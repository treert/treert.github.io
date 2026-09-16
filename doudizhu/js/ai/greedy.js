/**
 * 规则式策略 —— **所有挡位的底座**（design.md §7.4）。
 *
 * 纯逻辑。它只用 `view`，看不到任何人的手牌（§3.1）。就算上层换成了 PIMC，
 * 每个"可能的世界"里也是拿它当兜底策略与叶子估值。
 *
 * 打分是**越小越好**，单位与 `handValue` 一致：
 *
 *   出牌 → 出完之后的手牌估值（手数越少越好）− 出牌张数的一点奖励 + 拆炸弹的惩罚
 *   不要 → 手牌根本没变（估值不变），农民在"队友出的牌"上有额外偏置
 *
 * 有一条**刻意的不对称**：出牌永远比"不要"多得到一点好处（因为手牌确实少了），
 * 所以 AI 不会为了避免出牌而出牌 —— 除非 `cooperate` 的队友偏置压过来。
 */

import { rankCounts, ranksIn, cardsOfRank, removeCards, rankOf } from '../cards.js';
import { handValue } from '../evaluate.js';
import { isPass } from '../moves.js';

/**
 * `LEVELS[].noise`（0~150，与象棋的评估分量纲对齐）映射到 `handValue` 的尺度上。
 * `handValue` 的典型差值是 5~20（一手牌的量级），除 20 之后：
 * 入门 ±7.5（约等于乱出）、初级 ±4、中级 ±1、高级 0。
 */
const NOISE_SCALE = 20;

/** 拆炸弹的惩罚：手里有 4 张同点却只出了其中一部分 */
const SPLIT_BOMB_PENALTY = 30;

/**
 * 「队友出的牌，我该不该压」的偏置（越大越倾向于不要）。
 *
 * **这是基于公开信息的启发式，不是偷看队友的牌**（§3.1）：
 * 用到的只有"上一手是谁出的""他是什么角色""他剩几张"—— 全都是公开信息。
 * 真实规则里队友也不能交流，所以配合只能做到这一步。
 */
function teammateBonus(view, last) {
  if (!last) return 0;
  if (view.role !== 'farmer') return 0;               // 我是地主，没有队友
  const p = view.players[last.seat];
  if (!p || p.role !== 'farmer') return 0;            // 上一手是地主出的（或还没定角色）
  let bonus = 20;                                     // 队友出的牌，默认别压
  if (p.handCount <= 3) bonus += 40;                  // 队友快走完了，坚决别压
  return bonus;
}

export function scoreMove(view, move, level, counts) {
  const last = view.trick.lastPlay ? view.trick.lastPlay.combo : null;

  if (isPass(move)) {
    let s = handValue(view.myHand);
    if (level.cooperate) s -= teammateBonus(view, last);
    return s;
  }

  const after = removeCards(view.myHand, move.cards);
  let s = handValue(after);

  // 一次出的张数多，说明走得更快（手数相同的情况下优先出多的）
  s -= 0.2 * move.cards.length;

  // 首出时轻微偏好小牌：不要一上来就甩 2 和王
  if (!last) s += 0.15 * move.cards.reduce((m, c) => Math.max(m, rankOf(c)), 0);

  // 拆炸弹惩罚
  for (const rank of ranksIn(move.cards)) {
    if (counts[rank] === 4 && cardsOfRank(move.cards, rank).length < 4) {
      s += SPLIT_BOMB_PENALTY;
    }
  }
  return s;
}

/** 把候选着法按分数升序排好（分数小的在前） */
export function rankMoves(view, moves, level) {
  const counts = rankCounts(view.myHand);
  const out = moves.map((move) => ({ move, score: scoreMove(view, move, level, counts) }));
  out.sort((a, b) => a.score - b.score);
  return out;
}

/**
 * 从排好序的候选里挑一个。
 *
 * 两条弱化手段（§7.5）：`blunderRate` 按概率放弃最优着法（模拟看漏），
 * `noise` 给分数加双向扰动（让弱挡位倾向次优着而不是永远最优）。
 * **只剩一个候选时两条都不触发** —— 否则会挑出一个不存在的着法。
 */
export function pickMove(ranked, level, rng) {
  if (!ranked || ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0].move;

  if (level.blunderRate > 0 && rng() < level.blunderRate) {
    const rest = ranked.slice(1);
    return rest[Math.floor(rng() * rest.length)].move;
  }

  const noise = level.noise || 0;
  if (noise <= 0) return ranked[0].move;

  let best = ranked[0].move;
  let bestVal = Infinity;
  for (const { move, score } of ranked) {
    const v = score + (rng() * 2 - 1) * (noise / NOISE_SCALE);
    if (v < bestVal) { bestVal = v; best = move; }
  }
  return best;
}
