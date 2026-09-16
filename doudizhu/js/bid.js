/**
 * 叫分决策（design.md §5.5、§6.1）。
 *
 * 纯逻辑，不碰 DOM、不碰 localStorage。AI 与真人共用同一套评分：
 * 真人的「托管叫分」按钮走的就是 `decideBid`，AI 走 `decideBid` 时传自己的挡位。
 *
 * 叫分的规则由 `game.js` 管（顺序、只能叫更高、叫到 3 分立即结束、全不叫则重发），
 * 这里只管"我该叫几分"。
 *
 * **叫分阶段看不到底牌**，所以这里只接受 hand，不接受任何局面信息 ——
 * 签名本身就挡住了"偷看底牌"这条路（§3.1）。
 */

import { BID_NONE, BID_MAX, BID_THRESHOLDS, BID_NOISE_SCALE } from './config.js';
import { handScore } from './evaluate.js';

/** `handScore` → 想叫的分（0 = 不叫）。阈值表见 config.js */
export function bidForScore(score) {
  let want = BID_NONE;
  for (const t of BID_THRESHOLDS) if (score >= t.min) want = t.score;
  return want;
}

/**
 * AI（或者托管叫分）的决定。
 *
 * @param hand        我的手牌（17 张）
 * @param level       `LEVELS` 里的一项；`noise` 会按 `BID_NOISE_SCALE` 缩放后加到评分上
 * @param rng         () => [0,1)，注入以便复现
 * @param currentBest 场上当前的最高分（叫分必须**严格大于**它，否则只能不叫）
 * @returns 0（不叫）或 1..3
 */
export function decideBid(hand, level, rng, currentBest = BID_NONE) {
  // 双向噪声：弱挡位更容易叫错，但**不能偏到倾向不叫那一边** ——
  // 否则弱挡位会把流局率拉爆（§5.5）。rng 对称取 [-1, 1] 就保证了这一点。
  const noise = (rng() * 2 - 1) * ((level ? level.noise : 0) / BID_NOISE_SCALE);
  let want = bidForScore(handScore(hand) + noise);

  // 叫不过当前最高分就只能不叫（叫平也不允许）
  if (want <= currentBest) want = BID_NONE;
  if (want > BID_MAX) want = BID_MAX;
  return want;
}

/**
 * 叫分合法性的唯一判定 —— `game.js` 与界面按钮的置灰都用它，
 * 免得"界面上能点"和"状态机接受"两套规则各写一遍、慢慢长歪。
 */
export function isLegalBid(score, currentBest) {
  if (!Number.isInteger(score) || score < BID_NONE || score > BID_MAX) {
    return { ok: false, reason: `叫分只能是 0~${BID_MAX}` };
  }
  if (score === BID_NONE) return { ok: true, reason: '' };
  if (score <= currentBest) {
    return { ok: false, reason: `必须高于 ${currentBest} 分` };
  }
  return { ok: true, reason: '' };
}

/** 界面按这个把按钮置灰：返回这一手能点哪些分 */
export function legalBids(currentBest) {
  const out = [BID_NONE];
  for (let s = 1; s <= BID_MAX; s++) if (s > currentBest) out.push(s);
  return out;
}
