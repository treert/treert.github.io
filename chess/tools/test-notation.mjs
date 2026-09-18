#!/usr/bin/env node
/**
 * SAN 记谱测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-notation.mjs
 *
 * 这一层是纯函数、规则又绕（消歧义三段式 + 升变 + 将军 / 将死后缀），
 * 所以用**固定局面 + 固定着法**逐个钉字符串。
 *
 * 最值得单独测的一条：**被牵制的同类棋子不参与消歧义** ——
 * 判据是「其它同类棋子能否**合法**走到同一目标格」，写成「有没有同类棋子」在实战里
 * 几乎看不出来（多一个字母而已），只有拿固定的反例才钉得住。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const Pos = await load('position.js');
const Ru = await load('rules.js');
const No = await load('notation.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail}`);
}

const at = (name) => Pos.squareOf(name);
const fen = (text) => Pos.parseFen(text);
const fromTo = (move) => `${Pos.squareName(Ru.moveFrom(move))}${Pos.squareName(Ru.moveTo(move))}`;

/** 在局面上找出「起点终点等于 uci」的那个合法着法；找不到直接报错 */
function mv(text, uci) {
  const pos = fen(text);
  const move = Ru.generateLegalMoves(pos).find((m) => fromTo(m) === uci);
  if (move === undefined) throw new Error(`局面里没有 ${uci} 这个合法着法：${text}`);
  return No.toSan(pos, move);
}

console.log('SAN 记谱测试\n');

// --- 棋子中文名 ---
{
  check('棋子中文名', [1, 2, 3, 4, 5, 6].map((p) => No.PIECE_NAMES[p]), ['兵', '马', '象', '车', '后', '王']);
}

// --- 基本功：棋子字母、目标格、吃子 ---
console.log('\n=== 基本形态 ===');
{
  check('马走到 f3 → Nf3',
    mv('4k3/8/8/8/8/8/8/4K1N1 w - - 0 1', 'g1f3'), 'Nf3');
  check('兵直进 → e4',
    mv('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4'), 'e4');
  check('马吃子 → Nxe5',
    mv('4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1', 'f3e5'), 'Nxe5');
  check('王走一步 → Kd2',
    mv('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1d2'), 'Kd2');
}

// --- 兵的吃子 ---
console.log('\n=== 兵吃子 ===');
{
  check('兵吃子写起始纵线 → exd5',
    mv('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4d5'), 'exd5');
  check('吃过路兵与普通吃子同一形态 → exd6',
    mv('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6'), 'exd6');

  // 两个兵都能吃到 d5 → 纵线天然区分，不需要额外消歧义
  const twin = '4k3/8/8/3p4/2P1P3/8/8/4K3 w - - 0 1';
  check('左边那个兵吃 → cxd5', mv(twin, 'c4d5'), 'cxd5');
  check('右边那个兵吃 → exd5', mv(twin, 'e4d5'), 'exd5');
}

// --- 易位 ---
console.log('\n=== 易位 ===');
{
  const open = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  check('短易位 → O-O', mv(open, 'e1g1'), 'O-O');
  check('长易位 → O-O-O', mv(open, 'e1c1'), 'O-O-O');
}

// --- 消歧义三段式 ---
console.log('\n=== 消歧义 ===');
{
  // 1. 两个马都能到 d2 → 加起始纵线
  const knights = '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1';
  check('两个马都能到 d2：b1 的那个 → Nbd2', mv(knights, 'b1d2'), 'Nbd2');
  check('两个马都能到 d2：f3 的那个 → Nfd2', mv(knights, 'f3d2'), 'Nfd2');

  // 2. 两个车同 file、都能到 e2 → 改加起始横行
  const rooks = '4R3/8/7k/8/8/8/8/K3R3 w - - 0 1';
  check('两个车同纵线：e1 的那个 → R1e2', mv(rooks, 'e1e2'), 'R1e2');
  check('两个车同纵线：e8 的那个 → R8e2', mv(rooks, 'e8e2'), 'R8e2');

  // 3. 三个后都能到 e1：h4 那个既要写纵线也要写横行
  const queens = '8/k7/8/8/4Q2Q/8/1K6/7Q w - - 0 1';
  check('三个后都能到 e1：h4 的那个 → Qh4e1', mv(queens, 'h4e1'), 'Qh4e1');
  check('（对照）e4 的那个只需写纵线 → Qee1', mv(queens, 'e4e1'), 'Qee1');
  check('（对照）h1 的那个只需写横行 → Q1e1', mv(queens, 'h1e1'), 'Q1e1');

  // **反例**：e2 的马被 e8 的车牵住，它走不了 c3，所以 d1 的马走 c3 不需要消歧义
  const pinned = 'k3r3/8/8/8/8/8/4N3/3NK3 w - - 0 1';
  check('被牵制的马不参与消歧义 → Nc3（不是 Ndc3）', mv(pinned, 'd1c3'), 'Nc3');
  check('那个被牵制的马一步都走不了',
    Ru.generateLegalMoves(fen(pinned)).filter((m) => Ru.moveFrom(m) === at('e2')).length, 0);
}

