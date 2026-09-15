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
  // 所以**深度 1 发现不了「对方没着法可走」**。这个挡位没开将军延伸
  // （checkExtension 没写 = 0），所以它是这个样子的，不是 bug。
  // （开了静态搜索的挡位例外：quiesce 在被将军时会搜全部着法。）
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

// --- 置换表与着法排序 ---
{
  const { Searcher, search } = await load('engine.js');
  const { generateMoves, moveTo } = await load('rules.js');

  const base = { id: 'test', name: '测试', depth: 4, timeLimitMs: 60000,
                 quiescence: false, noise: 0, blunderRate: 0 };

  // 置换表不能改变搜索结果，只能省节点
  {
    const a = search(START_FEN, { ...base, useTT: false }, { rng: seededRng(7) });
    const b = search(START_FEN, { ...base, useTT: true }, { rng: seededRng(7) });
    check('开启置换表后最优着法不变', b.move, a.move);
    check('开启置换表后分值不变', b.score, a.score);
    check('开启置换表后访问的节点不增加', b.nodes <= a.nodes, true);
  }

  // 着法排序：吃子必须排在非吃子前面
  {
    const pos = parseFen('4k4/9/9/9/4r4/9/9/9/9/3KR4 w - - 0 1');
    const s = new Searcher(pos.cells.slice(), pos.side, base);
    const ordered = s.orderMoves(generateMoves(s.cells, s.side), 0, 0);
    const isCapture = ordered.map((m) => s.cells[moveTo(m)] !== 0);
    const lastCapture = isCapture.lastIndexOf(true);
    const firstQuiet = isCapture.indexOf(false);
    check('这个局面里红方确实有吃子可走', lastCapture >= 0, true);
    check('所有吃子都排在非吃子之前', lastCapture < firstQuiet, true);
  }

  // 置换表命中率：连搜两次同一局面，第二次的节点数应明显更少
  {
    const s = new Searcher(parseFen(START_FEN).cells, 1, base);
    s.searchRoot(3);
    const first = s.nodes;
    s.searchRoot(3);
    const second = s.nodes - first;
    check('第二次搜同一局面时节点数明显减少', second < first, true);
  }
}

// --- 静态搜索 ---
// 这组断言直接验证 design.md §7.3 的核心设计：**关掉静态搜索是让 AI「像新手」的
// 最有效开关**。红车可以吃黑卒，但吃完会被黑车吃回：
//   - 关掉静态搜索的深度 1 只看得到「吃了个卒、赚 100」，于是贪这一口
//   - 开启静态搜索会把兑子序列走完，看到「赚 100 丢 900」，于是不贪
{
  const { search } = await load('engine.js');

  const fen = '4k4/9/9/9/r3p4/4R4/9/9/9/3K5 w - - 0 1';

  const greedy = { id: 'greedy', name: '贪吃', depth: 1, timeLimitMs: 10000,
                   quiescence: false, noise: 0, blunderRate: 0 };
  const careful = { ...greedy, quiescence: true };

  check('关掉静态搜索的深度 1 会贪吃卒（这就是「入门」挡位的行为）',
    coordOf(search(fen, greedy, { rng: seededRng(3) }).to), '4,4');
  check('开启静态搜索后不去贪吃卒',
    coordOf(search(fen, careful, { rng: seededRng(3) }).to) === '4,4', false);
}

// --- 迭代加深与时间控制 ---
{
  const { search } = await load('engine.js');
  const { generateLegalMoves } = await load('rules.js');

  // 时间上限：给 300ms，必须在明显超时之前返回
  {
    const lv = { id: 'timed', name: '限时', depth: 64, timeLimitMs: 300,
                 quiescence: true, noise: 0, blunderRate: 0 };
    const t0 = Date.now();
    const r = search(START_FEN, lv, { rng: seededRng(5) });
    const elapsed = Date.now() - t0;
    check('限时 300ms 的搜索在 1500ms 内返回', elapsed < 1500, true);
    check('限时搜索至少完成了一层', r.depth >= 1, true);
  }

  // 迭代加深：深度给够时，完成的层数应当等于上限
  {
    const lv = { id: 'deep', name: '深搜', depth: 4, timeLimitMs: 60000,
                 quiescence: false, noise: 0, blunderRate: 0 };
    const r = search(START_FEN, lv, { rng: seededRng(5) });
    check('迭代加深跑到指定层数', r.depth, 4);
  }

  // 极短时间限制下也必须返回合法着法（用上一层的结果，绝不能返回半个）
  {
    const lv = { id: 'instant', name: '瞬时', depth: 64, timeLimitMs: 1,
                 quiescence: true, noise: 0, blunderRate: 0 };
    const r = search(START_FEN, lv, { rng: seededRng(5) });
    const legal = new Set(generateLegalMoves(parseFen(START_FEN)));
    check('时间限制极短时仍返回合法着法', legal.has(r.move), true);
  }
}

