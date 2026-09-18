/**
 * Worker 外壳：收一条搜索请求，回一条结果。纯胶水，不含任何搜索逻辑。
 *
 * 单 Worker、串行处理。搜索期间主线程会禁用操作，不做中途取消
 * （高级挡位上限 1.5 秒，可接受）。
 *
 * 这是本模块唯一允许碰 self / postMessage 的文件 ——
 * 其余 js/ 模块都必须保持纯逻辑，否则在 Worker 里加载时会崩。
 *
 * 协议：
 *   主线程 → Worker   { type: 'search', id, fen, level, history }
 *   Worker → 主线程   { type: 'result', id, move: { from, to } | null,
 *                       score, depth, nodes, timeMs, blundered }
 *                     { type: 'error',  id, message }
 *
 * `history` 是当前这条线上的局面（含起始局面，最后一项就是 `fen`）——
 * 循环规则（长将）要靠它才看得见搜索树之外的循环，见 engine.js 的 Searcher。
 *
 * 刻意**不返回 notation**：主线程在把着法记进对局状态时本来就要调一次
 * toNotation（玩家自己走的棋也要记谱），Worker 再算一遍是重复劳动，
 * 还让 Worker 多依赖一个模块。design.md §7.4 的初稿里有这一项，已去掉。
 */

import { search } from './engine.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'search') return;

  try {
    const result = search(msg.fen, msg.level, { history: msg.history });
    if (!result) {
      // 无着法可走（局面已经终局），回一个空着法让上层判负
      self.postMessage({ type: 'result', id: msg.id, move: null });
      return;
    }
    self.postMessage({
      type: 'result',
      id: msg.id,
      move: { from: result.from, to: result.to },
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      timeMs: result.timeMs,
      blundered: result.blundered,
    });
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
