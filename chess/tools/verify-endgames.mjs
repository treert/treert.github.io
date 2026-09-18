#!/usr/bin/env node
/**
 * 残局库入库闸门。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/verify-endgames.mjs
 *
 * ## 它查什么
 *
 *   1. 字段规范：category 对应一个页签、result 在枚举内、difficulty 在 1~5、
 *      id 唯一、name / source 非空
 *   2. FEN 能解析、**往返一致**（toFen 生成的与原文相同，说明写法规范）
 *   3. 局面合法（王的数量、兵不在末排、两王不相邻、非轮走方不被将军、易位权与子对得上）
 *   4. 不是已经终局的局面（那样练习没有意义）
 *   5. **解法线逐步可走**：每一步都必须能在本模块的规则层里走通
 *      （UCI 是文本协议，升变 `e7e8q` 与易位 `e1g1` 最容易解析错 —— 错法很难靠肉眼看数据发现）
 *   6. 解法线**结束时确实达成 result**：本库只给「先手胜」的局配解法，
 *      线必须走到**将死**；线和 result 对不上直接判不合格
 *   7. 解法能**被谱表匹配上**（`solution-book.js` 逐手对签名）——
 *      这条钉的是「有解法但提示不给谱」那类静默失效
 *
 * ## 它刻意不查什么
 *
 * **不校验胜负结论。** 「先手胜 / 和棋」来自定式与精确杀棋搜索（见 js/endgames.js 头部），
 * 不是引擎「搜了很久看起来是赢」。要更强的保证就离线挂表库重跑（docs/stockfish.md）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { RESULTS, endgameTabs, allEndgames } = await load('endgames.js');
const { SOLUTIONS, SOLUTIONS_SOURCE } = await load('solutions.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');
const { buildBook, bookMove } = await load('solution-book.js');

const TABS = endgameTabs();
const TAB_IDS = new Set(TABS.map((t) => t.id));
const ENDGAMES = allEndgames();

let failed = 0;
const fail = (label, reason) => {
  failed++;
  console.log(`FAIL  ${label}\n        ${reason}`);
};

console.log(`残局库校验：共 ${ENDGAMES.length} 局`);
console.log(`解法来源：${SOLUTIONS_SOURCE}\n`);

// --- id 唯一 ---
{
  const seen = new Map();
  for (const eg of ENDGAMES) {
    if (seen.has(eg.id)) fail(eg.id, `id 与「${seen.get(eg.id)}」重复`);
    else seen.set(eg.id, eg.name);
  }
}

// --- 逐局 ---
const withSolution = [];
for (const eg of ENDGAMES) {
  const problems = [];

  if (!eg.name) problems.push('name 为空');
  if (!eg.source) problems.push('source 为空');
  if (!eg.note) problems.push('note 为空（每局都该写清楚为什么是这个结论）');
  if (!TAB_IDS.has(eg.category)) problems.push(`category「${eg.category}」不对应任何页签`);
  if (!(eg.result in RESULTS)) problems.push(`result「${eg.result}」不在枚举内`);
  if (!Number.isInteger(eg.difficulty) || eg.difficulty < 1 || eg.difficulty > 5) {
    problems.push(`difficulty「${eg.difficulty}」不在 1~5`);
  }
  if (!/^[a-z0-9-]+$/.test(eg.id)) problems.push(`id「${eg.id}」只该用小写字母、数字与连字符`);

  let pos = null;
  if (problems.length === 0) {
    try {
      pos = Pos.parseFen(eg.fen);
    } catch (e) {
      problems.push(`FEN 解析失败：${e.message}`);
    }
  }

  if (pos) {
    const round = Pos.toFen(pos);
    if (round !== eg.fen) problems.push(`FEN 写法不规范化，往返之后是「${round}」`);

    const legal = Ru.isLegalPosition(pos);
    if (!legal.ok) problems.push(`局面不合法：${legal.reason}`);

    if (Ru.generateLegalMoves(pos).length === 0) {
      problems.push('轮走方一步都走不了（已经终局的局面没有练习价值）');
    }

    // 库里的局面统一是「白先」——「先手胜」这套说法才立得住
    if (pos.side !== 1) problems.push('残局库的局面应当都是白方先走');
  }

  if (problems.length) {
    for (const p of problems) fail(`${eg.name}（${eg.id}）`, p);
    continue;
  }

  // --- 解法线 ---
  const sol = SOLUTIONS[eg.id];
  if (!sol) {
    if (eg.result === 'white') console.log(`  --  ${eg.name}：没有谱载解法（提示走引擎现算）`);
    continue;
  }
  withSolution.push(eg);

  if (eg.result !== 'white') {
    fail(`${eg.name}（${eg.id}）`, `谱载解法只配给「先手胜」的局，本局是「${RESULTS[eg.result]}」`);
    continue;
  }

  const tokens = sol.pv.split(/\s+/).filter(Boolean);
  if (tokens.length !== 2 * sol.mate - 1) {
    fail(`${eg.name}（${eg.id}）`, `mate=${sol.mate} 与 pv 长度 ${tokens.length} 对不上（应为 ${2 * sol.mate - 1}）`);
    continue;
  }

  let cur = pos;
  let broken = '';
  for (let i = 0; i < tokens.length; i++) {
    const legalMoves = Ru.generateLegalMoves(cur);
    const want = Ru.moveOfUci(tokens[i]);
    const move = want < 0 ? undefined : legalMoves.find((m) => m === want);
    if (!move) {
      broken = `第 ${i + 1} 手「${tokens[i]}」在这个局面里不是合法着法`
        + `（合法着法示例：${legalMoves.slice(0, 4).map(Ru.moveToUci).join(' ')}）`;
      break;
    }
    cur = Ru.makeMove(cur, move).pos;
  }

  if (broken) { fail(`${eg.name}（${eg.id}）`, broken); continue; }

  // 末局必须是**将死**，而且是被杀的是黑方（先手胜）
  const endMoves = Ru.generateLegalMoves(cur);
  if (endMoves.length !== 0 || !Ru.inCheck(cur.cells, cur.side)) {
    fail(`${eg.name}（${eg.id}）`, '解法线走完没有将死（末局还有着法或没被将军）');
    continue;
  }
  if (cur.side === 1) {
    fail(`${eg.name}（${eg.id}）`, '解法线把白方自己将死了（与「先手胜」矛盾）');
    continue;
  }

  // --- 谱表匹配：整条线每一手都要能查到 ---
  const book = buildBook(eg.fen, sol.pv);
  let bookBad = '';
  let walk = pos;
  for (let ply = 0; ply < tokens.length; ply++) {
    const fen = Pos.toFen(walk);
    const got = bookMove(book, fen, ply);
    if (!got) { bookBad = `第 ${ply + 1} 手谱表查不到（键：局 id + ply=${ply}）`; break; }
    if (Ru.moveToUci(got) !== tokens[ply]) {
      bookBad = `第 ${ply + 1} 手谱表给的是 ${Ru.moveToUci(got)}，数据里写的是 ${tokens[ply]}`;
      break;
    }
    walk = Ru.makeMove(walk, got).pos;
  }
  if (bookBad) { fail(`${eg.name}（${eg.id}）`, bookBad); continue; }

  console.log(`ok    ${eg.name}（${eg.id}）：${sol.mate} 步杀，${tokens.length} 个半层逐步可走`);
}

// --- 反向检查：解法不能指向不存在的局面 ---
for (const id of Object.keys(SOLUTIONS)) {
  if (!ENDGAMES.some((e) => e.id === id)) failed++, console.log(`FAIL  解法 ${id}：库里没有这一局`);
}

// --- 统计 ---
console.log('');
for (const tab of TABS) {
  console.log(`${tab.label}：${ENDGAMES.filter((e) => e.category === tab.id).length} 局`
    + `（有解法 ${withSolution.filter((e) => e.category === tab.id).length}）`);
}
const byResult = new Map();
for (const eg of ENDGAMES) byResult.set(eg.result, (byResult.get(eg.result) || 0) + 1);
console.log([...byResult].map(([r, n]) => `${RESULTS[r] || r} ${n} 局`).join('　'));

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
