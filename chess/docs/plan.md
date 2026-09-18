# 国际象棋模块的实施计划

给「下一个会话」用的执行清单。设计依据是 `design.md`，引擎与残局的离线手册是 `stockfish.md`。
**每个 Task 都是可独立提交、可独立验证的**，不要合并着做。

## 0. 前置约定（先读一遍再动手）

- **工程约束**（照抄 `chinese-chess`）：纯静态、无构建、无依赖、无框架；
  所有测试用 `node chess/tools/test-*.mjs` 直接跑，退出码必须为 0。
- **模块隔离**（AGENTS.md）：不引用任何其它模块的文件，命名一律带 `chess-` 前缀，
  localStorage key 一律 `chess:` 开头。
- **能用站点公共文件**：`<head>` 里引 `../global.css` 与 `../global.js`
  （`global.js` 必须同步加载在 `<head>`，不能加 `defer`/`async`）。
- **新模块的注册**（AGENTS.md 的「新增模块」三步，放在 Task 12）：根 `index.html` 的
  `<details class="group">` 里加一张卡片、根 `README.md` 的目录表加一行。
- **本地预览**：`python -m http.server 8000` → `http://127.0.0.1:8000/chess/`
  （不要用 `file://` 打开，Worker / ES Module 会被 CORS 拦掉）。
- **注释风格**：跟 `chinese-chess` 一致 —— 注释写「为什么这么选、踩过什么坑」，
  不写「这行在做什么」。
- **每个 Task 完成后跑一遍已有的测试**，再按该 Task 末尾给的 commit message 提交。

---

## Task 0：骨架跑起来

**Files**：`chess/index.html`（新建）、`chess/style.css`（新建）

**要点**

- `index.html` 照抄 `chinese-chess/index.html` 的骨架：`../global.css` + `../global.js`、
  `.container.wide`、标题行、状态行、棋盘容器、工具栏、侧栏（对局面板 + 着法面板）、
  三个 `<dialog>`（局面库 / 保存导入 / 升变选择）。
- `style.css` 顶部先定义模块变量（深浅两套）：`--chess-light`（浅格）、`--chess-dark`（深格）、
  格线/坐标色、棋子白/黑两套（填充 + 描边）、高亮四色（上一步 / 选中 / 可走 / 可吃 / 将军）。
  **颜色不要写死**，深浅主题只换变量。
- 布局直接照搬象棋的网格（`grid-area` 显式定位：棋盘列 + 300px 侧栏 + 工具栏独立成行；
  ≤860px 单列），见 `design.md` §11.1。

**验证**：`python -m http.server 8000` 打开 `/chess/` —— 能看到空棋盘（8×8 深浅格）、
状态行、工具栏、侧栏、深浅主题切换正常。

**提交**：`feat(chess): 模块骨架与棋盘样式`

---

## Task 1：常量与局面（`config.js` / `position.js`）

**Files**：`chess/js/config.js`、`chess/js/position.js`（新建）、`chess/tools/test-position.mjs`

**Produces**（上层依赖这些名字，定下来别改）

```js
// config.js
export const FILES = 8, RANKS = 8, CELLS = 64;
export const EMPTY = 0;
export const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
export const WHITE = 1, BLACK = -1;
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const LEVELS = [ /* 见 design.md §7.3 */ ];

// position.js
export function parseFen(fen) -> Position   // 见 design.md §4.2
export function toFen(pos) -> string
export function normalizeFen(fen) -> string  // 用于判等（框里就是当前局面）
export function index(file, rank) -> number
export function fileOf(idx), rankOf(idx)
export function positionSignature(pos) -> string   // 重复局面用（不含步数计数）
export function zobristKey(pos) -> number          // 需要跨会话稳定 → 自己写 xorshift，别用 Math.random
```

**要点**

- FEN 少写后两段时要能容错（按 `0 1` 补），且 `parseFen` / `toFen` 必须互逆。
- `zobristKey` 的表必须**固定种子**生成，否则存档/复现的哈希会变。
- 这一层是纯逻辑、无 DOM —— 它将来要被 Worker 直接加载，所以**不许 import 任何和 DOM 有关的东西**。

