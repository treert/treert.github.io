/**
 * 残局库。**这是本模块唯一需要手工维护的数据文件。**
 *
 * 分两类：
 *   practical 实用残局 —— 教材定式，结果可靠，适合入门训练
 *   composed  经典排局 —— 取自《适情雅趣》，多为十几步的连杀，适合欣赏
 *
 * ## 数据来源
 *
 * 经典排局取自 kuiba1949/xiangqi-tools 的 fen/shiqingyaqu551.fen
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
 *   - 经典排局：结果取自《适情雅趣》这一「红先胜」排局谱的性质，**逐局未经复核**
 *
 * tools/verify-endgames.mjs 只校验局面合法性、不校验胜负结论。
 * 每局都带 source 字段标明出处，结论留给你实战验证。
 *
 * ## 加一局的流程
 *
 *   1. 在下面按格式加一条
 *   2. 跑 node chinese-chess/tools/verify-endgames.mjs
 *   3. 它会把不合法的局面连原因一起打出来
 */

export const CATEGORIES = {
  practical: '实用残局',
  composed: '经典排局',
};

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
    name: '单马难胜单将',
    fen: '4k4/9/9/9/9/4N4/9/9/9/3K5 w - - 0 1',
    result: 'draw',
    difficulty: 2,
    source: '教材定式',
    note: '单马不能胜孤将。练守方——记住怎么躲马。',
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

/** 全部残局。实用残局排在前面 —— 它们是训练的主体 */
export const ENDGAMES = [
  ...PRACTICAL.map((e) => ({ ...e, category: 'practical' })),
  ...COMPOSED.map((e) => ({ ...e, category: 'composed' })),
];

export function findEndgame(id) {
  return ENDGAMES.find((e) => e.id === id);
}

export function endgamesByCategory(category) {
  if (!category || category === 'all') return ENDGAMES;
  return ENDGAMES.filter((e) => e.category === category);
}
