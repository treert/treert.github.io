#!/usr/bin/env node
/**
 * 残局库校验。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/verify-endgames.mjs
 *
 * ## 它查什么
 *
 *   1. FEN 能被解析，且解析后重新生成与原文一致（往返一致）
 *   2. 局面合法（将帅照面 / 士象出界 / 兵在己方底线 / 子力超限 / 非轮走方被将军）
 *   3. 不是已经终局的局面（轮走方得有合法着法）
 *   4. 轮走方不是已经被将军 —— 出题局面不该从「正在被将」开始
 *   5. 字段规范：category / result 是枚举内的值，difficulty 在 1~5，
 *      id 唯一，name / source 非空
 *   6. 子力一致性：result 是「胜」时，先手方的子力价值不应低于对手
 *
 * ## 它刻意不查什么
 *
 * **不校验胜负结论。** 「红先胜」这类标注需要可靠的求解器或权威棋谱，
 * 本模块的引擎（简化评估 + 迭代加深）做不到。
 * 实用残局的结果取自教材定式，经典排局取自《适情雅趣》的性质，逐局未复核。
 * 详见 js/endgames.js 文件头。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, EMPTY, P, RED, PIECE_VALUE, PASSED_PAWN_BONUS } = await load('config.js');
const { parseFen, toFen, yOf } = await load('position.js');
const { isLegalPosition, generateLegalMoves, inCheck } = await load('rules.js');
const { ENDGAMES, CATEGORIES, RESULTS } = await load('endgames.js');

let failed = 0;

/** 先手方（红方）视角的子力价值，兵过河算加分 —— 与 engine.js 的评估口径一致 */
function material(cells, side) {
  let sum = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY || Math.sign(v) !== side) continue;
    const abs = Math.abs(v);
    let val = PIECE_VALUE[abs];
    if (abs === P) {
      const y = yOf(i);
      if (v > 0 ? y <= 4 : y >= 5) val += PASSED_PAWN_BONUS;
    }
    sum += val;
  }
  return sum;
}

function fail(eg, reason) {
  failed++;
  console.log(`FAIL  ${eg.name}  (${eg.id})\n        原因：${reason}`);
}

console.log(`残局库校验：共 ${ENDGAMES.length} 局\n`);

// --- 1. id 唯一 ---
{
  const seen = new Map();
  for (const eg of ENDGAMES) {
    if (seen.has(eg.id)) {
      fail(eg, `id 与「${seen.get(eg.id)}」重复`);
    } else {
      seen.set(eg.id, eg.name);
    }
  }
}

// --- 2~6. 逐局检查 ---
for (const eg of ENDGAMES) {
  const problems = [];

  // 字段规范
  if (!eg.name) problems.push('name 为空');
  if (!eg.source) problems.push('source 为空');
  if (!(eg.category in CATEGORIES)) problems.push(`category「${eg.category}」不在枚举内`);
  if (!(eg.result in RESULTS)) problems.push(`result「${eg.result}」不在枚举内`);
  if (!Number.isInteger(eg.difficulty) || eg.difficulty < 1 || eg.difficulty > 5) {
    problems.push(`difficulty「${eg.difficulty}」不在 1~5`);
  }

  if (problems.length === 0) {
    let pos = null;
    try {
      pos = parseFen(eg.fen);
    } catch (e) {
      problems.push(`FEN 解析失败：${e.message}`);
    }

    if (pos) {
      // FEN 往返一致
      const round = toFen(pos);
      if (round !== eg.fen) problems.push(`FEN 往返不一致：重新生成为「${round}」`);

      // 局面合法
      const legal = isLegalPosition(pos);
      if (!legal.ok) problems.push(`局面不合法：${legal.reason}`);

      // 不是已经终局
      const moves = generateLegalMoves(pos);
      if (moves.length === 0) problems.push('这个局面已经终局了（轮走方无着法可走）');

      // 轮走方不该已经被将军
      if (inCheck(pos.cells, pos.side)) problems.push('轮走方已经被将军，出题局面不该从被将开始');

      // 子力一致性：实用残局里标「胜」时，先手方不该比对手少子。
      //
      // **只对实用残局查这一条。** 经典排局（《适情雅趣》）恰恰以
      // 「红方子力更少、靠连杀取胜」为常态 —— 把它们也拦下来是错的，
      // 第一版就是这么写的，12 局排局被误报。
      if (eg.result === 'win' && eg.category === 'practical') {
        const mine = material(pos.cells, pos.side);
        const theirs = material(pos.cells, -pos.side);
        if (mine < theirs) {
          problems.push(`标注为「胜」，但先手方子力 ${mine} 低于对手 ${theirs}，多半是强弱写反了`);
        }
      }
    }
  }

  if (problems.length === 0) {
    console.log(`ok    ${eg.name}  (${eg.id})`);
  } else {
    for (const p of problems) fail(eg, p);
  }
}

// --- 统计 ---
console.log('');
const byCategory = new Map();
for (const eg of ENDGAMES) byCategory.set(eg.category, (byCategory.get(eg.category) || 0) + 1);
for (const [cat, n] of byCategory) console.log(`${CATEGORIES[cat] || cat}：${n} 局`);

const byResult = new Map();
for (const eg of ENDGAMES) byResult.set(eg.result, (byResult.get(eg.result) || 0) + 1);
console.log([...byResult].map(([r, n]) => `${RESULTS[r] || r} ${n} 局`).join('　'));

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