**验证**：`node chess/tools/test-position.mjs` —— 初始局面 FEN 往返一致、少写后两段能解析、
空/满局面边界、签名对「同一局面不同步数」相等。

**提交**：`feat(chess): 常量、局面表示与 FEN 解析`

---

## Task 2：规则层（`rules.js`）—— 本模块最硬的一层，先做

**Files**：`chess/js/rules.js`（新建）、`chess/tools/test-rules.mjs`

**Produces**

```js
export function encodeMove(from, to, promo = 0, flag = 0) -> number
export function moveFrom(m) / moveTo(m) / movePromo(m) / moveFlag(m)
export function generateMoves(pos) -> number[]        // 伪合法
export function generateLegalMoves(pos) -> number[]    // 走后不能被将军
export function makeMove(pos, m) -> Undo               // 返回回退所需信息（不可变风格：改副本）
export function isAttacked(cells, idx, bySide) -> boolean
export function findKing(cells, side) -> number
export function gameStatus(pos) -> { type, winner }    // checkmate | stalemate | fifty | insufficient | playing
```

**要点**

- 位布局、易位/过路兵/升变的条件见 `design.md` §5.1~§5.3。
- 合法性用「走一步 → 查自己的王是否被攻击 → 退回来」，**不要**自己推导「被将军时哪些能走」。
- 易位要单独查**王经过的两格**（含起点）不被攻击。
- 三次重复不在这一层（需要整条着法线，放 `game.js`）。

**测试（两层都要写）**

1. **perft**：初始局面 1~5 手（`--deep` 加第 6 手），Kiwipete / Position 3 / 4 / 5
   的 1~4 手 —— 数字见 `design.md` §3.4。**perft 是这一层唯一绝对权威的判据。**
2. **逐条断言**：perft 只报「总数不对」，逐条断言才能指出是哪条规则错了。至少盖：
   易位全部条件（权没了 / 中间有子 / 王经过被攻击 / 长易位中间格）、
   吃过路兵（含「吃过路兵后不能留下被将军的王」）、升变四种、
   逼和与将死的区别、50 步、子力不足三种（含 K+B vs K+B 同色格 vs 异色格）。

**提交**：`feat(chess): 规则层（着法生成、合法性、终局判定）与 perft 测试`

---

## Task 3：记谱（`notation.js`）

**Files**：`chess/js/notation.js`（新建）、`chess/tools/test-notation.mjs`

**Produces**

```js
export function toSan(pos, move) -> string      // 必须在改局面之前调用
export const PIECE_NAMES = { 1:'兵', 2:'马', 3:'象', 4:'车', 5:'后', 6:'王' };
```

**要点**

- 消歧义三段式、升变与将军/将死后缀，规则见 `design.md` §6.1。
  **判据是「其它同类棋子能否合法走到同一目标格」**，被牵制的不算 —— 这条最容易写错。
- 不做 SAN 解析。

**测试**：固定局面 + 固定着法，断言字符串：`Nbd2`（两个马都能到 d2）、`R1e2`（同 file 两车）、
`exd5`、`exd6`（吃过路兵）、`O-O` / `O-O-O`、`e8=Q+`、`Qh4e1`（都要写）、
以及「被牵制的马不参与消歧义」这个反例。

**提交**：`feat(chess): SAN 记谱与测试`

---

## Task 4：对局状态机（`game.js`）

**Files**：`chess/js/game.js`（新建）、`chess/tools/test-game.mjs`

**Produces**（**尽量与象棋的 `game.js` 同名同义**，这样 `main.js` 的骨架能照搬）

```js
export function createGame(options) -> Game     // { initialFen, moves, cursor, mode, playerSide, level, endgameId, twoPlayer }
export function currentPosition(game) -> Position
export function currentFen(game) -> string
export function evaluateStatus(game) -> { type, winner }   // 三次重复在这里判
export function playMove(game, move) -> { ok, reason? }
export function canUndo(game) / isReviewing(game) / sideToMove(game) / lastMove(game)
export function undoToPlayer(game) / gotoPly(game, n) / reset(game)
export function startEndgame(game, id) / startPosition(game, fen) / exitEndgame(game)
```

