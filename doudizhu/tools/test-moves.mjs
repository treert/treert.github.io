/**
 * 合法出牌生成的测试（design.md §11.2）。
 *
 * 跑法：node doudizhu/tools/test-moves.mjs
 *
 * 核心是**暴力法核对**：§5.3 那个集合定义本身就是规范，所以这里把它直接跑一遍 ——
 * 枚举手牌的全部子集，按定义过滤，得到「点数签名」的集合，
 * 再断言它与 `legalPlays` 的输出**逐元素相等**。
 *
 * 这不是"我猜一个期望值"，而是"把定义跑一遍"。所以它同时钉住了两件事：
 * moves.js 没有漏（完备）也没有多（正确），而且它与 combo.js 的 canBeat 口径一致。
 *
 * 手牌越大、子集越多：2^14 = 16384，所以暴力法只跑到 14 张。
 * 16 张以上的形状（飞机带单 n=4、飞机带对 n=3）用定向用例补。
 */

import {
  cardOf, sortHand, rankOf, DECK_SIZE, RANK_MIN, RANK_A,
} from '../js/cards.js';
import { identifyAll, identify, canBeat, TYPES } from '../js/combo.js';
import {
  legalPlays, enumerateCombos, hasAnyPlay, rankSignature, isPass, moveLabel,
} from '../js/moves.js';

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

function h(...ranks) {
  const used = new Map();
  const cards = ranks.map((r) => {
    const k = used.get(r) || 0;
    used.set(r, k + 1);
    if (k >= (r >= 16 ? 1 : 4)) throw new Error(`点数 ${r} 取了 ${k + 1} 张`);
    return cardOf(r, k);
  });
  return sortHand(cards);
}

/** 只留 play 的点数签名集合 */
function playSigs(moves) {
  const out = new Set();
  for (const m of moves) if (!isPass(m)) out.add(rankSignature(m.cards));
  return out;
}

function setEq(got, want, msg) {
  const missing = [...want].filter((s) => !got.has(s));
  const extra = [...got].filter((s) => !want.has(s));
  if (!missing.length && !extra.length) { passed++; return; }
  failures.push(
    `${msg}\n    漏了 ${missing.length} 个：${missing.slice(0, 8).join(' | ')}`
    + `\n    多了 ${extra.length} 个：${extra.slice(0, 8).join(' | ')}`,
  );
}

/**
 * 暴力法：把 §5.3 的定义直接跑一遍。
 * 返回「能出的那些牌组」的点数签名集合（不含 pass）。
 */
function bruteForce(hand, lastCombo) {
  const n = hand.length;
  const out = new Set();
  for (let mask = 1; mask < (1 << n); mask++) {
    const S = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) S.push(hand[i]);
    const good = lastCombo ? canBeat(S, lastCombo) : identifyAll(S).length > 0;
    if (good) out.add(rankSignature(S));
  }
  return out;
}

// ─────────────────────────────────────────────
// 1. 首出：不含 pass，且每个候选都成牌型
// ─────────────────────────────────────────────

{
  const hand = h(3, 3, 3, 4, 4, 4, 5, 6);
  const moves = legalPlays(hand, null);
  ok(moves.length > 0, '首出有候选');
  ok(moves.every((m) => m.kind === 'play'), '首出**不含 pass** —— 首出必须出牌');
  for (const m of moves) {
    ok(identifyAll(m.cards).length > 0, `${moveLabel(m)} 应当成牌型`);
    ok(m.cards.length > 0, '候选不能是空');
    ok(new Set(m.cards).size === m.cards.length, '候选内不能有重复的牌');
    for (const c of m.cards) ok(hand.includes(c), '候选必须是手牌的子集');
  }
}

// ─────────────────────────────────────────────
// 2. 跟牌：含 pass，且每个候选都压得过
// ─────────────────────────────────────────────

{
  const hand = h(3, 3, 3, 4, 4, 4, 5, 6);
  const last = identify(h(3, 3, 3, 3)); // 炸弹
  const moves = legalPlays(hand, last);
  ok(moves.filter(isPass).length === 1, '跟牌恰好有一个 pass');
  for (const m of moves) {
    if (isPass(m)) continue;
    ok(canBeat(m.cards, last), `${moveLabel(m)} 应当压得过场上的炸弹`);
  }
  ok(!hasAnyPlay(hand, last), '手里没有比这张炸弹更大的牌 → hasAnyPlay 为假');

  const lastSmall = identify(h(3)); // 单张 3
  ok(hasAnyPlay(hand, lastSmall), '手里有能压单张 3 的牌');
}

// ─────────────────────────────────────────────
// 3. 炸弹与王炸在跟牌时永远出现
// ─────────────────────────────────────────────

