/**
 * 可跟着走的线（"棋谱"）。纯逻辑 —— 不碰 DOM、不碰 Worker、不碰 localStorage。
 *
 * ## 两个来源、两种可信度
 *
 *   `solutions.js`  `src='mate'`  引擎在**根上**证明了强制杀 —— 「有解法」
 *   `solutions.js`  `src='walk'`  引擎走到底**能**杀，但**前段没有证明** —— 「引擎参考线」
 *   `prefixes.js`   （前缀）      引擎首选前 N 手，没走成杀 —— 同上，说「参考线 / 非证明」
 *
 * `lineOf` 把三者收成一个形状（`solutions.js` 优先），`lineLabel` 给出界面措辞。
 * **措辞分开是有意的**：实测把第 004 局谱上的妙手换成次优着法，Pikafish 只差 0.3~0.8 个兵，
 * 它分不出「杀网还在」和「只是还大优」—— 把这种线叫「正解」是骗人（详见 `docs/pikafish.md`）。
 *
 * ## 它解决什么
 *
 * 每局存的是一条**从初始局面开始的完整着法序列**（`pv`）。
 * 而界面要回答的是另一个问题：「**已经走过的这些着法**，谱上接下来写的是哪一步？」
 * —— 玩家可能已经走了几手，也可能压根没按线走。
 *
 * ## 怎么匹配：着法序列的前缀
 *
 * 把「实际走过的着法」与 `pv` **逐手比**：整个是前缀就给出下一手（`bookMove`），
 * 有一手对不上就返回 0，调用方回退引擎搜索。
 *
 * **不能只用「局面签名 → 着法」的 Map**：杀线里重复局面是常态（马炮来回走、士来回垫，
 * 同一条线上会反复回到同一个局面 —— 第 002 局里「马四进二 / 马二退四」就来回了几次），
 * 后一次会把前一次盖掉，于是**同一个局面拿到的是另一处该走的着法**，走错一步整条线就废了。
 * 这是 `tools/test-solution-book.mjs` 在全部 395 条上跑出来的（当时 4 条局红线）。
 *
 * 按「第几手」定位天然避开这一点，而且几条路径都对：跟着谱走（游标与谱同步）、
 * 悔棋（游标退回，前缀跟着变短）、点着法列表跳转（游标跟着走）。
 *
 * **对手一变着，前缀就断了** —— 这是有意的：`pv` 里红方的下一手只对 `pv` 上那个局面成立，
 * 硬接着往下走会走出错的棋。断了就回退引擎搜索（与没有线的局完全一样）。
 *
 * ## 谁来用
 *
 *   「提示」  → 一直用它：局面在线上就直接给谱上的着法，省掉最长 1.5 秒的搜索等待
 *   AI       → **默认不用**（一律实时搜索、按挡位出着）；「对局」面板里的
 *              「AI 按谱应着」开关打开后才走这里给出的着法，于是玩家顺着那条线
 *              能一直走到将死。开关默认关，见 `main.js` 的 `requestAiMove`。
 *
 * ## 为什么单独一个文件
 *
 * 展开与查表是纯逻辑（ICCS 坐标换算 + 前缀比对），写进 `main.js` 就没法单测，
 * 而它是「界面表现对不对」的关键一环 —— 包括 `lineOf` / `lineLabel` 那套措辞。
 * 与 share.js / custom-endgames.js 同一个理由。
 *
 * ## 坐标
 *
 * 解法里的着法用 **ICCS 坐标**（列 a-i 从左到右、行 0-9 从红方底线往上），
 * 与本模块的 `(x, y)`（y 从上往下）互为镜像，换算见 `moveOfIccs`。
 * 这一层只做换算与查表，不做合法性判断 —— 数据本身已经过 `verify-solutions.mjs` 校验。
 */
import { COLS } from './config.js';
import { encodeMove } from './rules.js';
import { solutionOf } from './solutions.js';
import { PREFIXES } from './prefixes.js';

