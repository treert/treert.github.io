/**
 * 合法出牌生成。
 *
 * 纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * 设计要点（design.md §5.3）：
 *
 *   1. **规则层的规范就是一个集合定义**，实现只是它的更快算法：
 *
 *        legalPlays(hand, last) = { S ⊆ hand, S ≠ ∅ |
 *             last 为 null（首出）时：identifyAll(S) 非空
 *             否则：                  canBeat(S, last) }
 *          ∪ （last 非空时并入 { pass }）
 *
 *      所以这里的实现是「**按类型构造候选 → 用 canBeat 过滤**」。
 *      `tools/test-moves.mjs` 会把这个定义直接跑一遍（枚举手牌的全部子集）来做核对 ——
 *      测试不是"我猜一个期望值"，而是"把定义跑一遍"，这是刻意的。
 *
 *   2. **候选按「点数组合」给，不按「具体牌」给**（§5.3）。
 *      同点数的牌功能完全等价：一手里有四张 3，出「一对 3」有 C(4,2)=6 种挑法，
 *      但它们能压的东西、出完之后手牌的点数结构完全一样。全枚举会让候选数虚高 4~6 倍，
 *      而 AI 的 maxCandidates 截断会被这些等价项浪费掉。
 *
 *      所以每个点数组合只保留**一个代表**（取该点数的前 k 张），
 *      并且先「按点数签名去重」再返回。**这个等价关系的正确性由 §11.2 的暴力法测试守住** ——
 *      那边也是按点数签名比的。
 *
 *   3. **不做任何排序、不做任何裁剪**。排序与裁剪是 AI 的策略（ai/index.js），
 *      规则层保持纯净 —— 与象棋「rules.js 只管规则、engine.js 才管强弱」一致。
 *      界面上的「提示」用完整集合自己排序。
 */

import {
  RANK_MIN, RANK_A, RANK_MAX, rankOf, rankCounts, cardsOfRank, sortHand,
} from './cards.js';
import { identifyAll, beats, canBeat } from './combo.js';

/** 着法：出牌 或 不要 */
export function play(cards) {
  return { kind: 'play', cards };
}
export const PASS = Object.freeze({ kind: 'pass' });

export function isPass(move) {
  return !move || move.kind === 'pass';
}

/** 给测试与调试用的简短描述，如 "play[♠3 ♥3 ♦3 ♦4]"，王炸/顺子这类不展开 */
export function moveLabel(move) {
  if (isPass(move)) return 'pass';
  return 'play[' + move.cards.map((c) => {
    const r = rankOf(c);
    if (r === 16) return '小王';
    if (r === 17) return '大王';
    return String(r);
  }).join(' ') + ']';
}

