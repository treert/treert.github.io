#!/usr/bin/env node
/**
 * 框选相关纯逻辑的单测：patterns.js 的 extractCells / normalizeCells，
 * 以及 custom-patterns.js 的增删查和坏存档降级。
 *
 * 用法：node conway-life-game/tools/test-custom.mjs
 *
 * custom-patterns.js 依赖 localStorage，这里塞一个内存版桩进去。
 * 注意桩必须在第一次调用之前装好——模块是懒读 localStorage 的（在函数里读），
 * 所以 import 本身不会碰它。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS_PATH = resolve(HERE, '../js/patterns.js');
const CUSTOM_PATH = resolve(HERE, '../js/custom-patterns.js');

const { normalizeCells, extractCells } = await import(pathToFileURL(PATTERNS_PATH).href);
const custom = await import(pathToFileURL(CUSTOM_PATH).href);
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

/** 每个用例开始前把结构库和棋盘都清干净 */
function fresh() {
  localStorage.clear();
  custom.resetCache();
}

console.log(`测试 ${relative(process.cwd(), PATTERNS_PATH)} 的框选工具\n`);

// 1. normalizeCells：平移到 (0,0) 并算出包围盒
{
  check('平移 + 尺寸', normalizeCells([[5, 7], [7, 7], [5, 8]]), {
    cells: [[0, 0], [2, 0], [0, 1]],
    width: 3,
    height: 2,
  });
  check('单格', normalizeCells([[3, 3]]), { cells: [[0, 0]], width: 1, height: 1 });
  check('已经是原点', normalizeCells([[0, 0], [1, 0]]), {
    cells: [[0, 0], [1, 0]],
    width: 2,
    height: 1,
  });
}

console.log('');

// 2. extractCells：矩形框选（含端点）
{
  const b = new Board(10, 10);
  // 在 (2,2) (3,2) (2,3) 放一个 L 形，另外在远处放一个，验证不会被误框进来
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [8, 8]]) b.set(x, y, 1);

  check('框住 L 形', extractCells(b, { x0: 2, y0: 2, x1: 3, y1: 3 }), [[2, 2], [3, 2], [2, 3]]);
  check('端点算在内', extractCells(b, { x0: 8, y0: 8, x1: 8, y1: 8 }), [[8, 8]]);
  check('空区域', extractCells(b, { x0: 0, y0: 0, x1: 1, y1: 1 }), []);
  check('整个棋盘', extractCells(b, { x0: 0, y0: 0, x1: 9, y1: 9 }).length, 4);
  check('顺序按行优先', extractCells(b, { x0: 0, y0: 0, x1: 9, y1: 9 })[0], [2, 2]);
  check('单行区域', extractCells(b, { x0: 2, y0: 2, x1: 3, y1: 2 }), [[2, 2], [3, 2]]);
  check('单列区域', extractCells(b, { x0: 2, y0: 2, x1: 2, y1: 3 }), [[2, 2], [2, 3]]);
}

console.log('');

// 3. 自定义结构：空库
{
  fresh();
  check('空库', custom.all(), []);
  check('空库 count', custom.count(), 0);
  check('查不存在的 id', custom.get('nope'), null);
  check('空库没满', custom.isFull(), false);
}

console.log('');

