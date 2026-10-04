/**
 * 开局库。纯逻辑 —— 不碰 DOM、不碰 Worker、不碰 localStorage。
 *
 * ## 它解决什么
 *
 * 没有它的时候，AI 的开局完全由评估 + 浅层搜索决定：只要评估没把某个「不像人」的
 * 着法压下去，AI 就会走出去。位置表（`config.js` 的 `PIECE_SQUARE_*`）把
 * 「开局弃炮换马」这类明显不像话的着法挡住了，但**像不像人**和**好不好**是两件事 ——
 * 中炮、屏风马、仙人指路这些人类几百年的开局共识，浅层搜索给不出来。
 * 开局库就是把这份共识直接写下来：库里有的局面**直接走谱上的着法，不做搜索**。
 *
 * ## 数据格式：一行一条线，用 ICCS 坐标
 *
 *   `{ name: '中炮对屏风马', weight: 3, moves: 'h2e2 h9g7 h0g2 ...' }`
 *
 * `moves` 是从**标准开局**开始的一串着法（红先，红黑交替），用 **ICCS 坐标**写：
 * 列 a-i 从左到右、行 0-9 从红方底线往上。换算是 `iccs.js` 里那一份，
 * 和解法（`solutions.js`）共用 —— 这样数据可以拿去和任何棋谱对照。
 *
 * `weight` 是这条线的分量（默认 1）。同一个局面下有多条线给出不同的着法时，
 * 权重决定**随机挑到**它们的概率 —— 这就是「AI 会变着」的来源。
 * 主力线（屏风马）给大一点，冷门线给小一点。
 *
 * ## 索引：局面 → 可选的着法（带权重）
 *
 * 加载时把每条线从 `START_FEN` **逐步走一遍**，把「走这一步之前的局面」当键记下来：
 *
 *   局面（含轮走方）→ [ { move, weight }, ... ]
 *
 * 于是**不同线走到同一个局面时会自然合并**（真正的转置），同一个局面下就有多个候选 ——
 * 这正是开局库该有的样子。注意这里和 `solution-book.js` 的取舍**不一样**：
 * 那边存的是「一条线」，同一个局面在不同线上要走向不同的着法，所以必须按着法序列
 * 逐手比前缀；而开局库的候选**只取决于局面**（转置后着法一样成立），所以按局面查表是对的。
 *
 * **键是规范化后的完整 FEN（含轮走方）** —— 用 `toFen` 而不是直接比传进来的字符串，
 * 于是「尾部字段写成 `w - - 12 34` 的同一个局面」也能命中。轮走方必须在键里：
 * 同一个盘面轮到谁走，可选着法完全不同。
 *
 * ## 谁用它、怎么用
 *
 * `engine.js` 的 `search()` 在**搜索之前**查一次，只在两件事同时成立时走谱：
 *
 *   1. 挡位允许 —— `LEVELS[k].book` 是「查谱概率」，弱挡位给它低值
 *      （入门 / 初级本来就该常常不按谱走、露出新手的样子）
 *   2. 这个局面确实在库里
 *
 * 走谱时**不派发搜索**（零耗时，天然对「实时」友好），也**不施加挡位弱化** ——
 * 谱上的着法是「已知的合理开局」，不是搜索结论，把它换成随机着法与它的意义相悖。
 *
 * 库里的着法返回前还会**再过一遍 `generateLegalMoves`**：数据写错、或者局面其实不是
 * 库里那个（哈希碰撞这类极端情况）时，宁可退回常规搜索，也不能让上层拿到非法着法
 * —— 上层会把非法着法静默丢掉，表现成「AI 不动了」（同 `future-work.md` E9 的教训）。
 *
 * **谱外一律回退搜索**：对手不按谱走、这一步走岔了、或者库本身没写到那么深，
 * 行为与没有开局库时一模一样。
 *
 * ## 怎么加 / 改一条线、怎么验证
 *
 * 见 [`docs/openings.md`](../docs/openings.md)。**每条线都会被 `tools/test-openings.mjs`
 * 从开局逐步重放并校验合法性** —— 数据写错（走不通、记法算错）会在那里当场变红，
 * 这是「外部标准要有一层自己写的校验钉住」的同一套路（见 `future-work.md` E10）。
 *
 * ## 特意不做的事
 *
 * - **不追求开局理论的深度。** 库到第 4~8 手就停（再深就要维护一整套变例树），
 *   剩下的交给搜索 —— 位置表已经在催 AI 出子、占中路了。
 * - **不放进 `solutions.js` / `prefixes.js`。** 那两个是**离线引擎生成的产物**、
 *   针对残局；开局库是**手写的常识数据**、针对标准开局。混在一起会让「谁是生成物」
 *   这件事说不清，也会把 Engine 的 Worker 拖进几百 KB 的解法数据里。
 */
