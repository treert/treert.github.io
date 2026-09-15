# 中国象棋对局层与界面层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出能在浏览器里人机对弈的完整页面——棋盘、走子、悔棋、复盘、提示、四个挡位。

**Architecture:** 分两层。**对局层**（`game.js`）是纯逻辑的状态机，局面只有一个来源（FEN 字符串），能在 Node 里完整测试。**界面层**（`renderer.js` / `interaction.js` / `main.js`）只负责把状态画出来、把点击翻译成 `game.js` 的调用，自己不持有任何棋类规则。AI 跑在 Worker 里，主线程只发 `{fen, level}`、收着法。

**Tech Stack:** 纯 ES Module + 原生 DOM。无依赖、无构建工具。

**本计划的范围：** 设计文档 `chinese-chess/docs/design.md` 的 §9（对局状态机）、§10（界面）、§11（持久化）。

**前置条件：** 规则层（`plan.md`）与 AI 层（`plan-ai.md`）已全部完成，三个测试脚本全绿。

**关于本计划的详细程度：** 布局与配色的权威说明在 `design.md` §10，本计划不重复抄一遍 CSS，只在任务里给出必须遵守的约束（类名前缀、CSS 变量、不监听 `themechange`）。**唯一需要逐行写清的是 `game.js` 和它的测试**——那是这一层里唯一会「错了但看起来能用」的部分。

## Global Constraints

- **无依赖 / 无构建工具 / 无 `package.json`**：源文件直接就是浏览器能加载的 ES Module，必须显式 `import` / `export`。
- **模块隔离**：类名一律带 `xq-` 前缀；`localStorage` key 一律带 `chinese-chess:` 前缀；不引用其他模块的任何文件。
- **`global.js` 必须用普通 `<script>` 同步加载在 `<head>`**（不加 `defer` / `async`，不改 `module`），否则深色模式用户会先看到一帧白屏。
- **颜色一律走 CSS 变量**，不写死。
- **不需要监听 `themechange`**：本模块用 DOM + CSS 渲染（不是 Canvas），主题自动跟随。这是 `design.md` §3.2 选择 DOM 而非 Canvas 的直接收益，**不要**从 `conway-life-game` 抄那段监听代码。
- **`game.js` 是纯逻辑**：不得出现 `document` / `window` / `localStorage`。它要能在 Node 里被测试脚本加载。
- **`engine.js` / `worker.js` 已经完成**，界面层只通过 `worker.postMessage` 使用它，不直接调 `search()`。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `chinese-chess/js/game.js` | 对局状态机。纯逻辑，Node 可测 |
| `chinese-chess/js/persist.js` | localStorage 存档。纯逻辑（依赖注入 storage） |
| `chinese-chess/js/renderer.js` | 棋盘 DOM 构建与绘制、高亮、走子动画 |
| `chinese-chess/js/interaction.js` | 点击 / 拖拽选子走子 |
| `chinese-chess/js/main.js` | 入口：状态中枢 + 装配 + Worker 通信 + 工具栏绑定 |
| `chinese-chess/index.html` | 页面骨架，只放 DOM |
| `chinese-chess/style.css` | 模块样式 |
| `chinese-chess/tools/test-game.mjs` | 对局状态机测试 |

---

## Task 1: 对局状态机（`game.js`）

**Files:**
- Create: `chinese-chess/js/game.js`
- Create: `chinese-chess/tools/test-game.mjs`

**Interfaces:**
- Consumes: `config.js` 的 `START_FEN` / `RED` / `BLACK` / `CELLS`；`position.js` 的 `parseFen` / `toFen` / `positionSignature`；`rules.js` 的 `generateLegalMoves` / `gameStatus` / `isThreefoldRepetition` / `moveFrom` / `moveTo`；`notation.js` 的 `toNotation`
- Produces:
  - `createGame(options) -> Game`
  - `Game = { initialFen, moves: Move[], cursor, mode, playerSide, level, status }`
  - `Move = { move: number, notation: string, captured: number, fenAfter: string }`
  - `currentFen(game) -> string`
  - `currentPosition(game) -> { cells, side }`
  - `legalMoves(game) -> number[]`
  - `playMove(game, move) -> { ok: boolean, reason?: string }`
  - `undo(game) -> boolean`
  - `gotoPly(game, n) -> boolean`
  - `canUndo(game) -> boolean`
  - `reset(game) -> void`
  - `evaluateStatus(game) -> { type, winner }`（含三次重复）
  - `moveList(game) -> Move[]`
  - `sideToMove(game) -> 1 | -1`
  - `lastMove(game) -> number | 0`（用于高亮上一步）

