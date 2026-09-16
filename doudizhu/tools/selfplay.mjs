/**
 * 自对弈冒烟 + 强度对照（design.md §11.5）。
 *
 * 两种模式：
 *
 *   node doudizhu/tools/selfplay.mjs [局数] [挡位]
 *       三个 AI 用同一个挡位打到底。管两件事：单测覆盖不到的"状态组合"，
 *       以及叫分阈值的校准（流局率 < 5%、三个座位当地主次数均匀）。
 *
 *   node doudizhu/tools/selfplay.mjs ab [地主挡位] [农民挡位] [局数]
 *       **强度对照**：固定座位 0 当地主（用测试入口跳过叫分），
 *       两个农民用另一个挡位。看"地主胜率"这一个数 ——
 *       农民变强 ⟹ 地主胜率下降。
 *
 *       为什么用这个设计：地主是单人、农民是双人，直接让 A 和 B 各坐一边比胜负
 *       会有"角色混淆"（同一挡位当农民比当地主轻松）。固定"座位 0 = 地主"之后，
 *       唯一的自变量就是两边用的挡位，胜负方向是确定的、可解释的。
 *
 * 刻意**不钉具体胜率**（除流局率那条单调的验收线）：它随挡位与随机种子波动。
 */

import { createGame, bid, play, biddingSeat } from '../js/game.js';
import { viewOf } from '../js/view.js';
import { decide, decideBid } from '../js/ai/index.js';
import { findLevel } from '../js/config.js';

const args = process.argv.slice(2);

let seed = 20260915;
const rng = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const failures = [];
const MAX_STEPS = 400;

/** 打一局。`levels[seat]` 是各座位用的挡位；`forcedLandlord` 给定时跳过叫分 */
function playOne(levels, forcedLandlord) {
  const game = forcedLandlord === undefined
    ? createGame({ rng })
    : createGame({ rng, landlord: forcedLandlord, bidScore: 1 });

  const stats = { redeal: false, steps: 0, thinkUs: 0, decisions: 0 };

  let guard = 0;
  while (game.phase === 'bidding') {
    const seat = biddingSeat(game);
    const r = bid(game, seat, decideBid(viewOf(game, seat), levels[seat], rng), rng);
    if (!r.ok) { failures.push(`叫分被拒：${r.reason}`); break; }
    if (r.redeal) stats.redeal = true;
    if (++guard > 60) { failures.push('叫分不死循环'); break; }
  }
  if (game.phase !== 'playing') return { game, stats };

  while (game.phase === 'playing') {
    const seat = game.turn;
    const t0 = process.hrtime.bigint();
    const move = decide(viewOf(game, seat), levels[seat], rng);
    stats.thinkUs += Number(process.hrtime.bigint() - t0) / 1000;
    stats.decisions++;
    if (process.env.DDZ_TRACE) {
      console.log(`    [${stats.decisions}] 座位${seat}(${levels[seat].name}) `
        + `${move && move.kind === 'pass' ? '不要' : (move ? move.cards.join(',') : 'null')}`);
    }
    if (!move) { failures.push('AI 在还能出牌的时候返回了 null'); break; }

    const before = game.hands[seat].length;
    const r = play(game, seat, move);
    if (!r.ok) {
      failures.push(`AI 出了非法着法（座位 ${seat}）：${r.reason}\n    ${JSON.stringify(move)}`);
      break;
    }
    if (move.kind === 'play' && game.hands[seat].length !== before - move.cards.length) {
      failures.push('出牌张数与手牌减少量对不上');
    }
    if (++stats.steps > MAX_STEPS) { failures.push(`一局超过 ${MAX_STEPS} 步还没结束`); break; }
  }
  return { game, stats };
}

// ─────────────────────────────────────────────
// 模式一：同挡位自对弈（含叫分与耗时）
// ─────────────────────────────────────────────

