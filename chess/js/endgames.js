/**
 * 残局库：**页签表 + 查询入口 + 数据**。这是本模块唯一需要手工维护的数据文件。
 *
 * ## 页签表
 *
 * 界面上的分类页签全部由 `endgameTabs()` 生成 —— 页签名、条数徽标、列表内容都读它，
 * **加一个新页签 = 在 TABS 里加一项**，界面那一侧一行都不用改。
 *
 * 四类：basic 基础杀法 / pawns 兵类残局 / rook 车兵类 / tactics 战术题，
 * 外加 custom（用户存进 localStorage 的局面，数据不在本文件里）。
 *
 * ## result 的可靠性边界（重要，别偷偷放宽）
 *
 * `result` 是 `white | black | draw`（**从先手方也就是白方角度**说的）。
 * 本文件里每条结论都来自**可陈述的定式**，不是「引擎搜了很久看起来是赢」：
 *
 *   - 基础杀法：子力定式（单后 / 单车 / 双车 / 双象 / 马象必胜，单象 / 单马 / 双马不够杀）
 *   - 兵类：方格法则（兵能不能独力升变）、车兵在角上的守和、双联通路兵、
 *     「兵顶住 + 王对王」的死和
 *   - 车兵类：车对车 / 车对单象 / 车对单马是和棋；车 + 通路兵对单王是胜
 *   - 战术题：**强制杀**，由 `tools/gen-solutions.mjs` 的精确杀棋搜索证明，
 *     并由 `tools/verify-endgames.mjs` 逐步复核（先手方取胜 = 那条线走到将死）
 *
 * **刻意不收卢塞纳 / 菲力多尔那类需要表库才能定论的复杂车兵局面**：
 * 它们的胜负要穷举证明（Syzygy 口径），而本模块的引擎做不到 ——
 * 「不编造结论」比「名字好听」重要（见 docs/stockfish.md §3）。
 *
 * ## 加一局 / 加一页的流程
 *
 *   加一局：往对应数组里按格式加一条
 *   加一页：在 TABS 里加一项
 *   两种改完都跑 `node chess/tools/verify-endgames.mjs`（它会连原因一起打出来）
 *   战术题还要跑 `node chess/tools/gen-solutions.mjs local` + `emit` 生成解法
 */

/**
 * 一局的胜负性质，**从先手方（白方）角度**说。界面上显示成
 * 「谱载先手胜 / 先手负 / 和棋」，终局判定也按它比。
 */
export const RESULTS = {
  white: '先手胜',
  draw: '和棋',
  black: '先手负',
};

/** 自定义局面那一页的 id。custom-endgames.js 也用它，别改 */
export const CUSTOM_CATEGORY = 'custom';
export const CUSTOM_SOURCE = '自定义局面';

// ============================================================
// 基础杀法
// ============================================================
const BASIC = [
  {
    id: 'kq-vs-k',
    name: '后对单王',
    fen: '4k3/8/8/8/8/8/8/3QK3 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '子力定式',
    note: '后能把单王挤到边上将死。要点是用后与王的「骑士距离」逼退，别让王靠近后。',
  },
  {
    id: 'kr-vs-k',
    name: '车对单王',
    fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '子力定式',
    note: '用车把王赶到边线，再让自己的王上前「对王」，一步杀。练的是王怎么配合。',
  },
  {
    id: 'krr-vs-k',
    name: '双车对单王',
    fen: '4k3/8/8/8/8/8/8/R3K2R w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '子力定式',
    note: '双车「阶梯」：一个车封住一排，另一个车把王往下压。不需要王的帮助。',
  },
  {
    id: 'kbb-vs-k',
    name: '双象对单王',
    fen: '4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1',
    result: 'white',
    difficulty: 3,
    source: '子力定式',
    note: '两象**异色格**才能把王逼到角上（同色格两象能逼到边但杀不了）。关键是把王往角上赶。',
  },
  {
    id: 'kbn-vs-k',
    name: '马象对单王',
    fen: '4k3/8/8/8/8/8/8/1NB1K3 w - - 0 1',
    result: 'white',
    difficulty: 5,
    source: '子力定式',
    note: '最难的定式杀法，正确走法要几十步。王必须被赶到**与象同色**的角上。',
  },
  {
    id: 'knn-vs-k',
    name: '双马对单王',
    fen: '4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '子力定式',
    note: '双马**不能**强制将死（对方一旦走对就永远等不到杀）。注意它不属于「子力不足自动判和」，' +
      '而是「下不出杀」——本模块只在 K/K、K+单马、K+单象、同色双象时才自动判和。',
  },
  {
    id: 'kb-vs-k',
    name: '单象对单王',
    fen: '4k3/8/8/8/8/8/8/2B1K3 w - - 0 1',
    result: 'draw',
    difficulty: 1,
    source: '子力定式',
    note: '单象控制不到另一色的格子，单王只要往异色格的角上跑就永远等不到杀。',
  },
  {
    id: 'kn-vs-k',
    name: '单马对单王',
    fen: '4k3/8/8/8/8/8/8/2N1K3 w - - 0 1',
    result: 'draw',
    difficulty: 1,
    source: '子力定式',
    note: '马连一步「闲着」都没有：逼到角上时反而是自己先没棋可走（逼和）。',
  },
  {
    id: 'k-vs-k',
    name: '单王对单王',
    fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    result: 'draw',
    difficulty: 1,
    source: '子力定式',
    note: '双方都无法将死 —— 局面一出现就该判「子力不足」。',
  },
];

