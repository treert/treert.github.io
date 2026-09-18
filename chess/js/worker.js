/**
 * Worker 外壳：收一条搜索请求，回一条结果。纯胶水，不含任何搜索逻辑。
 *
 * 单 Worker、串行处理。搜索期间主线程会禁用操作，不做中途取消
 *（最高挡位上限 1.5 秒，可接受）。
 *
 * 这是本模块唯一允许碰 self / postMessage 的文件 ——
 * 其余 js/ 模块都必须保持纯逻辑，否则在 Worker 里加载时会崩。
 *
 * 协议（design.md §7.4）：
 *   主线程 → Worker   { type: 'search', id, fen, level }
 *   Worker → 主线程   { type: 'result', id, move: { from, to, promo } | null,
 *                       score, depth, nodes, timeMs, blundered }
 *                     { type: 'error',  id, message }
 *
 * **promo 必须回**：国象的升变是「同一个起点终点、四个不同着法」，
 * 不带升变种类的话主线程无法还原是哪一种（这条与象棋不同 —— 那边没有升变）。
 *
 * 刻意**不返回 SAN**：主线程在把着法记进对局状态时本来就要调一次 toSan
 *（玩家自己走的棋也要记谱），Worker 再算一遍是重复劳动，还让 Worker 多依赖一个模块。
 */

import { search } from './engine.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'search') return;

  try {
    const result = search(msg.fen, msg.level);
    if (!result) {
      // 无着法可走（局面已经终局），回一个空着法让上层按状态行处理
      self.postMessage({ type: 'result', id: msg.id, move: null });
      return;
    }
    self.postMessage({
      type: 'result',
      id: msg.id,
      move: { from: result.from, to: result.to, promo: result.promo },
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
