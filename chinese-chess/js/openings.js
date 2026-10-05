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
 * ## 库里有两半数据，分开维护
 *
 * | 哪一半 | 在哪个文件 | 怎么来的 | 规模 |
 * |--------|-----------|----------|------|
 * | **手写的线** | 本文件（`LINES`） | 人写的常识：中炮对屏风马、顺炮、列炮… | 7 条线 / 25 个局面 |
 * | **生成的谱** | `openings-generated.js` | `tools/gen-openings.mjs` 驱动 Pikafish 离线展开 | 1,789 个局面 / 3,492 条候选 |
 *
 * 两半走**同一条入库路径**（`indexLines` / `indexGenerated`），撞到同一个局面时权重相加 ——
 * 也就是「手写线和引擎都说这一步好」。分成两个文件是因为**谁是生成物要说清楚**：
 * 生成的那份带生成命令与引擎版本，手写的那份是人维护的常识，混在一起以后没人敢改。
 *
 * 生成的那份治的是「开局不像人」（着法宽得多、有分值权重），**治不了「对手走偏」**：
 * 谱里只有引擎认为可走的着法，对手一步次优着就掉出谱、回退搜索。详见 `docs/openings.md`。
 *
 * ## 数据格式（手写那半）：一行一条线，用 ICCS 坐标
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
 * 生成那半的格式不一样 —— 它**按局面**存（`[局面 FEN, [[着法, 权重], ...]]`），
 * 因为那是一棵树：按线存会把内部局面重复几十遍，而权重要**逐局面**给，
 * 一条线只能带一个权重，decompose 不成。两个文件的取舍理由见 `docs/decisions.md` 第 15 条。
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
 * **键还要做左右镜像归一**：局面自身与它的左右镜像，取 FEN 字符串小的那个当代表，
 * 于是 炮二平五 之后的局面与 炮八平五 之后的局面落到**同一个键**上。
 * 这成立是因为棋盘与标准开局都左右对称（唯一成立的对称，见 `position.js` 的 `mirrorIdx`）——
 * 库不必为「从左边出子 / 从右边出子」各写一遍线。查表命中镜像键时，候选着法会
 * **镜像回来**再返回，所以上层拿到的永远是**当前局面下**的着法。
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
 * - **不追求开局理论的深度。** 到第 8 个半回合（4 个回合）为止 —— 再深，变例树按层数
 *   指数膨胀，而边际价值很低：谱外的事只能交给搜索（位置表在催 AI 出子、占中路）。
 * - **不放进 `solutions.js` / `prefixes.js`。** 那两个是**残局的杀线**（`go mate` 的输出），
 *   与「开局的候选着法」是两种数据：前者是一条条要跟着走的线，后者是局面到着法的表。
 *   混在一起还会把 Engine 的 Worker 拖进几百 KB 的解法数据里。
 * - **不从棋谱数据库生成。** 那需要一份有授权的谱库、还得逐条核对（`future-work.md` B1）。
 *   生成那半数据的输入是**引擎自己的搜索输出**，没有授权问题。
 */
import { START_FEN, CELLS, EMPTY } from './config.js';
import { parseFen, toFen, mirrorMove, mirrorPosition } from './position.js';
import { moveOfIccs } from './iccs.js';
import { GENERATED_TREE } from './openings-generated.js';

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

/** 往表里塞一条候选：同一个局面的同一步在两条线上都出现时，权重相加。 */
function insert(key, move, weight) {
  let entry = BOOK.get(key);
  if (!entry) BOOK.set(key, (entry = []));
  const found = entry.find((e) => e.move === move);
  if (found) found.weight += weight;
  else entry.push({ move, weight });
}

/**
 * 局面的**归一朝向**：自身与它的左右镜像，取 FEN 字符串小的那个当代表。
 *
 * `mirrored` 表示「这个局面本身不是代表、要镜像一次才是」——建索引时把着法换成
 * 代表朝向的写法再存，查表命中时再镜像回来。挑哪个当代表无所谓，只要建与查一致；
 * 用 FEN 字符串的大小关系，只是因为它是一个**确定性的**全序，不必额外定义比较规则。
 */
function canonicalOfPos(pos) {
  const own = toFen(pos);
  const flipped = toFen(mirrorPosition(pos));
  return flipped < own ? { key: flipped, mirrored: true } : { key: own, mirrored: false };
}

/** 归一后的键（测试与文档用）。左右镜像的两个局面得到同一个值。 */
export function openingCanonicalFen(fen) { return canonicalOfPos(parseFen(fen)).key; }

/** 手写的那一半：把每条线从标准开局逐步重放，把「走这一步之前的局面」当键 */
function indexLines() {
  const start = parseFen(START_FEN);
  for (const line of LINES) {
    const weight = line.weight || 1;
    const pos = { cells: start.cells.slice(), side: start.side };
    for (const tok of line.moves.trim().split(/\s+/).filter(Boolean)) {
      const move = moveOfIccs(tok);
      const { key, mirrored } = canonicalOfPos(pos);
      // 局面本身是镜像朝向时，着法要换成代表朝向的写法再存
      insert(key, mirrored ? mirrorMove(move) : move, weight);
      applyMove(pos, move);
    }
  }
}

/**
 * 生成的那一半（`openings-generated.js`）：一条一条是 `[局面 FEN, [[着法, 权重], ...]]`。
 *
 * 生成物本身已经是**归一朝向**的（生成器就在归一空间里展开），这里照样再走一遍
 * `canonicalOfPos` —— 两套数据共用**同一条入库路径**，将来生成器换了朝向也不会静默错位，
 * 而且手写线与生成谱撞到同一个局面时权重自然相加（这就是「两条线都推荐这一步」）。
 */
function indexGenerated() {
  for (const [fen, moves] of GENERATED_TREE) {
    const { key, mirrored } = canonicalOfPos(parseFen(fen));
    for (const [iccs, weight] of moves) {
      const move = moveOfIccs(iccs);
      insert(key, mirrored ? mirrorMove(move) : move, weight);
    }
  }
}

function buildBook() {
  indexLines();
  indexGenerated();
}

buildBook();

/**
 * 这个局面在开局库里吗？在的话返回候选着法 `[{ move, weight }]`，否则 null。
 *
 * `fen` 可以是任何合法写法的 FEN（尾部字段不参与比较）—— 内部先 `parseFen` 再 `toFen`
 * 规范化，所以 `... w - - 12 34` 和 `... w - - 0 1` 是同一个键。
 *
 * **左右镜像的局面也算命中**：查的是归一后的键，命中镜像朝向时候选着法镜像回来再返回，
 * 所以返回值永远是这个局面下、能直接走的着法。
 */
export function openingEntry(fen) {
  const { key, mirrored } = canonicalOfPos(parseFen(fen));
  const entry = BOOK.get(key);
  if (!entry) return null;
  return mirrored ? entry.map((e) => ({ move: mirrorMove(e.move), weight: e.weight })) : entry;
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

/** 手写线有几条（文档 / 测试用） */
export function openingLineCount() { return LINES.length; }

/** 生成谱里有多少个局面（文档 / 测试用） */
export function openingGeneratedCount() { return GENERATED_TREE.length; }

/** 库里一共索引了多少个局面（文档 / 测试用） */
export function openingPositionCount() { return BOOK.size; }

/** 原始的线（只读副本，给测试与文档用） */
export function openingLines() {
  return LINES.map((l) => ({ name: l.name, weight: l.weight || 1, moves: l.moves }));
}
