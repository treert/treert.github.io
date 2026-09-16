/**
 * 牌型识别与比较的测试（design.md §11.1）。
 *
 * 跑法：node doudizhu/tools/test-combo.mjs
 * 不装依赖 —— 与 conway-life-game / chinese-chess 的 tools 一致。
 *
 * 这一层是「要么全对、要么在某些牌上莫名其妙地错」的典型，所以逐条钉：
 * 每种牌型「成 / 不成」的边界、多解释的解释数与顺序、beats 的判定表、
 * mainRank 的定义、以及两条不变量（守门断言、canBeat 一致性）。
 */

import {
  cardOf, sortHand, rankCounts,
} from '../js/cards.js';
import {
  TYPES, ALL_TYPES, identifyAll, identify, beats, canBeat, comboName,
} from '../js/combo.js';

// === 极简断言 ===
let passed = 0;
const failures = [];

function eq(got, want, msg) {
  if (Object.is(got, want)) { passed++; return; }
  failures.push(`${msg}\n    期望 ${JSON.stringify(want)}\n    实际 ${JSON.stringify(got)}`);
}

function ok(cond, msg) {
  if (cond) { passed++; return; }
  failures.push(msg);
}

/** 按点数造牌：同一点按花色顺序取，超出 4 张（王超出 1 张）直接抛 */
function h(...ranks) {
  const used = new Map();
  const cards = ranks.map((r) => {
    const k = used.get(r) || 0;
    used.set(r, k + 1);
    const isJoker = r >= 16;
    if (k >= (isJoker ? 1 : 4)) throw new Error(`点数 ${r} 取了 ${k + 1} 张`);
    return cardOf(r, k);
  });
  return sortHand(cards);
}

/** 给人看的签名，断言里读起来清楚：'PLANE_ONE@4/8' */
function sig(c) {
  return `${c.type}@${c.mainRank}/${c.length}`;
}

/** 断言「这组牌的全部解释」按顺序正好是这些签名 */
function sigs(cards, want, msg) {
  const got = identifyAll(cards).map(sig);
  eq(got.join(' '), want.join(' '), msg);
}

/** 凭空造一个 combo，只用于 beats 的判定表 */
function C(type, mainRank, length) {
  return { type, mainRank, length, cards: [] };
}

// ─────────────────────────────────────────────
// 1. 基础类型
// ─────────────────────────────────────────────

sigs(h(3), ['SINGLE@3/1'], '单张');
sigs(h(16), ['SINGLE@16/1'], '单张小王');
sigs(h(3, 3), ['PAIR@3/2'], '对子');
sigs(h(16, 17), ['ROCKET@17/2'], '王炸');
sigs(h(3, 3, 3), ['TRIPLE@3/3'], '三张');
sigs(h(3, 3, 3, 3), ['BOMB@3/4'], '炸弹');
sigs(h(3, 3, 3, 4), ['TRIPLE_ONE@3/4'], '三带一');
sigs(h(3, 3, 3, 4, 4), ['TRIPLE_PAIR@3/5'], '三带二');

// ─────────────────────────────────────────────
// 2. 顺子
// ─────────────────────────────────────────────

sigs(h(3, 4, 5, 6, 7), ['STRAIGHT@7/5'], '最小顺子 34567');
sigs(h(10, 11, 12, 13, 14), ['STRAIGHT@14/5'], '最大顺子 10JQKA');
sigs(h(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14), ['STRAIGHT@14/12'], '最长顺子 3..A');

sigs(h(3, 4, 5, 6), [], '4 张不成顺子');
sigs(h(11, 12, 13, 14, 15), [], '含 2 不成顺子');
sigs(h(12, 13, 14, 15, 16), [], '含 2 和王不成顺子');
sigs(h(3, 4, 5, 6, 8), [], '不连续不成顺子');
sigs(h(14, 15, 16, 17), [], 'A2 小王大王 不成顺子');

// ─────────────────────────────────────────────
// 3. 连对
// ─────────────────────────────────────────────

sigs(h(3, 3, 4, 4, 5, 5), ['STRAIGHT_PAIR@5/6'], '最小连对 334455');
sigs(h(9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14), ['STRAIGHT_PAIR@14/12'], '最长连对 QQKKAA…');

sigs(h(3, 3, 4, 4), [], '两对不成连对');
sigs(h(13, 13, 14, 14, 15, 15), [], '含 2 不成连对');
sigs(h(3, 3, 4, 4, 6, 6), [], '不连续不成连对');
sigs(h(3, 3, 4, 4, 5), [], '5 张不成连对');

// ─────────────────────────────────────────────
// 4. 飞机 / 飞机带单 / 飞机带对
// ─────────────────────────────────────────────

