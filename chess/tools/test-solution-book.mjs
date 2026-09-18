#!/usr/bin/env node
/**
 * 谱表测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-solution-book.mjs
 *
 * 「有解法，但提示不给谱」这类故障**不会报错、界面上也看不出来**（提示悄悄退回引擎了）。
 * 两个地方最容易这样坏，下面各钉一条：
 *
 *   1. **匹配键必须带「第几手」**：杀线里重复局面是常态，只用局面签名当键，
 *      后一次会盖掉前一次，同一个局面就拿到另一处该走的着法。
 *   2. **展开时要跟着更新易位权与过路兵**：签名里含着这两项，不更新的话
 *      「走过车的线」和「刚推过两格兵的线」签名就对不上真实局面。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN } = await load('config.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');
const { buildBook, bookMove } = await load('solution-book.js');
const { SOLUTIONS } = await load('solutions.js');
const { allEndgames } = await load('endgames.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const uci = (move) => (move ? Ru.moveToUci(move) : '');
const sigAt = (fen) => Pos.positionSignature(Pos.parseFen(fen));
/** 判「是不是同一步」要按起点-终点-升变比：编码里还带着双步 / 易位 / 过路兵的标记位 */
const moveKey = (m) => `${Ru.moveFrom(m)}-${Ru.moveTo(m)}-${Ru.movePromo(m)}`;

/** 按 UCI 序列走一遍，返回每一步之后的 FEN 与签名（用规则层，保证和游戏同口径） */
function walk(fen, tokens) {
  let pos = Pos.parseFen(fen);
  const fens = [Pos.toFen(pos)];
  const sigs = [Pos.positionSignature(pos)];
  for (const tok of tokens) {
    const want = moveKey(Ru.moveOfUci(tok));
    const move = Ru.generateLegalMoves(pos).find((m) => moveKey(m) === want);
    if (!move) throw new Error(`走不通：${tok}`);
    pos = Ru.makeMove(pos, move).pos;
    fens.push(Pos.toFen(pos));
    sigs.push(Pos.positionSignature(pos));
  }
  return { fens, sigs };
}

console.log('谱表测试\n');

// === 展开 ===
console.log('=== 展开与查询 ===');
{
  const pv = 'g1f3 g8f6 f3g1 f6g8 b1c3';
  const tokens = pv.split(' ');
  const book = buildBook(START_FEN, pv);
  check('展开出 5 手', book.moves.length, 5);
  check('before 与 moves 等长', book.before.length, 5);

  const { sigs } = walk(START_FEN, tokens);
  check('before[i] = 走第 i 手之前的局面签名', book.before, sigs.slice(0, 5));
  check('第 0 手查到 g1f3', uci(bookMove(book, START_FEN, 0)), 'g1f3');

  // **关键**：第 4 手之前四个马都回到了原位，局面与开局**一模一样**，
  // 但谱上写的是另一步 —— 这正是「必须带 ply」的原因
  check('第 4 手之前的局面与开局相同', sigs[4], sigAt(START_FEN));
  check('同一个局面在第 4 手给出的是另一步', uci(bookMove(book, START_FEN, 4)), 'b1c3');
  check('（对照）不带 ply 只用局面的话，两者会撞在一起',
    book.before.indexOf(sigs[4]) !== book.before.lastIndexOf(sigs[4]), true);

  check('越界的 ply 返回 0', [bookMove(book, START_FEN, -1), bookMove(book, START_FEN, 5),
    bookMove(book, START_FEN, 99)], [0, 0, 0]);
  check('局面对不上返回 0',
    bookMove(book, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', 0), 0);
  check('没有谱表时返回 0', [bookMove(null, START_FEN, 0), bookMove(undefined, START_FEN, 0)], [0, 0]);
}

// === 易位权与过路兵要跟着更新 ===
console.log('\n=== 展开时要跟着更新易位权 / 过路兵 ===');
{
  // 白方短易位那一步之前的签名必须和真实局面（走过车、易位权已经变了）一致
  const castlePv = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1';
  const castle = castlePv.split(' ');
  const castleBook = buildBook(START_FEN, castlePv);
  const castleWalk = walk(START_FEN, castle);
  check('易位线：每一步的签名都对得上', castleBook.before, castleWalk.sigs.slice(0, castle.length));
  check('易位那一步之前白方还有短易位权',
    Pos.parseFen(castleWalk.fens[8]).castling & 1, 1);
  check('易位之后白方易位权用掉了', Pos.parseFen(castleWalk.fens[9]).castling & 1, 0);

  // 吃过路兵：黑方刚双步推兵，局面里有 d6 这个过路兵目标格
  const epPv = 'e2e4 g8f6 e4e5 d7d5 e5d6';
  const ep = epPv.split(' ');
  const epBook = buildBook(START_FEN, epPv);
  const epWalk = walk(START_FEN, ep);
  check('吃过路兵线：每一步的签名都对得上', epBook.before, epWalk.sigs.slice(0, ep.length));
  check('黑方双步推兵之后留下了过路兵目标格',
    Pos.parseFen(epWalk.fens[4]).ep, Pos.squareOf('d6'));
  check('谱上也记着这一步能吃', uci(bookMove(epBook, epWalk.fens[4], 4)), 'e5d6');
}

// === 坏数据不许抛 ===
console.log('\n=== 坏数据与边界 ===');
{
  check('空 pv 得到空谱表',
    (() => { const b = buildBook(START_FEN, ''); return [b.moves.length, b.before.length]; })(),
    [0, 0]);
  check('没有 pv 得到空谱表',
    (() => { const b = buildBook(START_FEN, null); return [b.moves.length, b.before.length]; })(),
    [0, 0]);
  check('UCI 读不动时整条作废',
    (() => { const b = buildBook(START_FEN, 'e2e4 zzzz e7e5'); return b.moves.length; })(), 1);
  // 走不通的着法会让整条线作废（宁可回退引擎，也不拿半条线给出错的提示）。
  // 数据本身该在入库时就被 verify-endgames.mjs 挡住。
  check('非法着法让整条线作废',
    (() => { const b = buildBook(START_FEN, 'e2e5 e7e5'); return b.moves.length; })(), 0);
  check('局面解析不了时返回空谱表',
    (() => {
      try { return buildBook('这不是 FEN', 'e2e4').moves.length; } catch { return 'threw'; }
    })(), 0);
  check('展开出来的着法带着标记位（双步前进）',
    (() => { const b = buildBook(START_FEN, 'e2e4'); return Ru.moveFlag(b.moves[0]); })(),
    Ru.FLAG_DOUBLE);
}

// === 真实数据 ===
console.log('\n=== 真实解法数据 ===');
{
  const entries = allEndgames();
  let ok = 0;
  let bad = 0;
  for (const [id, sol] of Object.entries(SOLUTIONS)) {
    const eg = entries.find((e) => e.id === id);
    if (!eg) { bad++; continue; }
    const tokens = sol.pv.split(' ');
    const book = buildBook(eg.fen, sol.pv);
    const { fens } = walk(eg.fen, tokens);
    let good = book.moves.length === tokens.length;
    for (let ply = 0; ply < tokens.length && good; ply++) {
      if (uci(bookMove(book, fens[ply], ply)) !== tokens[ply]) good = false;
    }
    if (good) ok++; else bad++;
  }
  check(`全部 ${Object.keys(SOLUTIONS).length} 条解法都能逐手查到`, [ok, bad],
    [Object.keys(SOLUTIONS).length, 0]);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