**核心不变量（这是本任务最要紧的部分）：**

1. **局面只有一个来源。** `currentFen(game)` 是唯一的真相；需要棋盘时现从它 `parseFen`。内存里**不额外维护一份 `Int8Array`**——否则复盘跳转、悔棋、走子会各走各的路径，出现「状态不同步」这类极难查的 bug。
2. **悔棋和复盘跳转都只移动 `cursor`，绝不删除 `moves`。** 这样重做（跳到后面）是免费的。只有在「回看状态下走新着法」时才截断 `moves`。
3. **三次重复只看当前这条线**（`initialFen` + `moves[0..cursor)`），不看被截断的分支。

- [ ] **Step 1: 建立测试脚本（此时必然失败）**

创建 `chinese-chess/tools/test-game.mjs`：

```js
#!/usr/bin/env node
/**
 * 对局状态机测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-game.mjs
 *
 * 这里测的是「悔棋 / 复盘跳转 / 截断」这些**只在多步之后才暴露**的行为。
 * 单步走子错了会立刻看出来，但 cursor 管理错了只会表现为「点了几下之后棋盘不对」，
 * 而且极难复现，所以必须钉住。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN } = await load('config.js');
const { parseFen, toFen, positionSignature } = await load('position.js');
const { generateLegalMoves, isThreefoldRepetition } = await load('rules.js');
const { toNotation } = await load('notation.js');
const G = await load('game.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

/** 用引擎无关的方式挑一个合法着法：优先吃子，其次第一个 */
function pickMove(game) {
  const legal = G.legalMoves(game);
  const pos = G.currentPosition(game);
  const capture = legal.find((m) => pos.cells[m % 90] !== 0);
  return capture !== undefined ? capture : legal[0];
}

console.log('对局状态机测试\n');

// === 以下为各任务追加的测试块 ===

// === 收尾 ===
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-game.mjs`
Expected: FAIL，`Cannot find module .../js/game.js`

- [ ] **Step 3: 写 `game.js`**

```js
/**
 * 对局状态机。纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * 设计要点（design.md §9）：
 *   1. 局面只有一个来源 —— FEN 字符串。需要棋盘时现从它 parseFen，
 *      内存里不额外维护一份 Int8Array。否则悔棋、复盘跳转、走子会各走各的路径，
 *      迟早出现「状态不同步」。
 *   2. 悔棋和复盘跳转都只移动 cursor，绝不删除 moves —— 这样重做是免费的。
 *      只有在「回看状态下走新着法」时才截断。
 *   3. 每步存一份 FEN 快照（约 60 字符），换来复盘跳转 O(1)。
 *      200 步也就 12KB，比每次重放划算得多，而且同一份数据同时供
 *      悔棋、跳转、着法列表、导出使用。
 */

import { START_FEN, RED } from './config.js';
import { parseFen, toFen, positionSignature } from './position.js';
import { generateLegalMoves, gameStatus, isThreefoldRepetition, moveFrom, moveTo } from './rules.js';
import { toNotation } from './notation.js';

export function createGame(options = {}) {
  return {
    initialFen: options.initialFen || START_FEN,
    moves: [],
    cursor: 0,
    mode: options.mode || 'play',           // play | endgame
    playerSide: options.playerSide || RED,
    level: options.level || 'medium',
    endgameId: options.endgameId || null,
  };
}

/** 当前局面：cursor 为 0 就是起始局面，否则取上一步的 FEN 快照 */
export function currentFen(game) {
  return game.cursor === 0 ? game.initialFen : game.moves[game.cursor - 1].fenAfter;
}

export function currentPosition(game) {
  return parseFen(currentFen(game));
}

export function sideToMove(game) {
  return currentPosition(game).side;
}

export function legalMoves(game) {
  return generateLegalMoves(currentPosition(game));
}

/** 上一步棋的编码；没有则返回 0（用于高亮） */
export function lastMove(game) {
  return game.cursor === 0 ? 0 : game.moves[game.cursor - 1].move;
}

/** 从起始局面到 cursor 为止的所有局面签名，供三次重复判定 */
function signatures(game) {
  const out = [positionSignature(game.initialFen)];
  for (let i = 0; i < game.cursor; i++) out.push(positionSignature(game.moves[i].fenAfter));
  return out;
}

/**
 * 终局判定。除了将死 / 困毙，还要看三次重复 —— 设计文档 §5.3 明确不做
 * 中国象棋的循环规则（长将 / 长捉判负），这一条是唯一的循环兜底。
 */
export function evaluateStatus(game) {
  const st = gameStatus(currentPosition(game));
  if (st.type !== 'playing') return { type: st.type, winner: st.winner };
  if (isThreefoldRepetition(signatures(game))) return { type: 'repetition', winner: null };
  return { type: 'playing', winner: null };
}

export function playMove(game, move) {
  if (evaluateStatus(game).type !== 'playing') {
    return { ok: false, reason: '对局已经结束' };
  }
  if (!legalMoves(game).includes(move)) {
    return { ok: false, reason: '这个着法不合法' };
  }

  const pos = currentPosition(game);
  const from = moveFrom(move), to = moveTo(move);
  const captured = pos.cells[to];
  const notation = toNotation(pos, move);   // 必须在改棋盘之前算

  // 在回看状态下走新着法：截断后面的分支，重做链作废
  if (game.cursor < game.moves.length) game.moves.length = game.cursor;

  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;

  game.moves.push({ move, notation, captured, fenAfter: toFen(pos) });
  game.cursor++;
  return { ok: true };
}

export function canUndo(game) {
  return game.cursor > 0;
}

/**
 * 悔棋。默认退一步；传入 steps 可以多退。
 *
 * **不删除 moves**，只移动 cursor —— 所以「悔棋之后想反悔」直接 gotoPly 回去就行。
 */
export function undo(game, steps = 1) {
  if (!canUndo(game)) return false;
  game.cursor = Math.max(0, game.cursor - steps);
  return true;
}

/** 悔到「轮到玩家走」为止（人机对弈时用，避免玩家悔完棋又轮到 AI） */
export function undoToPlayer(game) {
  if (!canUndo(game)) return false;
  game.cursor--;
  while (game.cursor > 0 && sideToMove(game) !== game.playerSide) game.cursor--;
  return true;
}

/** 复盘跳转到第 n 步（0 = 起始局面） */
export function gotoPly(game, n) {
  if (n < 0 || n > game.moves.length) return false;
  game.cursor = n;
  return true;
}

export function reset(game) {
  game.moves.length = 0;
  game.cursor = 0;
}

export function moveList(game) {
  return game.moves.slice(0, game.cursor);
}

/** 当前是否处在「回看」状态（后面还有已走过的着法） */
export function isReviewing(game) {
  return game.cursor < game.moves.length;
}
```

