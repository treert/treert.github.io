/**
 * **棋力仪器的局面集**（数据 + 取法，不参与网页运行）。
 *
 * 文件分两半：下面三组**冻结的数据**，以及文件末尾的 `strengthPositions()` ——
 * 「这批局面怎么取」的**唯一一份实现**。`tools/strength.mjs`（棋力尺子）与
 * `tools/move-diff.mjs`（着法对照）都从它取局面：**两把仪器必须跑同一批局面**，
 * 否则一边说「变好了」另一边说「没变」，谁也说不清。取法只留这一份，
 * 与 `js/iccs.js` 「换算只该有一份」是同一个理由。
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
 * 从 `js/openings-generated.js` 的**深处**挑若干局面当种子（谱是 BFS 展开的，越靠后越深），
 * 每个种子让 **Pikafish（depth 14、4 线程）自对弈**，沿途每 2 个半回合抽一个局面。
 * 抽的时候只用本模块的规则层复核（着法必须在 `generateLegalMoves` 里 ——
 * 非法局面会让 Pikafish 直接卡住不回复，见 `future-work.md` 的坑 1），并**剔掉**：
 *
 *   - 一面倒的局面（|裁判分| > 600）—— 那里不管怎么走都是同一个结果，量不出东西；
 *   - 已经分出胜负的（mate 分）—— 损失会变成 ±9000 的二元量，污染均值。
 *
 * **采过两批（同一批数据两次扩充，不是重新取）**：
 *
 * | | 种子 | 每盘手数 | 候选 |
 * |---|---|---|---|
 * | 第一批（2026-10-06 上午） | 12 | 36 | 194（中 164 / 残 30） |
 * | 第二批（同日，为**扩大局面集**） | 32 + 16 | 28 / 40 | 703（中 680 / 残 47） |
 *
 * 第一批的 20 + 10 个**原封不动留在前面**（早期那些测量是在它们上面做的，
 * 换掉就没法比了）；第二批只**追加**，并且**每盘对局最多取 1~2 个**
 * （按 `movesInto` 回到 4 切分对局）—— 同一盘相邻两手高度相关，
 * 直接抽进来会让「局面数」虚高。现在中局 100 个、残局 40 个。
 *
 * 加上从生成谱现扫的 `opening`（`--n` 可以放大到全部 124 个）与 5 个`regression`，
 * `--set all --n 300` 一共 **269 个局面** —— 这是 2026-10-06 后半段为了「量得动」
 * 专门扩的：65 个局面时，一个改动的差异常常只来自 1~2 个局面（见 `decisions.md` 第 24 条）。
 *
 * **这几个数字不是断言、只是线索**（`big` = 车马炮总数；`score` = 采集时 Pikafish depth 14
 * 对**走子方**的评分，用来确认这局面是均势）：
 *
 * ## 怎么用
 *
 * 直接用（走 `strengthPositions()` 的）是这两把仪器，不用手动 import 这个文件：
 *
 *   node chinese-chess/tools/strength.mjs --set middlegame
 *   node chinese-chess/tools/strength.mjs --set endgame,regression
 *   node chinese-chess/tools/strength.mjs --set all
 *   node chinese-chess/tools/move-diff.mjs dump --out tmp/a.json
 *
 * **不要**在这里手改 FEN 去「调一调局面」—— 想换局面就重跑采集脚本、重新抽样，
 * 否则这一组就不再是「引擎自己走出来的」了。
 *
 * 注意 `--n` 是**每组**取多少个（默认 30）：局面集扩大之后，
 * `--set middlegame` 取的是**前 30 个**（前 20 个与旧基线完全相同）；
 * 想全用上就 `--n 300`（`--set all` 一共 269 个）。
 */
