/**
 * 规则引擎：着法生成、攻击判定、合法性、终局判定。纯逻辑。
 *
 * 两层接口，用途不同：
 *   generateMoves(cells, side)   伪合法着法（不检查走完后己方是否被将军）—— 搜索用
 *   generateLegalMoves(pos)      合法着法 —— 界面走子校验、终局判定用
 */

import { CELLS, EMPTY, K, A, B, N, R, C, P, RED } from './config.js';
import { indexOf, xOf, yOf, inBoard } from './position.js';

// 四个正交方向
const ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];

// 马：[目标位移 dx, dy, 马腿位移 lx, ly]
// 马腿是「先直走的那一格」，也就是位移绝对值等于 2 的那个方向上的相邻格
const HORSE = [
  [1, -2, 0, -1], [-1, -2, 0, -1],
  [1, 2, 0, 1], [-1, 2, 0, 1],
  [2, -1, 1, 0], [2, 1, 1, 0],
  [-2, -1, -1, 0], [-2, 1, -1, 0],
];

// 象 / 相：田字，象眼是两格位移的中点
const ELEPHANT = [[2, 2], [2, -2], [-2, 2], [-2, -2]];

// 士 / 仕：斜走一格
const ADVISOR = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function encodeMove(from, to) { return from * CELLS + to; }
export function moveFrom(move) { return Math.floor(move / CELLS); }
export function moveTo(move) { return move % CELLS; }

/** 目标格为空或敌子即可落子 */
function canLand(cells, idx, side) {
  const t = cells[idx];
  return t === EMPTY || Math.sign(t) !== side;
}

/** 是否在自己的九宫内 */
function inPalace(x, y, side) {
  if (x < 3 || x > 5) return false;
  return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}

/** 是否在自己的半场内（相 / 象不能过河） */
function ownHalf(y, side) { return side === RED ? y >= 5 : y <= 4; }

/**
 * 生成伪合法着法。不检查走完之后己方是否被将军 —— 那一步在 generateLegalMoves() 里统一做。
 */
export function generateMoves(cells, side) {
  const out = [];
  for (let from = 0; from < CELLS; from++) {
    const v = cells[from];
    if (v === EMPTY || Math.sign(v) !== side) continue;
    const x = xOf(from), y = yOf(from);
    switch (Math.abs(v)) {
      case R: genRook(out, cells, from, x, y, side); break;
      case C: genCannon(out, cells, from, x, y, side); break;
      case P: genPawn(out, cells, from, x, y, side); break;
      case K: genKing(out, cells, from, x, y, side); break;
      default: break;
    }
  }
  return out;
}

/** 车：四方向直线滑动，遇子停止，遇敌子可吃 */
function genRook(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] === EMPTY) {
        out.push(encodeMove(from, idx));
      } else {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/**
 * 炮：四方向直线。
 * 第一段没有炮架，只能走空格；遇到第一个子（炮架）之后，
 * 再找它后面的第一个子，是敌子才能吃。
 */
function genCannon(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;

    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) {
      out.push(encodeMove(from, indexOf(cx, cy)));
      cx += dx; cy += dy;
    }
    if (!inBoard(cx, cy)) continue;

    // (cx,cy) 是炮架，从它后面继续找第一个子
    cx += dx; cy += dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] !== EMPTY) {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/** 兵 / 卒：未过河只能向前一格，过河后可向前或左右一格，永不后退 */
function genPawn(out, cells, from, x, y, side) {
  const forward = -side; // 红方前进 y 减小，黑方前进 y 增大
  const fy = y + forward;
  if (inBoard(x, fy)) {
    const idx = indexOf(x, fy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }

  // 过河后才能横走：红兵到 y <= 4，黑卒到 y >= 5
  const crossed = side === RED ? y <= 4 : y >= 5;
  if (!crossed) return;

  for (const dx of [-1, 1]) {
    const cx = x + dx;
    if (!inBoard(cx, y)) continue;
    const idx = indexOf(cx, y);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 将 / 帅：四方向一格，不得出九宫 */
function genKing(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}
