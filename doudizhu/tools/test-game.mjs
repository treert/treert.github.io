/**
 * 对局状态机的测试（design.md §11.3），外加叫分评分（§6.1）与 view（§4.5）。
 *
 * 跑法：node doudizhu/tools/test-game.mjs
 *
 * 这里钉三样东西：
 *   1. 每条规则的**边界**（叫分的 5 条、墩的轮转、非法着法的 reason 非空、春天/反春天）
 *   2. 对局过程中的**守恒不变量**（54 张不多不少、牌不重复、不能压自己）
 *   3. **随机走完一局**（本文件末尾）—— 这是 §11.5 selfplay 的一个精简版，
 *      单测覆盖不到的"状态组合"靠它兜。象棋那边的经验是：这类 bug 单测全绿、
 *      随机对局一次就抓到（见 chinese-chess/README 关键设计决策第 8 条）。
 */

import {
  cardOf, sortHand, fullDeck, DECK_SIZE, HAND_SIZE,
} from '../js/cards.js';
import { legalPlays } from '../js/moves.js';
import { handScore, handShape } from '../js/evaluate.js';
import { bidForScore, decideBid, isLegalBid, legalBids } from '../js/bid.js';
import {
  createGame, bid, play, biddingSeat, currentBestScore,
  nextSeat, canSeatPass, multiplierOf,
} from '../js/game.js';
import { viewOf, unseenOf, playedOf, canPass, otherSeats } from '../js/view.js';
import { findLevel, BID_MAX, SEATS } from '../js/config.js';

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

function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 造一个已经进入出牌阶段的局面，手牌可以被测试直接指定（白盒：状态机就是被测对象） */
function setup(opts = {}) {
  const game = createGame({
    rng: rngFrom(opts.seed || 1),
    landlord: opts.landlord === undefined ? 0 : opts.landlord,
    bidScore: opts.bidScore || 1,
  });
  if (opts.hands) {
    game.hands = opts.hands.map((x) => sortHand(x));
    // 补上底牌，否则计分/守恒断言会不准
    if (opts.trump) game.trump = sortHand(opts.trump);
  }
  return game;
}

// ─────────────────────────────────────────────
// 1. 叫分（§5.5 的 5 条规则 + view 的时机）
// ─────────────────────────────────────────────

{
  const game = createGame({ rng: rngFrom(7) });
  eq(game.phase, 'bidding', '新局处在叫分阶段');
  eq(game.landlord, null, '还没定地主');
  eq(game.turn, null, '叫分阶段 turn 无意义（读 biddingSeat）');
  eq(game.trump.length, 3, '引擎里有 3 张底牌');
  for (const hand of game.hands) eq(hand.length, HAND_SIZE, '每家 17 张');

  const v = viewOf(game, 0);
  eq(v.trump.length, 0, '叫分阶段 view.trump 必须是 []（底牌谁都看不到）');
  for (const p of v.players) eq(p.handCount, HAND_SIZE, '叫分阶段三家都是 17 张');
  eq(v.role, null, '叫分阶段还没有角色');

  // 起始座位随机（跑 300 次，三个座位都得当过起始者）
  const starts = new Set();
  for (let i = 0; i < 300; i++) starts.add(biddingSeat(createGame({ rng: rngFrom(i + 1) })));
  eq(starts.size, SEATS, '起始叫分座位覆盖三个座位（不能固定顺序）');
}

// 只能叫更高的分（叫平也不允许）；不是你的回合会被拒
{
  const game = createGame({ rng: rngFrom(11) });
  const first = biddingSeat(game);
  const second = nextSeat(first);

  const wrong = bid(game, second, 1, rngFrom(1));
  eq(wrong.ok, false, '不是你的回合 → 被拒');
  ok(wrong.reason.length > 0, '被拒必须带原因');

  eq(bid(game, first, 1, rngFrom(1)).ok, true, '第一个叫 1 分');
  eq(currentBestScore(game), 1, '当前最高分 1');

  const flat = bid(game, second, 1, rngFrom(1));
  eq(flat.ok, false, '叫平（1 分）被拒');
  ok(flat.reason.includes('必须高于'), '原因要说清"必须高于 N 分"');
  eq(bid(game, second, 0, rngFrom(1)).ok, true, '不叫永远合法');
}

