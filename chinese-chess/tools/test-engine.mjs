#!/usr/bin/env node
/**
 * AI 层测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-engine.mjs
 *
 * 搜索本身依赖时间，不能断言「搜了多少节点」这类数字。
 * 这里测的是三类能稳定断言的东西：
 *   1. 哈希 / 评估这些纯函数的数值性质
 *   2. 引擎在「只有唯一正确着法」的局面里是否走对
 *   3. 引擎返回的着法是否合法（对随机局面抽查）
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, PIECE_OF_FEN, START_FEN } = await load('config.js');
const { indexOf, xOf, yOf, parseFen, startPosition, zobristKey, hashPiece, hashSide } =
  await load('position.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const idxOf = (coord) => {
  const [x, y] = coord.split(',').map(Number);
  return y * 9 + x;
};

const coordOf = (idx) => `${xOf(idx)},${yOf(idx)}`;

/** 用「棋子字符 @ x,y」的稀疏描述造局面 */
function build(specs, side = 'w') {
  const cells = new Int8Array(CELLS);
  for (const spec of specs) {
    const [ch, coord] = spec.split('@');
    const piece = PIECE_OF_FEN[ch];
    if (piece === undefined) throw new Error(`build: 无法识别的棋子「${ch}」`);
    cells[idxOf(coord)] = piece;
  }
  return { cells, side: side === 'w' ? 1 : -1 };
}

/** 固定种子的 xorshift32，给需要注入 rng 的测试用 */
function seededRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

console.log('AI 层测试\n');

// --- Zobrist 哈希 ---
{
  const start = startPosition();
  const key = zobristKey(start.cells, start.side);

  check('同一局面两次计算得到同一个哈希', zobristKey(start.cells, start.side), key);
  check('哈希是 32 位无符号整数', key >= 0 && key <= 0xFFFFFFFF, true);

  check('轮走方不同则哈希不同', zobristKey(start.cells, -1) === key, false);

  check('空位恒返回 0（走子 / 回退可以无条件异或）',
    [hashPiece(0, 0), hashPiece(0, 44), hashPiece(0, 89)], [0, 0, 0]);

  // 只动一个兵，哈希必须变
  {
    const moved = startPosition();
    const from = idxOf('4,6'), to = idxOf('4,5');
    moved.cells[to] = moved.cells[from];
    moved.cells[from] = 0;
    check('动一个兵则哈希改变', zobristKey(moved.cells, moved.side) === key, false);
  }

  // 位置敏感：同一个棋子放在不同格子，哈希必须不同
  {
    const a = build(['K@3,9', 'k@5,0', 'R@0,9']).cells;
    const b = build(['K@3,9', 'k@5,0', 'R@8,9']).cells;
    check('同一个车放在不同格子则哈希不同', zobristKey(a, 1) === zobristKey(b, 1), false);
  }

  // 交换两个不同的棋子：棋盘内容变了，哈希必须跟着变
  {
    const swapped = startPosition();
    const a = idxOf('0,9'), b = idxOf('1,9'); // 红车 <-> 红马
    const tmp = swapped.cells[a];
    swapped.cells[a] = swapped.cells[b];
    swapped.cells[b] = tmp;
    check('交换红车与红马则哈希改变', zobristKey(swapped.cells, swapped.side) === key, false);
  }

  // 反过来：交换两个完全相同的棋子，棋盘其实一模一样，哈希必须不变。
  // 这条容易凭直觉写成「交换了就该变」，值得正面钉住。
  {
    const swapped = startPosition();
    const a = idxOf('0,9'), b = idxOf('8,9'); // 两个红车，互换后棋盘没有任何区别
    const tmp = swapped.cells[a];
    swapped.cells[a] = swapped.cells[b];
    swapped.cells[b] = tmp;
    check('交换两个相同的车，棋盘没变，哈希也不变', zobristKey(swapped.cells, swapped.side), key);
  }

  // 增量语义：把一个子挪走再挪回来，哈希必须还原
  {
    const p = startPosition();
    const from = idxOf('4,6'), to = idxOf('4,5');
    const piece = p.cells[from];
    const before = zobristKey(p.cells, p.side);
    p.cells[to] = piece; p.cells[from] = 0;
    p.cells[from] = piece; p.cells[to] = 0;
    check('挪走再挪回，哈希还原', zobristKey(p.cells, p.side), before);
  }

  // 哈希不依赖遍历顺序：手工按任意顺序异或，结果必须一致
  {
    let manual = 0;
    for (let i = CELLS - 1; i >= 0; i--) manual = (manual ^ hashPiece(start.cells[i], i)) >>> 0;
    check('逆序异或得到同一个哈希', manual, key);
    check('再异或一次轮走方等于黑方视角的哈希',
      (manual ^ hashSide()) >>> 0, zobristKey(start.cells, -1));
  }
}

