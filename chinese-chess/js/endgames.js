/**
 * 残局库。**这是本模块唯一需要手工维护的数据文件。**
 *
 * ## 页签表
 *
 * 界面上的分类页签全部由本文件末尾的 TABS 生成 —— 页签名、条数徽标、列表内容都读它，
 * **加一个新页签 = 在 TABS 里加一项 `{ id, label, entries }`**，界面那一侧一行都不用改。
 *
 * 现在有三页：
 *   practical 实用残局 —— 教材定式，结果可靠，适合入门训练
 *   composed  适情雅趣 —— 取自《适情雅趣》排局谱，多为十几步的连杀，适合欣赏
 *   custom    自定义     —— 用户存进 localStorage 的局面，数据不在本文件里
 *
 * ## 数据来源
 *
 * 「适情雅趣」这一页取自 kuiba1949/xiangqi-tools 的 fen/shiqingyaqu551.fen
 * （https://github.com/kuiba1949/xiangqi-tools，BSD-3-Clause）。
 * 原文件每行形如：
 *   [FEN_INDEX "shiqingyaqu-551-001"] [EVENT "...第001局 气吞关右"] [FEN "..."]
 * 本文件把 FEN_INDEX 用作 id、EVENT 里的局号局名用作 name。
 * 《适情雅趣》是明代排局谱，属公有领域；该仓库的 FEN 转换部分按 BSD-3 授权。
 *
 * 实用残局由本模块自己构造（红帅在 (3,9)、黑将在 (4,0) 这类骨架），
 * 结果取自教材定式。
 *
 * ## result 字段的可靠性边界（重要）
 *
 * **result 不经过机器验证。** 要证明「红先必胜」需要可靠的求解器或权威棋谱，
 * 本模块的引擎（简化评估 + 迭代加深）做不到，所以：
 *
 *   - 实用残局：结果取自教材定式，可靠
 *   - 适情雅趣：结果取自它这一「红先胜」排局谱的性质，**逐局未经复核**
 *
 * tools/verify-endgames.mjs 只校验局面合法性、不校验胜负结论。
 * 每局都带 source 字段标明出处，结论留给你实战验证。
 *
 * ## 加一局 / 加一页的流程
 *
 *   加一局：往对应页签的 entries 里按格式加一条
 *   加一页：在末尾的 TABS 里加一项（数据自己写在这一项里）
 *   两种改完都跑 node chinese-chess/tools/verify-endgames.mjs
 *   它会把不合法的局面、对不上页签的 category 连原因一起打出来
 */

import { CUSTOM_CATEGORY } from './custom-endgames.js';

export const RESULTS = {
  win: '先手胜',
  draw: '和棋',
};

/** 《适情雅趣》的出处标注统一用这个前缀，省得每局都写一遍 */
const YAQV = '《适情雅趣》';
const YAQV_NOTE = '（据 kuiba1949/xiangqi-tools 的 FEN 转换，BSD-3）';

