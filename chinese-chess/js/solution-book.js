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
 * 而界面要回答的是另一个问题：「**眼下这个局面**，线上写的是哪一步？」
 * —— 玩家可能已经走了几手，也可能压根没按线走。
 *
 * 做法：进一局时把那条线展开成两个平行数组（见 `buildBook`）——
 * 第 i 手**之前的局面签名**、以及第 i 手本身。查询时拿「当前走到第几手」
 * （`game.cursor`，也就是已走半层数）去对：签名一致就给出那一手，不一致就回退引擎搜索。
 *
 * ## 为什么不能只用「局面签名 → 着法」的 Map
 *
 * **杀线里重复局面是常态**：马炮来回走、士来回垫，同一条线上会反复回到同一个局面
 * （第 002 局里「马四进二 / 马二退四」就来回了几次）。只用签名当键，后一次会把前一次
 * 盖掉，于是**同一个局面拿到的是另一处该走的着法** —— 走错一步，整条线就废了。
 * 这是 `tools/test-solution-book.mjs` 在全部 395 条上跑出来的（当时 4 条局红线）。
 *
 * 带上「谱上第几手」之后，匹配就唯一了，而且几条路径天然都对：
 * 跟着谱走（游标与谱同步）、悔棋（只移动游标）、点着法列表跳转（游标跟着走）；
 * 一旦走了谱外的着法，签名对不上 → 回退引擎搜索。
 *
 * ## 为什么单独一个文件
 *
 * 展开与查表是纯逻辑（局面签名 + ICCS 坐标换算），写进 `main.js` 就没法单测，
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
import { parseFen, toFen, positionSignature } from './position.js';
import { encodeMove, moveFrom, moveTo } from './rules.js';
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

/** 在局面上走一步（就地改。这一层只跟着法序列打交道，不需要哈希之类的增量状态） */
function play(pos, move) {
  const from = moveFrom(move);
  const to = moveTo(move);
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;
}

/**
 * 把一条杀线展开成 `{ moves, before }`：两组等长数组。
 *
 *   `moves[i]`   第 i 手（0 基，红黑交替）
 *   `before[i]`  走第 i 手**之前**那个局面的签名
 *
 * `initialFen` 与 `pv` 都来自同一局的 `endgames.js` + `solutions.js`。
 * 两者对不上（数据错了）不会抛 —— 展开只是照着走，界面上表现为「查不到、回退引擎」；
 * 数据本身该由 `verify-solutions.mjs` 在离线时挡住，运行时不该为此崩页面。
 */
export function buildBook(initialFen, pv) {
  const moves = [];
  const before = [];
  if (!pv) return { moves, before };

  const pos = parseFen(initialFen);
  for (const tok of String(pv).trim().split(/\s+/).filter(Boolean)) {
    before.push(positionSignature(toFen(pos)));
    const move = moveOfIccs(tok);
    moves.push(move);
    play(pos, move);
  }
  return { moves, before };
}

/**
 * 谱载着法：**只有当「走到第 ply 手」这个位置与谱上对得上时**才给。
 *
 * `ply` = 已走的半层数（`game.cursor`）。返回 0 表示没命中 ——
 * 走岔了、悔棋到谱外、或者这一局本来就没有解法，调用方据此回退引擎搜索。
 */
export function bookMove(book, fen, ply) {
  if (!book || !Number.isInteger(ply) || ply < 0 || ply >= book.moves.length) return 0;
  return book.before[ply] === positionSignature(fen) ? book.moves[ply] : 0;
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
