/**
 * 中国象棋模块的常量。
 *
 * 纯数据，不 import 任何东西 —— Worker 会直接加载这个文件，
 * 所以这里绝对不能出现任何 DOM 相关的东西。
 */

// === 棋盘 ===
// x 向右 0..8，y 向下 0..9；黑方在 y = 0..4，红方在 y = 5..9
export const COLS = 9;
export const ROWS = 10;
export const CELLS = COLS * ROWS; // 90

// === 棋子编码 ===
// 局面是 Int8Array(90)：0 为空，正数红方，负数黑方。
// 判色用 Math.sign(v)，判类型用 Math.abs(v)。
export const EMPTY = 0;
export const K = 1; // 帅 / 将
export const A = 2; // 仕 / 士
export const B = 3; // 相 / 象
export const N = 4; // 马
export const R = 5; // 车
export const C = 6; // 炮
export const P = 7; // 兵 / 卒

// === 阵营 ===
export const RED = 1;
export const BLACK = -1;

// === FEN ===
// 索引 = 棋子编码 + 7，覆盖 -7..7。
// 索引 7 对应 EMPTY，但 FEN 里空格写成数字，所以那一项用不到。
export const FEN_OF_PIECE = [
  'p', 'c', 'r', 'n', 'b', 'a', 'k', '',
  'K', 'A', 'B', 'N', 'R', 'C', 'P',
];

export const PIECE_OF_FEN = {
  k: -K, a: -A, b: -B, n: -N, r: -R, c: -C, p: -P,
  K, A, B, N, R, C, P,
};

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
