# 中国象棋规则层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现中国象棋的规则引擎（`position.js` / `rules.js`）与中文记谱（`notation.js`），产出两个能在 Node 里直接跑通的测试脚本。

**Architecture:** 局面是 `{ cells: Int8Array(90), side: 1 | -1 }` 的纯值对象，规则引擎围绕它提供两层接口——`generateMoves()` 出伪合法着法给搜索用，`generateLegalMoves()` 出合法着法给界面和终局判定用。合法性判定用「试走 + 回退」而不是在生成时过滤，因为那样只有一处判断逻辑。全部模块是纯逻辑，不碰 DOM、不碰 Worker，所以能在 Node 里测完再进浏览器。

**Tech Stack:** 纯 ES Module + Node 内置模块（`node:url` / `node:path`），无依赖、无构建工具。

**本计划的范围：** 设计文档 `chinese-chess/docs/design.md` 的 §4（数据模型）、§5（规则引擎）、§6（中文记谱）。

**刻意不在本计划里：** §4.4 的 Zobrist 哈希。它只被 AI 层置换表用到，规则和记谱都不需要，所以跟着 AI 层那份计划一起做，避免这里先写一堆没人调的代码。AI 层、界面层、残局库、持久化各自另立计划——本计划完成后规则正确性已经锁死，后面几层不会因为「规则改了」而返工。

## Global Constraints

以下约束适用于本计划的每一个任务：

- **无依赖**：不引入任何 npm 包，只用 Node 内置模块。
- **无构建工具**：源文件直接就是浏览器能加载的 ES Module，不经过任何转译。
- **无 `package.json`**：整个仓库都没有。Node 靠语法自动检测把 `.js` 当 ES Module（本机 v24.11.0 已验证）。**因此所有源文件必须显式使用 `import` / `export` 语法**，不能写成 CommonJS。
- **模块隔离**：本模块不得引用其他模块（`conway-life-game` 等）的任何文件，不共享全局变量、`localStorage` key、CSS 类名。
- **纯逻辑模块不得碰 DOM**：`config.js` / `position.js` / `rules.js` / `notation.js` 会被 Worker 加载，里面出现任何 `document` / `window` 都会让 Worker 崩掉。
- **测试脚本必须能直接跑**：`node chinese-chess/tools/test-rules.mjs`，从任何工作目录执行都可以，不需要装依赖。
- **坐标约定**：`x` 向右 0..8，`y` 向下 0..9，`idx = y * 9 + x`。黑方在 `y = 0..4`，红方在 `y = 5..9`。
- **棋子编码**：`0` 空，正数红方，负数黑方；`K=1 A=2 B=3 N=4 R=5 C=6 P=7`。判色 `Math.sign(v)`，判类型 `Math.abs(v)`。
- **`EMPTY === 0`**：所以 `Math.sign(0) === 0`，「目标格为空或敌子」等价于 `Math.sign(target) !== Math.sign(mover)`。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `chinese-chess/js/config.js` | 棋盘尺寸、棋子编码、阵营常量、FEN 字符映射、起始局面。纯数据，不 import 任何东西 |
| `chinese-chess/js/position.js` | 坐标换算、FEN 读写、局面克隆、局面签名 |
| `chinese-chess/js/rules.js` | 着法生成、攻击判定、合法性、终局判定、三次重复 |
| `chinese-chess/js/notation.js` | 中文记谱生成 |
| `chinese-chess/tools/test-rules.mjs` | 规则引擎测试 |
| `chinese-chess/tools/test-notation.mjs` | 中文记谱测试 |

---

## Task 1: 常量与局面（FEN 读写）

**Files:**
- Create: `chinese-chess/js/config.js`
- Create: `chinese-chess/js/position.js`
- Test: `chinese-chess/tools/test-rules.mjs`

**Interfaces:**
- Consumes: 无（这是第一个任务）
- Produces:
  - `config.js`：`COLS=9`、`ROWS=10`、`CELLS=90`、`EMPTY=0`、`K=1 A=2 B=3 N=4 R=5 C=6 P=7`、`RED=1`、`BLACK=-1`、`FEN_OF_PIECE: string[]`（索引 = 棋子编码 + 7）、`PIECE_OF_FEN: Record<string, number>`、`START_FEN: string`
  - `position.js`：`indexOf(x, y) -> number`、`xOf(idx) -> number`、`yOf(idx) -> number`、`inBoard(x, y) -> boolean`、`parseFen(fen) -> { cells: Int8Array, side: 1|-1 }`、`toFen(pos) -> string`、`startPosition() -> pos`、`clonePosition(pos) -> pos`、`positionSignature(fen) -> string`

- [ ] **Step 1: 建立测试脚本骨架（此时必然失败）**

创建 `chinese-chess/tools/test-rules.mjs`。这个骨架后面每个任务都会往里加测试块，所以先把「加载模块 + 断言工具 + 造局面工具 + 收尾统计」搭好：

