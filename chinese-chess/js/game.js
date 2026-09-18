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
import {
  generateLegalMoves, gameStatus, isThreefoldRepetition, classifyRepetition,
  inCheck, moveFrom, moveTo,
} from './rules.js';
import { toNotation } from './notation.js';
import { findEndgame } from './endgames.js';

export function createGame(options = {}) {
  return {
    initialFen: options.initialFen || START_FEN,
    moves: [],
    cursor: 0,
    mode: options.mode || 'play',           // play | endgame
    playerSide: options.playerSide || RED,
    level: options.level || 'medium',
    endgameId: options.endgameId || null,
    // 双人对弈：两边都由人来点，不派发 AI 搜索。
    // 开着的时候 playerSide 只在「初始是否翻转棋盘」上还有意义，
    // 所以界面会把「执子」禁掉（见 main.js 的 updateButtons）。
    twoPlayer: options.twoPlayer || false,
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
 * 每一步的「走子方 + 有没有将军」。
 *
 * **不额外存字段**，用的时候从走完之后的 FEN 现算：走完之后轮到对方，
 * 对方被将军就是这一步将军了。同一份 FEN 既是棋盘也是这些事实的唯一来源，
 * 存档里也不用为它升版本号（老存档里的 fenAfter 一样算得出来）。
 */
function moveFacts(game) {
  const sides = [];
  const checks = [];
  for (let i = 0; i < game.cursor; i++) {
    const after = parseFen(game.moves[i].fenAfter);
    sides.push(-after.side);
    checks.push(inCheck(after.cells, after.side));
  }
  return { sides, checks };
}

/**
 * 终局判定：将死 / 困毙，以及走成循环时的三种结果。
 *
 * 循环规则只做**长将**（连续将军的一方判负），长捉 / 长兑 / 一将一杀不做 ——
 * 裁剪的理由写在 rules.js 的 perpetualChecker() 里。三次重复仍然是兜底，
 * 只是现在要分两种情况：
 *   循环里有人长将 → 长将方判负（perpetual-check，winner 是对方）
 *   没有             → 判和（repetition，winner 为 null）
 *
 * 三次重复只看**当前这条线**（起始局面 + moves[0..cursor)），不看被截断的分支。
 */
export function evaluateStatus(game) {
  const st = gameStatus(currentPosition(game));
  if (st.type !== 'playing') return { type: st.type, winner: st.winner };

  const sigs = signatures(game);
  if (!isThreefoldRepetition(sigs)) return { type: 'playing', winner: null };

  // 「每一步有没有将军」只在真的判重时才现算。放到上面去算的话，每次 refresh
  //（点一下棋盘就会调一次）都要把整盘棋的 FEN 重解析一遍，白白花掉几十毫秒级的时间。
  const { sides, checks } = moveFacts(game);
  const verdict = classifyRepetition(sigs, sides, checks);
  if (!verdict || verdict.type === 'repetition') return { type: 'repetition', winner: null };
  return { type: 'perpetual-check', winner: -verdict.loser };
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
 * 悔棋（界面上的「悔棋」按钮走这里）。
 *
 * **人机对弈**：退到「轮到玩家走」为止。玩家悔一步棋，如果只退一步就轮到 AI 了，
 * 玩家会看到 AI 立刻又走一步，体验上等于「悔棋没生效」。
 *
 * **双人对弈**：只退一步。两边都是人，没有「AI 马上又走」这回事 ——
 * 多退一步反而把对手刚走的那手也抹掉了。
 */
export function undoToPlayer(game) {
  if (!canUndo(game)) return false;

  game.cursor--;
  if (game.twoPlayer) return true;

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

/**
 * 切到某一局残局。
 *
 * 刻意**不改 level 与 playerSide** —— 玩家在残局里也应该能调挡位、换执子方。
 * 残局库都是红先，所以玩家执黑时由界面层负责派发一次 AI 搜索
 * （main.js 的 requestAiMove 已经处理了这种情况）。
 *
 * 切换失败（id 不存在）时不动任何状态，返回 false。
 */
export function startEndgame(game, endgameId) {
  const eg = findEndgame(endgameId);
  if (!eg) return false;

  game.mode = 'endgame';
  game.endgameId = eg.id;
  game.initialFen = eg.fen;
  game.moves = [];
  game.cursor = 0;
  return true;
}

/** 当前这一局的残局元信息；不在残局模式则返回 null */
export function endgameOf(game) {
  return game.endgameId ? findEndgame(game.endgameId) || null : null;
}

/**
 * 切到一个**自由局面** —— 起始局面既不是标准开局、也不在残局库里。
 * 目前唯一的来源是分享链接（share.js）。
 *
 * 刻意**不进残局库**：分享来的局面不该自动写进用户的自定义列表
 * （想留着的话，界面上本来就有「存为自定义局面」）。
 *
 * 代价是 `endgameOf` 对它返回 null —— 所以界面层靠
 * **「endgameId 为空 且 initialFen 不是 START_FEN」** 来认出这种状态
 * （见 main.js 的 isFreePosition）。这比再存一个标志位好：
 * 状态只有一个来源，刷新后从存档恢复出来的也照样认得出来。
 */
export function startPosition(game, fen) {
  game.mode = 'endgame';   // mode 只是个标记，没有任何逻辑读它
  game.endgameId = null;
  game.initialFen = fen;
  game.moves = [];
  game.cursor = 0;
}

/** 退回普通对局（起始局面回到标准开局，清空着法与残局标记） */
export function exitEndgame(game) {
  game.mode = 'play';
  game.endgameId = null;
  game.initialFen = START_FEN;
  game.moves = [];
  game.cursor = 0;
}
