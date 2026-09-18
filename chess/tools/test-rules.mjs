#!/usr/bin/env node
/**
 * 规则层测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-rules.mjs [--deep]
 *   --deep  额外跑初始局面 perft 第 6 层（约 1.19 亿叶子，几十秒）
 *
 * 两层判据，缺一不可：
 *
 *   1. **perft**：初始局面 1~5 层 + 四个经典局面（Kiwipete / Position 3/4/5）1~4 层，
 *      数字取自 Chess Programming Wiki。这是国象相对象棋的最大优势 ——
 *      规则层有一个**绝对权威且自动可验**的判据。
 *   2. **逐条断言**：perft 只报「总数不对」，逐条断言才能指出
 *      「是吃过路兵错了还是易位错了」。易位的四个条件、吃过路兵（含暴露己方王的反例）、
 *      升变四种、逼和与将死的区别、50 步、子力不足三种，都在下面逐条钉住。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, EMPTY, P, N, B, R, Q, K, WHITE, START_FEN } = await load('config.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const at = (name) => Pos.squareOf(name);
const fen = (text) => Pos.parseFen(text);

/** 一步棋的「起点终点」（忽略标记与升变种类），用来按代数坐标断言 */
const fromTo = (move) => `${Pos.squareName(Ru.moveFrom(move))}${Pos.squareName(Ru.moveTo(move))}`;
const hasFromTo = (moves, uci) => moves.some((m) => fromTo(m) === uci);
const movesOf = (moves, uci) => moves.filter((m) => fromTo(m) === uci);
const legalOf = (text) => Ru.generateLegalMoves(fen(text));

