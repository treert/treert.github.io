#!/usr/bin/env node
/**
 * 自对弈冒烟测试。直接跑 Node。
 *
 * 用法：node chinese-chess/tools/selfplay.mjs [红方挡位] [黑方挡位] [最大半回合数]
 *   例：node chinese-chess/tools/selfplay.mjs easy medium 120
 *
 * 这不是单元测试（搜索结果依赖时间，断言不稳定），而是端到端冒烟：
 * 让两个挡位真下一盘，检查全程着法合法、对局能正常结束、没有死循环。
 * 改动着法生成或搜索后建议跑一次。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN } = await load('config.js');
const { parseFen, toFen, positionSignature, clonePosition } = await load('position.js');
const { generateLegalMoves, gameStatus, isThreefoldRepetition } = await load('rules.js');
const { toNotation } = await load('notation.js');
const { search } = await load('engine.js');

const redLevel = process.argv[2] || 'easy';
const blackLevel = process.argv[3] || 'medium';
const maxPlies = Number(process.argv[4] || 120);

const pos = parseFen(START_FEN);
const signatures = [positionSignature(START_FEN)];
let plies = 0;
let failures = 0;

console.log(`自对弈：红=${redLevel} 黑=${blackLevel} 上限 ${maxPlies} 半回合\n`);

while (plies < maxPlies) {
  const status = gameStatus(pos);
  if (status.type !== 'playing') {
    console.log(`\n第 ${plies} 半回合：${status.type === 'checkmate' ? '将死' : '困毙'}，`
      + `${status.winner === 1 ? '红方' : '黑方'}胜`);
    break;
  }
  if (isThreefoldRepetition(signatures)) {
    console.log(`\n第 ${plies} 半回合：三次重复，判和`);
    break;
  }

  const mover = pos.side === 1 ? '红' : '黑';
  const level = pos.side === 1 ? redLevel : blackLevel;
  const result = search(toFen(pos), level);

  if (!result) { console.log('搜索返回空结果，中止'); failures++; break; }

  const legal = new Set(generateLegalMoves(clonePosition(pos)));
  if (!legal.has(result.move)) {
    console.log(`第 ${plies + 1} 半回合：${mover}方引擎返回了非法着法 ${result.move}`);
    failures++;
    break;
  }

  // 记谱必须在走子**之前**算 —— 判断有没有重子要看走之前的棋盘
  const notation = toNotation(pos, result.move);
  const from = Math.floor(result.move / 90), to = result.move % 90;
  const captured = pos.cells[to];
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;
  signatures.push(positionSignature(toFen(pos)));

  plies++;
  const eaten = captured === 0 ? '  ' : ' 吃';
  const mark = result.blundered ? ' [失误]' : '';
  // 分值也打出来：深度突然变小（比如从 5 掉到 1）时要能一眼看出是不是「找到杀棋」提前停了
  console.log(`${String(plies).padStart(3)}. ${mover} ${notation}${eaten} `
    + `深度${result.depth} 分${String(result.score).padStart(6)} `
    + `${String(result.nodes).padStart(7)}节点 ${result.timeMs}ms${mark}`);
}

console.log(`\n共 ${plies} 半回合${failures ? `，${failures} 处失败` : '，全程着法合法'}`);
process.exit(failures === 0 ? 0 : 1);