// 叫到 3 分立即结束，后面的人不再表态
{
  const game = createGame({ rng: rngFrom(13) });
  const first = biddingSeat(game);
  const second = nextSeat(first);
  const third = nextSeat(second);

  const r = bid(game, first, BID_MAX, rngFrom(1));
  eq(r.ok, true, '叫 3 分');
  eq(game.phase, 'playing', '立即进入出牌阶段');
  eq(game.landlord, first, '叫 3 分的人当地主');
  eq(game.bidding.calls[second], null, '后面的人没表态（calls 仍是 null）');
  eq(game.bidding.calls[third], null, '后面的人没表态（calls 仍是 null）');
  eq(game.hands[first].length, HAND_SIZE + 3, '地主拿到底牌 → 20 张');
  eq(game.trick.leader, first, '地主是首出');
  eq(game.turn, first, '首出轮到地主');
  eq(game.bidScore, BID_MAX, '底分 = 叫到的分');

  const v = viewOf(game, first);
  eq(v.trump.length, 3, '定地主后底牌是公开信息');
  eq(v.role, 'landlord', '地主的角色');
  eq(viewOf(game, second).role, 'farmer', '农民的角色');
  const vf = viewOf(game, second);
  ok(vf.trump.every((c) => !vf.myHand.includes(c)), '农民的 myHand 里不含底牌');
}

// 每人只有一次机会：一轮走完就定地主
{
  const game = createGame({ rng: rngFrom(17) });
  const order = game.bidding.order.slice();
  eq(bid(game, order[0], 0, rngFrom(1)).ok, true, '第一个人不叫');
  eq(bid(game, order[1], 0, rngFrom(1)).ok, true, '第二个人不叫');
  eq(bid(game, order[2], 2, rngFrom(1)).ok, true, '第三个人叫 2 分');
  eq(game.phase, 'playing', '一轮走完 → 进入出牌阶段');
  eq(game.landlord, order[2], '最高分者当地主');
  eq(game.bidScore, 2, '底分 2');
}

// 三家都不叫 → 流局重发（手牌换新、叫分从头开始、重发次数累计）
{
  const game = createGame({ rng: rngFrom(19) });
  const before = game.hands[0].join(',');
  const order = game.bidding.order.slice();

  bid(game, order[0], 0, rngFrom(2));
  bid(game, order[1], 0, rngFrom(2));
  const r = bid(game, order[2], 0, rngFrom(2));

  eq(r.ok, true, '第三个人也不叫');
  eq(r.redeal, true, '返回 redeal 标记');
  eq(game.phase, 'bidding', '流局后回到叫分阶段');
  eq(game.landlord, null, '还是没有地主');
  eq(game.bidding.index, 0, '叫分从头开始');
  eq(game.bidding.redeals, 1, '重发次数累计到 1');
  ok(game.bidding.calls.every((c) => c === null), '叫分记录清空');
  eq(game.hands[0].length, HAND_SIZE, '重发后还是 17 张');
  ok(game.hands[0].join(',') !== before, '重发后手牌是新的（54 张洗过）');

  // 不传 rng 时重发是编程错误，必须抛（不默认 Math.random，否则"可复现"是假的）
  const game2 = createGame({ rng: rngFrom(23) });
  const o2 = game2.bidding.order.slice();
  bid(game2, o2[0], 0, rngFrom(2));
  bid(game2, o2[1], 0, rngFrom(2));
  let threw = false;
  try { bid(game2, o2[2], 0); } catch { threw = true; }
  ok(threw, '三家都不叫又没给 rng → 抛异常（这是编程错误）');
}