function perft(pos, depth) {
  const moves = Ru.generateLegalMoves(pos);
  if (depth <= 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(Ru.makeMove(pos, m).pos, depth - 1);
  return n;
}

console.log('规则层测试\n');

// ============================================================
// 一、perft
// ============================================================
console.log('=== perft（权威基准，取自 Chess Programming Wiki）===\n');

const DEEP = process.argv.includes('--deep');

const SUITES = [
  {
    name: '初始局面',
    fen: START_FEN,
    counts: [20, 400, 8902, 197281, 4865609, 119060324],
  },
  {
    name: 'Kiwipete（专测易位 / 应将 / 吃过路兵）',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [48, 2039, 97862, 4085603],
  },
  {
    name: 'Position 3（专测兵与吃过路兵）',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [14, 191, 2812, 43238],
  },
  {
    name: 'Position 4（专测升变，含升变后的将军）',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [6, 264, 9467, 422333],
  },
  {
    name: 'Position 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [44, 1486, 62379, 2103487],
  },
];

for (const suite of SUITES) {
  console.log(`--- ${suite.name}`);
  console.log(`    ${suite.fen}`);
  const base = fen(suite.fen);
  const legal = Ru.isLegalPosition(base);
  check('  局面本身合法', legal.ok, true);
  if (!legal.ok) console.log(`      ↳ ${legal.reason}`);

  const limit = suite.name === '初始局面' && !DEEP ? 5 : suite.counts.length;
  for (let d = 1; d <= limit; d++) {
    const t0 = Date.now();
    const n = perft(base, d);
    const ms = Date.now() - t0;
    check(`  perft(${d})`, n, suite.counts[d - 1]);
    console.log(`      ${n} 个叶子，${ms}ms`);
  }
  console.log('');
}
if (!DEEP) console.log('（初始局面第 6 层 119060324 用 --deep 跑）\n');

// ============================================================
// 二、易位
// ============================================================
console.log('=== 易位 ===\n');
{
  const openFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const open = fen(openFen);
  const white = Ru.generateLegalMoves(open);
  check('两边都能易位', [hasFromTo(white, 'e1g1'), hasFromTo(white, 'e1c1')], [true, true]);
  check('黑方也能易位（轮到黑时）',
    (() => {
      const b = legalOf('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
      return [hasFromTo(b, 'e8g8'), hasFromTo(b, 'e8c8')];
    })(),
    [true, true]);

  // 条件 1：权没了
  const noRights = legalOf('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1');
  check('没有易位权就不能易位',
    [hasFromTo(noRights, 'e1g1'), hasFromTo(noRights, 'e1c1')], [false, false]);

  // 条件 2：中间有子
  check('短易位中间有子 → 只能长易位',
    (() => {
      const ms = legalOf('r3k2r/8/8/8/8/8/8/R3K1NR w KQkq - 0 1');
      return [hasFromTo(ms, 'e1g1'), hasFromTo(ms, 'e1c1')];
    })(),
    [false, true]);

  check('长易位的 b1 有子 → 只能短易位',
    (() => {
      const ms = legalOf('r3k2r/8/8/8/8/8/8/RN2K2R w KQkq - 0 1');
      return [hasFromTo(ms, 'e1c1'), hasFromTo(ms, 'e1g1')];
    })(),
    [false, true]);

  // 条件 3：王经过的格被攻击
  check('王经过的 f1 被攻击 → 不能短易位（长易位仍可）',
    (() => {
      const ms = legalOf('4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1');
      return [hasFromTo(ms, 'e1g1'), hasFromTo(ms, 'e1c1')];
    })(),
    [false, true]);

  check('王经过的 d1 被攻击 → 不能长易位（短易位仍可）',
    (() => {
      const ms = legalOf('4k3/8/8/8/8/3r4/8/R3K2R w KQ - 0 1');
      return [hasFromTo(ms, 'e1c1'), hasFromTo(ms, 'e1g1')];
    })(),
    [false, true]);

  // 只有 b1 被攻击不影响长易位（王不经过 b1）
  check('只有 b1 被攻击 → 长易位仍可',
    hasFromTo(legalOf('1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1c1'), true);

  // 条件 4：王正被将军
  check('王正被将军 → 两边都不能易位',
    (() => {
      const ms = legalOf('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1');
      return [hasFromTo(ms, 'e1g1'), hasFromTo(ms, 'e1c1')];
    })(),
    [false, false]);

  // 走完之后车真的跟着越过王了
  const castleMove = white.find((m) => fromTo(m) === 'e1g1');
  check('易位着法带 FLAG_CASTLE 标记', Ru.moveFlag(castleMove), Ru.FLAG_CASTLE);
  const afterShort = Ru.makeMove(open, castleMove);
  check('短易位之后：王在 g1、车在 f1、h1 空',
    [afterShort.pos.cells[at('g1')], afterShort.pos.cells[at('f1')], afterShort.pos.cells[at('h1')]],
    [K, R, EMPTY]);
  check('短易位之后的 FEN', Pos.toFen(afterShort.pos), 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
  check('短易位丢的是白方两条权', afterShort.pos.castling, 12);

  const longMove = white.find((m) => fromTo(m) === 'e1c1');
  const afterLong = Ru.makeMove(open, longMove);
  check('长易位之后：王在 c1、车在 d1、a1 空',
    [afterLong.pos.cells[at('c1')], afterLong.pos.cells[at('d1')], afterLong.pos.cells[at('a1')]],
    [K, R, EMPTY]);
  check('长易位之后的 FEN', Pos.toFen(afterLong.pos), 'r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1');

  // 王或车动过一次之后，权就没了（由 nextCastling 决定）
  const kingStep = Ru.makeMove(open, Ru.encodeMove(at('e1'), at('e2')));
  check('王走一步之后白方两条权都没了', kingStep.pos.castling & 3, 0);
  const rookStep = Ru.makeMove(open, Ru.encodeMove(at('h1'), at('h2')));
  check('h1 车走一步 → 只剩长易位权', rookStep.pos.castling & 3, 2);
  const rookTaken = Ru.makeMove(
    fen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'),
    Ru.encodeMove(at('a1'), at('a8')),
  );
  check('吃掉 a8 的车 → 黑方长易位权没了', rookTaken.pos.castling & 8, 0);
}

// ============================================================
// 三、吃过路兵
// ============================================================
console.log('\n=== 吃过路兵 ===\n');
{
  const epFen = '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1';
  const pos = fen(epFen);
  const moves = Ru.generateLegalMoves(pos);
  check('吃过路兵着法被生成', hasFromTo(moves, 'd5e6'), true);

  const ep = movesOf(moves, 'd5e6')[0];
  check('带 FLAG_EP 标记', Ru.moveFlag(ep), Ru.FLAG_EP);

  const made = Ru.makeMove(pos, ep);
  check('被吃的兵是 e5 上那个黑兵', made.captured, -P);
  check('吃过路兵之后的 FEN', Pos.toFen(made.pos), '4k3/8/4P3/8/8/8/8/4K3 b - - 0 1');

  // **反例**：吃过去之后自己的王暴露在车的横线上 —— 这一步必须被拒
  const pinned = legalOf('7k/8/8/K2Pp2r/8/8/8/8 w - e6 0 1');
  check('吃过路兵会暴露己方王 → 不合法', hasFromTo(pinned, 'd5e6'), false);
  check('那个局面仍有别的合法着法', pinned.length > 0, true);

  // 没有过路兵机会时不能斜吃
  check('没有过路兵机会时 d5 不能斜走到 e6',
    hasFromTo(legalOf('4k3/8/8/3Pp3/8/8/8/4K3 w - - 0 1'), 'd5e6'), false);

  // 双步前进留下目标格，别的走法清空
  const dbl = Ru.makeMove(fen(START_FEN), Ru.encodeMove(at('e2'), at('e4'), 0, Ru.FLAG_DOUBLE));
  check('双步前进留下 e3 作为目标格', dbl.pos.ep, at('e3'));
  const one = Ru.makeMove(fen(START_FEN), Ru.encodeMove(at('e2'), at('e3')));
  check('单步前进不留下目标格', one.pos.ep, -1);
}

// ============================================================
// 四、升变
// ============================================================
console.log('\n=== 升变 ===\n');
{
  const pos = fen('1n6/P7/8/8/8/8/8/K5k1 w - - 20 30');
  const moves = Ru.generateLegalMoves(pos);
  const push = movesOf(moves, 'a7a8');
  const capture = movesOf(moves, 'a7b8');

  check('直进升变有四种', push.length, 4);
  check('吃子升变也有四种（吃到 b8 的马）', capture.length, 4);
  check('四种升变就是 后/车/象/马',
    push.map((m) => Ru.movePromo(m)).sort((a, b) => a - b), [N, B, R, Q].sort((a, b) => a - b));

  const queen = push.find((m) => Ru.movePromo(m) === Q);
  const made = Ru.makeMove(pos, queen);
  check('升变之后的 FEN', Pos.toFen(made.pos), 'Qn6/8/8/8/8/8/8/K5k1 b - - 0 30');
  check('升变把半步计数归零', made.pos.halfmove, 0);
  check('升变成马就真的是马', Ru.makeMove(pos, push.find((m) => Ru.movePromo(m) === N)).pos.cells[at('a8')], N);
  check('兵不能后退', movesOf(moves, 'a7a6').length, 0);

  check('兵停在第八排 → FEN 非法',
    Ru.isLegalPosition(fen('P6k/8/8/8/8/8/8/K7 w - - 0 1')).ok, false);
}

// ============================================================
// 四之二、UCI 坐标（离线工具与解法数据用它）
// ============================================================
console.log('\n=== UCI 坐标 ===');
{
  const uci = (from, to, promo = 0) => Ru.moveToUci(Ru.encodeMove(at(from), at(to), promo));

  check('普通着法：e2e4', uci('e2', 'e4'), 'e2e4');
  check('吃子也不带标记：e4d5', uci('e4', 'd5'), 'e4d5');
  // **升变必须写成第 5 个字符** —— 少一个字母 Stockfish 会拒收整条命令
  check('升变成后：e7e8q', uci('e7', 'e8', Q), 'e7e8q');
  check('升变成马：e7e8n', uci('e7', 'e8', N), 'e7e8n');
  check('升变成车 / 象：e7e8r / e7e8b', [uci('e7', 'e8', R), uci('e7', 'e8', B)], ['e7e8r', 'e7e8b']);
  check('易位只是「王的起点终点」：e1g1', uci('e1', 'g1'), 'e1g1');

  check('moveOfUci 往返', ['e2e4', 'e7e8q', 'e1g1'].map((t) => Ru.moveToUci(Ru.moveOfUci(t))),
    ['e2e4', 'e7e8q', 'e1g1']);
  check('moveOfUci 认出升变种类',
    ['e7e8q', 'e7e8n', 'e7e8r', 'e7e8b'].map((t) => Ru.movePromo(Ru.moveOfUci(t))),
    [Q, N, R, B]);
  check('moveOfUci 拒绝乱写的坐标',
    ['', 'e2', 'e2e4x', 'z2e4', 'e9e4', 'e7e8k'].map((t) => Ru.moveOfUci(t)),
    [-1, -1, -1, -1, -1, -1]);
}

// ============================================================
// 五、将死 / 逼和 / 50 步 / 子力不足
// ============================================================
console.log('\n=== 终局判定 ===\n');
{
  const mate = Ru.gameStatus(fen('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1'));
  check('底线闷杀 → checkmate', mate.type, 'checkmate');
  check('将死的胜方是白方', mate.winner, WHITE);

  const stale = Ru.gameStatus(fen('k7/8/1Q6/8/8/8/8/K7 b - - 0 1'));
  check('无着法且未被将军 → stalemate', stale.type, 'stalemate');
  check('逼和没有胜方', stale.winner, null);

  check('开局是 playing', Ru.gameStatus(fen(START_FEN)).type, 'playing');
  check('开局有 20 个合法着法', Ru.gameStatus(fen(START_FEN)).moves.length, 20);

  check('半步计数到 100 → fifty', Ru.gameStatus(fen('k7/8/1Q6/8/8/8/8/K7 w - - 100 60')).type, 'fifty');
  check('步骤 99 还没到 → playing', Ru.gameStatus(fen('k7/8/1Q6/8/8/8/8/K7 w - - 99 60')).type, 'playing');
  check('将死优先于 50 步判和',
    Ru.gameStatus(fen('R5k1/5ppp/8/8/8/8/8/6K1 b - - 100 60')).type, 'checkmate');

  // 子力不足的几种
  const insuf = (text) => Ru.gameStatus(fen(text)).type === 'insufficient';
  check('K vs K → 子力不足', insuf('7k/8/8/8/8/8/8/K7 w - - 0 1'), true);
  check('K+象 vs K → 子力不足', insuf('7k/8/8/8/8/8/8/KB6 w - - 0 1'), true);
  check('K+马 vs K → 子力不足', insuf('7k/8/8/8/8/8/8/KN6 w - - 0 1'), true);
  check('K+双马 vs K → **不算**子力不足（存在被将死的合法序列）',
    insuf('7k/8/8/8/8/8/8/KNN5 w - - 0 1'), false);
  check('K+车 vs K → 不算子力不足', insuf('7k/8/8/8/8/8/8/KR6 w - - 0 1'), false);
  check('K+兵 vs K → 不算子力不足', insuf('7k/8/8/8/8/8/P7/K7 w - - 0 1'), false);
  check('K+象 vs K+象（同色格）→ 子力不足',
    insuf('5b1k/8/8/8/8/8/8/2B1K3 w - - 0 1'), true);
  check('K+象 vs K+象（异色格）→ 不算子力不足',
    insuf('2b4k/8/8/8/8/8/8/2B1K3 w - - 0 1'), false);
}

// ============================================================
// 六、开局（交叉验证着法生成的正确性）
// ============================================================
console.log('\n=== 开局与基本走法 ===\n');
{
  const pos = fen(START_FEN);
  const moves = Ru.generateLegalMoves(pos);
  const ucis = moves.map(fromTo).sort();

  check('8 个兵各直进 + 双步 = 16 个着法', ucis.filter((u) => u[1] === '2').length, 16);
  check('两个马各两步 = 4 个着法',
    ucis.filter((u) => u[0] === 'b' && u[1] === '1').length
    + ucis.filter((u) => u[0] === 'g' && u[1] === '1').length, 4);
  check('开局不能吃子', moves.every((m) => pos.cells[Ru.moveTo(m)] === EMPTY), true);
  check('开局没有升变着法', moves.every((m) => Ru.movePromo(m) === 0), true);
  check('伪合法着法与合法着法都是 20（开局没有「走完被将军」的着法）',
    Ru.generateMoves(pos).length, 20);

  // 兵的正前方有子：既不能直进也不能双步
  const blocked = legalOf('4k3/8/8/8/8/4p3/4P3/4K3 w - - 0 1');
  check('兵正前方有子 → 直进与双步都不行',
    [hasFromTo(blocked, 'e2e3'), hasFromTo(blocked, 'e2e4')], [false, false]);

  // **马是跳的，没有「别马腿」这条规则**（那是中国象棋）
  const jumping = legalOf('4k3/8/8/8/8/8/PPP5/N3K3 w - - 0 1');
  check('马可以跳过挡路的子（跳到 b3）', hasFromTo(jumping, 'a1b3'), true);
  check('目标格被自己人占住时才不能去（c2）', hasFromTo(jumping, 'a1c2'), false);

  // 象不能越子：c3 上放一个自己的兵，a1 的象就只能走到 b2 为止
  const bishopBlocked = legalOf('4k3/8/8/8/8/2P5/8/B3K3 w - - 0 1');
  check('象被 c3 的兵挡住（a1 只能走到 b2）',
    [hasFromTo(bishopBlocked, 'a1b2'), hasFromTo(bishopBlocked, 'a1c3')], [true, false]);

  // 车被挡住
  const rookBlocked = legalOf('4k3/8/8/8/8/8/P7/R3K3 w - - 0 1');
  check('车被 a2 的兵挡住上不去（只能沿第一排走）',
    [hasFromTo(rookBlocked, 'a1a3'), hasFromTo(rookBlocked, 'a1a2'), hasFromTo(rookBlocked, 'a1b1')],
    [false, false, true]);
}

// ============================================================
// 七、局面合法性校验
// ============================================================
console.log('\n=== 局面合法性校验 ===\n');
{
  const reason = (text) => {
    const r = Ru.isLegalPosition(fen(text));
    return r.ok ? 'ok' : r.reason;
  };
  check('标准开局合法', reason(START_FEN), 'ok');
  check('少一个王 → 报出来', reason('7k/8/8/8/8/8/8/8 w - - 0 1').includes('王'), true);
  check('两个王相邻 → 报出来', reason('8/8/8/8/8/8/1k6/K7 w - - 0 1').includes('相邻'), true);
  check('非轮走方被将军 → 报出来',
    reason('4k3/8/8/8/8/8/8/4K2r b - - 0 1').includes('非轮走方'), true);
  check('易位权与子的位置对不上 → 报出来',
    reason('4k3/8/8/8/8/8/8/4K3 w K - 0 1').includes('易位'), true);
  check('子力超过上限 → 报出来',
    reason('4k3/8/8/8/8/P7/PPPPPPPP/6K1 w - - 0 1').includes('上限'), true);
  check('轮走方自己正被将军是**合法**的',
    Ru.isLegalPosition(fen('4k3/8/8/8/8/8/4r3/R3K3 w - - 0 1')).ok, true);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