function runSameLevel(games, level) {
  const levels = [level, level, level];
  const agg = {
    finished: 0, redeals: 0, landlordWins: 0,
    bySeat: [0, 0, 0], bombs: 0, springs: 0, steps: 0, maxSteps: 0,
    thinkUs: 0, decisions: 0, maxThinkUs: 0,
  };

  for (let i = 0; i < games; i++) {
    const { game, stats } = playOne(levels, undefined);
    agg.thinkUs += stats.thinkUs;
    agg.decisions += stats.decisions;
    const avg = stats.decisions ? stats.thinkUs / stats.decisions : 0;
    if (avg > agg.maxThinkUs) agg.maxThinkUs = avg;
    if (game.phase !== 'finished') continue;

    agg.finished++;
    agg.steps += stats.steps;
    if (stats.steps > agg.maxSteps) agg.maxSteps = stats.steps;
    if (stats.redeal) agg.redeals++;
    agg.bySeat[game.landlord]++;
    if (game.result.winner === 'landlord') agg.landlordWins++;
    agg.bombs += game.result.bombs;
    if (game.result.spring !== 'none') agg.springs++;
  }

  const n = agg.finished || 1;
  console.log(`selfplay: 挡位「${level.name}」 ${games} 局`);
  console.log(`  打到底            ${agg.finished} 局`);
  console.log(`  地主胜 / 农民胜    ${agg.landlordWins} / ${agg.finished - agg.landlordWins}`
    + `（地主胜率 ${((agg.landlordWins / n) * 100).toFixed(1)}%）`);
  console.log(`  流局率            ${((agg.redeals / games) * 100).toFixed(2)}%   ← §5.5 的验收线是 < 5%`);
  console.log(`  三个座位当地主     ${agg.bySeat.join(' / ')}`);
  console.log(`  平均步数           ${(agg.steps / n).toFixed(1)}（最长 ${agg.maxSteps}）`);
  console.log(`  平均炸弹数         ${(agg.bombs / n).toFixed(2)}    春天/反春天 ${agg.springs} 次`);
  console.log(`  每次决策耗时       平均 ${(agg.thinkUs / (agg.decisions || 1) / 1000).toFixed(1)} ms`
    + `（单局平均最慢 ${(agg.maxThinkUs / 1000).toFixed(1)} ms，thinkMs ${level.thinkMs}）`);

  return {
    finished: agg.finished === games,
    redeal: agg.redeals / games < 0.05,
    seats: agg.bySeat.every((c) => c > 0),
    both: agg.landlordWins > 0 && agg.landlordWins < agg.finished,
  };
}

// ─────────────────────────────────────────────
// 模式二：强度对照（座位 0 固定当地主）
// ─────────────────────────────────────────────

function runAB(landlordLevel, farmerLevel, games) {
  const levels = [landlordLevel, farmerLevel, farmerLevel];
  let finished = 0;
  let landlordWins = 0;

  for (let i = 0; i < games; i++) {
    const { game } = playOne(levels, 0);
    if (game.phase !== 'finished') continue;
    finished++;
    if (game.result.winner === 'landlord') landlordWins++;
  }

  const rate = finished ? (landlordWins / finished) * 100 : 0;
  const brief = (l) => `${l.name}(采样${l.samples}/深度${l.searchDepth}/宽${l.innerWidth}`
    + `/候选${l.maxCandidates}/噪声${l.noise})`;
  console.log(`强度对照：地主「${brief(landlordLevel)}」 vs 农民「${brief(farmerLevel)}」 ${games} 局`);
  console.log(`  打到底      ${finished} 局`);
  console.log(`  地主胜率    ${rate.toFixed(1)}%（${landlordWins} / ${finished}）`);
  console.log('  → 这个数越小，说明农民那一方越强');

  return { finished: finished === games, rate, finishedCount: finished };
}

// ─────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────

/**
 * 对照用的"贪心基线"：**拿「高级」的全部参数，只把 PIMC 与搜索关掉**。
 *
 * 不能直接拿 `easy` 当基线 —— 它还带着 `cooperate: false` 与更大的噪声，
 * 那样测出来的差异分不清是 PIMC 的功劳还是"会不会配合"的功劳。
 * 只翻 `samples` / `searchDepth` 这两个开关，才是干净的对照（§11.4c 的同一手法）。
 */
function baselineOf(level) {
  return { ...level, id: 'greedy', name: '贪心基线', samples: 1, searchDepth: 0, innerWidth: 0 };
}

function resolveLevel(id, reference) {
  if (!id) return baselineOf(reference);
  if (id === 'greedy' || id === 'base') return baselineOf(reference);
  return findLevel(id);
}

if (args[0] === 'ab') {
  const ref = findLevel(args[1] || 'hard');
  const lvL = resolveLevel(args[1], findLevel('hard'));
  const lvF = resolveLevel(args[2], ref);
  const games = Number(args[3]) || 200;
  const r = runAB(lvL, lvF, games);
  console.log('');
  if (failures.length) {
    for (const f of failures.slice(0, 10)) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log(`  ${r.finished ? '✓' : '✗'} 每局都能打到底`);
  process.exit(r.finished ? 0 : 1);
} else {
  const games = Number(args[0]) || 300;
  const level = findLevel(args[1] || 'medium');
  const r = runSameLevel(games, level);
  console.log('');
  if (failures.length) {
    for (const f of failures.slice(0, 10)) console.log('  ✗ ' + f);
    if (failures.length > 10) console.log(`  …还有 ${failures.length - 10} 条`);
    process.exit(1);
  }
  const checks = [
    ['每局都能打到底', r.finished],
    ['流局率 < 5%（§5.5 验收线）', r.redeal],
    ['三个座位都当过地主', r.seats],
    ['两侧都赢过', r.both],
  ];
  let bad = 0;
  for (const [name, okFlag] of checks) {
    console.log(`  ${okFlag ? '✓' : '✗'} ${name}`);
    if (!okFlag) bad++;
  }
  process.exit(bad ? 1 : 0);
}