```js
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
const { indexOf, xOf, yOf, inBoard, parseFen, toFen, startPosition, positionSignature } =
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

// === 收尾 ===
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: FAIL，报 `Cannot find module .../js/config.js`

- [ ] **Step 3: 写 `config.js`**

```js
/**
 * 中国象棋模块的常量。
 *
 * 纯数据，不 import 任何东西 —— Worker 会直接加载这个文件，
 * 所以这里绝对不能出现任何 DOM 相关的东西。
 */

// === 棋盘 ===
// x 向右 0..8，y 向下 0..9；黑方在 y = 0..4，红方在 y = 5..9
export const COLS = 9;
export const ROWS = 10;
export const CELLS = COLS * ROWS; // 90

// === 棋子编码 ===
// 局面是 Int8Array(90)：0 为空，正数红方，负数黑方。
// 判色用 Math.sign(v)，判类型用 Math.abs(v)。
export const EMPTY = 0;
export const K = 1; // 帅 / 将
export const A = 2; // 仕 / 士
export const B = 3; // 相 / 象
export const N = 4; // 马
export const R = 5; // 车
export const C = 6; // 炮
export const P = 7; // 兵 / 卒

// === 阵营 ===
export const RED = 1;
export const BLACK = -1;

// === FEN ===
// 索引 = 棋子编码 + 7，覆盖 -7..7。
// 索引 7 对应 EMPTY，但 FEN 里空格写成数字，所以那一项用不到。
export const FEN_OF_PIECE = [
  'p', 'c', 'r', 'n', 'b', 'a', 'k', '',
  'K', 'A', 'B', 'N', 'R', 'C', 'P',
];

export const PIECE_OF_FEN = {
  k: -K, a: -A, b: -B, n: -N, r: -R, c: -C, p: -P,
  K, A, B, N, R, C, P,
};

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
```

- [ ] **Step 4: 写 `position.js`**

```js
/**
 * 局面表示与 FEN 读写。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 局面对象：{ cells: Int8Array(90), side: 1 | -1 }
 *   - idx = y * COLS + x
 *   - cells 是「值」而不是共享状态：clonePosition() 就是一次 90 字节拷贝，
 *     所以搜索和试走可以随便复制，不用担心共享引用
 */

import { COLS, ROWS, CELLS, EMPTY, FEN_OF_PIECE, PIECE_OF_FEN, START_FEN, RED, BLACK } from './config.js';

export function indexOf(x, y) { return y * COLS + x; }
export function xOf(idx) { return idx % COLS; }
export function yOf(idx) { return Math.floor(idx / COLS); }
export function inBoard(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

/**
 * 解析 FEN。只读前两个字段（棋盘 + 轮走方），后三个字段忽略。
 *
 * 解析失败抛 Error 而不是返回 null —— 调用方（残局库校验、粘贴导入）
 * 需要知道到底哪里不对，抛异常能带上具体原因。
 */
export function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`FEN 至少需要「棋盘 轮走方」两个字段：${fen}`);

  const rows = parts[0].split('/');
  if (rows.length !== ROWS) throw new Error(`FEN 棋盘应为 ${ROWS} 行，实际 ${rows.length} 行`);

  const cells = new Int8Array(CELLS);
  for (let y = 0; y < ROWS; y++) {
    let x = 0;
    for (const ch of rows[y]) {
      if (ch >= '1' && ch <= '9') { x += Number(ch); continue; }
      const piece = PIECE_OF_FEN[ch];
      if (piece === undefined) throw new Error(`FEN 第 ${y + 1} 行出现无法识别的字符「${ch}」`);
      if (x >= COLS) throw new Error(`FEN 第 ${y + 1} 行超出 ${COLS} 列`);
      cells[indexOf(x, y)] = piece;
      x++;
    }
    if (x !== COLS) throw new Error(`FEN 第 ${y + 1} 行共 ${x} 列，应为 ${COLS} 列`);
  }

  const side = parts[1] === 'w' ? RED : parts[1] === 'b' ? BLACK : null;
  if (side === null) throw new Error(`FEN 轮走方应为 w 或 b，实际「${parts[1]}」`);

  return { cells, side };
}

/** 生成 FEN。后三个字段固定输出 `- - 0 1`，本模块不使用它们。 */
export function toFen(pos) {
  const lines = [];
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    let empty = 0;
    for (let x = 0; x < COLS; x++) {
      const v = pos.cells[indexOf(x, y)];
      if (v === EMPTY) { empty++; continue; }
      if (empty) { line += empty; empty = 0; }
      line += FEN_OF_PIECE[v + 7];
    }
    if (empty) line += empty;
    lines.push(line);
  }
  return `${lines.join('/')} ${pos.side === RED ? 'w' : 'b'} - - 0 1`;
}

export function startPosition() { return parseFen(START_FEN); }

export function clonePosition(pos) {
  return { cells: pos.cells.slice(), side: pos.side };
}

/**
 * 局面签名：FEN 的前两个字段。
 *
 * 用于「三次重复判和」。后三个字段（含回合数）每次都变，必须排除，
 * 否则同一个局面永远比不出重复。
 */
