# 中国象棋残局库实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出可训练的内置残局库——局面合法性校验、残局模式、界面上的选择与训练。

**Architecture:** `endgames.js` 是纯数据（FEN + 元信息），`rules.js` 新增 `isLegalPosition()` 负责校验，
`tools/verify-endgames.mjs` 在开发时逐局跑校验，`game.js` 增加残局模式（起始局面来自残局库），
界面加一个残局选择面板与训练反馈。

**Tech Stack:** 纯 ES Module + Node 内置模块。无依赖、无构建工具。

**本计划的范围：** 设计文档 `chinese-chess/docs/design.md` 的 §5.4（局面合法性校验）与 §8（残局库）。

**前置条件：** 规则层、AI 层、对局层、界面层都已完成，四个测试脚本全绿。

## 数据来源（已确认）

**经典排局**来自 [`kuiba1949/xiangqi-tools`](https://github.com/kuiba1949/xiangqi-tools) 的
`fen/shiqingyaqu551.fen`（BSD-3-Clause）。每行格式：

```
[FEN_INDEX "shiqingyaqu-551-001"] [EVENT "适情雅趣_李浭551局新版 第001局 气吞关右"] [FEN "2baka3/3P3N1/bN7/7nc/9/4C1P2/P5n1P/B3R3B/4Apr2/2RAK3c w - - 0 1"]
```

- `FEN_INDEX` 是稳定 id，`EVENT` 里带局号与局名，`FEN` 直接可用（`w` 表示红先）。
- 《适情雅趣》是明代排局谱，**公有领域**；该仓库的 FEN 转换部分按 BSD-3 授权。
- **运行时绝不联网**：本计划只做一次性整理，整理结果直接写进 `endgames.js`。

**实用残局**由本计划自己构造（教材定式）。理由是排局对学习者偏难，
而「单车例胜单士」这类定式才是训练的主体；这些局面的结果在教材里是确定的。

## 关于 `result` 字段的诚实说明（重要）

**`result` 不经过机器验证。** 要证明「红先必胜」需要可靠的求解器或权威棋谱，
本模块的引擎（简化评估 + 迭代加深）做不到。

- 实用残局：结果取自教材定式，可靠。
- 经典排局：结果取自《适情雅趣》这一「红先胜」排局谱的性质，**逐局未经复核**。
- `verify-endgames.mjs` **只校验局面合法性**，不校验胜负结论。
- 每局都带 `source` 字段标明出处；README 里也要写清这一点。

## Global Constraints

与前面几份计划相同：无依赖、无构建工具、无 `package.json`、模块隔离、纯逻辑模块不碰 DOM、
类名带 `xq-` 前缀、颜色走 CSS 变量、不监听 `themechange`。

---

## 文件结构

| 文件 | 职责 | 变化 |
|------|------|------|
| `chinese-chess/js/rules.js` | 规则引擎 | 追加 `isLegalPosition()` |
| `chinese-chess/js/endgames.js` | 残局库数据 | **新建**（唯一手工维护点） |
| `chinese-chess/js/game.js` | 对局状态机 | 追加残局模式相关函数 |
| `chinese-chess/js/main.js` | 入口装配 | 追加残局面板绑定 |
| `chinese-chess/index.html` | 页面骨架 | 追加残局选择区 |
| `chinese-chess/style.css` | 样式 | 追加残局面板样式 |
| `chinese-chess/tools/verify-endgames.mjs` | 残局库校验 | **新建** |
| `chinese-chess/tools/test-rules.mjs` | 规则测试 | 追加 `isLegalPosition` 用例 |
| `chinese-chess/tools/test-game.mjs` | 对局测试 | 追加残局模式用例 |

---

## Task 1: 局面合法性校验（`isLegalPosition`）

**Files:**
- Modify: `chinese-chess/js/rules.js`
- Modify: `chinese-chess/tools/test-rules.mjs`

**Interfaces:**
- Consumes: `config.js` 的 `CELLS` / `EMPTY` / `K` / `A` / `B` / `P` / `RED`；`position.js` 的 `xOf` / `yOf`；`rules.js` 已有的 `findKing` / `isAttacked` / `inCheck` / `generateLegalMoves`
- Produces: `isLegalPosition(pos) -> { ok: boolean, reason?: string }`

**为什么返回 `{ ok, reason }` 而不是 `boolean`：** 校验残局库时要能说出「第 003 局哪里不合法」，
只返回 `false` 等于让作者自己去猜。

**六条检查（`design.md` §5.4）：**

1. 双方各恰好一个将 / 帅
2. 将帅不照面
3. 所有棋子都在自己的合法区域内（士 / 象 / 兵的位置约束）
4. 兵 / 卒不在己方底线
5. 非轮走方不处于被将军状态（即上一步不该让己方被将军）
6. 双方子力数量不超过理论上限（车 ≤ 2、马 ≤ 2、炮 ≤ 2、象 ≤ 2、士 ≤ 2、兵 ≤ 5）

**第 3 条要按棋子逐个查：**

| 棋子 | 合法位置 |
|------|----------|
| 将 / 帅 | 己方九宫 |
| 士 / 仕 | 己方九宫的五个斜点：`(3,0) (5,0) (4,1) (3,2) (5,2)`（黑）/ `(3,7) (5,7) (4,8) (3,9) (5,9)`（红） |
| 象 / 相 | 己方七个象位：`(2,0) (6,0) (0,2) (4,2) (8,2) (2,4) (6,4)`（黑）/ 对应的 `y = 5..9` 镜像（红） |
| 兵 / 卒 | 红方 `y ∈ [0,8]`（不能在自己底线 `y = 9`）；黑方 `y ∈ [1,9]`（不能在自己底线 `y = 0`） |
| 车 / 马 / 炮 | 棋盘内即可 |

- [ ] **Step 1: 追加测试**

在 `test-rules.mjs` 的收尾之前插入：

```js
// --- 局面合法性校验（残局库用） ---
{
  const { isLegalPosition } = await load('rules.js');
  const ok = (pos) => isLegalPosition(pos).ok;

  check('起始局面合法', ok(startPosition()), true);
  check('残局示例局面合法', ok(parseFen('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1')), true);

  // 1. 缺将 / 多将
  check('缺黑将 → 不合法', ok(build(['K@4,9'])), false);
  check('两个红帅 → 不合法', ok(build(['K@3,9', 'K@4,9', 'k@4,0'])), false);
  check('不合法时给出原因', typeof isLegalPosition(build(['K@4,9'])).reason, 'string');

  // 2. 将帅照面
  check('将帅照面 → 不合法', ok(build(['K@4,9', 'k@4,0'])), false);
  check('中间有子则合法', ok(build(['K@4,9', 'P@4,5', 'k@4,0'])), true);

  // 3. 棋子出界
  check('黑士不在九宫斜点 → 不合法', ok(build(['K@3,9', 'k@4,0', 'a@4,0'])), false);
  check('黑士在九宫斜点 → 合法', ok(build(['K@3,9', 'k@4,0', 'a@5,0'])), true);
  check('红相过河 → 不合法', ok(build(['K@3,9', 'k@4,0', 'B@4,4'])), false);
  check('黑象在自己半场但不在象位 → 不合法', ok(build(['K@3,9', 'k@4,0', 'b@3,0'])), false);
  check('黑象在象位 → 合法', ok(build(['K@3,9', 'k@4,0', 'b@2,0'])), true);
  check('红帅不在九宫 → 不合法', ok(build(['K@2,9', 'k@4,0'])), false);
  check('黑将不在九宫 → 不合法', ok(build(['K@3,9', 'k@2,0'])), false);

  // 4. 兵在己方底线
  check('红兵在自己底线 (y=9) → 不合法', ok(build(['K@3,9', 'k@4,0', 'P@0,9'])), false);
  check('黑卒在自己底线 (y=0) → 不合法', ok(build(['K@3,9', 'k@4,0', 'p@0,0'])), false);
  check('红兵在 y=8 → 合法', ok(build(['K@3,9', 'k@4,0', 'P@0,8'])), true);

  // 5. 非轮走方被将军
  {
    // 红方走，但黑将正被红车将军 —— 说明上一步红方走错了
    const bad = build(['K@3,9', 'k@4,0', 'R@4,5']);
    check('非轮走方被将军 → 不合法', ok(bad), false);
    // 反过来：轮走方被将军是正常的（他正在被将，需要应将）
    const good = build(['K@3,9', 'k@4,0', 'R@4,5'], 'b');
    check('轮走方被将军 → 合法', ok(good), true);
  }

  // 6. 子力超限
  check('三个红车 → 不合法', ok(build(['K@3,9', 'k@4,0', 'R@0,9', 'R@1,9', 'R@2,9'])), false);
  check('六个红兵 → 不合法',
    ok(build(['K@3,9', 'k@4,0', 'P@0,5', 'P@1,5', 'P@2,5', 'P@3,5', 'P@4,5', 'P@5,5'])), false);
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: FAIL，`isLegalPosition is not a function`

- [ ] **Step 3: 实现**

在 `rules.js` 末尾追加：

```js
// 士 / 仕 的五个斜点（黑方视角；红方是 y 方向的镜像）
const ADVISOR_SPOTS_BLACK = [[3, 0], [5, 0], [4, 1], [3, 2], [5, 2]];
// 象 / 相 的七个象位（黑方视角；红方是 y 方向的镜像）
const ELEPHANT_SPOTS_BLACK = [[2, 0], [6, 0], [0, 2], [4, 2], [8, 2], [2, 4], [6, 4]];

/** 红方的点位是黑方沿 y 轴镜像过来的：y' = 9 - y */
function mirror(spots) {
  return spots.map(([x, y]) => [x, 9 - y]);
}
const ADVISOR_SPOTS = { [RED]: mirror(ADVISOR_SPOTS_BLACK), [-RED]: ADVISOR_SPOTS_BLACK };
const ELEPHANT_SPOTS = { [RED]: mirror(ELEPHANT_SPOTS_BLACK), [-RED]: ELEPHANT_SPOTS_BLACK };

const onAnySpot = (spots, x, y) => spots.some(([sx, sy]) => sx === x && sy === y);

/** 各类棋子的理论上限，用来挡住「摆出三个车」这种明显错误的录入 */
const MAX_COUNT = { [R]: 2, [N]: 2, [C]: 2, [B]: 2, [A]: 2, [P]: 5 };

/**
 * 局面合法性校验。残局库录入时逐局跑这个。
 *
 * 返回 { ok, reason } 而不是布尔值 —— 校验残局库时要能说出
 * 「第 003 局哪里不合法」，只返回 false 等于让作者自己去猜。
 *
 * 注意这里**不校验胜负结论**（「红先胜」这类标注需要可靠的求解器或权威棋谱，
 * 本模块的引擎做不到）。见 design.md §14。
 */
export function isLegalPosition(pos) {
  const { cells, side } = pos;

  // 1. 双方各恰好一个将 / 帅
  let redKings = 0, blackKings = 0;
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] === K) redKings++;
    else if (cells[i] === -K) blackKings++;
  }
  if (redKings !== 1) return { ok: false, reason: `红方帅的数量是 ${redKings}，应为 1` };
  if (blackKings !== 1) return { ok: false, reason: `黑方将的数量是 ${blackKings}，应为 1` };

  // 2. 将帅不照面
  const redKing = findKing(cells, RED);
  const blackKing = findKing(cells, -RED);
  if (xOf(redKing) === xOf(blackKing)) {
    let blocked = false;
    const lo = Math.min(yOf(redKing), yOf(blackKing)) + 1;
    const hi = Math.max(yOf(redKing), yOf(blackKing));
    for (let y = lo; y < hi; y++) {
      if (cells[indexOf(xOf(redKing), y)] !== EMPTY) { blocked = true; break; }
    }
    if (!blocked) return { ok: false, reason: '将帅照面（同一条纵线且中间无子）' };
  }

  // 3 & 4. 每个棋子都要在自己的合法区域内；顺便统计子力数量
  const counts = new Map();
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const s = Math.sign(v);
    const abs = Math.abs(v);
    const x = xOf(i), y = yOf(i);
    const who = s === RED ? '红' : '黑';

    counts.set(v, (counts.get(v) || 0) + 1);

    if (abs === K && !inPalace(x, y, s)) {
      return { ok: false, reason: `${who}方${abs === K ? '帅/将' : ''}在 (${x},${y})，不在九宫内` };
    }
    if (abs === A && !onAnySpot(ADVISOR_SPOTS[s], x, y)) {
      return { ok: false, reason: `${who}方士/仕在 (${x},${y})，不在九宫斜点上` };
    }
    if (abs === B && !onAnySpot(ELEPHANT_SPOTS[s], x, y)) {
      return { ok: false, reason: `${who}方象/相在 (${x},${y})，不在象位上（过河或位置错误）` };
    }
    if (abs === P) {
      // 兵 / 卒不能出现在自己的底线
      if (s === RED && y === 9) return { ok: false, reason: `红兵在 (${x},${y})，位于己方底线` };
      if (s === -RED && y === 0) return { ok: false, reason: `黑卒在 (${x},${y})，位于己方底线` };
    }
  }

  // 6. 子力数量不超过理论上限
  for (const [piece, max] of Object.entries(MAX_COUNT)) {
    const n = counts.get(Number(piece)) || 0;
    const m = counts.get(-Number(piece)) || 0;
    if (n > max) return { ok: false, reason: `红方 ${n} 个同种棋子，超过上限 ${max}` };
    if (m > max) return { ok: false, reason: `黑方 ${m} 个同种棋子，超过上限 ${max}` };
  }

  // 5. 非轮走方不该被将军（那意味着上一步走错了）
  if (inCheck(cells, -side)) {
    return { ok: false, reason: '非轮走方正被将军，说明上一步不合法' };
  }

  return { ok: true };
}
```

> `inPalace` 是 `rules.js` 里已有的内部函数，直接用即可（同一文件，不需要导出）。
> `indexOf` / `xOf` / `yOf` 已经在文件顶部 import 过了。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-rules.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/rules.js chinese-chess/tools/test-rules.mjs
git commit -m "feat(chinese-chess): 局面合法性校验"
```

