#!/usr/bin/env node
/**
 * 演化性能基准。
 *
 * 用法：node conway-life-game/tools/bench-board.mjs
 *
 * 用的是 30% 随机填充——棋盘一直处于混沌状态，没有大片空白可以跳过，
 * 属于 board.step() 的最坏情况。想加"活跃包围盒裁剪"之类的优化时，
 * 先跑这个留个基线。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const { Board } = await import(pathToFileURL(resolve(HERE, '../js/board.js')).href);

function bench(cols, rows, wrap, density, gens) {
  const b = new Board(cols, rows, wrap);
  b.fillRandom(density);
  b.step(); // 预热，别把 JIT 的首次编译算进去
  const t0 = performance.now();
  for (let i = 0; i < gens; i++) b.step();
  const dt = performance.now() - t0;
  return { gps: Math.round(gens / (dt / 1000)), ms: +(dt / gens).toFixed(3) };
}

console.log('30% 随机填充，每组 300 代\n');
for (const [cols, rows] of [[62, 56], [160, 120], [240, 160]]) {
  for (const wrap of [false, true]) {
    const r = bench(cols, rows, wrap, 0.3, 300);
    console.log(
      `  ${String(cols + 'x' + rows).padEnd(9)} wrap=${String(wrap).padEnd(5)} ` +
        `${String(r.gps).padStart(6)} 代/秒   ${r.ms} ms/代`
    );
  }
}

console.log('\n参考：速度档位最高 200 代/秒，单帧上限 40 代，所以最大棋盘也绰绰有余。');
