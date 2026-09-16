/**
 * 对局状态机：发牌 / 叫分 / 出牌轮转 / 终局 / 计分。
 *
 * **纯逻辑，不碰 DOM、不碰 localStorage。** 界面层只负责把它画出来、
 * 把点击翻译成这里的调用，自己不持有任何牌类规则（与象棋的 `game.js` 同一分工）。
 *
 * 设计要点（design.md §4.4、§5.4~§5.6、§8）：
 *
 *   1. **AI 拿不到这个对象。** `hands` 是引擎真相，只经 `view.js` 的 `viewOf`
 *      过滤成"这个座位合法知道的信息"再给 AI（§3.1）。这一条是整个模块的地基。
 *
 *   2. **所有变更函数返回 `{ ok, reason }`，不抛异常。** 界面要能把原因显示给用户
 *      （"压不过上一手"、"这是首出，必须出牌"）—— 说"不行"而不说为什么等于没说。
 *      唯一的例外是 `bid()` 在三家都不叫时没拿到 rng：那是**编程错误**不是用户错误，
 *      所以直接抛。
 *
 *   3. **`rng` 不入状态。** 状态机要能 JSON 序列化（存档 §10），所以随机源是参数。
 *      `createGame` / `newDeal` / `bid`（可能要重发）都显式接收它。
 *
 *   4. **不存派生量**（§3.6）：倍数由 `multiplierOf()` 现算，
 *      "轮到谁"在叫分阶段读 `biddingSeat()`、出牌阶段读 `turn`。
 */

import { SEATS, BID_NONE, BID_MAX, BASE_SCORE } from './config.js';
import { deal, sortHand, removeCards, isSubset } from './cards.js';
import { identifyAll, resolveCombo, TYPES } from './combo.js';
import { isPass } from './moves.js';
import { isLegalBid } from './bid.js';

export function nextSeat(seat) {
  return (seat + 1) % SEATS;
}

export function createGame(options = {}) {
  const game = {
    phase: 'bidding',        // bidding | playing | finished
    /** 三家手牌 —— **引擎真相，绝不外传** */
    hands: [[], [], []],
    /** 底牌 3 张。叫分阶段 viewOf 会把它藏起来（返回 []），定地主后才是公开信息 */
    trump: [],
    landlord: null,
    bidScore: 0,             // 叫到几分（就是底分倍数）
    bidding: { order: [], index: 0, calls: [null, null, null], best: null, redeals: 0 },
    /** 出牌阶段才有效；叫分阶段是 null，用 biddingSeat() 读 */
    turn: null,
    trick: { leader: 0, lastPlay: null, passes: 0 },
    /** 全部公开出牌记录，按时间顺序；combo 为 null 表示"不要" */
    history: [],
    /** 每家出过几手（判春天用） */
    playedCounts: [0, 0, 0],
    bombs: 0,
    result: null,
  };

  const { landlord, rng } = options;
  dealInto(game, rng);

  if (landlord === undefined || landlord === null) {
    startBidding(game, rng);
  } else {
    // 测试入口：跳过叫分，直接指定地主与底分（§5.5）。
    // 只给 Node 测试与调 AI 用，**不进界面** —— 不进界面就没有作弊问题。
    if (!Number.isInteger(landlord) || landlord < 0 || landlord >= SEATS) {
      throw new RangeError(`landlord 必须是 0..${SEATS - 1}`);
    }
    assignLandlord(game, landlord, options.bidScore || BID_MAX);
  }
  return game;
}

/** 重新发牌并回到叫分阶段。保留累计的"重发次数" */
export function newDeal(game, rng) {
  const redeals = game.bidding ? game.bidding.redeals : 0;
  const best = { redeals };
  game.phase = 'bidding';
  game.trump = [];
  game.landlord = null;
  game.bidScore = 0;
  game.turn = null;
  game.trick = { leader: 0, lastPlay: null, passes: 0 };
  game.history = [];
  game.playedCounts = [0, 0, 0];
  game.bombs = 0;
  game.result = null;
  dealInto(game, rng);
  startBidding(game, rng);
  game.bidding.redeals = best.redeals;
  return game;
}