sigs(h(3, 3, 3, 4, 4, 4), ['PLANE@4/6'], '最小飞机 333444');
sigs(h(3, 3, 3, 4, 4, 4, 5, 5, 5), ['PLANE@5/9'], '三连飞机');
sigs(h(14, 14, 14, 15, 15, 15), [], '含 2 不成飞机');
sigs(h(3, 3, 3, 5, 5, 5), [], '不连续不成飞机');

sigs(h(3, 3, 3, 4, 4, 4, 5, 6), ['PLANE_ONE@4/8'], '飞机带单');
sigs(h(3, 3, 3, 4, 4, 4, 5, 5), ['PLANE_ONE@4/8'], '飞机带单（翅膀同点 55）');
sigs(h(3, 3, 3, 4, 4, 4, 16, 17), ['PLANE_ONE@4/8'], '飞机带单（翅膀是王）');
sigs(h(3, 3, 3, 4, 4, 4, 5), [], '7 张不成飞机带单');

sigs(h(3, 3, 3, 4, 4, 4, 5, 5, 6, 6), ['PLANE_PAIR@4/10'], '飞机带对');
sigs(h(3, 3, 3, 4, 4, 4, 5, 5, 5, 5), ['PLANE_PAIR@4/10'], '飞机带对（翅膀 5555 当两对）');
sigs(h(3, 3, 3, 4, 4, 4, 5, 6, 7, 8), [], '翅膀凑不出对子');

// ─────────────────────────────────────────────
// 5. 四带二（§0 第 2 条：允许带一对）
// ─────────────────────────────────────────────

sigs(h(3, 3, 3, 3, 4, 5), ['FOUR_TWO_SINGLE@3/6'], '四带两单');
sigs(h(3, 3, 3, 3, 4, 4), ['FOUR_TWO_SINGLE@3/6'], '四带两单（带一对）');
sigs(h(3, 3, 3, 3, 4, 4, 5, 5), ['FOUR_TWO_PAIR@3/8'], '四带两对');
sigs(h(3, 3, 3, 3, 4, 4, 5, 6), [], '翅膀不是两对');

// ─────────────────────────────────────────────
// 6. 多解释（§5.1 那张表 —— 这是本文件最该看的一节）
// ─────────────────────────────────────────────

// 情形 A：手里有 4 组连续三张。三种读法全部有效，顺序是「不带翅膀的优先，其次主体大的优先」
sigs(
  h(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6),
  ['PLANE@6/12', 'PLANE_ONE@6/12', 'PLANE_ONE@5/12'],
  '四组连续三张 → 3 种解释',
);
eq(
  identify(h(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6)).type, TYPES.PLANE,
  '四组连续三张的首选解释是不带翅膀的 PLANE',
);

sigs(
  h(4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7),
  ['PLANE@7/12', 'PLANE_ONE@7/12', 'PLANE_ONE@6/12'],
  '四组连续三张（4..7）',
);

// 情形 B：主体的点数在手上多于 3 张，多出来的落进翅膀
// `33334444` 有两种解释，不是一种 —— 这是实现期间才发现的一处修正：
//   PLANE_ONE(2)：主体 333+444，翅膀 3+4
//   FOUR_TWO_PAIR：主体 3333，翅膀 4444（4 张同点当两对）
sigs(
  h(3, 3, 3, 3, 4, 4, 4, 4),
  ['PLANE_ONE@4/8', 'FOUR_TWO_PAIR@3/8'],
  '两个相邻的炸弹形状 → 2 种解释',
);

// ─────────────────────────────────────────────
// 7. canBeat 的回归用例（单值版本会在这里判错）
// ─────────────────────────────────────────────

{
  const table = h(3, 3, 3, 4, 4, 4, 5, 5, 5, 8, 9, 10); // PLANE_ONE(3) 主体 345
  eq(sig(identify(table)), 'PLANE_ONE@5/12', '构造出来的场上牌型是 PLANE_ONE 主体 345');

  const mine = h(4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7);
  eq(
    canBeat(mine, identify(table)), true,
    '四连飞机的那手牌，能当 PLANE_ONE(3)@456 压过 PLANE_ONE(3)@345 —— ' +
    '把 identifyAll 改回单值会让这条变红（design.md §5.1 末尾）',
  );
}

// ─────────────────────────────────────────────
// 8. beats 的判定表
// ─────────────────────────────────────────────