{
  // 手上有 9 炸弹 + 王炸
  const hand = h(9, 9, 9, 9, 16, 17, 5, 6);
  for (const last of [identify(h(14)), identify(h(3, 3, 3, 4, 4)), identify(h(3, 3, 3, 3))]) {
    const got = playSigs(legalPlays(hand, last));
    ok(got.has(rankSignature(h(9, 9, 9, 9))), `炸弹必须出现在跟牌候选里（场上 ${last.type}）`);
    ok(got.has(rankSignature(h(16, 17))), `王炸必须出现在跟牌候选里（场上 ${last.type}）`);
  }

  // 小炸弹压不过大炸弹
  const smallBomb = h(3, 3, 3, 3, 5, 6, 7, 8);
  const got2 = playSigs(legalPlays(smallBomb, identify(h(9, 9, 9, 9))));
  ok(!got2.has(rankSignature(h(3, 3, 3, 3))), '3 炸弹压不过 9 炸弹');

  // 场上已经是王炸 → 谁都压不过，只剩 pass
  // （这是退化输入：同一副牌里不可能同时有两组王炸。这里只确认不会崩、且结果只剩 pass）
  const vsRocket = legalPlays(smallBomb, identify(h(16, 17)));
  eq(vsRocket.length, 1, '王炸压不过任何人');
  eq(isPass(vsRocket[0]), true, '只剩 pass');
}

// ─────────────────────────────────────────────
// 4. 多解释的候选不会被漏掉（§11.1 那个 bug 的另一面）
// ─────────────────────────────────────────────

{
  const mine = h(4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7);
  const table = identify(h(3, 3, 3, 4, 4, 4, 5, 5, 5, 8, 9, 10)); // PLANE_ONE(3) 主体 345
  eq(table.type, TYPES.PLANE_ONE, '场上牌型是 PLANE_ONE');

  const got = playSigs(legalPlays(mine, table));
  ok(
    got.has(rankSignature(mine)),
    '「把 12 张全出掉」必须在候选里 —— 它当 PLANE_ONE(3)@456 能压过 PLANE_ONE(3)@345',
  );
}

// ─────────────────────────────────────────────
// 5. 纯函数：不改手牌、可重复调用
// ─────────────────────────────────────────────

{
  const hand = h(3, 3, 3, 4, 4, 5, 6, 7, 8);
  const before = hand.join(',');
  const a = legalPlays(hand, null).map(moveLabel).join(' ');
  const b = legalPlays(hand, null).map(moveLabel).join(' ');
  eq(hand.join(','), before, 'legalPlays 不改手牌');
  eq(a, b, 'legalPlays 结果稳定（同样的输入给同样的顺序）');
  eq(enumerateCombos(hand).map((c) => c.join(',')).join(' '), enumerateCombos(hand).map((c) => c.join(',')).join(' '),
    'enumerateCombos 结果稳定');
}

// ─────────────────────────────────────────────
// 6. 手写的定向用例（读起来能看懂"到底该出哪些"）
// ─────────────────────────────────────────────

{
  // 只剩一张牌：首出必须出它
  const one = h(5);
  const m1 = legalPlays(one, null);
  eq(m1.length, 1, '只有一张牌时首出只有一个候选');
  eq(rankSignature(m1[0].cards), '5', '而且就是那张牌');

  // 手里全是大牌，场上一个 2 → 只剩炸弹/王炸能压
  const noBomb = h(9, 9, 10, 10, 11, 11);
  const vsTwo = legalPlays(noBomb, identify(h(15)));
  eq(noBomb.some((c) => rankOf(c) === 16 || rankOf(c) === 17), false, '这手牌没有王');
  ok(vsTwo.every(isPass), '没有炸弹也没有王 → 压不过单张 2，只剩 pass');

  // 顺子：手里 3..9，场上是 45678，只有 56789 能压
  const straightHand = h(3, 4, 5, 6, 7, 8, 9);
  const vsStraight = identify(h(4, 5, 6, 7, 8));
  const straights = legalPlays(straightHand, vsStraight)
    .filter((m) => !isPass(m))
    .filter((m) => identifyAll(m.cards).some((c) => c.type === TYPES.STRAIGHT))
    .map((m) => rankSignature(m.cards));
  ok(straights.includes('5,6,7,8,9'), '56789 应当能压 45678');
  ok(!straights.includes('3,4,5,6,7'), '34567 压不过 45678（更小）');
}

// ─────────────────────────────────────────────
// 7. 暴力法核对（本文件的核心）
// ─────────────────────────────────────────────