/** 数组的全部 k 元组合（k=0 时产出一次空数组） */
function* combinations(arr, k) {
  const n = arr.length;
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * 把任意一组牌规范化成「按点数取前 k 张」的那个代表。
 * 同点数的牌等价，所以同一个点数签名只会对应一个代表。
 */
function canonical(hand, cards) {
  const need = new Map();
  for (const c of cards) {
    const r = rankOf(c);
    need.set(r, (need.get(r) || 0) + 1);
  }
  const out = [];
  for (const r of [...need.keys()].sort((a, b) => a - b)) {
    const have = cardsOfRank(hand, r);
    const k = need.get(r);
    if (have.length < k) return null; // 不是 hand 的子集
    for (let i = 0; i < k; i++) out.push(have[i]);
  }
  return sortHand(out);
}

/** 点数签名：去重与测试比对都用它 */
export function rankSignature(cards) {
  return cards.map(rankOf).sort((a, b) => a - b).join(',');
}

/**
 * 这手牌能组成的所有牌型（每个点数组合一个代表，未过滤场面）。
 *
 * 导出它是因为 AI 的着法排序、以及「提示」都需要"完整候选集"这个概念，
 * 而 legalPlays 只是它加了一层过滤。
 */
export function enumerateCombos(hand) {
  const sorted = sortHand(hand);
  const counts = rankCounts(sorted);
  const take = (r, k) => cardsOfRank(sorted, r).slice(0, k);
  const raw = [];

  // --- 单张 / 对子 / 三张 / 炸弹 ---
  // 王各只有一张，所以 counts[16] / counts[17] 最多是 1，
  // 下面 counts >= 2 / >= 3 的判断自然把它们排除掉了（王不可能成对）
  for (let r = RANK_MIN; r <= RANK_MAX; r++) {
    if (counts[r] >= 1) raw.push(take(r, 1));
    if (counts[r] >= 2) raw.push(take(r, 2));
    if (counts[r] >= 3) raw.push(take(r, 3));
    if (counts[r] === 4) raw.push(take(r, 4));
  }

  // --- 王炸 ---
  if (counts[16] === 1 && counts[17] === 1) raw.push([...take(16, 1), ...take(17, 1)]);

  // --- 三带一 / 三带二：主体是那个三张的点 ---
  for (let r = RANK_MIN; r <= RANK_A; r++) {
    if (counts[r] < 3) continue;
    const body = take(r, 3);
    const rest = sorted.filter((c) => !body.includes(c));

    for (const wing of combinations(rest, 1)) raw.push([...body, ...wing]);

    // 翅膀必须是一个**对子**（同一个点两张），所以按点数挑，不按具体牌挑
    const seenWingRank = new Set();
    for (const c of rest) {
      const wr = rankOf(c);
      if (wr === r || seenWingRank.has(wr)) continue;
      const pair = cardsOfRank(rest, wr);
      if (pair.length < 2) continue;
      seenWingRank.add(wr);
      raw.push([...body, ...pair.slice(0, 2)]);
    }
  }

  // --- 顺子（5 张起，只能用 3..A）---
  for (let start = RANK_MIN; start <= RANK_A; start++) {
    let end = start;
    while (end <= RANK_A && counts[end] >= 1) end++;
    const maxLen = end - start;
    for (let len = 5; len <= maxLen; len++) {
      const cards = [];
      for (let r = start; r < start + len; r++) cards.push(...take(r, 1));
      raw.push(cards);
    }
  }

  // --- 连对（3 组起）---
  for (let start = RANK_MIN; start <= RANK_A; start++) {
    let end = start;
    while (end <= RANK_A && counts[end] >= 2) end++;
    const maxGroups = end - start;
    for (let g = 3; g <= maxGroups; g++) {
      const cards = [];
      for (let r = start; r < start + g; r++) cards.push(...take(r, 2));
      raw.push(cards);
    }
  }

  // --- 飞机（2 组起，不带翅膀）---
  for (let start = RANK_MIN; start <= RANK_A; start++) {
    let end = start;
    while (end <= RANK_A && counts[end] >= 3) end++;
    const maxGroups = end - start;
    for (let g = 2; g <= maxGroups; g++) {
      const cards = [];
      for (let r = start; r < start + g; r++) cards.push(...take(r, 3));
      raw.push(cards);
    }
  }

  // --- 飞机带单 / 带对：主体 g 组，翅膀 g 张 / g 对 ---
  for (let start = RANK_MIN; start <= RANK_A; start++) {
    let end = start;
    while (end <= RANK_A && counts[end] >= 3) end++;
    const maxGroups = end - start;

    for (let g = 2; g <= maxGroups; g++) {
      const body = [];
      for (let r = start; r < start + g; r++) body.push(...take(r, 3));
      const bodySet = new Set(body);
      const rest = sorted.filter((c) => !bodySet.has(c));

      // 带单：翅膀是「g 张任意牌」（可以同点，见 design.md §0 第 3 条）
      if (rest.length >= g && 4 * g <= sorted.length) {
        for (const wings of combinations(rest, g)) raw.push([...body, ...wings]);
      }

      // 带对：翅膀是 g 个对子
      if (5 * g <= sorted.length) {
        const units = []; // 每个元素是一个「对子」
        const seenRank = new Set();
        for (const c of rest) {
          const wr = rankOf(c);
          if (seenRank.has(wr)) continue;
          seenRank.add(wr);
          const group = cardsOfRank(rest, wr);
          for (let i = 0; i + 1 < group.length; i += 2) {
            units.push(group.slice(i, i + 2));
          }
        }
        for (const picked of combinations(units, g)) raw.push([...body, ...picked.flat()]);
      }
    }
  }

  // --- 四带两单 / 四带两对（§0 第 2、3 条：两单可以是一对，两对可以是同一个点的 4 张）---
  for (let r = RANK_MIN; r <= RANK_A; r++) {
    if (counts[r] !== 4) continue;
    const body = take(r, 4);
    const bodySet = new Set(body);
    const rest = sorted.filter((c) => !bodySet.has(c));

    if (sorted.length >= 6) {
      for (const wings of combinations(rest, 2)) raw.push([...body, ...wings]);
    }
    if (sorted.length >= 8) {
      const units = [];
      const seenRank = new Set();
      for (const c of rest) {
        const wr = rankOf(c);
        if (seenRank.has(wr)) continue;
        seenRank.add(wr);
        const group = cardsOfRank(rest, wr);
        for (let i = 0; i + 1 < group.length; i += 2) {
          units.push(group.slice(i, i + 2));
        }
      }
      for (const picked of combinations(units, 2)) raw.push([...body, ...picked.flat()]);
    }
  }

  // --- 规范化 + 按点数签名去重 ---
  const seen = new Set();
  const out = [];
  for (const cards of raw) {
    const canon = canonical(sorted, cards);
    if (!canon) continue;
    const sig = canon.join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(canon);
  }
  return out;
}

/**
 * 合法着法。**判「能不能出」的规则来源就是这个函数。**
 *
 * lastCombo 为 null 表示本墩首出 —— 此时不含 `pass`（首出必须出牌）。
 */
export function legalPlays(hand, lastCombo = null) {
  const out = [];
  for (const cards of enumerateCombos(hand)) {
    // 首出时「成牌型」就是「可以出」（enumerateCombos 只产出成牌型的组合），
    // 所以省掉一次 canBeat —— 它在搜索里是热点
    if (lastCombo && !canBeat(cards, lastCombo)) continue;
    out.push(play(cards));
  }
  if (lastCombo) out.push(PASS);
  return out;
}

/** 只要"能不能出"这个布尔量时用它，比构造完整列表便宜（但仍会早退） */
export function hasAnyPlay(hand, lastCombo = null) {
  if (!lastCombo) return enumerateCombos(hand).length > 0;
  for (const cards of enumerateCombos(hand)) {
    if (canBeat(cards, lastCombo)) return true;
  }
  return false;
}

/**
 * 和 `legalPlays` 同样的候选集，但**顺带给出每个候选落定成哪个 combo**
 * （跟牌时是"压得过的那个解释"，见 `combo.js` 的 `resolveCombo`）。
 *
 * 搜索要在每个节点上推进局面，而推进需要知道"这一手是什么牌型" ——
 * 自己再调一次 `resolveCombo` 等于把 `identifyAll` 算两遍。
 *
 * **不要用它替 `legalPlays` 的第一个参数**：首出时 `legalPlays` 刻意跳过了
 * `identifyAll`（候选一定成牌型，见 C11），而这里必须算 —— 实测那是 15 倍的差距
 * （20 张手牌 114µs → 1.7ms）。所以首出的热点路径仍走 `legalPlays`。
 */
export function playsWithCombos(hand, lastCombo = null) {
  const out = [];
  for (const cards of enumerateCombos(hand)) {
    const combos = identifyAll(cards);
    if (combos.length === 0) continue;
    const combo = lastCombo ? combos.find((c) => beats(c, lastCombo)) : combos[0];
    if (combo) out.push({ cards, combo });
  }
  return out;
}
