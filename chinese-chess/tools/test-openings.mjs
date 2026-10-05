#!/usr/bin/env node
/**
 * 开局库测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-openings.mjs
 *
 * ## 重点不是「查表能不能查到」，而是**数据有没有写错**
 *
 * 开局库有**两半数据**：手写的线（`js/openings.js` 的 `LINES`）与生成的谱
 * （`js/openings-generated.js`，`tools/gen-openings.mjs` 的产物）。手写着法最容易出的三种错
 * 都是静默的：
 *
 *   1. **这一步根本走不通**（记法算错、棋子不在那儿、被蹩腿 / 塞眼）
 *   2. **走子方不对**（红黑顺序写反了）
 *   3. **索引键算错**（局面和着法对不上）
 *
 * 所以这里的主要动作是**把每条线从标准开局逐步重放**，每一步都：
 *   - 必须是当前局面的合法着法
 *   - 必须出现在库对这个局面的候选里（也就是索引真的建对了）
 *   - 走子方必须与手数交替一致（红先）
 *   - 库里这个局面的**所有**候选（含转置合并进来的）都必须是合法着法
 *
 * 另外两件单独钉住的事：
 *   - **左右镜像归一**：镜像局面也要命中，且镜像回来的候选在镜像局面里同样合法
 *     （镜像算错不会报错，只会让 AI「不动了」—— 引擎会静默丢掉非法着法，见 E9）
 *   - **归一后的键数**与索引规模一致：镜像归一会让互为镜像的局面合并，数目必须对得上
 *
 * 这是 `future-work.md` E10 那条教训的正面用法：数据有外部标准（象棋规则）时，
 * 一定要有一层**自己写的校验**钉住，不能只靠「看起来对」。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN, CELLS, EMPTY } = await load('config.js');
const { parseFen, toFen, indexOf, mirrorIdx, mirrorMove } = await load('position.js');
const { generateLegalMoves } = await load('rules.js');
const { moveOfIccs, iccsOfMove } = await load('iccs.js');
const {
  openingEntry, pickOpening, openingLines, openingLineCount, openingPositionCount,
  openingCanonicalFen, openingGeneratedCount,
} = await load('openings.js');
const { GENERATED_TREE } = await load('openings-generated.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

/** 与 openings.js 里那份一致的试走（库的数据可信，这里只为推进局面） */
function applyMove(pos, move) {
  const from = Math.floor(move / CELLS);
  const to = move % CELLS;
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = EMPTY;
  pos.side = -pos.side;
}

/** 固定种子的 xorshift32 —— 与 test-engine.mjs 用的是同一个套路 */
function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const { RED } = await load('config.js');
const lines = openingLines();

console.log(`开局库测试：${openingLineCount()} 条线 / ${openingPositionCount()} 个局面\n`);

// --- 1. ICCS 换算（与 solution-book.js 共用同一个实现） ---
{
  const m = moveOfIccs('b5b9');
  check('b5b9 → (1,4)->(1,0)', [Math.floor(m / 90), m % 90], [37, 1]);
  check('iccsOfMove 是 moveOfIccs 的逆运算', iccsOfMove(m), 'b5b9');
  check('起点定在红方底线（e0 → 格子 85 = x4,y9）', Math.floor(moveOfIccs('e0e0') / 90), 85);
}

// --- 2. 数据字段 ---
{
  const bad = lines.filter((l) => !l.name || !l.moves || !(l.weight > 0));
  check('每条线都有名字、着法、正权重', bad, []);
}

// --- 3. 逐条线重放：合法、在库、交替、候选全合法 ---
{
  const problems = [];
  const visited = new Set();

  for (const line of lines) {
    const pos = parseFen(START_FEN);
    const toks = line.moves.trim().split(/\s+/).filter(Boolean);

    if (toks.length === 0) { problems.push(`${line.name}：着法为空`); continue; }

    toks.forEach((tok, i) => {
      const where = `${line.name} 第 ${i + 1} 手 ${tok}`;
      if (pos.side !== (i % 2 === 0 ? RED : -RED)) problems.push(`${where}：走子方与手数不符`);

      const legal = generateLegalMoves(pos);
      const move = moveOfIccs(tok);
      if (!legal.includes(move)) { problems.push(`${where}：不是合法着法`); return; }

      const key = toFen(pos);
      visited.add(key);
      const entry = openingEntry(key);
      if (!entry) {
        problems.push(`${where}：这个局面不在库里`);
      } else {
        if (!entry.some((e) => e.move === move)) problems.push(`${where}：库里没有这一步`);
        // 转置合并进来的候选也必须是合法着法（这才说明索引没串）
        for (const e of entry) if (!legal.includes(e.move)) problems.push(`${where}：候选里有非法着法`);
      }

      applyMove(pos, move);
    });
  }

  check('每条线的每一步都合法、在库、走子方正确', problems, []);
  // 库的键 = 手写线的前缀局面 ∪ 生成谱的局面（两边都归一），一条不多一条不少
  const canonicalKeys = new Set([...visited].map((fen) => openingCanonicalFen(fen)));
  for (const [fen] of GENERATED_TREE) canonicalKeys.add(openingCanonicalFen(fen));
  check('索引里的局面数 = 手写前缀 ∪ 生成谱（归一后）',
    openingPositionCount(), canonicalKeys.size);
}