// 测试入口：跳过叫分直接指定地主
{
  const game = createGame({ rng: rngFrom(29), landlord: 1, bidScore: 2 });
  eq(game.phase, 'playing', 'createGame({landlord}) 直接进入出牌阶段');
  eq(game.landlord, 1, '地主是指定的那家');
  eq(game.hands[1].length, HAND_SIZE + 3, '指定地主也拿底牌');
  eq(game.bidding.calls[0], null, '没有产生叫分记录');
  eq(game.turn, 1, '指定地主是首出');
}

// ─────────────────────────────────────────────
// 2. 墩的轮转（§5.4）
// ─────────────────────────────────────────────

{
  const game = setup({
    landlord: 0,
    hands: [h(3, 4, 5), h(6, 7, 8), h(9, 10, 11)],
  });
  eq(game.trick.leader, 0, '地主首出');

  const noFirstPass = play(game, 0, { kind: 'pass' });
  eq(noFirstPass.ok, false, '首出不能不要');
  eq(noFirstPass.reason.includes('首出'), true, '原因要说明是首出');

  eq(play(game, 0, { kind: 'play', cards: h(3) }).ok, true, '地主出单张 3');
  eq(game.turn, 1, '轮到下家');
  eq(canSeatPass(game, 1), true, '下家可以不要');
  eq(canSeatPass(game, 0), false, '首出方不能压自己');
  eq(canPass(viewOf(game, 0)), false, 'view 那边口径一致');

  eq(play(game, 1, { kind: 'pass' }).ok, true, '下家不要');
  eq(game.turn, 2, '轮到第三家');
  eq(game.trick.passes, 1, '过了 1 家');

  eq(play(game, 2, { kind: 'pass' }).ok, true, '第三家也不要');
  eq(game.trick.lastPlay, null, '两家都不要 → 本墩结束，lastPlay 清空');
  eq(game.trick.leader, 0, '首出方重新首出');
  eq(game.turn, 0, '轮回到首出方');
  eq(game.trick.passes, 0, 'passes 归零');
  eq(game.history.length, 3, '三次动作都进了历史');

  // 被人压过之后，首出方这一墩就由压他的人重新首出
  eq(play(game, 0, { kind: 'play', cards: h(4) }).ok, true, '首出 4');
  eq(play(game, 1, { kind: 'play', cards: h(6) }).ok, true, '下家用 6 压');
  eq(play(game, 2, { kind: 'pass' }).ok, true, '第三家不要');
  eq(play(game, 0, { kind: 'pass' }).ok, true, '首出方也不要');
  eq(game.trick.leader, 1, '压过的那家成为新的首出方');
  eq(game.turn, 1, '轮到他首出');
  eq(game.trick.lastPlay, null, 'lastPlay 清空');
}

// ─────────────────────────────────────────────
// 3. 非法着法被拒，且每条都带原因
// ─────────────────────────────────────────────

{
  const game = setup({ landlord: 0, hands: [h(3, 4, 5), h(6, 7, 8), h(9, 10, 11)] });
  const cases = [
    [() => play(game, 1, { kind: 'play', cards: h(6) }), '不是你的回合'],
    [() => play(game, 0, { kind: 'play', cards: h(16) }), '出了手上没有的牌'],
    [() => play(game, 0, { kind: 'play', cards: h(3, 4) }), '不成牌型'],
    [() => play(game, 0, { kind: 'play', cards: [] }), '没有选择要出的牌'],
    [() => play(game, 0, { kind: 'play', cards: h(3, 3) }), '重复的牌'],
  ];
  for (const [fn, msg] of cases) {
    const r = fn();
    eq(r.ok, false, `被拒：${msg}`);
    ok(r.reason.length > 0, `被拒必须带原因：${msg}`);
  }

  // 压不过
  play(game, 0, { kind: 'play', cards: h(5) });
  const cannot = play(game, 1, { kind: 'play', cards: h(6, 6) });
  eq(cannot.ok, false, '压不过（牌型不同/更小）被拒');
  ok(cannot.reason.length > 0, '压不过的 reason 非空');

  // 终局之后再出牌
  const done = setup({ landlord: 0, hands: [h(3), h(4), h(5)] });
  play(done, 0, { kind: 'play', cards: h(3) });
  eq(done.phase, 'finished', '地主出完 → 结束');
  const after = play(done, 1, { kind: 'play', cards: h(4) });
  eq(after.ok, false, '终局之后不能再出牌');
}

