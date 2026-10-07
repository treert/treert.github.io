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
//
// **按名字赋值，不数位置**：这里原来写成 `[0, 0, 200, 200, 400, 900, 450, 100]`
// 加一行 `占位 K A B N R C P` 的对齐注释 —— 那正是第 22 条那个 bug 的成因
// （`MOBILITY_WEIGHT` 当年就是这么把 车 / 马 写反的，安静地错了一整轮）。
// 那一轮的结论是「写法不改就会再犯」，这里照做（`tools/eval-compare.mjs` 的 `piece` 组
// 仍然按下标改它，接口没变）。
export const PIECE_VALUE = (() => {
  const v = [0, 0, 0, 0, 0, 0, 0, 0];   // 0 号位占位；帅 / 将（K）也留 0
  v[A] = 200;   // 仕 / 士
  v[B] = 200;   // 相 / 象
  v[N] = 400;   // 马
  v[R] = 900;   // 车
  v[C] = 450;   // 炮
  v[P] = 100;   // 兵 / 卒
  return v;
})();

// 兵 / 卒过河的额外加分。**开局一套、残局一套** ——
// 同一枚过河兵在残局里值钱得多（残局里一个贴近九宫的兵常常直接决定胜负），
// 评估按相位在这两个数之间插值，见 engine.js 的 evaluate()。
//
// **兵的位置分就这一处**：「过了河之后又往前走了多远」原本想再补一行行分，
// 2026-10-06 试过、量过、撤掉了（见下面行分表的说明与 decisions.md 第 21 条）。
export const PAWN_BONUS_OPENING = 50;
export const PAWN_BONUS_ENDGAME = 100;

// === 相位（开局 ⇄ 残局）===
//
// 「这个局面离开局有多远」用**剩余子力的加权和**衡量：满盘 = PHASE_MAX（50），
// 子力越少越接近 0，也就是越像残局。evaluate() 用它在**开局位置表**和**残局位置表**
// 之间线性插值 —— 于是同一枚棋子在不同阶段有不同的位置价值。
//
// 权重只表达「这类子力还剩多少决定局面像不像开局」：车最重（4），马炮次之（2），
// 士象兵再次之（1），帅 / 将不参与（双方恒各一个，不携带信息）。
// 满盘时的和必须正好等于 PHASE_MAX，`test-engine.mjs` 钉着这条 ——
// 不然插值的两端永远取不到，表调了也看不出效果。
export const PHASE_MAX = 50;
// **按名字赋值，不数位置** —— 理由与上面的 `PIECE_VALUE` 一样（第 22 条）。
export const PHASE_WEIGHT = (() => {
  const w = [0, 0, 0, 0, 0, 0, 0, 0];   // 0 号位占位；帅 / 将（K）不参与
  w[A] = 1;
  w[B] = 1;
  w[N] = 2;
  w[R] = 4;
  w[C] = 2;
  w[P] = 1;
  return w;
})();

