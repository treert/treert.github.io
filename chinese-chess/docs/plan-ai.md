# 中国象棋 AI 层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AI 搜索（`engine.js`）与 Worker 外壳（`worker.js`），产出四个挡位的对手，并有一个自对弈冒烟脚本。

**Architecture:** 局面用 Zobrist 哈希做置换表索引，搜索是负极大值形式的 alpha-beta + 迭代加深 + 静态搜索。搜索过程复用**同一个可变状态对象**（`cells` / `side` / `key`），走子与回退成对出现，不在节点上分配对象。挡位是 `config.js` 里的一张声明式策略表，弱化手段（关静态搜索、评分加噪、按概率失误）都在根节点统一施加。

**Tech Stack:** 纯 ES Module + Node 内置模块。无依赖、无构建工具。

**本计划的范围：** 设计文档 `chinese-chess/docs/design.md` 的 §4.4（Zobrist）与 §7（AI 引擎）。

**前置条件：** 规则层计划（`plan.md`）已全部完成，`node chinese-chess/tools/test-rules.mjs` 与 `test-notation.mjs` 全绿。

## Global Constraints

与规则层计划相同，逐条照搬：

- **无依赖**：不引入任何 npm 包，只用 Node 内置模块。
- **无构建工具 / 无 `package.json`**：源文件直接就是浏览器能加载的 ES Module。必须显式用 `import` / `export`。
- **模块隔离**：不得引用其他模块的文件，不共享全局变量、`localStorage` key、CSS 类名。
- **纯逻辑模块不得碰 DOM**：`config.js` / `position.js` / `rules.js` / `notation.js` / `engine.js` 会被 Worker 加载，出现任何 `document` / `window` 都会让 Worker 崩掉。**`worker.js` 是唯一允许碰 `self` 的文件。**
- **测试脚本必须能直接跑**：`node chinese-chess/tools/test-engine.mjs`，从任何工作目录执行都可以。
- **坐标与编码**：`idx = y * 9 + x`，`x` 向右 0..8、`y` 向下 0..9；`0` 空、正数红方、负数黑方；`K=1 A=2 B=3 N=4 R=5 C=6 P=7`。
- **搜索必须确定性可测**：所有随机性（评分噪声、失误率）都要走可注入的 `rng`，默认 `Math.random`。测试里注入固定种子的 rng。

---

## 文件结构

| 文件 | 职责 | 本计划中的变化 |
|------|------|----------------|
| `chinese-chess/js/config.js` | 常量与可调参数 | 追加 `PIECE_VALUE` / `PASSED_PAWN_BONUS` / `LEVELS` |
| `chinese-chess/js/position.js` | 局面与 FEN | 追加 Zobrist 哈希 |
| `chinese-chess/js/engine.js` | 评估 + 搜索 | **新建** |
| `chinese-chess/js/worker.js` | Worker 外壳 | **新建** |
| `chinese-chess/tools/test-engine.mjs` | AI 层测试 | **新建** |
| `chinese-chess/tools/selfplay.mjs` | 自对弈冒烟 | **新建** |

---

## Task 1: Zobrist 哈希

**Files:**
- Modify: `chinese-chess/js/position.js`
- Create: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: `config.js` 的 `CELLS` / `EMPTY` / `BLACK`；`position.js` 已有的 `startPosition` / `parseFen` / `toFen`
- Produces:
  - `hashPiece(piece, idx) -> number`（32 位无符号；`piece === EMPTY` 时返回 0）
  - `hashSide() -> number`
  - `zobristKey(cells, side) -> number`（全量计算，32 位无符号）

**关键设计：`hashPiece(EMPTY, idx)` 必须返回 0。** 这样走子/回退时可以把「被吃子」的哈希无条件异或进去，不用写 `if (captured !== EMPTY)`，两边对称、不容易写错。

- [ ] **Step 1: 建立测试骨架（此时必然失败）**

创建 `chinese-chess/tools/test-engine.mjs`：

```js
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

// === 以下为各任务追加的测试块 ===

// === 收尾 ===
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`zobristKey is not a function`（或 `Cannot find module` 之类）

- [ ] **Step 3: 在 `position.js` 末尾追加 Zobrist**

```js
/**
 * Zobrist 哈希。
 *
 * 用 32 位整数（不是 64 位）：搜索节点数在 10^6 量级，
 * 10^6 / 2^32 ≈ 0.02% 的碰撞概率，而置换表查找时还会校验着法合法性，
 * 所以碰撞最多导致缓存失效，不会产生错误着法。
 *
 * 随机数用固定种子的 xorshift32 生成 —— 必须是确定性的，
 * 否则同一个局面的哈希每次刷新都不一样，测试没法断言，调试也没法复现。
 */
const HASH_SEED = 0x9e3779b9;
let PIECE_HASH = null;
let SIDE_HASH = 0;

function initHash() {
  if (PIECE_HASH) return;
  let s = HASH_SEED >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
  // 15 个槽位对应棋子编码 -7..7（索引 = 编码 + 7），索引 7 是空位，恒为 0
  PIECE_HASH = [];
  for (let piece = -7; piece <= 7; piece++) {
    const row = new Uint32Array(CELLS);
    if (piece !== EMPTY) for (let i = 0; i < CELLS; i++) row[i] = next();
    PIECE_HASH.push(row);
  }
  SIDE_HASH = next();
}

/**
 * 某个棋子站在某一格上的哈希值。
 *
 * EMPTY 恒返回 0 —— 这样走子 / 回退时可以无条件把「被吃子」异或进去，
 * 两边对称，不用写 if (captured !== EMPTY)，少一处可能写错的地方。
 */
export function hashPiece(piece, idx) {
  if (piece === EMPTY) return 0;
  initHash();
  return PIECE_HASH[piece + 7][idx];
}

/** 轮到黑方走时额外异或的值 */
export function hashSide() {
  initHash();
  return SIDE_HASH;
}

