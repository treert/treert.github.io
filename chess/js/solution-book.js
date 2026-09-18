/**
 * 谱载解法（棋谱）。纯逻辑 —— 不碰 DOM、不碰 Worker、不碰 localStorage。
 *
 * `js/solutions.js` 里每局存的是一条**从初始局面开始的完整杀线**（`pv`，UCI 文本）。
 * 界面要回答的是另一个问题：「**眼下这个局面**，谱上写的是哪一步？」
 *
 * 做法：进一局时把那条线展开成两个平行数组（见 `buildBook`）——
 * 第 i 手**之前的局面签名**、以及第 i 手本身。查询时拿「当前走到第几手」
 * （`game.cursor`）去对：签名一致就给那一手，不一致就回退引擎搜索。
 *
 * ## 为什么必须带上「第几手」
 *
 * **杀线里重复局面是常态**：子力少量时来回走、王来回躲，同一条线上会反复回到
 * 同一个局面。只用签名当键，后一次会把前一次盖掉，于是**同一个局面拿到的是
 * 另一处该走的着法** —— 走错一步，整条线就废了。（象棋那边踩过这个坑，
 * 结论照搬。）带上 ply 之后匹配就唯一了，而且几条路径天然都对：
 * 跟着谱走、悔棋（只移动游标）、点着法列表跳转（游标跟着走）；
 * 一旦走了谱外的着法，签名对不上 → 回退引擎搜索。
 *
 * ## 坐标
 *
 * 解法里的着法用 **UCI 坐标**（`e2e4` / `e7e8q`）—— 与 Stockfish、
 * 与 `tools/gen-solutions.mjs` 的输入输出同格式，拿出去核对方便。
 * 这一层只做换算与查表，不做合法性判断 —— 数据本身已经过
 * `tools/verify-endgames.mjs` 校验。
 */

import { parseFen, positionSignature } from './position.js';
import {
  moveOfUci, moveFrom, moveTo, movePromo,
  applyMoveCells, nextCastling, nextEp, generateLegalMoves,
} from './rules.js';

/**
 * 判「是不是同一步」：按起点-终点-升变比。
 *
 * **不能拿整数直接比** —— `solutions.js` 里的着法是 UCI 文本转来的（只有 from/to/promo），
 * 而规则层生成的着法还带着「双步前进 / 易位 / 吃过路兵」的标记位。不比这一层的话
 * 谱表里永远找不到对应的合法着法（签名也就无从算起）。
 */
const sameMove = (a, b) => moveFrom(a) === moveFrom(b)
  && moveTo(a) === moveTo(b)
  && movePromo(a) === movePromo(b);

/**
 * 在局面上走一步（就地改）。
 *
 * **易位权与过路兵必须跟着更新** —— 局面签名里含着这两项，
 * 不更新的话「走过车的线」和「刚推过两格兵的线」签名就对不上游戏里的局面，
 * 谱表会静悄悄地失效（表现成「有解法但提示不给谱」）。
 *
 * 所以传进来的着法必须是**规则层生成的那一个**（带着标记位），
 * 见 `buildBook` 里那一步规范化。
 */
function play(pos, move) {
  const castling = nextCastling(pos.castling, move, pos.cells);
  const ep = nextEp(move);
  applyMoveCells(pos.cells, move);
  pos.side = -pos.side;
  pos.castling = castling;
  pos.ep = ep;
}

/**
 * 把一条杀线展开成 `{ moves, before }`：两组等长数组。
 *
 *   `moves[i]`   第 i 手（**规范化过的**，带双步 / 易位 / 过路兵标记）
 *   `before[i]`  走第 i 手**之前**那个局面的签名
 *
 * `initialFen` 与 `pv` 对不上（数据错了、坐标写错）时不会抛，而是**整条作废**
 * —— 界面上表现为「查不到、回退引擎」。数据本身该由 `verify-endgames.mjs`
 * 在入库时挡住，运行时不该为此崩页面，也不该拿半条线给出错的提示。
 */
export function buildBook(initialFen, pv) {
  const moves = [];
  const before = [];
  if (!pv) return { moves, before };

  let pos;
  try {
    pos = parseFen(initialFen);
  } catch {
    return { moves, before };
  }

  for (const tok of String(pv).trim().split(/\s+/).filter(Boolean)) {
    const want = moveOfUci(tok);
    if (want < 0) return { moves, before };   // 坐标读不动 → 整条作废

    // **规范化**：在合法着法里找出同一步，拿带标记位的那个版本往下走。
    // 走不通说明数据有问题（坐标写错、局面与线对不上）—— 也整条作废，
    // 让界面老老实实回退引擎，而不是拿着半条线给出错的提示。
    const move = generateLegalMoves(pos).find((m) => sameMove(m, want));
    if (!move) return { moves, before };

    before.push(positionSignature(pos));
    moves.push(move);
    play(pos, move);
  }
  return { moves, before };
}

/**
 * 谱载着法：**只有当「走到第 ply 手」这个位置与谱上对得上时**才给。
 *
 * `ply` = 已走的半层数（`game.cursor`）。返回 0 表示没命中 ——
 * 走岔了、悔棋到谱外、或者这一局本来就没有解法，调用方据此回退引擎搜索。
 */
export function bookMove(book, fen, ply) {
  if (!book || !Number.isInteger(ply) || ply < 0 || ply >= book.moves.length) return 0;
  return book.before[ply] === positionSignature(parseFen(fen)) ? book.moves[ply] : 0;
}
