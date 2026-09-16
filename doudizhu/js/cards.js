/**
 * 牌的编码、洗牌、发牌、rank 计数。
 *
 * 纯逻辑，不碰 DOM、不碰 localStorage。Node 里被 tools/*.mjs 直接加载，
 * 浏览器里也会被 Worker 加载（经 ai/），所以这里绝对不能出现 window / document。
 *
 * 设计要点（design.md §4.1、§3.2）：
 *
 *   1. card 是 0..53 的整数：0..51 是四种花色 × 十三个点数，按 rank 升序排列；
 *      52 是小王，53 是大王。
 *        card = rankIndex * 4 + suit，rankIndex 0..12 → rank 3..15
 *      所以「按 card 升序」==「按 rank 升序，同 rank 按花色升序」，不用额外写排序规则。
 *
 *   2. rank 是全模块比较大小的唯一依据（3..17，见表）。花色只用于显示。
 *
 *   3. hand 恒为按 card 升序的 number[]（§3.2）。**不缓存 rankCounts** ——
 *      hand 是唯一真相，计数是每次现算的 O(n) 派生函数。多一份真相就多一条
 *      会忘记同步的路径（与象棋「局面只有一个来源 FEN」是同一个取舍）。
 *
 *   4. rng 一律注入（() => number，返回 [0,1)）。这样发牌、采样、AI 决策
 *      全都可以种子化复现 —— 这是 §11.4 那组测试的前提。
 *      与 persist.js 注入 storage 是同一手法。
 */

// === rank 表 ===
//   3..10 → 3..10，J=11，Q=12，K=13，A=14，2=15，小王=16，大王=17
export const RANK_MIN = 3;
export const RANK_A = 14;
export const RANK_2 = 15;
export const RANK_JOKER_SMALL = 16;
export const RANK_JOKER_BIG = 17;
export const RANK_MAX = 17;

// 顺子 / 连对 / 飞机的**主体**只能用 3..A 这 12 个点数（2 和王不参与），
// 所以顺子最长 12 张、飞机最长 12 组。
export const RANK_STRAIGHT_MAX = RANK_A;
export const STRAIGHT_RANKS = 12; // 3..A 共 12 个点数

// rank 数组的下标上界（rankCounts 返回长度为 18 的数组，下标 0..17）
export const RANK_SLOTS = RANK_MAX + 1;

// === 牌 ===
export const DECK_SIZE = 54;
export const JOKER_SMALL = 52;
export const JOKER_BIG = 53;

export const SUITS = ['♠', '♥', '♦', '♣']; // 0: 黑桃 1: 红桃 2: 方块 3: 梅花

const RANK_LABELS = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

/** 牌的 rank（3..17）。判花色用 suitOf，判大小一律用 rankOf。 */
export function rankOf(card) {
  if (card === JOKER_SMALL) return RANK_JOKER_SMALL;
  if (card === JOKER_BIG) return RANK_JOKER_BIG;
  return RANK_MIN + ((card / 4) | 0);
}

/** 牌的花色下标 0..3；大小王没有花色，返回 -1 */
export function suitOf(card) {
  if (card >= JOKER_SMALL) return -1;
  return card % 4;
}

/**
 * 由 rank + 花色下标反查牌。
 *
 * 大小王忽略花色参数（各只有一张），这样 cardsOfRanks() 那类「按点数造牌」
 * 的测试辅助函数可以统一处理王，不用特判。
 */
export function cardOf(rank, suit = 0) {
  if (rank === RANK_JOKER_SMALL) return JOKER_SMALL;
  if (rank === RANK_JOKER_BIG) return JOKER_BIG;
  if (rank < RANK_MIN || rank > RANK_2) throw new RangeError(`rank 越界：${rank}`);
  return (rank - RANK_MIN) * 4 + ((suit % 4) + 4) % 4;
}

export function isJoker(card) {
  return card >= JOKER_SMALL;
}

export function rankLabel(rank) {
  return RANK_LABELS[rank] || String(rank);
}

/** 给人看的牌名，如 "♥K" / "大王"。测试失败信息和界面都用它 */
export function cardLabel(card) {
  if (card === JOKER_SMALL) return '小王';
  if (card === JOKER_BIG) return '大王';
  return SUITS[suitOf(card)] + rankLabel(rankOf(card));
}

/** 一手牌的简短描述，如 "[♠3 ♥3 ♦4 大王]" */
export function handLabel(cards) {
  return '[' + cards.map(cardLabel).join(' ') + ']';
}

/** hand → 每个 rank 有几张。返回长度 18 的数组，下标即 rank（0..17） */
export function rankCounts(hand) {
  const counts = new Array(RANK_SLOTS).fill(0);
  for (let i = 0; i < hand.length; i++) counts[rankOf(hand[i])]++;
  return counts;
}

/** 升序（按 rank 再按花色）。返回新数组，不改原数组 */
export function sortHand(cards) {
  return cards.slice().sort((a, b) => a - b);
}

/** 该手里某个点数的具体牌（升序）。牌型枚举时用来把「点数组合」映射回具体牌 */
export function cardsOfRank(hand, rank) {
  const out = [];
  for (const c of hand) if (rankOf(c) === rank) out.push(c);
  return out;
}

/** 该手里出现在哪些点数上（升序） */
export function ranksIn(hand) {
  const seen = new Uint8Array(RANK_SLOTS);
  const out = [];
  for (const c of hand) {
    const r = rankOf(c);
    if (!seen[r]) { seen[r] = 1; out.push(r); }
  }
  return out.sort((a, b) => a - b);
}

/** 从 hand 里去掉 cards（必须是子集）。返回新数组 */
export function removeCards(hand, cards) {
  const drop = new Set(cards);
  return hand.filter((c) => !drop.has(c));
}

/** 判断 cards 是否是 hand 的子集（含重复检查交给调用方，牌本身不重复） */
export function isSubset(hand, cards) {
  const pool = new Map();
  for (const c of hand) pool.set(c, (pool.get(c) || 0) + 1);
  for (const c of cards) {
    const n = pool.get(c) || 0;
    if (n === 0) return false;
    pool.set(c, n - 1);
  }
  return true;
}

/** 完整的一副 54 张，升序 */
export function fullDeck() {
  const deck = [];
  for (let i = 0; i < DECK_SIZE; i++) deck.push(i);
  return deck;
}

/**
 * 确定性 PRNG（mulberry32）。返回 () => [0, 1) 的函数。
 *
 * 放在 cards.js 而不是新建 rng.js：全模块只有「发牌」和「AI 采样」需要随机源，
 * 两处都能 import 这里，没必要多一个文件（design.md §7.6 提到过这个实现）。
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates。返回新数组，不改原数组 */
export function shuffle(cards, rng) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** 每个座位 17 张，底牌 3 张。三家手牌与底牌都是升序的 */
export const HAND_SIZE = 17;
export const TRUMP_SIZE = 3;

/**
 * 发牌。返回 { hands: [17,17,17], trump: [3] }。
 *
 * 不变量（test-cards.mjs 断言）：hands 展平 + trump 恰好是 0..53 的一个排列。
 */
export function deal(rng) {
  const deck = shuffle(fullDeck(), rng);
  return {
    hands: [
      sortHand(deck.slice(0, HAND_SIZE)),
      sortHand(deck.slice(HAND_SIZE, HAND_SIZE * 2)),
      sortHand(deck.slice(HAND_SIZE * 2, HAND_SIZE * 3)),
    ],
    trump: sortHand(deck.slice(HAND_SIZE * 3)),
  };
}