/** 全量计算一个局面的哈希 */
export function zobristKey(cells, side) {
  initHash();
  let key = 0;
  for (let i = 0; i < CELLS; i++) key = (key ^ PIECE_HASH[cells[i] + 7][i]) >>> 0;
  if (side === BLACK) key = (key ^ SIDE_HASH) >>> 0;
  return key;
}
```

- [ ] **Step 4: 追加测试**

在 `test-engine.mjs` 的「以下为各任务追加的测试块」之后插入：

```js
// --- Zobrist 哈希 ---
{
  const start = startPosition();
  const key = zobristKey(start.cells, start.side);

  check('同一局面两次计算得到同一个哈希', zobristKey(start.cells, start.side), key);
  check('哈希是 32 位无符号整数', key >= 0 && key <= 0xFFFFFFFF, true);

  check('轮走方不同则哈希不同',
    zobristKey(start.cells, -1) === key, false);

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

  // 交换两个同类同色棋子：棋盘内容变了（位置不同），哈希必须跟着变
  {
    const swapped = startPosition();
    const a = idxOf('0,9'), b = idxOf('8,9');
    const tmp = swapped.cells[a];
    swapped.cells[a] = swapped.cells[b];
    swapped.cells[b] = tmp;
    check('交换两个红车则哈希改变', zobristKey(swapped.cells, swapped.side) === key, false);
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
```

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`，末行 `全部通过`

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/position.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): Zobrist 哈希"
```

---

## Task 2: 评估函数

**Files:**
- Modify: `chinese-chess/js/config.js`
- Create: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: `config.js` 的 `CELLS` / `EMPTY` / `K` / `A` / `B` / `N` / `R` / `C` / `P` / `RED`；`position.js` 的 `yOf`
- Produces:
  - `config.js`：`PIECE_VALUE: number[]`（索引 = 棋子编码 1..7）、`PASSED_PAWN_BONUS: number`
  - `engine.js`：`evaluate(cells, side) -> number`（**返回轮走方视角的分值**，负极大值搜索要求）

- [ ] **Step 1: 追加测试**

```js
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
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`Cannot find module .../js/engine.js`

- [ ] **Step 3: 在 `config.js` 末尾追加**

```js
// === 评估 ===
// 索引 = 棋子编码（1..7）。
// 帅 / 将 记 0：双方恒各有一个，算进子力只会互相抵消，白增加一次查表。
export const PIECE_VALUE = [0, 0, 200, 200, 400, 900, 450, 100];
//                            K   A    B    N    R    C    P

// 兵 / 卒过河的额外加分
export const PASSED_PAWN_BONUS = 50;
```

- [ ] **Step 4: 创建 `engine.js`**

```js
/**
 * AI 引擎：评估 + 搜索。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 对外只有一个入口 search()，内部结构（置换表、着法排序、静态搜索）都可以换，
 * 不影响调用方。这是「方便后续优化」的落点。
 */

import { CELLS, EMPTY, K, A, B, N, R, C, P, RED, PIECE_VALUE, PASSED_PAWN_BONUS } from './config.js';
import { yOf } from './position.js';

/**
 * 静态评估：只算子力和兵是否过河。
 *
 * 返回**轮走方视角**的分值 —— 负极大值搜索要求「分数总是对当前走子方有利为正」。
 *
 * 刻意不加机动性、位置表这类项：
 *   - 机动性需要生成全部着法，而评估在叶节点被调用上百万次，等于把搜索成本翻倍
 *   - 位置表要维护 7 × 90 格的数据，是独立的一块手工维护点，留到棋力不够时再加
 * 想提升棋力，正确的下一步是加 90 格位置表（O(1) 查表），不是加需要生成着法的项。
 */
export function evaluate(cells, side) {
  let score = 0; // 先按红方视角累加
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const abs = Math.abs(v);
    let value = PIECE_VALUE[abs];
    if (abs === P) {
      const y = yOf(i);
      const crossed = v > 0 ? y <= 4 : y >= 5;
      if (crossed) value += PASSED_PAWN_BONUS;
    }
    score += v > 0 ? value : -value;
  }
  return side === RED ? score : -score;
}
```

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/config.js chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): 子力评估函数"
```

---

## Task 3: 搜索核心（negamax + alpha-beta）

**Files:**
- Modify: `chinese-chess/js/config.js`（追加 `LEVELS`）
- Modify: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: Task 1 的 `zobristKey` / `hashPiece` / `hashSide`；Task 2 的 `evaluate`；`rules.js` 的 `generateMoves` / `generateLegalMoves` / `isAttacked` / `findKing` / `encodeMove` / `moveFrom` / `moveTo`
- Produces:
  - `config.js`：`LEVELS: Level[]`，`Level = { id, name, depth, timeLimitMs, quiescence, noise, blunderRate }`
  - `engine.js`：`class Searcher`（导出供测试）、`search(fen, level, options) -> SearchResult | null`
  - `SearchResult = { move: number, from: number, to: number, score: number, depth: number, nodes: number, timeMs: number }`
  - `search` 的 `level` 参数接受**挡位 id 字符串**或**挡位对象**（测试要构造自定义挡位）；`options = { rng }`

- [ ] **Step 1: 追加测试**

```js
// --- 搜索：negamax + alpha-beta ---
{
  const { Searcher, search } = await load('engine.js');
  const { generateLegalMoves } = await load('rules.js');

  const legalSet = (pos) => new Set(generateLegalMoves(pos));

  // 深度 1 的固定挡位：关掉一切随机性，只验搜索本身
  const plain = { id: 'test', name: '测试', depth: 1, timeLimitMs: 10000,
                  quiescence: false, noise: 0, blunderRate: 0 };

  // 一步杀：黑将 (3,0)；红车 (4,5) 封住逃路 (4,0)；
  // 红车 (0,9) 平到 (3,9) 后沿纵线 3 将军，黑将的两条逃路都被堵死。
  //
  // 这条**不能断言「唯一杀着」** —— 这个局面里红方有好几个着法都能让黑方无路可走
  // （比如车 (4,5) 走到 (4,1) 造成困毙，而困毙在中国象棋里同样判黑方负）。
  // 断言「走完之后黑方一步都走不了」才是稳定的。
  //
  // 必须用 depth 2：depth <= 0 的节点直接返回静态评估、不生成着法，
  // 所以**深度 1 发现不了「对方没着法可走」**。这是设计文档 §7.1「不做将军延伸」
  // 的直接后果，不是 bug。（开了静态搜索的挡位例外：quiesce 在被将军时会搜全部着法。）
  {
    const fen = '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1';
    const r = search(fen, { ...plain, depth: 2 }, { rng: seededRng(1) });

    const after = parseFen(fen);
    after.cells[r.to] = after.cells[r.from];
    after.cells[r.from] = 0;
    after.side = -after.side;
    check('一步杀：走完之后黑方一步都走不了', generateLegalMoves(after).length, 0);
    check('一步杀：分值显示为必胜（远高于任何子力价值）', r.score > 90000, true);
  }

  // 吃白送的子：黑车 (4,4) 无人保护，红车 (4,9) 沿纵线 4 直接吃掉
  {
    const fen = '5k3/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1';
    const r = search(fen, plain, { rng: seededRng(1) });
    check('吃白送的子：红车吃掉黑车',
      [coordOf(r.from), coordOf(r.to)], ['4,9', '4,4']);
  }

  // 救子：黑马 (3,7) 盯着红车 (4,9)，而红车一步之内吃不到马（马不走直线），
  // 所以红车必须挪走，否则丢一个车。
  // 这条要用 depth 2 —— 深度 1 只能看到自己走完的局面，看不到对方的下一步。
  {
    const fen = '4k4/9/9/9/9/9/9/3n5/9/4RK3 w - - 0 1';
    const r = search(fen, { ...plain, depth: 2 }, { rng: seededRng(1) });
    check('被马盯上的红车必须先跑', coordOf(r.from), '4,9');
  }

  // 引擎返回的着法必须合法
  {
    const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
    const r = search(fen, plain, { rng: seededRng(1) });
    const legal = legalSet(parseFen(fen));
    check('起始局面的返回着法合法', legal.has(r.move), true);
  }

  // 增量哈希与全量哈希必须一致 —— 走子 / 回退写错了会静默串味
  {
    const pos = startPosition();
    const s = new Searcher(pos.cells.slice(), pos.side);
    const before = zobristKey(s.cells, s.side);
    check('构造时哈希与全量计算一致', s.key, before);

    const moves = generateLegalMoves({ cells: s.cells, side: s.side }).slice(0, 12);
    const undo = [];
    for (const m of moves) undo.push([m, s.make(m)]);
    check('连续走 12 步后，增量哈希仍与全量一致', s.key, zobristKey(s.cells, s.side));
    check('连走 12 步后轮走方翻转了 12 次', s.side, pos.side);

    for (let i = undo.length - 1; i >= 0; i--) s.unmake(undo[i][0], undo[i][1]);
    check('全部回退后哈希还原', s.key, before);
    check('全部回退后轮走方还原', s.side, pos.side);
    check('全部回退后棋盘还原', Array.from(s.cells), Array.from(pos.cells));
  }

  // 只有一个合法着法时必须返回它。
  // 局面：黑将 (4,0)，红车 (3,1) 同时封住 (3,0) 和 (4,1)，黑方只剩 (5,0) 可走。
  // 注意不能图省事写成「红帅 (4,9) + 黑将 (4,0)」—— 那是将帅照面，
  // 黑方反而有两个合法着法（(3,0) 和 (5,0)），测不到「唯一着法」。
  {
    const fen = '4k4/3R5/9/9/9/9/9/9/9/3K5 b - - 0 1';
    const r = search(fen, plain, { rng: seededRng(1) });
    check('黑方只剩一个着法时返回它', [coordOf(r.from), coordOf(r.to)], ['4,0', '5,0']);
  }

  // 已经终局的局面返回 null。
  // 局面：黑将 (3,0) 被红车 (3,5) 沿纵线将军，逃路 (4,0) 又被红车 (4,5) 封住。
  {
    const fen = '3k5/9/9/9/9/3RR4/9/9/9/4K4 b - - 0 1';
    const r = search(fen, { ...plain, depth: 3 }, { rng: seededRng(1) });
    check('无着法可走时返回 null', r, null);
  }
}
```

> **测试局面清单**（本计划里出现的全部 FEN，已逐局画棋盘核对过）：
>
> | 用途 | FEN | 子力（坐标 `x,y`） |
> |------|-----|---------------------|
> | 一步杀 | `3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1` | 黑将 `3,0`；红车 `4,5`、`0,9`；红帅 `4,9` |
> | 吃白送的子 | `5k3/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1` | 黑将 `5,0`；黑车 `4,4`；红帅 `3,9`；红车 `4,9` |
> | 救子 | `4k4/9/9/9/9/9/9/3n5/9/4RK3 w - - 0 1` | 黑将 `4,0`；黑马 `3,7`；红车 `4,9`；红帅 `5,9` |
> | 唯一着法 | `4k4/3R5/9/9/9/9/9/9/9/3K5 b - - 0 1` | 黑将 `4,0`；红车 `3,1`；红帅 `3,9` |
> | 已经终局 | `3k5/9/9/9/9/3RR4/9/9/9/4K4 b - - 0 1` | 黑将 `3,0`；红车 `3,5`、`4,5`；红帅 `4,9` |
> | 着法排序 | `4k4/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1` | 同「吃白送的子」 |
> | 静态搜索 | `4k4/9/9/9/r3p4/4R4/9/9/9/3K5 w - - 0 1` | 黑将 `4,0`；黑车 `0,4`；黑卒 `4,4`；红车 `4,5`；红帅 `3,9` |
>
> **写新局面时的三条硬性检查**（每一条都在实际执行时踩过）：
>
> 1. **两将不能在同一条纵线上且中间无子** —— 那是照面，局面本身不合法。
>    上一轮实现规则层时，就是因为把黑将放在了红帅同一条纵线上，
>    把「没被将军」测成了照面，而且另一条断言**碰巧绿了**、根本没测到想测的东西。
> 2. **红帅的位置会通过照面影响黑将的逃路**。上面「唯一着法」那局对此极其敏感：
>    帅放 `4,9` 是照面（局面非法）；帅放 `5,9` 则黑将走到 `5,0` 会和帅照面，
>    黑方一步都走不了 —— **变成困毙**，`search` 返回 `null`，断言直接崩在「读 null 的 from」上；
>    只有帅放 `3,9` 才恰好只剩一个合法着法。
> 3. **别想当然认为解法唯一**。上面「一步杀」那局，红方有好几个着法都能让黑方无路可走
>    （将死和困毙在中国象棋里都判负）。断言「唯一杀着」会失败，
>    断言「走完之后对方一步都走不了」才稳定。同理，「救子」那局初稿把帅放在 `3,9`，
>    结果帅走到 `3,8` 正好蹩住马腿、同样保住了车 —— 写这类局面时必须检查
>    **除了目标解法还有没有别的着法能达到同样效果**。

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`search is not a function`

- [ ] **Step 3: 在 `config.js` 末尾追加挡位表**

```js
// === AI 挡位 ===
// 每个挡位是一组声明式参数，弱化手段都在这里调，不要散到 engine.js 的 if 里。
//
// 四个挡位而不是五个：深度 6 与 7 对普通玩家体感没有差别，耗时却翻倍。
//
// quiescence（静态搜索）是让 AI「像新手」最有效的单个开关：
// 关掉它，AI 会在兑子序列中途停下、以为自己占便宜，结果被吃回 ——
// 这恰恰是初学者的真实特征，比单纯降深度像得多。
//
// depth 是迭代加深的上限，实际由 timeLimitMs 截断。
// noise 是根节点评分扰动幅度（与评估函数同单位）；blunderRate 是按概率故意走次优着。
export const LEVELS = [
  { id: 'novice', name: '入门', depth: 1,  timeLimitMs: 200,  quiescence: false, noise: 120, blunderRate: 0.35 },
  { id: 'easy',   name: '初级', depth: 3,  timeLimitMs: 400,  quiescence: false, noise: 60,  blunderRate: 0.15 },
  { id: 'medium', name: '中级', depth: 5,  timeLimitMs: 800,  quiescence: true,  noise: 20,  blunderRate: 0.03 },
  { id: 'hard',   name: '高级', depth: 64, timeLimitMs: 1500, quiescence: true,  noise: 0,   blunderRate: 0 },
];
```

- [ ] **Step 4: 在 `engine.js` 追加搜索核心**

```js
import { generateMoves, generateLegalMoves, isAttacked, findKing, moveFrom, moveTo, encodeMove } from './rules.js';
import { zobristKey, hashPiece, hashSide } from './position.js';
import { LEVELS } from './config.js';

