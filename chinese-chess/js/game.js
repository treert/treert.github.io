/**
 * 对局状态机。纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * 设计要点（design.md §9）：
 *
 *   1. 局面只有一个来源 —— FEN 字符串。需要棋盘时现从它 parseFen，
 *      内存里不额外维护一份 Int8Array。否则悔棋、复盘跳转、走子会各走各的路径，
 *      迟早出现「状态不同步」这类极难查的 bug。
 *
 *   2. 悔棋和复盘跳转都只移动 cursor，绝不删除 moves —— 这样重做是免费的。
 *      只有在「回看状态下走新着法」时才截断后面的分支。
 *
 *   3. 每步存一份 FEN 快照（约 60 字符），换来复盘跳转 O(1)。
 *      200 步也就 12KB，比每次重放划算得多，而且同一份数据同时供
 *      悔棋、跳转、着法列表、导出使用。
 */

import { START_FEN, RED } from './config.js';
import { parseFen, toFen, positionSignature } from './position.js';
import { generateLegalMoves, gameStatus, isThreefoldRepetition, moveFrom, moveTo } from './rules.js';
import { toNotation } from './notation.js';

export function createGame(options = {}) {
  return {
    initialFen: options.initialFen || START_FEN,
    moves: [],
    cursor: 0,
    mode: options.mode || 'play',           // play | endgame
    playerSide: options.playerSide || RED,
    level: options.level || 'medium',
    endgameId: options.endgameId || null,
  };
}

/** 当前局面：cursor 为 0 就是起始局面，否则取上一步的 FEN 快照 */
export function currentFen(game) {
  return game.cursor === 0 ? game.initialFen : game.moves[game.cursor - 1].fenAfter;
}

export function currentPosition(game) {
  return parseFen(currentFen(game));
}

export function sideToMove(game) {
  return currentPosition(game).side;
}

export function legalMoves(game) {
  return generateLegalMoves(currentPosition(game));
}

/** 上一步棋的编码；没有则返回 0（用于高亮） */
export function lastMove(game) {
  return game.cursor === 0 ? 0 : game.moves[game.cursor - 1].move;
}

/** 当前是否处在「回看」状态（后面还有已经走过的着法） */
export function isReviewing(game) {
  return game.cursor < game.moves.length;
}

/** 从起始局面到 cursor 为止的所有局面签名，供三次重复判定 */
function signatures(game) {
  const out = [positionSignature(game.initialFen)];
  for (let i = 0; i < game.cursor; i++) out.push(positionSignature(game.moves[i].fenAfter));
  return out;
}

/**
 * 终局判定。除了将死 / 困毙，还要看三次重复 —— 设计文档 §5.3 明确不做
 * 中国象棋的循环规则（长将 / 长捉判负），这一条是唯一的循环兜底。
 *
 * 三次重复只看**当前这条线**（起始局面 + moves[0..cursor)），不看被截断的分支。
 */
export function evaluateStatus(game) {
  const st = gameStatus(currentPosition(game));
  if (st.type !== 'playing') return { type: st.type, winner: st.winner };
  if (isThreefoldRepetition(signatures(game))) return { type: 'repetition', winner: null };
  return { type: 'playing', winner: null };
}

export function playMove(game, move) {
  if (evaluateStatus(game).type !== 'playing') {
    return { ok: false, reason: '对局已经结束' };
  }
  if (!legalMoves(game).includes(move)) {
    return { ok: false, reason: '这个着法不合法' };
  }

  const pos = currentPosition(game);
  const from = moveFrom(move), to = moveTo(move);
  const captured = pos.cells[to];
  const notation = toNotation(pos, move); // 必须在改棋盘之前算

  // 在回看状态下走新着法：截断后面的分支，重做链作废
  if (game.cursor < game.moves.length) game.moves.length = game.cursor;

  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;

  game.moves.push({ move, notation, captured, fenAfter: toFen(pos) });
  game.cursor++;
  return { ok: true };
}

export function canUndo(game) {
  return game.cursor > 0;
}

/**
 * 悔棋。默认退一步，传 steps 可以多退。
 *
 * **不删除 moves**，只移动 cursor —— 所以「悔棋之后想反悔」直接 gotoPly 回去就行。
 */
export function undo(game, steps = 1) {
  if (!canUndo(game)) return false;
  game.cursor = Math.max(0, game.cursor - steps);
  return true;
}

/**
 * 悔到「轮到玩家走」为止。
 *
 * 人机对弈时用这个：玩家悔一步棋，如果只退一步就轮到 AI 了，
 * 玩家会看到 AI 立刻又走一步，体验上等于「悔棋没生效」。
 */
export function undoToPlayer(game) {
  if (!canUndo(game)) return false;
  game.cursor--;
  while (game.cursor > 0 && sideToMove(game) !== game.playerSide) game.cursor--;
  return true;
}

/** 复盘跳转到第 n 步（0 = 起始局面） */
export function gotoPly(game, n) {
  if (!Number.isInteger(n) || n < 0 || n > game.moves.length) return false;
  game.cursor = n;
  return true;
}

export function reset(game) {
  game.moves.length = 0;
  game.cursor = 0;
}

/** 当前这条线上的着法（回看时只到 cursor 为止） */
export function moveList(game) {
  return game.moves.slice(0, game.cursor);
}