/**
 * ICCS 坐标 → 内部着法编码（`from * 90 + to`）。
 *
 * `b5b9` → `(1,4) → (1,0)`：列 `a`-`i` 对应 `x = 0..8`；行 `0`-`9` 从红方底线往上，
 * 而我们的 `y = 0` 是黑方底线，所以 `y = 9 - rank`。
 *
 * **格子索引是 `y * COLS + x`（一格 9），不是 `y * CELLS + x`** ——
 * `CELLS = 90` 是格子**总数**，只在着法编码 `from * CELLS + to` 里用。
 * 这两个常量写混了不会报错，只会把着法整体算歪（`y * 90 + x` 会跑出棋盘外），
 * 所以 test-solution-book.mjs 里拿 `b5b9 → (1,4)→(1,0)` 钉了一条定点。
 */
export function moveOfIccs(tok) {
  const from = (9 - Number(tok[1])) * COLS + (tok.charCodeAt(0) - 97);
  const to = (9 - Number(tok[3])) * COLS + (tok.charCodeAt(2) - 97);
  return encodeMove(from, to);
}

/**
 * 把一条谱展开成着法数组：`moves[i]` 是第 i 手（0 基，红黑交替）。
 *
 * 纯换算，**不需要棋盘** —— 前缀匹配只比着法编码（见 `bookMove`），
 * 所以这一层既不 `parseFen`，也不维护「第 i 手之前的局面」。
 */
export function buildBook(pv) {
  const moves = [];
  if (!pv) return { moves };
  for (const tok of String(pv).trim().split(/\s+/).filter(Boolean)) moves.push(moveOfIccs(tok));
  return { moves };
}

/**
 * 谱载着法：**只有「已走的着法逐手都是谱的前 `ply` 手」时**才给。
 *
 * `played` 是已走的着法编码（`game.moves[i].move`，长度不小于 `ply`），
 * `ply` 是已走的半层数（`game.cursor`）。返回 0 表示没命中 —— 走岔了、悔棋到谱外、
 * 对手变了着、或者这一局本来就没有谱，调用方据此回退引擎搜索。
 *
 * 逐手比而不是只查「当前局面」：见文件头「怎么匹配」—— 杀线里重复局面是常态，
 * 同一个局面在两处要走向不同的着法。
 */
export function bookMove(book, played, ply) {
  if (!book || !Number.isInteger(ply) || ply < 0 || ply >= book.moves.length) return 0;
  for (let i = 0; i < ply; i++) {
    if (played[i] !== book.moves[i]) return 0;
  }
  return book.moves[ply];
}

/**
 * 「这一局可以跟着走的线」：先看 `solutions.js`，没有再看 `prefixes.js`。没有则 null。
 *
 * 两个来源合并成同一个形状 `{ pv, mate, src }`，**`src` 决定界面怎么措辞**：
 *   `'mate'`  引擎在**根上**证明了强制杀（`go mate`）—— 对手怎么走都杀，「有解法」
 *   `'walk'`  引擎沿自己选的着法**走到底能杀**（`mate` 有值）或只有一段首选前缀（`mate` 为 null）
 *             —— **前段没有证明**，「引擎参考线」
 * 实测（见 `docs/pikafish.md`）：把第 004 局谱上的妙手换成次优着法，Pikafish 只差 0.3~0.8 个兵 ——
 * 它分不出「杀网还在」和「只是还大优」。所以这两种**必须在文字上分开**，不能一律说「解法」。
 *
 * 放在这个文件而不是 `main.js`：它是纯查表逻辑（不碰 DOM），而措辞对不对是**能自动断言**的 ——
 * `tools/test-solution-book.mjs` 第 7 组就是钉它的（同 E10 的教训：界面表现要有断言钉住）。
 */
export function lineOf(id) {
  if (!id) return null;
  const sol = solutionOf(id);
  if (sol) return { pv: sol.pv, mate: sol.mate, src: sol.src || 'mate' };
  const pre = PREFIXES[id];
  if (pre) return { pv: pre.pv, mate: pre.mate || null, src: 'walk' };
  return null;
}

/** 一条线的说法。状态行 / 列表徽标 / tooltip 共用这一处，免得三处措辞打架 */
export function lineLabel(line) {
  if (!line) return '';
  if (line.src === 'mate') return `有解法（${line.mate} 步杀）`;
  const plies = line.pv.trim().split(/\s+/).filter(Boolean).length;
  return line.mate
    ? `引擎参考线（走到底 ${line.mate} 步杀，前段未经证明）`
    : `引擎参考线（前 ${Math.ceil(plies / 2)} 回合，非证明）`;
}