**要点**

- `moves[i] = { move, san, captured, fenAfter }`；每步一份 FEN 快照，换来回看跳转 O(1)。
- **悔棋与跳转只移动 `cursor`，绝不删除 `moves`** —— 重做才免费；只有在回看状态下走新着法
  时才截断后面的分支。
- `undoToPlayer`：人机模式退到「轮到玩家走」为止（否则 AI 立刻又走一步，等于悔棋没生效），
  双人对弈只退一步。
- 三次重复只看当前这条线（起始局面 + `moves[0..cursor)`），不看被截断的分支。

**测试**：`node chess/tools/test-game.mjs` —— 悔棋后重做能回到原局面、回看状态走新着法会截断、
连续三次重复触发和棋、AI 模式下悔棋退两步（双人模式退一步）。

**提交**：`feat(chess): 对局状态机（FEN 快照、悔棋、回看跳转）`

---

## Task 5：棋盘渲染（`renderer.js`）

**Files**：`chess/js/renderer.js`（新建）

**Produces**

```js
export function createRenderer(boardEl, wrapEl) -> {
  draw(pos, highlight, movers),   // movers: { from, to } 或数组，见 design.md §3.8
  cellIndexOf(node), setFlipped(v), isFlipped(),
  isAnimating(), afterAnimation(fn),
  cells, boardEl,
}
```

**要点**

- 64 个 `<button class="chess-cell">`（键盘可遍历），格心就是落点，棋子绝对定位用 `left/top` 百分比。
- 棋子：内联 SVG（图形是生成物 `js/pieces.js`，Cburnett 棋子集；`fill` / `stroke` 走 CSS 变量），
  **理由见 `design.md` §3.3（Unicode 会被渲染成 emoji、白棋在浅格上糊成一片）**。
  （期间试过手绘一版，最终换成 Cburnett：手绘在棋盘尺寸下「王和象分不开、马像个团块」——
  原因与三条踩过的坑都记在 design.md §3.3。）
- 坐标 `a-h` / `1-8` 放在棋盘**外面**（棋盘留 margin，坐标行用负偏移站进去）——
  象棋在同一个地方踩过坑（数字被棋子压住），照搬它「放到棋盘外」的结论。
- 高亮清单见 `design.md` §8.2。**不要**照搬象棋的「整方棋子加紫圈」（SVG 上 `outline` 是矩形）。
- 重绘与动画三条（diff / AI 等补间 / 只有 ±1 步补间）见 `design.md` §3.8，实现细节直接看
  象棋的 `renderer.js` 与 `main.js` 的 `stepAnimation` / `afterAnimation`。

**验证**（没有 DOM 测试，只能手动）：在 `index.html` 末尾临时塞一段脚本摆一个局面，
确认：坐标不出格、翻转后坐标仍然正着（动画期间会短暂隐藏）、走一步能看到棋子滑过去。

**提交**：`feat(chess): 棋盘渲染（格子、SVG 棋子、坐标、高亮、补间）`

---

## Task 6：交互与装配（`interaction.js` / `main.js`）

**Files**：`chess/js/interaction.js`、`chess/js/main.js`（新建）

**要点**

- 交互照搬象棋：点击选子 → 点击目标（主路径）；鼠标可拖拽（`pointerType === 'mouse'`），
  不做拖拽残影；目标格不合法 = 改选，不报错。
- **升变**：兵到末 rank 时先弹浮层（后/车/象/马 + Esc 取消），选定后才落子。
  这是国象多出来的唯一一处「走子前要问一句」的交互。
- 状态行：轮走方（方名按色着色）、将死 / 逼和 / 50 步 / 三次重复 / 子力不足、思考中、回看中。
- 防重入：`busy` 期间禁止操作（AI 在思考、以及等补间跑完的那一段，见 `design.md` §3.8）。

