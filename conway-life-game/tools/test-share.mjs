#!/usr/bin/env node
/**
 * share.js 的单元测试：URL 分享的编解码。
 *
 * 用法：node conway-life-game/tools/test-share.mjs
 *
 * 最要紧的是往返一致——编码再解码必须逐格相同。另外还要挡住坏输入：
 * 别人手搓一个链接、或者链接被聊天工具截断，都不能让页面崩掉或算错。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARE_PATH = resolve(HERE, '../js/share.js');
const { encodeBoard, decodeBoard } = await import(pathToFileURL(SHARE_PATH).href);
const { Board } = await import(pathToFileURL(resolve(HERE, '../js/board.js')).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

/** 编码再解码，返回解码结果（失败返回 null） */
function roundTrip(board) {
  return decodeBoard(encodeBoard(board));
}

/** 逐格比对两个棋盘的内容 */
function sameLive(a, b) {
  if (!b || a.cols !== b.cols || a.rows !== b.rows) return false;
  for (let i = 0; i < a.cells.length; i++) {
    if (a.cells[i] !== b.cells[i]) return false;
  }
  return true;
}

console.log(`测试 ${relative(process.cwd(), SHARE_PATH)}\n`);

// 1. 往返一致：随机填充、跑过若干代的棋盘
{
  const b = new Board(62, 40);
  b.fillRandom(0.3);
  check('随机棋盘往返一致', sameLive(b, roundTrip(b)), true);

  for (let i = 0; i < 20; i++) b.step();
  check('演化 20 代后仍往返一致', sameLive(b, roundTrip(b)), true);
}

// 2. 空棋盘
{
  const b = new Board(40, 30);
  const back = roundTrip(b);
  check('空棋盘能解回来', back !== null, true);
  check('空棋盘没有任何活细胞', back.cells.some((v) => v !== 0), false);
}

// 3. wrap 标志
{
  const on = new Board(20, 15, true);
  const off = new Board(20, 15, false);
  on.stamp([[0, 0]], 0, 0);
  off.stamp([[0, 0]], 0, 0);
  check('wrap=true 能带回来', roundTrip(on).wrap, true);
  check('wrap=false 能带回来', roundTrip(off).wrap, false);
}

// 4. 边界位置的细胞：下标 0、最后一格、四角
{
  const b = new Board(8, 6);
  const corners = [[0, 0], [7, 0], [0, 5], [7, 5]];
  for (const [x, y] of corners) b.set(x, y, 1);
  const back = roundTrip(b);
  check('四个角和首尾格都往返一致', sameLive(b, back), true);
  check('四角确实还活着', corners.map(([x, y]) => back.cells[y * 8 + x]), [1, 1, 1, 1]);
}

// 5. 最坏情况：全满棋盘（差分全是 1，varint 一字节一个）
{
  const b = new Board(30, 20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) b.set(x, y, 1);
  check('全满棋盘往返一致', sameLive(b, roundTrip(b)), true);
}

// 6. 单个细胞在最后一格（下标最大，检验越界判断）
{
  const b = new Board(10, 10);
  b.set(9, 9, 1);
  const back = roundTrip(b);
  check('最后一格往返一致', sameLive(b, back), true);
}

// 7. 坏输入
{
  check('空字符串', decodeBoard(''), null);
  check('只有 #', decodeBoard('#'), null);
  check('版本不对', decodeBoard('#v=2&c=10&r=10'), null);
  check('缺版本', decodeBoard('#c=10&r=10'), null);
  check('缺尺寸', decodeBoard('#v=1&c=10'), null);
  check('尺寸不是数字', decodeBoard('#v=1&c=abc&r=10'), null);
  check('尺寸为 0', decodeBoard('#v=1&c=0&r=10'), null);
  check('尺寸为负', decodeBoard('#v=1&c=-5&r=10'), null);
  check('尺寸超上限', decodeBoard('#v=1&c=2000&r=2000'), null);
  check('base64 损坏', decodeBoard('#v=1&c=10&r=10&d=!!!!'), null);
  check('乱码参数', decodeBoard('#乱七八糟'), null);
}

// 8. 被截断的链接不能崩，也不能解出错误结果
{
  const b = new Board(40, 30);
  b.fillRandom(0.2);
  const hash = encodeBoard(b);
  let crashes = 0;
  let wrong = 0;
  for (let cut = 1; cut < hash.length; cut++) {
    let back;
    try {
      back = decodeBoard(hash.slice(0, cut));
    } catch {
      crashes++;
      continue;
    }
    // 截断后要么解不出来，要么解出来的必须比原棋盘"少"细胞（绝不能凭空多出来）
    if (back) {
      let extra = 0;
      for (let i = 0; i < back.cells.length; i++) {
        if (back.cells[i] && !b.cells[i]) extra++;
      }
      if (extra > 0) wrong++;
    }
  }
  check('任意位置截断都不抛异常', crashes, 0);
  check('任意位置截断都不会凭空多出细胞', wrong, 0);
}

// 9. 编码长度：稀疏该短，密集该长
{
  const sparse = new Board(240, 160);
  sparse.stamp([[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]], 100, 80); // 一架滑翔机
  const dense = new Board(240, 160);
  dense.fillRandom(0.3);

  const sparseLen = encodeBoard(sparse).length;
  const denseLen = encodeBoard(dense).length;
  check('滑翔机的链接足够短（< 100 字符）', sparseLen < 100, true);
  console.log(`        滑翔机 ${sparseLen} 字符，30% 随机填充 ${denseLen} 字符`);
}

// 10. 同一棋盘编码结果稳定（同样输入同样输出，方便比对链接）
{
  const b = new Board(30, 20);
  b.fillRandom(0.25);
  check('编码结果可重现', encodeBoard(b), encodeBoard(b));
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