const PRACTICAL = [
  {
    id: 'che-vs-dan-shi',
    name: '单车例胜单士',
    fen: '4ka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1',
    result: 'win',
    difficulty: 1,
    source: '教材定式',
    note: '车方先逼将离位，再破士。士离将越远越难守。',
  },
  {
    id: 'che-vs-dan-xiang',
    name: '单车例胜单象',
    fen: '2b1k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1',
    result: 'win',
    difficulty: 1,
    source: '教材定式',
    note: '象的活动范围比士大，但孤象仍守不住。',
  },
  {
    id: 'che-vs-shuang-shi',
    name: '单车例胜双士',
    fen: '3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1',
    result: 'win',
    difficulty: 2,
    source: '教材定式',
    note: '双士比单士难破，关键是逼将上到三楼、再用帅助攻。',
  },
  {
    id: 'che-vs-ma-shuang-shi',
    name: '单车例胜马双士',
    fen: 'n2aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1',
    result: 'win',
    difficulty: 3,
    source: '教材定式',
    note: '马反而会挡住自己的士，比纯双士更好破。',
  },
  {
    id: 'che-vs-shi-xiang-quan',
    name: '单车难胜士象全',
    fen: '2bakab2/9/9/9/9/9/9/9/9/R2K5 w - - 0 1',
    result: 'draw',
    difficulty: 3,
    source: '教材定式',
    note: '最经典的守和定式。守方只要士象不散，车方无解。练守方。',
  },
  {
    id: 'shuang-che-vs-shi-xiang-quan',
    name: '双车必胜士象全',
    fen: '2bakab2/9/9/9/9/9/9/9/9/RR1K5 w - - 0 1',
    result: 'win',
    difficulty: 2,
    source: '教材定式',
    note: '双车错杀，士象全也挡不住。与上一局对照着看很直观。',
  },
  {
    id: 'ma-qin-dan-shi',
    name: '马擒单士',
    // 注意黑将是 (4,0)、士是 (3,0) —— 写成 `3ka4` 会把两者写反，
    // 那样黑将和红帅同在纵线 3 上、中间无子，直接变成照面的非法局面。
    // 这个错误是 verify-endgames.mjs 抓出来的。
    fen: '3ak4/9/9/9/9/4N4/9/9/9/3K5 w - - 0 1',
    result: 'win',
    difficulty: 4,
    source: '教材定式',
    note: '单马擒单士要借帅的力量，走法很讲究，是练马的好题目。',
  },
  {
    id: 'dan-ma-vs-dan-jiang',
    name: '单马必胜单将',
    // 这一条原来写成「单马难胜单将 / draw」，是错的：
    // 单马对孤将（两边都没有士象）红方必胜 —— 靠的不是将死，是把将逼进九宫死角后困毙。
    // 把这个残局按「红帅 9 格 × 黑将 9 格 × 马 90 格」全部穷举一遍（逆向分析，并用
    // 另一套正向搜索交叉验证过），红先的局面全部红胜，黑先的局面只有在黑将能吃马时才和。
    // 下面自己搭的骨架恰好就是两步杀：1.马五进四 将5平4（黑方唯一着法）2.马四进六 困毙。
    fen: '4k4/9/9/9/9/4N4/9/9/9/3K5 w - - 0 1',
    result: 'win',
    difficulty: 2,
    source: '教材定式',
    note: '孤将守不住一马：帅照面封住一路、马封住另一个落点，把将逼进九宫角就是困毙（困毙判负）。'
      + '本局面两步解决：1.马五进四 将5平4（黑方唯一着法）2.马四进六。',
  },
];

// 《适情雅趣》前 15 局。id 与 name 都来自原文件的 FEN_INDEX / EVENT 字段。
const COMPOSED_RAW = [
  ['shiqingyaqu-551-001', '第001局 气吞关右', '2baka3/3P3N1/bN7/7nc/9/4C1P2/P5n1P/B3R3B/4Apr2/2RAK3c w - - 0 1'],
  ['shiqingyaqu-551-002', '第002局 马蹀阏氏', 'C3kab2/4a4/n3c1n2/3Np1p2/1R4P2/1R7/4P4/4B4/1pCp1p3/1crAK1N2 w - - 0 1'],
  ['shiqingyaqu-551-003', '第003局 羝羊触藩', '1rbckaP2/3PaP1r1/1P2b4/1R7/Nn7/CRBp1n3/4C4/9/4p1p2/1c3K3 w - - 0 1'],
  ['shiqingyaqu-551-004', '第004局 良将安边', '2bk1ab2/4a4/9/p1P6/3NC4/4Pp3/P5n2/4B3N/4Ar3/1RBAK2cr w - - 0 1'],
  ['shiqingyaqu-551-005', '第005局 淮阴遇汉', '2ba1k3/4a1R2/9/1cp2N3/1Nb6/3n2P2/4C4/3AB4/3r1p1n1/2R1KAr1c w - - 0 1'],
  ['shiqingyaqu-551-006', '第006局 蝇垂骥尾', '2b1kabn1/4aR3/3R2N2/4p1p2/5P3/4P4/3N2Pr1/4C1n2/3pAr3/4K3c w - - 0 1'],
  ['shiqingyaqu-551-007', '第007局 春雷惊蛰', '3a2b2/1P1k5/2Pab4/7RC/9/9/2P2c3/2NA5/3KAr3/cnn1r4 w - - 0 1'],
  ['shiqingyaqu-551-008', '第008局 珠藏韫柜', 'C1bac1RN1/r2Rak3/7n1/1rP6/2N1P1p2/9/9/2n6/5p3/4Kc3 w - - 0 1'],
  ['shiqingyaqu-551-009', '第009局 神龟出洛', '3a1k3/1C7/c4a3/8N/3P5/9/8C/B8/r2pnpp2/4K1cRR w - - 0 1'],
  ['shiqingyaqu-551-010', '第010局 鸳鸯戏水', '4kab1C/4a4/9/1R7/4P1N2/2N3B2/1n5r1/4n4/4A4/c1BAK4 w - - 0 1'],
  ['shiqingyaqu-551-011', '第011局 群鼠争穴', '3k2b2/4P4/crR1b2Rc/9/9/9/9/1C3N1C1/4p1r2/2p2K3 w - - 0 1'],
  ['shiqingyaqu-551-012', '第012局 颠猿饮涧', '1C2kab2/rN2a2R1/2r1c3b/9/9/5R3/9/7C1/9/3K5 w - - 0 1'],
  ['shiqingyaqu-551-013', '第013局 目视横流', '4k4/3P2P2/b2N2R2/7r1/2b6/9/9/3n5/4p3r/2R2K3 w - - 0 1'],
  ['shiqingyaqu-551-014', '第014局 独鹿鸣泽', 'C3k4/4a1r2/5a3/1N7/1Cp6/1R7/9/3p5/4p3r/3K5 w - - 0 1'],
  ['shiqingyaqu-551-015', '第015局 妙振兵铃', 'r1b1k4/c1PPaRc2/r2ab3n/4C4/7RC/9/9/9/4p4/3K5 w - - 0 1'],
];

