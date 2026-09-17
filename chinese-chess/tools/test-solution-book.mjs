#!/usr/bin/env node
/**
 * 谱载解法（查表）测试。直接跑 Node —— 不需要浏览器、不需要装依赖、**不需要引擎**。
 *
 * 用法：node chinese-chess/tools/test-solution-book.mjs
 *
 * 盯四件事：
 *   1. **坐标定点**：`b5b9` ↔ `(1,4)→(1,0)` ↔ 中文记谱「前车进四」
 *      （与 test-notation.mjs 里那几条谱例锚点是同一批证据）。
 *   2. **每条解法的每一步都查得到** —— 「展开时算的局面签名」必须等于「按那条线走到
 *      该位置时的签名」。两个常量写混了（`y*9+x` 与 `y*90+x`）这里会全红，实测抓到过。
 *   3. **重复局面**：杀线里同一个局面反复出现是常态（马炮来回走），所以匹配必须带
 *      「谱上第几手」。只用「签名 → 着法」的 Map 会互相覆盖 —— 这一组就是钉它的。
 *   4. **走岔之后查不到** —— 界面据此回退引擎搜索。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { parseFen, toFen } = await load('position.js');
const { generateLegalMoves, moveFrom, moveTo } = await load('rules.js');
const { toNotation } = await load('notation.js');
const { ENDGAMES } = await load('endgames.js');
const { SOLUTIONS, SOLUTIONS_SOURCE } = await load('solutions.js');
const { buildBook, bookMove, moveOfIccs } = await load('solution-book.js');

const byId = new Map(ENDGAMES.map((e) => [e.id, e]));
const SAMPLE = 'shiqingyaqu-551-002';

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

/** 在局面上走一步（就地改；测试里够用，不关心哈希等增量状态） */
function play(pos, move) {
  pos.cells[moveTo(move)] = pos.cells[moveFrom(move)];
  pos.cells[moveFrom(move)] = 0;
  pos.side = -pos.side;
}

console.log(`谱载解法查表测试（数据生成自 ${SOLUTIONS_SOURCE}）\n`);

// --- 1. 坐标换算定点 ---
{
  const m = moveOfIccs('b5b9');
  check('b5b9 → (1,4)->(1,0)', [moveFrom(m), moveTo(m)], [37, 1]);

  const pos = parseFen(byId.get(SAMPLE).fen);
  check('谱例：b5b9 记作「前车进四」', toNotation(pos, m), '前车进四');

  // 走完这一手再看黑方的应着 —— 顺带验证黑方记谱方向（见 future-work.md E10）
  play(pos, m);
  check('谱例：e8d9（黑应）记作「士5退4」', toNotation(pos, moveOfIccs('e8d9')), '士5退4');
}

// --- 2. 每一条解法的每一步都查得到 ---
{
  const problems = [];
  let steps = 0;

  for (const [id, sol] of Object.entries(SOLUTIONS)) {
    const eg = byId.get(id);
    if (!eg) { problems.push(`${id}：endgames.js 里没有这一局`); continue; }

    const book = buildBook(eg.fen, sol.pv);
    const pos = parseFen(eg.fen);
    let ply = 0;

    for (const tok of sol.pv.trim().split(/\s+/)) {
      const got = bookMove(book, toFen(pos), ply);
      if (got !== moveOfIccs(tok)) {
        problems.push(`${id} 第 ${ply + 1} 手：查表得到 ${got}，期望 ${moveOfIccs(tok)}（${tok}）`);
        break;
      }
      steps++;
      play(pos, got);
      ply++;
    }
    if (generateLegalMoves(pos).length !== 0) problems.push(`${id}：走完整条线对方还有着法`);
  }

  check(`全部 ${Object.keys(SOLUTIONS).length} 条解法、共 ${steps} 手，逐步查到同一个着法`,
    problems.slice(0, 5), []);
}