import { CELLS, EMPTY } from '../js/config.js';
import { parseFen } from '../js/position.js';
import { generateMoves } from '../js/rules.js';
import { GENERATED_TREE } from '../js/openings-generated.js';

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
  { id: '中#21', big: 7, movesInto: 34, score: 38, fen: '2b1kab2/4a4/n3c4/CR6p/3r2p2/1Cp6/P3P1P1P/6N2/4A4/2BAK1B2 b - - 0 1' },
  { id: '中#22', big: 7, movesInto: 30, score: 0, fen: '2bakab2/9/2n6/p1p1p4/4n3p/2P6/P3N2rP/3CB2N1/4AR3/2BAK4 b - - 0 1' },
  { id: '中#23', big: 8, movesInto: 22, score: 0, fen: '2b1kab2/4a1c2/3rc4/p1p1C1p2/7np/5NP2/P1P1P3P/4B4/4A4/1NBAKR3 b - - 0 1' },
  { id: '中#24', big: 8, movesInto: 22, score: 33, fen: '2b1kab2/4a4/n1c1c4/p1pCC1R1p/1r4p2/2P6/P3P1P1P/B5N2/9/3AKAB2 b - - 0 1' },
  { id: '中#25', big: 8, movesInto: 20, score: 45, fen: '2b1kab2/4a4/n2cc4/2p1C1p2/p6rp/2P2RP2/P3P3P/2N3N2/4A4/2BAK1B2 b - - 0 1' },
  { id: '中#26', big: 8, movesInto: 30, score: 0, fen: '2baka3/9/n2cb4/2p1p3C/7n1/9/2P1P2cP/N2CB4/5N3/2BAKA3 b - - 0 1' },
  { id: '中#27', big: 8, movesInto: 22, score: 2, fen: '3rkabn1/2c1a4/4b4/p3p1p1p/2pn5/6P2/P3P3P/2N1B1N2/1R4C2/2BAKA3 w - - 0 1' },
  { id: '中#28', big: 8, movesInto: 18, score: 1, fen: '2bakab2/r8/2n3c2/p1p1p4/8p/2PN1nB2/P3P3P/1C5N1/R8/2BAKA3 b - - 0 1' },
  { id: '中#29', big: 8, movesInto: 12, score: 1, fen: '2baka1nr/9/2n1b4/p1p1p1p1p/9/9/P1P1N1P1P/1r4N2/4A2R1/R1B1KAB2 b - - 0 1' },
  { id: '中#30', big: 9, movesInto: 20, score: 4, fen: '2b1kab2/4a1c2/3rc3n/p1p1C1p2/7Rp/5NP2/P1P1P3P/4B4/4A4/1NBAK3R b - - 0 1' },
  { id: '中#31', big: 9, movesInto: 16, score: 1, fen: '2bakab2/r8/1cn3C2/p1p1p4/8p/2P2nB2/P3P3P/1CN4N1/R8/2BAKA3 b - - 0 1' },
  { id: '中#32', big: 9, movesInto: 10, score: -1, fen: '2bakabnr/9/2n1C4/p1p1p1p1p/9/9/P1P1N1P1P/1r4N2/4A3R/R1B1KAB2 b - - 0 1' },
  { id: '中#33', big: 10, movesInto: 8, score: 17, fen: 'r1b1kabr1/4a4/4cc2n/p1p1C1p1p/9/6P2/P1P1P3P/6N2/5R3/1NBAKAB1R b - - 0 1' },
  { id: '中#34', big: 10, movesInto: 16, score: 14, fen: '1nbak3r/c3a4/4bcn2/p1p1p3p/6p2/2P3PR1/P3P3P/N1C3N1C/9/2BAKAB2 b - - 0 1' },
  { id: '中#35', big: 10, movesInto: 12, score: 32, fen: '2bakab2/3C5/n1c1c1n2/p1p1p1p1p/9/2PN5/P3P1P1P/B3C1N2/9/1r1AKABR1 b - - 0 1' },
  { id: '中#36', big: 10, movesInto: 12, score: 42, fen: '2bakab2/9/n2cc1n2/pCp1p1p1p/7r1/2P3P2/P3P3P/2N1C1N2/5R3/2BAKAB2 b - - 0 1' },
  { id: '中#37', big: 10, movesInto: 14, score: 17, fen: 'r3kabn1/4a4/1c2b4/p3p1p1p/2pn5/6P2/P1c1P3P/2N1BCN2/R5C2/2BAKA3 w - - 0 1' },
  { id: '中#38', big: 10, movesInto: 18, score: 0, fen: '1r1akabr1/3n5/4c1n2/p3p3p/1Cp1P1b2/9/P1P5P/2N1C4/8R/1RBAKAB2 b - - 0 1' },
  { id: '中#39', big: 10, movesInto: 14, score: -4, fen: '2bakab2/r8/1cn3c2/p1p1p4/7np/2P3B2/P3P3P/1CN3CN1/R8/2BAKA3 b - - 0 1' },
  { id: '中#40', big: 11, movesInto: 14, score: 25, fen: '1Rbak3r/c3a4/2n1bcn2/p1p1p3p/6p2/2P4R1/P3P1P1P/N1C3N1C/9/2BAKAB2 b - - 0 1' },
  { id: '中#41', big: 11, movesInto: 12, score: -3, fen: '2bakab2/r8/1cn3c1n/p1p1p4/7Rp/2P3B2/P3P3P/1CN3C2/R4N3/2BAKA3 b - - 0 1' },
  { id: '中#42', big: 11, movesInto: 8, score: 0, fen: '1rbakabnr/9/2n1c4/p1p1p1p1p/4C4/9/P1P1N1P1P/1C4N2/4A3R/R1B1KAB2 b - - 0 1' },
  { id: '中#43', big: 12, movesInto: 4, score: 3, fen: 'r1bakabr1/9/1cn3nc1/p3p1p1p/2p6/9/P1P1P1P1P/N2CC1N2/9/R1BAKABR1 b - - 0 1' },
  { id: '中#44', big: 12, movesInto: 4, score: -28, fen: '1rbakab1r/9/2n1c2cn/p1p1p1p1p/9/6P2/P1P1P3P/1CN3NC1/9/1RBAKAB1R w - - 0 1' },
  { id: '中#45', big: 12, movesInto: 6, score: 20, fen: 'r1b1kabr1/4a4/2n1cc2n/p1p1C1p1p/9/6P2/P1P1P3P/4C1N2/5R3/1NBAKAB1R b - - 0 1' },
  { id: '中#46', big: 12, movesInto: 4, score: 34, fen: '1rbakabnr/7R1/c1n2c3/p1p1p1p1p/9/2P6/P3P1P1P/1C4N1C/9/RNBAKAB2 b - - 0 1' },
  { id: '中#47', big: 12, movesInto: 4, score: 34, fen: '1rbakab1r/9/n1c1c1n2/p1p1p1p1p/9/2P6/P3P1P1P/1CN1C1N2/9/1RBAKABR1 b - - 0 1' },
  { id: '中#48', big: 12, movesInto: 4, score: 27, fen: 'r1bakabr1/9/n2cc1n2/pCp1p1p1p/9/2P3P2/P3P3P/2N1C1N2/9/R1BAKAB1R b - - 0 1' },
  { id: '中#49', big: 12, movesInto: 4, score: 5, fen: '1rbakabnr/9/n2c3c1/p1p1p3p/6p2/P8/2P1P1P1P/N2C2N1C/9/R1BAKAB1R b - - 0 1' },
  { id: '中#50', big: 12, movesInto: 4, score: 1, fen: 'r2akabr1/9/1cn1b2cn/p3p1p1p/2p6/9/P1P1P1P1P/1CN2CN2/R8/2BAKABR1 w - - 0 1' },
  { id: '中#51', big: 12, movesInto: 4, score: 19, fen: 'rn1akab2/8r/1c2b1nc1/p1p1p3p/6p2/2P6/P3P1P1P/1CNC2N2/9/R1BAKABR1 b - - 0 1' },
  { id: '中#52', big: 12, movesInto: 4, score: 1, fen: 'r2akabnr/3n5/1C1cb2c1/p3p3p/2p3p2/4P4/P1P1N1P1P/2N4C1/9/1RBAKAB1R b - - 0 1' },
  { id: '中#53', big: 12, movesInto: 4, score: -3, fen: 'rnbakabr1/9/1c4c1n/p1p1p3p/9/2P3B2/P3P3P/1CN4C1/5N3/R1BAKA2R b - - 0 1' },
  { id: '中#54', big: 12, movesInto: 4, score: -2, fen: 'rnbakabnr/9/4c4/p1p1p1p1p/4c4/9/P1P3P1P/1CN1C1N2/4A3R/R1B1KAB2 b - - 0 1' },
  { id: '中#55', big: 8, movesInto: 22, score: -6, fen: '2baka1r1/7r1/4b1cc1/p3p3p/2p2N3/3N1R3/P3P3P/B8/9/3AKABR1 b - - 0 1' },
  { id: '中#56', big: 8, movesInto: 26, score: -4, fen: '2bakab2/9/2n1c4/p1pC1np1p/4p4/2P3P2/P3Pc2P/2N1B1C2/9/2BAKA1N1 b - - 0 1' },
  { id: '中#57', big: 8, movesInto: 26, score: -1, fen: '2bakab2/c8/1Rn5r/p3p3p/6p2/2PN5/P3c1P1P/2C4C1/9/2BAKAB2 b - - 0 1' },
  { id: '中#58', big: 8, movesInto: 28, score: -12, fen: '2baka3/9/c1c1b3n/p3p4/2r6/3R1N2p/P3P4/4B2C1/9/1N1AKAB2 w - - 0 1' },
  { id: '中#59', big: 8, movesInto: 24, score: -121, fen: '2bak1b2/4a4/n5n2/p3c1p1p/2pNR4/6P2/P1P1Pr2P/B1N1C4/9/3AKAB2 w - - 0 1' },
  { id: '中#60', big: 8, movesInto: 22, score: 5, fen: '2bakab2/9/n5n2/p1p1p3p/6p2/P2R5/2P1c1P1P/N2CBr3/4A4/2B1KA1N1 b - - 0 1' },
  { id: '中#61', big: 8, movesInto: 28, score: -21, fen: '1c2kab2/3na1c2/4b3n/p3C1p2/2p5p/4P1P2/P1P5P/2NCB4/9/2BAKA1N1 w - - 0 1' },
  { id: '中#62', big: 8, movesInto: 20, score: -35, fen: '2rakab2/3n1r3/3C2n2/p3p3p/2b3p2/7R1/P3P1P1P/B5N2/3R5/3AKAB2 w - - 0 1' },
  { id: '中#63', big: 8, movesInto: 24, score: 29, fen: '2ba1k3/4an3/1c2b1c2/pR1C2p1p/2p4r1/6P2/P1P1P3P/C1N1B4/9/2BAKA3 b - - 0 1' },
  { id: '中#64', big: 8, movesInto: 18, score: 1, fen: 'r1bakabn1/9/1c7/p7p/1np1p1p2/9/P1P1N1P1P/2N5C/9/R1BAKAB2 w - - 0 1' },
  { id: '中#65', big: 8, movesInto: 14, score: -16, fen: '2bakabn1/9/n3c4/p1p1p3p/6p2/2P6/P2cP1P1P/C5N1C/9/1NBAKAB2 w - - 0 1' },
  { id: '中#66', big: 9, movesInto: 20, score: -8, fen: '2baka1r1/7r1/1c2b1Cc1/p3p3p/2p6/3N1R3/P3P1N1P/B8/9/3AKABR1 b - - 0 1' },
  { id: '中#67', big: 9, movesInto: 22, score: -119, fen: '1nbak1b2/4a4/6n2/p3c1p1p/2pNc2R1/6P2/P1P1Pr2P/B1N1C4/9/3AKAB2 w - - 0 1' },
  { id: '中#68', big: 9, movesInto: 22, score: -20, fen: '4kab2/9/c1n2a2n/p1p1p3p/1r4b2/2P2N3/P3P3P/1CNr5/9/1RBAKAB2 w - - 0 1' },
  { id: '中#69', big: 9, movesInto: 18, score: -36, fen: '2rakab2/3n4r/3C2n2/p3p3p/2b3p2/7R1/P3P1P1P/c5N2/3R5/2BAKAB2 w - - 0 1' },
  { id: '中#70', big: 9, movesInto: 24, score: -27, fen: '1n1ak1b2/4a4/4b3n/p2rp1p1p/2p1cr3/6P1P/P1P6/B1N1C2C1/4A4/3RKAB2 w - - 0 1' },
  { id: '中#71', big: 10, movesInto: 16, score: -15, fen: 'r1baka1r1/9/1c2b1nc1/p3p3p/2p6/5R3/P3P1N1P/B1N3C2/9/3AKABR1 b - - 0 1' },
  { id: '中#72', big: 10, movesInto: 8, score: -5, fen: '2bakabr1/9/2n1c1c1n/p1p1p1p1p/9/2P3P2/P3P3P/3CB2C1/5N3/1NBAKA2R b - - 0 1' },
  { id: '中#73', big: 10, movesInto: 18, score: 19, fen: '2bakabr1/9/2n1c1n2/p3p1C1p/5R3/2p3P2/P1c1P3P/4C1N1B/9/1NBAKA3 b - - 0 1' },
  { id: '中#74', big: 10, movesInto: 28, score: -86, fen: '3ak1b2/4a1r2/b1n1cc2n/p1C5p/2p1pN3/1R6P/P1P1P4/2N1B3C/9/3AKAB2 w - - 0 1' },
  { id: '中#75', big: 10, movesInto: 24, score: -22, fen: '1rbak1b2/4ac3/2P5n/pC1Np3p/9/6pr1/P3P3P/2N1C4/6c2/1RBAKAB2 b - - 0 1' },
  { id: '中#76', big: 10, movesInto: 28, score: 10, fen: '2b1kabr1/9/3acR3/p3p3p/2p3p2/9/P3P1PcP/Nr3CnRC/9/2BAKAB2 b - - 0 1' },
  { id: '中#77', big: 10, movesInto: 14, score: 35, fen: '2bakab2/r8/2nc2nc1/p3p3p/2p3p2/PN5R1/2P1P1P1P/1C4N1C/9/2BAKAB2 b - - 0 1' },
  { id: '中#78', big: 10, movesInto: 18, score: 32, fen: '2bakabr1/c8/2n6/p1N1p3p/5np2/2P6/P3P1PcP/2C3N1C/1R7/2BAKAB2 b - - 0 1' },
  { id: '中#79', big: 10, movesInto: 22, score: -5, fen: '1rbakabr1/7c1/c5n2/p3p1R1p/9/5N3/P3P3P/2N1C4/9/R1BAKAB2 b - - 0 1' },
  { id: '中#80', big: 10, movesInto: 22, score: -15, fen: '2baka3/9/c1n1b1c1n/p3p4/2p3r1p/2PR1N2P/P3P4/C3B2C1/9/1N1AKAB2 w - - 0 1' },
  { id: '中#81', big: 10, movesInto: 10, score: -96, fen: '1nbak1br1/4a4/2c1c1n2/p1p3p1p/4C4/9/P1P1P1P1P/2N1C1N2/9/2BAKAB1R w - - 0 1' },
  { id: '中#82', big: 10, movesInto: 18, score: -1, fen: '2b1kabr1/4a4/n2c2n2/p3p3p/2P3r2/5N3/P3P3P/2C1B3R/R8/1C1AKAB2 b - - 0 1' },
  { id: '中#83', big: 10, movesInto: 18, score: 0, fen: '2b1kab2/4a4/n2c1cn2/2p1p1p1p/p2r5/1RP3P1P/P3P4/C1N1B3C/4A4/4KABN1 b - - 0 1' },
  { id: '中#84', big: 10, movesInto: 14, score: -30, fen: '1nbakab2/5r3/2c1c1n2/p3p3p/2p3P2/2PN5/P3P3P/3CBC3/5N3/2BAKA2R b - - 0 1' },
  { id: '中#85', big: 10, movesInto: 16, score: 6, fen: '2bakabr1/9/n5n2/p1p1p3p/5rp2/P2R5/2P1P1PcP/N2C2N2/9/2BAKABR1 b - - 0 1' },
  { id: '中#86', big: 10, movesInto: 8, score: 12, fen: 'r2akabn1/9/1cn1b3c/p1C1p3p/6p2/2P6/P3P1P1P/1CN3N2/9/R1BAKAB2 b - - 0 1' },
  { id: '中#87', big: 10, movesInto: 24, score: -10, fen: 'r3kab2/4a4/c3b2c1/N2rn2Rp/4p1p2/2B6/P3P1P1P/C5N2/9/1R1AKAB2 b - - 0 1' },
  { id: '中#88', big: 10, movesInto: 14, score: -30, fen: '1r2kab2/3r5/c1n1ba2n/p1p1p1p1p/9/2P2NP2/P3P3P/1CN6/9/1RBAKABR1 w - - 0 1' },
  { id: '中#89', big: 10, movesInto: 16, score: 11, fen: 'rn1akabr1/9/4b4/p3p3p/2P2R3/6p2/P3P2cP/1Cc3C1N/9/2BAKABR1 b - - 0 1' },
  { id: '中#90', big: 10, movesInto: 16, score: -30, fen: '2rakab2/3n4r/2C3n2/p3p3p/2b3p2/7R1/P3P1P1P/N5Nc1/3R5/2BAKAB2 w - - 0 1' },
  { id: '中#91', big: 10, movesInto: 10, score: 9, fen: 'r2akab1r/3n5/1C1cb2c1/p3p3p/2p3P2/4P4/P1P1N3P/7C1/9/1RBAKAB1R b - - 0 1' },
  { id: '中#92', big: 10, movesInto: 28, score: 9, fen: '3ckab2/4a4/1r2bcn2/p3R2rp/6p2/3N4P/P3P1P2/1R2BC2N/4A4/4KAB2 b - - 0 1' },
  { id: '中#93', big: 10, movesInto: 10, score: 36, fen: '2bak1bnr/4ar3/1c4c2/p3C1p1p/2p6/6P2/P1P1P3P/C1N6/9/R1BAKAB1R b - - 0 1' },
  { id: '中#94', big: 10, movesInto: 16, score: 0, fen: 'r1bakabn1/9/1c7/p3p3p/1np1c1p2/9/P1P1N1P1P/2N1C3C/9/R1BAKAB2 w - - 0 1' },
  { id: '中#95', big: 10, movesInto: 12, score: -28, fen: '1n1akab2/r4r3/4b3n/p1p1p1p1p/4c4/8P/P1P3P1R/2N1C2C1/4A4/R1B1KAB2 w - - 0 1' },
  { id: '中#96', big: 10, movesInto: 16, score: 0, fen: '1nbakab2/r8/2c3P2/p1p1p3p/4c4/2P2r2P/P7R/1C2B2C1/4A4/RN2KAB2 b - - 0 1' },
  { id: '中#97', big: 10, movesInto: 10, score: -19, fen: '2bakab1r/9/n3c1n2/p1p1p3p/6p2/2P6/P2cP1P1P/C5N1C/9/1NBAKABR1 w - - 0 1' },
  { id: '中#98', big: 11, movesInto: 20, score: 22, fen: '1rb1kabr1/4a4/4c1R2/p2Pp3p/2pn2p2/9/P3P1PcP/N1C3N1C/9/2BAKABR1 b - - 0 1' },
  { id: '中#99', big: 11, movesInto: 12, score: 36, fen: '2bakab2/r8/2ncc1nR1/p3p3p/2p3p2/PN7/2P1P1P1P/1C4N1C/7R1/2BAKAB2 b - - 0 1' },
  { id: '中#100', big: 11, movesInto: 12, score: -33, fen: '1Rbakab2/5r3/n1c1c1n2/p3p3p/2p3P2/2P6/P3P3P/2NCBC3/5N3/2BAKA2R b - - 0 1' },
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
  { id: '残#11', big: 4, movesInto: 32, score: 1, fen: '4kab2/4a1c2/4b4/p1p2rp2/4R3p/6P2/P1P1P3P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#12', big: 5, movesInto: 28, score: 2, fen: '2b1kab2/4a1c2/4C4/p1p1r1p2/8p/5RP2/P1P1P3P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#13', big: 6, movesInto: 26, score: 2, fen: '2b1kab2/4a1c2/4c4/p1pr2p2/4C3p/5RP2/P1P1P3P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#14', big: 6, movesInto: 28, score: 2, fen: '4kabn1/2c1a4/4b4/p3p1p1p/9/2Br1NP2/P3P3P/9/1R4C2/2BAKA3 w - - 0 1' },
  { id: '残#15', big: 6, movesInto: 34, score: 1, fen: '2bakab2/9/2n6/p1p1p4/4n3P/2P6/r8/3CB2N1/4AR3/2BAK4 b - - 0 1' },
  { id: '残#16', big: 6, movesInto: 18, score: 0, fen: '2baka1nr/9/2n1b4/p1p3p1p/9/2N1p4/P1P3P1P/B5N2/4A2R1/4KAB2 b - - 0 1' },
  { id: '残#17', big: 6, movesInto: 28, score: -6, fen: '2baka1r1/6c2/4bc3/p3p2Rp/2p2N3/3N5/P3P3P/B8/9/3AKAB2 b - - 0 1' },
  { id: '残#18', big: 6, movesInto: 26, score: -20, fen: '4kab2/9/c1n1ba2n/p1p1p3p/9/2P2N3/P3P3P/3C5/9/1NBAKAB2 w - - 0 1' },
  { id: '残#19', big: 6, movesInto: 24, score: 1, fen: 'r1bakabn1/9/9/p7p/1np3p2/9/P3N1P1P/2N6/9/R1BAKAB2 w - - 0 1' },
  { id: '残#20', big: 4, movesInto: 36, score: 7, fen: '3akab2/3n5/9/p2r4p/2p2Pb2/1NP6/P6RP/4B4/4A4/2BAK4 b - - 0 1' },
  { id: '残#21', big: 5, movesInto: 38, score: -21, fen: '2b1ka3/4a4/1c2b3n/pR6p/4N4/6P2/4P3P/2r1B4/9/3AKAB2 w - - 0 1' },
  { id: '残#22', big: 6, movesInto: 32, score: -14, fen: '2bak4/4a4/3c2n2/p1P5p/4p1b2/7r1/P7P/2N1BC3/5R3/3AKAB2 w - - 0 1' },
  { id: '残#23', big: 6, movesInto: 30, score: -3, fen: '3ak1b2/4a4/1c2b2c1/p3r3p/4p4/2R1P1B2/P7P/4C2C1/4A4/4KAB2 b - - 0 1' },
  { id: '残#24', big: 6, movesInto: 34, score: 6, fen: '3akab2/3n5/9/pr1r4p/2p2Pb2/1RP6/P6RP/2N1B4/4A4/2BAK4 b - - 0 1' },
  { id: '残#25', big: 4, movesInto: 34, score: -1, fen: '4kab2/4a1c2/4b4/p4rp2/2p5R/6P2/P1P1P3P/4B4/4A4/1NBAK4 b - - 0 1' },
  { id: '残#26', big: 6, movesInto: 32, score: 12, fen: '2bak4/6c2/2n1ba3/p3p3C/9/2PnPN3/P7P/N8/9/2BAKAB2 b - - 0 1' },
  { id: '残#27', big: 6, movesInto: 30, score: 2, fen: '4kabn1/2c1a4/4b4/p2rN1p1p/9/2B3P2/P3P3P/9/1R4C2/2BAKA3 w - - 0 1' },
  { id: '残#28', big: 6, movesInto: 36, score: 0, fen: '2baka3/9/2n1b4/p1p1p4/4nR2P/2P6/r8/3CB2N1/4A4/2BAK4 b - - 0 1' },
  { id: '残#29', big: 6, movesInto: 20, score: 1, fen: '2baka1nr/9/2n1b4/p5p1p/2p1N4/4p4/P1P3P1P/B5N2/4A2R1/4KAB2 b - - 0 1' },
  { id: '残#30', big: 6, movesInto: 28, score: -20, fen: '1n2kab2/9/c3ba2n/p1p1p3p/3N5/2P6/P3P3P/3C5/9/1NBAKAB2 w - - 0 1' },
  { id: '残#31', big: 6, movesInto: 26, score: 3, fen: '1rbakabn1/9/9/p7p/1np3p2/9/P3N1P1P/2N1B4/9/R1BAKA3 w - - 0 1' },
  { id: '残#32', big: 4, movesInto: 38, score: 8, fen: '3akab2/3n5/9/p2r4p/5Pb2/1NB6/P6RP/9/4A4/2BAK4 b - - 0 1' },
  { id: '残#33', big: 6, movesInto: 34, score: -15, fen: '2bak4/4a4/3c5/p1P1n3p/4p1b2/7r1/P7P/2N1BC3/6R2/3AKAB2 w - - 0 1' },
  { id: '残#34', big: 6, movesInto: 32, score: 0, fen: '3ak1b2/4a4/1c2b4/p3r3p/4P4/2R3Bc1/P7P/4C2C1/4A4/4KAB2 b - - 0 1' },
  { id: '残#35', big: 6, movesInto: 34, score: 13, fen: '2bak4/6c2/2n1ba3/4p3C/p8/2PnPN2P/P8/N8/9/2BAKAB2 b - - 0 1' },
  { id: '残#36', big: 6, movesInto: 34, score: 3, fen: '4kabn1/4a4/4b4/p3N1p1p/9/2Br2P2/P3P3P/9/1R4C2/2cAKA3 w - - 0 1' },
  { id: '残#37', big: 6, movesInto: 22, score: 0, fen: '2baka2r/5n1R1/2n1b4/p5p1p/2p1N4/4p4/P1P3P1P/B5N2/4A4/4KAB2 b - - 0 1' },
  { id: '残#38', big: 6, movesInto: 28, score: 5, fen: '2bakabn1/9/9/pr6p/1npN2p2/9/P5P1P/2N1B4/9/R1BAKA3 w - - 0 1' },
  { id: '残#39', big: 4, movesInto: 40, score: 10, fen: '3akab2/3n5/9/p7p/3r1Pb2/1NB6/P4R2P/9/4A4/2BAK4 b - - 0 1' },
  { id: '残#40', big: 6, movesInto: 36, score: -13, fen: '2bak4/4a4/6c2/p2Pn3p/4p1b2/7r1/P7P/2N1BC3/6R2/3AKAB2 w - - 0 1' },
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