// === 位置表（piece-square）===
//
// 评估的位置项（2026-10-06 起不是唯一一个了：`engine.js` 里另加了「机动性」——
// 车马炮的可达格数。两者分工：这里管「这个格子值多少」，机动性管「这个子有多活」）。
// 没有它的时候，开局的 44 个着法分值**一模一样**（全是 0，
// 因为评估只有子力），选哪个纯凭搜索先试到谁 —— 于是 AI 会走「借对方的炮当炮架、
// 一个炮换一个马」这类只在浅层看着划算的着法，也就是人一眼就说「哪有这么开局的」。
//
// **两张表：开局一张、残局一张，evaluate() 按相位插值。** 只表达几条
// **能讲出理由**的常识，不追求精确：
//   开局表 —— 出子（马炮走出来）、中路比边路值钱（这就是「中炮」的道理）、
//             炮待在对方底线上是死子、车离开底线、帅别乱动、士相待在要点
//   残局表 —— 同样的形状，按残局的棋理重新给值：马在开阔的残局更强、
//             炮缺了炮架所以中路油水变少、帅可以「老将出马」助攻（出走惩罚减轻）、
//             士相是守和的资本（单车难胜士象全）
//
// **写成「纵线分 + 行分」两张小表再铺开，不是 90 格逐格手填。** 逐格手填的 1260 个数
// 没人复核得了，也没人知道为什么是那个值；可分离的形式下每个数都对应上面一条理由，
// 将来要从引擎（Pikafish）换算实测表，替换的也只是这一块数据。
//
// 注（2026-10-05）：**「换成引擎拟合的表」这件事试过了，没换成** —— 只拟合位置表更差，
// 放开拟合 MAE 好 41% 但同局面排序更差。为什么、数据是多少，见 tools/gen-pst.mjs 头部
// 与 docs/future-work.md 的 C1。
//
// 注（2026-10-06）：**兵的推进试过加行分，量完撤了**。当时发现兵的位置分**恒等于 0**
// （「刚过河」与「已到九宫门口」同分），补了一行「越靠近九宫越值钱」；
// 固定深度对照里它**一步棋都换不动**（×1 / ×2 都是 0/65，放大到 ×4 才动 1 步）——
// 这项在同一个局面内近乎恒定，对候选着法没有区分度。数据、做法与结论见
// docs/decisions.md 第 21 条（它同时改掉了「继续微调位置表」这个方向）。
//
// 红方视角：y=0 是黑方底线、y=9 是红方底线、x=4 是中路。左右对称（只依赖 |x-4|），
// 所以黑方按 y 镜像查同一张表就够（见 MIRROR_INDEX 与 engine.js 的 evaluate）。
//
// 两张表左右都对称 → 开局那种左右对称的局面两边加起来正好抵消，
// 静态评估仍然是 0（`test-engine.mjs` 里有这条断言）。
const FILE_OPENING = {
  [N]: [0, -6, -12, -18, -24],   // 马：越靠边越别扭
  [C]: [12, 8, 2, 0, 0],         // 炮：中路最好（这就是「中炮」的道理），其次三七路
};

const RANK_OPENING = {
  [N]: [-6, -2, 2, 6, 6, 4, 2, 0, -8, -18],  // 马：过河最好，压在底线上最差（催它出子）
  [C]: [-24, 0, 4, 8, 6, 6, 4, 0, -2, -10],  // 炮：敌方底线是死子，我方底线只是过渡
  [R]: [4, 6, 6, 6, 8, 8, 8, 6, 2, 0],       // 车：出到中间几行就好
  [K]: [0, 0, 0, 0, 0, 0, 0, -40, -18, 0],   // 帅 / 将：待在底线，别乱动
  // **兵刻意没有这一行**：兵的位置分只有「过没过河」那一个加分（PAWN_BONUS_*）。
  // 2026-10-06 补过一行「过了河之后走了多远」的行分（九宫那两行最值钱），
  // **量完撤掉了** —— 固定深度对照里它一步棋都换不动（×1 / ×2 都是 0/65，
  // 要放大到 ×4 才动 1 步）。原因值得记：这项在同一个局面内近乎恒定，
  // 对候选着法没有区分度。数据与结论见 docs/decisions.md 第 21 条。
};

/** 单点加分，[x, y, 分] —— 只有这两个点值得单说 */
const SPOT_OPENING = {
  [A]: [[4, 8, 6]],   // 仕在九宫中心
  [B]: [[4, 7, 6]],   // 相在中路象位
};

// 残局表：每条值都对应一句残局棋理（与上面的开局表逐项对照着看）。
const FILE_ENDGAME = {
  [N]: [0, -4, -9, -14, -18],    // 马：残局棋盘开阔，边马的损失比开局小
  [C]: [8, 5, 1, 0, 0],          // 炮：残局缺炮架，中路的油水比开局少一半
};

const RANK_ENDGAME = {
  [N]: [-6, 2, 8, 14, 14, 6, 3, 0, -6, -14],  // 马：残局的马「八面威风」，占到过河位值一大截
  [C]: [-16, 2, 4, 6, 4, 4, 2, 0, -2, -6],    // 炮：沉在对方底线的惩罚减轻（残局沉底炮能做杀）
  [R]: [2, 4, 6, 8, 10, 10, 8, 6, 2, 0],      // 车：依然是最强子，占中行要道
  [K]: [0, 0, 0, 0, 0, 0, 0, -30, -12, 0],    // 帅：残局可以出来助攻，出走惩罚比开局小
  // 兵同样刻意没有这一行（残局那一版也试过、量过、撤掉了）—— 见上面开局表的说明
};

const SPOT_ENDGAME = {
  [A]: [[4, 8, 8]],   // 仕：残局的士是守和的资本（单车难胜士象全）
  [B]: [[4, 7, 8]],   // 相：同上
};

