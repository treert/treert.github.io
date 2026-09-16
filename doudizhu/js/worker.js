/**
 * Worker 外壳：收一条决策请求，回一个结果。纯胶水，不含任何策略。
 *
 * **这是本模块唯一允许碰 `self` / `postMessage` 的文件** ——
 * 其余 `js/` 模块都必须保持纯逻辑，否则在 Worker 里加载时会崩（与象棋同一规矩）。
 *
 * 它同时是"AI 看不到别人的手牌"的**第三道防线**（§3.1、§7.7）：
 * 主线程只 `postMessage(view)`，所以 Worker 进程里**根本不存在完整的对局状态**。
 * 前两道防线是"AI 的签名只接受 view"和"那条可执行的测试"（test-ai.mjs）。
 *
 * 协议：
 *   主线程 → Worker   { type: 'decide' | 'bid', id, view, levelId, seed }
 *   Worker → 主线程   { type: 'move', id, move }       // decide 的结果
 *                     { type: 'bid',  id, score }      // bid 的结果
 *                     { type: 'error', id, message }
 *
 * `seed` 由主线程给，Worker 内部用 `mulberry32` 还原成确定性 PRNG ——
 * 这样 AI 的行为可复现（Node 里的测试与浏览器里跑的是同一条路径）。
 */

import { mulberry32 } from './cards.js';
import { findLevel } from './config.js';
import { decide, decideBid } from './ai/index.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || !msg.id) return;

  try {
    const level = findLevel(msg.levelId);
    const rng = mulberry32(msg.seed >>> 0);

    if (msg.type === 'decide') {
      self.postMessage({ type: 'move', id: msg.id, move: decide(msg.view, level, rng) });
      return;
    }
    if (msg.type === 'bid') {
      self.postMessage({ type: 'bid', id: msg.id, score: decideBid(msg.view, level, rng) });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