// --- 评估函数 ---
{
  const { evaluate } = await load('engine.js');

  check('起始局面完全对称，分值为 0', evaluate(startPosition().cells, 1), 0);
  check('起始局面黑方视角也是 0', evaluate(startPosition().cells, -1), 0);

  // 红方多一个车
  {
    const cells = build(['K@3,9', 'k@5,0', 'R@0,9']).cells;
    check('红方多一个车：红方视角 +900', evaluate(cells, 1), 900);
    check('红方多一个车：黑方视角 -900', evaluate(cells, -1), -900);
  }

  // 兵过河加分
  {
    const own = build(['K@3,9', 'k@5,0', 'P@4,6']).cells;
    const crossed = build(['K@3,9', 'k@5,0', 'P@4,4']).cells;
    check('红兵未过河记 100', evaluate(own, 1), 100);
    check('红兵过河记 150', evaluate(crossed, 1), 150);
  }

  // 黑卒过河同样加分（方向相反）
  {
    const own = build(['K@3,9', 'k@5,0', 'p@4,3']).cells;
    const crossed = build(['K@3,9', 'k@5,0', 'p@4,5']).cells;
    check('黑卒未过河记 100（黑方视角）', evaluate(own, -1), 100);
    check('黑卒过河记 150（黑方视角）', evaluate(crossed, -1), 150);
  }

  // 帅 / 将不计入子力：双方恒各有一个，算进去只会互相抵消
  {
    const cells = build(['K@3,9', 'k@5,0']).cells;
    check('只有两个将时分值为 0', evaluate(cells, 1), 0);
  }
}