{
  let seed = 987654321;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let cases = 0;
  let bruteCalled = 0;
  let maxPlays = 0;

  const runCase = (hand, lastCombo, msg) => {
    const got = playSigs(legalPlays(hand, lastCombo));
    const want = bruteForce(hand, lastCombo);
    setEq(got, want, msg);
    cases++;
    bruteCalled++;
    if (got.size > maxPlays) maxPlays = got.size;

    // pass 的有无必须与「是否跟牌」一致
    const passes = legalPlays(hand, lastCombo).filter(isPass).length;
    eq(passes, lastCombo ? 1 : 0, `pass 的有无：${msg}`);
  };

  // 随机手牌（≤ 12 张，子集数 ≤ 4096）
  for (let iter = 0; iter < 60; iter++) {
    const kindCount = 2 + Math.floor(rng() * 5);
    const pool = [];
    for (let r = RANK_MIN; r <= RANK_A; r++) pool.push(r);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const cards = [];
    for (const r of pool.slice(0, kindCount)) {
      const cnt = 1 + Math.floor(rng() * 4);
      for (let i = 0; i < cnt && cards.length < 12; i++) cards.push(cardOf(r, i));
    }
    if (cards.length === 0) continue;
    const hand = sortHand(cards);

    // 首出
    runCase(hand, null, `随机手牌首出 #${iter}`);

    // 跟牌：场上的牌用「这手牌自己的某个子集」造，保证是真实可能的牌型
    const combos = enumerateCombos(hand);
    for (let pick = 0; pick < 2 && combos.length; pick++) {
      const last = identify(combos[Math.floor(rng() * combos.length)]);
      if (last) runCase(hand, last, `随机手牌跟牌 #${iter}/${pick}`);
    }
  }

  // 定向：14 张（2^14 = 16384 个子集），覆盖顺子 / 连对 / 飞机带对
  const bigCases = [
    h(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15),
    h(3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9),
    h(3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8),
    h(3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8),
  ];
  for (const hand of bigCases) {
    runCase(hand, null, `定向 14 张首出 ${rankSignature(hand)}`);
    const last = identify(hand.slice(0, 5));
    if (last) runCase(hand, last, `定向 14 张跟牌 ${rankSignature(hand)}`);
  }

  // 定向：16 张以上（暴力法跑不动，只核对手工算得出来的那几种）
  {
    // 飞机带单 n=4：主体 3456 各三张 + 4 张翅膀
    const hand = h(3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 9, 10, 11, 12);
    const got = playSigs(legalPlays(hand, null));
    ok(got.has(rankSignature(hand)), '16 张：飞机带单 n=4（把 16 张全出掉）应当在候选里');
    const all = legalPlays(hand, null);
    for (const m of all) {
      ok(identifyAll(m.cards).length > 0, `16 张首出的候选都应当成牌型：${moveLabel(m)}`);
    }
    ok(all.length > 0, '16 张首出有候选');
  }

  // 20 张（地主拿底牌后的上限）：只断言"能跑完且候选都合法"
  {
    const hand = h(
      3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 9, 10,
    );
    const t0 = Date.now();
    const all = legalPlays(hand, null);
    const ms = Date.now() - t0;
    ok(all.length > 0, '20 张首出有候选');
    for (const m of all) ok(identifyAll(m.cards).length > 0, '20 张首出的候选都应当成牌型');
    ok(ms < 2000, `20 张的一手候选生成应当快（实测 ${ms}ms，${all.length} 个候选）`);
    console.log(`  20 张手牌的首出候选数：${all.length}（${ms}ms）`);
  }

  console.log(`  暴力法核对跑了 ${cases} 个局面，单个局面最多 ${maxPlays} 个候选`);
  ok(cases >= 100, `暴力法核对的局面数应当足够多（实际 ${cases}）`);
}

// ─────────────────────────────────────────────
// 8. 兜底：一整副牌里的任意一手都不该抛异常
// ─────────────────────────────────────────────

{
  let seed = 424242;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let iter = 0; iter < 200; iter++) {
    const deck = [];
    for (let c = 0; c < DECK_SIZE; c++) deck.push(c);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const hand = sortHand(deck.slice(0, 17));
    const last = identify(sortHand(deck.slice(17, 22)));
    let moves;
    try {
      moves = legalPlays(hand, last);
    } catch (err) {
      failures.push(`真实发牌的一手牌让 legalPlays 抛异常：${err.message}\n    ${rankSignature(hand)}`);
      continue;
    }
    ok(moves.length > 0, '真实手牌至少有 pass');
    for (const m of moves) {
      if (isPass(m)) continue;
      ok(canBeat(m.cards, last), `候选必须压得过（或场上没有牌）`);
    }
  }
}

// === 收尾 ===
console.log(`test-moves: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures.slice(0, 20)) console.log('  ✗ ' + f);
  if (failures.length > 20) console.log(`  …还有 ${failures.length - 20} 条`);
  process.exit(1);
}