import { START_FEN, CELLS, EMPTY } from './config.js';
import { parseFen, toFen } from './position.js';
import { moveOfIccs } from './iccs.js';

/**
 * 开局主线。加一条线就加一行 —— 但**加完必须跑 `tools/test-openings.mjs`**，
 * 它会从标准开局逐步重放、逐手校验合法性。
 *
 * 权重只是「同一个局面下被挑中的相对概率」，不是棋力评价。
 */
const LINES = [
  // 中炮对屏风马：最主流的一条，给最大权重
  { name: '中炮对屏风马', weight: 3, moves: 'h2e2 h9g7 h0g2 i9h9 i0h0 b9c7 c3c4 g6g5' },
  // 顺炮（双方中炮在同一侧）、列炮（异侧）
  { name: '中炮对顺炮', weight: 2, moves: 'h2e2 h7e7 h0g2 h9g7 i0h0 i9h9' },
  { name: '中炮对列炮', weight: 1, moves: 'h2e2 b7e7 h0g2 h9g7 i0h0 i9h9' },
  // 单提马（黑马屯边）
  { name: '中炮对单提马', weight: 1, moves: 'h2e2 b9a7 h0g2 h9g7' },
  // 仙人指路 / 飞相局 / 起马局：另外三种红先体系
  { name: '仙人指路', weight: 1, moves: 'c3c4 b7c7 h0g2 h9g7' },
  { name: '飞相局', weight: 1, moves: 'g0e2 h7e7 h0g2 h9g7' },
  { name: '起马局', weight: 1, moves: 'h0g2 g6g5' },
];

/**
 * 局面（规范化 FEN）→ [{ move, weight }]。
 *
 * 同一个局面下多条线给出同一步时权重相加；给出不同的着法时并列成候选。
 */
const BOOK = new Map();

/** 走一步（数据可信，不做合法性校验 —— 校验在 `tools/test-openings.mjs` 里做） */
function applyMove(pos, move) {
  const from = Math.floor(move / CELLS);
  const to = move % CELLS;
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = EMPTY;
  pos.side = -pos.side;
}

function buildBook() {
  const start = parseFen(START_FEN);
  for (const line of LINES) {
    const weight = line.weight || 1;
    const pos = { cells: start.cells.slice(), side: start.side };
    for (const tok of line.moves.trim().split(/\s+/).filter(Boolean)) {
      const move = moveOfIccs(tok);
      const key = toFen(pos);
      let entry = BOOK.get(key);
      if (!entry) BOOK.set(key, (entry = []));
      const found = entry.find((e) => e.move === move);
      if (found) found.weight += weight;
      else entry.push({ move, weight });
      applyMove(pos, move);
    }
  }
}

buildBook();

/**
 * 这个局面在开局库里吗？在的话返回候选着法 `[{ move, weight }]`，否则 null。
 *
 * `fen` 可以是任何合法写法的 FEN（尾部字段不参与比较）—— 内部先 `parseFen` 再 `toFen`
 * 规范化，所以 `... w - - 12 34` 和 `... w - - 0 1` 是同一个键。
 */
export function openingEntry(fen) {
  return BOOK.get(toFen(parseFen(fen))) || null;
}

/**
 * 按权重随机挑一步谱上的着法。不在库里返回 0。
 *
 * `rng` 由调用方注入（默认 `Math.random`）—— 与引擎其余部分一致，
 * 测试传固定种子就能得到确定结果。
 */
export function pickOpening(fen, rng = Math.random) {
  const entry = openingEntry(fen);
  if (!entry) return 0;

  let total = 0;
  for (const e of entry) total += e.weight;

  let roll = rng() * total;
  for (const e of entry) {
    roll -= e.weight;
    if (roll < 0) return e.move;
  }
  // 浮点边界兜底（rng 恰好等于 1 时理论上到得了这里）
  return entry[entry.length - 1].move;
}

/** 库里有几条线（文档 / 测试用） */
export function openingLineCount() { return LINES.length; }

/** 库里一共索引了多少个局面（文档 / 测试用） */
export function openingPositionCount() { return BOOK.size; }

/** 原始的线（只读副本，给测试与文档用） */
export function openingLines() {
  return LINES.map((l) => ({ name: l.name, weight: l.weight || 1, moves: l.moves }));
}
