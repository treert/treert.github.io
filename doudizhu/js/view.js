/**
 * 玩家视角：**隐藏信息的唯一闸门**（design.md §3.1、§4.5）。
 *
 * `game.js` 里当然有`hands`（三家的手牌都全）—— 它得知道，否则发牌、判终局都做不了。
 * 但 AI 只能拿到 `viewOf(game, seat)` 的产物，那里面**只有这个座位合法知道的信息**：
 *
 *   有：我自己的手牌（牌面）、所有人的剩余张数、已公开的底牌、按时间顺序的公开出牌、
 *       叫分历史、我的角色、轮到谁、当前这一墩、炸弹数
 *   没有：其他两家的手牌，以及任何能反推出手牌的表示
 *
 * 这条约束由三件事保证（§7.7）：接口只收 view、Worker 里只传 view、
 * 以及一条**可执行的测试** ——「同一个 view 配两个只有隐藏信息不同的真相，
 * AI 必须给出完全相同的着法」（§11.4a）。
 *
 * **采样（determinization）不是作弊。** `unseenOf` 返回的是"还没出现过的牌"，
 * 它是纯公开信息的推导 —— 任何只看到牌面的观众都能算出来。
 * 判据：**能从"只看公开牌面的观众视角"推出来的信息，就不算泄漏。**
 * 同一个函数也顺手做了记牌器的数据源（§9.5），一处逻辑两处用。
 *
 * 返回的是**纯 JSON 可序列化的普通对象**（数字 / 字符串 / 数组 / 普通对象）。
 * 这不是巧合：它是能丢进 Worker 的前提，也让"同 view 不同真相"那条测试容易写。
 */

import { fullDeck } from './cards.js';

export function viewOf(game, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= game.hands.length) {
    throw new RangeError(`座位越界：${seat}`);
  }
  const revealed = game.landlord !== null;

  return {
    seat,
    phase: game.phase,
    // 定地主之前谁都还不是地主/农民，所以是 null（界面据此显示"待定"）
    role: revealed ? (game.landlord === seat ? 'landlord' : 'farmer') : null,
    players: game.hands.map((hand, i) => ({
      seat: i,
      role: revealed ? (game.landlord === i ? 'landlord' : 'farmer') : null,
      // **只有张数，没有牌面** —— 这是公共信息
      handCount: hand.length,
      playedCount: game.playedCounts[i],
    })),
    /** 只有我自己的手牌是牌面 */
    myHand: game.hands[seat].slice(),
    turn: game.turn,
    landlord: game.landlord,
    /**
     * 底牌：定地主前是 `[]`（叫分阶段谁都看不到），定地主后是 3 张公开的牌。
     *
     * 注意**地主自己也拿到这 3 张**，此时它们同时出现在 `myHand` 里 ——
     * 这是有意的重复（一个表达"公开信息"、一个表达"我的手牌"），
     * `unseenOf` 用的是集合减法，重复不会算错。
     */
    trump: revealed ? game.trump.slice() : [],
    bidding: {
      order: game.bidding.order.slice(),
      index: game.bidding.index,
      calls: game.bidding.calls.slice(),
      best: game.bidding.best ? { ...game.bidding.best } : null,
    },
    trick: {
      leader: game.trick.leader,
      lastPlay: game.trick.lastPlay
        ? { seat: game.trick.lastPlay.seat, combo: game.trick.lastPlay.combo }
        : null,
      passes: game.trick.passes,
    },
    /** 全部公开出牌记录；combo 为 null 表示"不要" */
    history: game.history.map((h) => ({ seat: h.seat, combo: h.combo })),
    bombs: game.bombs,
    bidScore: game.bidScore,
  };
}

/**
 * **还没出现过的牌** = 全部 54 张 − 我的手牌 − 已经打出的牌 − 已公开的底牌。
 *
 * 这是记牌器的数据源，也是 AI 采样（determinization）的输入。
 * 它**只依赖 view**，所以在信息论意义上不可能包含别的座位的手牌。
 *
 * 地主的情形：底牌在他手里，已经在 `myHand` 里被减掉过一次，
 * 所以这里再减一次是空操作（集合减法）。
 */
export function unseenOf(view) {
  const known = new Set(view.myHand);
  for (const h of view.history) {
    if (!h.combo) continue;
    for (const c of h.combo.cards) known.add(c);
  }
  for (const c of view.trump) known.add(c);
  return fullDeck().filter((c) => !known.has(c));
}

/** 一把牌里已经打出去了哪些（记牌器要"已出现"，`unseenOf` 要"没出现"，两者互补） */
export function playedOf(view) {
  const out = [];
  for (const h of view.history) {
    if (!h.combo) continue;
    for (const c of h.combo.cards) out.push(c);
  }
  return out;
}

/**
 * 我这一手能不能"不要"。
 *
 * 条件：场上有人出过牌，且那人不是我自己 —— **首出方不能压自己**。
 * 界面用它决定「不要」按钮是否可点，`game.canSeatPass` 是状态机那边的同一判断
 * （两处都要有：一个是禁用按钮，一个是拒绝非法着法；但它们必须口径一致）。
 */
export function canPass(view) {
  return !!view.trick.lastPlay && view.trick.lastPlay.seat !== view.seat;
}

/** 其他两个座位（AI 采样要按它们的剩余张数分配未见过的牌） */
export function otherSeats(view) {
  const out = [];
  for (const p of view.players) if (p.seat !== view.seat) out.push(p);
  return out;
}
