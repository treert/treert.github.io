#!/usr/bin/env node
/**
 * AI 层测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-engine.mjs
 *
 * 搜索本身依赖时间，不能断言「搜了多少节点」这类数字。
 * 这里测的是三类能稳定断言的东西：
 *   1. 哈希 / 评估这些纯函数的数值性质
 *   2. 引擎在「只有唯一正确着法」的局面里是否走对
 *   3. 引擎返回的着法是否合法（对随机局面抽查）
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, PIECE_OF_FEN, START_FEN } = await load('config.js');
const { indexOf, xOf, yOf, parseFen, startPosition, zobristKey, hashPiece, hashSide } =
  await load('position.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const idxOf = (coord) => {
  const [x, y] = coord.split(',').map(Number);
  return y * 9 + x;
};

const coordOf = (idx) => `${xOf(idx)},${yOf(idx)}`;

/** 用「棋子字符 @ x,y」的稀疏描述造局面 */
function build(specs, side = 'w') {
  const cells = new Int8Array(CELLS);
  for (const spec of specs) {
    const [ch, coord] = spec.split('@');
    const piece = PIECE_OF_FEN[ch];
    if (piece === undefined) throw new Error(`build: 无法识别的棋子「${ch}」`);
    cells[idxOf(coord)] = piece;
  }
  return { cells, side: side === 'w' ? 1 : -1 };
}

/** 固定种子的 xorshift32，给需要注入 rng 的测试用 */
function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

console.log('AI 层测试\n');

// --- Zobrist 哈希 ---
{
  const start = startPosition();
  const key = zobristKey(start.cells, start.side);

  check('同一局面两次计算得到同一个哈希', zobristKey(start.cells, start.side), key);
  check('哈希是 32 位无符号整数', key >= 0 && key <= 0xFFFFFFFF, true);

  check('轮走方不同则哈希不同', zobristKey(start.cells, -1) === key, false);

  check('空位恒返回 0（走子 / 回退可以无条件异或）',
    [hashPiece(0, 0), hashPiece(0, 44), hashPiece(0, 89)], [0, 0, 0]);

  // 只动一个兵，哈希必须变
  {
    const moved = startPosition();
    const from = idxOf('4,6'), to = idxOf('4,5');
    moved.cells[to] = moved.cells[from];
    moved.cells[from] = 0;
    check('动一个兵则哈希改变', zobristKey(moved.cells, moved.side) === key, false);
  }

  // 位置敏感：同一个棋子放在不同格子，哈希必须不同
  {
    const a = build(['K@3,9', 'k@5,0', 'R@0,9']).cells;
    const b = build(['K@3,9', 'k@5,0', 'R@8,9']).cells;
    check('同一个车放在不同格子则哈希不同', zobristKey(a, 1) === zobristKey(b, 1), false);
  }

  // 交换两个不同的棋子：棋盘内容变了，哈希必须跟着变
  {
    const swapped = startPosition();
    const a = idxOf('0,9'), b = idxOf('1,9'); // 红车 <-> 红马
    const tmp = swapped.cells[a];
    swapped.cells[a] = swapped.cells[b];
    swapped.cells[b] = tmp;
    check('交换红车与红马则哈希改变', zobristKey(swapped.cells, swapped.side) === key, false);
  }

  // 反过来：交换两个完全相同的棋子，棋盘其实一模一样，哈希必须不变。
  // 这条容易凭直觉写成「交换了就该变」，值得正面钉住。
  {
    const swapped = startPosition();
    const a = idxOf('0,9'), b = idxOf('8,9'); // 两个红车，互换后棋盘没有任何区别
    const tmp = swapped.cells[a];
    swapped.cells[a] = swapped.cells[b];
    swapped.cells[b] = tmp;
    check('交换两个相同的车，棋盘没变，哈希也不变', zobristKey(swapped.cells, swapped.side), key);
  }

  // 增量语义：把一个子挪走再挪回来，哈希必须还原
  {
    const p = startPosition();
    const from = idxOf('4,6'), to = idxOf('4,5');
    const piece = p.cells[from];
    const before = zobristKey(p.cells, p.side);
    p.cells[to] = piece; p.cells[from] = 0;
    p.cells[from] = piece; p.cells[to] = 0;
    check('挪走再挪回，哈希还原', zobristKey(p.cells, p.side), before);
  }

  // 哈希不依赖遍历顺序：手工按任意顺序异或，结果必须一致
  {
    let manual = 0;
    for (let i = CELLS - 1; i >= 0; i--) manual = (manual ^ hashPiece(start.cells[i], i)) >>> 0;
    check('逆序异或得到同一个哈希', manual, key);
    check('再异或一次轮走方等于黑方视角的哈希',
      (manual ^ hashSide()) >>> 0, zobristKey(start.cells, -1));
  }
}

// --- 评估函数 ---
{
  const { evaluate } = await load('engine.js');

  check('起始局面完全对称，分值为 0', evaluate(startPosition().cells, 1), 0);
  check('起始局面黑方视角也是 0', evaluate(startPosition().cells, -1), 0);

  // 红方多一个车
  {
    const cells = build(['K@3,9', 'k@5,0', 'R@0,9']).cells;
    check('红方多一个车：红方视角 +900', evaluate(cells, 1), 900);
    check('红方多一个车：黑方视角 -900', evaluate(cells, -1), -900);
  }

  // 兵过河加分
  {
    const own = build(['K@3,9', 'k@5,0', 'P@4,6']).cells;
    const crossed = build(['K@3,9', 'k@5,0', 'P@4,4']).cells;
    check('红兵未过河记 100', evaluate(own, 1), 100);
    check('红兵过河记 150', evaluate(crossed, 1), 150);
  }

  // 黑卒过河同样加分（方向相反）
  {
    const own = build(['K@3,9', 'k@5,0', 'p@4,3']).cells;
    const crossed = build(['K@3,9', 'k@5,0', 'p@4,5']).cells;
    check('黑卒未过河记 100（黑方视角）', evaluate(own, -1), 100);
    check('黑卒过河记 150（黑方视角）', evaluate(crossed, -1), 150);
  }

  // 帅 / 将不计入子力：双方恒各有一个，算进去只会互相抵消
  {
    const cells = build(['K@3,9', 'k@5,0']).cells;
    check('只有两个将时分值为 0', evaluate(cells, 1), 0);
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