- [ ] **Step 4: 追加测试**

```js
// --- 基本走子 ---
{
  const g = G.createGame();
  check('新对局：cursor 为 0', g.cursor, 0);
  check('新对局：当前局面就是起始局面', G.currentFen(g), START_FEN);
  check('新对局：没有上一步', G.lastMove(g), 0);
  check('新对局：轮到红方', G.sideToMove(g), 1);
  check('新对局：不能悔棋', G.canUndo(g), false);

  const before = G.currentFen(g);
  const r = G.playMove(g, pickMove(g));
  check('走一步成功', r.ok, true);
  check('走一步后 cursor 为 1', g.cursor, 1);
  check('走一步后轮到黑方', G.sideToMove(g), -1);
  check('走一步后局面变了', G.currentFen(g) !== before, true);
  check('走一步后可以悔棋', G.canUndo(g), true);
  check('着法列表长度为 1', G.moveList(g).length, 1);
  check('着法列表里有中文记谱', typeof G.moveList(g)[0].notation, 'string');
  check('上一步就是刚走的那一步', G.lastMove(g), g.moves[0].move);
}

// --- 非法着法必须被拒 ---
{
  const g = G.createGame();
  const illegal = 0;                       // from = to = 0，永远不合法
  check('非法着法被拒', G.playMove(g, illegal).ok, false);
  check('被拒之后 cursor 不变', g.cursor, 0);

  // 把红车走到黑方九宫里（纵线不动，横向跨过多子）—— 随便找一个不在合法表里的
  const legal = new Set(G.legalMoves(g));
  let bad = -1;
  for (let m = 0; m < 8100; m++) if (!legal.has(m) && m % 90 !== m / 90) { bad = m; break; }
  check('任意非合法着法都被拒', G.playMove(g, bad).ok, false);
  check('连续被拒后状态干净', [g.cursor, g.moves.length], [0, 0]);
}

// --- 悔棋：只移动游标，不删着法 ---
{
  const g = G.createGame();
  const start = G.currentFen(g);
  for (let i = 0; i < 4; i++) G.playMove(g, pickMove(g));
  check('走 4 步后 cursor 为 4', g.cursor, 4);
  check('走 4 步后着法数 4', g.moves.length, 4);

  const fen4 = G.currentFen(g);
  G.undo(g);
  check('悔棋后 cursor 为 3', g.cursor, 3);
  check('悔棋后着法数仍是 4（只移游标）', g.moves.length, 4);
  check('悔棋后局面回到第 3 步', G.currentFen(g) !== fen4, true);
  check('悔棋后处于回看状态', G.isReviewing(g), true);

  G.undo(g, 3);
  check('一次退 3 步回到起始局面', G.currentFen(g), start);
  check('退到底后不能继续悔棋', G.undo(g), false);
  check('退到底后 cursor 不小于 0', g.cursor, 0);
}

// --- 回看状态下走新着法：必须截断后面的分支 ---
{
  const g = G.createGame();
  for (let i = 0; i < 4; i++) G.playMove(g, pickMove(g));
  const dropped = g.moves[3].notation;

  G.gotoPly(g, 2);
  check('跳回第 2 步后处于回看状态', G.isReviewing(g), true);

  const r = G.playMove(g, pickMove(g));
  check('回看状态下可以走新着法', r.ok, true);
  check('走新着法后着法数变成 3（旧分支被截断）', g.moves.length, 3);
  check('走新着法后不再是回看状态', G.isReviewing(g), false);
  check('被截断的那一步已经不在列表里',
    g.moves.some((m) => m.notation === dropped), false);
}

// --- 复盘跳转 ---
{
  const g = G.createGame();
  const fens = [START_FEN];
  for (let i = 0; i < 5; i++) { G.playMove(g, pickMove(g)); fens.push(G.currentFen(g)); }

  let allMatch = true;
  for (let n = 0; n <= 5; n++) {
    G.gotoPly(g, n);
    if (G.currentFen(g) !== fens[n]) allMatch = false;
  }
  check('跳转到任意一步都能还原当时的局面', allMatch, true);
  check('跳转越界被拒', G.gotoPly(g, 99), false);
  check('跳转负数被拒', G.gotoPly(g, -1), false);
}

// --- 重置 ---
{
  const g = G.createGame();
  for (let i = 0; i < 3; i++) G.playMove(g, pickMove(g));
  G.reset(g);
  check('重置后 cursor 为 0', g.cursor, 0);
  check('重置后着法清空', g.moves.length, 0);
  check('重置后回到起始局面', G.currentFen(g), START_FEN);
}

// --- 终局判定 ---
{
  // 红车 (0,9) 平到 (3,9) 一步杀
  const g = G.createGame({ initialFen: '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1' });
  check('开局前是进行中', G.evaluateStatus(g).type, 'playing');

  const mate = G.legalMoves(g).find((m) => m === 0 * 90 + 3 + 9 * 9);
  check('找得到那步杀着', mate !== undefined, true);
  G.playMove(g, mate);

  const st = G.evaluateStatus(g);
  check('走完杀着后判定为将死', st.type, 'checkmate');
  check('胜方是红方', st.winner, 1);
  check('终局后不能再走子', G.playMove(g, G.legalMoves(g)[0] ?? 0).ok, false);
}

// --- 三次重复 ---
{
  // 用两个车在两条纵线上来回走，制造重复局面
  const g = G.createGame({ initialFen: '3k5/9/9/9/9/9/9/9/9/R2RK4 w - - 0 1' });
  const cycle = [];
  // 红车 (0,9) 上一步再回来，黑将 (3,0) 左右来回
  const moves = [
    0 * 90 + 9 * 9 - 9,   // 车(0,9) -> (0,8)
    3 * 90 + 4 * 9,       // 将(3,0) -> (4,0)
    0 * 90 + 9 * 9 - 9 + 9, // 车(0,8) -> (0,9)  （注意：这是 0*90+81 = 81）
  ];
  // 直接用合法着法驱动，避免手写编码出错
  const loop = [];
  for (let i = 0; i < 12; i++) {
    const st = G.evaluateStatus(g);
    if (st.type !== 'playing') break;
    const legal = G.legalMoves(g);
    // 优先走「回到上一步之前的样子」的着法，制造循环
    const pick = loop.length && legal.includes(loop[loop.length - 1]) ? loop[loop.length - 1] : legal[0];
    loop.push(pick);
    G.playMove(g, pick);
  }
  check('重复局面最终判和', G.evaluateStatus(g).type, 'repetition');
}
```