// ─────────────────────────────────────────────
// 4. 终局与计分（§5.6）
// ─────────────────────────────────────────────

{
  // 地主出完 → 地主胜，农民一手没出过 → 春天
  const g1 = setup({ landlord: 0, bidScore: 1, hands: [h(3, 3), h(4), h(5)] });
  play(g1, 0, { kind: 'play', cards: h(3, 3) });
  eq(g1.phase, 'finished', '出完即结束');
  eq(g1.result.winner, 'landlord', '地主胜');
  eq(g1.result.spring, 'spring', '农民一手没出 → 春天');
  eq(g1.result.multiplier, 1 * 1 * 2, '倍数 = 底分 1 × 叫分 1 × 春天 2');

  // 农民出完 → 农民胜；地主只出过一手 → 反春天
  const g2 = setup({ landlord: 0, bidScore: 2, hands: [h(3, 4), h(5), h(6)] });
  play(g2, 0, { kind: 'play', cards: h(3) });
  eq(g2.playedCounts[0], 1, '地主出过一手');
  play(g2, 1, { kind: 'play', cards: h(5) });
  eq(g2.result.winner, 'farmers', '农民胜');
  eq(g2.result.spring, 'anti', '地主只出过一手 → 反春天');
  eq(g2.result.multiplier, 1 * 2 * 2, '倍数 = 1 × 叫分 2 × 反春天 2');

  // 普通一局：地主胜，但农民出过牌 → 不是春天；没有炸弹 → 倍数是叫分
  const g3 = setup({ landlord: 0, bidScore: 3, hands: [h(3, 14), h(6, 7), h(8, 9)] });
  play(g3, 0, { kind: 'play', cards: h(3) });
  play(g3, 1, { kind: 'play', cards: h(6) });   // 农民出过牌
  play(g3, 2, { kind: 'pass' });
  play(g3, 0, { kind: 'play', cards: h(14) });  // 地主出完
  eq(g3.result.winner, 'landlord', '地主胜');
  eq(g3.result.spring, 'none', '农民出过牌 → 不是春天');
  eq(g3.result.multiplier, 3, '倍数 = 底分 1 × 叫分 3（无炸弹无春天）');

  // 炸弹翻倍（含王炸）
  const g4 = setup({ landlord: 0, bidScore: 1, hands: [h(3, 3, 3, 3), h(4), h(5)] });
  eq(multiplierOf(g4), 1, '还没炸：倍数 = 底分 1 × 叫分 1');
  play(g4, 0, { kind: 'play', cards: h(3, 3, 3, 3) });
  eq(g4.phase, 'finished', '炸弹直接把牌出完');
  eq(g4.bombs, 1, '记了 1 个炸弹');
  ok(g4.result.multiplier >= 2, '炸弹让倍数至少翻倍');

  const g5 = setup({ landlord: 0, bidScore: 1, hands: [h(16, 17), h(4), h(5)] });
  play(g5, 0, { kind: 'play', cards: h(16, 17) });
  eq(g5.bombs, 1, '王炸也算一次翻倍');
}