// ============================================================
// 兵类残局
// ============================================================
const PAWNS = [
  {
    id: 'pawn-runs',
    name: '兵独力升变（方格之外）',
    fen: '7k/8/P7/8/8/8/8/K7 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '方格法则',
    note: '黑王在兵的「方格」之外（从 a6 算，方格是 a6~f6 与 a8~f8），追不上：'
      + 'a7、a8=Q 两步升变。方格法则只需要数格子，不用算。',
  },
  {
    id: 'pawn-caught',
    name: '王在方格里追死兵（和）',
    fen: '8/8/4k3/8/4P3/8/8/7K w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '方格法则',
    note: '白王远在 h1 帮不上忙，黑王就在方格里：e5 也好、等着也好，黑王都能走到兵前面挡住或直接吃掉兵。',
  },
  {
    id: 'rook-pawn-corner',
    name: '车兵被挡在角上（和）',
    fen: 'k7/P7/1K6/8/8/8/8/8 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '教材定式',
    note: 'a 线的兵到了第 7 排、黑王又正好在 a8 角上 —— 这是车兵永远破不了的守和定式。'
      + '白王一动就成逼和（黑王没地方去），所以只能和。',
  },
  {
    id: 'two-connected',
    name: '双联通路兵（胜）',
    fen: '7k/8/2PP4/8/8/8/8/K7 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '教材定式',
    note: '两个并排的通路兵在第 6 排：黑王顾此失彼，无论吃哪一个，另一个两步升变。',
  },
  {
    id: 'king-escorts-pawn',
    name: '王护送兵升变（胜）',
    fen: 'k7/5K2/4P3/8/8/8/8/8 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '教材定式',
    note: '白王顶在兵前面、还替它守住了 e8 的升变格：黑王从 a8 赶过来至少四步，来不及。',
  },
  {
    id: 'locked-pawns',
    name: '兵顶住 + 对王（和）',
    fen: '8/8/4k3/4p3/4P3/4K3/8/8 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '教材定式',
    note: '两个兵在 e4/e5 互相顶死，谁也推不动。想赢只能靠王绕过去吃对方的兵，'
      + '而黑王只要保持「对王」（正对着白王）就永远挡得住。',
  },
];

// ============================================================
// 车兵类
// ============================================================
const ROOK = [
  {
    id: 'rook-and-pawn',
    name: '车 + 通路兵对单王',
    fen: '7k/8/4P3/8/8/8/8/6RK w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '子力定式',
    note: '单车方连吃兵的机会都没有：兵两步升变，黑王从 h8 赶到 e8 要四步。'
      + '车在这里只是保险（防对方的车从背后长将），没有车这个局面也是必胜。',
  },
  {
    id: 'rook-vs-rook',
    name: '车对车（和）',
    fen: '1r5k/8/8/8/8/8/8/R6K w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '子力定式',
    note: '没有兵的时候，车 vs 车 是和棋：只要注意别把自己的车摆在对方车的同一条线上（会被白吃）。'
      + '把车放得离对方王远一点、随时准备将军，就守得住。',
  },
  {
    id: 'rook-vs-bishop',
    name: '车对单象（和）',
    fen: '4k3/3b4/8/8/8/8/8/R3K3 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '子力定式',
    note: '车对单象是公认的和棋：象永远贴着自己的王（这里 d7 的象就有 e8 的王护着），'
      + '车既吃不到它也逼不出杀。',
  },
  {
    id: 'rook-vs-knight',
    name: '车对单马（和）',
    fen: '4k3/4n3/8/8/8/8/8/R3K3 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '子力定式',
    note: '车对单马也是和棋，但比对象难守：马要一直待在王身边（被将军时还得同时看住马）。'
      + '注意本局刻意把马摆在 e7 让王护着 —— 马要是孤零零地摆在外面，车就直接吃掉了。',
  },
  {
    id: 'rook-pawn-7th',
    name: '兵到第 7 排 + 车（胜）',
    fen: '5k2/2PK4/8/8/8/8/8/R7 w - - 0 1',
    result: 'white',
    difficulty: 2,
    source: '教材定式',
    note: '兵已经在第 7 排、白王又守着 c8：c8=Q 直接升变（升变格被王守着，黑王吃不到）。'
      + '车只需要防住对方的车从后面长将 —— 这一局黑方没有车，所以是一步到位。',
  },
];

