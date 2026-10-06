/**
 * **棋力尺子的局面集**（数据，不参与网页运行）—— 冻结在这里，供 `tools/strength.mjs` 取用。
 *
 * ## 为什么要有这个文件
 *
 * 尺子原来只有一组局面：从开局谱里扫出来的 4~8 半回合局面 + 一个★回归局面。
 * 那里**评估说了算、深度体现不出来**，而且全混在一个平均数里 ——
 * 任何改进都会被平均掉（`docs/future-work.md` C1 的教训：判据选错，努力全白费）。
 * 于是把局面集拆成**带标签的几组**，尺子**按组分报**：
 *
 * | 组 | 是什么 | 谁关心 |
 * |---|---|---|
 * | `opening` | 开局谱里的安静局面（**不在这里**，由 `strength.mjs` 从 `js/openings-generated.js` 现扫） | 评估的「开局不犯傻」 |
 * | `middlegame` | 引擎自对弈走出来的中局（子力 8~12 个大子，有接触、有战术） | 评估 + 深度都说了算 |
 * | `endgame` | 同一条自对弈里走到子力 ≤ 6 大子的局面 | 残局位置表、相位权重 |
 * | `regression` | **历史上踩过的坑**（★那盘 炮5进4 等五个漏着） | 「修好没」—— 最硬的判据 |
 *
 * ## 中局 / 残局这两组是怎么来的
 *
 * 2026-10-06 用 `tmp/gen-strength-positions.mjs` 采集（一次性脚本，在 `tmp/` 里）：
 * 从 `js/openings-generated.js` 的**深处**挑 12 个局面当种子（谱是 BFS 展开的，越靠后越深），
 * 每个种子让 **Pikafish（depth 14、4 线程）自对弈 36 个半回合**，沿途每 2 个半回合抽一个局面。
 * 抽的时候只用本模块的规则层复核（着法必须在 `generateLegalMoves` 里 ——
 * 非法局面会让 Pikafish 直接卡住不回复，见 `future-work.md` 的坑 1），并**剔掉**：
 *
 *   - 一面倒的局面（|裁判分| > 600）—— 那里不管怎么走都是同一个结果，量不出东西；
 *   - 已经分出胜负的（mate 分）—— 损失会变成 ±9000 的二元量，污染均值。
 *
 * 采到 194 个候选，**均匀抽样**成这里这 20 + 10 个（每个局面在尺子上要花
 * 1.5 秒搜索 + 两次 depth 16 判分，取多了跑一次要十几分钟）。
 * 抽样是「按候选序号等距取」，没有人工挑选 —— 免得无意中把「模块恰好走得好的局面」挑进来。
 *
 * **这几个数字不是断言、只是线索**（`big` = 车马炮总数；`score` = 采集时 Pikafish depth 14
 * 对**走子方**的评分，用来确认这局面是均势）：
 *
 * ## 怎么用
 *
 *   node chinese-chess/tools/strength.mjs --set middlegame
 *   node chinese-chess/tools/strength.mjs --set endgame,regression
 *   node chinese-chess/tools/strength.mjs --set all
 *
 * **不要**在这里手改 FEN 去「调一调局面」—— 想换局面就重跑采集脚本、重新抽样，
 * 否则这一组就不再是「引擎自己走出来的」了。
 */