function dealInto(game, rng) {
  if (typeof rng !== 'function') {
    throw new TypeError('发牌需要 rng —— 它是参数不是状态（状态要能 JSON 序列化）');
  }
  const { hands, trump } = deal(rng);
  game.hands = hands;
  game.trump = trump;
}

/**
 * 叫分顺序：**每局随机选起始座位**，再按座位号轮。
 *
 * 不能固定顺序：先叫的人在"叫 3 分"上有结构性优势（后面的人没机会了），
 * 固定顺序等于让某个座位系统性占便宜（§5.5）。
 */
function startBidding(game, rng) {
  if (typeof rng !== 'function') {
    throw new TypeError('叫分顺序要从随机起始座位开始，需要 rng');
  }
  const start = Math.floor(rng() * SEATS) % SEATS;
  const order = [];
  for (let i = 0; i < SEATS; i++) order.push((start + i) % SEATS);
  game.bidding = { order, index: 0, calls: [null, null, null], best: null, redeals: 0 };
}

// === 叫分 ===

/** 叫分阶段轮到谁（phase 不是 bidding 时返回 null） */
export function biddingSeat(game) {
  if (game.phase !== 'bidding') return null;
  return game.bidding.order[game.bidding.index] ?? null;
}

/** 场上当前最高分 */
export function currentBestScore(game) {
  return game.bidding.best ? game.bidding.best.score : BID_NONE;
}

/**
 * 叫分。返回 `{ ok, reason, redeal? }`。
 *
 * `redeal: true` 表示三家都不叫、已经重新发牌了（此时叫分从头开始）。
 *
 * @param rng 只有"三家都不叫"这一条路径需要它。**故意不给默认值** ——
 *            默认成 Math.random 会让"看起来可复现"的测试悄悄不可复现。
 */
export function bid(game, seat, score, rng) {
  if (game.phase !== 'bidding') return { ok: false, reason: '现在不是叫分阶段' };

  const want = biddingSeat(game);
  if (seat !== want) return { ok: false, reason: '还没轮到你叫分' };

  const legal = isLegalBid(score, currentBestScore(game));
  if (!legal.ok) return { ok: false, reason: legal.reason };

  game.bidding.calls[seat] = score;
  if (score > BID_NONE && (!game.bidding.best || score > game.bidding.best.score)) {
    game.bidding.best = { seat, score };
  }

  // 叫到 3 分立即结束 —— 后面的人不再表态
  if (score >= BID_MAX) return finishBidding(game, rng);

  game.bidding.index++;
  if (game.bidding.index >= SEATS) return finishBidding(game, rng);
  return { ok: true, reason: '' };
}

function finishBidding(game, rng) {
  const best = game.bidding.best;
  if (!best) {
    // 三家都不叫 → 流局，重新洗牌发牌
    if (typeof rng !== 'function') {
      throw new TypeError('三家都不叫需要重新发牌，调用 bid() 时必须传 rng');
    }
    const redeals = game.bidding.redeals + 1;
    newDeal(game, rng);
    game.bidding.redeals = redeals;
    return { ok: true, redeal: true, reason: '三家都不叫，重新发牌' };
  }
  assignLandlord(game, best.seat, best.score);
  return { ok: true, reason: '' };
}

/** 定地主：底牌归他（手牌变 20 张），他是首出。底牌从此是公开信息 */
function assignLandlord(game, seat, score) {
  game.landlord = seat;
  game.bidScore = score;
  game.hands[seat] = sortHand([...game.hands[seat], ...game.trump]);
  game.phase = 'playing';
  game.turn = seat;
  game.trick = { leader: seat, lastPlay: null, passes: 0 };
}

// === 出牌 ===

export function roleOf(game, seat) {
  return game.landlord === seat ? 'landlord' : 'farmer';
}

