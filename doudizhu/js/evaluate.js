/**
 * 手牌评估。**这是全模块唯一"手写知识"的地方，也是最容易调坏的地方**
 * （design.md §6）。第一版刻意做最简版。
 *
 * 纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * 本文件分两半（按 §12 的构建顺序分两步实现，**两半现在都已实现**）：
 *   - `handScore`  —— 叫分用，第 3 步
 *   - `handValue`  —— 出牌评估用，第 4 步，AI 的底座
 *
 * `handValue` 里那句 `ctx` 参数目前仍然没用上（§6.2 的签名里留的位），
 * 别把它当成"这里还没写完"。
 */

import {
  RANK_MIN, RANK_A, RANK_2, RANK_JOKER_SMALL, RANK_JOKER_BIG, RANK_MAX,
  rankCounts,
} from './cards.js';

// === 叫分用的权重（§6.1）===
// 表里的数字是初值，改它们请连着跑一遍 selfplay 看流局率（§5.5）。
const W_BIG_JOKER = 6;    // 大王：绝对控制牌
const W_SMALL_JOKER = 4;  // 小王
const W_TWO = 3;          // 每张 2
const W_ACE = 1.5;        // 每张 A
const W_BOMB = 8;         // 每个炸弹
const W_TRIPLE_SET = 1;   // 每组三张（顺子 / 飞机潜力）
const W_PAIR_RUN = 1;     // 每组连续对子（连对潜力）
const W_SINGLE = -0.5;    // 每个"小单张"—— 越散越难走

/**
 * 这手牌值几分（叫分用）。只看手牌本身，不看局势，也**不看底牌**
 * （叫分阶段底牌还没翻开，看它就是作弊）。
 *
 * 返回值是无量纲的分数，由 `bid.js` 按 `BID_THRESHOLDS` 折算成 0~3 分。
 */
export function handScore(hand) {
  const counts = rankCounts(hand);
  let s = 0;

  if (counts[RANK_JOKER_BIG]) s += W_BIG_JOKER;
  if (counts[RANK_JOKER_SMALL]) s += W_SMALL_JOKER;

  s += counts[RANK_2] * W_TWO;
  s += counts[RANK_A] * W_ACE;

  // 炸弹
  for (let r = RANK_MIN; r <= RANK_2; r++) if (counts[r] === 4) s += W_BOMB;

  for (let r = RANK_MIN; r <= RANK_A; r++) {
    // 三张组（>=3 张的点都算一组；4 张的已经在上面的炸弹里加过权重了，
    // 这里仍然算一组 —— 它出的时候可以当三带一或飞机主体）
    if (counts[r] >= 3) s += W_TRIPLE_SET;

    // 连续对子组：滑动窗口数 (r, r+1, r+2) 三个点都至少有 2 张的次数。
    // 这是个**代理量**，不是"最长连对链的长度" —— 后者要多写十几行，
    // 而叫分只需要一个"这手牌有没有连对潜力的粗略信号"。
    if (r + 2 <= RANK_A && counts[r] >= 2 && counts[r + 1] >= 2 && counts[r + 2] >= 2) {
      s += W_PAIR_RUN;
    }

    // 小单张惩罚：只算 3..K。A / 2 / 王 当单张是好牌，不该被扣
    if (r <= 13 && counts[r] === 1) s += W_SINGLE;
  }

  return s;
}

/**
 * 手牌的点数结构概览，给测试与调试用（也是将来做「提示」文案的现成材料）。
 * 不算分值，只数结构。
 */
export function handShape(hand) {
  const counts = rankCounts(hand);
  const shape = { jokers: 0, bombs: 0, triples: 0, pairs: 0, singles: 0, ranks: 0 };
  for (let r = RANK_MIN; r <= RANK_MAX; r++) {
    if (!counts[r]) continue;
    shape.ranks++;
    if (r >= RANK_JOKER_SMALL) shape.jokers++;
    if (counts[r] === 4) shape.bombs++;
    else if (counts[r] === 3) shape.triples++;
    else if (counts[r] === 2) shape.pairs++;
    else shape.singles++;
  }
  return shape;
}

// ============================================================================
// 出牌评估（§6.2）—— AI 的底座，也是「提示」的候选排序依据
// ============================================================================

/**
 * 把一手牌贪心拆成若干"手"，返回 `{ groups, controls }`。
 *
 * `groups.length` 就是「还要出几手才能走完」—— 这是全场唯一一个真正有信号的量。
 * 斗地主的胜负几乎就是"谁的手数先降到 0"。
 *
 * 拆牌顺序（先后有讲究）：
 *   1. **炸弹先摘**，而且摘完就再不拆它 —— 炸弹是夺回出牌权的手段，不是普通的四张
 *   2. **顺子 / 连对**：反复取「最长的那一段」，直到凑不出 5 张 / 3 对为止
 *   3. **三张**：每个三张再吸走一张单牌（当三带一），能少一手
 *   4. 剩下的按对子、单张收尾
 *
 * `controls` 是"控制牌"的组数：炸弹、王炸、单出的王、每一组 2。
 * 它们的作用是**夺回出牌权**，所以在 `handValue` 里是减分项
 * （少一张控制牌 = 手牌变差）。
 *
 * **这是启发式，不是最优拆牌。** 完整拆牌是组合优化，第一版不做（§6.2）。
 */
