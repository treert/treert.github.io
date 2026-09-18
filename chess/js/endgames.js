/**
 * 残局库：**页签表 + 查询入口**。这是本模块唯一需要手工维护的数据文件。
 *
 * ## 页签表
 *
 * 界面上的分类页签全部由 `endgameTabs()` 生成 —— 页签名、条数徽标、列表内容都读它，
 * **加一个新页签 = 在 TABS 里加一项 `{ id, label, entries, empty }`**，界面那一侧一行都不用改。
 *
 * 四类：
 *   basic     基础杀法  —— KQ vs K、KR vs K、双象杀、马象杀这类定式
 *   pawns     兵类残局  —— K+P vs K 的关键格、通路兵
 *   rook      车兵类    —— 卢塞纳 / 菲力多尔这类经典局面
 *   tactics   战术题    —— 一步杀 / 两步杀、牵制与双击
 *   custom    自定义    —— 用户存进 localStorage 的局面（数据不在本文件里）
 *
 * ## 数据来源与结论的可靠性边界
 *
 * `result` 字段是 `white | black | draw`（从**先手方**角度说）。它的可靠来源有两类：
 *
 *   - **表库 / 深搜可证明**：3~5 子残局可以用 Syzygy 表库给出 DTZ 口径的结论
 *     （见 docs/stockfish.md §3）。本文件里的基础杀法、兵类、车兵类都属于这一类。
 *   - **离线引擎算出来再用本模块规则层逐手复核**：战术题的 `result` 由
 *     `tools/gen-solutions.mjs` 生成解法线时确认，并由 `tools/verify-endgames.mjs`
 *     复核每一步合法、末局确实达成该结果。
 *
 * `source` 字段一律写清出处。**不把别人的数据当自己的**（stockfish.md §4.1）。
 *
 * ## 加一局 / 加一页的流程
 *
 *   加一局：往对应页签的数组里按格式加一条
 *   加一页：在 TABS 里加一项（数据自己写在这一项里）
 *   两种改完都跑 `node chess/tools/verify-endgames.mjs`
 */

/**
 * 一局的胜负性质。三个值都是**从先手方（白方）角度**说的。
 * 界面上显示成「先手胜 / 先手负 / 和棋」，终局判定也按它比。
 */
export const RESULTS = {
  white: '先手胜',
  draw: '和棋',
  black: '先手负',
};

/** 自定义局面那一页的 id。custom-endgames.js 也用它，别改 */
export const CUSTOM_CATEGORY = 'custom';
export const CUSTOM_SOURCE = '自定义局面';

// === 数据区（Task 10 填内容）===

/** 基础杀法 */
const BASIC = [];

/** 兵类残局 */
const PAWNS = [];

/** 车兵类 */
const ROOK = [];

/** 战术题 */
const TACTICS = [];

/** 用户存进 localStorage 的局面。由 main.js 在启动和增删后重新灌进来 */
let customEntries = [];

/**
 * 注册（或替换）自定义局面。`endgames.js` 只存一份引用，
 * 所以 game.js / persist.js 完全不需要知道有「自定义」这回事。
 */
export function setCustomEndgames(list) {
  customEntries = Array.isArray(list) ? list : [];
}

// === 查询 ===

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

/** 全部局面（内置 + 自定义）。校验脚本用这个 */
export function allEndgames() {
  return endgameTabs().flatMap((tab) => tab.entries);
}

/**
 * 某一页的局面。返回的是**补上 category 的副本** ——
 * 数据里不用每条都写一遍 category，界面也不必自己拼。
 */
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