// ================================================================ 取局面
// 下面是「这批局面怎么取」的**唯一一份实现**，两把仪器都从它取（见文件头）。

/** 四个组的名字（`--set` 的合法取值，另外还认一个 `all`） */
export const SET_NAMES = ['opening', 'middlegame', 'endgame', 'regression'];

/**
 * 把 `--set` 的取值解析成组名列表：`all` 展开成四组全要。
 *
 * 不认识的名字**抛错**（调用方负责打印并退出）—— 不静默忽略：
 * 打错一个字就会拿到一个意料之外的组，而「跑错了一批局面」是这里最贵的错误。
 */
export function resolveSets(spec = 'opening,regression') {
  const names = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .flatMap((s) => (s === 'all' ? SET_NAMES : [s]));
  for (const s of names) {
    if (!SET_NAMES.includes(s)) {
      throw new Error(`不认识的局面集「${s}」—— 可选：${SET_NAMES.join(' / ')} / all`);
    }
  }
  return names;
}

/**
 * 取这批局面。顺序 = 调用方给的组顺序，组内顺序固定（同一批局面每次必须一模一样）。
 *
 * `tactical` **只作用于 `opening`**：那组是从开局谱里扫出来的安静局面，
 * 「只看有吃子的」才量得出深度收益；中局 / 残局 / 回归三组本来就是照真实对弈采的，不再筛。
 */
export function strengthPositions({ sets = ['opening', 'regression'], tactical = false, n = 30 } = {}) {
  const out = [];
  for (const set of sets) {
    if (set === 'opening') {
      // 生成谱里大部分局面是黑走的，扫密一点才凑得够数
      const seen = new Set();
      let k = 0;
      for (let i = 0; i < GENERATED_TREE.length && k < n; i += 5) {
        const [fen] = GENERATED_TREE[i];
        const pos = parseFen(fen);
        if (pos.side !== 1) continue;
        if (tactical && !generateMoves(pos.cells, pos.side).some((m) => pos.cells[m % CELLS] !== EMPTY)) {
          continue;
        }
        if (seen.has(fen)) continue;
        seen.add(fen);
        out.push({ set, id: (tactical ? '战术#' : '谱#') + k, fen });
        k += 1;
      }
      continue;
    }
    const list = { middlegame: MIDDLEGAME, endgame: ENDGAME, regression: REGRESSION }[set];
    for (const p of list.slice(0, n)) out.push({ set, id: p.id, fen: p.fen, meta: p });
  }
  return out;
}