// --- 挡位弱化 ---
{
  const { search } = await load('engine.js');

  const strong = { id: 's', name: '强', depth: 3, timeLimitMs: 10000,
                   quiescence: true, noise: 0, blunderRate: 0 };

  // 没有随机性时，结果必须与随机源无关
  {
    const a = search(START_FEN, strong, { rng: seededRng(11) });
    const b = search(START_FEN, strong, { rng: seededRng(22) });
    check('noise 与 blunderRate 都为 0 时结果与随机源无关', b.move, a.move);
  }

  // 评分噪声足够大时，着法会随随机源变化 —— 这就是「弱挡位不总是走同一步」的来源
  {
    const noisy = { ...strong, noise: 400 };
    const seen = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      seen.add(search(START_FEN, noisy, { rng: seededRng(seed) }).move);
    }
    check('噪声足够大时着法会随随机源变化', seen.size > 1, true);
  }

  // 失误率 1.0：每次都标记为失误，且不走最优着法
  {
    const blunder = { ...strong, blunderRate: 1 };
    const best = search(START_FEN, strong, { rng: seededRng(11) }).move;
    let blunders = 0;
    for (let seed = 1; seed <= 8; seed++) {
      if (search(START_FEN, blunder, { rng: seededRng(seed) }).blundered) blunders++;
    }
    check('失误率 1.0 时每次都标记为失误', blunders, 8);
    check('失误率 1.0 时不会返回最优着法',
      search(START_FEN, blunder, { rng: seededRng(11) }).move === best, false);
  }

  // 只有一个合法着法时，失误率绝不能触发 —— 否则会走出非法着法
  {
    const blunder = { ...strong, blunderRate: 1 };
    const fen1 = '4k4/3R5/9/9/9/9/9/9/9/3K5 b - - 0 1';
    const r = search(fen1, blunder, { rng: seededRng(1) });
    check('只有一个合法着法时失误率不触发', r.blundered, false);
    check('只有一个合法着法时仍返回那个着法',
      [coordOf(r.from), coordOf(r.to)], ['4,0', '5,0']);
  }
}

// --- 回归：quiesce 在「被将军且无着法」时不能返回 -INF ---
// 不处理的话 best 会停在 alpha（-INF），取负变成 +INF，
// iterativeDeepen 判断「找到杀棋」的条件是 |score| > MATE - 1000，
// 于是误判成杀棋、提前停止加深 —— 表现为挡位突然只搜 1 层。
// 这个 bug 是自对弈冒烟测试（tools/selfplay.mjs）发现的，不是单测发现的。
{
  const { search } = await load('engine.js');

  const mateIn1 = '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1';
  const lv = { id: 'r', name: '回归', depth: 4, timeLimitMs: 30000,
               quiescence: true, noise: 0, blunderRate: 0 };
  const r = search(mateIn1, lv, { rng: seededRng(1) });

  check('杀棋分值不超过 MATE（不能是 INF 取负的结果）', r.score < 1e6, true);
  check('找到杀棋后提前停止加深，不必跑满 4 层', r.depth < 4, true);
  check('深度必须 >= 1，不能因为误判而退化成 0', r.depth >= 1, true);
}

// --- 将军延伸 ---
// 被将军的节点不消耗深度（LEVELS.checkExtension）。这条正面钉住它的价值：
// 同一个局面、同一个基准深度，开了延伸的看得见杀棋，关掉的看不见。
//
// 局面是《适情雅趣》第013局「目视横流」，5 层连杀（红先）。
// 挑它是因为便宜：基准深度 3 + 延伸就能看完 5 层，几十毫秒。
{
  const { search } = await load('engine.js');

  const fen = '4k4/3P2P2/b2N2R2/7r1/2b6/9/9/3n5/4p3r/2R2K3 w - - 0 1';
  const base = { id: 'e', name: '延伸', depth: 3, timeLimitMs: 20000,
                 quiescence: true, noise: 0, blunderRate: 0 };

  const off = search(fen, { ...base, checkExtension: 0 });
  const on = search(fen, { ...base, checkExtension: 8 });

  check('关掉延伸时深度 3 看不见 5 层连杀', Math.abs(off.score) > 99000, false);
  check('开了延伸时深度 3 能看见杀棋', Math.abs(on.score) > 99000, true);
  check('延伸看到的是那步 6,2 -> 4,2 的杀着', [coordOf(on.from), coordOf(on.to)], ['6,2', '4,2']);
}