---

## Task 2: 残局库数据与校验脚本

**Files:**
- Create: `chinese-chess/js/endgames.js`
- Create: `chinese-chess/tools/verify-endgames.mjs`

**Interfaces:**
- Consumes: `rules.js` 的 `isLegalPosition` / `generateLegalMoves` / `inCheck`；`position.js` 的 `parseFen` / `toFen`；`config.js` 的 `PIECE_VALUE` / `RED`
- Produces:
  - `ENDGAMES: Endgame[]`，`Endgame = { id, name, category, fen, result, difficulty, source, note? }`
  - `CATEGORIES = { practical: '实用残局', composed: '经典排局' }`
  - `findEndgame(id) -> Endgame | undefined`

**数据结构（`design.md` §8.1）：**

```js
{
  id: 'che-vs-dan-shi',        // 唯一标识，kebab-case
  name: '单车例胜单士',
  category: 'practical',       // practical 实用残局 | composed 经典排局
  fen: '3ka4/9/9/9/9/9/9/9/9/R3K4 w - - 0 1',
  result: 'win',               // 先手方视角：win 胜 | draw 和
  difficulty: 1,               // 1~5
  source: '象棋残局基础（教材定式）',
  note: '车方先逼将离位，再破士',   // 可选
}
```

**实用残局（自己构造，8 局）—— 全部按「红方先走、黑将不在被将状态」构造：**