// --- 4. 起始局面：候选就是几个主流首着 ---
{
  const entry = openingEntry(START_FEN);
  const moves = new Set((entry || []).map((e) => e.move));

  check('起始局面在库里', moves.size > 0, true);
  check('候选包含 炮二平五（h2e2）', moves.has(moveOfIccs('h2e2')), true);
  check('候选包含 兵七进一（c3c4）', moves.has(moveOfIccs('c3c4')), true);
  check('候选包含 相三进五（g0e2）', moves.has(moveOfIccs('g0e2')), true);
  check('候选包含 马二进三（h0g2）', moves.has(moveOfIccs('h0g2')), true);
  check('候选里没有「炮八进七」那类开局乱走', moves.has(moveOfIccs('b2b9')), false);
}

// --- 5. 转置合并：两条线走到同一个局面时候选会合在一起 ---
{
  // 「中炮对屏风马」与「中炮对顺炮」都从 炮二平五 起步，第 1 手的局面是同一个，
  // 于是黑方的候选里应当同时有 马8进7（屏风马）和 炮8平5（顺炮）。
  const afterFirst = parseFen(START_FEN);
  applyMove(afterFirst, moveOfIccs('h2e2'));
  const entry = openingEntry(toFen(afterFirst));
  const s = new Set((entry || []).map((e) => e.move));

  check('第 1 手后的局面：黑方候选含 马8进7', s.has(moveOfIccs('h9g7')), true);
  check('第 1 手后的局面：黑方候选含 炮8平5（顺炮）', s.has(moveOfIccs('h7e7')), true);
  check('同一局面下多条线给出的着法并列成候选（转置合并）', (entry || []).length > 1, true);
}

// --- 6. 按权重随机挑 ---
{
  // 起始局面的权重：炮二平五 7（4 条线）> 其余三条各 1
  const rng = seededRng(20261004);
  const counts = new Map();
  for (let i = 0; i < 800; i++) {
    const move = pickOpening(START_FEN, rng);
    counts.set(move, (counts.get(move) || 0) + 1);
  }
  const entry = openingEntry(START_FEN);
  const inEntry = [...counts.keys()].every((m) => entry.some((e) => e.move === m));
  check('挑出来的着法永远是库里的候选', inEntry, true);
  check('走遍了所有候选（权重不为 0 的都会出现）', counts.size, entry.length);
  check('权重大的着法出现得更多（炮二平五 > 兵七进一）',
    counts.get(moveOfIccs('h2e2')) > counts.get(moveOfIccs('c3c4')), true);
}

// --- 7. 谱外：查不到就是查不到 ---
{
  const noBook = '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1';
  check('不在库里的局面返回 null', openingEntry(noBook), null);
  check('不在库里时挑不出着法（返回 0）', pickOpening(noBook, seededRng(1)), 0);

  // 走岔：第 1 手走一个库外的着法（兵九进一），之后的局面就不在库了
  const off = parseFen(START_FEN);
  applyMove(off, moveOfIccs('a3a4'));
  check('走了库外的着法之后，局面不在库里', openingEntry(toFen(off)), null);
}

// --- 8. FEN 规范化：尾部字段不影响查表 ---
{
  // 同一个局面，尾部写成 12 34 —— 键用的是 parseFen + toFen，所以照样命中
  const messy = START_FEN.replace('w - - 0 1', 'w - - 12 34');
  check('尾部字段不同的同一个局面也能命中', openingEntry(messy) !== null, true);
  check('规范化后的候选与标准写法一致',
    (openingEntry(messy) || []).map((e) => e.move),
    (openingEntry(START_FEN) || []).map((e) => e.move));
}

