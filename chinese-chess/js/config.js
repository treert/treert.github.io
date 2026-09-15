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

// === 评估 ===
// 索引 = 棋子编码（1..7）。
// 帅 / 将 记 0：双方恒各有一个，算进子力只会互相抵消，白增加一次查表。
export const PIECE_VALUE = [0, 0, 200, 200, 400, 900, 450, 100];
//                          占位 K   A    B    N    R    C    P

// 兵 / 卒过河的额外加分
export const PASSED_PAWN_BONUS = 50;

// === AI 挡位 ===
// 每个挡位是一组声明式参数，弱化手段都在这里调，不要散到 engine.js 的 if 里。
//
// 四个挡位而不是五个：深度 6 与 7 对普通玩家体感没有差别，耗时却翻倍。
//
// quiescence（静态搜索）是让 AI「像新手」最有效的单个开关：
// 关掉它，AI 会在兑子序列中途停下、以为自己占便宜，结果被吃回 ——
// 这恰恰是初学者的真实特征，比单纯降深度像得多。
//
// checkExtension（将军延伸）让引擎多看几步「将军里的事」：被将军的节点不消耗深度。
// 弱挡位给 0 —— 新手本来就该看不清强制手段。
//
// mateProbePly（连将杀探测）才是让「十几步连杀」看得见的那个开关，值是多层上限（0 = 关）。
// 详见 engine.js 的 probeMate()：攻击方只走将军着法，实测把《适情雅趣》那种排局
// 从「要上千万节点、根本搜不到底」降到十几万节点。弱挡位给 0：入门/初级不该一眼看穿杀棋。
//
// depth 是迭代加深的上限，实际由 timeLimitMs 截断。
// noise 是根节点评分扰动幅度（与评估函数同单位）；blunderRate 是按概率故意走次优着。
//
// medium 的时间上限从 800ms 提到 1200ms 是给探测留的：它的常规搜索本来就被 depth 5
// 卡住（几百毫秒就返回），多出来的预算只有探测会用 —— 而《适情雅趣》那类十三层连杀
// 要 700ms 上下才证得完。hard 的时间上限没动，所以「一步最多等 1.5 秒」仍然成立。
export const LEVELS = [
  { id: 'novice', name: '入门', depth: 1,  timeLimitMs: 200,  quiescence: false, noise: 120, blunderRate: 0.35, checkExtension: 0, mateProbePly: 0 },
  { id: 'easy',   name: '初级', depth: 3,  timeLimitMs: 400,  quiescence: false, noise: 60,  blunderRate: 0.15, checkExtension: 0, mateProbePly: 0 },
  { id: 'medium', name: '中级', depth: 5,  timeLimitMs: 1200, quiescence: true,  noise: 20,  blunderRate: 0.03, checkExtension: 6, mateProbePly: 13 },
  { id: 'hard',   name: '高级', depth: 64, timeLimitMs: 1500, quiescence: true,  noise: 0,   blunderRate: 0,    checkExtension: 6, mateProbePly: 15 },
];