export function positionSignature(fen) {
  const parts = String(fen).trim().split(/\s+/);
  return `${parts[0]} ${parts[1]}`;
}
```

- [ ] **Step 5: 追加 FEN 与坐标测试**

在 `test-rules.mjs` 的「以下为各任务追加的测试块」之后、「收尾」之前插入：

```js
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
```

> 注：`clonePosition 是深拷贝` 那条断言里 `a.cells[0] === -5` 依赖起始局面左上角是黑车（编码 `-R` = `-5`）。如果改过 `START_FEN`，这条要跟着改。

- [ ] **Step 6: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 ok，末行 `全部通过`，退出码 0

- [ ] **Step 7: 提交**

```bash
git add chinese-chess/js/config.js chinese-chess/js/position.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 局面表示与 FEN 读写"
```

---

## Task 2: 着法生成——车、炮、兵、将

**Files:**
- Create: `chinese-chess/js/rules.js`
- Modify: `chinese-chess/tools/test-rules.mjs`（追加测试块）

**Interfaces:**
- Consumes: `config.js` 的 `COLS/CELLS/EMPTY/K/A/B/N/R/C/P/RED/BLACK`；`position.js` 的 `indexOf/xOf/yOf/inBoard`；测试文件里已有的 `build` / `idxOf` / `coordOf`
- Produces:
  - `encodeMove(from, to) -> number`（`from * 90 + to`）
  - `moveFrom(move) -> number`、`moveTo(move) -> number`
  - `generateMoves(cells, side) -> number[]`（伪合法着法）
  - 内部辅助（暂不导出）：`canLand`、`inPalace`、`ownHalf`

- [ ] **Step 1: 追加测试（此时必然失败）**

```js
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
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: FAIL，报 `Cannot find module .../js/rules.js`

- [ ] **Step 3: 写 `rules.js` 的骨架与四个棋子生成器**

```js
/**
 * 规则引擎：着法生成、攻击判定、合法性、终局判定。纯逻辑。
 *
 * 两层接口，用途不同：
 *   generateMoves(cells, side)   伪合法着法（不检查走完后己方是否被将军）—— 搜索用
 *   generateLegalMoves(pos)      合法着法 —— 界面走子校验、终局判定用
 */

import { COLS, CELLS, EMPTY, K, A, B, N, R, C, P, RED, BLACK } from './config.js';
import { indexOf, xOf, yOf, inBoard } from './position.js';

// 四个正交方向
const ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];

// 马：[目标位移 dx, dy, 马腿位移 lx, ly]
// 马腿是「先直走的那一格」，也就是位移绝对值等于 2 的那个方向上的相邻格
const HORSE = [
  [1, -2, 0, -1], [-1, -2, 0, -1],
  [1, 2, 0, 1], [-1, 2, 0, 1],
  [2, -1, 1, 0], [2, 1, 1, 0],
  [-2, -1, -1, 0], [-2, 1, -1, 0],
];

// 象 / 相：田字，象眼是两格位移的中点
const ELEPHANT = [[2, 2], [2, -2], [-2, 2], [-2, -2]];

// 士 / 仕：斜走一格
const ADVISOR = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function encodeMove(from, to) { return from * CELLS + to; }
export function moveFrom(move) { return Math.floor(move / CELLS); }
export function moveTo(move) { return move % CELLS; }

/** 目标格为空或敌子即可落子 */
function canLand(cells, idx, side) {
  const t = cells[idx];
  return t === EMPTY || Math.sign(t) !== side;
}

/** 是否在自己的九宫内 */
function inPalace(x, y, side) {
  if (x < 3 || x > 5) return false;
  return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}

/** 是否在自己的半场内（相 / 象不能过河） */
function ownHalf(y, side) { return side === RED ? y >= 5 : y <= 4; }

/**
 * 生成伪合法着法。不检查走完之后己方是否被将军 —— 那一步在 generateLegalMoves() 里统一做。
 */
export function generateMoves(cells, side) {
  const out = [];
  for (let from = 0; from < CELLS; from++) {
    const v = cells[from];
    if (v === EMPTY || Math.sign(v) !== side) continue;
    const x = xOf(from), y = yOf(from);
    switch (Math.abs(v)) {
      case R: genRook(out, cells, from, x, y, side); break;
      case C: genCannon(out, cells, from, x, y, side); break;
      case P: genPawn(out, cells, from, x, y, side); break;
      case K: genKing(out, cells, from, x, y, side); break;
      default: break;
    }
  }
  return out;
}

/** 车：四方向直线滑动，遇子停止，遇敌子可吃 */
function genRook(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] === EMPTY) {
        out.push(encodeMove(from, idx));
      } else {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/**
 * 炮：四方向直线。
 * 第一段没有炮架，只能走空格；遇到第一个子（炮架）之后，
 * 再找它后面的第一个子，是敌子才能吃。
 */
function genCannon(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;

    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) {
      out.push(encodeMove(from, indexOf(cx, cy)));
      cx += dx; cy += dy;
    }
    if (!inBoard(cx, cy)) continue;

    // (cx,cy) 是炮架，从它后面继续找第一个子
    cx += dx; cy += dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] !== EMPTY) {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/** 兵 / 卒：未过河只能向前一格，过河后可向前或左右一格，永不后退 */
function genPawn(out, cells, from, x, y, side) {
  const forward = -side; // 红方前进 y 减小，黑方前进 y 增大
  const fy = y + forward;
  if (inBoard(x, fy)) {
    const idx = indexOf(x, fy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }

  // 过河后才能横走：红兵到 y <= 4，黑卒到 y >= 5
  const crossed = side === RED ? y <= 4 : y >= 5;
  if (!crossed) return;

  for (const dx of [-1, 1]) {
    const cx = x + dx;
    if (!inBoard(cx, y)) continue;
    const idx = indexOf(cx, y);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 将 / 帅：四方向一格，不得出九宫 */
function genKing(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}
```

