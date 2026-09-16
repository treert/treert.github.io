/**
 * 牌型识别与大小比较。
 *
 * 纯逻辑，不碰 DOM、不碰 localStorage。规则层的核心，测试重点也在这里
 * （design.md §5.1、§5.2、§11.1）。
 *
 * 设计要点：
 *
 *   1. 只认「张数 + 点数多重集」，**不看花色**。所以王永远不会构成对子
 *      （大小王点数不同），也永远不参与顺子（点的数值超出 3..A）。
 *
 *   2. **`combo` 是「这组牌的一种解释」，不是「这组牌的类型」。**
 *      同一个 cards 可能对应多个 combo，所以识别函数是 `identifyAll`，
 *      判「能不能压过」是 `canBeat`（存在一种解释能压过就算能压过）。
 *
 *      原设计是单值的 `identify(cards) -> combo | null`，靠一张优先级表消解歧义。
 *      它会犯一个具体的错：手里 `444555666777`，场上 `PLANE_ONE(3)@345`，
 *      按「PLANE 优先」读成四连飞机 → 类型不匹配 → 判「压不过」，
 *      但实际上可以当 `PLANE_ONE(3)@456` 出。详见 design.md §5.1 末尾。
 *
 *   3. 翅膀的松紧（design.md §0 第 3 条）：**翅膀允许与主体同点，翅膀内部也允许同点**。
 *      - `33334444` → `PLANE_ONE(2)`（主体 333+444，翅膀 3+4）
 *      - `333444+55` → 飞机带单（55 当两张单牌）
 *      - `333444+5555` → 飞机带对（5555 当两对）
 *      方向是刻意选的：**规则不确定时，宽松是安全的错误方向** ——
 *      宽松只是多给一种出法，严格却会剥夺一种，而"我认为能出但程序说不能"
 *      是用户能看见的最坏一类错。
 */

import {
  RANK_MIN, RANK_A, RANK_MAX, RANK_JOKER_SMALL, RANK_JOKER_BIG,
  rankCounts, sortHand, rankLabel,
} from './cards.js';

export const TYPES = Object.freeze({
  SINGLE: 'SINGLE',
  PAIR: 'PAIR',
  TRIPLE: 'TRIPLE',
  TRIPLE_ONE: 'TRIPLE_ONE',
  TRIPLE_PAIR: 'TRIPLE_PAIR',
  STRAIGHT: 'STRAIGHT',
  STRAIGHT_PAIR: 'STRAIGHT_PAIR',
  PLANE: 'PLANE',
  PLANE_ONE: 'PLANE_ONE',
  PLANE_PAIR: 'PLANE_PAIR',
  FOUR_TWO_SINGLE: 'FOUR_TWO_SINGLE',
  FOUR_TWO_PAIR: 'FOUR_TWO_PAIR',
  BOMB: 'BOMB',
  ROCKET: 'ROCKET',
});

/** 14 种牌型（§0 第 7 条：全保留，不砍） */
export const ALL_TYPES = Object.freeze(Object.values(TYPES));

/** 带翅膀的类型 —— 排序与显示时「不带翅膀的优先」 */
const HAS_WINGS = new Set([
  TYPES.TRIPLE_ONE, TYPES.TRIPLE_PAIR,
  TYPES.PLANE_ONE, TYPES.PLANE_PAIR,
  TYPES.FOUR_TWO_SINGLE, TYPES.FOUR_TWO_PAIR,
]);

const TYPE_NAMES = {
  [TYPES.SINGLE]: '单张',
  [TYPES.PAIR]: '对子',
  [TYPES.TRIPLE]: '三张',
  [TYPES.TRIPLE_ONE]: '三带一',
  [TYPES.TRIPLE_PAIR]: '三带二',
  [TYPES.STRAIGHT]: '顺子',
  [TYPES.STRAIGHT_PAIR]: '连对',
  [TYPES.PLANE]: '飞机',
  [TYPES.PLANE_ONE]: '飞机带单',
  [TYPES.PLANE_PAIR]: '飞机带对',
  [TYPES.FOUR_TWO_SINGLE]: '四带两单',
  [TYPES.FOUR_TWO_PAIR]: '四带两对',
  [TYPES.BOMB]: '炸弹',
  [TYPES.ROCKET]: '王炸',
};

const ORDER_INDEX = {};
ALL_TYPES.forEach((t, i) => { ORDER_INDEX[t] = i; });

function mk(type, mainRank, cards) {
  return { type, mainRank, length: cards.length, cards };
}

/** 排序规则见 design.md §5.1：不带翅膀的优先，其次 mainRank 大者优先 */
function cmpCombo(a, b) {
  const wa = HAS_WINGS.has(a.type) ? 1 : 0;
  const wb = HAS_WINGS.has(b.type) ? 1 : 0;
  if (wa !== wb) return wa - wb;
  if (a.mainRank !== b.mainRank) return b.mainRank - a.mainRank;
  return ORDER_INDEX[a.type] - ORDER_INDEX[b.type];
}