const INF = 1e9;
/** 将死分值。用「离根多远」微调，让引擎偏好更快的杀棋、更晚的被杀 */
const MATE = 100000;

/**
 * 一次搜索的全部可变状态。
 *
 * 整个搜索复用同一个实例：节点上不分配对象，走子与回退成对出现。
 * 这是引擎里唯一「可变」的地方 —— 对外暴露的 search() 每次都会新建一个。
 */
export class Searcher {
  constructor(cells, side, level, rng = Math.random) {
    this.cells = cells;
    this.side = side;
    this.key = zobristKey(cells, side);
    this.level = level;
    this.rng = rng;
    this.nodes = 0;
    this.deadline = Infinity;
    this.checkEvery = 0;
  }

  /**
   * 走一步。返回被吃的子（可能是 EMPTY），回退时要原样传回 unmake()。
   *
   * 哈希的三个异或项是无条件写的 —— 因为 hashPiece(EMPTY, idx) 恒为 0，
   * 所以「没吃子」这一支不需要特殊处理，make / unmake 两边也就天然对称。
   */
  make(move) {
    const from = moveFrom(move), to = moveTo(move);
    const piece = this.cells[from];
    const captured = this.cells[to];
    this.key = (this.key ^ hashPiece(piece, from) ^ hashPiece(piece, to) ^ hashPiece(captured, to)) >>> 0;
    this.cells[to] = piece;
    this.cells[from] = EMPTY;
    this.side = -this.side;
    this.key = (this.key ^ hashSide()) >>> 0;
    return captured;
  }