// --- 搜索：negamax + alpha-beta ---
{
  const { Searcher, search } = await load('engine.js');
  const { generateLegalMoves } = await load('rules.js');

  // 深度 1、关掉一切随机性的固定挡位：只验搜索本身
  const plain = { id: 'test', name: '测试', depth: 1, timeLimitMs: 10000,
                  quiescence: false, noise: 0, blunderRate: 0 };

  // 一步杀：黑将 (3,0)；红车 (4,5) 封住逃路 (4,0)；红车 (0,9) 平到 (3,9) 沿纵线将军。
  //
  // 这条**不能断言「唯一杀着」** —— 这个局面里红方有好几个着法都能让黑方无路可走
  // （比如车 (4,5) 走到 (4,1) 造成困毙，而困毙在中国象棋里同样判黑方负）。
  // 断言「走完之后黑方一步都走不了」才是稳定的，而且正好测到了引擎该有的能力。
  //
  // 必须用 depth 2：depth <= 0 的节点直接返回静态评估、不生成着法，
  // 所以**深度 1 发现不了「对方没着法可走」**。这是设计文档 §7.1「不做将军延伸」
  // 的直接后果，不是 bug。（开了静态搜索的挡位例外：quiesce 在被将军时会搜全部着法。）
  {
    const fen = '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1';
    const r = search(fen, { ...plain, depth: 2 }, { rng: seededRng(1) });

    const after = parseFen(fen);
    after.cells[r.to] = after.cells[r.from];
    after.cells[r.from] = 0;
    after.side = -after.side;
    check('一步杀：走完之后黑方一步都走不了', generateLegalMoves(after).length, 0);
    check('一步杀：分值显示为必胜（远高于任何子力价值）', r.score > 90000, true);
  }

  // 吃白送的子：黑车 (4,4) 无人保护，红车 (4,9) 沿纵线 4 直接吃掉
  {
    const fen = '5k3/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1';
    const r = search(fen, plain, { rng: seededRng(1) });
    check('吃白送的子：红车吃掉黑车',
      [coordOf(r.from), coordOf(r.to)], ['4,9', '4,4']);
  }

  // 救子：黑马 (3,7) 盯着红车 (4,9)，而红车一步之内吃不到马（马不走直线），
  // 所以红方必须处理，否则丢一个车。需要 depth 2 才看得到对方的应手。
  //
  // 红帅特意放在 (5,9) —— 初稿把帅放在 (3,9)，结果帅走到 (3,8) 正好蹩住马腿，
  // 同样保住了车，于是「红车必须跑」这条断言就不成立了。
  // 写这类局面时要连带检查：**除了目标解法，还有没有别的着法能达到同样效果**。
  {
    const fen = '4k4/9/9/9/9/9/9/3n5/9/4RK3 w - - 0 1';
    const r = search(fen, { ...plain, depth: 2 }, { rng: seededRng(1) });
    check('被马盯上的红车必须先跑', coordOf(r.from), '4,9');
  }

  // 引擎返回的着法必须合法
  {
    const r = search(START_FEN, plain, { rng: seededRng(1) });
    const legal = new Set(generateLegalMoves(parseFen(START_FEN)));
    check('起始局面的返回着法合法', legal.has(r.move), true);
  }

  // 增量哈希与全量哈希必须一致 —— 走子 / 回退写错了会静默串味，
  // 表现为「引擎偶尔走出莫名其妙的着法」，非常难查，所以正面钉住。
  {
    const pos = startPosition();
    const s = new Searcher(pos.cells.slice(), pos.side, plain);
    const before = zobristKey(s.cells, s.side);
    check('构造时哈希与全量计算一致', s.key, before);

    const moves = generateLegalMoves({ cells: s.cells, side: s.side }).slice(0, 12);
    const undo = [];
    for (const m of moves) undo.push([m, s.make(m)]);
    check('连续走 12 步后，增量哈希仍与全量一致', s.key, zobristKey(s.cells, s.side));
    check('连走 12 步后轮走方翻转了 12 次', s.side, pos.side);

    for (let i = undo.length - 1; i >= 0; i--) s.unmake(undo[i][0], undo[i][1]);
    check('全部回退后哈希还原', s.key, before);
    check('全部回退后轮走方还原', s.side, pos.side);
    check('全部回退后棋盘还原', Array.from(s.cells), Array.from(pos.cells));
  }

  // 只有一个合法着法时必须返回它。
  // 局面：黑将 (4,0)，红车 (3,1) 同时封住 (3,0) 和 (4,1)，红帅 (3,9)，
  // 黑方只剩 (5,0) 可走。
  //
  // 这个局面对红帅的位置很敏感，改之前先想清楚：
  //   - 帅放 (4,9)：和黑将同处纵线 4，是照面，局面本身就不合法
  //   - 帅放 (5,9)：黑将走到 (5,0) 会和帅照面，于是黑方一步都走不了 —— 变成困毙，
  //                  search 返回 null，这条断言直接崩在「读 null 的 from」上
  //   - 帅放 (3,9) 才对：(3,0) 因照面非法、(4,1) 被车封死，只剩 (5,0)
  {
    const fen = '4k4/3R5/9/9/9/9/9/9/9/3K5 b - - 0 1';
    const r = search(fen, plain, { rng: seededRng(1) });
    check('黑方只剩一个着法时返回它', [coordOf(r.from), coordOf(r.to)], ['4,0', '5,0']);
  }

  // 已经终局的局面返回 null。
  // 局面：黑将 (3,0) 被红车 (3,5) 沿纵线将军，逃路 (4,0) 又被红车 (4,5) 封住。
  {
    const fen = '3k5/9/9/9/9/3RR4/9/9/9/4K4 b - - 0 1';
    const r = search(fen, { ...plain, depth: 3 }, { rng: seededRng(1) });
    check('无着法可走时返回 null', r, null);
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