/** 一组 rank 是否连续且都落在 3..A（2 与王不参与顺子 / 连对 / 飞机） */
function isRun(ranks) {
  if (ranks.length === 0) return false;
  if (ranks[0] < RANK_MIN || ranks[ranks.length - 1] > RANK_A) return false;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return false;
  }
  return true;
}

/**
 * 识别一组牌的全部合法解释。**空数组 = 这组牌不成牌型。**
 *
 * 实现是「按类型逐个试」，而不是「按张数 switch 再在组内挑」——
 * 前者每个类型的判定互相独立，多解释是自然落出来的结果，
 * 后者会诱导你去写优先级表（那正是 §5.1 否掉的写法）。
 */
export function identifyAll(cards) {
  const out = [];
  if (!cards || cards.length === 0) return out;

  // 校验：牌在 0..53 内、不重复。不合法直接返回空（调用方本来就该保证，这里是兜底）
  const seen = new Set();
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 53 || seen.has(c)) return out;
    seen.add(c);
  }

  const n = cards.length;
  const sorted = sortHand(cards);
  const counts = rankCounts(sorted);

  const ranks = [];
  for (let r = RANK_MIN; r <= RANK_MAX; r++) if (counts[r] > 0) ranks.push(r);
  const kinds = ranks.length;
  const lastRank = ranks[kinds - 1];

  let maxCount = 0;
  for (const r of ranks) if (counts[r] > maxCount) maxCount = counts[r];

  const allCount = (k) => ranks.every((r) => counts[r] === k);

  // --- 单张 / 对子 / 王炸 / 三张 / 炸弹 ---
  if (n === 1) out.push(mk(TYPES.SINGLE, ranks[0], sorted));
  if (n === 2 && counts[RANK_JOKER_SMALL] === 1 && counts[RANK_JOKER_BIG] === 1) {
    out.push(mk(TYPES.ROCKET, RANK_JOKER_BIG, sorted));
  }
  if (n === 2 && kinds === 1) out.push(mk(TYPES.PAIR, ranks[0], sorted));
  if (n === 3 && kinds === 1) out.push(mk(TYPES.TRIPLE, ranks[0], sorted));
  if (n === 4 && kinds === 1) out.push(mk(TYPES.BOMB, ranks[0], sorted));

  // --- 三带一 / 三带二（主体 = 那个三张的点）---
  if (n === 4 && kinds === 2 && maxCount === 3) {
    out.push(mk(TYPES.TRIPLE_ONE, ranks.find((r) => counts[r] === 3), sorted));
  }
  if (n === 5 && kinds === 2 && maxCount === 3) {
    out.push(mk(TYPES.TRIPLE_PAIR, ranks.find((r) => counts[r] === 3), sorted));
  }

  // --- 顺子 / 连对 / 飞机：整手牌都是同一种「组」，所以形状唯一 ---
  if (n >= 5 && allCount(1) && isRun(ranks)) {
    out.push(mk(TYPES.STRAIGHT, lastRank, sorted));
  }
  if (n >= 6 && n % 2 === 0 && allCount(2) && isRun(ranks)) {
    out.push(mk(TYPES.STRAIGHT_PAIR, lastRank, sorted));
  }
  if (n >= 6 && allCount(3) && isRun(ranks)) {
    out.push(mk(TYPES.PLANE, lastRank, sorted));
  }

  // --- 飞机带单：4n 张，n≥2，主体是 n 个连续的点各取 3 张，剩下 n 张全是翅膀 ---
  if (n >= 8 && n % 4 === 0) {
    const m = n / 4;
    for (let start = RANK_MIN; start + m - 1 <= RANK_A; start++) {
      let ok = true;
      for (let r = start; r < start + m; r++) if (counts[r] < 3) { ok = false; break; }
      if (ok) out.push(mk(TYPES.PLANE_ONE, start + m - 1, sorted));
    }
  }

  // --- 飞机带对：5n 张，n≥2，主体同上，剩下 2n 张要能凑成 n 个对子 ---
  //     「凑成对子」等价于「每个点剩下的张数都是偶数」（剩下的总数正好是 2n）
  if (n >= 10 && n % 5 === 0) {
    const m = n / 5;
    for (let start = RANK_MIN; start + m - 1 <= RANK_A; start++) {
      let ok = true;
      for (let r = start; r < start + m; r++) if (counts[r] < 3) { ok = false; break; }
      if (!ok) continue;

      let wingsEven = true;
      for (let r = RANK_MIN; r <= RANK_MAX; r++) {
        const used = (r >= start && r < start + m) ? 3 : 0;
        if ((counts[r] - used) % 2 !== 0) { wingsEven = false; break; }
      }
      if (wingsEven) out.push(mk(TYPES.PLANE_PAIR, start + m - 1, sorted));
    }
  }

  // --- 四带两单 / 四带两对 ---
  //     翅膀的松紧照 §0 第 2、3 条：两单可以是一对；两对可以是同一个点的 4 张
  if (n === 6 && maxCount === 4) {
    out.push(mk(TYPES.FOUR_TWO_SINGLE, ranks.find((r) => counts[r] === 4), sorted));
  }
  if (n === 8 && maxCount === 4) {
    let wingsEven = true;
    for (const r of ranks) if (counts[r] !== 4 && counts[r] % 2 !== 0) { wingsEven = false; break; }
    if (wingsEven) {
      out.push(mk(TYPES.FOUR_TWO_PAIR, ranks.find((r) => counts[r] === 4), sorted));
    }
  }

  return out.sort(cmpCombo);
}