**验证**：能人机走完一盘；能升变（选四种各试一次）；**翻转棋盘后点击仍然正确**
（这条最容易错：翻转后点错格子就说明坐标映射写反了）。

**提交**：`feat(chess): 走子交互、升变选择与人机装配`

---

## Task 7：引擎（`engine.js` / `worker.js`）

**Files**：`chess/js/engine.js`、`chess/js/worker.js`（新建）、`chess/tools/test-engine.mjs`、`chess/tools/selfplay.mjs`

**要点**

- 评估与搜索的清单见 `design.md` §7.1~§7.2。**评估里不许出现需要生成着法的项**。
- 置换表用 Zobrist 增量哈希；`make/unmake` 成对，超时异常穿过去之后棋盘必须能还原
  （象棋那边踩过：不还原就会从错乱的棋盘上挑着法，表现成「AI 不动了」）。
- 挡位表照 `design.md` §7.3；**弱挡位靠「关掉静态搜索 + 根节点噪声 + 故意次优着」**，
  这三个开关比降深度更「像新手」。
- Worker 协议照 `design.md` §7.4；**不返回 SAN**（主线程本来就要算一次）。

**测试**

- 单测只钉稳定的东西（**不要钉节点数、不要钉耗时**）：增量哈希与全量一致、全程回退后
  棋盘与哈希都还原、只有一个合法着法的局面必须返回它、只翻一个参数的对照组
  （打开/关闭静态搜索给出不同结论）。
- `selfplay.mjs`：两挡位自对弈若干局，断言「不崩、不超时、着法全部合法、终局类型合理」——
  它管的是组合状态，单测覆盖不到（象棋那边靠它抓到过两个真 bug）。

**提交**：`feat(chess): 自研引擎（评估、搜索、挡位）与 Worker`

---

## Task 8：工具栏、单步回看、提示

**Files**：`chess/js/main.js`、`chess/style.css`

**要点**

- 工具栏：悔棋 / 重做 / 重开 / 翻转 / 提示 / 复制 FEN / 复制链接。
- **着法面板标题行加「上一步 / 下一步」**（三列网格：左标题、中单步、右复制）——
  国象这边「悔棋」在人机模式同样会退两步，所以单步回看是必需的，不是可选。
- 单步回看 / 重做 / 点着法列表都走同一个函数（挪光标 + 相邻一步才补间），
  照搬象棋的 `gotoPlyAnimated` + `stepAnimation` + `MAX_ANIMATED_PLIES = 2`。
- 提示：优先给谱载解法（有解法的残局），否则派发一次搜索。

**验证**：单步回看动画正确、到两头按钮置灰、AI 思考期间按钮全灰、跳转不补间。

**提交**：`feat(chess): 工具栏、单步回看与提示`

---

## Task 9：存档与分享（`persist.js` / `share.js`）

**Files**：`chess/js/persist.js`、`chess/js/share.js`（新建）、`chess/tools/test-share.mjs`

**要点**

- key `chess:state`；存 `level / playerSide / mode / initialFen / moves / cursor / twoPlayer / endgameId`。
- 任何字段坏掉 → 整体重建为标准开局（不抛错、不半坏）。
- 分享链接把 FEN 编进 URL；**打开链接优先于存档**（用户是主动点开的），解析失败只在状态行提示。

**验证**：`node chess/tools/test-share.mjs`（编解码往返、坏链接不炸）；手动确认刷新不丢局面、
打开自己的链接能复现。

**提交**：`feat(chess): 存档与分享链接`

---

## Task 10：残局库与谱载解法

**Files**：`chess/js/endgames.js`、`chess/js/solutions.js`（生成物）、`chess/js/solution-book.js`（新建）、
`chess/tools/gen-solutions.mjs`、`chess/tools/verify-endgames.mjs`

**要点**

- 流水线与数据结构见 `design.md` §9、`stockfish.md` §4。先放 30~60 局（四类页签），跑通流程最重要。
- 解法匹配键是 `endgameId + '|' + ply`，**不能只用局面**（杀线里重复局面是常态）。
- 每一步都要用本模块规则层复核，`verify-endgames.mjs` 是入库闸门。

