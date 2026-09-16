/**
 * AI 内部诊断：**PIMC 到底有没有在跑？跑得动吗？**
 *
 * 跑法：`node doudizhu/tools/diag-ai.mjs`
 *
 * 为什么单独有这个文件：`selfplay.mjs` 只报"每局谁赢了、花了多久"，
 * 看不出 AI **内部**发生了什么。而"AI 是不是真的在做蒙特卡洛采样"
 * 这个问题单看胜负是回答不了的 —— 一个采样器坏掉、退化成纯贪心的 AI
 * 照样能打完每一局，胜负数字也不难看。**必须问它自己。**
 *
 * 它回答三件事：
 *
 *   1. **决策分流**：每次决策走了哪条路（`decide` 的 `stats.path`）。
 *      `no-move` 与 `finish` 都是早退，不需要 AI，所以真正需要 PIMC 的只有一部分。
 *   2. **PIMC 的实际强度**：真的走到 PIMC 的那些决策里，平均采了多少个世界、
 *      搜了多少节点 —— 和 `config.js` 里配置的 `samples` 对不对得上。
 *   3. **开关对照**：同一个局面下逐步关掉"采样"和"搜索"，着法变了多少百分比。
 *      这是 §11.4(c) 那套对照手法在**运行期**的版本（测试里是断言，这里是读数）。
 *
 * 实测基线（用于判断"数字变得对不对"，不是断言）：
 *
 *   | 挡位 | 平均耗时 | 决策分流                        | 走到 PIMC 时采样 | 搜索节点 |
 *   |------|---------|--------------------------------|----------------|---------|
 *   | 中级 | 2.8ms   | pimc 55% / no-move 41% / finish 4% | 20.0（配置 20） | 180 |
 *   | 高级 | 5.0ms   | pimc 52% / no-move 45% / finish 4% | 32.0（配置 32） | 362 |
 *
 *   开关对照：关掉采样有 20.4% 的着法变了，关掉搜索有 9.3% 变了。
 *
 * **两个"看起来是旋钮、实际不起作用"的数字**（见 config.js 的注释与 future-work）：
 *   - `thinkMs`（1000 / 1500）在这两个挡位上**从不生效** —— 一次决策只要 3~5ms，
 *     离超时差两三个数量级。它是安全上限，不是调参旋钮。
 *   - `noise` / `blunderRate` 对 PIMC 挡位是死代码（只在贪心路径上生效）。
 */

import { createGame, play } from '../js/game.js';
import { viewOf } from '../js/view.js';
import { decide } from '../js/ai/index.js';
import { findLevel } from '../js/config.js';

const GAMES = Number(process.argv[2]) || 10;

let seed = 20260915;
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const key = (m) => (m && m.kind === 'pass' ? 'pass' : (m ? m.cards.join(',') : 'null'));

// ─────────────────────────────────────────────
// 1 + 2. 决策分流与 PIMC 的实际强度
// ─────────────────────────────────────────────

for (const id of ['novice', 'easy', 'medium', 'hard']) {
  const level = findLevel(id);
  const byPath = new Map();
  let decisions = 0;
  let ms = 0;
  const pimc = { n: 0, worlds: 0, nodes: 0, cands: 0, minW: Infinity, maxW: 0 };

  for (let g = 0; g < GAMES; g++) {
    // 三家都用这个挡位，才覆盖得到"地主"和"农民"两种角色
    const game = createGame({ rng, landlord: g % 3, bidScore: 1 });
    let guard = 0;
    while (game.phase === 'playing' && guard++ < 400) {
      const seat = game.turn;
      const s = {};
      const t0 = Date.now();
      const move = decide(viewOf(game, seat), level, rng, s);
      ms += Date.now() - t0;
      decisions++;
      byPath.set(s.path, (byPath.get(s.path) || 0) + 1);
      if (s.path === 'pimc') {
        pimc.n++;
        pimc.worlds += s.worlds;
        pimc.nodes += s.nodes;
        pimc.cands += s.candidates;
        if (s.worlds < pimc.minW) pimc.minW = s.worlds;
        if (s.worlds > pimc.maxW) pimc.maxW = s.worlds;
      }
      const r = play(game, seat, move);
      if (!r.ok) { console.log(`  ✗ 合法着法被拒（座位 ${seat}）：${r.reason}`); break; }
    }
  }

  const d = decisions || 1;
  const dist = [...byPath].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}(${((n / d) * 100).toFixed(0)}%)`).join('  ');
  console.log(`[${level.name}] ${decisions} 次决策，平均 ${(ms / d).toFixed(1)}ms`
    + `（thinkMs ${level.thinkMs}）`);
  console.log(`  分支分布：${dist}`);
  if (pimc.n) {
    const full = pimc.minW === pimc.maxW && pimc.minW === level.samples;
    console.log(`  走到 PIMC 的 ${pimc.n} 次：采样 ${(pimc.worlds / pimc.n).toFixed(1)}`
      + `（${pimc.minW}~${pimc.maxW}，配置 ${level.samples}）`
      + `${full ? ' ✓ 每次都跑满' : ' ⚠ 有没跑满的（预算不够？）'}`
      + `，搜索节点 ${(pimc.nodes / pimc.n).toFixed(1)}，候选 ${(pimc.cands / pimc.n).toFixed(1)}`);
  } else {
    console.log('  这个挡位不做 PIMC（samples <= 1，纯贪心）');
  }
}

// ─────────────────────────────────────────────
// 3. 开关对照：逐步关掉采样 / 搜索，着法变多少
// ─────────────────────────────────────────────

{
  const full = findLevel('medium');
  const noSample = { ...full, samples: 1 };                     // 只剩贪心
  const noSearch = { ...full, searchDepth: 0, innerWidth: 0 };   // 采样但不搜索
  let diffSample = 0;
  let diffSearch = 0;
  let total = 0;
  let cur = createGame({ rng, landlord: 0, bidScore: 1 });

  for (let i = 0; i < 3000; i++) {
    if (cur.phase !== 'playing') { cur = createGame({ rng, landlord: i % 3, bidScore: 1 }); continue; }
    const seat = cur.turn;
    const v = viewOf(cur, seat);
    const move = decide(v, full, rng);
    total++;
    if (key(move) !== key(decide(v, noSample, rng))) diffSample++;
    if (key(move) !== key(decide(v, noSearch, rng))) diffSearch++;
    const r = play(cur, seat, move);
    if (!r.ok) break;
  }

  console.log(`开关对照（中级，${total} 个局面）：`);
  console.log(`  关掉采样（PIMC → 纯贪心）  着法变了 ${diffSample} 个`
    + `（${((diffSample / total) * 100).toFixed(1)}%）`);
  console.log(`  关掉搜索（深度 1 → 0）      着法变了 ${diffSearch} 个`
    + `（${((diffSearch / total) * 100).toFixed(1)}%）`);
  console.log('  → 这两个数太小（比如 < 1%）就说明那个开关实际上没接上；'
    + '为 0 就是断的。');
}