统一用「红帅 `(4,9)` 或 `(3,9)`、黑将 `(4,0)` 或 `(3,0)`」的骨架，
**必须保证两将不同纵线或中间有子**，否则 `isLegalPosition` 会直接判不合法。

| id | 名称 | 红方 | 黑方 | result |
|----|------|------|------|--------|
| `che-vs-dan-shi` | 单车例胜单士 | 帅 车 | 将 士 | win |
| `che-vs-dan-xiang` | 单车例胜单象 | 帅 车 | 将 象 | win |
| `che-vs-shuang-shi` | 单车例胜双士 | 帅 车 | 将 双士 | win |
| `che-vs-ma-shuang-shi` | 单车例胜马双士 | 帅 车 | 将 双士 马 | win |
| `che-vs-shi-xiang-quan` | 单车难胜士象全 | 帅 车 | 将 士象全 | draw |
| `shuang-che-vs-shi-xiang-quan` | 双车必胜士象全 | 帅 双车 | 将 士象全 | win |
| `ma-qin-dan-shi` | 马擒单士 | 帅 马 | 将 士 | win |
| `dan-ma-vs-dan-jiang` | 单马必胜单将 | 帅 马 | 将 | win |

**经典排局（取自《适情雅趣》，15 局）：** 用 `FEN_INDEX` 作 id，`EVENT` 里的局号局名作 name，
`category: 'composed'`，`result: 'win'`，`source: '《适情雅趣》第 NNN 局（据 kuiba1949/xiangqi-tools 的 FEN 转换，BSD-3）'`。

