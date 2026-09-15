#!/usr/bin/env node
/**
 * 规则引擎的行为测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-rules.mjs
 *
 * 这里测的是「改着法生成时最容易悄悄弄坏」的地方：每种棋子的走法约束、
 * 将帅照面、应将、困毙判负。象棋的 perft 基准值来源不一、容易记错，
 * 所以不依赖外部数字，改成逐条规则点的断言 —— 失败时能直接指出是哪条规则错了。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, PIECE_OF_FEN, START_FEN } = await load('config.js');
const { indexOf, xOf, yOf, inBoard, parseFen, toFen, startPosition, clonePosition, positionSignature } =
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

/** 'x,y' -> 下标。测试里到处要用，别在每个块里重复写 */
const idxOf = (coord) => {
  const [x, y] = coord.split(',').map(Number);
  return y * 9 + x;
};

const coordOf = (idx) => `${xOf(idx)},${yOf(idx)}`;

/** 用「棋子字符 @ x,y」的稀疏描述造局面，比手写 FEN 好核对 */
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

console.log('规则引擎测试\n');

// === 以下为各任务追加的测试块 ===

// --- 坐标换算 ---
{
  check('indexOf / xOf / yOf 互逆',
    [0, 8, 9, 40, 44, 89].map((i) => indexOf(xOf(i), yOf(i))),
    [0, 8, 9, 40, 44, 89]);
  check('indexOf(4, 4) = 40', indexOf(4, 4), 40);
  check('idx 0 是黑方左上角', [xOf(0), yOf(0)], [0, 0]);
  check('idx 89 是红方右下角', [xOf(89), yOf(89)], [8, 9]);
  check('inBoard 判边界',
    [inBoard(0, 0), inBoard(8, 9), inBoard(9, 0), inBoard(0, 10), inBoard(-1, 0)],
    [true, true, false, false, false]);
}