- [ ] **Step 4: 跑测试，确认车 / 炮 / 兵 / 将全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 本任务新增的断言全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/rules.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 车炮兵将的着法生成"
```

---

## Task 3: 着法生成——马、象、士；初始局面 42 步

**Files:**
- Modify: `chinese-chess/js/rules.js`
- Modify: `chinese-chess/tools/test-rules.mjs`

**Interfaces:**
- Consumes: Task 2 的 `generateMoves`、`canLand`、`inPalace`、`ownHalf`、`HORSE`、`ELEPHANT`、`ADVISOR`
- Produces: 无新增导出（补全 `generateMoves` 的覆盖）

- [ ] **Step 1: 追加测试**

```js
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
  check('初始局面：2 个炮各 11 步', counts(['1,7', '7,7']), [11, 11]);
  check('初始局面：2 个马各 2 步', counts(['1,9', '7,9']), [2, 2]);
  check('初始局面：2 个车各 2 步', counts(['0,9', '8,9']), [2, 2]);
  check('初始局面：2 个相各 2 步', counts(['2,9', '6,9']), [2, 2]);
  check('初始局面：2 个仕各 1 步', counts(['3,9', '5,9']), [1, 1]);
  check('初始局面：帅 1 步', perPiece.get('4,9'), 1);
  check('初始局面：红方共 42 步', generateMoves(pos.cells, pos.side).length, 42);
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 马 / 象 / 士相关断言 FAIL，`初始局面：红方共 42 步` FAIL

- [ ] **Step 3: 补上三个生成器**

在 `rules.js` 的 `generateMoves` 里把 `default: break;` 换成完整分派：

```js
    switch (Math.abs(v)) {
      case R: genRook(out, cells, from, x, y, side); break;
      case C: genCannon(out, cells, from, x, y, side); break;
      case N: genHorse(out, cells, from, x, y, side); break;
      case B: genElephant(out, cells, from, x, y, side); break;
      case A: genAdvisor(out, cells, from, x, y, side); break;
      case K: genKing(out, cells, from, x, y, side); break;
      case P: genPawn(out, cells, from, x, y, side); break;
    }
```

并在 `genPawn` 之后加上：

```js
/** 马：八个日字目标；马腿（先直走的那一格）有子则该方向全部禁止 */
function genHorse(out, cells, from, x, y, side) {
  for (const [dx, dy, lx, ly] of HORSE) {
    const legX = x + lx, legY = y + ly;
    // 马腿在棋盘外时，对应的目标也必然在棋盘外，直接跳过
    if (!inBoard(legX, legY) || cells[indexOf(legX, legY)] !== EMPTY) continue;

    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 象 / 相：四个田字目标；象眼（田字中心）有子则禁；不得过河 */
function genElephant(out, cells, from, x, y, side) {
  for (const [dx, dy] of ELEPHANT) {
    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    if (!ownHalf(cy, side)) continue;
    if (cells[indexOf(x + dx / 2, y + dy / 2)] !== EMPTY) continue; // 塞象眼
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 士 / 仕：四个斜向一格；不得出九宫 */
function genAdvisor(out, cells, from, x, y, side) {
  for (const [dx, dy] of ADVISOR) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 `ok`。

**如果「红方共 42 步」失败，先看上面那 7 条分解断言哪条挂了**——分解断言就是为了定位这个用的，不要直接去改 42 这个数字。42 是这样推出来的：5 兵 × 1 + 2 炮 × 11 + 2 马 × 2 + 2 车 × 2 + 2 相 × 2 + 2 仕 × 1 + 1 帅 × 1。其中炮的 11 步最容易被漏算——红炮在 `(1,7)` 时，除了向上 4 步、向左 1 步、向右 5 步，还能**向下走到 `(1,8)`**（`(1,8)` 是空的，再往下的 `(1,9)` 是自家马）。

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/rules.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 马象士着法生成，初始局面 42 步对齐"
```

---

## Task 4: 合法性判定（攻击、将帅照面、应将）

**Files:**
- Modify: `chinese-chess/js/rules.js`
- Modify: `chinese-chess/tools/test-rules.mjs`

**Interfaces:**
- Consumes: Task 2/3 的 `generateMoves`、`encodeMove`、`moveFrom`、`moveTo`、`HORSE`、`ORTHO`
- Produces:
  - `isAttacked(cells, idx, bySide) -> boolean`
  - `findKing(cells, side) -> number`（找不到返回 -1）
  - `inCheck(cells, side) -> boolean`
  - `generateLegalMoves(pos) -> number[]`

