/**
 * 局面表示与 FEN 读写。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 局面对象：{ cells: Int8Array(90), side: 1 | -1 }
 *   - idx = y * COLS + x
 *   - cells 是「值」而不是共享状态：clonePosition() 就是一次 90 字节拷贝，
 *     所以搜索和试走可以随便复制，不用担心共享引用
 */

import { COLS, ROWS, CELLS, EMPTY, FEN_OF_PIECE, PIECE_OF_FEN, START_FEN, RED, BLACK } from './config.js';

export function indexOf(x, y) { return y * COLS + x; }
export function xOf(idx) { return idx % COLS; }
export function yOf(idx) { return Math.floor(idx / COLS); }
export function inBoard(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

/**
 * 解析 FEN。只读前两个字段（棋盘 + 轮走方），后三个字段忽略。
 *
 * 解析失败抛 Error 而不是返回 null —— 调用方（残局库校验、粘贴导入）
 * 需要知道到底哪里不对，抛异常能带上具体原因。
 */
export function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`FEN 至少需要「棋盘 轮走方」两个字段：${fen}`);

  const rows = parts[0].split('/');
  if (rows.length !== ROWS) throw new Error(`FEN 棋盘应为 ${ROWS} 行，实际 ${rows.length} 行`);

  const cells = new Int8Array(CELLS);
  for (let y = 0; y < ROWS; y++) {
    let x = 0;
    for (const ch of rows[y]) {
      if (ch >= '1' && ch <= '9') { x += Number(ch); continue; }
      const piece = PIECE_OF_FEN[ch];
      if (piece === undefined) throw new Error(`FEN 第 ${y + 1} 行出现无法识别的字符「${ch}」`);
      if (x >= COLS) throw new Error(`FEN 第 ${y + 1} 行超出 ${COLS} 列`);
      cells[indexOf(x, y)] = piece;
      x++;
    }
    if (x !== COLS) throw new Error(`FEN 第 ${y + 1} 行共 ${x} 列，应为 ${COLS} 列`);
  }

  const side = parts[1] === 'w' ? RED : parts[1] === 'b' ? BLACK : null;
  if (side === null) throw new Error(`FEN 轮走方应为 w 或 b，实际「${parts[1]}」`);

  return { cells, side };
}

/** 生成 FEN。后三个字段固定输出 `- - 0 1`，本模块不使用它们。 */
export function toFen(pos) {
  const lines = [];
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    let empty = 0;
    for (let x = 0; x < COLS; x++) {
      const v = pos.cells[indexOf(x, y)];
      if (v === EMPTY) { empty++; continue; }
      if (empty) { line += empty; empty = 0; }
      line += FEN_OF_PIECE[v + 7];
    }
    if (empty) line += empty;
    lines.push(line);
  }
  return `${lines.join('/')} ${pos.side === RED ? 'w' : 'b'} - - 0 1`;
}

export function startPosition() { return parseFen(START_FEN); }

export function clonePosition(pos) {
  return { cells: pos.cells.slice(), side: pos.side };
}

/**
 * 局面签名：FEN 的前两个字段。
 *
 * 用于「三次重复判和」。后三个字段（含回合数）每次都变，必须排除，
 * 否则同一个局面永远比不出重复。
 */
export function positionSignature(fen) {
  const parts = String(fen).trim().split(/\s+/);
  return `${parts[0]} ${parts[1]}`;
}