ok(beats(C(TYPES.ROCKET, 17, 2), C(TYPES.BOMB, 15, 4)), '王炸压炸弹（哪怕是四个 2）');
ok(!beats(C(TYPES.BOMB, 15, 4), C(TYPES.ROCKET, 17, 2)), '炸弹压不过王炸');
// 王炸不可被压 —— 这条同时保证「任何牌型自比都是 false」，与其余 13 种牌型口径一致。
// 设计文档初稿写的是「a 是王炸 → true」在前，那会让 beats(王炸, 王炸) 返回 true，
// 从而在"手里有王炸、场上也是王炸"（代码层面可构造，实战不可能）时多出一个合法着法。
ok(!beats(C(TYPES.ROCKET, 17, 2), C(TYPES.ROCKET, 17, 2)), '王炸压不过王炸');
for (const t of ALL_TYPES) ok(!beats(C(t, 9, 4), C(t, 9, 4)), `任何牌型都不能压自己：${t}`);

ok(beats(C(TYPES.BOMB, 3, 4), C(TYPES.TRIPLE_ONE, 14, 4)), '炸弹压任何普通牌型（哪怕点数最小）');
ok(!beats(C(TYPES.TRIPLE_ONE, 14, 4), C(TYPES.BOMB, 3, 4)), '普通牌型压不过炸弹');
ok(beats(C(TYPES.BOMB, 4, 4), C(TYPES.BOMB, 3, 4)), '大炸弹压小炸弹');
ok(!beats(C(TYPES.BOMB, 3, 4), C(TYPES.BOMB, 4, 4)), '小炸弹压不过大炸弹');

ok(beats(C(TYPES.SINGLE, 14, 1), C(TYPES.SINGLE, 13, 1)), '单张 A 压 K');
ok(!beats(C(TYPES.SINGLE, 15, 1), C(TYPES.SINGLE, 16, 1)), '单张 2 压不过小王');

ok(beats(C(TYPES.STRAIGHT, 7, 5), C(TYPES.STRAIGHT, 6, 5)), '同长顺子比最大点');
ok(!beats(C(TYPES.STRAIGHT, 8, 6), C(TYPES.STRAIGHT, 7, 5)), '不同长的顺子互不相压');
ok(!beats(C(TYPES.STRAIGHT, 10, 5), C(TYPES.STRAIGHT_PAIR, 10, 6)), '顺子与连对互不相压');
ok(!beats(C(TYPES.PLANE, 6, 12), C(TYPES.PLANE_ONE, 5, 12)), '飞机与飞机带单互不相压');

// 带牌不参与比较：主体相同则一样大，主体大的赢
ok(beats(C(TYPES.TRIPLE_ONE, 4, 4), C(TYPES.TRIPLE_ONE, 3, 4)), '主体大的三带一赢');
ok(!beats(C(TYPES.TRIPLE_ONE, 4, 4), C(TYPES.TRIPLE_ONE, 4, 4)), '主体相同则互不相压');

// ─────────────────────────────────────────────
// 9. mainRank 的定义（beats 的地基）
// ─────────────────────────────────────────────

const MAIN_RANK_CASES = [
  [[3], 3, '单张'],
  [[3, 3], 3, '对子'],
  [[3, 3, 3], 3, '三张'],
  [[3, 3, 3, 3], 3, '炸弹'],
  [[3, 3, 3, 4], 3, '三带一取三张的点'],
  [[3, 3, 3, 4, 4], 3, '三带二取三张的点'],
  [[3, 4, 5, 6, 7], 7, '顺子取最大点'],
  [[3, 3, 4, 4, 5, 5], 5, '连对取最大点'],
  [[3, 3, 3, 4, 4, 4], 4, '飞机取最大点'],
  [[3, 3, 3, 4, 4, 4, 5, 6], 4, '飞机带单取三张里最大的点'],
  [[3, 3, 3, 4, 4, 4, 5, 5, 6, 6], 4, '飞机带对取三张里最大的点'],
  [[3, 3, 3, 3, 4, 5], 3, '四带两单取四张的点'],
  [[3, 3, 3, 3, 4, 4, 5, 5], 3, '四带两对取四张的点'],
  [[16, 17], 17, '王炸固定 17'],
];

for (const [ranks, want, msg] of MAIN_RANK_CASES) {
  const c = identify(h(...ranks));
  eq(c ? c.mainRank : null, want, `mainRank：${msg}`);
}

// ─────────────────────────────────────────────
// 10. 不成牌型的负例
// ─────────────────────────────────────────────

sigs([], [], '空手牌');
sigs(h(3, 3, 3, 4, 4, 5, 5), [], '7 张不成任何牌型');
sigs(h(3, 3, 4, 4, 5), [], '5 张的 [2,2,1] 不成牌型');
sigs(h(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15), [], '13 张含 2');
sigs(h(3, 3, 5, 5, 7, 7), [], '不连续的三个对子');
sigs(h(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7), [], '13 张（多一张）');