// --- 升变 ---
console.log('\n=== 升变 ===');
{
  const promote = '7k/4P3/8/8/8/8/8/K7 w - - 0 1';
  check('升变并将军 → e8=Q+', mv(promote, 'e7e8'), 'e8=Q+');

  // 升变成别的子不给将军 → 没有后缀
  const quiet = '7k/4P3/8/8/8/8/8/K7 w - - 0 1';
  const pos = fen(quiet);
  const knightPromo = Ru.generateLegalMoves(pos).find((m) => fromTo(m) === 'e7e8' && Ru.movePromo(m) === 2);
  check('升变成马且不给将军 → e8=N', No.toSan(pos, knightPromo), 'e8=N');

  // 吃子升变 → 写起始纵线 + =Q（a7 吃 b8）
  const capturePromo = '1n6/P7/8/8/8/8/8/K5k1 w - - 0 1';
  const pos2 = fen(capturePromo);
  const q = Ru.generateLegalMoves(pos2).find((m) => fromTo(m) === 'a7b8' && Ru.movePromo(m) === 5);
  check('吃子升变 → axb8=Q', No.toSan(pos2, q), 'axb8=Q');
}

// --- 将军 / 将死后缀 ---
console.log('\n=== 将军与将死 ===');
{
  check('一步将军 → Ra8+',
    mv('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8'), 'Ra8+');
  check('底线将死 → Ra8#',
    mv('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8'), 'Ra8#');
  check('走成逼和不加后缀 → Qb6',
    mv('k7/8/8/8/8/8/1Q6/K7 w - - 0 1', 'b2b6'), 'Qb6');

  // 逼和的那一步走完之后，对方确实无着法可走
  const staleFen = 'k7/8/8/8/8/8/1Q6/K7 w - - 0 1';
  const stalePos = fen(staleFen);
  const b6 = Ru.generateLegalMoves(stalePos).find((m) => fromTo(m) === 'b2b6');
  check('那一步之后是逼和', Ru.gameStatus(Ru.makeMove(stalePos, b6).pos).type, 'stalemate');
}

// --- 不要因为「有同类棋子」就乱加消歧义 ---
console.log('\n=== 不该消歧义的情形 ===');
{
  // 棋盘上有两个车，但只有一个能到 d7 → 不消歧义
  check('只有一个车能到 d7 → Rd7',
    (() => {
      const pos = fen('4k3/8/8/8/8/8/8/K2R3R w - - 0 1');
      const m = Ru.generateLegalMoves(pos).find((x) => fromTo(x) === 'd1d7');
      return No.toSan(pos, m);
    })(), 'Rd7');

  // 两个马都能到 d3 → 两边都只写纵线（写横行是多余的）
  const two = '4k3/8/8/8/8/8/8/K1N1N3 w - - 0 1';
  const san = (uci) => {
    const pos = fen(two);
    return No.toSan(pos, Ru.generateLegalMoves(pos).find((x) => fromTo(x) === uci));
  };
  check('两个马都能到 d3：c1 的那个 → Ncd3', san('c1d3'), 'Ncd3');
  check('两个马都能到 d3：e1 的那个 → Ned3', san('e1d3'), 'Ned3');
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
