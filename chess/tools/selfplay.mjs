#!/usr/bin/env node
/**
 * 自对弈冒烟测试。直接跑 Node。
 *
 * 用法：node chess/tools/selfplay.mjs [白方挡位] [黑方挡位] [最大半回合数]
 *   例：node chess/tools/selfplay.mjs novice easy 120
 *
 * 这不是单元测试（搜索结果依赖时间，断言不稳定），而是**端到端冒烟**：
 * 让两个挡位真下一盘，检查全程着法合法、每一步都在时间预算内、对局能正常结束。
 *
 * 它管的是**组合状态** —— 几百手真实对局里才会出现的局面（吃过路兵的同时暴露王、
 * 易位权边角、升变后立刻被将军…），单测按构造覆盖不到。
 * 改动着法生成、评估或搜索之后建议跑一次（象棋那边靠它抓到过两个真 bug）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN, LEVELS } = await load('config.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');
const { createGame, playMove, currentFen, evaluateStatus, sideToMove, legalMoves } = await load('game.js');
const En = await load('engine.js');

const whiteId = process.argv[2] || 'novice';
const blackId = process.argv[3] || 'easy';
const maxPlies = Number(process.argv[4] || 160);

const levelOf = (id) => LEVELS.find((l) => l.id === id) || LEVELS[0];
const whiteLv = levelOf(whiteId);
const blackLv = levelOf(blackId);

// 双人对弈模式：走子全由这里派发，不走 UI 也不走 Worker
const game = createGame({ twoPlayer: true });

/** 终局类型 → 中文。**必须在循环之前声明** —— 循环在模块求值时就会用到它 */
const END_TEXT = {
  checkmate: '将死',
  stalemate: '逼和',
  fifty: '50 步判和',
  repetition: '三次重复判和',
  insufficient: '子力不足判和',
};

const problems = [];
let plies = 0;
let slow = 0;

console.log(`自对弈：白=${whiteLv.name} 黑=${blackLv.name}，上限 ${maxPlies} 个半回合\n`);
console.log('（每行：半回合号 方 SAN 搜索信息）');

while (plies < maxPlies) {
  const status = evaluateStatus(game);
  if (status.type !== 'playing') {
    console.log(`\n第 ${plies} 个半回合：${END_TEXT[status.type] || status.type}`
      + `${status.winner ? `（${status.winner === 1 ? '白' : '黑'}方胜）` : ''}`);
    if (!END_TEXT[status.type]) problems.push(`未知的终局类型：${status.type}`);
    break;
  }

  const side = sideToMove(game);
  const lv = side === 1 ? whiteLv : blackLv;
  const fen = currentFen(game);

  const result = En.search(fen, lv.id);
  if (!result) {
    // 上层判定为 playing，引擎却说没有着法 —— 两边必须一致
    problems.push(`第 ${plies + 1} 手：状态是 playing，引擎却返回空着法`);
    break;
  }

  // **按「起点 - 终点 - 升变」比，不能直接比整数**：着法编码里还带着
  // 易位 / 吃过路兵 / 双步前进的标记位，而引擎只回 from/to/promo
  //（game.js 的 canonicalMove 也是这么比的，playMove 会把标记补齐）
  const moveKey = (m) => `${Ru.moveFrom(m)}-${Ru.moveTo(m)}-${Ru.movePromo(m)}`;
  const legal = new Set(legalMoves(game).map(moveKey));
  const move = Ru.encodeMove(result.from, result.to, result.promo);
  if (!legal.has(moveKey(move))) {
    problems.push(`第 ${plies + 1} 手：${side === 1 ? '白' : '黑'}方引擎返回了非法着法 `
      + `${Pos.squareName(result.from)}${Pos.squareName(result.to)}`
      + `${result.promo ? `=${result.promo}` : ''}`);
    break;
  }
  if (result.timeMs > lv.timeLimitMs + 400) slow++;

  const played = playMove(game, move);
  if (!played.ok) {
    problems.push(`第 ${plies + 1} 手：playMove 拒绝了自己的合法着法（${played.reason}）`);
    break;
  }

  plies++;
  const mover = side === 1 ? '白' : '黑';
  const eaten = game.moves[plies - 1].captured !== 0 ? ' 吃' : '  ';
  const mark = result.blundered ? ' [失误]' : '';
  console.log(`${String(plies).padStart(3)}. ${mover} ${game.moves[plies - 1].san.padEnd(8)}${eaten} `
    + `${String(result.depth).padStart(2)}层 ${String(result.score).padStart(7)}分 `
    + `${String(result.nodes).padStart(8)}节点 ${String(result.timeMs).padStart(5)}ms${mark}`);
}

// === 结果检查 ===
{
  const status = evaluateStatus(game);
  const stat = {
    moves: plies,
    captures: game.moves.filter((m) => m.captured !== 0).length,
    castling: game.moves.filter((m) => Ru.moveFlag(m.move) === Ru.FLAG_CASTLE).length,
    enPassant: game.moves.filter((m) => Ru.moveFlag(m.move) === Ru.FLAG_EP).length,
    promotions: game.moves.filter((m) => Ru.movePromo(m.move) !== 0).length,
  };
  console.log(`\n共 ${plies} 个半回合：吃子 ${stat.captures}、易位 ${stat.castling}、`
    + `吃过路兵 ${stat.enPassant}、升变 ${stat.promotions}`);
  console.log(`终局：${END_TEXT[status.type] || status.type}`);

  if (plies < maxPlies) {
    // 正常结束（不是被上限截断）—— 终局类型必须是已知的那几种
    if (!END_TEXT[status.type]) problems.push(`对局结束时给了未知状态：${status.type}`);
  } else {
    console.log('（走到上限还没结束，这对冒烟来说也是正常结果）');
  }

  // FEN 快照必须能重放（走子层与规则层对同一盘棋的理解要一致）
  let pos = Pos.parseFen(game.initialFen);
  let mismatch = -1;
  for (let i = 0; i < game.moves.length; i++) {
    pos = Ru.makeMove(pos, game.moves[i].move).pos;
    if (Pos.toFen(pos) !== game.moves[i].fenAfter) { mismatch = i; break; }
  }
  if (mismatch >= 0) problems.push(`第 ${mismatch + 1} 手的 FEN 快照与重放结果不一致`);

  if (slow) problems.push(`${slow} 手超出了挡位的时间预算`);
  if (plies === 0) problems.push('一步都没走');

  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(`\n${problems.length === 0 ? '冒烟通过：全程着法合法、状态自洽' : `${problems.length} 处问题`}`);
}
process.exit(problems.length === 0 ? 0 : 1);