// --- 连将杀探测 ---
// 攻击方只走将军着法的强制杀搜索（Searcher.probeMate）。它解决的是
// 「十几步连杀用常规搜索根本搜不到底」—— 常规搜索要上千万节点，它能降到十几万。
//
// 局面：《适情雅趣》第001局「气吞关右」，13 层连杀，正解首着是**平炮抽将**
// （炮五平九，借纵线上的红车抽将）。这个局面是用户报上来的原始案例：
// 只加将军延伸时「高级」挡位仍然看不到它。
{
  const { search } = await load('engine.js');

  const fen = '2baka3/3P3N1/bN7/7nc/9/4C1P2/P5n1P/B3R3B/4Apr2/2RAK3c w - - 0 1';
  const lv = { id: 'm', name: '探测', depth: 64, timeLimitMs: 5000,
               quiescence: true, noise: 0, blunderRate: 0, checkExtension: 6, mateProbePly: 15 };
  const r = search(fen, lv, { rng: seededRng(1) });

  check('连将杀探测找到正解首着', [coordOf(r.from), coordOf(r.to)], ['4,5', '0,5']);
  check('分值是被证明的杀棋', Math.abs(r.score) > 99000, true);
  check('探到的杀棋是 13 层', r.depth, 13);

  // 探测找到的杀棋不能被动摇：杀棋是**证明**，不是评估，「失误」不该把它抹掉。
  // 否则残局库的「提示」给出的就是错的 —— 那正是要修的问题。
  const shaky = { ...lv, blunderRate: 1, noise: 200 };
  check('探测到杀棋时挡位弱化不生效',
    [coordOf(search(fen, shaky, { rng: seededRng(3) }).from),
      coordOf(search(fen, shaky, { rng: seededRng(3) }).to)], ['4,5', '0,5']);
}

// 探测在「没有连杀」的局面里必须几乎不花钱，也不能改变结果。
// 代价来源是根节点的将军着法：一步都没有时它是 0 个节点。
{
  const { search } = await load('engine.js');

  const lv = { id: 'q', name: '安静', depth: 5, timeLimitMs: 30000,
               quiescence: true, noise: 0, blunderRate: 0, checkExtension: 6 };
  const off = search(START_FEN, { ...lv, mateProbePly: 0 }, { rng: seededRng(9) });
  const on = search(START_FEN, { ...lv, mateProbePly: 15 }, { rng: seededRng(9) });

  check('开局没有连杀：开探测与关探测选同一步', on.move, off.move);
  check('开局没有连杀：开探测与关探测分值相同', on.score, off.score);
  check('开局没有连杀：探测不额外花时间', on.nodes, off.nodes);

  // 一步杀也不能被它漏掉
  const mateIn1 = '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1';
  const r = search(mateIn1, { ...lv, mateProbePly: 15 }, { rng: seededRng(1) });
  check('一步杀：探测也能发现', Math.abs(r.score) > 99000, true);
}

// --- 回归：超时中断后，searcher 的棋盘必须还原 ---
// 超时是用抛异常中断的，异常会从 make() / unmake() 中间穿过去，棋盘停在
// 「走了一半」的状态上。而 search() 之后还要用 searcher.cells 生成根着法
// 来施加挡位弱化 —— 从一个错乱的棋盘上挑着法会挑出**非法着法**，
// 上层 playMove 拒掉它，表现成「AI 不动了」（不是报错，是静默卡住）。
// 修之前用 blunderRate = 1 + 800ms 在这个局面下跑 40 次，有 34 次返回非法着法。
{
  const { Searcher, search } = await load('engine.js');
  const { generateLegalMoves } = await load('rules.js');

  const fen = '2baka3/3P3N1/bN7/7nc/9/4C1P2/P5n1P/B3R3B/4Apr2/2RAK3c w - - 0 1';

  // 直接构造一个「必然超时」的 Searcher，看它的棋盘还在不在
  {
    const lv = { id: 'x', name: 'x', depth: 64, timeLimitMs: 300, quiescence: true,
                 noise: 0, blunderRate: 0 };
    const pos = parseFen(fen);
    const before = Array.from(pos.cells);
    const s = new Searcher(pos.cells, pos.side, lv);
    s.deadline = Date.now() + 300;
    s.iterativeDeepen();
    check('超时之后棋盘还原', Array.from(s.cells), before);
    check('超时之后轮走方还原', s.side, pos.side);
  }

  // 放大到 search() 这一层：失误率 1.0 时每次都会从根着法里随机挑，
  // 棋盘没还原的话挑出来的就是非法着法。
  {
    const legal = new Set(generateLegalMoves(parseFen(fen)));
    const lv = { id: 'b', name: 'b', depth: 64, timeLimitMs: 300, quiescence: true,
                 noise: 0, blunderRate: 1, checkExtension: 6 };
    let illegal = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const r = search(fen, lv, { rng: seededRng(seed) });
      if (!legal.has(r.move)) illegal++;
    }
    check('超时 + 失误率 1.0 时返回的着法仍然合法', illegal, 0);
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
