#!/usr/bin/env node
/**
 * life-format.js 的单元测试：Life 1.06 的解析与生成。
 *
 * 用法：node conway-life-game/tools/test-life-format.mjs
 *
 * 重点覆盖两类容易出问题的地方：
 *   1. 头行容错 —— 文件可能带 BOM、CRLF，或用管道喂进来时首行被塞了不可见字节，
 *      精确比较会莫名其妙失败，所以解析用的是"包含"而不是"相等"。
 *   2. 坏输入要给出能看懂的错误，而不是静默算错。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMAT_PATH = resolve(HERE, '../js/life-format.js');
const { parseLife, formatLife } = await import(pathToFileURL(FORMAT_PATH).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

console.log(`测试 ${relative(process.cwd(), FORMAT_PATH)}\n`);

// 1. 正常往返
{
  const cells = [[3, 4], [0, 0], [1, 0], [10, 2]];
  const text = formatLife(cells);
  check('导出：头行正确', text.split('\n')[0], '#Life 1.06');
  check('导出：按行优先排序', text.trim().split('\n').slice(1), ['0 0', '1 0', '10 2', '3 4']);
  const back = parseLife(text);
  check('往返：解析成功', back.ok, true);
  check('往返：文本完全一致', formatLife(back.cells), text);
}

// 2. 空棋盘
{
  const text = formatLife([]);
  check('空棋盘只输出头行', text, '#Life 1.06\n');
  check('空文件解析失败并给出提示', parseLife(text).ok, false);
}

// 3. 头行容错：BOM / CRLF / 前后空白
{
  const body = '#Life 1.06\n1 2\n3 4\n';
  check('容忍 UTF-8 BOM', parseLife('\uFEFF' + body).ok, true);
  check('容忍 CRLF', parseLife(body.replace(/\n/g, '\r\n')).cells, [[1, 2], [3, 4]]);
  check('容忍头行尾随空格', parseLife('#Life 1.06 \n1 2\n').ok, true);
}

// 4. 头行不对
{
  check('缺头行时报错', parseLife('1 2\n3 4\n').ok, false);
  check('头行版本不对时报错', parseLife('#Life 1.05\n1 2\n').ok, false);
}

// 5. 各种坏输入
{
  check('奇数个数字', parseLife('#Life 1.06\n1 2\n3\n').ok, false);
  check('非整数坐标', parseLife('#Life 1.06\n1 2\n3 x\n').ok, false);
  check('小数坐标', parseLife('#Life 1.06\n1.5 2\n').ok, false);
  check('只有头行', parseLife('#Life 1.06\n').ok, false);
  check('错误信息包含问题内容', parseLife('#Life 1.06\nfoo bar\n').error.includes('foo bar'), true);
}

// 6. 负坐标（C++ 版用的就是 -19..19）
{
  const r = parseLife('#Life 1.06\n-19 -19\n0 0\n19 19\n');
  check('支持负坐标', r.cells, [[-19, -19], [0, 0], [19, 19]]);
  check('负坐标包围盒', [r.bounds.minX, r.bounds.minY, r.bounds.width, r.bounds.height], [-19, -19, 39, 39]);
}

// 7. 注释行、空行、一行多个坐标
{
  const r = parseLife('#Life 1.06\n# 这是注释\n\n1 2 3 4\n\n# 又一行注释\n5 6\n');
  check('跳过注释与空行，支持一行多个坐标', r.cells, [[1, 2], [3, 4], [5, 6]]);
}

// 8. 重复坐标
{
  const r = parseLife('#Life 1.06\n1 2\n1 2\n3 4\n');
  check('重复坐标被去掉并计数', [r.cells.length, r.duplicates], [2, 1]);
}

// 9. 生成的文件能被最朴素的解析器读（模拟 C++ 的 while (is >> x >> y)）
{
  const text = formatLife([[5, 6], [-1, 2], [0, 0]]);
  const lines = text.trim().split('\n');
  const pairs = lines.slice(1).map((l) => l.split(' ').map(Number));
  check('每行都是两个整数，无多余内容', pairs.every((p) => p.length === 2 && p.every(Number.isInteger)), true);
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