/**
 * 把「纵线分 + 行分 + 单点分」铺成一张平表：索引 = 棋子编码 * 90 + 格子。
 * 铺一次，评估里只剩一次查表 —— evaluate() 在叶节点会被调用上百万次，
 * 多一层数组套数组都嫌贵。
 */
function buildPieceSquareTable(file, rank, spot) {
  const table = new Int16Array(8 * CELLS);
  for (let piece = 0; piece < 8; piece++) {
    const fileBonus = file[piece];
    const rankBonus = rank[piece];
    for (let idx = 0; idx < CELLS; idx++) {
      const x = idx % COLS;
      const y = (idx - x) / COLS;
      let v = (fileBonus ? fileBonus[Math.abs(x - 4)] : 0) + (rankBonus ? rankBonus[y] : 0);
      for (const [sx, sy, sv] of spot[piece] || []) if (sx === x && sy === y) v += sv;
      table[piece * CELLS + idx] = v;
    }
  }
  return table;
}

export const PIECE_SQUARE_OPENING = buildPieceSquareTable(FILE_OPENING, RANK_OPENING, SPOT_OPENING);
export const PIECE_SQUARE_ENDGAME = buildPieceSquareTable(FILE_ENDGAME, RANK_ENDGAME, SPOT_ENDGAME);

/**
 * **机动性权重**（`engine.js` 的 `mobility` 项）：车 / 马 / 炮的「可达格数」各值多少。
 *
 * 为什么写在 config.js：它和 `PIECE_VALUE` / `PHASE_WEIGHT` / 上面两张表一样，
 * 是**调出来的常量**（数据），不是逻辑。放这里工具才能像改位置表那样改它 ——
 * 2026-10-06 就是用它扫了一遍三个权重（`tmp/xq-mobility-tune.mjs`）。
 *
 * **按名字赋值，不数位置**：它原来是 `[0, 0, 0, 0, 3, 2, 3, 0]` 加一行对齐注释
 * （`占位 K A B N R C P`），结果把 **N 与 R 写反了** —— 车拿 2、马拿 3，安静地错了一整轮。
 * 那种写法每加一行表就得重新数一遍位置，错位不会报错、只会让权重悄悄换人，所以换成现在这样。
 * 见 `docs/decisions.md` 第 22 条。
 */
export const MOBILITY_WEIGHT = (() => {
  const w = new Int8Array(8);
  w[R] = 3;
  w[N] = 2;
  w[C] = 3;
  return w;
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
// book（开局库）是**查谱的概率**：局面在开局库里、且掷骰子命中时，直接走谱上的着法
// （按权重随机挑一条），不派发搜索 —— 于是开局不再「不像人」，而且零耗时。
// 弱挡位给得低：它们本来就该常常不按谱走、走出新手的样子。
// 库、匹配方式与「谱外怎么办」都在 openings.js 与 docs/openings.md。
//
// depth 是迭代加深的上限，实际由 timeLimitMs 截断。
// noise 是根节点评分扰动幅度（与评估函数同单位）；blunderRate 是按概率故意走次优着。
//
// medium 的时间上限从 800ms 提到 1200ms 是给探测留的：它的常规搜索本来就被 depth 5
// 卡住（几百毫秒就返回），多出来的预算只有探测会用 —— 而《适情雅趣》那类十三层连杀
// 要 700ms 上下才证得完。hard 的时间上限没动，所以「一步最多等 1.5 秒」仍然成立。
export const LEVELS = [
  { id: 'novice', name: '入门', depth: 1,  timeLimitMs: 200,  quiescence: false, noise: 120, blunderRate: 0.35, checkExtension: 0, mateProbePly: 0,  book: 0.5 },
  { id: 'easy',   name: '初级', depth: 3,  timeLimitMs: 400,  quiescence: false, noise: 60,  blunderRate: 0.15, checkExtension: 0, mateProbePly: 0,  book: 0.7 },
  { id: 'medium', name: '中级', depth: 5,  timeLimitMs: 1200, quiescence: true,  noise: 20,  blunderRate: 0.03, checkExtension: 6, mateProbePly: 13, book: 0.9 },
  { id: 'hard',   name: '高级', depth: 64, timeLimitMs: 1500, quiescence: true,  noise: 0,   blunderRate: 0,    checkExtension: 6, mateProbePly: 15, book: 1 },
];
