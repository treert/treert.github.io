#!/usr/bin/env node
/**
 * 谱载解法（查表）测试。直接跑 Node —— 不需要浏览器、不需要装依赖、**不需要引擎**。
 *
 * 用法：node chinese-chess/tools/test-solution-book.mjs
 *
 * 盯这些事：
 *   1. **坐标定点**：`b5b9` ↔ `(1,4)→(1,0)` ↔ 中文记谱「前车进四」
 *      （与 test-notation.mjs 里那几条谱例锚点是同一批证据）。
 *   2. **每条线的每一步都查得到** —— 把谱逐步喂回去，每一步都要取到自己那一手
 *      （这一组同时兜住坐标常量写混：`y*9+x` 与 `y*90+x` 错了这里会全红，实测抓到过）。
 *      **`src='walk'` 那 34 条也一起走**：它们同样要以「末局对方一步都走不出」收场。
 *   3. **重复局面**：杀线里同一个局面反复出现是常态（马炮来回走），而两处要走向**不同**的
 *      着法 —— 所以匹配必须**逐手比前缀**（只按「当前局面」查会串）。这一组就是钉它的。
 *   4. **走岔之后查不到** —— 界面据此回退引擎搜索。
 *   5~6. 越界 / 空表，以及与对局状态机的口径一致（`game.moves[i].move` 与谱同一套编码）。
 *   7. **可信度分级与措辞**（`lineOf` / `lineLabel`）：`src='mate'` 说「有解法」，
 *      `src='walk'` 必须说「参考线、未经证明」；引擎认为红方不行的局（反杀那几局）不给线。
 *      措辞写错 = 把没证明的东西说成正解，比没有解法更糟 —— 所以要有断言钉住。
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

    const book = buildBook(sol.pv);
    const pos = parseFen(eg.fen);
    const played = [];
    let ply = 0;

    for (const tok of sol.pv.trim().split(/\s+/)) {
      const got = bookMove(book, played, ply);
      if (got !== moveOfIccs(tok)) {
        problems.push(`${id} 第 ${ply + 1} 手：查表得到 ${got}，期望 ${moveOfIccs(tok)}（${tok}）`);
        break;
      }
      steps++;
      played.push(got);
      play(pos, got);
      ply++;
    }
    if (generateLegalMoves(pos).length !== 0) problems.push(`${id}：走完整条线对方还有着法`);
  }

  check(`全部 ${Object.keys(SOLUTIONS).length} 条解法、共 ${steps} 手，逐步查到同一个着法`,
    problems.slice(0, 5), []);
}

// --- 3. 重复局面：同一个局面在不同位置对应不同的着法 ---
{
  // 先在数据里找一条「同一局面出现两次」的解法（杀线常态）
  let sample = null;
  for (const [id, sol] of Object.entries(SOLUTIONS)) {
    const pos = parseFen(byId.get(id).fen);
    const book = buildBook(sol.pv);
    const seen = new Map(); // 局面（FEN 文本）→ 第几手
    for (let i = 0; i < book.moves.length; i++) {
      const key = toFen(pos);
      if (seen.has(key)) { sample = { id, first: seen.get(key), again: i, book }; break; }
      seen.set(key, i);
      play(pos, book.moves[i]);
    }
    if (sample) break;
  }

  check('数据里确实有重复局面（所以只按「当前局面」查会串）', sample !== null, true);
  if (sample) {
    const a = sample.book.moves[sample.first];
    const b = sample.book.moves[sample.again];
    check(`同一局面出现在 ${sample.id} 的第 ${sample.first + 1} / ${sample.again + 1} 手，两处着法不同`,
      a !== b, true);
    // 两处的「已走着法」前缀不同（一个长一个短）→ 各自取到各自那一手
    check('逐手比前缀，两处各取各的着法',
      [bookMove(sample.book, sample.book.moves.slice(0, sample.first), sample.first),
        bookMove(sample.book, sample.book.moves.slice(0, sample.again), sample.again)],
      [a, b]);
  }
}

// --- 4. 走岔之后查不到 ---
{
  const eg = byId.get(SAMPLE);
  const book = buildBook(SOLUTIONS[eg.id].pv);
  const pos = parseFen(eg.fen);

  const onBook = bookMove(book, [], 0);
  check('开局（第 0 手）查得到', onBook !== 0, true);

  const offBook = generateLegalMoves(pos).find((m) => m !== onBook);
  check('走了一步谱外的着法之后查不到（界面据此回退引擎搜索）',
    bookMove(book, [offBook], 1), 0);

  // 前缀是**整段**都要对：第 2 手岔了，第 3 手就算正好和谱一样也不认
  // （对手变着之后正是这种情况 —— 红方的下一手只对谱上那个局面成立）
  check('前缀断在中间，后面那手也不认',
    bookMove(book, [onBook, offBook, book.moves[2]], 3), 0);
}

// --- 5. 越界与空表 ---
check('没有谱（pv 为空）时一律查不到', bookMove(buildBook(''), [], 0), 0);
check('空表也稳', bookMove(null, [], 0), 0);
check('ply 越界返回 0', bookMove(buildBook(SOLUTIONS[SAMPLE].pv), [], 999), 0);
check('已走着法比 ply 短时也查不到（宁可回退引擎，不能给错的着法）',
  bookMove(buildBook(SOLUTIONS[SAMPLE].pv), [], 1), 0);

// --- 6. 与对局状态机配合（main.js 就是这么查表的：`moves[i].move` + `cursor`）---
//
// 这一组盯的是**两套编码是否一致**：谱表给的是 ICCS 换算出来的着法编码，而状态机存下来的
// （`moves[i].move`）必须是同一个 —— 只要有一处换了口径，界面上就永远查不到，
// 而这种错在浏览器里看起来只是「提示没反应」。
{
  const G = await load('game.js');
  const g = G.createGame();
  check('能载入这一局', G.startEndgame(g, SAMPLE), true);

  const pv = SOLUTIONS[SAMPLE].pv.trim().split(/\s+/);
  const book = buildBook(SOLUTIONS[SAMPLE].pv);
  const played = () => G.moveList(g).map((m) => m.move);

  let ply = 0;
  while (ply < pv.length) {
    const m = bookMove(book, played(), g.cursor);
    if (!m) { check(`第 ${ply + 1} 手查到谱载着法`, false, true); break; }
    if (!G.playMove(g, m).ok) { check(`第 ${ply + 1} 手被状态机接受`, false, true); break; }
    ply++;
  }
  check(`跟着谱走能走完整条线（${pv.length} 手）`, ply, pv.length);
  check('走完是「将死」', G.evaluateStatus(g).type, 'checkmate');

  // 悔棋 / 点着法列表跳转：游标只移动、前缀跟着变短，仍然查得到
  G.gotoPly(g, 3);
  check('跳回第 3 手后仍查得到谱载着法', bookMove(book, played(), g.cursor) !== 0, true);
  G.gotoPly(g, 0);
  check('跳回开局仍给出第 1 手的谱载着法',
    bookMove(book, played(), g.cursor), moveOfIccs(pv[0]));
}

// --- 7. 「这一局有什么线」与措辞（`src` 决定，见 solution-book.js 的 lineOf）---
//
// 这一组钉的是**可信度分级**：`src='mate'` 是引擎在根上证明了的强制杀，
// `src='walk'` 只是「引擎走到底能杀」或「一段首选前缀」—— 前段没有证明。
// 两者在界面上必须是不同的字（措辞写错 = 把没证明的东西说成正解，比没有解法更糟）。
{
  const { PREFIXES } = await load('prefixes.js');
  const { lineOf: line, lineLabel: label } = await load('solution-book.js');

  // (a) 已证明的杀线
  const mateLine = line(SAMPLE);
  check('第002局：来源是 mate', mateLine && mateLine.src, 'mate');
  check('第002局：措辞是「有解法」', label(mateLine).startsWith('有解法（'), true);

  // (b) 走成完整线、但前段没有证明的那批（solutions.js 里的 src='walk'）
  const walkIds = Object.keys(SOLUTIONS).filter((id) => SOLUTIONS[id].src === 'walk');
  check('数据里确实有 src=walk 的线（否则这一组是空转）', walkIds.length > 0, true);
  if (walkIds.length) {
    const w = line(walkIds[0]);
    check(`walk 线（${walkIds[0]}）的来源是 walk、且带 mate`, [w.src, w.mate > 0], ['walk', true]);
    check('walk 线的措辞里必须有「参考线」和「未经证明」',
      [label(w).includes('参考线'), label(w).includes('未经证明')], [true, true]);
    check('walk 线的措辞里**不能**出现「有解法」', label(w).includes('有解法'), false);
  }

  // (c) 只有前缀、没走成杀的局（prefixes.js）
  const prefIds = Object.keys(PREFIXES).filter((id) => !PREFIXES[id].mate);
  check('数据里确实有「只有前缀」的局', prefIds.length > 0, true);
  if (prefIds.length) {
    const p = line(prefIds[0]);
    check(`只有前缀的局（${prefIds[0]}）：src=walk、mate 为空`, [p.src, p.mate], ['walk', null]);
    check('只有前缀的措辞里写着「非证明」', label(p).includes('非证明'), true);
  }

  // (d) **不让用户跟着输棋**：引擎认为红方不行的局（A 组「反杀」）不该给线。
  // 这批在 `prefix-scan.mjs emit` 里按「第一步的红方优势 < 0」筛掉，这里从数据侧再钉一遍。
  // 举例换成第 190 局：原来拿来举例的第 020 局 2026-09 查出上游 FEN 漏了一枚一路兵，
  // 已修正（引擎不再判红方被杀），见 `js/endgames.js` 头部第 4 条。
  check('反杀的第190局不给线（跟着走等于教人怎么输）', line('shiqingyaqu-551-190'), null);
  const badFirst = Object.entries(PREFIXES).filter(([, p]) => {
    const first = (p.scores || '').trim().split(/\s+/)[0] || '';
    if (first.startsWith('cp')) return Number(first.slice(2)) < 0;
    if (first.startsWith('mate')) return Number(first.slice(4)) < 0; // 轮走方（红）被杀
    return false;
  }).map(([id]) => id);
  check('prefixes.js 里没有「开局就判红方下风」的局', badFirst, []);

  // (e) 没有线的局
  check('自定义 / 未知 id 一律返回 null', [line('no-such-id'), line('')], [null, null]);
  check('lineLabel(null) 是空串', label(null), '');
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