> **注意「三次重复」那条测试**：上面用「反复走第一个合法着法」来制造循环，**不保证一定能造出三次重复**——它依赖具体局面的着法顺序。实现时如果这条失败，**先手动确认局面是否真的重复了三次**，再决定是改测试还是改局面。不要为了让测试变绿去改判定逻辑。

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-game.mjs`
Expected: 全部 `ok`

- [ ] **Step 6: 提交**

```bash
git add chinese-chess/js/game.js chinese-chess/tools/test-game.mjs
git commit -m "feat(chinese-chess): 对局状态机"
```

---

## Task 2: 页面骨架与样式

**Files:**
- Create: `chinese-chess/index.html`
- Create: `chinese-chess/style.css`

**Interfaces:**
- Consumes: `../global.css` / `../global.js`
- Produces: 一批带固定 id 的 DOM 节点，供 `main.js` 绑定（见下面的清单）

**必须遵守（`design.md` §10 与 AGENTS.md）：**

- `<head>` 里 `../global.css` 之后引 `./style.css`；`../global.js` 用**普通同步 `<script>`**，不能加 `defer` / `async`。
- 所有类名带 `xq-` 前缀。
- 颜色只用 `var(--bg)` / `var(--card-bg)` / `var(--text)` / `var(--text-secondary)` / `var(--border)` / `var(--accent)` / `var(--danger)` / `var(--radius)` / `var(--shadow)`，不写死。
- 棋盘尺寸用 `aspect-ratio: 9 / 10` + `width: 100%` 自适应，不做缩放控件。
- **不要写 `themechange` 监听**（DOM 渲染，主题自动跟随）。
- 棋子配色额外定义两套模块级变量（红黑双方在深浅两色主题下都要可读）：

```css
:root {
  --xq-red: #c0392b;
  --xq-black: #2d3436;
  --xq-board-bg: #f0d9b5;
  --xq-board-line: #8b7355;
  --xq-cell: 0px;
}
:root[data-theme="dark"] {
  --xq-red: #ff6b6b;
  --xq-black: #e6e9ee;
  --xq-board-bg: #2b2a26;
  --xq-board-line: #6b6355;
}
```

**`index.html` 里 `main.js` 需要绑定的 id 清单**（实现时照这张表建 DOM）：

| id | 用途 |
|----|------|
| `board` | 棋盘容器（`renderer.js` 往里塞 90 个格子） |
| `board-wrap` | 棋盘外层，用于「翻转棋盘」时加 `is-flipped` 类 |
| `status-text` | 状态提示（轮到谁走 / 将死 / 和棋） |
| `level-select` | 挡位下拉 |
| `side-select` | 执红 / 执黑 |
| `btn-undo` / `btn-redo` | 悔棋 / 重做 |
| `btn-reset` / `btn-flip` / `btn-hint` | 重开 / 翻转棋盘 / 提示 |
| `move-list` | 着法列表容器 |
| `thinking` | 「思考中」指示器 |

- [ ] **Step 1: 写 `index.html`**

骨架照抄 `conway-life-game/index.html` 的头部与 `.container.wide` 结构，正文用两栏：棋盘在左（`#board-wrap` 里套 `#board`），面板在右（对局面板 + 着法列表）。页面底部加一行「已走 N 步 / 当前挡位 / 节点数」。