- [ ] **Step 1: 追加测试**

```js
// --- 攻击判定 ---
// isAttacked 只看几何关系，但车 / 炮 / 将这类滑行攻击必须「扫到目标格」才命中，
// 所以靶子格上必须真的有子。下面统一往目标格塞一个红兵当靶子。
{
  const { isAttacked, findKing, inCheck } = await load('rules.js');
  const attacked = (specs, coord, bySide) =>
    isAttacked(build([...specs, `P@${coord}`]).cells, idxOf(coord), bySide);

  // 车
  check('车沿纵线攻击', attacked(['r@4,0'], '4,4', -1), true);
  check('车被挡住则不攻击', attacked(['r@4,0', 'P@4,3'], '4,4', -1), false);
  check('车看不到自己后方', attacked(['r@4,8'], '4,4', -1), true);

  // 炮
  check('炮隔一子攻击', attacked(['c@4,0', 'P@4,3'], '4,4', -1), true);
  check('炮没炮架不攻击', attacked(['c@4,0'], '4,4', -1), false);
  check('炮隔两子不攻击', attacked(['c@4,0', 'P@4,3', 'P@4,2'], '4,4', -1), false);

  // 马
  check('马攻击日字目标', attacked(['n@5,2'], '4,4', -1), true);
  check('马腿被蹩则不攻击', attacked(['n@5,2', 'P@5,3'], '4,4', -1), false);

  // 兵 / 卒
  check('红兵攻击正前方', attacked(['P@4,5'], '4,4', 1), true);
  check('红兵未过河不攻击侧面', attacked(['P@5,6'], '4,6', 1), false);
  check('红兵过河后攻击侧面', attacked(['P@5,4'], '4,4', 1), true);
  check('黑卒攻击正前方', attacked(['p@4,3'], '4,4', -1), true);

  // 将帅照面：同处一条纵线且中间无子时互相攻击
  check('将帅照面时互相攻击',
    isAttacked(build(['K@4,9', 'k@4,0']).cells, idxOf('4,0'), 1), true);
  check('中间有子则不算照面',
    isAttacked(build(['K@4,9', 'P@4,5', 'k@4,0']).cells, idxOf('4,0'), 1), false);

  // inCheck / findKing
  check('被将军时 inCheck 为真', inCheck(build(['K@4,9', 'r@4,0']).cells, 1), true);
  check('没被将军时 inCheck 为假', inCheck(build(['K@4,9', 'r@3,0']).cells, 1), false);
  check('findKing 能找到红帅', findKing(build(['K@4,9']).cells, 1), idxOf('4,9'));
  check('findKing 找不到时返回 -1', findKing(build(['K@4,9']).cells, -1), -1);
}

// --- 合法着法 ---
{
  const { generateLegalMoves, moveFrom, moveTo } = await load('rules.js');
  const legalFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateLegalMoves(pos)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 不能把挡在两将中间的炮挪离纵线（否则将帅照面）
  {
    const pos = build(['K@4,9', 'C@4,5', 'k@4,0']);
    check('将帅照面：炮不能挪离纵线',
      legalFrom(pos, '4,5'), ['4,1', '4,2', '4,3', '4,4', '4,6', '4,7', '4,8']);
    check('将帅照面：帅可以离开纵线', legalFrom(pos, '4,9'), ['3,9', '4,8', '5,9']);
    check('将帅照面：红方共 10 个合法着法', generateLegalMoves(pos).length, 10);
  }

  // 应将：被将军时，不能解的着法全部非法
  {
    const pos = build(['K@4,9', 'r@4,0', 'R@0,0']);
    check('被将军时只有 3 个合法着法', generateLegalMoves(pos).length, 3);
    check('车只能吃掉将军的车', legalFrom(pos, '0,0'), ['4,0']);
    check('帅只能离开被攻击的纵线', legalFrom(pos, '4,9'), ['3,9', '5,9']);
  }

  // 不能吃被保护的子
  {
    const pos = build(['K@4,9', 'r@4,8', 'c@4,0', 'p@4,4', 'k@3,0']);
    check('帅不能吃掉被炮保护的子', legalFrom(pos, '4,9').includes('4,8'), false);
    check('但可以躲开', legalFrom(pos, '4,9'), ['3,9', '5,9']);
  }
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: FAIL，`generateLegalMoves is not a function`

- [ ] **Step 3: 实现攻击判定**

在 `rules.js` 末尾追加：

```js
export function findKing(cells, side) {
  const target = side * K;
  for (let i = 0; i < CELLS; i++) if (cells[i] === target) return i;
  return -1;
}

/**
 * 判断 idx 这一格是否被 bySide 攻击。
 *
 * 用「反向探测」而不是「遍历所有棋子试吃」：每个方向最多扫到第二个子就停，
 * 成本与棋盘上有多少棋子无关。这个函数在搜索里每试走一步都要调一次，值得写细。
 *
 * 注意：车 / 炮 / 将这类滑行攻击是「扫描到第一个子」才命中的，
 * 所以传进来的 idx 上必须真的有子（实际调用时都是将 / 帅所在格，恒成立）。
 *
 * 将帅照面也在这里处理：两将同处一条纵线且中间无子时互相攻击，
 * 于是「走完之后两将照面」会被合法性检查直接拒掉，不需要额外的规则代码。
 */