// 4. 增删查
{
  fresh();
  const p = custom.add('滑翔机', [[5, 5], [6, 6], [4, 7], [5, 7], [6, 7]]);
  check('存进去后能查到', custom.get(p.id) !== null, true);
  check('坐标被归一化', p.cells, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  check('宽高', [p.width, p.height], [3, 3]);
  check('分类是 custom', p.category, 'custom');
  check('count', custom.count(), 1);
  check('名字保留', p.name, '滑翔机');

  check('删除成功', custom.remove(p.id), true);
  check('删除后查不到', custom.get(p.id), null);
  check('删除后 count', custom.count(), 0);
  check('再删一次返回 false', custom.remove(p.id), false);
}

console.log('');

// 5. 名字处理
{
  fresh();
  check('名字去空白', custom.add('  蜂巢  ', [[0, 0], [1, 0]]).name, '蜂巢');
  check('空名字兜底', custom.add('', [[0, 0], [1, 0]]).name, '未命名');
  check('纯空白也算空', custom.add('   ', [[0, 0], [1, 0]]).name, '未命名');
  check('超长截断到 20 字', custom.add('x'.repeat(50), [[0, 0], [1, 0]]).name.length, 20);
  check('没有细胞不存', custom.add('空的', []), null);
  check('这几次之后 count', custom.count(), 4);
}

console.log('');

// 6. id 唯一：同一毫秒内连存两次也不能撞
{
  fresh();
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push(custom.add(`p${i}`, [[0, 0], [i, 0]]).id);
  check('30 个 id 互不相同', new Set(ids).size, 30);
  check('30 个结构都在', custom.count(), 30);
}

console.log('');

// 7. 上限
{
  fresh();
  for (let i = 0; i < custom.MAX; i++) custom.add(`p${i}`, [[0, 0], [i % 5, 0]]);
  check('刚好填满', custom.count(), custom.MAX);
  check('满了', custom.isFull(), true);
  check('满了之后拒绝新增', custom.add('溢出', [[0, 0]]), null);
  custom.remove(custom.all()[0].id);
  check('删一个之后又能存', custom.add('新的', [[0, 0]]).name, '新的');
}

console.log('');

// 8. 坏存档一律降级成空库，不能让页面起不来
{
  const cases = [
    ['JSON 坏了', '{{{'],
    ['不是对象', '123'],
    ['items 不是数组', '{"v":1,"items":{}}'],
    ['items 缺失', '{"v":1}'],
    ['坐标是字符串', '{"v":1,"items":[{"id":"a","name":"x","cells":[["1","2"]]}]}'],
    ['坐标是小数', '{"v":1,"items":[{"id":"a","name":"x","cells":[[1.5,2]]}]}'],
    ['坐标是负数', '{"v":1,"items":[{"id":"a","name":"x","cells":[[-1,2]]}]}'],
    ['cells 为空', '{"v":1,"items":[{"id":"a","name":"x","cells":[]}]}'],
    ['id 缺失', '{"v":1,"items":[{"name":"x","cells":[[0,0]]}]}'],
    ['item 是 null', '{"v":1,"items":[null]}'],
  ];
  let bad = 0;
  for (const [label, raw] of cases) {
    localStorage.clear();
    custom.resetCache();
    localStorage.setItem('conway-life-game/custom/v1', raw);
    try {
      const list = custom.all();
      if (!Array.isArray(list) || list.length !== 0) {
        bad++;
        console.log(`         ${label} 应该降级成空库，实际得到 ${JSON.stringify(list)}`);
      }
    } catch (err) {
      bad++;
      console.log(`         ${label} 抛异常了：${err.message}`);
    }
  }
  check('10 种坏存档全部降级成空库且不抛异常', bad, 0);
}

console.log('');

// 9. 坏数据里混着好数据时，只丢坏的那条
{
  localStorage.clear();
  custom.resetCache();
  localStorage.setItem(
    'conway-life-game/custom/v1',
    JSON.stringify({
      v: 1,
      items: [
        { id: 'good', name: '好的', cells: [[0, 0], [1, 0]] },
        { id: 'bad', name: '坏的', cells: 'nope' },
        { id: 'good2', name: '也好的', cells: [[2, 2]] },
      ],
    })
  );
  check('只丢掉坏的那条', custom.all().map((p) => p.id), ['good', 'good2']);
  check('好数据坐标被重新归一化', custom.get('good2').cells, [[0, 0]]);
}

console.log('');

// 10. 写进 localStorage 之后，换一个"会话"（清缓存重读）还在
{
  fresh();
  const p = custom.add('要留下来的', [[3, 3], [4, 3]]);
  custom.resetCache();
  const back = custom.get(p.id);
  check('重读后还在', back !== null, true);
  check('重读后内容一致', back.cells, [[0, 0], [1, 0]]);
  check('重读后名字一致', back.name, '要留下来的');
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
