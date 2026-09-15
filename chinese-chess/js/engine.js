/**
 * AI 引擎：评估 + 搜索。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 对外只有一个入口 search()，内部结构（置换表、着法排序、静态搜索）都可以换，
 * 不影响调用方。这是「方便后续优化」的落点。
 */

import { CELLS, EMPTY, P, RED, PIECE_VALUE, PASSED_PAWN_BONUS } from './config.js';
import { yOf } from './position.js';

/**
 * 静态评估：只算子力和兵是否过河。
 *
 * 返回**轮走方视角**的分值 —— 负极大值搜索要求「分数总是对当前走子方有利为正」。
 *
 * 刻意不加机动性、位置表这类项：
 *   - 机动性需要生成全部着法，而评估在叶节点被调用上百万次，等于把搜索成本翻倍
 *   - 位置表要维护 7 × 90 格的数据，是独立的一块手工维护点，留到棋力不够时再加
 * 想提升棋力，正确的下一步是加 90 格位置表（O(1) 查表），不是加任何需要生成着法的项。
 */
export function evaluate(cells, side) {
  let score = 0; // 先按红方视角累加
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const abs = Math.abs(v);
    let value = PIECE_VALUE[abs];
    if (abs === P) {
      const y = yOf(i);
      const crossed = v > 0 ? y <= 4 : y >= 5;
      if (crossed) value += PASSED_PAWN_BONUS;
    }
    score += v > 0 ? value : -value;
  }
  return side === RED ? score : -score;
}