const COMPOSED = COMPOSED_RAW.map(([id, name, fen]) => ({
  id,
  name: `${YAQV}${name}`,
  fen,
  // 《适情雅趣》是「红先胜」排局谱，所以先手方视角一律标胜。
  // 这是按谱的性质标的，逐局未复核 —— 见文件头的说明。
  result: 'win',
  difficulty: 5,
  source: `${YAQV}${YAQV_NOTE}`,
}));

// === 自定义局面的内存副本 ===
//
// 用户存的自定义局面不在这里（它们是 localStorage 里的数据，见 custom-endgames.js），
// 但 findEndgame / endgamesByCategory / 页签表是 game.js 和界面层共用的查询入口 ——
// 给它们加一个「去哪找自定义局面」的参数会污染一大片调用点。
// 所以放一个**只写一次**的容器：main.js 启动时灌一次，其它地方只读。
//
// 注意 setCustomEndgames 是**原地替换**（length = 0 再 push），不是换引用 ——
// 页签表里存的就是这个数组，换引用那一页就取不到数据了。
//
// 这样做的直接收益：game.js 的 startEndgame / endgameOf、persist.js 的存档格式
// 全都不需要知道有「自定义」这回事。
const CUSTOM_ENTRIES = [];

// === 页签表 ===
//
// **加一页只改这里。** 每项：
//   id       写进每条的 category，也是界面里 dataset.filter 的值
//   label    页签上显示的名字
//   entries  这一页的数据（数组字面量，或者像自定义那样的运行时容器）
//   runtime  true = 数据不在本文件里（目前只有自定义这一页）
//   empty    这一页空着时列表里的提示，不给就用界面的默认文案
const TABS = [
  { id: 'practical', label: '实用残局', entries: PRACTICAL },
  { id: 'composed', label: '适情雅趣', entries: COMPOSED },
  {
    id: CUSTOM_CATEGORY,
    label: '自定义',
    entries: CUSTOM_ENTRIES,
    runtime: true,
    empty: '还没有自定义局面。把当前下到一半的棋存一个，或者粘一段 FEN 进来。',
  },
];

/**
 * 页签表（只读副本）。界面按它渲染页签与列表 —— 与数据同源，不会两边漏改。
 *
 * `entries` 是**活的数组**（自定义那一页会随增删变），调用方不要缓存它。
 */
export function endgameTabs() {
  return TABS.map(({ id, label, entries, empty }) => ({ id, label, entries, empty }));
}

/** 页签 id → 显示名。工具脚本（verify-endgames.mjs）用它做枚举校验 */
export const CATEGORIES = Object.fromEntries(TABS.map((t) => [t.id, t.label]));

/**
 * 内置局面（不含自定义那一页 —— 它的数据运行时才灌进来）。
 * 每条的 category 由**它所在的页签**推导，不用手写，也就不会和页签对不上。
 */
export const ENDGAMES = TABS
  .filter((t) => !t.runtime)
  .flatMap((t) => t.entries.map((e) => ({ ...e, category: t.id })));

export function setCustomEndgames(list) {
  const next = Array.isArray(list) ? list : [];
  CUSTOM_ENTRIES.length = 0;
  CUSTOM_ENTRIES.push(...next);
}

/** 内置库 + 自定义库的合并视图。总是新数组，调用方改不动库里的对象 */
export function allEndgames() {
  return TABS.flatMap((t) => t.entries.map((e) => ({ ...e, category: t.id })));
}

export function findEndgame(id) {
  return ENDGAMES.find((e) => e.id === id) || CUSTOM_ENTRIES.find((e) => e.id === id);
}

/** 某个页签的全部局面。不传分类 = 全部（内置 + 自定义） */
export function endgamesByCategory(category) {
  if (!category) return allEndgames();
  const tab = TABS.find((t) => t.id === category);
  return tab ? tab.entries.map((e) => ({ ...e, category: tab.id })) : [];
}