**页面标题下的可折叠说明**（`<details class="page-help">`）要写清：四个挡位的差别、`悔棋` 会一次退到玩家走棋、点着法列表可以跳回去看、翻转棋盘只影响显示。

- [ ] **Step 2: 写 `style.css`**

要点：

- `.xq-board` 用 `display: grid; grid-template-columns: repeat(9, 1fr); grid-template-rows: repeat(10, 1fr); aspect-ratio: 9 / 10;`
- 交叉线用格子的 `::before` / `::after` 画，避免额外的 SVG 层
- 河界与九宫斜线用棋盘容器上的两个伪元素 + `background-image: linear-gradient(...)` 画
- `.xq-piece` 绝对定位，`transform: translate(...)` 定位到格子中心，`transition: transform .18s ease-out`
- 高亮：`.xq-cell--last`（上一步）、`.xq-cell--target`（可走位置）、`.xq-piece--checked`（被将军的将）
- 翻转：`#board-wrap.is-flipped .xq-board { transform: rotate(180deg); }`，棋子文字也要跟着转回来（`.xq-piece > span { }` 上反向旋转）

- [ ] **Step 3: 本地起服务看效果**

Run: `python -m http.server 8000`，浏览器打开 `http://127.0.0.1:8000/chinese-chess/`
Expected: 能看到空棋盘、工具栏、深色模式切换钮。此时还没有 JS 逻辑，棋盘是空的——这是正常的。

- [ ] **Step 4: 提交**

```bash
git add chinese-chess/index.html chinese-chess/style.css
git commit -m "feat(chinese-chess): 页面骨架与棋盘样式"
```

