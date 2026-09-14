#!/usr/bin/env node
/**
 * 结构校验工具。
 *
 * 为什么需要它：js/patterns.js 里的坐标是手抄的，多一个少一个细胞，
 * 结构就会从"飞船"变成"一团糊"，而且肉眼很难发现。这个脚本在无限大网格上
 * 模拟若干代，检测最小周期与整体平移量，据此判断每个结构到底是什么东西，
 * 顺便和声明的 period / category 交叉验证。
 *
 * 用法：
 *
 *   node conway-life-game/tools/verify-patterns.mjs
 *       校验 js/patterns.js 里的全部结构。有任何一处对不上就以非 0 退出码结束。
 *
 *   node conway-life-game/tools/verify-patterns.mjs --grid
 *       从标准输入读若干 ASCII 图形（O / # / * 表示活细胞，其它字符表示死细胞，
 *       图形之间用空行隔开），逐个判定。抄新结构坐标之前，先用这个试形状最省事。
 *
 *       PowerShell 示例：
 *         @"
 *         .O..O
 *         O....
 *         O...O
 *         OOOO.
 *         "@ | node conway-life-game/tools/verify-patterns.mjs --grid
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS_PATH = resolve(HERE, '../js/patterns.js');

// 最多模拟多少代。长寿者（R-五连块要 1103 代）会超出这个上限，属于正常情况。
const MAX_PERIOD = 220;

// ---------------------------------------------------------------- 演化

function step(cells) {
  const live = new Set();
  for (const [x, y] of cells) live.add(`${x},${y}`);

  const counts = new Map();
  for (const [x, y] of cells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const key = `${x + dx},${y + dy}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  const out = [];
  for (const [key, n] of counts) {
    const alive = live.has(key);
    if (alive ? n === 2 || n === 3 : n === 3) {
      const comma = key.indexOf(',');
      out.push([Number(key.slice(0, comma)), Number(key.slice(comma + 1))]);
    }
  }
  return out;
}

function stepN(cells, n) {
  let cur = cells;
  for (let i = 0; i < n; i++) cur = step(cur);
  return cur;
}

function bounds(cells) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 平移到包围盒左上角，并排好序，作为"形状指纹" */
function shapeKey(cells) {
  const b = bounds(cells);
  return cells
    .map(([x, y]) => [x - b.minX, y - b.minY])
    .sort((p, q) => p[1] - q[1] || p[0] - q[0])
    .map((p) => p.join(','))
    .join(';');
}

const KIND_LABEL = {
  still: '静物',
  oscillator: '振荡器',
  spaceship: '飞船',
  died: '消亡',
  unstable: '未稳定',
  empty: '空',
};

/**
 * 在无限大网格上模拟，找出最小周期和整体平移量。
 * @returns {{kind:string, period:number|null, dx:number, dy:number, generations:number}}
 */
function analyze(start) {
  if (start.length === 0) return { kind: 'empty', period: null, dx: 0, dy: 0, generations: 0 };

  const seen = new Map([[shapeKey(start), 0]]);
  let cur = start;

  for (let g = 1; g <= MAX_PERIOD; g++) {
    cur = step(cur);
    if (cur.length === 0) return { kind: 'died', period: null, dx: 0, dy: 0, generations: g };

    const key = shapeKey(cur);
    if (!seen.has(key)) {
      seen.set(key, g);
      continue;
    }

    // 形状复现，说明进入循环。再用包围盒位置判断有没有整体平移。
    const first = seen.get(key);
    const before = bounds(stepN(start, first));
    const now = bounds(cur);
    const dx = now.minX - before.minX;
    const dy = now.minY - before.minY;
    const period = g - first;
    const kind = dx !== 0 || dy !== 0 ? 'spaceship' : period === 1 ? 'still' : 'oscillator';
    return { kind, period, dx, dy, generations: g };
  }

  return { kind: 'unstable', period: null, dx: 0, dy: 0, generations: MAX_PERIOD };
}

// ---------------------------------------------------------------- 输出辅助

