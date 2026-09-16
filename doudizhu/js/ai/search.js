/**
 * 完全信息搜索（design.md §7.3）。
 *
 * **它只在一个"可能的世界"里搜**（`sample.js` 造的），输出还要跨世界投票 ——
 * 所以它是一个前置环节，不是独立可用的策略。
 *
 * 值函数按**队伍**看：地主走完 = `+1`，任一农民走完 = `-1`。
 * 于是地主节点取 max、农民节点取 min，就是一棵标准的两方零和树，
 * **alpha-beta 在这里是成立的**（§3.4 里那条修正）。
 *
 * 两个农民**各有自己的手牌**，不能合并成一个"农民方"出牌 ——
 * 它们只是共享同一个效用。
 *
 * 三条工程上的取舍，都是被实测数据逼出来的：
 *
 *   1. **每个节点只展开 `width` 个着法**（按"能多出牌 + 先用小牌"排序，外加永远留着 `pass`）。
 *      首出时一手可能有 350+ 个候选，全展开在深度 2 上就是几万次着法生成。
 *   2. **`make` / `unmake` 就地改状态**，不每层 `slice()` 三份手牌 ——
 *      搜索树里每层复制 3 个数组是纯浪费。
 *   3. **预算用尽就停止加深**（`deadline` 在节点入口检查），而不是抛异常中断。
 *      抛异常会从 `make` 和 `unmake` 中间穿过去，把状态留在"走了一半"的样子 ——
 *      象棋的引擎在那个坑里摔过一次（见 chinese-chess 的 design.md §7.1）。
 *      这里改成"提前当叶子"，既安全，也只是精度下降而不是出错。
 */

import { rankOf, removeCards, sortHand } from '../cards.js';
import { resolveCombo } from '../combo.js';
import { legalPlays, isPass } from '../moves.js';
import { handValue } from '../evaluate.js';

export const PASS_MOVE = Object.freeze({ kind: 'pass' });

/**
 * 从"采样出来的世界 + 公开信息"造一个搜索状态。
 *
 * 注意它只需要 view 里那几样公开的东西（轮次、这一墩的首出方与最后一手、过了几家），
 * 加上一个猜出来的 `hands`。
 */
export function createState(world, view) {
  const last = view.trick.lastPlay;
  return {
    hands: world.hands.map((h) => h.slice()),
    turn: view.turn,
    landlord: view.landlord,
    leader: view.trick.leader,
    lastCombo: last ? last.combo : null,
    lastPlaySeat: last ? last.seat : null,
    passes: view.trick.passes,
  };
}

/**
 * 叶子估值，返回**地主视角**的分值（+ 对地主有利）。
 *
 * 用到的只有一件事：**手数**。地主的"还要几手"越小越接近赢；
 * 农民那边只要有一家先走完就算赢，所以取两个农民里最小的那个。
 */
export function evaluateState(state) {
  const L = handValue(state.hands[state.landlord]);
  let F = Infinity;
  for (let s = 0; s < state.hands.length; s++) {
    if (s === state.landlord) continue;
    const v = handValue(state.hands[s]);
    if (v < F) F = v;
  }
  const d = (F - L) / 40;
  return d > 1 ? 1 : (d < -1 ? -1 : d);
}

/**
 * 排序 + 截断。
 *
 * 排序键：**能一次走完的绝对优先**，然后多出牌的优先，同张数先用小牌。
 * 这条排序只影响"剪枝看得见哪几个着法"，不影响正确性 ——
 * 代价写在 §7.3 的取舍里：它是近似，不是完整搜索。
 */
function orderMoves(state, seat, moves, width) {
  const handLen = state.hands[seat].length;
  const scored = [];
  let hasPass = false;

  for (const m of moves) {
    if (isPass(m)) { hasPass = true; continue; }
    const n = m.cards.length;
    let maxR = 0;
    for (const c of m.cards) { const r = rankOf(c); if (r > maxR) maxR = r; }
    const win = n === handLen ? -1e6 : 0;
    scored.push({ m, k: win + (100 - n * 4) + maxR * 0.1 });
  }
  scored.sort((a, b) => a.k - b.k);

  const out = [];
  for (const x of scored) {
    if (out.length >= width) break;
    out.push(x.m);
  }
  // `pass` 永远留着：它常常是农民配合队友时唯一正确的选择，
  // 而按上面的键它一定排不进前 width 个
  if (hasPass) out.push(PASS_MOVE);
  return out;
}

