/**
 * 牌的编码、洗牌、发牌的测试（design.md §4.1、§8.2）。
 *
 * 跑法：node doudizhu/tools/test-cards.mjs
 *
 * 这里钉的是**不变量**而不是具体值：一副牌必须是 0..53 的一个排列，
 * 发牌只是把它切三份加三张底牌。这类断言比"期望某张牌在某人手里"可靠得多，
 * 而且它挡的正是最坏的一类 bug —— 多一张 / 少一张 / 重复一张，
 * 那种错会让后面的计数、AI 采样、存档校验全部跟着歪。
 */

import {
  DECK_SIZE, JOKER_SMALL, JOKER_BIG, RANK_MIN, RANK_2, RANK_JOKER_SMALL, RANK_JOKER_BIG,
  RANK_STRAIGHT_MAX, SUITS, HAND_SIZE, TRUMP_SIZE,
  rankOf, suitOf, cardOf, isJoker, cardLabel, handLabel, rankCounts, sortHand,
  cardsOfRank, ranksIn, removeCards, isSubset, fullDeck, mulberry32, shuffle, deal,
} from '../js/cards.js';

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

// ─────────────────────────────────────────────
// 1. 编码往返
// ─────────────────────────────────────────────

// 3..15 每个点数 4 张：rank 与花色能往返，且 card 与「rank 升序、花色升序」一致
for (let rank = RANK_MIN; rank <= RANK_2; rank++) {
  for (let suit = 0; suit < 4; suit++) {
    const c = cardOf(rank, suit);
    eq(rankOf(c), rank, `rankOf(cardOf(${rank}, ${suit}))`);
    eq(suitOf(c), suit, `suitOf(cardOf(${rank}, ${suit}))`);
    eq(isJoker(c), false, `普通牌不是王：${rank}`);
  }
}
eq(cardOf(RANK_JOKER_SMALL), JOKER_SMALL, '小王 = 52');
eq(cardOf(RANK_JOKER_BIG), JOKER_BIG, '大王 = 53');
eq(rankOf(JOKER_SMALL), RANK_JOKER_SMALL, '52 是小王');
eq(rankOf(JOKER_BIG), RANK_JOKER_BIG, '53 是大王');
eq(suitOf(JOKER_SMALL), -1, '王没有花色');

// 0..51 的 card 值恰好覆盖 3..15 × 4 花色，无重无漏
{
  const seen = new Set();
  for (let c = 0; c < 52; c++) seen.add(`${rankOf(c)}-${suitOf(c)}`);
  eq(seen.size, 52, '0..51 的 (rank, suit) 组合数');
}

// 顺子的上界是 A（14）—— 这个常数错了会让顺子多出「A2345」这种非法牌型
eq(RANK_STRAIGHT_MAX, 14, '顺子主体上界是 A');
eq(SUITS.length, 4, '花色数');

// ─────────────────────────────────────────────
// 2. 派生函数
// ─────────────────────────────────────────────

{
  const hand = sortHand([cardOf(3, 0), cardOf(3, 2), cardOf(5, 1), JOKER_BIG]);
  eq(handLabel(hand), '[♠3 ♦3 ♥5 大王]', 'handLabel');
  const counts = rankCounts(hand);
  eq(counts[3], 2, 'rankCounts：3 有两张');
  eq(counts[5], 1, 'rankCounts：5 有一张');
  eq(counts[RANK_JOKER_BIG], 1, 'rankCounts：大王一张');
  eq(counts[4], 0, 'rankCounts：没有 4');
  eq(counts.length, 18, 'rankCounts 长度按 rank 0..17 开');

  eq(cardsOfRank(hand, 3).length, 2, 'cardsOfRank：3 的具体牌有两张');
  eq(ranksIn(hand).join(','), '3,5,17', 'ranksIn 升序去重');

  const rest = removeCards(hand, cardsOfRank(hand, 3));
  eq(rest.length, 2, 'removeCards 之后剩两张');
  eq(rest.includes(cardOf(3, 0)), false, 'removeCards 去掉了指定的牌');

  ok(isSubset(hand, cardsOfRank(hand, 3)), '自己的牌是自己的子集');
  ok(!isSubset(hand, [cardOf(4, 0)]), '不在手里的牌不是子集');
  ok(isSubset(hand, []), '空集是任何集合的子集');

  // sortHand 是纯函数，不改原数组
  const before = [cardOf(5, 0), cardOf(3, 0)];
  const copy = before.slice();
  sortHand(before);
  eq(before.join(','), copy.join(','), 'sortHand 不改原数组');
  // 按 card 升序 == 按 rank 升序再按花色升序
  eq(sortHand(before).join(','), [cardOf(3, 0), cardOf(5, 0)].join(','), 'sortHand 结果');
}

// ─────────────────────────────────────────────
// 3. 洗牌与发牌的不变量（跑 200 次）
// ─────────────────────────────────────────────

{
  const rng = mulberry32(20260915);

  for (let iter = 0; iter < 200; iter++) {
    const deck = shuffle(fullDeck(), rng);
    eq(deck.length, DECK_SIZE, '洗牌后张数不变');
    eq(new Set(deck).size, DECK_SIZE, '洗牌后无重复');

    const { hands, trump } = deal(rng);
    eq(hands.length, 3, '三家');
    for (const hand of hands) eq(hand.length, HAND_SIZE, '每家 17 张');
    eq(trump.length, TRUMP_SIZE, '底牌 3 张');

    const all = [...hands[0], ...hands[1], ...hands[2], ...trump];
    eq(all.length, DECK_SIZE, '三家手牌 + 底牌 = 54 张');
    eq(new Set(all).size, DECK_SIZE, '54 张无重复无遗漏');
    for (let c = 0; c < DECK_SIZE; c++) {
      ok(all.includes(c), `牌 ${cardLabel(c)} 出现了`);
    }

    // 每家手牌都必须是升序的（§4.1 的约定，UI 与枚举都依赖它）
    for (const hand of hands) {
      eq(hand.join(','), sortHand(hand).join(','), '发出来的手牌已排序');
    }
  }

  // 同一个种子必须发出同一局牌 —— 这是 AI 可复现测试的前提
  const a = deal(mulberry32(42));
  const b = deal(mulberry32(42));
  eq(JSON.stringify(a), JSON.stringify(b), '同一个 seed 发同一局牌');
  const c = deal(mulberry32(43));
  ok(JSON.stringify(a) !== JSON.stringify(c), '不同 seed 发不同牌');
}

// === 收尾 ===
console.log(`test-cards: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