/** 中局：引擎自对弈走到子力还很足的局面（大子 8~12），有接触、有战术 */
export const MIDDLEGAME = [
  { id: '中#1', big: 7, movesInto: 28, score: 13, fen: '1nbak4/4a1c2/4bC3/p1C1p3p/9/2Pn1N3/P3P3P/N8/9/2BAKAB2 b - - 0 1' },
  { id: '中#2', big: 8, movesInto: 28, score: 37, fen: '2b1kab2/4a4/n3c4/C1p1C1R1p/3r2p2/2P6/P3P1P1P/6N2/4A4/1cBAK1B2 b - - 0 1' },
  { id: '中#3', big: 8, movesInto: 30, score: 40, fen: '2b1kab2/4a4/n2cc4/2p3R2/p7p/2P3p2/P3P3P/2NCB1Nr1/4A4/2BAK4 b - - 0 1' },
  { id: '中#4', big: 8, movesInto: 24, score: 3, fen: '3rkabn1/2c1a4/4b4/p3p1p1p/3n5/2pN2P2/P3P3P/4B1N2/1R4C2/2BAKA3 w - - 0 1' },
  { id: '中#5', big: 8, movesInto: 22, score: -3, fen: '2bakab2/7r1/2n1c4/p1p1p4/8p/2PN1n3/P3P3P/1C2B2N1/5R3/2BAKA3 b - - 0 1' },
  { id: '中#6', big: 9, movesInto: 28, score: 0, fen: '2baka3/9/n2cb1n2/2p1p3p/7R1/9/2P1P2cP/N2CB3C/5N3/2BAKA3 b - - 0 1' },
  { id: '中#7', big: 10, movesInto: 28, score: -19, fen: '4kab2/4a4/b1n1c1n2/pRC1p4/3r4p/P1P3B2/4Pc2P/C1N1B1N2/4A4/3AK4 w - - 0 1' },
  { id: '中#8', big: 10, movesInto: 18, score: 4, fen: '2b1kabr1/4a1c2/3rc3n/p1p1C1p2/5R2p/5NP2/P1P1P3P/4B4/4A4/1NBAK3R b - - 0 1' },
  { id: '中#9', big: 10, movesInto: 20, score: 40, fen: '2b1kab2/4a4/n1c1c1n2/p1pCN1R1p/1r4p2/2P6/P3P1P1P/B3C1N2/9/3AKAB2 b - - 0 1' },
  { id: '中#10', big: 10, movesInto: 26, score: 0, fen: '2baka3/9/n2cb1n2/2p1p3p/6r2/7R1/2P1P2cP/N2CB3C/5N3/2BAKA3 b - - 0 1' },
  { id: '中#11', big: 10, movesInto: 24, score: 0, fen: '3akab2/1r1n5/4c1n2/p3p3p/1Cp1P1b2/9/P1P5P/2N1C2r1/3R5/1RBAKAB2 b - - 0 1' },
  { id: '中#12', big: 12, movesInto: 8, score: 6, fen: 'r1baka1r1/9/1cn1b1n2/p3p1p1p/2p4c1/2P4R1/P3P1P1P/N2CC1N2/9/R1BAKAB2 b - - 0 1' },
  { id: '中#13', big: 12, movesInto: 34, score: 4, fen: 'r1b1ka3/4a4/3cb1n2/4p1p1p/pn3r3/1R4P2/P3P1c1P/N1C1BCN2/1R7/2BAKA3 b - - 0 1' },
  { id: '中#14', big: 12, movesInto: 4, score: 11, fen: 'r1b1kab1r/4a4/2n1cc2n/p1p1p1pCp/9/6P2/P1P1P3P/4C1N2/5R3/1NBAKAB1R b - - 0 1' },
  { id: '中#15', big: 12, movesInto: 6, score: 43, fen: '2bakab1r/9/n1c1c1n2/p1p1p1p1p/1r7/2PN5/P3P1P1P/1C2C1N2/9/1RBAKABR1 b - - 0 1' },
  { id: '中#16', big: 12, movesInto: 8, score: 7, fen: '1rbakabr1/9/n2c2nc1/p1p1p3p/6p2/P8/2P1P1P1P/N2C2N1C/R8/2BAKABR1 b - - 0 1' },
  { id: '中#17', big: 12, movesInto: 8, score: 2, fen: 'r3kabr1/4a4/1cn1b3n/p3p1p1p/2p6/6P2/P1P1P2cP/1CN1BCN2/R8/2BAKA1R1 w - - 0 1' },
  { id: '中#18', big: 12, movesInto: 16, score: 33, fen: 'rn1akab2/2r6/1c2bc3/p3p3p/2P2Rpn1/9/P2CP3P/1CN3N2/R8/2BAKAB2 b - - 0 1' },
  { id: '中#19', big: 12, movesInto: 10, score: 6, fen: '1r1akabr1/3n5/3cb1nc1/p3p3p/1Cp3p2/4P1P2/P1P1N3P/2N1C4/9/1RBAKAB1R b - - 0 1' },
  { id: '中#20', big: 12, movesInto: 6, score: 0, fen: 'r1bakabnr/9/2n1c4/p1p1p1p1p/4c4/9/P1P1N1P1P/1C2C1N2/4A3R/R1B1KAB2 b - - 0 1' },
];