/**
 * 单一解释（= identifyAll 里的第一个）。**只用于两处**：
 * 界面上显示这手牌「是什么」、以及首出时把 combo 落定成唯一一个（下一家按它来压）。
 * **判「能不能出」一律走 canBeat，不要用这个。**
 */
export function identify(cards) {
  const all = identifyAll(cards);
  return all.length ? all[0] : null;
}

/**
 * a 能不能压过 b。两个都是**确定的** combo。
 *
 * 判定顺序：**先判「b 是不是王炸」（不可被压）**，再判「a 是不是王炸」（压一切），
 * 然后炸弹，最后同型同长比 mainRank。
 *
 * 前两条的顺序是刻意的（design.md §5.2 的初稿写反了，实现时改的）：
 * 初稿先判 `a` 是王炸 → `beats(王炸, 王炸)` 返回 true，而**其余每一种牌型自比都是 false**。
 * 那个 true 会让"手里有王炸、场上也是王炸"（同一副牌里不可能，但代码层面能构造出来）
 * 冒出一个多余的合法着法。先判 `b` 之后，`beats(x, x) === false` 对所有牌型一律成立。
 *
 * `length` 相等是必须的：5 张顺子与 6 张顺子互不相压，飞机带单 n=2 与 n=3 同理。
 * 带牌不参与比较 —— mainRank 取的是主体里最大的那个点。
 */
export function beats(a, b) {
  if (!a || !b) return false;
  if (b.type === TYPES.ROCKET) return false;
  if (a.type === TYPES.ROCKET) return true;
  if (a.type === TYPES.BOMB && b.type === TYPES.BOMB) return a.mainRank > b.mainRank;
  if (a.type === TYPES.BOMB) return true;
  if (b.type === TYPES.BOMB) return false;
  return a.type === b.type && a.length === b.length && a.mainRank > b.mainRank;
}

/**
 * 出这几张牌，能不能压过场上的 lastCombo。**判「能不能出」的唯一入口。**
 *
 * lastCombo 为 null 表示本墩首出 —— 只要成牌型就能出。
 */
export function canBeat(cards, lastCombo) {
  const all = identifyAll(cards);
  if (all.length === 0) return false;
  if (!lastCombo) return true;
  return all.some((c) => beats(c, lastCombo));
}

/**
 * 把这手牌在**给定场面**下落定成唯一一个 combo —— `game.js` 记进
 * `trick.lastPlay.combo` 用的（下一家要按它来压）。
 *
 * **不能一律用 `identify()`。** 首出时用 `identify()` 没问题（没人比，
 * 取显示顺序的第一个即可）；但**跟牌时必须取「压得过的那个解释」**：
 *
 *   `444555666777` 压 `PLANE_ONE(3)@345` 时，`identify()` 给的是 `PLANE(4)`，
 *   而 `PLANE(4)` 与 `PLANE_ONE` 类型不同、压不过 —— 记下它，下一家面对的
 *   就是一个**自相矛盾的 lastPlay**（"上一手出的牌按记录根本压不过更上一手"）。
 *
 * 多个解释都压得过时取 `identifyAll` 顺序里的第一个（不带翅膀优先 → 主体大的优先）。
 * 这也是出牌人最想要的：同样的牌，声明成更强的那一种对他更有利。
 *
 * 返回 null 表示这手牌既不成牌型、也压不过场面。
 */
export function resolveCombo(cards, lastCombo) {
  const all = identifyAll(cards);
  if (all.length === 0) return null;
  if (!lastCombo) return all[0];
  return all.find((c) => beats(c, lastCombo)) || null;
}

/** 给人看的名字，如「三带一（KKK + 1）」。界面与调试输出用 */
export function comboName(combo) {
  if (!combo) return '—';
  const t = TYPE_NAMES[combo.type] || combo.type;
  if (combo.type === TYPES.ROCKET) return t;
  return `${t}（主体 ${rankLabel(combo.mainRank)}）`;
}
