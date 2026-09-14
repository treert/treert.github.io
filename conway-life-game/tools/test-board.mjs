#!/usr/bin/env node
/**
 * board.js 的行为测试：硬边界 / 环绕两种模式。
 * 直接跑 Node 即可，不需要浏览器、不需要装依赖。
 *
 * 用法：node conway-life-game/tools/test-board.mjs
 *
 * 这里测的都是"改 step() 时最容易悄悄弄坏"的地方：
 * 内部演化必须与边界模式无关、环绕落子不能丢细胞、跨接缝的邻居关系要正确。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_PATH = resolve(HERE, '../js/board.js');
const { Board } = await import(pathToFileURL(BOARD_PATH).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

function live(board) {
  const out = [];
  for (let y = 0; y < board.rows; y++) {
    for (let x = 0; x < board.cols; x++) if (board.get(x, y)) out.push([x, y]);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

const GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
const shift = (cells, dx, dy) => cells.map(([x, y]) => [x + dx, y + dy]);

console.log(`测试 ${relative(process.cwd(), BOARD_PATH)}\n`);

// 1. 棋盘内部：两种模式结果必须完全一致
{
  const a = new Board(20, 20, false);
  const b = new Board(20, 20, true);
  a.stamp(GLIDER, 5, 5);
  b.stamp(GLIDER, 5, 5);
  for (let i = 0; i < 4; i++) {
    a.step();
    b.step();
  }
  check('棋盘内部：环绕与硬边界结果一致', live(b), live(a));
  check('滑翔机 4 代后位移 +1,+1', live(a), shift(GLIDER, 6, 6));
}

// 2. 环绕落子：越界部分从对面接回来
{
  const b = new Board(10, 10, true);
  b.stamp(GLIDER, 8, 3);
  check('环绕落子：越界部分从对面接上', live(b), [[9, 3], [0, 4], [0, 5], [8, 5], [9, 5]]);
}

// 3. 硬边界落子：越界部分被裁掉
{
  const b = new Board(10, 10, false);
  b.stamp(GLIDER, 8, 3);
  check('硬边界落子：越界部分被裁掉', live(b), [[9, 3], [8, 5], [9, 5]]);
}

// 4. 环绕落子重叠：同一格只算一次
{
  const b = new Board(4, 4, true);
  const added = b.stamp([[0, 0], [4, 0], [8, 0]], 0, 0);
  check('环绕落子重叠时只算一次', [added, b.population], [1, 1]);
}

// 5. 跨接缝的 blinker：在环绕下是连续的一行，行为等同普通 blinker
{
  const b = new Board(5, 5, true);
  b.set(4, 2, 1);
  b.set(0, 2, 1);
  b.set(1, 2, 1);
  b.step();
  check('跨接缝的 blinker 变成竖排', live(b), [[0, 1], [0, 2], [0, 3]]);
}

// 6. 同样三个格子，硬边界下不构成 blinker
{
  const b = new Board(5, 5, false);
  b.set(4, 2, 1);
  b.set(0, 2, 1);
  b.set(1, 2, 1);
  b.step();
  // (4,2) 和 (0,2) 不相邻，(1,2) 各自只有 1 个邻居，三个全灭
  check('硬边界下同样三格全灭', live(b), []);
}

// 7. 滑翔机在 10x10 环绕棋盘上跑 40 代应精确回到原样
//    （每 4 代位移 +1,+1，40 代正好位移 (10,10) ≡ (0,0)）
{
  const b = new Board(10, 10, true);
  b.stamp(GLIDER, 2, 2);
  const before = live(b);
  for (let i = 0; i < 40; i++) b.step();
  check('滑翔机绕一圈 40 代后回到原样', live(b), before);
  check('绕行过程中种群始终是 5', b.population, 5);
}

// 8. 中途切换 wrap：邻居表必须惰性重建
{
  const b = new Board(5, 5, false);
  b.step(); // 先用硬边界建一次表
  b.clear();
  b.set(4, 2, 1);
  b.set(0, 2, 1);
  b.set(1, 2, 1);
  b.wrap = true;
  b.step();
  check('中途切换 wrap 后邻居表正确重建', live(b), [[0, 1], [0, 2], [0, 3]]);
}

// 9. 两种模式下 200 代的种群轨迹应当分道扬镳（硬边界会撞墙）
{
  const a = new Board(12, 12, false);
  const b = new Board(12, 12, true);
  a.stamp(GLIDER, 9, 9);
  b.stamp(GLIDER, 9, 9);
  for (let i = 0; i < 200; i++) {
    a.step();
    b.step();
  }
  check('200 代后环绕棋盘仍有活细胞', b.population > 0, true);
  check('200 代后两种模式结果不同', JSON.stringify(live(a)) !== JSON.stringify(live(b)), true);
}

// 10. 空棋盘连续演化不应报错，代数照常累加
{
  const b = new Board(8, 8, true);
  for (let i = 0; i < 5; i++) b.step();
  check('空棋盘演化后代数为 5、种群为 0', [b.generation, b.population], [5, 0]);
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