// --- FEN 读写 ---
{
  check('起始局面 FEN 往返一致', toFen(startPosition()), START_FEN);
  check('起始局面轮走方是红', startPosition().side, 1);

  const egFen = '3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1';
  check('残局示例 FEN 往返一致', toFen(parseFen(egFen)), egFen);
  check('残局示例：红车在 (0,9)', parseFen(egFen).cells[idxOf('0,9')], 5);
  check('残局示例：黑将在 (4,0)', parseFen(egFen).cells[idxOf('4,0')], -1);

  const blackFirst = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1';
  check('轮走方 b 解析为黑', parseFen(blackFirst).side, -1);

  check('clonePosition 是深拷贝',
    (() => {
      const a = startPosition();
      const b = clonePosition(a);
      b.cells[0] = 0;
      return a.cells[0] === -5 && b.cells[0] === 0;
    })(), true);

  const throws = (name, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(name, threw, true);
  };
  throws('FEN 行数不对时报错', () => parseFen('9/9 w'));
  throws('FEN 轮走方非法时报错', () => parseFen('9/9/9/9/9/9/9/9/9/9 x'));
  throws('FEN 出现非法字符时报错', () => parseFen('9/9/9/9/9/9/9/9/9/xxx w'));
  throws('FEN 列数不足时报错', () => parseFen('rnbakabn/9/9/9/9/9/9/9/9/RNBAKABNR w'));
  throws('FEN 缺字段时报错', () => parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'));

  check('局面签名忽略后三个字段',
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1'),
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 7 12'));
  check('局面签名区分轮走方',
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1') ===
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 b - - 0 1'), false);
}

// --- 着法生成：车 / 炮 / 兵 / 将 ---
{
  const { generateMoves, moveFrom, moveTo } = await load('rules.js');

  const movesFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateMoves(pos.cells, pos.side)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 车：四方向直线滑动，遇子停止，遇敌子可吃
  check('车在空盘正中：17 个落点', movesFrom(build(['R@4,4']), '4,4').length, 17);
  check('车被己方挡住时停在前面',
    movesFrom(build(['R@4,4', 'P@4,2']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);
  check('车可以吃敌子，且停在敌子那一格',
    movesFrom(build(['R@4,4', 'p@4,2']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,2', '4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);

  // 炮：没有炮架只能走空格，隔一个子才能吃
  check('炮在空盘正中：17 个落点（与车相同，因为无子可吃）',
    movesFrom(build(['C@4,4']), '4,4').length, 17);
  check('炮隔一个子可吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'r@4,0']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,0', '4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);
  check('炮隔两个子不能吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'P@4,1', 'r@4,0']), '4,4').includes('4,0'), false);
  check('炮没有炮架时不能吃',
    movesFrom(build(['C@4,4', 'r@4,0']), '4,4').includes('4,0'), false);
  check('炮的炮架是己方子也能吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'r@4,0']), '4,4').includes('4,0'), true);

  // 兵：未过河只能前进，过河后可横走，永不后退
  check('红兵未过河只能前进一格', movesFrom(build(['P@0,6']), '0,6'), ['0,5']);
  check('红兵过河后可前进和横走', movesFrom(build(['P@4,4']), '4,4'), ['3,4', '4,3', '5,4']);
  check('红兵贴边过河只有两个落点', movesFrom(build(['P@0,4']), '0,4'), ['0,3', '1,4']);
  check('黑卒未过河只能前进一格', movesFrom(build(['p@0,3'], 'b'), '0,3'), ['0,4']);
  check('黑卒过河后可前进和横走', movesFrom(build(['p@4,5'], 'b'), '4,5'), ['3,5', '4,6', '5,5']);

  // 将 / 帅：四方向一格，不得出九宫
  check('红帅在底线正中：3 个落点', movesFrom(build(['K@4,9']), '4,9'), ['3,9', '4,8', '5,9']);
  check('红帅在九宫左边：3 个落点', movesFrom(build(['K@3,8']), '3,8'), ['3,7', '3,9', '4,8']);
  check('红帅在九宫角：2 个落点', movesFrom(build(['K@3,9']), '3,9'), ['3,8', '4,9']);
  check('黑将在九宫角：2 个落点', movesFrom(build(['k@5,0'], 'b'), '5,0'), ['4,0', '5,1']);
}

// --- 着法生成：马 / 象 / 士 ---
{
  const { generateMoves, moveFrom, moveTo } = await load('rules.js');
  const movesFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateMoves(pos.cells, pos.side)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 马：八个日字目标，四个马腿方向各塞一个挡子试一遍
  check('马在正中：8 个落点', movesFrom(build(['N@4,4']), '4,4').length, 8);
  check('蹩马腿（上）：(3,2) 与 (5,2) 都不可达',
    movesFrom(build(['N@4,4', 'P@4,3']), '4,4').filter((c) => c.endsWith(',2')), []);
  check('蹩马腿（下）：(3,6) 与 (5,6) 都不可达',
    movesFrom(build(['N@4,4', 'P@4,5']), '4,4').filter((c) => c.endsWith(',6')), []);
  check('蹩马腿（左）：(2,3) 与 (2,5) 都不可达',
    movesFrom(build(['N@4,4', 'P@3,4']), '4,4').filter((c) => c.startsWith('2,')), []);
  check('蹩马腿（右）：(6,3) 与 (6,5) 都不可达',
    movesFrom(build(['N@4,4', 'P@5,4']), '4,4').filter((c) => c.startsWith('6,')), []);
  check('马腿只挡一个方向，其余六个落点照走',
    movesFrom(build(['N@4,4', 'P@4,3']), '4,4'),
    ['2,3', '2,5', '3,6', '5,6', '6,3', '6,5']);

  // 象 / 相：田字，塞象眼，不能过河
  check('红相在底线：2 个落点', movesFrom(build(['B@2,9']), '2,9'), ['0,7', '4,7']);
  check('塞象眼：象眼有子则该田字不可达',
    movesFrom(build(['B@2,9', 'P@1,8']), '2,9'), ['4,7']);
  check('相不能过河', movesFrom(build(['B@2,5']), '2,5'), ['0,7', '4,7']);
  check('黑象在底线：2 个落点', movesFrom(build(['b@2,0'], 'b'), '2,0'), ['0,2', '4,2']);

  // 士 / 仕：斜走一格，不得出九宫
  check('红仕在九宫正中：4 个落点',
    movesFrom(build(['A@4,8']), '4,8'), ['3,7', '3,9', '5,7', '5,9']);
  check('红仕在九宫角：只有 1 个落点（另一个出九宫）',
    movesFrom(build(['A@3,9']), '3,9'), ['4,8']);
  check('黑士在九宫角：只有 1 个落点',
    movesFrom(build(['a@5,0'], 'b'), '5,0'), ['4,1']);
}

// --- 初始局面着法数分解 ---
// 红方共 42 步。拆到每个棋子上，这样失败时能直接看出是哪种棋子错了。
{
  const { generateMoves, moveFrom } = await load('rules.js');
  const pos = startPosition();
  const perPiece = new Map();
  for (const m of generateMoves(pos.cells, pos.side)) {
    const key = coordOf(moveFrom(m));
    perPiece.set(key, (perPiece.get(key) || 0) + 1);
  }
  const counts = (keys) => keys.map((k) => perPiece.get(k));

  check('初始局面：5 个兵各 1 步', counts(['0,6', '2,6', '4,6', '6,6', '8,6']), [1, 1, 1, 1, 1]);
  check('初始局面：2 个炮各 12 步', counts(['1,7', '7,7']), [12, 12]);
  check('初始局面：2 个马各 2 步', counts(['1,9', '7,9']), [2, 2]);
  check('初始局面：2 个车各 2 步', counts(['0,9', '8,9']), [2, 2]);
  check('初始局面：2 个相各 2 步', counts(['2,9', '6,9']), [2, 2]);
  check('初始局面：2 个仕各 1 步', counts(['3,9', '5,9']), [1, 1]);
  check('初始局面：帅 1 步', perPiece.get('4,9'), 1);
  check('初始局面：红方共 44 步', generateMoves(pos.cells, pos.side).length, 44);
}

// === 收尾 ===
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