/** 这一手能不能"不要"：必须场上有人出过牌，且那人不是自己（首出方不能压自己） */
export function canSeatPass(game, seat) {
  const last = game.trick.lastPlay;
  return !!last && last.seat !== seat;
}

/**
 * 出一手牌或不要。返回 `{ ok, reason }`。
 *
 * **AI 的输出不被信任**：这里会重新校验"牌在不在手里""成不成牌型""压不压得过"，
 * 与象棋 `playMove` 会重新校验合法性是同一个态度。
 */
export function play(game, seat, move) {
  if (game.phase !== 'playing') return { ok: false, reason: '对局已经结束' };
  if (seat !== game.turn) return { ok: false, reason: '还没轮到你出牌' };

  const last = game.trick.lastPlay ? game.trick.lastPlay.combo : null;

  if (isPass(move)) {
    if (!canSeatPass(game, seat)) return { ok: false, reason: '这是首出，必须出牌' };
    game.history.push({ seat, combo: null });
    game.trick.passes++;
    if (game.trick.passes >= SEATS - 1) {
      // 一墩结束：首出方重新首出（他不能压自己，所以 lastPlay 必须清空）
      game.trick.leader = game.trick.lastPlay.seat;
      game.trick.lastPlay = null;
      game.trick.passes = 0;
      game.turn = game.trick.leader;
    } else {
      game.turn = nextSeat(game.turn);
    }
    return { ok: true, reason: '' };
  }

  const cards = move && Array.isArray(move.cards) ? sortHand(move.cards) : null;
  if (!cards || cards.length === 0) return { ok: false, reason: '没有选择要出的牌' };
  if (new Set(cards).size !== cards.length) return { ok: false, reason: '选择的牌有重复' };
  if (!isSubset(game.hands[seat], cards)) return { ok: false, reason: '这些牌不在你手里' };
  if (identifyAll(cards).length === 0) return { ok: false, reason: '这些牌不成牌型' };

  // 落定成**唯一一个** combo：下一家按它来压。
  // 跟牌时必须取"压得过的那个解释"，不能一律取 identify() —— 那会记下一个
  // 压不过场面的牌型，下一家面对的就是一个自相矛盾的 lastPlay（§5.3 末尾）。
  const combo = resolveCombo(cards, last);
  if (!combo) return { ok: false, reason: '压不过上一手' };

  game.hands[seat] = removeCards(game.hands[seat], cards);
  game.trick.lastPlay = { seat, combo };
  game.trick.passes = 0;
  game.history.push({ seat, combo });
  game.playedCounts[seat]++;
  if (combo.type === TYPES.BOMB || combo.type === TYPES.ROCKET) game.bombs++;

  if (game.hands[seat].length === 0) {
    finish(game, seat === game.landlord ? 'landlord' : 'farmers');
    return { ok: true, reason: '' };
  }

  game.turn = nextSeat(game.turn);
  return { ok: true, reason: '' };
}

// === 终局与计分 ===

/**
 * 倍数 = 底分 × 叫分 × 2^炸弹数。**现算不存**（§3.6）—— 只有结算时才需要
 * 把它连春天倍数一起冻进 `result`。
 */
export function multiplierOf(game) {
  return BASE_SCORE * (game.bidScore || 1) * Math.pow(2, game.bombs);
}

function finish(game, winner) {
  game.phase = 'finished';
  const f = game.landlord;

  let spring = 'none';
  if (winner === 'landlord' && game.playedCounts.every((n, i) => i === f || n === 0)) {
    spring = 'spring';      // 农民一手都没出过
  } else if (winner === 'farmers' && game.playedCounts[f] <= 1) {
    spring = 'anti';        // 地主只出过一手
  }

  const multiplier = multiplierOf(game) * (spring === 'none' ? 1 : 2);
  game.result = {
    winner, spring, bid: game.bidScore, bombs: game.bombs, multiplier, score: multiplier,
  };
}

/** 对局是否还能继续（界面用） */
export function isOver(game) {
  return game.phase === 'finished';
}