// 反春天的**边界**：地主出过 1 手 → 反春天；出过 2 手 → 不是
{
  // 地主出完 3 手之后被农民抢先走完 —— 反春天要求"地主只出过一手"，这里不满足
  const g = setup({
    landlord: 0,
    bidScore: 1,
    hands: [h(3, 4, 5, 13), h(8, 9), h(10, 11)],
  });
  play(g, 0, { kind: 'play', cards: h(3) });
  play(g, 1, { kind: 'play', cards: h(8) });
  play(g, 2, { kind: 'play', cards: h(10) });
  play(g, 0, { kind: 'play', cards: h(13) });  // 地主第 2 手
  play(g, 1, { kind: 'pass' });
  play(g, 2, { kind: 'pass' });
  play(g, 0, { kind: 'play', cards: h(4) });   // 地主第 3 手
  play(g, 1, { kind: 'play', cards: h(9) });   // 农民出完
  eq(g.result.winner, 'farmers', '农民胜');
  eq(g.playedCounts[0], 3, '地主出过 3 手');
  eq(g.result.spring, 'none', '地主出过 3 手 → 不是反春天');
}

// ─────────────────────────────────────────────
// 5. view 与 unseen（§4.5）—— 隐藏信息这一层
// ─────────────────────────────────────────────

{
  const checkView = (game, seat, label) => {
    const v = viewOf(game, seat);
    ok(!('hands' in v), `${label}：view 里不能有 hands 键`);

    const played = playedOf(v);
    eq(played.length, v.history.reduce((s, x) => s + (x.combo ? x.combo.cards.length : 0), 0),
      `${label}：playedOf 与 history 一致`);

    const playedSet = new Set(played);
    const unseen = unseenOf(v);
    // 定义式：54 − |我的手牌 ∪ 已出的牌 ∪ 已公开底牌|
    //
    // 注意这里是**并集**不是加法。地主打出一张底牌之后，那张牌同时属于
    // "已出的牌"和"底牌"，加法会把同一张牌算两遍，看起来像少了/多了一张。
    // 实现期间就是被这一点卡住的 —— 见 future-work 的 B3。
    const known = new Set([...v.myHand, ...played, ...v.trump]);
    eq(unseen.length, DECK_SIZE - known.size, `${label}：unseen = 54 − |手牌 ∪ 已出 ∪ 底牌|`);
    ok(unseen.every((c) => !known.has(c)), `${label}：unseen 与"我已知的牌"不相交`);
    eq(new Set(unseen).size, unseen.length, `${label}：unseen 无重复`);

    if (game.phase === 'playing') {
      // 语义式：unseen 的张数 + 「我知道但还没被打出的底牌」 = 另外两家的手牌总张数。
      //
      // 我是地主时最后一项是 0（底牌就在我手里，已经在 myHand 里了）。
      // 我是农民时，底牌里还没被打出的那几张仍在地主手里、而且我见过，所以要补回来 ——
      // **这正是农民比地主多"知道 3 张"的地方**，也是 AI 采样分配张数时必须扣掉的量。
      const otherSum = otherSeats(v).reduce((s, p) => s + p.handCount, 0);
      const trumpLeft = v.trump.filter((c) => !playedSet.has(c)).length;
      const add = v.landlord !== null && v.landlord !== v.seat ? trumpLeft : 0;
      eq(unseen.length + add, otherSum,
        `${label}：unseen + 我知道且未打出的底牌 = 另两家手牌总数`);
    }
  };

  const bidding = createGame({ rng: rngFrom(31) });
  for (let s = 0; s < 3; s++) checkView(bidding, s, `叫分阶段座位 ${s}`);

  const playing = createGame({ rng: rngFrom(37), landlord: 0 });
  for (let s = 0; s < 3; s++) checkView(playing, s, `出牌阶段座位 ${s}`);
  // 地主与农民的 unseen 张数应当都是 34（地主：另两家 34；农民：地主 20 + 另一农民 17 − 已知底牌 3）
  eq(unseenOf(viewOf(playing, 0)).length, 34, '地主的 unseen 是 34 张');
  eq(unseenOf(viewOf(playing, 1)).length, 34, '农民的 unseen 也是 34 张');

  // 打几手之后再查一遍
  const g = createGame({ rng: rngFrom(41), landlord: 0 });
  const rng = rngFrom(43);
  for (let i = 0; i < 20 && g.phase === 'playing'; i++) {
    const last = g.trick.lastPlay ? g.trick.lastPlay.combo : null;
    const moves = legalPlays(g.hands[g.turn], last);
    const r = play(g, g.turn, moves[Math.floor(rng() * moves.length)]);
    ok(r.ok, `随机走一步应当合法：${r.reason}`);
    for (let s = 0; s < 3; s++) checkView(g, s, `第 ${i} 步后座位 ${s}`);
    if (g.phase !== 'playing') break;
  }
}