  unmake(move, captured) {
    const from = moveFrom(move), to = moveTo(move);
    const piece = this.cells[to];
    this.key = (this.key ^ hashPiece(piece, to) ^ hashPiece(piece, from) ^ hashPiece(captured, to)) >>> 0;
    this.cells[from] = piece;
    this.cells[to] = captured;
    this.side = -this.side;
    this.key = (this.key ^ hashSide()) >>> 0;
  }

  /**
   * 刚走完的那一方，其将 / 帅是否安全（也就是这一步是否合法）。
   *
   * 注意 make() 已经把 this.side 翻成了**对方**，
   * 所以要查的是 -this.side 的将、被 this.side 攻击。
   * 写成 `findKing(this.cells, this.side)` 会检查错的一方 —— 症状是引擎走出
   * 「送将」的着法，但不会报任何错。
   */
  leavesKingSafe() {
    const mover = -this.side;
    const king = findKing(this.cells, mover);
    return king >= 0 && !isAttacked(this.cells, king, this.side);
  }

  /** 负极大值形式的 alpha-beta */
  negamax(depth, alpha, beta, ply) {
    this.nodes++;

    if (depth <= 0) return evaluate(this.cells, this.side);

    let best = -INF;
    let legalCount = 0;

    for (const move of generateMoves(this.cells, this.side)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      legalCount++;

      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(move, captured);

      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }

    // 一步都走不了 = 被将死或困毙，两种情况在中国象棋里都是走子方负
    if (legalCount === 0) return -MATE + ply;
    return best;
  }

  /** 搜索根节点，返回 { move, score, scores } */
  searchRoot(depth) {
    const moves = generateLegalMoves({ cells: this.cells, side: this.side });
    if (moves.length === 0) return null;

    let bestMove = moves[0];
    let bestScore = -INF;
    const scores = new Map();

    for (const move of moves) {
      const captured = this.make(move);
      const score = -this.negamax(depth - 1, -INF, -bestScore, 1);
      this.unmake(move, captured);
      scores.set(move, score);
      if (score > bestScore) { bestScore = score; bestMove = move; }
    }
    return { move: bestMove, score: bestScore, scores };
  }
}

/**
 * 搜索入口。
 *
 * level 可以是挡位 id，也可以直接是一个挡位对象 ——
 * 测试需要构造「深度 1、无随机性」这类自定义挡位，走对象形式最省事。
 * options.rng 用来注入随机源，默认 Math.random；测试传固定种子以得到确定结果。
 */
export function search(fen, level, options = {}) {
  const lv = typeof level === 'string' ? LEVELS.find((l) => l.id === level) : level;
  if (!lv) throw new Error(`未知挡位：${level}`);

  const pos = parseFen(fen);
  const searcher = new Searcher(pos.cells, pos.side, lv, options.rng || Math.random);
  searcher.deadline = Date.now() + lv.timeLimitMs;

  const started = Date.now();
  const result = searcher.searchRoot(Math.min(lv.depth, 1)); // 迭代加深在 Task 6 加
  if (!result) return null;

  return {
    move: result.move,
    from: moveFrom(result.move),
    to: moveTo(result.move),
    score: result.score,
    depth: 1,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
  };
}
```

> `engine.js` 顶部已有的 `import` 需要合并，不要重复写 `config.js` / `position.js` 的两行。

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`。

