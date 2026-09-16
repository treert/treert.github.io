/**
 * AI 的入口：`decide(view, level, rng)`（design.md §7.4）。
 *
 * 纯逻辑，只接受 `view` —— 拿不到 `game`，所以**物理上看不到别人的手牌**（§3.1）。
 * 它在 Worker 里跑（§7.6），主线程只 `postMessage(view)`，
 * Worker 进程里根本不存在完整的对局状态。
 *
 * 决策分三条路（按代价从低到高）：
 *
 *   1. **一手走完** —— 直接走。比什么搜索都便宜，而且漏了它 AI 看起来像坏了。
 *   2. **贪心**（`samples === 1` 的弱挡位）—— `greedy.js` 打分排序 + 噪声 / 看漏。
 *   3. **PIMC** —— 采样若干个"可能的世界"，每个世界里把每个候选走一遍、
 *      用完全信息搜索估个值，**每个世界投一票给该世界里最好的那个候选**，
 *      最后取票最多的。
 *
 * **为什么是投票而不是"跨世界平均分"**：不同世界的估值尺度不可比
 * （同一个着法在"对手有王炸"的世界里分值天然低）。投票只比较"在同一个世界里
 * 哪个着法最好"，把不可比的量规避掉了。这一点在 future-work 里有对照实验的入口。
 */

import { playsWithCombos, isPass } from '../moves.js';
import { isLegalBid, decideBid as decideBidRaw } from '../bid.js';
import { rankMoves, pickMove } from './greedy.js';
import { sampleWorld } from './sample.js';
import { createState, valueAfterMove, finishNow, newStats } from './search.js';

function moveKey(move) {
  return isPass(move) ? 'pass' : move.cards.join(',');
}

/**
 * 决定出什么。
 *
 * @param view  玩家视角（§4.5）—— 只有我的牌面 + 公开信息
 * @param level `LEVELS` 里的一项
 * @param rng   () => [0,1)，注入以便复现（§11.4 的前提）
 * @param stats 可选的诊断出口（`{candidates, worlds, nodes}`）。**由调用方持有** ——
 *              刻意不做成模块级的量，那会变成"看起来纯、其实带状态"的函数，
 *              正是 §11.4(a) 那条测试要防的东西
 * @returns 着法 `{kind:'play',cards}` / `{kind:'pass'}`，或 null（无着法可选）
 */
export function decide(view, level, rng, stats = null) {
  const last = view.trick.lastPlay ? view.trick.lastPlay.combo : null;
  const passMove = last ? { kind: 'pass' } : null;

  // 诊断量**必须在所有早退之前初始化**。否则调用方看到 `worlds === 0`
  // 时分不清「PIMC 采了 0 个世界」和「根本没走到 PIMC」——
  // 实测里这两种情况混在一起占了近一半的决策次数（见 future-work 的 E10）。
  // `path` 就是把这个区分直接摆出来。
  if (stats) {
    stats.path = 'unknown';
    stats.candidates = 0;
    stats.worlds = 0;
    stats.nodes = 0;
  }

  // —— 1. 一手走完，短路 ——
  const winNow = finishNow(view.myHand, last);
  if (winNow) {
    if (stats) stats.path = 'finish';
    return { kind: 'play', cards: winNow };
  }

  // —— 2. 候选：一次算好，所有世界共用同一份，投票才可比 ——
  const withCombos = playsWithCombos(view.myHand, last);
  if (withCombos.length === 0) {
    // 跟牌时压不过上一手 —— 这个分支比想象中常见
    if (stats) stats.path = 'no-move';
    return passMove;
  }

  const asMoves = withCombos.map((c) => ({ kind: 'play', cards: c.cards }));
  const scored = rankMoves(view, asMoves, level);
  const kept = scored
    .filter((_, i) => i < level.maxCandidates)
    .map((x) => x.move);

  const comboOf = new Map(withCombos.map((c) => [c.cards.join(','), c.combo]));
  const options = kept.map((m) => ({ move: m, combo: comboOf.get(m.cards.join(',')) }));
  if (passMove) options.push({ move: passMove, combo: null });

  if (stats) { stats.candidates = options.length; stats.path = 'greedy'; }

  // —— 3a. 贪心：不做任何"猜牌" ——
  if (!level.samples || level.samples <= 1) {
    return pickMove(rankMoves(view, options.map((o) => o.move), level), level, rng);
  }

  // —— 3b. PIMC ——
  if (stats) stats.path = 'pimc';
  const deadline = Date.now() + (level.thinkMs || 1000);
  const searchStats = newStats();
  const ctx = { deadline, width: level.innerWidth || 1, stats: searchStats };
  const mineIsFarmer = view.role === 'farmer';

  const votes = new Map();
  let worlds = 0;

  for (let i = 0; i < level.samples; i++) {
    // 时间到了就停，用已经投出来的票 —— 这是安全的降级（只是精度下降），
    // 不像超时抛异常那样会把搜索树留在半路（见 search.js 的说明）
    if (Date.now() >= deadline) break;

    const world = sampleWorld(view, rng);
    const base = createState(world, view);
    worlds++;

    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let j = 0; j < options.length; j++) {
      const st = { ...base, hands: base.hands.map((h) => h.slice()) };
      const opt = options[j];
      let v = valueAfterMove(st, view.seat, opt.move, opt.combo, level.searchDepth || 0, ctx);
      // 搜索给的是"地主视角"，换成"我的队伍视角"
      if (mineIsFarmer) v = -v;
      if (v > bestVal) { bestVal = v; bestIdx = j; }
    }
    if (bestIdx >= 0) {
      const k = moveKey(options[bestIdx].move);
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }

  if (stats) { stats.worlds = worlds; stats.nodes = searchStats.nodes; }

  if (votes.size === 0) {
    // 一次都没采成（预算太紧）→ 退回贪心，绝不返回空。
    // 正常参数下走不到这里（i=0 时 deadline 一定还没到），所以它同时是个哨兵：
    // selfplay 里如果 path 出现这个值，说明 thinkMs 被调得太小了。
    if (stats) stats.path = 'pimc-fallback';
    return pickMove(rankMoves(view, options.map((o) => o.move), level), level, rng);
  }

  let winnerKey = null;
  let winnerVotes = -1;
  for (const [k, n] of votes) {
    // 平票时取先出现的（options 已经按贪心分数排过序，所以"先出现"就是"贪心更看好的"）
    if (n > winnerVotes) { winnerVotes = n; winnerKey = k; }
  }

  const chosen = options.find((o) => moveKey(o.move) === winnerKey);
  return chosen ? chosen.move : options[0].move;
}

/**
 * 决定叫几分。叫分的评分与阈值在 `bid.js` / `config.js`，
 * 这里只是把 view 里那份"场上最高分"解析出来，给界面与 Worker 一个统一入口。
 */
export function decideBid(view, level, rng) {
  const best = view.bidding && view.bidding.best ? view.bidding.best.score : 0;
  const want = decideBidRaw(view.myHand, level, rng, best);
  // 双保险：绝不返回一个非法叫分（§11.4b 那类"只出合法牌"的断言同样适用于叫分）
  return isLegalBid(want, best).ok ? want : 0;
}
