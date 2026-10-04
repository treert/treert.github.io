#!/usr/bin/env node
/**
 * 开局库测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-openings.mjs
 *
 * ## 重点不是「查表能不能查到」，而是**数据有没有写错**
 *
 * 开局库是**手写的数据**（`js/openings.js` 的 `LINES`），而手写着法最容易出的三种错
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
 * 这是 `future-work.md` E10 那条教训的正面用法：数据有外部标准（象棋规则）时，
 * 一定要有一层**自己写的校验**钉住，不能只靠「看起来对」。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN, CELLS, EMPTY } = await load('config.js');
const { parseFen, toFen } = await load('position.js');
const { generateLegalMoves } = await load('rules.js');
const { moveOfIccs, iccsOfMove } = await load('iccs.js');
const {
  openingEntry, pickOpening, openingLines, openingLineCount, openingPositionCount,
} = await load('openings.js');

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
  // 库的键 = 所有线的所有前缀局面（含标准开局本身），一条不多一条不少
  check('索引里的局面数 = 所有线的前缀局面数', openingPositionCount(), visited.size);
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

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