// --- 3. 重复局面：同一个签名在不同位置可能对应不同的着法 ---
{
  // 先在数据里找一条「同一局面出现两次」的解法（杀线常态）
  let sample = null;
  for (const [id, sol] of Object.entries(SOLUTIONS)) {
    const eg = byId.get(id);
    const book = buildBook(eg.fen, sol.pv);
    const seen = new Map();
    for (let i = 0; i < book.before.length; i++) {
      const sig = book.before[i];
      if (seen.has(sig)) { sample = { id, first: seen.get(sig), again: i, book }; break; }
      seen.set(sig, i);
    }
    if (sample) break;
  }

  check('数据里确实有重复局面（所以匹配必须带「第几手」）', sample !== null, true);
  if (sample) {
    const a = sample.book.moves[sample.first];
    const b = sample.book.moves[sample.again];
    check(`同一局面出现在 ${sample.id} 的第 ${sample.first + 1} / ${sample.again + 1} 手，两处着法不同`,
      a !== b, true);
    // 按 ply 取，各自取到各自那一手（只用签名当键就会串）
    check('按「第几手」取，两处各取各的着法',
      [bookMove(sample.book, sample.book.before[sample.first], sample.first),
        bookMove(sample.book, sample.book.before[sample.again], sample.again)],
      [a, b]);
  }
}

// --- 4. 走岔之后查不到 ---
{
  const eg = byId.get(SAMPLE);
  const book = buildBook(eg.fen, SOLUTIONS[eg.id].pv);
  const pos = parseFen(eg.fen);

  const onBook = bookMove(book, toFen(pos), 0);
  check('开局（第 0 手）查得到', onBook !== 0, true);

  const offBook = generateLegalMoves(pos).find((m) => m !== onBook);
  play(pos, offBook);
  check('走了一步谱外的着法之后查不到（界面据此回退引擎搜索）',
    bookMove(book, toFen(pos), 1), 0);
}

// --- 5. 越界与空表 ---
check('没有解法（pv 为空）时一律查不到', bookMove(buildBook(byId.get(SAMPLE).fen, ''), 'x', 0), 0);
check('空表也稳', bookMove(null, 'x', 0), 0);
check('ply 越界返回 0', bookMove(buildBook(byId.get(SAMPLE).fen, SOLUTIONS[SAMPLE].pv), 'x', 999), 0);

// --- 6. 与对局状态机配合（main.js 就是这么查表的：`currentFen()` + `cursor`）---
//
// 这一组盯的是**两套口径是否一致**：谱表推进用的是 `toFen`，而状态机存下来的快照
// （`moves[i].fenAfter`）也必须是同一个 `toFen` —— 只要有一处换了口径，
// 界面上就永远查不到，而这种错在浏览器里看起来只是「提示没反应」。
{
  const G = await load('game.js');
  const g = G.createGame();
  check('能载入这一局', G.startEndgame(g, SAMPLE), true);

  const pv = SOLUTIONS[SAMPLE].pv.trim().split(/\s+/);
  const book = buildBook(g.initialFen, SOLUTIONS[SAMPLE].pv);

  let ply = 0;
  while (ply < pv.length) {
    const m = bookMove(book, G.currentFen(g), g.cursor);
    if (!m) { check(`第 ${ply + 1} 手查到谱载着法`, false, true); break; }
    if (!G.playMove(g, m).ok) { check(`第 ${ply + 1} 手被状态机接受`, false, true); break; }
    ply++;
  }
  check(`跟着谱走能走完整条线（${pv.length} 手）`, ply, pv.length);
  check('走完是「将死」', G.evaluateStatus(g).type, 'checkmate');

  // 悔棋 / 点着法列表跳转：游标只移动、局面回退到谱上的某一步，仍然查得到
  G.gotoPly(g, 3);
  check('跳回第 3 手后仍查得到谱载着法', bookMove(book, G.currentFen(g), g.cursor) !== 0, true);
  G.gotoPly(g, 0);
  check('跳回开局仍给出第 1 手的谱载着法',
    bookMove(book, G.currentFen(g), g.cursor), moveOfIccs(pv[0]));
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