/** 残局：同一条自对弈里走到子力 ≤ 6 个大子的局面（相位权重与残局位置表说了算） */
export const ENDGAME = [
  { id: '残#1', big: 4, movesInto: 30, score: 1, fen: '4kab2/4a1c2/4b4/p1p1r1p2/8p/4R1P2/P1P1P3P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#2', big: 4, movesInto: 36, score: 0, fen: '3akab2/6c2/4b4/p4rp2/2p5R/4P1P2/P1P5P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#3', big: 6, movesInto: 30, score: 14, fen: '1nbak4/6c2/4ba3/p3p3C/9/2Pn1N3/P3P3P/N8/9/2BAKAB2 b - - 0 1' },
  { id: '残#4', big: 6, movesInto: 36, score: 34, fen: '2b1kab2/4a4/n3c4/1R6C/3r2p2/1p7/P3P1P1P/6N2/4A4/2BAK1B2 b - - 0 1' },
  { id: '残#5', big: 6, movesInto: 32, score: 2, fen: '4kabn1/2c1a4/4b4/p5p1p/9/2Br1NP2/P3P3P/9/1R4C2/2BAKA3 w - - 0 1' },
  { id: '残#6', big: 6, movesInto: 32, score: 1, fen: '2bakab2/9/2n6/p1p1p4/4n3p/2P5P/P3r4/3CB2N1/4AR3/2BAK4 b - - 0 1' },
  { id: '残#7', big: 6, movesInto: 16, score: -1, fen: '2baka1nr/9/2n1b4/p1p3p1p/4p4/9/P1P1N1P1P/B5N2/4A2R1/4KAB2 b - - 0 1' },
  { id: '残#8', big: 6, movesInto: 24, score: 0, fen: '2baka2r/9/2n1b4/p3n1p1p/2p1N4/4p2R1/P1P3P1P/B5N2/4A4/4KAB2 b - - 0 1' },
  { id: '残#9', big: 6, movesInto: 30, score: -4, fen: '2bakr3/4a4/2n1b4/p3n3p/2p1N1P2/4R4/P1P5P/B5N2/4A4/4KAB2 b - - 0 1' },
  { id: '残#10', big: 6, movesInto: 36, score: 0, fen: '2bak4/4a4/2n1b4/p5N1p/2p1N1n2/5r3/P1P1R3P/B8/4A4/4KAB2 b - - 0 1' },
];

/**
 * **回归集：历史上量出来的五个漏着局面。**
 *
 * 这五个是 2026-10-05/06 那两轮尺子报出来的最差着法（`docs/future-work.md` C2 有记录）：
 * 四个是**炮的着法**（往前顶 / 横向挪），模块自评 +60/+88，裁判（Pikafish depth 16）
 * 认为亏 111~428cp，而且一律推荐**最简单的出子**。
 *
 * 它们曾经被混在 30 个局面里只体现成一个平均数，所以「修好了没有」根本看不出来。
 * 现在单独成组：**尺子会逐个列出模块这一手与裁判首选是否一致（✅ / ❌）** ——
 * 这是比任何平均数都硬的一条判据（见 `docs/decisions.md` 第 20 条）。
 *
 * `wasMove` / `loss` 是**历史记录**（当时它走的是什么、亏多少），只作对照，不是断言。
 */
export const REGRESSION = [
  { id: '★用户那盘', wasMove: '炮5进4', loss: 425,
    fen: 'rnbakabnr/9/1c2c4/p1p1C1p1p/9/9/P1P1P1P1P/7C1/9/RNBAKABNR b - - 0 1' },
  { id: '炮五平七 #1', wasMove: '炮五平七', loss: 156,
    fen: '1rbakabnr/9/1cn4c1/p1p1p1p1p/9/9/P1P1P1P1P/4CC3/9/RNBAKABNR w - - 0 1' },
  { id: '炮五平七 #2', wasMove: '炮五平七', loss: 127,
    fen: '1nbakab1r/r8/4c1nc1/p1p1p1p1p/9/2P6/P3P1P1P/4C1NC1/9/RNBAKAB1R w - - 0 1' },
  { id: '炮九进四', wasMove: '炮九进四', loss: 112,
    fen: '1rbakabnr/9/1cn4c1/p1p1p3p/6p2/9/P1P1P1P1P/C1N1C4/9/R1BAKABNR w - - 0 1' },
  // ⚠️ 这一条的 FEN **修过一次**：当年它在 tmp/xq-deep.mjs 里是手抄的，
  // 红方底线写成了 `R1NBAKABNR` —— 那是 **10 格**，不是 9 格的一个非法局面。
  // 本模块的 parseFen 不校验列数、照样能搜，所以「111cp」是在一个**错位**的局面上量出来的。
  // 这里换成生成谱里的真身（`R1BAKABNR`，与上一条同一批扫描出来的）。
  // 尺子开头那道 FEN 自检就是为了拦住这类东西（非法局面还会让 Pikafish 直接卡住）。
  { id: '炮二平三', wasMove: '炮二进四', loss: 111,
    fen: '1rbakabnr/9/2n1c2c1/p1p1p1p1p/9/2P6/P3P1P1P/2N1C2C1/9/R1BAKABNR w - - 0 1' },
];