**校验脚本 `verify-endgames.mjs` 逐局检查：**

1. FEN 能被解析，且解析后重新生成与原文一致（往返一致）
2. `isLegalPosition()` 通过
3. 该局面不是已经终局的（轮走方有合法着法）
4. 轮走方不是已经被将军（残局库的出题局面不该从被将开始）
5. `result` / `category` 是枚举内的值，`difficulty` 在 1~5
6. `id` 全局唯一，`source` 非空，`name` 非空
7. **子力一致性**：`result: 'win'` 时，先手方的子力价值不应低于对手
   （这条能挡住「把强弱写反了」这类录入错误，成本极低）
8. **不校验胜负结论** —— 理由见本文件开头的说明

- [ ] **Step 1: 写 `endgames.js`**

按上面的结构写数据。文件顶部要有注释说明数据来源与 `result` 的可靠性边界。

- [ ] **Step 2: 写 `tools/verify-endgames.mjs`**

结构照 `tools/test-rules.mjs` 的检查风格（`check(name, actual, expected)` + 失败计数 + 非 0 退出码），
但输出要带局名，方便定位：

```
ok    单车例胜单士        (che-vs-dan-shi)
FAIL  某局                (some-id)  原因：非轮走方正被将军
```

- [ ] **Step 3: 跑校验，修掉不合法或终局的局面**

