#!/usr/bin/env node
/**
 * 局面层测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-position.mjs
 *
 * 这一层是纯函数，所以能把边界都钉住：FEN 往返互逆、少写字段的容错、
 * 空 / 满局面的边界、签名的判等口径、Zobrist 的确定性。
 * **Zobrist 必须跨会话稳定**（固定种子），否则存档、复现、置换表全都不可比。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { FILES, CELLS, START_FEN, WHITE, BLACK } = await load('config.js');
const P = await load('position.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

function throws(name, fn) {
  let ok = false;
  let message = '';
  try {
    fn();
  } catch (e) {
    ok = true;
    message = e.message;
  }
  check(`${name}（抛错）`, ok, true);
  if (ok) console.log(`      ↳ ${message}`);
}

console.log('局面层测试\n');

// --- 坐标换算 ---
{
  check('index / fileOf / rankOf 互逆',
    [0, 7, 8, 27, 36, 63].map((i) => P.index(P.fileOf(i), P.rankOf(i))),
    [0, 7, 8, 27, 36, 63]);
  check('a1 = 0，h8 = 63', [P.index(0, 0), P.index(7, 7)], [0, 63]);
  check('e4 = 28', P.index(4, 3), 28);
  check('squareName(a1/h8/e4)', [P.squareName(0), P.squareName(63), P.squareName(28)], ['a1', 'h8', 'e4']);
  check('squareOf 往返', [P.squareOf('a1'), P.squareOf('e4'), P.squareOf('h8')],
    [P.index(0, 0), P.index(4, 3), P.index(7, 7)]);
  check('squareOf 遇到坏坐标返回 -1',
    [P.squareOf('i1'), P.squareOf('a9'), P.squareOf('a'), P.squareOf(null)],
    [-1, -1, -1, -1]);
  check('onBoard 判边界',
    [P.onBoard(0, 0), P.onBoard(7, 7), P.onBoard(8, 0), P.onBoard(0, 8)],
    [true, true, false, false]);
}

// --- FEN 往返 ---
{
  check('起始局面往返一致', P.toFen(P.parseFen(START_FEN)), START_FEN);

  const start = P.parseFen(START_FEN);
  check('起始局面：白方 16 子', start.cells.filter((v) => v > 0).length, 16);
  check('起始局面：黑方 16 子', start.cells.filter((v) => v < 0).length, 16);
  check('起始局面：轮走白', start.side, WHITE);
  check('起始局面：易位权全在', start.castling, 15);
  check('起始局面：没有过路兵', start.ep, -1);
  check('起始局面：a1 是白车', start.cells[P.index(0, 0)], 4);
  check('起始局面：e1 是白王', start.cells[P.index(4, 0)], 6);
  check('起始局面：e8 是黑王', start.cells[P.index(4, 7)], -6);

  const empty = '8/8/8/8/8/8/8/8 w - - 0 1';
  check('空局面往返一致', P.toFen(P.parseFen(empty)), empty);
  check('空局面 64 格全空', P.parseFen(empty).cells.every((v) => v === 0), true);

  const epFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  check('带过路兵的局面往返一致', P.toFen(P.parseFen(epFen)), epFen);
  check('过路兵目标格解析成 e3', P.parseFen(epFen).ep, P.squareOf('e3'));

  const noCastle = '8/8/8/8/8/8/8/4K3 w - - 0 1';
  check('没有易位权时输出 `-`', P.toFen(P.parseFen(noCastle)), noCastle);

  // 满局面：64 个格子塞满（不是合法对局，只是解析层的边界）
  const full = 'rnbqkbnr/pppppppp/PPPPPPPP/NNNNNNNN/BBBBBBBB/RRRRRRRR/QQQQQQQQ/KKKKKKKK w - - 0 1';
  check('满局面也能解析（64 格）', P.parseFen(full).cells.every((v) => v !== 0), true);
  check('满局面往返一致', P.toFen(P.parseFen(full)), full);
}

// --- 少写字段的容错 ---
{
  const four = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  const p4 = P.parseFen(four);
  check('只写四段：半步计数补 0', p4.halfmove, 0);
  check('只写四段：回合数补 1', p4.fullmove, 1);
  check('只写四段：补完之后就是标准 FEN', P.toFen(p4), START_FEN);

  const two = '8/8/8/8/8/8/8/8 b';
  const p2 = P.parseFen(two);
  check('只写两段：轮走方仍生效', p2.side, BLACK);
  check('只写两段：易位权补 0', p2.castling, 0);
  check('只写两段：过路兵补 -1', p2.ep, -1);
  check('只写两段：补全后是 6 段', P.toFen(p2), '8/8/8/8/8/8/8/8 b - - 0 1');

  check('多余空白不影响', P.normalizeFen(`  ${START_FEN}  `), START_FEN);
  check('乱写的尾部被规范化',
    P.normalizeFen('8/8/8/8/8/8/8/8 w - - 12 34'), '8/8/8/8/8/8/8/8 w - - 12 34');
  check('半步计数写坏时退回 0', P.parseFen('8/8/8/8/8/8/8/8 w - - x 3').halfmove, 0);
  check('回合数写 0 时退回 1', P.parseFen('8/8/8/8/8/8/8/8 w - - 0 0').fullmove, 1);
}

// --- 解析失败要带原因 ---
{
  throws('只有一段', () => P.parseFen('8/8/8/8/8/8/8/8'));
  throws('行数只有 7 行', () => P.parseFen('8/8/8/8/8/8/8 w - - 0 1'));
  throws('某行多出格子', () => P.parseFen('8/8/8/8/8/8/8/9 w - - 0 1'));
  throws('某行格子不够', () => P.parseFen('7/8/8/8/8/8/8/8 w - - 0 1'));
  throws('无法识别的棋子字符', () => P.parseFen('8/8/8/8/8/8/8/x7 w - - 0 1'));
  throws('轮走方写成 x', () => P.parseFen('8/8/8/8/8/8/8/8 x - - 0 1'));
  throws('易位权里乱写', () => P.parseFen('8/8/8/8/8/8/8/8 w KZ - 0 1'));
  throws('过路兵目标格越界', () => P.parseFen('8/8/8/8/8/8/8/8 w - i3 0 1'));
  throws('过路兵目标格不是坐标', () => P.parseFen('8/8/8/8/8/8/8/8 w - e 0 1'));
}

// --- 拷贝是深拷贝 ---
{
  const a = P.startPosition();
  const b = P.clonePosition(a);
  b.cells[0] = 0;
  b.side = BLACK;
  b.castling = 0;
  check('clonePosition 改副本不动原局面',
    [a.cells[0], a.side, a.castling], [4, WHITE, 15]);

  check('startPosition 每次都是新的', P.startPosition().cells !== P.startPosition().cells, true);
}

// --- 局面签名（三次重复的判等口径）---
{
  const a = P.parseFen(START_FEN);
  // 同一个棋盘、同一个轮走方、同样的易位权与过路兵，只是计数不同
  const b = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42');
  check('同局面不同步数 → 签名相等', P.positionSignature(a), P.positionSignature(b));

  const c = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  check('轮走方不同 → 签名不同', P.positionSignature(a) === P.positionSignature(c), false);

  const d = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1');
  check('少一条易位权 → 签名不同', P.positionSignature(a) === P.positionSignature(d), false);

  const e = P.parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  const f = P.parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  check('过路兵机会不同 → 签名不同', P.positionSignature(e) === P.positionSignature(f), false);
}

// --- Zobrist ---
{
  const a = P.parseFen(START_FEN);
  const b = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 99');
  check('哈希不含步数计数', P.zobristKey(a), P.zobristKey(b));

  // 确定性：同一个进程里反复算必须一样（跨会话靠固定种子保证）
  check('哈希是确定性的', P.zobristKey(a), P.zobristKey(P.parseFen(START_FEN)));

  const c = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  check('轮走方不同 → 哈希不同', P.zobristKey(a) === P.zobristKey(c), false);

  const d = P.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kkq - 0 1');
  check('易位权不同 → 哈希不同', P.zobristKey(a) === P.zobristKey(d), false);

  const e = P.parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  const f = P.parseFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  check('过路兵不同 → 哈希不同', P.zobristKey(e) === P.zobristKey(f), false);

  // 增量哈希要能对上全量：这里先钉「单步异或」的恒等式，引擎里再逐节点比
  const from = P.index(4, 1), to = P.index(4, 3); // e2 -> e4
  const a2 = P.clonePosition(a);
  const piece = a2.cells[from];
  const incremental = (P.zobristKey(a)
    ^ P.hashPiece(piece, from) ^ P.hashPiece(piece, to)
    ^ P.hashSide() ^ P.hashCastle(a.castling) ^ P.hashCastle(a.castling)
    ^ P.hashEp(a.ep) ^ P.hashEp(P.squareOf('e3'))) >>> 0;
  const manual = P.clonePosition(a);
  manual.cells[to] = manual.cells[from];
  manual.cells[from] = 0;
  manual.side = BLACK;
  manual.ep = P.squareOf('e3');
  check('单步异或 = 全量重算', incremental, P.zobristKey(manual));

  check('hashPiece(EMPTY) 恒为 0', P.hashPiece(0, 27), 0);
  check('hashEp(-1) 为 0', P.hashEp(-1), 0);
}

// --- 常量自洽 ---
{
  check('CELLS = FILES * RANKS', CELLS, FILES * 8);
  check('startPosition 与 START_FEN 一致', P.toFen(P.startPosition()), START_FEN);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
