#!/usr/bin/env node
/**
 * 中文记谱测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-notation.mjs
 *
 * 规则见 design.md §6：棋子名 + 起始纵线 + 动作 + 目标。
 * 纵线号**按方各自编号**（两方镜像）：红方 `9 - x` 用汉字、黑方 `x + 1` 用阿拉伯数字。
 * 车 / 炮 / 兵 / 将 的进退还记步数，马 / 象 / 士 记目标纵线。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, PIECE_OF_FEN } = await load('config.js');
const { toNotation } = await load('notation.js');

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

/** 用稀疏描述造局面，然后给一步棋，返回记谱串 */
function note(specs, side, from, to) {
  const cells = new Int8Array(CELLS);
  for (const spec of specs) {
    const [ch, coord] = spec.split('@');
    cells[idxOf(coord)] = PIECE_OF_FEN[ch];
  }
  return toNotation({ cells, side: side === 'w' ? 1 : -1 }, idxOf(from) * 90 + idxOf(to));
}

console.log('中文记谱测试\n');

// 平：目标记纵线
check('红炮八平五', note(['C@1,7'], 'w', '1,7', '4,7'), '炮八平五');
// **黑方纵线号是 `x + 1`**：黑方从自己的右手边（x = 0）数起。同一个 x 上，
// 红黑两方的号是**镜像**的（红「一」x = 8 与黑「9」x = 8 同列），不能再用红方那套 9 - x。
check('黑卒9平8', note(['p@8,4'], 'b', '8,4', '7,4'), '卒9平8');
check('红车九平八', note(['R@0,9'], 'w', '0,9', '1,9'), '车九平八');

// 进 / 退：车、炮、兵、将记步数
check('红车九进一', note(['R@0,9'], 'w', '0,9', '0,8'), '车九进一');
check('红车九退一', note(['R@0,5'], 'w', '0,5', '0,6'), '车九退一');
check('黑车1退1', note(['r@0,4'], 'b', '0,4', '0,3'), '车1退1');
check('红兵五进一', note(['P@4,6'], 'w', '4,6', '4,5'), '兵五进一');
check('红帅五进一', note(['K@4,9'], 'w', '4,9', '4,8'), '帅五进一');
check('红车九进三记步数而不是纵线', note(['R@0,9'], 'w', '0,9', '0,6'), '车九进三');

// 进 / 退：马、象、士记目标纵线
check('红马八进七', note(['N@1,9'], 'w', '1,9', '2,7'), '马八进七');
check('黑马8进7', note(['n@7,0'], 'b', '7,0', '6,2'), '马8进7');
check('红相七进五', note(['B@2,9'], 'w', '2,9', '4,7'), '相七进五');
check('红仕六进五', note(['A@3,9'], 'w', '3,9', '4,8'), '仕六进五');

// 同一纵线上的重子：用前 / 后
check('前车进一', note(['R@0,9', 'R@0,5'], 'w', '0,5', '0,4'), '前车进一');
check('后车进一', note(['R@0,9', 'R@0,5'], 'w', '0,9', '0,8'), '后车进一');
check('黑方前车进1', note(['r@0,0', 'r@0,4'], 'b', '0,4', '0,5'), '前车进1');

// 同一纵线上三个兵：用前 / 中 / 后
check('前兵进一', note(['P@4,6', 'P@4,4', 'P@4,2'], 'w', '4,2', '4,1'), '前兵进一');
check('中兵进一', note(['P@4,6', 'P@4,4', 'P@4,2'], 'w', '4,4', '4,3'), '中兵进一');
check('后兵进一', note(['P@4,6', 'P@4,4', 'P@4,2'], 'w', '4,6', '4,5'), '后兵进一');

// 起始纵线只在没有重子时才用
check('同纵线只有一个棋子时用纵线号',
  note(['R@0,9', 'R@1,9'], 'w', '0,9', '0,8'), '车九进一');

// --- 外部谱例锚定 ---
// 上面那些用例是「实现怎么写就怎么断言」，**规则本身错了它们也全绿** ——
// 黑方纵线方向反了整整一个版本，就是这么藏住的。
// 这四条取自《适情雅趣》第 002 局「马蹀阏氏」的谱载解法（通行记谱，
// 也已和 Pikafish 算出的 PV 逐手对上）：两方编号方向一旦回退就会被它们钉死。
check('谱例：红双车同线，(1,4)->(1,0) 记作「前车进四」',
  note(['R@1,4', 'R@1,5'], 'w', '1,4', '1,0'), '前车进四');
check('谱例：红炮 (2,8)->(2,0) 记作「炮七进八」',
  note(['C@2,8'], 'w', '2,8', '2,0'), '炮七进八');
check('谱例：黑士 (4,1)->(3,0) 记作「士5退4」',
  note(['a@4,1'], 'b', '4,1', '3,0'), '士5退4');
check('谱例：黑马 (0,2)->(1,0) 记作「马1退2」',
  note(['n@0,2'], 'b', '0,2', '1,0'), '马1退2');

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
