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

// === 位置表（piece-square） ===
//
// 评估里唯一的位置项。没有它的时候，开局的 44 个着法分值**一模一样**（全是 0，
// 因为评估只有子力），选哪个纯凭搜索先试到谁 —— 于是 AI 会走「借对方的炮当炮架、
// 一个炮换一个马」这类只在浅层看着划算的着法，也就是人一眼就说「哪有这么开局的」。
//
// 只表达几条**能讲出理由**的常识，不追求精确（第一版）：
//   马 / 炮 用中路的纵线、过河是好事（鼓励出子、中炮）
//   炮 待在自己或对方的底线上是死子
//   车 离开底线、占到中间几行是好事
//   帅 / 将 离开底线是坏事
//   仕 / 相 在九宫中心 / 中路象位是好事
//   兵 / 卒 不另开表：它的位置分就是已有的过河加分（PASSED_PAWN_BONUS）
//
// **写成「纵线分 + 行分」两张小表再铺开，不是 90 格逐格手填。** 逐格手填的 630 个数
// 没人复核得了，也没人知道为什么是那个值；可分离的形式下每个数都对应上面一条理由，
// 将来要从引擎（Pikafish）换算实测表，替换的也只是这一块数据。
//
// 红方视角：y=0 是黑方底线、y=9 是红方底线、x=4 是中路。左右对称（只依赖 |x-4|），
// 所以黑方按 y 镜像查同一张表就够（见 MIRROR_INDEX 与 engine.js 的 evaluate）。
const FILE_BY_DISTANCE = {
  [N]: [0, -6, -12, -18, -24],   // 马：越靠边越别扭
  [C]: [12, 8, 2, 0, 0],         // 炮：中路最好（这就是「中炮」的道理），其次三七路
};

const RANK_BONUS = {
  [N]: [-6, -2, 2, 6, 6, 4, 2, 0, -8, -18],  // 马：过河最好，压在底线上最差（催它出子）
  [C]: [-24, 0, 4, 8, 6, 6, 4, 0, -2, -10],  // 炮：敌方底线是死子，我方底线只是过渡
  [R]: [4, 6, 6, 6, 8, 8, 8, 6, 2, 0],       // 车：出到中间几行就好
  [K]: [0, 0, 0, 0, 0, 0, 0, -40, -18, 0],   // 帅 / 将：待在底线，别乱动
};

/** 单点加分，[x, y, 分] —— 只有这两个点值得单说 */
const SPOT_BONUS = {
  [A]: [[4, 8, 6]],   // 仕在九宫中心
  [B]: [[4, 7, 6]],   // 相在中路象位
};

/**
 * 铺成一张平表：索引 = 棋子编码 * 90 + 格子。铺一次，评估里只剩一次查表 ——
 * evaluate() 在叶节点会被调用上百万次，多一层数组套数组都嫌贵。
 */
export const PIECE_SQUARE = (() => {
  const table = new Int16Array(8 * CELLS);
  for (let piece = 0; piece < 8; piece++) {
    const file = FILE_BY_DISTANCE[piece];
    const rank = RANK_BONUS[piece];
    for (let idx = 0; idx < CELLS; idx++) {
      const x = idx % COLS;
      const y = (idx - x) / COLS;
      let v = (file ? file[Math.abs(x - 4)] : 0) + (rank ? rank[y] : 0);
      for (const [sx, sy, sv] of SPOT_BONUS[piece] || []) if (sx === x && sy === y) v += sv;
      table[piece * CELLS + idx] = v;
    }
  }
  return table;
})();

/**
 * 黑方查表用的下标映射：上下镜像（x 不变）。
 *
 * 位置表左右对称，所以不必再镜像横轴 —— 于是开局那种左右对称的局面两边加起来
 * 正好抵消，静态评估仍然是 0（`test-engine.mjs` 里有这条断言）。
 */
export const MIRROR_INDEX = (() => {
  const m = new Int16Array(CELLS);
  for (let idx = 0; idx < CELLS; idx++) {
    const x = idx % COLS;
    m[idx] = (ROWS - 1 - (idx - x) / COLS) * COLS + x;
  }
  return m;
})();

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