export function decompose(hand) {
  const counts = rankCounts(hand);
  const groups = [];

  // 1. 炸弹
  for (let r = RANK_MIN; r <= RANK_2; r++) {
    if (counts[r] === 4) { groups.push({ type: 'BOMB', rank: r }); counts[r] = 0; }
  }

  // 2. 王炸 / 单王（王永远不参与别的牌型）
  if (counts[RANK_JOKER_SMALL] && counts[RANK_JOKER_BIG]) {
    groups.push({ type: 'ROCKET' });
    counts[RANK_JOKER_SMALL] = 0;
    counts[RANK_JOKER_BIG] = 0;
  } else {
    if (counts[RANK_JOKER_SMALL]) { groups.push({ type: 'SINGLE', rank: RANK_JOKER_SMALL }); counts[RANK_JOKER_SMALL] = 0; }
    if (counts[RANK_JOKER_BIG]) { groups.push({ type: 'SINGLE', rank: RANK_JOKER_BIG }); counts[RANK_JOKER_BIG] = 0; }
  }

  // 3. 顺子 / 连对：反复摘最长的一段
  for (const [perRank, minLen, type] of [[1, 5, 'STRAIGHT'], [2, 3, 'STRAIGHT_PAIR']]) {
    for (;;) {
      const run = longestRun(counts, perRank, minLen);
      if (!run) break;
      groups.push({ type, len: run.len, rank: run.start + run.len - 1 });
      for (let r = run.start; r < run.start + run.len; r++) counts[r] -= perRank;
    }
  }

  // 4. 三张 / 对子 / 单张
  const triples = [];
  const pairs = [];
  const singles = [];
  for (let r = RANK_MIN; r <= RANK_2; r++) {
    while (counts[r] >= 3) { triples.push({ type: 'TRIPLE', rank: r }); counts[r] -= 3; }
    while (counts[r] >= 2) { pairs.push({ type: 'PAIR', rank: r }); counts[r] -= 2; }
    while (counts[r] >= 1) { singles.push({ type: 'SINGLE', rank: r }); counts[r] -= 1; }
  }

  // 5. 三张吸走一张**最小的**单牌（三带一），少一手。
  //    吸最小的而不是最大的：大的留着当控制牌更值钱。
  pairs.sort((a, b) => a.rank - b.rank);
  singles.sort((a, b) => a.rank - b.rank);
  const absorbed = new Set();
  for (const t of triples) {
    const wing = singles.find((s) => !absorbed.has(s)) || pairs.find((p) => !absorbed.has(p));
    if (wing) absorbed.add(wing);
    groups.push({ ...t, wing: wing ? wing.type : null });
  }
  for (const p of pairs) if (!absorbed.has(p)) groups.push(p);
  for (const s of singles) if (!absorbed.has(s)) groups.push(s);

  // 6. 控制牌组数
  let controls = 0;
  for (const g of groups) {
    if (g.type === 'BOMB' || g.type === 'ROCKET') controls++;
    else if (g.rank >= RANK_JOKER_SMALL) controls++;   // 单出的王
    else if (g.rank === RANK_2) controls++;            // 每一组 2
  }

  return { groups, controls };
}

/** 在 counts 里找最长的连续段（每个点至少 perRank 张，且只能落在 3..A） */
function longestRun(counts, perRank, minLen) {
  let best = null;
  let r = RANK_MIN;
  while (r <= RANK_A) {
    if (counts[r] < perRank) { r++; continue; }
    let end = r;
    while (end + 1 <= RANK_A && counts[end + 1] >= perRank) end++;
    const len = end - r + 1;
    if (len >= minLen && (!best || len > best.len)) best = { start: r, len };
    r = end + 1;
  }
  return best;
}

/**
 * 这手牌"还要出几手才能走完"的估值（**越小越好**）。
 *
 * ```
 * handValue = (手数 − 0.5 × 控制牌组数) × 10
 * ```
 *
 * 乘 10 是为了让 `LEVELS[].noise`（0~150，与象棋的评估分量纲对齐）能直接调参 ——
 * 不缩放的话噪声会把结果完全淹没，弱挡位就变成纯随机了。
 *
 * `ctx` 目前**没用上**（§6.2 的签名里留了位）。将来要加的是"对手还剩几张"这类
 * 局势项；现在加就是凭空猜。
 */
export function handValue(hand, ctx = null) {
  const { groups, controls } = decompose(hand);
  return (groups.length - 0.5 * controls) * 10;
}