/** 就地走一步，返回还原所需的信息 */
function make(state, seat, move, combo) {
  const undo = {
    oldHand: state.hands[seat],
    lastCombo: state.lastCombo,
    lastPlaySeat: state.lastPlaySeat,
    leader: state.leader,
    passes: state.passes,
    turn: state.turn,
    winner: null,
  };

  if (isPass(move)) {
    state.passes++;
    if (state.passes >= 2) {
      // 一墩结束：首出方重新首出
      state.leader = state.lastPlaySeat;
      state.lastCombo = null;
      state.lastPlaySeat = null;
      state.passes = 0;
      state.turn = state.leader;
    } else {
      state.turn = (state.turn + 1) % state.hands.length;
    }
    return undo;
  }

  state.hands[seat] = removeCards(state.hands[seat], move.cards);
  state.lastCombo = combo;
  state.lastPlaySeat = seat;
  state.passes = 0;
  if (state.hands[seat].length === 0) {
    undo.winner = seat === state.landlord ? 'landlord' : 'farmers';
    return undo;
  }
  state.turn = (state.turn + 1) % state.hands.length;
  return undo;
}

function unmake(state, seat, move, undo) {
  state.hands[seat] = undo.oldHand;
  state.lastCombo = undo.lastCombo;
  state.lastPlaySeat = undo.lastPlaySeat;
  state.leader = undo.leader;
  state.passes = undo.passes;
  state.turn = undo.turn;
}

/**
 * "走掉这一手之后的局面值"。**根节点与内部节点共用这一个入口** ——
 * `make` / `search` / `unmake` 这三步必须永远成对，拆开写迟早漏掉一次还原。
 *
 * @returns 地主视角的分值，落在 `[-1, 1]`
 */
export function valueAfterMove(state, seat, move, combo, depth, ctx,
  alpha = -Infinity, beta = Infinity) {
  const undo = make(state, seat, move, combo);
  let v;
  if (undo.winner) {
    v = undo.winner === 'landlord' ? 1 : -1;
  } else if (depth > 0) {
    v = search(state, depth, alpha, beta, ctx);
  } else {
    v = evaluateState(state);
  }
  unmake(state, seat, move, undo);
  return v;
}

/**
 * 搜 `depth` 层（**不含**发起搜索的那一手 —— 那一手由调用方在根节点上枚举）。
 *
 * @param ctx `{ deadline, width, stats }`；`deadline` 是时间戳（毫秒）
 * @returns 地主视角的分值，落在 `[-1, 1]`
 */
export function search(state, depth, alpha, beta, ctx) {
  ctx.stats.nodes++;
  if (depth <= 0 || Date.now() >= ctx.deadline) return evaluateState(state);

  const seat = state.turn;
  const moves = legalPlays(state.hands[seat], state.lastCombo);
  if (moves.length === 0) return evaluateState(state);

  const ordered = orderMoves(state, seat, moves, ctx.width);
  const isMax = seat === state.landlord;
  let best = isMax ? -Infinity : Infinity;

  for (const move of ordered) {
    const combo = isPass(move) ? null : resolveCombo(move.cards, state.lastCombo);
    if (!isPass(move) && !combo) continue;

    const v = valueAfterMove(state, seat, move, combo, depth - 1, ctx, alpha, beta);
    if (isMax) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * 「一手走完」的短路检查。**有就直接走，不进搜索、也不采样。**
 *
 * 它比搜索便宜得多，而且它对**所有挡位都生效** —— 缺这一手的 AI 看起来像坏了，
 * 不是像新手（象棋那边"探测到杀棋时不做挡位弱化"是同一条道理）。
 */
export function finishNow(hand, lastCombo) {
  if (lastCombo) {
    const c = resolveCombo(hand, lastCombo);
    return c ? hand.slice() : null;
  }
  return legalPlays(hand, null).some((m) => !isPass(m) && m.cards.length === hand.length)
    ? hand.slice()
    : null;
}

/** 搜索用的新统计器。`nodes` 只用于诊断与 selfplay 报告，不参与决策 */
export function newStats() {
  return { nodes: 0 };
}

/** 内部工具：把一个手牌数组整理成升序（供调用方在调试时用） */
export function normalizeHand(hand) {
  return sortHand(hand);
}