/** 中文字符占两个字符宽，直接用 padEnd 会错位 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u1100-\uFFFF]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, width, align = 'left') {
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

function describe(result) {
  const { kind, period, dx, dy } = result;
  switch (kind) {
    case 'still':
      return '静物';
    case 'oscillator':
      return `振荡器 周期${period}`;
    case 'spaceship':
      return `飞船 周期${period} 位移${dx > 0 ? '+' : ''}${dx},${dy > 0 ? '+' : ''}${dy}`;
    case 'died':
      return `第 ${result.generations} 代消亡`;
    case 'unstable':
      return `未在 ${MAX_PERIOD} 代内稳定`;
    default:
      return KIND_LABEL[kind] || kind;
  }
}

// ---------------------------------------------------------------- 模式一：校验 patterns.js

async function verifyPatterns() {
  const mod = await import(pathToFileURL(PATTERNS_PATH).href);
  console.log(`校验 ${relative(process.cwd(), PATTERNS_PATH)}\n`);

  // 分类声明与实测行为的对应关系，用来抓"抄错导致性质变了"的情况
  const EXPECTED_KIND = {
    'still-life': 'still',
    oscillator: 'oscillator',
    spaceship: 'spaceship',
  };

  let failed = 0;
  const rows = [];

  for (const p of mod.PATTERNS) {
    const result = analyze(p.cells);
    const box = bounds(p.cells);
    const problems = [];

    if (box.width !== p.width || box.height !== p.height) {
      problems.push(`声明尺寸 ${p.width}x${p.height} 与实际 ${box.width}x${box.height} 不符`);
    }
    if (p.period != null && result.period != null && result.period !== p.period) {
      problems.push(`声明周期 ${p.period} 与实际 ${result.period} 不符`);
    }
    const expected = EXPECTED_KIND[p.category];
    if (expected && result.kind !== expected) {
      problems.push(`分类是「${p.category}」，但实测是「${describe(result)}」`);
    }
    if (problems.length) failed++;

    rows.push({
      id: p.id,
      name: p.name,
      cells: p.cells.length,
      size: `${box.width}x${box.height}`,
      verdict: describe(result),
      problems,
    });
  }

  const idW = Math.max(...rows.map((r) => displayWidth(r.id))) + 2;
  const nameW = Math.max(...rows.map((r) => displayWidth(r.name))) + 2;

  for (const r of rows) {
    const line =
      `  ${pad(r.id, idW)}${pad(r.name, nameW)}${pad(String(r.cells), 5, 'right')} cells  ` +
      `${pad(r.size, 8)}${r.verdict}`;
    console.log(r.problems.length ? `${line}\n      ✗ ${r.problems.join('；')}` : line);
  }

  console.log(
    failed === 0
      ? `\n共 ${rows.length} 个结构，全部通过`
      : `\n共 ${rows.length} 个结构，有 ${failed} 处需要修正`
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 模式二：判定 stdin 里的 ASCII 图形

function parseGrids(text) {
  return text
    .replace(/\r\n/g, '\n')
    // 去掉 BOM。PowerShell 把字符串管道喂给原生程序时会按 $OutputEncoding 编码，
    // Win 上默认是带 preamble 的 UTF8Encoding，于是输入最前面多出一个 EF BB BF。
    // 它本身不是活细胞，但会占掉第 0 列，把首行整体顶偏一格。
    .replace(/\uFEFF/g, '')
    .split(/\n[ \t]*\n/)
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const cells = [];
      lines.forEach((line, y) => {
        for (let x = 0; x < line.length; x++) {
          const ch = line[x];
          if (ch === 'O' || ch === 'o' || ch === '#' || ch === '*') cells.push([x, y]);
        }
      });
      return { lines, cells };
    })
    .filter((g) => g.cells.length > 0);
}

async function verifyGrids() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const grids = parseGrids(Buffer.concat(chunks).toString('utf8'));

  if (grids.length === 0) {
    console.error('标准输入里没读到有效的 ASCII 图形（活细胞请用 O / # / * 表示）');
    process.exitCode = 1;
    return;
  }

  grids.forEach((g, i) => {
    const box = bounds(g.cells);
    const result = analyze(g.cells);
    console.log(`#${i + 1}  ${box.width}x${box.height}  ${g.cells.length} cells  ->  ${describe(result)}`);
    for (const line of g.lines) console.log(`    ${line}`);
    console.log('');
  });
}

// ---------------------------------------------------------------- 入口

if (process.argv.includes('--grid')) await verifyGrids();
else await verifyPatterns();