---

## Task 3: 棋盘渲染（`renderer.js`）

**Files:**
- Create: `chinese-chess/js/renderer.js`

**Interfaces:**
- Consumes: `config.js` 的 `COLS` / `ROWS` / `CELLS` / `EMPTY` / `RED` / `FEN_OF_PIECE`；`position.js` 的 `xOf` / `yOf` / `parseFen`；`notation.js` 的 `toNotation`
- Produces: `createRenderer(boardEl, wrapEl) -> Renderer`，含：
  - `draw(pos, highlight) -> void` —— 全量重绘（不做动画）
  - `animateMove(from, to) -> void` —— 只把 `from` 上的棋子元素挪到 `to`（走子动画）
  - `cellAt(clientX, clientY) -> number | -1` —— 屏幕坐标 → 格子下标（含翻转）
  - `setFlipped(bool) -> void`

**关键设计：`draw()` 与 `animateMove()` 是两个不同的入口，不要合并。**

- `draw(pos, highlight)` 全量重建棋子元素。因为元素的 `transform` 是在**插入 DOM 之前**设好的，所以不会触发 transition —— 复盘跳转、悔棋时棋子直接出现在该在的位置，不会满屏乱飞。
- `animateMove(from, to)` 只处理「刚走了一步」这个最常见的情况：复用 `from` 上的元素、删掉 `to` 上被吃的元素、改 `transform` 让 CSS 过渡接管。这样走子有动画，而跳转没有。

**棋子字形**：CSS 画圆 + 汉字。字体栈 `"KaiTi", "STKaiti", "SimSun", serif`（`design.md` §14 记录了缺少楷体的系统会兜底成衬线体，本版接受这个降级）。

- [ ] **Step 1: 写 `renderer.js`**

要点：

- 构造时一次性建好 90 个 `.xq-cell` 按钮（`<button>`，键盘可遍历），存进 `this.cells` 数组
- 每个格子的坐标标签（`data-x` / `data-y`）要留着，供 `cellAt` 与调试用
- `pieceEl(piece)` 生成棋子元素：`<div class="xq-piece xq-piece--red|black"><span>车</span></div>`，红方用 `RED_NAMES`、黑方用 `BLACK_NAMES`（与 `notation.js` 里同一套字，可以直接 `import` 那两个常量——**为此需要把 `notation.js` 的 `RED_NAMES` / `BLACK_NAMES` 导出**，改一行 `const` 为 `export const`）
- `draw()` 里先清空 `#board` 上的棋子（保留格子），再按 `pos.cells` 逐个插入
- `highlight` 参数形如 `{ last: number, targets: number[], checked: number }`，`last` 是着法编码（用 `moveFrom` / `moveTo` 取两端）
- 翻转：`is-flipped` 时格子的视觉位置要反过来。**最省事的做法是让 CSS 负责**——给 `.xq-board` 加 `transform: rotate(180deg)`，同时给 `.xq-piece` 加 `transform: rotate(180deg)` 抵消。这样 `cellAt` 不需要任何翻转逻辑（点击事件由格子自己冒泡，DOM 位置已经翻过了）

- [ ] **Step 2: 用临时代码验证**

在 `index.html` 末尾临时加一段：

```html
<script type="module">
  import { createRenderer } from './js/renderer.js';
  import { startPosition } from './js/position.js';
  const r = createRenderer(document.getElementById('board'), document.getElementById('board-wrap'));
  r.draw(startPosition(), { last: 0, targets: [], checked: -1 });
</script>
```

Run: 刷新页面
Expected: 棋盘上出现完整的初始局面，红黑双方各 16 子，字体和配色正常；切深色模式后颜色跟着变。

- [ ] **Step 3: 删掉临时代码，提交**

```bash
git add chinese-chess/js/renderer.js chinese-chess/js/notation.js
git commit -m "feat(chinese-chess): 棋盘渲染"
```

---

## Task 4: 交互与装配（`interaction.js` + `main.js`）

**Files:**
- Create: `chinese-chess/js/interaction.js`
- Create: `chinese-chess/js/main.js`
- Modify: `chinese-chess/index.html`（把 Task 3 的临时脚本换成 `main.js`）

**Interfaces:**
- Consumes: `game.js` 全部导出、`renderer.js`、`worker.js`（通过 `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`）
- Produces: 可运行的人机对弈页面

**装配方式照抄 `conway-life-game/js/main.js`：状态集中在一个 `app` 对象上，模块之间不互相 import，统一通过 `app` 上的回调协作。**