export function isAttacked(cells, idx, bySide) {
  const x = xOf(idx), y = yOf(idx);
  const target = cells[idx];

  // 车 / 炮 / 将：沿四个正交方向
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (!inBoard(cx, cy)) continue;

    const first = cells[indexOf(cx, cy)];
    if (Math.sign(first) === bySide) {
      const abs = Math.abs(first);
      if (abs === R) return true;                                   // 车
      if (abs === K) {
        if (Math.abs(cx - x) + Math.abs(cy - y) === 1) return true; // 将贴身
        if (Math.abs(target) === K) return true;                    // 将帅照面（中间无子）
      }
    }

    // 炮：隔一个子才能吃
    cx += dx; cy += dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (inBoard(cx, cy)) {
      const second = cells[indexOf(cx, cy)];
      if (Math.sign(second) === bySide && Math.abs(second) === C) return true;
    }
  }

  // 马：反过来找八个能跳到 idx 的位置
  for (const [dx, dy, lx, ly] of HORSE) {
    const kx = x - dx, ky = y - dy;
    if (!inBoard(kx, ky)) continue;
    const v = cells[indexOf(kx, ky)];
    if (Math.sign(v) !== bySide || Math.abs(v) !== N) continue;
    if (cells[indexOf(kx + lx, ky + ly)] !== EMPTY) continue;       // 蹩马腿
    return true;
  }

  // 兵 / 卒：正前方一格 + 过河后的左右一格
  const py = y + bySide; // 兵所在的行：红方(bySide=1)在下一行，黑方(bySide=-1)在上一行
  if (inBoard(x, py)) {
    const v = cells[indexOf(x, py)];
    if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
  }
  const crossed = bySide === RED ? y <= 4 : y >= 5;
  if (crossed) {
    for (const dx of [-1, 1]) {
      const px = x + dx;
      if (!inBoard(px, y)) continue;
      const v = cells[indexOf(px, y)];
      if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
    }
  }

  return false;
}

export function inCheck(cells, side) {
  const king = findKing(cells, side);
  return king >= 0 && isAttacked(cells, king, -side);
}

/**
 * 合法着法 = 伪合法着法去掉「走完之后己方被将军」的那些。
 *
 * 用试走 + 回退而不是在生成时就过滤：只有一处判断逻辑，不容易漏。
 * 将 / 帅的起点只在循环外找一次；如果这一步走的正好是将 / 帅，则改查它的落点。
 */