// ─────────────────────────────────────────────
// 6. 叫分评分与决策（§6.1）
// ─────────────────────────────────────────────

{
  const strong = h(16, 17, 15, 15, 14, 14, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6);
  const weak = h(3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 3, 5, 7, 9, 11, 13, 4);
  ok(handScore(strong) > handScore(weak), '强手牌的评分更高');
  ok(handScore(strong) >= 13, `双王 + 双 2 + 三组三张 应当能叫 3 分（实际 ${handScore(strong)}）`);
  ok(handScore(weak) < 6, `一手小散牌不该叫分（实际 ${handScore(weak)}）`);

  // 评分只取决于手牌，与"底牌"无关 —— 签名里根本没有别的信息
  eq(handScore(strong), handScore(sortHand(strong.slice())), 'handScore 是纯函数');

  eq(bidForScore(0), 0, '0 分不叫');
  eq(bidForScore(20), 3, '高分叫 3 分');
  ok(bidForScore(6.5) >= 1, '刚到阈值就叫 1 分');

  // 决策必须永远合法：要么 0，要么 > currentBest
  const levels = [findLevel('novice'), findLevel('easy'), findLevel('medium'), findLevel('hard')];
  const rng = rngFrom(53);
  let sawPass = false;
  let sawBid = false;
  for (let i = 0; i < 2000; i++) {
    const hand = sortHand(fullDeck().slice(i % 30, (i % 30) + 17).map((c) => c));
    const level = levels[i % levels.length];
    const currentBest = i % 4; // 0..3
    const want = decideBid(hand, level, rng, currentBest);
    ok(isLegalBid(want, currentBest).ok, `decideBid 必须合法（want=${want}, best=${currentBest}）`);
    if (want === 0) sawPass = true; else sawBid = true;
  }
  ok(sawPass && sawBid, '随机样本里两种决定都出现过（噪声没有把结果压成一边）');

  // 高级挡位没有噪声 → 决定是确定的
  const hard = findLevel('hard');
  const a = decideBid(strong, hard, rngFrom(1), 0);
  const b = decideBid(strong, hard, rngFrom(2), 0);
  eq(a, b, '高级挡位没有噪声，同一个手牌给同一个决定');
  eq(a, 3, '这手牌在高级挡位下叫 3 分');

  // 噪声是双向的：同一个手牌在入门挡位下应当出现"叫得更高"和"叫得更低"两种结果
  const novice = findLevel('novice');
  const wants = new Set();
  const mid = h(14, 13, 12, 3, 4, 5, 6, 7, 8, 9, 10, 3, 4, 5, 6, 7, 8); // 评分中等
  for (let i = 0; i < 500; i++) wants.add(decideBid(mid, novice, rngFrom(i + 100), 0));
  ok(wants.size >= 3, `入门挡位的叫分噪声应当是双向的（实际出现 ${[...wants].join('/')}）`);

  eq(legalBids(0).join(','), '0,1,2,3', '没人叫时可以点 0~3');
  eq(legalBids(2).join(','), '0,3', '最高 2 分时只能点"不叫"或 3 分');
  eq(legalBids(3).join(','), '0', '已经被叫到 3 分 → 只能不叫');

  const shape = handShape(strong);
  eq(shape.jokers, 2, 'handShape 数得出双王');
  eq(shape.triples, 3, 'handShape 数得出三组三张');
}

