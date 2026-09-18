/**
 * 对局状态机。纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * 设计要点（design.md §3.1 与象棋那一层的结论）：
 *
 *   1. 局面只有一个来源 —— FEN 字符串。需要棋盘时现从它 parseFen，
 *      内存里不额外维护一份 Int8Array。否则悔棋、回看跳转、走子会各走各的路径，
 *      迟早出现「状态不同步」这类极难查的 bug。
 *
 *   2. 悔棋和回看跳转都**只移动 cursor，绝不删除 moves** —— 这样重做是免费的。
 *      只有在「回看状态下走新着法」时才截断后面的分支。
 *
 *   3. 每步存一份 FEN 快照（约 60~70 字符），换来悔棋 / 回看跳转 O(1)。
 *      200 步约 14KB，比每次重放划算得多，而且同一份数据同时供
 *      悔棋、跳转、着法列表、存档、分享使用。
 */

import { START_FEN, WHITE } from './config.js';
import { parseFen, toFen, positionSignature } from './position.js';
import {
  generateLegalMoves, gameStatus, makeMove,
  moveFrom, moveTo, movePromo,
} from './rules.js';
import { toSan } from './notation.js';
import { findEndgame } from './endgames.js';

export function createGame(options = {}) {
  return {
    initialFen: options.initialFen || START_FEN,
    moves: [],
    cursor: 0,
    mode: options.mode || 'play',            // play | endgame（只是个标记，没有逻辑读它）
    playerSide: options.playerSide || WHITE,
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

/** 当前这条线上的着法（回看时只到 cursor 为止） */
export function moveList(game) {
  return game.moves.slice(0, game.cursor);
}

export function canUndo(game) {
  return game.cursor > 0;
}

/**
 * 从起始局面到 cursor 为止的所有局面签名，供三次重复判定。
 *
 * 签名在走子时就算好存在 `moves[i].sig` 里，**不在这里重新解析每一份 FEN** ——
 * 这个函数每次刷新界面都会被调到，一盘 200 步的棋重解析 200 次 FEN
 * 白白吃掉几十毫秒（点一下棋子就卡一下）。
 */
function signatures(game) {
  const out = [positionSignature(parseFen(game.initialFen))];
  for (let i = 0; i < game.cursor; i++) out.push(game.moves[i].sig);
  return out;
}

/**
 * 三次重复判和。
 *
 * 只看**当前这条线**（起始局面 + moves[0..cursor)），不看被截断的分支 ——
 * 被截掉的那些着法在规则上从来没发生过。
 *
 * 用 `positionSignature` 而不是完整 FEN：回合数字段每次都变，
 * 用完整 FEN 永远比不出重复。
 */
function isThreefold(sigs) {
  const count = new Map();
  for (const s of sigs) {
    const n = (count.get(s) || 0) + 1;
    if (n >= 3) return true;
    count.set(s, n);
  }
  return false;
}

/**
 * 终局判定。除了将死 / 逼和 / 50 步 / 子力不足，还要看**三次重复** ——
 * 后者需要整条着法线，所以判定放在这里而不是 rules.js。
 *
 * 顺序与 rules.gameStatus 一致（先判无着法，再判计数类），
 * 三次重复排在最后。
 */
export function evaluateStatus(game) {
  const st = gameStatus(currentPosition(game));
  if (st.type !== 'playing') return { type: st.type, winner: st.winner };
  if (isThreefold(signatures(game))) return { type: 'repetition', winner: null };
  return { type: 'playing', winner: null };
}

/**
 * 把一个「只知道起点、终点、升变」的着法补齐成规范编码。
 *
 * **为什么需要它**：Worker 按协议只回 `{ from, to, promo }`（design.md §7.4 ——
 * 不返回标记位，主线程本来就要重算记谱）。而本模块的着法编码里，
 * 易位 / 吃过路兵 / 双步前进各有标记位，直接 `encodeMove(from, to)` 出来的整数
 * 和 `generateLegalMoves` 里那个**不相等** —— 于是 `includes()` 判不出它是合法的，
 * 表现成「AI 走易位时不动了」。
 *
 * 做法是按「起点 + 终点 + 升变种类」在合法着法里找对应的那一个，并以它为准。
 * 这三个字段能唯一确定一个合法着法（同一格上的四种升变由 promo 区分）。
 *
 * 返回 0 表示没有对应的合法着法（0 这个编码 from = to = a1，永远不是合法着法，当哨兵是安全的）。
 */
export function canonicalMove(game, move) {
  const from = moveFrom(move);
  const to = moveTo(move);
  const promo = movePromo(move);
  return generateLegalMoves(currentPosition(game))
    .find((m) => moveFrom(m) === from && moveTo(m) === to && movePromo(m) === promo) || 0;
}

/**
 * 走一步棋。
 *
 * `san` 必须在改棋盘**之前**算（消歧义要看走之前的同类棋子），
 * 所以这里先算记谱、再 makeMove。
 */
export function playMove(game, move) {
  if (evaluateStatus(game).type !== 'playing') return { ok: false, reason: '对局已经结束' };

  const canonical = canonicalMove(game, move);
  if (!canonical) return { ok: false, reason: '这个着法不合法' };

  const pos = currentPosition(game);
  const san = toSan(pos, canonical);
  const made = makeMove(pos, canonical);

  // 在回看状态下走新着法：截断后面的分支，重做链作废
  if (game.cursor < game.moves.length) game.moves.length = game.cursor;
  game.moves.push({
    move: canonical,
    san,
    captured: made.captured,
    fenAfter: toFen(made.pos),
    sig: positionSignature(made.pos), // 三次重复判定用（见 signatures）
  });
  game.cursor++;
  return { ok: true, move: canonical };
}

/**
 * 悔棋（界面上的「悔棋」按钮走这里）。
 *
 * **人机对弈**：退到「轮到玩家走」为止。玩家悔一步棋，如果只退一步就轮到 AI 了，
 * 玩家会看到 AI 立刻又走一步，体验上等于「悔棋没生效」。
 *
 * **双人对弈**：只退一步。两边都是人，没有「AI 马上又走」这回事 ——
 * 多退一步反而把对手刚走的那手也抹掉了。
 *
 * **不删除 moves**，只移动 cursor —— 所以「悔棋之后想反悔」直接 gotoPly 回去就行。
 */
export function undoToPlayer(game) {
  if (!canUndo(game)) return false;

  game.cursor--;
  if (game.twoPlayer) return true;

  while (game.cursor > 0 && sideToMove(game) !== game.playerSide) game.cursor--;
  return true;
}

/** 回看跳转到第 n 步（0 = 起始局面）。越界返回 false 且不动状态 */
export function gotoPly(game, n) {
  if (!Number.isInteger(n) || n < 0 || n > game.moves.length) return false;
  game.cursor = n;
  return true;
}

export function reset(game) {
  game.moves.length = 0;
  game.cursor = 0;
}

/**
 * 切到某一局残局。
 *
 * 刻意**不改 level 与 playerSide** —— 玩家在残局里也应该能调挡位、换执子方。
 * 残局库都是白先，所以玩家执黑时由界面层负责派发一次 AI 搜索
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
 * 来源有两个：分享链接（share.js）、粘一段 FEN 直接摆上去（自定义局面导入）。
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