// ============================================================
// 战术题（结论都是「先手方有强制杀」，解法线由 gen-solutions.mjs 生成）
// ============================================================
const TACTICS = [
  {
    id: 'tac-back-rank-rook',
    name: '底线一步杀（车）',
    fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '构造题',
    note: '黑方三个兵把自家王的退路堵死，车从底线进来就是杀。',
  },
  {
    id: 'tac-back-rank-queen',
    name: '底线一步杀（后）',
    fen: '6k1/5ppp/8/8/8/8/8/4Q1K1 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '构造题',
    note: '和后翼入侵同一课：后走到第 8 排，底线同样是杀。',
  },
  {
    id: 'tac-queen-smother',
    name: '后贴身一步杀',
    fen: '7k/4Q3/5K2/8/8/8/8/8 w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '构造题',
    note: '后走到 g7 贴住王：王吃不到（被自己的王护着），也没有别的格子 —— 杀。'
      + '这一手是「后 + 王 配合」的最小样本。',
  },
  {
    id: 'tac-knight-smother',
    name: '马的闷杀（smothered mate）',
    fen: '6rk/6pp/8/4N3/8/8/8/K7 w - - 0 1',
    result: 'white',
    difficulty: 2,
    source: '构造题',
    note: '王被自己的车和兵围死，马跳进来将军即成杀 —— 马的杀法里最经典的一种。'
      + '（本局黑方子力远多于白方，是纯战术题。）',
  },
  {
    id: 'tac-parallel-rooks',
    name: '双车一步杀（封住第 7 排）',
    fen: '7k/R7/8/8/8/8/8/1R5K w - - 0 1',
    result: 'white',
    difficulty: 1,
    source: '构造题',
    note: '一个车占住第 7 排、另一个车从底线进来：王被压在角上，g7/g8/h7 全被封住。'
      + '双车杀单王的标准手法就是这个 —— 一排一排往下压。',
  },
];

// === 注册表 ===

/** 用户存进 localStorage 的局面。由 main.js 在启动和增删后重新灌进来 */
let customEntries = [];

/** 注册（或替换）自定义局面。`endgames.js` 只存一份引用 */
export function setCustomEndgames(list) {
  customEntries = Array.isArray(list) ? list : [];
}

/** 页签表。**界面上有哪几页只由这里决定** */
export function endgameTabs() {
  return [
    { id: 'basic', label: '基础杀法', entries: BASIC, empty: '这一页还没有局面。' },
    { id: 'pawns', label: '兵类残局', entries: PAWNS, empty: '这一页还没有局面。' },
    { id: 'rook', label: '车兵类', entries: ROOK, empty: '这一页还没有局面。' },
    { id: 'tactics', label: '战术题', entries: TACTICS, empty: '这一页还没有局面。' },
    {
      id: CUSTOM_CATEGORY,
      label: '自定义',
      entries: customEntries,
      empty: '还没有存过局面。标题右边的「保存 / 导入」可以把当前局面收进来。',
    },
  ];
}

/** 全部局面（内置 + 自定义），**补上 category** —— 校验脚本与离线工具用它 */
export function allEndgames() {
  return endgameTabs().flatMap((tab) => tab.entries.map((e) => ({ ...e, category: tab.id })));
}

/** 某一页的局面。返回的是**补上 category 的副本** */
export function endgamesByCategory(id) {
  const tab = endgameTabs().find((t) => t.id === id);
  if (!tab) return [];
  return tab.entries.map((e) => ({ ...e, category: tab.id }));
}

/** 按 id 找一局；找不到返回 null */
export function findEndgame(id) {
  if (!id) return null;
  for (const tab of endgameTabs()) {
    const found = tab.entries.find((e) => e.id === id);
    if (found) return { ...found, category: tab.id };
  }
  return null;
}