// --- 9. 左右镜像归一：从左边开局也能吃到右边的谱 ---
{
  // 炮二平五（h2e2，右）与 炮八平五（b2e2，左）互为镜像
  const afterRight = parseFen(START_FEN);
  applyMove(afterRight, moveOfIccs('h2e2'));
  const afterLeft = parseFen(START_FEN);
  applyMove(afterLeft, moveOfIccs('b2e2'));

  // 先单独钉住镜像本身 —— 这部分和库无关，错了后面全歪
  check('格子镜像 x → 8-x（b5 ↔ h5）', mirrorIdx(indexOf(1, 4)), indexOf(7, 4));
  check('中列是镜像不动点（e5）', mirrorIdx(indexOf(4, 4)), indexOf(4, 4));
  check('镜像是对合（两次回到自身）', mirrorIdx(mirrorIdx(indexOf(1, 4))), indexOf(1, 4));
  check('着法镜像：炮二平五 ↔ 炮八平五',
    mirrorMove(moveOfIccs('h2e2')), moveOfIccs('b2e2'));
  check('着法镜像：马8进7 ↔ 马2进3',
    mirrorMove(moveOfIccs('h9g7')), moveOfIccs('b9c7'));

  check('炮二平五 与 炮八平五 归一到同一个键',
    openingCanonicalFen(toFen(afterLeft)), openingCanonicalFen(toFen(afterRight)));

  const right = openingEntry(toFen(afterRight));
  const left = openingEntry(toFen(afterLeft));
  check('炮八平五 之后也能查到库（镜像归一）', left !== null, true);

  // 左侧候选 = 右侧候选逐个镜像（含权重），顺序不限
  const sig = (list) => list.map((e) => `${e.move}:${e.weight}`).sort().join(',');
  check('左侧候选 = 右侧候选逐个镜像',
    sig(left || []),
    sig((right || []).map((e) => ({ move: mirrorMove(e.move), weight: e.weight }))));

  // 镜像出来的候选必须在**左侧**局面里合法 —— 非法的会被引擎静默丢掉（E9）
  const legalLeft = generateLegalMoves(afterLeft);
  check('左侧候选全是左侧局面下的合法着法',
    (left || []).every((e) => legalLeft.includes(e.move)), true);

  // 按权重挑走的是同一条路，挑出来的必须是候选、且合法
  const rng = seededRng(20261005);
  const picks = new Set();
  for (let i = 0; i < 200; i++) picks.add(pickOpening(toFen(afterLeft), rng));
  check('左侧局面挑出来的着法都在候选里',
    [...picks].every((m) => (left || []).some((e) => e.move === m)), true);
  check('左侧局面挑出来的着法都合法', [...picks].every((m) => legalLeft.includes(m)), true);
  check('左侧局面能走遍所有候选', picks.size, (left || []).length);
}

// --- 10. 生成谱（js/openings-generated.js）：归一的、合法的、连通的 ---
{
  const badKey = []; const badLegal = []; const badEntry = []; const badWeight = [];
  const seen = new Set(); const dup = [];

  for (const [fen, moves] of GENERATED_TREE) {
    if (seen.has(fen)) dup.push(fen);
    seen.add(fen);
    // 生成器只在归一空间里展开，所以写出来必须已经是归一朝向（不是的话说明两处规则漂了）
    if (openingCanonicalFen(fen) !== fen) badKey.push(fen);
    const pos = parseFen(fen);
    const legal = new Set(generateLegalMoves(pos));
    const entry = openingEntry(fen);
    for (const [iccs, w] of moves) {
      const mv = moveOfIccs(iccs);
      if (!legal.has(mv)) badLegal.push(`${fen} ${iccs}`);
      if (!(entry || []).some((e) => e.move === mv)) badEntry.push(`${fen} ${iccs}`);
      if (!(Number.isInteger(w) && w > 0)) badWeight.push(`${fen} ${iccs} w=${w}`);
    }
  }

  check('生成谱非空（这才是「更多开局库」的兑现）', openingGeneratedCount() > 1000, true);
  check('生成谱每条记录的着法都合法（过本模块规则层）', badLegal.slice(0, 3), []);
  check('生成谱每个着法都能在库里查到（索引真的建了）', badEntry.slice(0, 3), []);
  check('生成谱的局面都是归一朝向', badKey.slice(0, 3), []);
  check('生成谱的权重都是正整数', badWeight.slice(0, 3), []);
  check('生成谱没有重复局面', dup.slice(0, 3), []);

  // 连通性：表里的每个局面都要能从标准开局**沿表里的着法**走到。
  // 平表（局面 → 候选）不带路径，所以只能这样自证：从根 BFS 一遍，走不到的条目就是孤立的。
  const keys = new Set(GENERATED_TREE.map(([fen]) => fen));
  const visitedG = new Set([openingCanonicalFen(START_FEN)]);
  const queue = [...visitedG];
  while (queue.length) {
    const fen = queue.shift();
    const entry = openingEntry(fen);
    if (!entry) continue;                      // 出了谱就停（谱外本来就没得走）
    for (const e of entry) {
      const child = parseFen(fen);
      applyMove(child, e.move);
      const ck = openingCanonicalFen(toFen(child));
      if (visitedG.has(ck)) continue;
      visitedG.add(ck);
      if (keys.has(ck)) queue.push(ck);
    }
  }
  const orphans = [...keys].filter((f) => !visitedG.has(f));
  check('生成谱里没有孤立局面（都能从标准开局走到）', orphans.slice(0, 3), []);
  check('生成谱的局面都真的进了索引',
    [...keys].every((f) => openingEntry(f) !== null), true);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