**如果「一步将死」或「吃白送的子」失败，先怀疑搜索实现（alpha-beta 的窗口传参最容易写反），再怀疑上面那张局面表。** 局面表已经逐局画棋盘核对过，而 alpha-beta 的窗口写反是个很典型的错误：`-this.negamax(depth - 1, -beta, -alpha, ...)` 里两个参数都带负号，漏一个就会得到「看似能搜、但结果全错」的行为。

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/config.js chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): negamax + alpha-beta 搜索核心与挡位表"
```

---

## Task 4: 置换表与着法排序

**Files:**
- Modify: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: Task 3 的 `Searcher`
- Produces: `Searcher` 新增 `tt`（`Map`）、`killers`、`history`，以及 `orderMoves()`；`search()` 的返回值不变

- [ ] **Step 1: 追加测试**

```js
// --- 置换表与着法排序 ---
{
  const { Searcher, search } = await load('engine.js');
  const base = { id: 'test', name: '测试', depth: 4, timeLimitMs: 60000,
                 quiescence: false, noise: 0, blunderRate: 0 };

  const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

  // 置换表不能改变搜索结果
  {
    const a = search(fen, { ...base, useTT: false }, { rng: seededRng(7) });
    const b = search(fen, { ...base, useTT: true }, { rng: seededRng(7) });
    check('开启置换表后最优着法不变', b.move, a.move);
    check('开启置换表后分值不变', b.score, a.score);
    check('开启置换表后访问的节点不增加', b.nodes <= a.nodes, true);
  }

  // 着法排序：吃子必须排在非吃子前面
  {
    // 红车 (4,9) 与黑车 (4,4) 同在纵线 4，中间全空 —— 红方有吃子可选，
    // 排序测试才有意义（没有吃子时这条断言会退化成「恒真」）
    const pos = parseFen('4k4/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1');
    const s = new Searcher(pos.cells.slice(), pos.side, base);
    const ordered = s.orderMoves(generateMoves(s.cells, s.side), 0, 0);
    const firstNonCapture = ordered.findIndex((m) => s.cells[moveTo(m)] === 0);
    const lastCapture = ordered.map((m) => s.cells[moveTo(m)] !== 0).lastIndexOf(true);
    check('所有吃子都排在非吃子之前', lastCapture < firstNonCapture, true);
  }

  // 置换表命中率：搜同一局面两次，第二次的节点数应明显更少
  {
    const s = new Searcher(parseFen(fen).cells, 1, base);
    s.searchRoot(3);
    const first = s.nodes;
    const before = s.nodes;
    s.searchRoot(3);
    check('第二次搜同一局面时节点数明显减少', s.nodes - before < first, true);
  }
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`s.orderMoves is not a function`

- [ ] **Step 3: 实现**

在 `Searcher` 的 `constructor` 里追加：

```js
    this.useTT = level.useTT !== false;
    this.tt = new Map();                 // key -> { depth, score, flag, move }
    this.killers = [];                   // killers[ply] = [move1, move2]
    this.history = new Int32Array(CELLS * CELLS);
```

在 `Searcher` 里追加方法：

```js
  /**
   * 着法排序。顺序直接决定 alpha-beta 的剪枝效率，是引擎里性价比最高的一处优化。
   * 优先级：置换表着法 > 吃子（MVV-LVA）> 杀手着法 > 历史启发。
   */
  orderMoves(moves, ply, ttMove) {
    const score = (move) => {
      if (move === ttMove) return 1e7;
      const victim = this.cells[moveTo(move)];
      if (victim !== EMPTY) {
        // MVV-LVA：优先「用小子吃大子」
        return 1e6 + PIECE_VALUE[Math.abs(victim)] * 10
                    - PIECE_VALUE[Math.abs(this.cells[moveFrom(move)])];
      }
      const k = this.killers[ply];
      if (k) {
        if (k[0] === move) return 9e5;
        if (k[1] === move) return 8e5;
      }
      return this.history[move];
    };
    return moves.slice().sort((a, b) => score(b) - score(a));
  }

  /** 把一个着法记为杀手着法（在同一层造成剪枝的非吃子着法） */
  recordKiller(move, ply) {
    const k = this.killers[ply] || (this.killers[ply] = [0, 0]);
    if (k[0] === move) return;
    k[1] = k[0];
    k[0] = move;
  }
```

把 `negamax` 换成带置换表与排序的版本：

```js
  negamax(depth, alpha, beta, ply) {
    this.nodes++;

    const alphaOrig = alpha;
    let ttMove = 0;
    if (this.useTT) {
      const e = this.tt.get(this.key);
      if (e) {
        ttMove = e.move;
        if (e.depth >= depth) {
          if (e.flag === TT_EXACT) return e.score;
          if (e.flag === TT_LOWER && e.score > alpha) alpha = e.score;
          else if (e.flag === TT_UPPER && e.score < beta) beta = e.score;
          if (alpha >= beta) return e.score;
        }
      }
    }

    if (depth <= 0) return evaluate(this.cells, this.side);

    let best = -INF;
    let bestMove = 0;
    let legalCount = 0;

    for (const move of this.orderMoves(generateMoves(this.cells, this.side), ply, ttMove)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      legalCount++;

      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(move, captured);

      if (score > best) { best = score; bestMove = move; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (captured === EMPTY) {
          this.recordKiller(move, ply);
          this.history[move] += depth * depth;
        }
        break;
      }
    }

    if (legalCount === 0) return -MATE + ply;

    // 杀棋分值带「离根多远」的信息，存进置换表后换了层数就不对了，所以不存
    if (this.useTT && Math.abs(best) < MATE - 1000) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      this.tt.set(this.key, { depth, score: best, flag, move: bestMove });
    }
    return best;
  }
```

在文件顶部（`MATE` 旁边）加：

```js
// 置换表条目类型：精确值 / 只证明了上界 / 只证明了下界
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
```

在 `search()` 里把 `Math.min(lv.depth, 1)` 换成 `lv.depth`。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): 置换表与着法排序"
```

---

## Task 5: 静态搜索

**Files:**
- Modify: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: Task 4 的 `Searcher`
- Produces: `Searcher.quiesce(alpha, beta, ply, qdepth)`；`negamax` 在 `depth <= 0` 时按挡位决定是否调用它

- [ ] **Step 1: 追加测试**

```js
// --- 静态搜索 ---
{
  const { search } = await load('engine.js');
  const { evaluate } = await load('engine.js');

  // 红车可以吃黑卒，但吃完会被黑车吃回。
  // 关掉静态搜索的深度 1 会贪这一口（这正是「入门」挡位的设计意图）；
  // 开启静态搜索就能看到兑子序列，不去贪。
  const fen = '4k4/9/9/9/r3p4/4R4/9/9/9/3K5 w - - 0 1';

  const greedy = { id: 'greedy', name: '贪吃', depth: 1, timeLimitMs: 10000,
                   quiescence: false, noise: 0, blunderRate: 0 };
  const careful = { ...greedy, quiescence: true };

  check('关掉静态搜索的深度 1 会贪吃卒',
    coordOf(search(fen, greedy, { rng: seededRng(3) }).to), '4,4');
  check('开启静态搜索后不去贪吃卒',
    coordOf(search(fen, careful, { rng: seededRng(3) }).to) === '4,4', false);
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，第二条断言（`quiesce` 还没实现，`quiescence` 开关不起作用）

- [ ] **Step 3: 实现**

在 `Searcher` 里追加：

```js
  /**
   * 静态搜索：只搜吃子，把「兑子序列没走完就评估」这个水平线效应消掉。
   *
   * 被将军时改为搜全部着法 —— 只看吃子的话，会漏掉「唯一的应将手段」，
   * 得出「被将死也没关系」的荒谬结论。
   */
  quiesce(alpha, beta, ply, qdepth) {
    this.nodes++;

    const checked = isAttacked(this.cells, findKing(this.cells, this.side), -this.side);
    if (!checked) {
      const stand = evaluate(this.cells, this.side);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }
    if (qdepth <= 0) return alpha;

    let best = alpha;
    const moves = generateMoves(this.cells, this.side)
      .filter((m) => checked || this.cells[moveTo(m)] !== EMPTY);

    for (const move of this.orderMoves(moves, ply, 0)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      const score = -this.quiesce(-beta, -best, ply + 1, qdepth - 1);
      this.unmake(move, captured);

      if (score > best) best = score;
      if (best >= beta) return best;
    }
    return best;
  }
```

把 `negamax` 里 `if (depth <= 0) return evaluate(this.cells, this.side);` 换成：

```js
    if (depth <= 0) {
      return this.level.quiescence
        ? this.quiesce(alpha, beta, ply, MAX_QUIESCE_DEPTH)
        : evaluate(this.cells, this.side);
    }
```

在 `MATE` 旁边加：

```js
/** 静态搜索的层数上限。兑子序列可能很长，必须封顶，否则单节点开销失控 */
const MAX_QUIESCE_DEPTH = 6;
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): 静态搜索（quiescence）"
```

---

## Task 6: 迭代加深与时间控制

**Files:**
- Modify: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: Task 5 的 `Searcher`
- Produces: `Searcher.searchRoot(depth)` 返回 `{ move, score, scores }`（已有）；新增 `Searcher.iterativeDeepen()` 返回同样的结构；`search()` 返回值里的 `depth` 变成实际完成的层数

- [ ] **Step 1: 追加测试**

```js
// --- 迭代加深与时间控制 ---
{
  const { search } = await load('engine.js');
  const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

  // 时间上限：给 300ms，必须在明显超时之前返回
  {
    const lv = { id: 'timed', name: '限时', depth: 64, timeLimitMs: 300,
                 quiescence: true, noise: 0, blunderRate: 0 };
    const t0 = Date.now();
    const r = search(fen, lv, { rng: seededRng(5) });
    const elapsed = Date.now() - t0;
    check('限时 300ms 的搜索在 1500ms 内返回', elapsed < 1500, true);
    check('限时搜索至少完成了一层', r.depth >= 1, true);
  }

  // 迭代加深：深度给够时，完成的层数应当大于 1
  {
    const lv = { id: 'deep', name: '深搜', depth: 4, timeLimitMs: 60000,
                 quiescence: false, noise: 0, blunderRate: 0 };
    const r = search(fen, lv, { rng: seededRng(5) });
    check('迭代加深跑到指定层数', r.depth, 4);
  }

  // 极短时间限制下也必须返回合法着法（用上一层的结果，不能返回半个）
  {
    const lv = { id: 'instant', name: '瞬时', depth: 64, timeLimitMs: 1,
                 quiescence: true, noise: 0, blunderRate: 0 };
    const r = search(fen, lv, { rng: seededRng(5) });
    const { generateLegalMoves } = await load('rules.js');
    const legal = new Set(generateLegalMoves(parseFen(fen)));
    check('时间限制极短时仍返回合法着法', legal.has(r.move), true);
  }
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`迭代加深跑到指定层数`（当前 `search()` 固定只搜 1 层）

- [ ] **Step 3: 实现**

在 `Searcher` 里追加：

```js
  /**
   * 迭代加深：从 1 层逐层加深，每层用上一层的着法顺序做种子。
   *
   * 好处有两个：时间控制天然生效（超时就丢掉没跑完的那一层），
   * 以及浅层结果能给深层做很好的着法排序。
   *
   * 超时用抛异常来中断，而不是逐层检查标志位 —— 否则每一层递归都要判断，
   * 那些判断本身的开销在叶节点上会被放大很多倍。
   */
  iterativeDeepen() {
    const moves = generateLegalMoves({ cells: this.cells, side: this.side });
    if (moves.length === 0) return null;
    if (moves.length === 1) {
      return { move: moves[0], score: 0, scores: new Map([[moves[0], 0]]), depth: 1 };
    }

    let best = { move: moves[0], score: 0, scores: new Map(), depth: 0 };
    let ordered = moves;

    for (let depth = 1; depth <= this.level.depth; depth++) {
      const result = this.searchRootAt(depth, ordered);
      if (!result) break;
      best = { ...result, depth };
      // 下一层从这一层的最优着法开始搜，剪枝效率更高
      ordered = [result.move, ...result.scores.keys()].filter((m, i, a) => a.indexOf(m) === i);
      if (Math.abs(result.score) > MATE - 1000) break; // 已经找到杀棋
    }
    return best;
  }

  /** 按给定着法顺序搜根节点 */
  searchRootAt(depth, ordered) {
    let bestMove = ordered[0];
    let bestScore = -INF;
    const scores = new Map();

    for (const move of ordered) {
      const captured = this.make(move);
      const score = -this.negamax(depth - 1, -INF, -bestScore, 1);
      this.unmake(move, captured);
      scores.set(move, score);
      if (score > bestScore) { bestScore = score; bestMove = move; }
    }
    return { move: bestMove, score: bestScore, scores };
  }
```

在 `negamax` 开头（`this.nodes++` 之后）加超时检查：

```js
    if (--this.checkEvery <= 0) {
      this.checkEvery = 1024;
      if (Date.now() >= this.deadline) throw TIMEOUT;
    }
```

在文件顶部加：

```js
/** 超时中断用的哨兵。用异常而不是标志位，见 iterativeDeepen 的注释 */
const TIMEOUT = { timeout: true };
```

`constructor` 里加 `this.checkEvery = 1024;`。

把 `search()` 换成：

```js
export function search(fen, level, options = {}) {
  const lv = typeof level === 'string' ? LEVELS.find((l) => l.id === level) : level;
  if (!lv) throw new Error(`未知挡位：${level}`);

  const pos = parseFen(fen);
  const searcher = new Searcher(pos.cells, pos.side, lv, options.rng || Math.random);
  const started = Date.now();
  searcher.deadline = started + lv.timeLimitMs;

  let result;
  try {
    result = searcher.iterativeDeepen();
  } catch (e) {
    if (e !== TIMEOUT) throw e;
    result = null; // 只有连第 1 层都没跑完才会走到这里
  }
  if (!result) {
    // 兜底：时间限制短到连 1 层都搜不完时，随便走一个合法着法，
    // 绝不能让上层拿到 null 然后卡死
    const legal = generateLegalMoves({ cells: searcher.cells, side: searcher.side });
    if (legal.length === 0) return null;
    result = { move: legal[0], score: 0, scores: new Map(), depth: 0 };
  }

  return {
    move: result.move,
    from: moveFrom(result.move),
    to: moveTo(result.move),
    score: result.score,
    depth: result.depth,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
  };
}
```

> **注意**：`iterativeDeepen` 里的 `searchRootAt` 抛 `TIMEOUT` 时，整个函数会直接抛出，已经完成的那一层结果会丢失。修正办法是在 `iterativeDeepen` 内部包一层 `try/catch`：捕获 `TIMEOUT` 后 `break`，保留 `best`。**实现时必须这么做**，否则「极短时间限制」那条断言会失败（返回的是没跑完的半个结果）。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): 迭代加深与时间控制"
```

---

## Task 7: 挡位弱化（评分噪声与失误率）

**Files:**
- Modify: `chinese-chess/js/engine.js`
- Modify: `chinese-chess/tools/test-engine.mjs`

**Interfaces:**
- Consumes: Task 6 的 `search()`
- Produces: `search()` 返回值新增 `blundered: boolean`；`search()` 行为受 `level.noise` / `level.blunderRate` 影响

- [ ] **Step 1: 追加测试**

```js
// --- 挡位弱化 ---
{
  const { search } = await load('engine.js');
  const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

  const strong = { id: 's', name: '强', depth: 3, timeLimitMs: 10000,
                   quiescence: true, noise: 0, blunderRate: 0 };

  // 无随机性时，不同种子必须给出同一个结果
  {
    const a = search(fen, strong, { rng: seededRng(11) });
    const b = search(fen, strong, { rng: seededRng(22) });
    check('noise 与 blunderRate 都为 0 时结果与随机源无关', b.move, a.move);
  }

  // 评分噪声足够大时，结果会随随机源变化
  {
    const noisy = { ...strong, noise: 400 };
    const seen = new Set();
    for (let seed = 1; seed <= 12; seed++) seen.add(search(fen, noisy, { rng: seededRng(seed) }).move);
    check('噪声足够大时着法会随随机源变化', seen.size > 1, true);
  }

  // 失误率 1.0：必然不走最优着法
  {
    const blunder = { ...strong, blunderRate: 1 };
    const best = search(fen, strong, { rng: seededRng(11) }).move;
    let blunders = 0;
    for (let seed = 1; seed <= 8; seed++) {
      if (search(fen, blunder, { rng: seededRng(seed) }).blundered) blunders++;
    }
    check('失误率 1.0 时每次都标记为失误', blunders, 8);
    check('失误率 1.0 时不会返回最优着法',
      search(fen, blunder, { rng: seededRng(11) }).move === best, false);
  }

  // 只有一个合法着法时，失误率不能让它走出非法着法
  {
    const blunder = { ...strong, blunderRate: 1 };
    const fen1 = '4k4/3R5/9/9/9/9/9/9/9/3K5 b - - 0 1';
    const r = search(fen1, blunder, { rng: seededRng(1) });
    check('只有一个合法着法时失误率不触发', r.blundered, false);
  }
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: FAIL，`blundered` 字段不存在

- [ ] **Step 3: 实现**

在 `search()` 里，`iterativeDeepen()` 得到结果之后、组装返回值之前插入：

```js
  // === 挡位弱化：在根节点统一施加，不影响搜索内部 ===
  let blundered = false;
  const allMoves = generateLegalMoves({ cells: searcher.cells, side: searcher.side });

  // 失误：放弃搜索结果，从「除最优着法之外」的合法着法里随机挑一个。
  // 只剩一个合法着法时绝不能触发 —— 那会走出非法着法，上层直接崩。
  if (lv.blunderRate > 0 && allMoves.length > 1 && searcher.rng() < lv.blunderRate) {
    const others = allMoves.filter((m) => m !== result.move);
    result = { ...result, move: others[Math.floor(searcher.rng() * others.length)] };
    blundered = true;
  } else if (lv.noise > 0 && result.scores.size > 1) {
    // 噪声：给每个根着法的评分加一个均匀扰动，重新选最优。
    // 这让弱挡位倾向选次优着，而不是永远选同一个最优着。
    let bestMove = result.move, bestVal = -INF;
    for (const [move, score] of result.scores) {
      const noisy = score + (searcher.rng() * 2 - 1) * lv.noise;
      if (noisy > bestVal) { bestVal = noisy; bestMove = move; }
    }
    result = { ...result, move: bestMove };
  }
```

返回值里加 `blundered`：

```js
  return {
    move: result.move,
    from: moveFrom(result.move),
    to: moveTo(result.move),
    score: result.score,
    depth: result.depth,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
    blundered,
  };
```

> 兜底分支（连 1 层都没跑完）也要带上 `blundered: false`。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-engine.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/engine.js chinese-chess/tools/test-engine.mjs
git commit -m "feat(chinese-chess): 挡位弱化（评分噪声与失误率）"
```

---

## Task 8: Worker 外壳与自对弈冒烟

**Files:**
- Create: `chinese-chess/js/worker.js`
- Create: `chinese-chess/tools/selfplay.mjs`
- Modify: `chinese-chess/docs/design.md`（§7.4 协议调整）

**Interfaces:**
- Consumes: `search()` / `LEVELS`
- Produces: Worker 消息协议（见下）

**协议调整（相对 `design.md` §7.4 的原始设计）：** 原设计让 Worker 在结果里返回 `notation`。实际不需要——主线程在把着法记进对局状态时**本来就要调一次 `toNotation`**（玩家自己走的棋也需要记谱），Worker 再算一遍是重复劳动，还让 Worker 多依赖一个模块。**已改为不返回 `notation`。**

```js
// 主线程 → Worker
{ type: 'search', id: number, fen: string, level: string }

// Worker → 主线程
{ type: 'result', id, move: { from, to }, score, depth, nodes, timeMs, blundered }
{ type: 'error',  id, message: string }
```

- [ ] **Step 1: 写 `worker.js`**

```js
/**
 * Worker 外壳：收一条搜索请求，回一条结果。纯胶水，不含任何搜索逻辑。
 *
 * 单 Worker、串行处理。搜索期间主线程会禁用操作，不做中途取消
 * （高级挡位上限 1.5 秒，可接受）。
 *
 * 这是本模块唯一允许碰 self / postMessage 的文件 ——
 * 其余 js/ 模块都必须保持纯逻辑，否则在 Worker 里加载时会崩。
 */

import { search } from './engine.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'search') return;

  try {
    const result = search(msg.fen, msg.level);
    if (!result) {
      // 无着法可走（已经终局），回一个空结果让上层判负
      self.postMessage({ type: 'result', id: msg.id, move: null });
      return;
    }
    self.postMessage({
      type: 'result',
      id: msg.id,
      move: { from: result.from, to: result.to },
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      timeMs: result.timeMs,
      blundered: result.blundered,
    });
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
```

- [ ] **Step 2: 写 `tools/selfplay.mjs`**

```js
#!/usr/bin/env node
/**
 * 自对弈冒烟测试。直接跑 Node。
 *
 * 用法：node chinese-chess/tools/selfplay.mjs [红方挡位] [黑方挡位] [最大步数]
 *   例：node chinese-chess/tools/selfplay.mjs easy medium 120
 *
 * 这不是单元测试（搜索结果依赖时间，断言不稳定），而是端到端冒烟：
 * 让两个挡位真下一盘，检查全程着法合法、对局能结束、没有死循环。
 * 改动着法生成或搜索后建议跑一次。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { parseFen, toFen, positionSignature, clonePosition } = await load('position.js');
const { generateLegalMoves, gameStatus, isThreefoldRepetition } = await load('rules.js');
const { toNotation } = await load('notation.js');
const { search } = await load('engine.js');
const { START_FEN } = await load('config.js');

const redLevel = process.argv[2] || 'easy';
const blackLevel = process.argv[3] || 'medium';
const maxPlies = Number(process.argv[4] || 120);

const pos = parseFen(START_FEN);
const signatures = [positionSignature(START_FEN)];
let plies = 0;
let failures = 0;

console.log(`自对弈：红=${redLevel} 黑=${blackLevel} 上限 ${maxPlies} 半回合\n`);

while (plies < maxPlies) {
  const status = gameStatus(pos);
  if (status.type !== 'playing') {
    console.log(`\n第 ${plies} 半回合：${status.type === 'checkmate' ? '将死' : '困毙'}，`
      + `${status.winner === 1 ? '红方' : '黑方'}胜`);
    break;
  }
  if (isThreefoldRepetition(signatures)) {
    console.log(`\n第 ${plies} 半回合：三次重复，判和`);
    break;
  }

  const fen = toFen(pos);
  const level = pos.side === 1 ? redLevel : blackLevel;
  const result = search(fen, level);
  if (!result) { console.log('搜索返回空结果，中止'); failures++; break; }

  const legal = new Set(generateLegalMoves(clonePosition(pos)));
  if (!legal.has(result.move)) {
    console.log(`第 ${plies} 半回合：引擎返回了非法着法 ${result.move}`);
    failures++;
    break;
  }

  const notation = toNotation(pos, result.move);
  const from = Math.floor(result.move / 90), to = result.move % 90;
  const captured = pos.cells[to];
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;
  signatures.push(positionSignature(toFen(pos)));

  plies++;
  const mark = result.blundered ? ' [失误]' : '';
  console.log(`${String(plies).padStart(3)}. ${pos.side === -1 ? '红' : '黑'} `
    + `${notation}${captured ? ' 吃' : '  '} 深度${result.depth} `
    + `${result.nodes}节点 ${result.timeMs}ms${mark}`);
}

console.log(`\n共 ${plies} 半回合`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: 跑冒烟测试**

Run: `node chinese-chess/tools/selfplay.mjs easy medium 60`
Expected: 打印每一步的中文记谱，退出码 0，**不出现「引擎返回了非法着法」**

- [ ] **Step 4: 回归全部测试**

Run: `node chinese-chess/tools/test-rules.mjs && node chinese-chess/tools/test-notation.mjs && node chinese-chess/tools/test-engine.mjs`
Expected: 三个脚本全部 `全部通过`

- [ ] **Step 5: 更新 `design.md` §7.4**

把协议示例里的 `notation: string` 去掉，并补一句说明为什么（主线程本来就要算记谱，Worker 再算一遍是重复依赖）。

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/worker.js chinese-chess/tools/selfplay.mjs chinese-chess/docs/design.md
git commit -m "feat(chinese-chess): Worker 外壳与自对弈冒烟脚本"
```

---

## 完成标准

```bash
node chinese-chess/tools/test-rules.mjs      # 规则层回归
node chinese-chess/tools/test-notation.mjs   # 记谱回归
node chinese-chess/tools/test-engine.mjs     # AI 层
node chinese-chess/tools/selfplay.mjs        # 端到端冒烟
```

四个命令都必须退出码 0。

## 已知限制

> 本节的**权威版本在 [`future-work.md`](./future-work.md)**（含改进路径与工作量估算）。
> 这里保留的是撰写计划时的预期，供对照。

| 限制 | 说明 |
|------|------|
| **评估函数是简化版** | 只有子力 + 兵过河，无位置表。高级挡位大约业余中低水平。提升路径是把 `evaluate()` 换成 90 格位置表版本，接口不用动 |
| **置换表不存杀棋分值** | 杀棋分值含「离根多远」，换层数就不对了。简单起见直接不存，代价是杀棋搜索重复计算 |
| **不做空着裁剪 / 吃子延伸** | 这些能明显提速，但都会引入搜索不稳定性，第一版不做 |
| **静态搜索只封 6 层** | 超长兑子序列仍可能被截断，但比完全不搜好得多 |
| **`worker.js` 没有自动化测试** | 它是纯胶水，逻辑全在 `engine.js`（已充分测试）。Worker 的消息收发靠界面层验证 |
| **无开局库** | 开局阶段可能不按谱走，走出「不像人」的着法 |