// 输入校验：重复的牌、越界的牌都不算牌型
eq(identifyAll([0, 0, 0, 0, 0]).length, 0, '重复的牌不成牌型');
eq(identifyAll([54]).length, 0, '越界的牌不成牌型');
eq(identifyAll([-1]).length, 0, '负数牌不成牌型');

// ─────────────────────────────────────────────
// 11. 通用不变量（跑随机形状，覆盖上表的手工用例漏掉的情况）
// ─────────────────────────────────────────────

/** 除 A 情形之外的「多解释」猜想：必有一个点的张数 ≥ 4，或有 4 个连续的点都 ≥ 3 */
function guardOk(cards) {
  const counts = rankCounts(cards);
  for (let r = 3; r <= 17; r++) if (counts[r] >= 4) return true;
  for (let r = 3; r + 3 <= 14; r++) {
    if (counts[r] >= 3 && counts[r + 1] >= 3 && counts[r + 2] >= 3 && counts[r + 3] >= 3) return true;
  }
  return false;
}

{
  // 不用 cards.js 的 mulberry32 之外的随机源，保证这个测试也是可复现的
  let seed = 20260915;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let multiSeen = 0;
  let shapesSeen = 0;

  for (let iter = 0; iter < 20000; iter++) {
    const kindCount = 1 + Math.floor(rng() * 5);   // 1~5 个不同的点
    const pool = [];
    for (let r = 3; r <= 14; r++) pool.push(r);    // 只用 3..A，命中有趣形状的概率更高
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const ranks = pool.slice(0, kindCount);

    const cards = [];
    for (const r of ranks) {
      const cnt = 1 + Math.floor(rng() * 4);       // 1~4 张
      for (let i = 0; i < cnt && cards.length < 20; i++) cards.push(cardOf(r, i));
    }
    if (cards.length === 0) continue;
    const hand = sortHand(cards);

    const all = identifyAll(hand);
    shapesSeen++;
    if (all.length >= 2) multiSeen++;

    // 每个解释的 length 必须等于输入张数，cards 必须与输入是同一组
    for (const c of all) {
      eq(c.length, hand.length, `解释 ${sig(c)} 的 length 与输入不一致`);
      eq(c.cards.join(','), hand.join(','), `解释 ${sig(c)} 的 cards 与输入不一致`);
    }

    // 解释里的每一个都必须能压过「同型同长但主体小一点」的牌（王炸除外）
    for (const c of all) {
      if (c.type === TYPES.ROCKET) continue;
      const lower = C(c.type, c.mainRank - 1, c.length);
      ok(beats(c, lower), `${sig(c)} 应当能压过主体更小的同型牌`);
    }

    // 守门断言（§11.1）：出现多解释时，手里必定满足情形 A 或 B
    if (all.length >= 2) {
      ok(guardOk(hand), `多解释但不符合情形 A/B：${JSON.stringify(rankCounts(hand))} → ${all.map(sig).join(' ')}`);
    }

    // canBeat 与 identifyAll 的一致性：首出时「成牌型」就是「可以出」
    eq(canBeat(hand, null), all.length > 0, 'canBeat(hand, null) 必须等于「成牌型」');
  }

  ok(multiSeen > 50, `随机样本里应当出现足够多的多解释形状（实际 ${multiSeen} / ${shapesSeen}）`);
}

// ─────────────────────────────────────────────
// 12. 14 种牌型都有正例（防止 ALL_TYPES 与实现脱节）
// ─────────────────────────────────────────────

{
  const seenTypes = new Set();
  const samples = [
    h(3), h(3, 3), h(3, 3, 3), h(3, 3, 3, 4), h(3, 3, 3, 4, 4),
    h(3, 4, 5, 6, 7), h(3, 3, 4, 4, 5, 5), h(3, 3, 3, 4, 4, 4),
    h(3, 3, 3, 4, 4, 4, 5, 6), h(3, 3, 3, 4, 4, 4, 5, 5, 6, 6),
    h(3, 3, 3, 3, 4, 5), h(3, 3, 3, 3, 4, 4, 5, 5),
    h(3, 3, 3, 3), h(16, 17),
  ];
  for (const s of samples) for (const c of identifyAll(s)) seenTypes.add(c.type);
  for (const t of ALL_TYPES) ok(seenTypes.has(t), `牌型 ${t} 没有正例`);
  ok(comboName(identify(h(3, 3, 3, 4))).includes('三带一'), 'comboName 可读');
}

// === 收尾 ===
console.log(`test-combo: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