// ─────────────────────────────────────────────
// 7. 随机走完一局：守恒不变量 + 一定能结束（§11.5 的精简版）
// ─────────────────────────────────────────────

{
  const rng = rngFrom(20260915);
  let finished = 0;
  let landlordWins = 0;
  let redeals = 0;
  let maxSteps = 0;

  for (let game_i = 0; game_i < 200; game_i++) {
    const game = createGame({ rng });
    let steps = 0;
    let guard = 0;

    // 叫分：随机挑一个合法选项
    while (game.phase === 'bidding') {
      const seat = biddingSeat(game);
      const options = legalBids(currentBestScore(game));
      const pick = options[Math.floor(rng() * options.length)];
      const r = bid(game, seat, pick, rng);
      if (!r.ok) { failures.push(`叫分被拒：${r.reason}`); break; }
      if (r.redeal) redeals++;
      if (++guard > 50) { failures.push('叫分不死循环'); break; }
    }
    if (game.phase !== 'playing') continue;

    // 出牌：随机挑一手合法的
    while (game.phase === 'playing') {
      const seat = game.turn;
      const last = game.trick.lastPlay ? game.trick.lastPlay.combo : null;
      const moves = legalPlays(game.hands[seat], last);
      ok(moves.length > 0, '任何局面都至少有一个着法可选');
      const move = moves[Math.floor(rng() * moves.length)];

      const r = play(game, seat, move);
      if (!r.ok) { failures.push(`随机着法被拒：${r.reason}\n    ${JSON.stringify(move)}`); break; }
      steps++;

      // —— 守恒不变量 ——
      const played = game.history.reduce((s, x) => s + (x.combo ? x.combo.cards.length : 0), 0);
      const inHands = game.hands[0].length + game.hands[1].length + game.hands[2].length;
      eq(inHands + played, DECK_SIZE, `第 ${steps} 步：手牌 + 已出牌 = 54 张`);

      const all = [...game.hands[0], ...game.hands[1], ...game.hands[2]];
      for (const x of game.history) if (x.combo) all.push(...x.combo.cards);
      eq(new Set(all).size, DECK_SIZE, `第 ${steps} 步：54 张不重复`);

      if (game.phase === 'playing') {
        // 出完牌之后才轮转，所以能走到这里说明手牌还没空
        ok(game.hands[seat].length > 0, '手牌没空就不该结束');
        // 不能自己压自己
        if (game.trick.lastPlay) {
          ok(game.trick.lastPlay.seat !== game.turn, '不能压自己（lastPlay 的人不等于轮到的下家）');
        }
        ok(game.trick.passes < 2, 'passes 不会攒到 2 还不结束这一墩');
      }

      if (steps > 400) { failures.push('一局最多几百步就该结束'); break; }
    }

    if (game.phase === 'finished') {
      finished++;
      if (game.result.winner === 'landlord') landlordWins++;
      ok(game.result.multiplier >= 1, '结算倍数至少是 1');
      ok(game.hands.some((x) => x.length === 0), '终局时必定有一家手牌为空');
    }
    if (steps > maxSteps) maxSteps = steps;
  }

  eq(finished, 200, '200 局随机对局应当全部正常结束（不卡死）');
  ok(landlordWins > 0 && landlordWins < 200, `两侧都赢过（地主 ${landlordWins} / 农民 ${200 - landlordWins}）`);
  console.log(`  200 局随机对局：地主胜 ${landlordWins}，流局 ${redeals} 次，单局最多 ${maxSteps} 步`);
  console.log(`  （随机叫分的流局率 ${(redeals / 200 * 100).toFixed(1)}% 只是量级观察，`
    + '真正的验收线 < 5% 要等第 4 步用 AI 跑 selfplay 才有意义 —— §5.5）');
}

// === 收尾 ===
console.log(`test-game: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures.slice(0, 20)) console.log('  ✗ ' + f);
  if (failures.length > 20) console.log(`  …还有 ${failures.length - 20} 条`);
  process.exit(1);
}