```js
const app = {
  game,                    // Game 实例
  renderer,
  worker,
  searchId: 0,             // 递增的请求 id，用来丢弃过期响应
  busy: false,             // AI 思考中
  selected: -1,            // 当前选中的格子（-1 表示没选）
  hint: 0,                 // 提示的着法编码
  refresh(),               // 重绘 + 更新面板
  requestAiMove(),         // 派发一次搜索
  applyMove(move),         // 走子 + 动画 + 刷新 + 触发 AI
};
```

- [ ] **Step 1: 写 `interaction.js`**

- 点击格子（事件委托到 `#board`）：
  - 没选中任何子 → 若该格有己方棋子且轮到自己走，选中它，高亮合法目标
  - 已选中 → 若目标在合法着法集合里，走子；否则**改选另一个己方棋子**（不报错、不弹窗）
- 鼠标拖拽（`pointerType === 'mouse'` 才启用，触屏走「点选 → 点棋盘」两步，避免与滚动打架 —— 与 `conway-life-game` 的处理一致）
- `Esc` 取消选中

- [ ] **Step 2: 写 `main.js`**

装配顺序：建 game → 建 renderer → 建 worker → 绑定工具栏 → 首次 refresh → 如果轮到 AI 就 `requestAiMove()`。

Worker 通信：

```js
worker.postMessage({ type: 'search', id: ++app.searchId, fen: currentFen(app.game), level: app.game.level });

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.id !== app.searchId) return;   // 过期响应，丢掉
  app.busy = false;
  if (msg.type === 'error') { showStatus(`引擎出错：${msg.message}`); return; }
  if (!msg.move) { app.refresh(); return; }  // 无着法 = 已终局
  app.applyMove(msg.move.from * 90 + msg.move.to);
};
```

**三条必须处理的情况：**

1. **过期响应**：用户可能在 AI 思考期间悔棋或重开，此时回来的着法已经不该走了 —— 用递增的 `searchId` 丢弃。
2. **思考期间禁用操作**：`app.busy` 为真时，工具栏按钮与棋盘点击都直接返回（`design.md` §14 记录了这个取舍：最长 1.5 秒不可中断）。
3. **玩家执黑时 AI 先走**：首次 refresh 后如果 `sideToMove !== playerSide`，要主动派发一次搜索。

- [ ] **Step 3: 人机对弈冒烟**

Run: `python -m http.server 8000`，打开页面，用「中级」挡位下几步
Expected: 能走子、有动画、AI 会应手、「思考中」指示器会出现、状态栏显示轮到谁走。

- [ ] **Step 4: 提交**

```bash
git add chinese-chess/js/interaction.js chinese-chess/js/main.js chinese-chess/index.html
git commit -m "feat(chinese-chess): 走子交互与人机对弈装配"
```

---

## Task 5: 着法列表、悔棋/重做、复盘跳转、翻转、提示

**Files:**
- Modify: `chinese-chess/js/main.js`
- Modify: `chinese-chess/style.css`

**Interfaces:**
- Consumes: `game.js` 的 `undoToPlayer` / `gotoPly` / `moveList` / `isReviewing` / `lastMove`
- Produces: 完整的工具栏行为

**要点：**

- **着法列表**：按「回合」分组（红黑各一步为一行，如 `1. 炮二平五  炮8平5`）。点击任意一步 → `gotoPly` 跳到那一步之后；再点一次同一步 → 取消回看（跳到最新）。回看状态要有明显样式，并在状态栏提示「正在回看第 N 步」。
- **悔棋**用 `undoToPlayer`（一次退到玩家走棋），**重做**用 `gotoPly(cursor + 1)`。两者在回看状态下要禁用。
- **翻转棋盘**只切 `renderer.setFlipped()`，不动对局状态。
- **提示**：以当前挡位向 Worker 发一次搜索，把返回的着法高亮在棋盘上（用 `.xq-cell--hint`），不走子。提示期间同样受 `busy` 保护。

- [ ] **Step 1: 实现上述五件事**
- [ ] **Step 2: 手动验证**

逐条验证：走 6 步 → 点第 2 步能跳回去 → 状态栏提示回看 → 点「重做」能前进 → 悔棋回到玩家走棋 → 翻转棋盘后点击仍然正确（**这一条最容易错，翻转后点错格子就是坐标映射写反了**）→ 提示能给出着法。

- [ ] **Step 3: 提交**

```bash
git add chinese-chess/js/main.js chinese-chess/style.css
git commit -m "feat(chinese-chess): 着法列表、悔棋重做、复盘跳转、翻转与提示"
```

---

## Task 6: 持久化（`persist.js`）