Run: `node chinese-chess/tools/verify-endgames.mjs`
Expected: 全部 `ok`，退出码 0。

**如果某个《适情雅趣》局面被判「已经终局」或「非轮走方被将军」，
直接从库里去掉它**，不要改 FEN —— 那份数据是别人转换好的，改了就失去可信来源。

- [ ] **Step 4: 提交**

```bash
git add chinese-chess/js/endgames.js chinese-chess/tools/verify-endgames.mjs
git commit -m "feat(chinese-chess): 残局库数据与校验脚本"
```

---

## Task 3: 对局状态机的残局模式

**Files:**
- Modify: `chinese-chess/js/game.js`
- Modify: `chinese-chess/tools/test-game.mjs`

**Interfaces:**
- Consumes: `endgames.js` 的 `findEndgame` / `ENDGAMES`
- Produces:
  - `startEndgame(game, endgameId) -> boolean`
  - `endgameOf(game) -> Endgame | null`

**要点：**

- 残局模式下 `mode = 'endgame'`、`endgameId` 记下是哪一局、`initialFen` 换成残局的 FEN、
  `moves` 清空、`cursor` 归零。
- `playerSide` 保持玩家选的执子方。残局库都是红先，所以玩家执黑时 AI 先走 —— 这条逻辑
  界面层已经有了（`requestAiMove`），不用改。