**验证**：`node chess/tools/verify-endgames.mjs` 全绿；界面上打开一局有解法的残局，
提示给出谱上正解，AI 按谱应着。

**提交**：`feat(chess): 残局库、离线解法流水线与谱载应着`

---

## Task 11：局面库与自定义局面

**Files**：`chess/js/custom-endgames.js`、`chess/js/main.js`、`chess/index.html`、`chess/tools/test-main.mjs`

**要点**：照搬象棋的三个弹窗（局面库 / 保存-导入 / 重命名）与交互约定：
FEN 框打开时就是当前局面、「框里就是当前局面」时「载入到棋盘」置灰、校验失败必须带原因。

**验证**：存/改名/删自定义局面；粘一段别处复制的 FEN 载入；分享链接打开的是「临时局面」。

**提交**：`feat(chess): 局面库、自定义局面与 FEN 导入导出`

---

## Task 12：注册与收尾

**Files**：根 `index.html`、根 `README.md`、根 `AGENTS.md`、`chess/README.md`

**要点**

1. 根 `index.html` 的 `<details class="group">` 里加一张 `.card`（链到 `./chess/index.html`）；
2. 根 `README.md` 的目录表加一行；
3. 根 `AGENTS.md` 的模块表加一行（本地子目录形式）；
4. `chess/README.md` 定稿：这是什么、怎么跑、目录结构、文档导航、玩法、常见改动、已知限制
   （形状照抄 `chinese-chess/README.md`）。

**验证**：从首页点进去能用；四个测试脚本 + 残局校验全部退出码 0；深浅主题与窄屏各看一遍。

**提交**：`docs(chess): 注册到首页与仓库文档`

---

## 验收清单（做完 Task 12 时逐条过）

- [x] `node chess/tools/test-rules.mjs`（含 perft 1~5 + Kiwipete 等四个局面）退出码 0
      （可选的 `--deep` 也跑了：初始局面第 6 手 119060324 通过）
- [x] `node chess/tools/test-notation.mjs` / `test-game.mjs` / `test-engine.mjs` / `test-share.mjs` 退出码 0
      （另加 `test-position.mjs` / `test-renderer.mjs` / `test-solution-book.mjs` / `test-main.mjs` 也都 0）
- [x] `node chess/tools/verify-endgames.mjs` 退出码 0
- [x] 人机对弈能下完一盘（含升变、吃过路兵、易位各至少出现一次）
      —— 浏览器里实走（用「保存 / 导入」的 FEN 框读回局面当证据，双人对弈开关避开 AI 随机性）：
      短易位 `1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O`（rank 1 变 `RNBQ1RK1`、易位权降到 `kq`）；
      吃过路兵 `1.exd6`（`4k3/8/8/3pP3/8/8/8/4K3 w - d6` → 黑 d5 兵消失）；
      升变四种各一次（`a8=Q+` / `a8=R+` / `a8=B` / `a8=N`，Esc 取消过一步、着法列表仍是「还没有走棋」）；
      终局从 `7k/8/6K1/8/8/8/8/R7 w` 走 `1.Ra8#` → 状态行「将死 · 白方胜」。
      **注意**：这几种着法是分别在摆好的局面上走的，「一整盘里三种都出现」没有特意构造。
      这轮已经把它们**固化成 `test-main.mjs` 最后的「特殊着法」一节**
      （21 处 check，其中 3 处在「四种升变」的循环里 → 实跑 30 条；
      吃过路兵那两条是成对的「走之前 d5 有黑兵 / 走之后没有」），以后改交互层不用再靠手工点。
- [x] 悔棋 / 重做 / 单步回看 / 翻转 / 提示 全部可用，动画符合 `design.md` §3.8
      —— 行为由 `test-main.mjs` 逐条钉住（含翻转后点击映射、AI 等补间）；动画观感没有逐帧看过。
- [x] 深色模式配色正常；窄屏单列布局正常（浏览器实看，控制台 0 报错）
- [x] 刷新不丢局面；分享链接能复现局面
- [x] 首页卡片与两份仓库文档都已更新