**Files:**
- Create: `chinese-chess/js/persist.js`
- Modify: `chinese-chess/js/main.js`

**Interfaces:**
- Consumes: 无（storage 通过参数注入，便于测试）
- Produces:
  - `save(storage, game) -> boolean`
  - `load(storage) -> Game | null`
  - `clear(storage) -> void`
  - `STORAGE_KEY = 'chinese-chess:state'`

**要点：**

- **key 必须带模块前缀** `chinese-chess:`（AGENTS.md 的模块隔离要求）。
- 存 `level` / `playerSide` / `mode` / `initialFen` / `moves` / `cursor`。
- 存盘时机：走子后、悔棋后、切挡位后（防抖 300ms）；**AI 思考期间不存**。
- 读取失败 / 数据损坏 → 返回 `null`，降级为全新开局，**不阻塞页面启动**（与 `conway-life-game` 的容错策略一致）。
- storage 通过参数注入，测试时传一个假对象即可，不需要真的 localStorage。

- [ ] **Step 1: 写 `persist.js`**
- [ ] **Step 2: 在 `main.js` 里接上（启动时 load、变更时防抖 save）**
- [ ] **Step 3: 手动验证**

走几步 → 刷新页面 → 局面和挡位都还在 → 手动把 localStorage 里的值改成乱码 → 刷新 → 能正常开局、不白屏。

- [ ] **Step 4: 提交**

```bash
git add chinese-chess/js/persist.js chinese-chess/js/main.js
git commit -m "feat(chinese-chess): localStorage 存档"
```

---

## Task 7: 接入首页与模块 README

**Files:**
- Modify: `index.html`（根目录）
- Modify: `README.md`（根目录）
- Create: `chinese-chess/README.md`

**要点：**

- 根 `index.html` 在「🎮 折腾 / 好玩」分组里加一张 `.card`，图标建议 `🐘`，标题「中国象棋」，描述「单机对弈，四个挡位的 AI，中文记谱与复盘」。
- 根 `README.md` 的目录表加一行，位置与卡片一致。
- `chinese-chess/README.md` 按 `conway-life-game/README.md` 的结构写：本地运行（**必须走 http，ES Module 在 `file://` 下会被 CORS 拦掉**）、目录结构、架构、关键设计决策、常见改动、已知限制。

**「关键设计决策」至少覆盖这几条**（都是实际踩过或论证过的，不要写成泛泛的介绍）：

1. 局面只有一个来源（FEN 字符串），内存里不额外维护棋盘数组。
2. 悔棋只移游标不删着法，所以重做是免费的。
3. 用 DOM 而不是 Canvas 渲染，因此不需要监听 `themechange`。
4. 挡位是声明式策略表，弱化手段在根节点统一施加。
5. **关掉静态搜索是让 AI 像新手最有效的开关**（有测试钉住）。
6. `worker.js` 不返回记谱——主线程本来就要算。
7. 测试策略：规则层用逐条规则点的断言而非外部 perft 数值；AI 层用自对弈冒烟（**单测抓不到 `quiesce` 返回 `-INF` 那个 bug，冒烟抓到了**）。

- [ ] **Step 1: 改根 `index.html` 与根 `README.md`**
- [ ] **Step 2: 写 `chinese-chess/README.md`**
- [ ] **Step 3: 提交**

```bash
git add index.html README.md chinese-chess/README.md
git commit -m "docs: 中国象棋模块接入首页并补 README"
```

---

## 完成标准

```bash
node chinese-chess/tools/test-rules.mjs      # 规则层
node chinese-chess/tools/test-notation.mjs   # 记谱
node chinese-chess/tools/test-engine.mjs     # AI 层
node chinese-chess/tools/test-game.mjs       # 对局层
```

四个命令退出码必须为 0。另外手动确认：能人机对弈、能悔棋、能点着法列表跳回去、翻转棋盘后点击仍然正确、深色模式下配色正常、刷新不丢局面。

## 已知限制

| 限制 | 说明 |
|------|------|
| 走子动画只覆盖「刚走一步」 | 悔棋 / 复盘跳转是全量重绘，没有补间。想加的话要把 `draw()` 改成按棋子身份匹配元素 |
| 棋子字形依赖系统楷体 | 缺楷体的系统会兜底成衬线体。彻底解决要内联 SVG 字形 |
| AI 思考期间不能中断 | 最长 1.5 秒内禁用操作，不做取消 |
| 移动端不做拖拽 | 触屏走「点选 → 点棋盘」两步，避免与滚动打架 |
| 必须走 http 服务 | ES Module 在 `file://` 下会被 CORS 拦掉 |