- **`startEndgame` 不改变 `level` 与 `playerSide`**：玩家在残局里也应该能调挡位。

- [ ] **Step 1: 追加测试**

```js
// --- 残局模式 ---
{
  const E = await load('endgames.js');

  check('残局库非空', E.ENDGAMES.length > 0, true);
  check('每一局都有 id / name / fen / source',
    E.ENDGAMES.every((e) => e.id && e.name && e.fen && e.source), true);
  check('findEndgame 找得到', E.findEndgame(E.ENDGAMES[0].id).id, E.ENDGAMES[0].id);
  check('findEndgame 找不到时返回 undefined', E.findEndgame('no-such-id'), undefined);

  const first = E.ENDGAMES[0];
  const g = G.createGame();
  G.playMove(g, pickMove(g)); // 先走一步，验证换局时会清空

  check('切换到残局成功', G.startEndgame(g, first.id), true);
  check('模式变成 endgame', g.mode, 'endgame');
  check('记录了残局 id', g.endgameId, first.id);
  check('起始局面换成了残局的 FEN', g.initialFen, first.fen);
  check('着法被清空', g.moves.length, 0);
  check('游标归零', g.cursor, 0);
  check('当前局面就是残局局面', G.currentFen(g), first.fen);
  check('endgameOf 能取回', G.endgameOf(g).id, first.id);

  check('切换不存在的残局失败', G.startEndgame(g, 'no-such-id'), false);
  check('切换失败后仍是原来的残局', g.endgameId, first.id);

  // 挡位与执子方不受影响
  g.level = 'easy';
  g.playerSide = -1;
  G.startEndgame(g, E.ENDGAMES[1].id);
  check('切残局不改挡位', g.level, 'easy');
  check('切残局不改执子方', g.playerSide, -1);
  check('切到第二局后 endgameOf 跟着变', G.endgameOf(g).id, E.ENDGAMES[1].id);

  // 回到普通对局
  G.reset(g);
  check('重置后仍标记为 endgame 模式（reset 只清着法）', g.mode, 'endgame');
  check('重置后回到残局起始局面', G.currentFen(g), E.ENDGAMES[1].fen);
}
```

- [ ] **Step 2: 跑一次，确认失败**

Run: `node chinese-chess/tools/test-game.mjs`
Expected: FAIL，`startEndgame is not a function`

- [ ] **Step 3: 实现**

在 `game.js` 里追加：

