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
 *   Worker → 主线程   { type: 'result', id, move: { from, to, promo } | null, ... }
 *                     { type: 'error',  id, message }
 *
 * **promo 必须回**：国象的升变是「同一个起点终点、四个不同着法」，
 * 不带升变种类的话主线程无法还原是哪一种（这条与象棋不同 —— 那边没有升变）。
 *
 * 刻意**不返回 SAN**：主线程在把着法记进对局状态时本来就要调一次 toSan
 *（玩家自己走的棋也要记谱），Worker 再算一遍是重复劳动，还让 Worker 多依赖一个模块。
 */

import { parseFen } from './position.js';
import { generateLegalMoves, moveFrom, moveTo, movePromo } from './rules.js';

/**
 * 选一步棋。
 *
 * **当前是随机挑一步合法着法**，只为把「主线程 ↔ Worker」这条链路跑通
 *（Task 6 的验证是「能人机走完一盘」）。真正的引擎在 engine.js，
 * 由它替换掉这个函数 —— 协议与其余代码都不用动。
 */
function pickMove(fen) {
  const moves = generateLegalMoves(parseFen(fen));
  if (moves.length === 0) return null;
  const move = moves[Math.floor(Math.random() * moves.length)];
  return { move, nodes: moves.length, depth: 1 };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'search') return;

  const started = Date.now();
  try {
    const picked = pickMove(msg.fen);
    if (!picked) {
      // 无着法可走（局面已经终局），回一个空着法让上层按状态行处理
      self.postMessage({ type: 'result', id: msg.id, move: null });
      return;
    }
    const move = picked.move;
    self.postMessage({
      type: 'result',
      id: msg.id,
      move: {
        from: moveFrom(move),
        to: moveTo(move),
        promo: movePromo(move),
      },
      nodes: picked.nodes,
      depth: picked.depth,
      timeMs: Date.now() - started,
    });
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
