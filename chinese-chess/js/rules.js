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
      case N: genHorse(out, cells, from, x, y, side); break;
      case B: genElephant(out, cells, from, x, y, side); break;
      case A: genAdvisor(out, cells, from, x, y, side); break;
      case K: genKing(out, cells, from, x, y, side); break;
      case P: genPawn(out, cells, from, x, y, side); break;
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

/** 马：八个日字目标；马腿（先直走的那一格）有子则该方向全部禁止 */
function genHorse(out, cells, from, x, y, side) {
  for (const [dx, dy, lx, ly] of HORSE) {
    const legX = x + lx, legY = y + ly;
    // 马腿在棋盘外时，对应的目标也必然在棋盘外，直接跳过
    if (!inBoard(legX, legY) || cells[indexOf(legX, legY)] !== EMPTY) continue;

    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 象 / 相：四个田字目标；象眼（田字中心）有子则禁；不得过河 */
function genElephant(out, cells, from, x, y, side) {
  for (const [dx, dy] of ELEPHANT) {
    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    if (!ownHalf(cy, side)) continue;
    if (cells[indexOf(x + dx / 2, y + dy / 2)] !== EMPTY) continue; // 塞象眼
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 士 / 仕：四个斜向一格；不得出九宫 */
function genAdvisor(out, cells, from, x, y, side) {
  for (const [dx, dy] of ADVISOR) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

export function findKing(cells, side) {
  const target = side * K;
  for (let i = 0; i < CELLS; i++) if (cells[i] === target) return i;
  return -1;
}

/**
 * 判断 idx 这一格是否被 bySide 攻击。
 *
 * 用「反向探测」而不是「遍历所有棋子试吃」：每个方向最多扫到第二个子就停，
 * 成本与棋盘上有多少棋子无关。这个函数在搜索里每试走一步都要调一次，值得写细。
 *
 * 注意：车 / 炮 / 将这类滑行攻击是「扫描到第一个子」才命中的，
 * 所以传进来的 idx 上必须真的有子（实际调用时都是将 / 帅所在格，恒成立）。
 *
 * 将帅照面也在这里处理：两将同处一条纵线且中间无子时互相攻击，
 * 于是「走完之后两将照面」会被合法性检查直接拒掉，不需要额外的规则代码。
 */
export function isAttacked(cells, idx, bySide) {
  const x = xOf(idx), y = yOf(idx);
  const target = cells[idx];

  // 车 / 炮 / 将：沿四个正交方向
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (!inBoard(cx, cy)) continue;

    const first = cells[indexOf(cx, cy)];
    if (Math.sign(first) === bySide) {
      const abs = Math.abs(first);
      if (abs === R) return true;                                   // 车
      if (abs === K) {
        if (Math.abs(cx - x) + Math.abs(cy - y) === 1) return true; // 将贴身
        if (Math.abs(target) === K) return true;                    // 将帅照面（中间无子）
      }
    }

    // 炮：隔一个子才能吃
    cx += dx; cy += dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (inBoard(cx, cy)) {
      const second = cells[indexOf(cx, cy)];
      if (Math.sign(second) === bySide && Math.abs(second) === C) return true;
    }
  }

  // 马：反过来找八个能跳到 idx 的位置
  for (const [dx, dy, lx, ly] of HORSE) {
    const kx = x - dx, ky = y - dy;
    if (!inBoard(kx, ky)) continue;
    const v = cells[indexOf(kx, ky)];
    if (Math.sign(v) !== bySide || Math.abs(v) !== N) continue;
    if (cells[indexOf(kx + lx, ky + ly)] !== EMPTY) continue;       // 蹩马腿
    return true;
  }

  // 兵 / 卒：正前方一格 + 过河后的左右一格
  const py = y + bySide; // 兵所在的行：红方(bySide=1)在下一行，黑方(bySide=-1)在上一行
  if (inBoard(x, py)) {
    const v = cells[indexOf(x, py)];
    if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
  }
  const crossed = bySide === RED ? y <= 4 : y >= 5;
  if (crossed) {
    for (const dx of [-1, 1]) {
      const px = x + dx;
      if (!inBoard(px, y)) continue;
      const v = cells[indexOf(px, y)];
      if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
    }
  }

  return false;
}

export function inCheck(cells, side) {
  const king = findKing(cells, side);
  return king >= 0 && isAttacked(cells, king, -side);
}

/**
 * 合法着法 = 伪合法着法去掉「走完之后己方被将军」的那些。
 *
 * 用试走 + 回退而不是在生成时就过滤：只有一处判断逻辑，不容易漏。
 * 将 / 帅的起点只在循环外找一次；如果这一步走的正好是将 / 帅，则改查它的落点。
 */
export function generateLegalMoves(pos) {
  const { cells, side } = pos;
  const kingFrom = findKing(cells, side);
  if (kingFrom < 0) return [];

  const out = [];
  for (const move of generateMoves(cells, side)) {
    const from = moveFrom(move), to = moveTo(move);
    const captured = cells[to];
    cells[to] = cells[from];
    cells[from] = EMPTY;

    const kingAt = from === kingFrom ? to : kingFrom;
    if (!isAttacked(cells, kingAt, -side)) out.push(move);

    cells[from] = cells[to];
    cells[to] = captured;
  }
  return out;
}