```js
import { findEndgame } from './endgames.js';

/**
 * 切到某一局残局。
 *
 * 刻意**不改 level 与 playerSide** —— 玩家在残局里也应该能调挡位、换执子方。
 * 残局库都是红先，所以玩家执黑时由界面层负责派发一次 AI 搜索。
 */
export function startEndgame(game, endgameId) {
  const eg = findEndgame(endgameId);
  if (!eg) return false;

  game.mode = 'endgame';
  game.endgameId = eg.id;
  game.initialFen = eg.fen;
  game.moves = [];
  game.cursor = 0;
  return true;
}

export function endgameOf(game) {
  return game.endgameId ? findEndgame(game.endgameId) || null : null;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

Run: `node chinese-chess/tools/test-game.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/js/game.js chinese-chess/tools/test-game.mjs
git commit -m "feat(chinese-chess): 对局状态机的残局模式"
```

---

## Task 4: 界面上的残局选择与训练

**Files:**
- Modify: `chinese-chess/index.html`
- Modify: `chinese-chess/style.css`
- Modify: `chinese-chess/js/main.js`
- Modify: `chinese-chess/js/persist.js`（存档要带上 `mode` / `endgameId`）

**Interfaces:**
- Consumes: `endgames.js` 的 `ENDGAMES` / `CATEGORIES`；`game.js` 的 `startEndgame` / `endgameOf`
- Produces: 残局面板

**界面要点：**

- 侧栏加一个「残局」面板：分类下拉（全部 / 实用残局 / 经典排局）+ 残局列表（名称 + 难度）。
  列表要能滚动，最多 340px 高（与着法列表一致）。
- 选中一局后：`startEndgame` → `refresh()` → 若是 AI 先走则 `requestAiMove()`。
- **训练反馈**：残局模式下，状态栏除了显示轮次，还要显示**该局的目标**（「红先胜」/「红先和」）
  与**已经走了几步**。玩家走完一步后如果局面变成终局，状态栏要明确说「达成目标」或「未达成」。
- 加一个「回到残局起点」按钮（复用「重开」即可，`reset` 已经能正确回到残局起始局面）。
- 「退出残局」：切回普通对局（`mode = 'play'`、`initialFen = START_FEN`、清空着法）。

- [ ] **Step 1: 加 DOM 与样式**
- [ ] **Step 2: 在 `main.js` 里绑定**
- [ ] **Step 3: 让 `persist.js` 存 `mode` / `endgameId`（`restoreInto` 也要恢复）**
- [ ] **Step 4: 浏览器实测**

用 `agent-browser` 逐项验证：能列出残局、点一局能载入、棋盘变成残局局面、
走子后有训练反馈、重开回到残局起点、退出残局能回到普通对局。

**注意：`agent-browser open` 对同一个 URL 是空操作**，改了代码后必须
先导航到别的地址再回来，否则跑的还是缓存里的旧 JS（这一条在实际执行时踩过）。

- [ ] **Step 5: 提交**

```bash
git add chinese-chess/index.html chinese-chess/style.css chinese-chess/js/main.js chinese-chess/js/persist.js
git commit -m "feat(chinese-chess): 残局选择与训练界面"
```

---

## Task 5: 文档

**Files:**
- Modify: `chinese-chess/README.md`
- Modify: `chinese-chess/docs/design.md`

**要点：**

- README 的「待办」去掉残局库，改成已完成的说明；补上：
  - 残局库有两类、各多少局
  - 数据来源与授权（《适情雅趣》公有领域 + `kuiba1949/xiangqi-tools` 的 BSD-3 FEN 转换）
  - **`result` 未经机器验证**，实用残局取自教材定式、经典排局取自排局谱性质
  - 怎么加一局（改 `endgames.js` → 跑 `verify-endgames.mjs`）
- `design.md` §8.2 的数据来源表补上已确认的实际来源；§14 的「排局胜负结论不保证精确」
  保持原样（它已经预见了这一点）。

- [ ] **Step 1: 改 README 与 design.md**
- [ ] **Step 2: 跑全部测试与校验**
- [ ] **Step 3: 提交**

```bash
git add chinese-chess/README.md chinese-chess/docs/design.md
git commit -m "docs: 残局库说明与数据来源"
```

---

## 完成标准

```bash
node chinese-chess/tools/test-rules.mjs        # 规则层（含 isLegalPosition）
node chinese-chess/tools/test-notation.mjs     # 记谱
node chinese-chess/tools/test-engine.mjs       # AI 层
node chinese-chess/tools/test-game.mjs         # 对局层（含残局模式）
node chinese-chess/tools/verify-endgames.mjs   # 残局库校验
```

五个命令退出码必须为 0。另外手动确认：能列出残局、能载入、能训练、能退出。

## 已知限制

> 本节的**权威版本在 [`future-work.md`](./future-work.md)**（含改进路径与工作量估算）。
> 这里保留的是撰写计划时的预期，供对照。

| 限制 | 说明 |
|------|------|
| **`result` 未经机器验证** | 要证明「红先必胜」需要可靠的求解器或权威棋谱。实用残局取自教材定式（可靠），经典排局取自《适情雅趣》的性质（逐局未复核） |
| **残局库不含解法** | 只有起始局面与结论，没有推荐着法或答案。想做「提示该走哪一步」的话，可以用现有引擎搜，但它对排局这种长杀棋的局面多半搜不出正解 |
| **不做局面编辑器** | 不能自由摆棋。要加新残局得直接改 `endgames.js` |
| **经典排局对学习者偏难** | 《适情雅趣》的局多是十几步的连杀，适合欣赏不适合入门训练。想练手请用「实用残局」那一类 |