export function generateLegalMoves(pos) {
  const { cells, side } = pos;
  const kingFrom = findKing(cells, side);
  if (kingFrom < 0) return [];

  const out = [];
  for (const move of generateMoves(cells, side)) {
    const from = moveFrom(move), to = moveTo(move);
    const captured = cells[to];
    cells[to] = cells[from];
    cells[from] = EMPTY;

    const kingAt = from === kingFrom ? to : kingFrom;
    if (!isAttacked(cells, kingAt, -side)) out.push(move);

    cells[from] = cells[to];
    cells[to] = captured;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/rules.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 攻击判定与合法着法过滤"
```

---

## Task 5: 终局判定与三次重复

**Files:**
- Modify: `chinese-chess/js/rules.js`
- Modify: `chinese-chess/tools/test-rules.mjs`

**Interfaces:**
- Consumes: Task 4 的 `generateLegalMoves`、`inCheck`
- Produces:
  - `gameStatus(pos) -> { type: 'playing'|'checkmate'|'stalemate', winner: 1|-1|null, moves: number[] }`
  - `isThreefoldRepetition(signatures: string[]) -> boolean`

- [ ] **Step 1: 追加测试**

```js
// --- 终局判定 ---
{
  const { gameStatus, isThreefoldRepetition } = await load('rules.js');

  check('起始局面是进行中', gameStatus(startPosition()).type, 'playing');

  // 将死：黑将困在九宫角，两个红车分别封住两条逃路
  {
    const mate = build(['k@3,0', 'R@3,5', 'R@4,5', 'K@4,9'], 'b');
    const st = gameStatus(mate);
    check('将死：类型为 checkmate', st.type, 'checkmate');
    check('将死：胜方是红', st.winner, 1);
    check('将死：没有合法着法', st.moves.length, 0);
  }

  // 困毙：黑将没被将军，但一步也走不了 —— 中国象棋里判负，不是和棋
  {
    const stale = build(['k@3,0', 'R@4,5', 'R@0,1', 'K@4,9'], 'b');
    const st = gameStatus(stale);
    check('困毙：类型为 stalemate', st.type, 'stalemate');
    check('困毙：走子方判负（胜方是红）', st.winner, 1);
  }

  // 三次重复
  check('三次重复：同一签名出现 3 次判和',
    isThreefoldRepetition(['A w', 'B b', 'A w', 'B b', 'A w']), true);
  check('三次重复：只出现 2 次不判和',
    isThreefoldRepetition(['A w', 'B b', 'A w', 'B b']), false);
  check('三次重复：轮走方不同算不同局面',
    isThreefoldRepetition(['A w', 'A b', 'A w']), false);
  check('三次重复：空序列不判和', isThreefoldRepetition([]), false);
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: FAIL，`gameStatus is not a function`

- [ ] **Step 3: 实现**

在 `rules.js` 末尾追加：

```js
/**
 * 终局判定。
 *
 * 中国象棋与国际象棋不同：困毙（无着法可走但没被将军）也是判负，不是和棋。
 * 所以两种情况都是走子方负，只有 type 不同 —— 界面要分开显示「将死」和「困毙」。
 */
export function gameStatus(pos) {
  const moves = generateLegalMoves(pos);
  if (moves.length > 0) return { type: 'playing', winner: null, moves };

  const checked = inCheck(pos.cells, pos.side);
  return {
    type: checked ? 'checkmate' : 'stalemate',
    winner: -pos.side,
    moves,
  };
}

/**
 * 三次重复判和。
 *
 * signatures 是按时间顺序排列的「局面签名」（positionSignature 的输出）。
 * 必须是签名而不是完整 FEN —— 回合数字段每次都变，用完整 FEN 永远比不出重复。
 *
 * 设计文档 §5.3 明确不做中国象棋的循环规则（长将 / 长捉判负），
 * 这一条是唯一的循环兜底，保证对局不会无限进行下去。
 */
export function isThreefoldRepetition(signatures) {
  const count = new Map();
  for (const s of signatures) {
    const n = (count.get(s) || 0) + 1;
    if (n >= 3) return true;
    count.set(s, n);
  }
  return false;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 `ok`，末行 `全部通过`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/rules.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 终局判定与三次重复判和"
```

---

## Task 6: 中文记谱

**Files:**
- Create: `chinese-chess/js/notation.js`
- Create: `chinese-chess/tools/test-notation.mjs`

**Interfaces:**
- Consumes: `config.js` 的 `CELLS/K/A/B/N/R/C/P/RED`；`position.js` 的 `indexOf/xOf/yOf`
- Produces: `toNotation(pos, move) -> string`（`pos` 是**走子之前**的局面）

- [ ] **Step 1: 写测试（此时必然失败）**

创建 `chinese-chess/tools/test-notation.mjs`：

```js
#!/usr/bin/env node
/**
 * 中文记谱测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-notation.mjs
 *
 * 规则见 design.md §6：棋子名 + 起始纵线 + 动作 + 目标。
 * 纵线号 = 9 - x，红方用汉字、黑方用阿拉伯数字。
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
check('黑卒1平2', note(['p@8,4'], 'b', '8,4', '7,4'), '卒1平2');
check('红车九平八', note(['R@0,9'], 'w', '0,9', '1,9'), '车九平八');

// 进 / 退：车、炮、兵、将记步数
check('红车九进一', note(['R@0,9'], 'w', '0,9', '0,8'), '车九进一');
check('红车九退一', note(['R@0,5'], 'w', '0,5', '0,6'), '车九退一');
check('黑车9退1', note(['r@0,4'], 'b', '0,4', '0,3'), '车9退1');
check('红兵五进一', note(['P@4,6'], 'w', '4,6', '4,5'), '兵五进一');
check('红帅五进一', note(['K@4,9'], 'w', '4,9', '4,8'), '帅五进一');
check('红车九进三记步数而不是纵线', note(['R@0,9'], 'w', '0,9', '0,6'), '车九进三');

// 进 / 退：马、象、士记目标纵线
check('红马八进七', note(['N@1,9'], 'w', '1,9', '2,7'), '马八进七');
check('黑马2进3', note(['n@7,0'], 'b', '7,0', '6,2'), '马2进3');
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

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-notation.mjs`
Expected: FAIL，`Cannot find module .../js/notation.js`

- [ ] **Step 3: 写 `notation.js`**

```js
/**
 * 中文记谱（炮二平五 / 车九进一）。纯逻辑。
 *
 * 只做「生成」，不做解析 —— 复盘靠着法列表的索引跳转，不需要从记谱串反推着法。
 *
 * 规则（design.md §6）：
 *   棋子名 + 起始纵线 + 动作 + 目标
 *   纵线号 = 9 - x，红方用汉字、黑方用阿拉伯数字
 *   车 / 炮 / 兵 / 将 的进退还记步数，马 / 象 / 士 记目标纵线
 *   同一纵线上有重子时，用「前 / 后」（三个用「前 / 中 / 后」，更多用数字）替代起始纵线
 */

import { CELLS, K, A, B, N, R, C, P, RED } from './config.js';
import { indexOf, xOf, yOf } from './position.js';

// 棋子名，索引 = 棋子编码（1..7）
const RED_NAMES = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
const BLACK_NAMES = ['', '将', '士', '象', '马', '车', '炮', '卒'];

const RED_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BLACK_DIGITS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * 纵线号：x = 8 记作「一 / 1」，x = 0 记作「九 / 9」。
 * 两方数值相同 —— 红方从自己的右边数起，黑方从自己的左边数起，正好落在同一个 x 方向上。
 */
function fileNumber(x) { return 9 - x; }

function digit(side, n) { return side === RED ? RED_DIGITS[n] : BLACK_DIGITS[n]; }

/**
 * 决定「谁在走」这一段。
 *   同纵线只有这一个同类子 → 用起始纵线，如「炮八」
 *   两个 → 「前 / 后」
 *   三个 → 「前 / 中 / 后」
 *   四个以上（只可能是兵）→ 「一 / 二 / 三 …」，从前往后数
 *
 * 「前」是更靠近对方的那一个：红方 y 更小，黑方 y 更大。
 */
function subjectOf(cells, from, side, abs, name) {
  const x = xOf(from);
  const sameFile = [];
  for (let y = 0; y < 10; y++) {
    const i = indexOf(x, y);
    if (cells[i] === side * abs) sameFile.push(i);
  }

  if (sameFile.length === 1) return `${name}${digit(side, fileNumber(x))}`;

  // 从前往后排序：红方 y 递增即从前往后，黑方相反
  const ordered = side === RED ? sameFile : sameFile.slice().reverse();
  const rank = ordered.indexOf(from);

  if (sameFile.length === 2) return `${rank === 0 ? '前' : '后'}${name}`;
  if (sameFile.length === 3) return `${['前', '中', '后'][rank]}${name}`;
  return `${digit(side, rank + 1)}${name}`;
}

/**
 * 生成一步棋的中文记谱。pos 必须是**走子之前**的局面 ——
 * 判断有没有重子、决定用纵线还是前后，都要看走之前的棋盘。
 */
export function toNotation(pos, move) {
  const { cells, side } = pos;
  const from = Math.floor(move / CELLS);
  const to = move % CELLS;

  const piece = cells[from];
  if (piece === 0) throw new Error('记谱失败：起点没有棋子');

  const abs = Math.abs(piece);
  const s = Math.sign(piece);
  const name = s === RED ? RED_NAMES[abs] : BLACK_NAMES[abs];
  const subject = subjectOf(cells, from, s, abs, name);

  const fx = xOf(from), fy = yOf(from);
  const tx = xOf(to), ty = yOf(to);

  if (ty === fy) return `${subject}平${digit(s, fileNumber(tx))}`;

  // 红方 y 减小为「进」，黑方 y 增大为「进」—— 乘上阵营符号后统一判负
  const verb = (ty - fy) * s < 0 ? '进' : '退';

  // 车 / 炮 / 兵 / 将 记步数，马 / 象 / 士 记目标纵线
  const bySteps = abs === R || abs === C || abs === P || abs === K;
  const target = bySteps ? digit(s, Math.abs(ty - fy)) : digit(s, fileNumber(tx));
  return `${subject}${verb}${target}`;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-notation.mjs`
Expected: 全部 `ok`，末行 `全部通过`

- [ ] **Step 5: 回归一遍规则测试**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 `ok`（只是确认没碰坏前面）

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/notation.js chinese-chess/tools/test-notation.mjs
git commit -m "feat(chinese-chess): 中文记谱生成"
```

---

## 完成标准

本计划完成时，以下命令必须都通过、退出码为 0：

```bash
node chinese-chess/tools/test-rules.mjs
node chinese-chess/tools/test-notation.mjs
```

此时规则正确性已经锁死。后续计划（AI 层 / 界面层 / 残局库 / 持久化）在此基础上叠加，不需要回头改规则——如果确实要改，上面两个脚本就是回归网。

---

## 本计划自查记录

写完后对照 `design.md` 逐节核对，发现并修掉了以下问题（记在这里，免得后面有人重新踩）：

1. **`isAttacked` 的测试原本必然失败。** 车 / 炮 / 将这类滑行攻击的实现是「沿方向扫描，遇到第一个子就停」，所以**目标格上必须有子**才会命中。原先的测试往空的目标格上测，全部会返回 `false`。现在统一用一个 `attacked()` 包装函数往目标格塞一个红兵当靶子。
2. **`将 / 帅在九宫角` 的落点数写错了。** 原先写「3 个落点」，但九宫角（如 `(5,0)`）只有两个相邻格在宫内，正确是 2。
3. **`车被己方挡住` 的断言原先写得又长又绕**，重写成直接列出期望的落点数组。
4. **补上了「车可以吃敌子」和「炮的炮架是己方子」两条断言**——前者是车生成器里唯一的分支（遇敌子可吃），后者是炮生成器最容易写反的地方（炮架不区分敌我，能吃的是炮架后面的子）。
5. **`clonePosition` 加了深拷贝断言**。如果哪天有人把它改成返回原对象，规则层不会立刻出错，但 AI 层的试走会静默串味——这种 bug 最难查，所以现在就钉住。
6. **`§4.4` 的 Zobrist 明确移出本计划**，理由记在开头。它只被 AI 层的置换表用到，放在这里就是死代码。

### 未覆盖项

`design.md` §5.4 的 `isLegalPosition()`（残局库用的局面合法性校验）**不在本计划里**。它依赖 `findKing` 和 `isAttacked`，等残局库那份计划一起做更合适——那时才有真实的残局数据来驱动它需要检查哪些条件。
