#!/usr/bin/env node
/**
 * 规则引擎的行为测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-rules.mjs
 *
 * 这里测的是「改着法生成时最容易悄悄弄坏」的地方：每种棋子的走法约束、
 * 将帅照面、应将、困毙判负。象棋的 perft 基准值来源不一、容易记错，
 * 所以不依赖外部数字，改成逐条规则点的断言 —— 失败时能直接指出是哪条规则错了。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { CELLS, PIECE_OF_FEN, START_FEN } = await load('config.js');
const { indexOf, xOf, yOf, inBoard, parseFen, toFen, startPosition, clonePosition, positionSignature } =
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

/** 'x,y' -> 下标。测试里到处要用，别在每个块里重复写 */
const idxOf = (coord) => {
  const [x, y] = coord.split(',').map(Number);
  return y * 9 + x;
};

const coordOf = (idx) => `${xOf(idx)},${yOf(idx)}`;

/** 用「棋子字符 @ x,y」的稀疏描述造局面，比手写 FEN 好核对 */
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

console.log('规则引擎测试\n');

// === 以下为各任务追加的测试块 ===

// --- 坐标换算 ---
{
  check('indexOf / xOf / yOf 互逆',
    [0, 8, 9, 40, 44, 89].map((i) => indexOf(xOf(i), yOf(i))),
    [0, 8, 9, 40, 44, 89]);
  check('indexOf(4, 4) = 40', indexOf(4, 4), 40);
  check('idx 0 是黑方左上角', [xOf(0), yOf(0)], [0, 0]);
  check('idx 89 是红方右下角', [xOf(89), yOf(89)], [8, 9]);
  check('inBoard 判边界',
    [inBoard(0, 0), inBoard(8, 9), inBoard(9, 0), inBoard(0, 10), inBoard(-1, 0)],
    [true, true, false, false, false]);
}

// --- FEN 读写 ---
{
  check('起始局面 FEN 往返一致', toFen(startPosition()), START_FEN);
  check('起始局面轮走方是红', startPosition().side, 1);

  const egFen = '3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1';
  check('残局示例 FEN 往返一致', toFen(parseFen(egFen)), egFen);
  check('残局示例：红车在 (0,9)', parseFen(egFen).cells[idxOf('0,9')], 5);
  check('残局示例：黑将在 (4,0)', parseFen(egFen).cells[idxOf('4,0')], -1);

  const blackFirst = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1';
  check('轮走方 b 解析为黑', parseFen(blackFirst).side, -1);

  check('clonePosition 是深拷贝',
    (() => {
      const a = startPosition();
      const b = clonePosition(a);
      b.cells[0] = 0;
      return a.cells[0] === -5 && b.cells[0] === 0;
    })(), true);

  const throws = (name, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    check(name, threw, true);
  };
  throws('FEN 行数不对时报错', () => parseFen('9/9 w'));
  throws('FEN 轮走方非法时报错', () => parseFen('9/9/9/9/9/9/9/9/9/9 x'));
  throws('FEN 出现非法字符时报错', () => parseFen('9/9/9/9/9/9/9/9/9/xxx w'));
  throws('FEN 列数不足时报错', () => parseFen('rnbakabn/9/9/9/9/9/9/9/9/RNBAKABNR w'));
  throws('FEN 缺字段时报错', () => parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'));

  check('局面签名忽略后三个字段',
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1'),
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 7 12'));
  check('局面签名区分轮走方',
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1') ===
    positionSignature('3aka3/9/9/9/9/9/9/9/9/R2K5 b - - 0 1'), false);
}

// --- 着法生成：车 / 炮 / 兵 / 将 ---
{
  const { generateMoves, moveFrom, moveTo } = await load('rules.js');

  const movesFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateMoves(pos.cells, pos.side)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 车：四方向直线滑动，遇子停止，遇敌子可吃
  check('车在空盘正中：17 个落点', movesFrom(build(['R@4,4']), '4,4').length, 17);
  check('车被己方挡住时停在前面',
    movesFrom(build(['R@4,4', 'P@4,2']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);
  check('车可以吃敌子，且停在敌子那一格',
    movesFrom(build(['R@4,4', 'p@4,2']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,2', '4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);

  // 炮：没有炮架只能走空格，隔一个子才能吃
  check('炮在空盘正中：17 个落点（与车相同，因为无子可吃）',
    movesFrom(build(['C@4,4']), '4,4').length, 17);
  check('炮隔一个子可吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'r@4,0']), '4,4').filter((c) => c.startsWith('4,')),
    ['4,0', '4,3', '4,5', '4,6', '4,7', '4,8', '4,9']);
  check('炮隔两个子不能吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'P@4,1', 'r@4,0']), '4,4').includes('4,0'), false);
  check('炮没有炮架时不能吃',
    movesFrom(build(['C@4,4', 'r@4,0']), '4,4').includes('4,0'), false);
  check('炮的炮架是己方子也能吃',
    movesFrom(build(['C@4,4', 'P@4,2', 'r@4,0']), '4,4').includes('4,0'), true);

  // 兵：未过河只能前进，过河后可横走，永不后退
  check('红兵未过河只能前进一格', movesFrom(build(['P@0,6']), '0,6'), ['0,5']);
  check('红兵过河后可前进和横走', movesFrom(build(['P@4,4']), '4,4'), ['3,4', '4,3', '5,4']);
  check('红兵贴边过河只有两个落点', movesFrom(build(['P@0,4']), '0,4'), ['0,3', '1,4']);
  check('黑卒未过河只能前进一格', movesFrom(build(['p@0,3'], 'b'), '0,3'), ['0,4']);
  check('黑卒过河后可前进和横走', movesFrom(build(['p@4,5'], 'b'), '4,5'), ['3,5', '4,6', '5,5']);

  // 将 / 帅：四方向一格，不得出九宫
  check('红帅在底线正中：3 个落点', movesFrom(build(['K@4,9']), '4,9'), ['3,9', '4,8', '5,9']);
  check('红帅在九宫左边：3 个落点', movesFrom(build(['K@3,8']), '3,8'), ['3,7', '3,9', '4,8']);
  check('红帅在九宫角：2 个落点', movesFrom(build(['K@3,9']), '3,9'), ['3,8', '4,9']);
  check('黑将在九宫角：2 个落点', movesFrom(build(['k@5,0'], 'b'), '5,0'), ['4,0', '5,1']);
}

// --- 着法生成：马 / 象 / 士 ---
{
  const { generateMoves, moveFrom, moveTo } = await load('rules.js');
  const movesFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateMoves(pos.cells, pos.side)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 马：八个日字目标，四个马腿方向各塞一个挡子试一遍
  check('马在正中：8 个落点', movesFrom(build(['N@4,4']), '4,4').length, 8);
  check('蹩马腿（上）：(3,2) 与 (5,2) 都不可达',
    movesFrom(build(['N@4,4', 'P@4,3']), '4,4').filter((c) => c.endsWith(',2')), []);
  check('蹩马腿（下）：(3,6) 与 (5,6) 都不可达',
    movesFrom(build(['N@4,4', 'P@4,5']), '4,4').filter((c) => c.endsWith(',6')), []);
  check('蹩马腿（左）：(2,3) 与 (2,5) 都不可达',
    movesFrom(build(['N@4,4', 'P@3,4']), '4,4').filter((c) => c.startsWith('2,')), []);
  check('蹩马腿（右）：(6,3) 与 (6,5) 都不可达',
    movesFrom(build(['N@4,4', 'P@5,4']), '4,4').filter((c) => c.startsWith('6,')), []);
  check('马腿只挡一个方向，其余六个落点照走',
    movesFrom(build(['N@4,4', 'P@4,3']), '4,4'),
    ['2,3', '2,5', '3,6', '5,6', '6,3', '6,5']);

  // 象 / 相：田字，塞象眼，不能过河
  check('红相在底线：2 个落点', movesFrom(build(['B@2,9']), '2,9'), ['0,7', '4,7']);
  check('塞象眼：象眼有子则该田字不可达',
    movesFrom(build(['B@2,9', 'P@1,8']), '2,9'), ['4,7']);
  check('相不能过河', movesFrom(build(['B@2,5']), '2,5'), ['0,7', '4,7']);
  check('黑象在底线：2 个落点', movesFrom(build(['b@2,0'], 'b'), '2,0'), ['0,2', '4,2']);

  // 士 / 仕：斜走一格，不得出九宫
  check('红仕在九宫正中：4 个落点',
    movesFrom(build(['A@4,8']), '4,8'), ['3,7', '3,9', '5,7', '5,9']);
  check('红仕在九宫角：只有 1 个落点（另一个出九宫）',
    movesFrom(build(['A@3,9']), '3,9'), ['4,8']);
  check('黑士在九宫角：只有 1 个落点',
    movesFrom(build(['a@5,0'], 'b'), '5,0'), ['4,1']);
}

// --- 初始局面着法数分解 ---
// 红方共 42 步。拆到每个棋子上，这样失败时能直接看出是哪种棋子错了。
{
  const { generateMoves, moveFrom } = await load('rules.js');
  const pos = startPosition();
  const perPiece = new Map();
  for (const m of generateMoves(pos.cells, pos.side)) {
    const key = coordOf(moveFrom(m));
    perPiece.set(key, (perPiece.get(key) || 0) + 1);
  }
  const counts = (keys) => keys.map((k) => perPiece.get(k));

  check('初始局面：5 个兵各 1 步', counts(['0,6', '2,6', '4,6', '6,6', '8,6']), [1, 1, 1, 1, 1]);
  check('初始局面：2 个炮各 12 步', counts(['1,7', '7,7']), [12, 12]);
  check('初始局面：2 个马各 2 步', counts(['1,9', '7,9']), [2, 2]);
  check('初始局面：2 个车各 2 步', counts(['0,9', '8,9']), [2, 2]);
  check('初始局面：2 个相各 2 步', counts(['2,9', '6,9']), [2, 2]);
  check('初始局面：2 个仕各 1 步', counts(['3,9', '5,9']), [1, 1]);
  check('初始局面：帅 1 步', perPiece.get('4,9'), 1);
  check('初始局面：红方共 44 步', generateMoves(pos.cells, pos.side).length, 44);
}

// --- 攻击判定 ---
// isAttacked 只看几何关系，但车 / 炮 / 将这类滑行攻击必须「扫到目标格」才命中，
// 所以靶子格上必须真的有子。下面统一往目标格塞一个红兵当靶子。
{
  const { isAttacked, findKing, inCheck } = await load('rules.js');
  const attacked = (specs, coord, bySide) =>
    isAttacked(build([...specs, `P@${coord}`]).cells, idxOf(coord), bySide);

  // 车
  check('车沿纵线攻击', attacked(['r@4,0'], '4,4', -1), true);
  check('车被挡住则不攻击', attacked(['r@4,0', 'P@4,3'], '4,4', -1), false);
  check('车从另一侧也攻击', attacked(['r@4,8'], '4,4', -1), true);

  // 炮
  check('炮隔一子攻击', attacked(['c@4,0', 'P@4,3'], '4,4', -1), true);
  check('炮没炮架不攻击', attacked(['c@4,0'], '4,4', -1), false);
  check('炮隔两子不攻击', attacked(['c@4,0', 'P@4,3', 'P@4,2'], '4,4', -1), false);

  // 马
  check('马攻击日字目标', attacked(['n@5,2'], '4,4', -1), true);
  check('马腿被蹩则不攻击', attacked(['n@5,2', 'P@5,3'], '4,4', -1), false);

  // 兵 / 卒
  check('红兵攻击正前方', attacked(['P@4,5'], '4,4', 1), true);
  check('红兵未过河不攻击侧面', attacked(['P@5,6'], '4,6', 1), false);
  check('红兵过河后攻击侧面', attacked(['P@5,4'], '4,4', 1), true);
  check('黑卒攻击正前方', attacked(['p@4,3'], '4,4', -1), true);

  // 将帅照面：同处一条纵线且中间无子时互相攻击
  check('将帅照面时互相攻击',
    isAttacked(build(['K@4,9', 'k@4,0']).cells, idxOf('4,0'), 1), true);
  check('中间有子则不算照面',
    isAttacked(build(['K@4,9', 'P@4,5', 'k@4,0']).cells, idxOf('4,0'), 1), false);

  // inCheck / findKing
  // 注意黑将不能放在纵线 4 上 —— 那会和红帅照面，把「被将军」测成照面
  check('被将军时 inCheck 为真', inCheck(build(['K@4,9', 'r@4,0', 'k@5,0']).cells, 1), true);
  check('没被将军时 inCheck 为假', inCheck(build(['K@4,9', 'r@3,0', 'k@5,0']).cells, 1), false);
  check('只有将帅照面、没有别的攻击子时也算被将军',
    inCheck(build(['K@4,9', 'k@4,0']).cells, 1), true);
  check('findKing 能找到红帅', findKing(build(['K@4,9']).cells, 1), idxOf('4,9'));
  check('findKing 找不到时返回 -1', findKing(build(['K@4,9']).cells, -1), -1);
}

// --- 合法着法 ---
{
  const { generateLegalMoves, moveFrom, moveTo } = await load('rules.js');
  const legalFrom = (pos, coord) => {
    const from = idxOf(coord);
    return generateLegalMoves(pos)
      .filter((m) => moveFrom(m) === from)
      .map((m) => coordOf(moveTo(m)))
      .sort();
  };

  // 不能把挡在两将中间的炮挪离纵线（否则将帅照面）
  {
    const pos = build(['K@4,9', 'C@4,5', 'k@4,0']);
    check('将帅照面：炮不能挪离纵线',
      legalFrom(pos, '4,5'), ['4,1', '4,2', '4,3', '4,4', '4,6', '4,7', '4,8']);
    check('将帅照面：帅可以离开纵线', legalFrom(pos, '4,9'), ['3,9', '4,8', '5,9']);
    check('将帅照面：红方共 10 个合法着法', generateLegalMoves(pos).length, 10);
  }

  // 应将：被将军时，不能解的着法全部非法
  {
    const pos = build(['K@4,9', 'r@4,5', 'R@0,5', 'k@4,0']);
    check('被将军时只有 3 个合法着法', generateLegalMoves(pos).length, 3);
    check('车只能吃掉将军的车', legalFrom(pos, '0,5'), ['4,5']);
    check('帅只能躲到两侧，不能留在纵线上', legalFrom(pos, '4,9'), ['3,9', '5,9']);
  }

  // 不能吃被保护的子；躲的方向也要考虑将帅照面
  {
    const pos = build(['K@4,9', 'r@4,8', 'c@4,0', 'p@4,4', 'k@3,0']);
    check('帅不能吃掉被炮保护的子', legalFrom(pos, '4,9').includes('4,8'), false);
    check('也不能躲到会与黑将照面的纵线', legalFrom(pos, '4,9').includes('3,9'), false);
    check('唯一的解法是躲到 (5,9)', legalFrom(pos, '4,9'), ['5,9']);
  }
}

// --- 终局判定 ---
{
  const { gameStatus, isThreefoldRepetition, perpetualChecker, classifyRepetition } =
    await load('rules.js');

  check('起始局面是进行中', gameStatus(startPosition()).type, 'playing');

  // 将死：黑将困在九宫角，两个红车分别封住两条逃路
  {
    const mate = build(['k@3,0', 'R@3,5', 'R@4,5', 'K@4,9'], 'b');
    const st = gameStatus(mate);
    check('将死：类型为 checkmate', st.type, 'checkmate');
    check('将死：胜方是红', st.winner, 1);
    check('将死：没有合法着法', st.moves.length, 0);
  }

  // 困毙：黑将没被将军，但一步也走不了 —— 中国象棋里判负，不是和棋
  {
    const stale = build(['k@3,0', 'R@4,5', 'R@0,1', 'K@4,9'], 'b');
    const st = gameStatus(stale);
    check('困毙：类型为 stalemate', st.type, 'stalemate');
    check('困毙：走子方判负（胜方是红）', st.winner, 1);
  }

  // 三次重复
  check('三次重复：同一签名出现 3 次判和',
    isThreefoldRepetition(['A w', 'B b', 'A w', 'B b', 'A w']), true);
  check('三次重复：只出现 2 次不判和',
    isThreefoldRepetition(['A w', 'B b', 'A w', 'B b']), false);
  check('三次重复：轮走方不同算不同局面',
    isThreefoldRepetition(['A w', 'A b', 'A w']), false);
  check('三次重复：空序列不判和', isThreefoldRepetition([]), false);

  // 长将：循环里有一方每一步都在将军
  //
  // 四个着法的循环（红、黑、红、黑），checks 与 sides 一一对应。
  // 三种结论各钉一条，外加「互将判和」这一条 —— 它是唯一的例外，
  // 只钉「有人长将」的话，把互将也判成某一方负是看不出来的。
  check('长将：红方每步都将军 → 长将方是红',
    perpetualChecker([1, -1, 1, -1], [true, false, true, false]), 1);
  check('长将：黑方每步都将军 → 长将方是黑',
    perpetualChecker([1, -1, 1, -1], [false, true, false, true]), -1);
  check('长将：都没将军 → 0（普通重复判和）',
    perpetualChecker([1, -1, 1, -1], [false, false, false, false]), 0);
  check('长将：双方都在将军（互将）→ 0（棋规判和）',
    perpetualChecker([1, -1, 1, -1], [true, true, true, true]), 0);
  check('长将：空循环 → 0', perpetualChecker([], []), 0);

  // 定性：三次重复 ≠ 一定是和棋
  {
    // 8 步的循环：红黑各走 4 步，起始局面 A 在第 0、4、8 步出现三次
    const sigs = ['A w', 'B b', 'C w', 'D b', 'A w', 'B b', 'C w', 'D b', 'A w'];
    const sides = [1, -1, 1, -1, 1, -1, 1, -1];

    check('定性：没有三次重复时返回 null',
      classifyRepetition(['A w', 'B b', 'A w'], [1, -1], [true, false]), null);
    check('定性：没人长将 → 普通判和',
      classifyRepetition(sigs, sides, sides.map(() => false)), { type: 'repetition' });
    check('定性：红方每步都将军 → 红方判负',
      classifyRepetition(sigs, sides, [true, false, true, false, true, false, true, false]),
      { type: 'perpetual-check', loser: 1 });
    check('定性：黑方每步都将军 → 黑方判负',
      classifyRepetition(sigs, sides, [false, true, false, true, false, true, false, true]),
      { type: 'perpetual-check', loser: -1 });
    check('定性：互将 → 普通判和',
      classifyRepetition(sigs, sides, sides.map(() => true)), { type: 'repetition' });

    // 只看**最近**一个循环：前半段红方将军、后半段谁都没将军，
    // 不能拿前面那个已经走完的循环去指控红方 —— 那一段已经不重复了。
    check('定性：只看最近一个循环，前面那段不追究',
      classifyRepetition(sigs, sides, [true, false, true, false, false, false, false, false]),
      { type: 'repetition' });
  }
}

// === 收尾 ===
// --- 局面合法性校验（残局库用） ---
{
  const { isLegalPosition } = await load('rules.js');
  const ok = (pos) => isLegalPosition(pos).ok;

  check('起始局面合法', ok(startPosition()), true);
  check('残局示例局面合法', ok(parseFen('3aka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1')), true);

  // 1. 缺将 / 多将
  check('缺黑将 → 不合法', ok(build(['K@4,9'])), false);
  check('两个红帅 → 不合法', ok(build(['K@3,9', 'K@4,9', 'k@4,0'])), false);
  check('不合法时给出原因', typeof isLegalPosition(build(['K@4,9'])).reason, 'string');

  // 2. 将帅照面
  check('将帅照面 → 不合法', ok(build(['K@4,9', 'k@4,0'])), false);
  check('中间有子则合法', ok(build(['K@4,9', 'P@4,5', 'k@4,0'])), true);

  // 3. 棋子出界
  check('黑士不在九宫斜点 → 不合法', ok(build(['K@3,9', 'k@4,0', 'a@4,0'])), false);
  check('黑士在九宫斜点 → 合法', ok(build(['K@3,9', 'k@4,0', 'a@5,0'])), true);
  check('红相过河 → 不合法', ok(build(['K@3,9', 'k@4,0', 'B@4,4'])), false);
  check('黑象不在象位 → 不合法', ok(build(['K@3,9', 'k@4,0', 'b@3,0'])), false);
  check('黑象在象位 → 合法', ok(build(['K@3,9', 'k@4,0', 'b@2,0'])), true);
  check('红帅不在九宫 → 不合法', ok(build(['K@2,9', 'k@4,0'])), false);
  check('黑将不在九宫 → 不合法', ok(build(['K@3,9', 'k@2,0'])), false);

  // 4. 兵在己方底线
  check('红兵在己方底线 (y=9) → 不合法', ok(build(['K@3,9', 'k@4,0', 'P@0,9'])), false);
  check('黑卒在己方底线 (y=0) → 不合法', ok(build(['K@3,9', 'k@4,0', 'p@0,0'])), false);
  check('红兵在 y=8 → 合法', ok(build(['K@3,9', 'k@4,0', 'P@0,8'])), true);

  // 5. 非轮走方被将军
  check('非轮走方被将军 → 不合法', ok(build(['K@3,9', 'k@4,0', 'R@4,5'])), false);
  check('轮走方被将军 → 合法（他正在被将，需要应将）',
    ok(build(['K@3,9', 'k@4,0', 'R@4,5'], 'b')), true);

  // 6. 子力超限
  check('三个红车 → 不合法',
    ok(build(['K@3,9', 'k@4,0', 'R@0,9', 'R@1,9', 'R@2,9'])), false);
  check('六个红兵 → 不合法',
    ok(build(['K@3,9', 'k@4,0', 'P@0,5', 'P@1,5', 'P@2,5', 'P@3,5', 'P@4,5', 'P@5,5'])), false);
}

// --- 方向查表（`rules.js` 的 RAY_NEXT / HORSE_LEG / HORSE_TARGET）---
// 这三张表是**生成**的，却同时喂 `isAttacked()`（搜索里最热的单个函数）与评估的机动性
// （评估里最贵的一项 —— 两处合计超过一半的自耗时，见 `decisions.md` 第 32 / 34 条）。
// 生成循环写错、或者以后有人把手写数据塞回来，都不会报错，只会让**两个热路径一起**悄悄偏向。
//
// 这里**不拿 ORTHO / HORSE 再算一遍** —— 那是同义反复（表本来就是它俩铺出来的）。
// 钉的是**几何不变量**，其中第一条是最要紧的：
//   1) 同一个方向在所有格子上的位移必须一致。不一致意味着射线走到一半会**拐弯** ——
//      而「每格有四个正交邻居」这种集合型断言**抓不到**它。
//   2) 车 / 炮的下一格必须与当前格正交相邻；每格的邻居集合 = 棋盘内的四个正交邻格。
//   3) 马的腿格正交相邻于起点、目标格是「日」字，且腿格落在**长边**方向上
//      （蹩马腿的语义就是长边那一格）；每格的目标集合 = 棋盘内的八个日字点。
{
  const { RAY_NEXT, HORSE_LEG, HORSE_TARGET } = await load('rules.js');
  const { COLS: COLS_, ROWS: ROWS_ } = await load('config.js');
  const xs = (i) => i % COLS_;
  const ys = (i) => (i - xs(i)) / COLS_;
  const key = (ax, ay, bx, by) => `${bx - ax},${by - ay}`;

  // 1) + 2)
  const raySteps = [];
  let rayDirOk = true;
  for (let d = 0; d < 4; d++) {
    let step = null;
    for (let i = 0; i < CELLS; i++) {
      const j = RAY_NEXT[i * 4 + d];
      if (j < 0) continue;
      const s = key(xs(i), ys(i), xs(j), ys(j));
      if (step === null) step = s;
      else if (step !== s) rayDirOk = false;
    }
    raySteps.push(step);
    if (!['0,-1', '0,1', '-1,0', '1,0'].includes(step)) rayDirOk = false;
  }
  check('RAY_NEXT：每个方向的位移在所有格子一致、且是正交单位步（不然射线会拐弯）',
    rayDirOk, true);
  check('RAY_NEXT：四个方向互不重复', new Set(raySteps).size, 4);

  const orthoNeighbours = (i) => [[0, -1], [0, 1], [-1, 0], [1, 0]]
    .map(([dx, dy]) => [xs(i) + dx, ys(i) + dy])
    .filter(([nx, ny]) => nx >= 0 && nx < COLS_ && ny >= 0 && ny < ROWS_)
    .map(([nx, ny]) => ny * COLS_ + nx).sort((a, b) => a - b);
  let raySetOk = true;
  for (let i = 0; i < CELLS; i++) {
    const got = [0, 1, 2, 3].map((d) => RAY_NEXT[i * 4 + d]).filter((j) => j >= 0);
    got.sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(orthoNeighbours(i))) raySetOk = false;
  }
  check('RAY_NEXT：每格的邻居集合正好是棋盘内的四个正交邻格', raySetOk, true);

  // 3)
  let horseOk = true;
  let horseCount = 0;
  for (let d = 0; d < 8; d++) {
    let disp = null;
    for (let i = 0; i < CELLS; i++) {
      const leg = HORSE_LEG[i * 8 + d], t = HORSE_TARGET[i * 8 + d];
      if (leg < 0 || t < 0) { if (leg !== t) horseOk = false; continue; }   // 腿出界 ⇔ 目标出界
      horseCount++;
      const ldx = xs(leg) - xs(i), ldy = ys(leg) - ys(i);
      const tdx = xs(t) - xs(i), tdy = ys(t) - ys(i);
      const k = `${tdx},${tdy}|${ldx},${ldy}`;
      if (disp === null) disp = k;
      else if (disp !== k) horseOk = false;
      if (Math.abs(ldx) + Math.abs(ldy) !== 1) horseOk = false;             // 腿必须正交相邻
      if (!((Math.abs(tdx) === 2 && Math.abs(tdy) === 1)
            || (Math.abs(tdx) === 1 && Math.abs(tdy) === 2))) horseOk = false;
      const longOk = Math.abs(tdx) === 2
        ? (ldx === tdx / 2 && ldy === 0)
        : (ldy === tdy / 2 && ldx === 0);
      if (!longOk) horseOk = false;                                        // 腿在长边
    }
  }
  check('HORSE_LEG / HORSE_TARGET：位移一致、腿正交相邻且在长边、目标是日字', horseOk, true);
  check('HORSE：八个方向的位移互不重复', new Set([...Array(8).keys()].map((d) => {
    for (let i = 0; i < CELLS; i++) {
      const t = HORSE_TARGET[i * 8 + d];
      if (t >= 0) return `${xs(t) - xs(i)},${ys(t) - ys(i)}`;
    }
    return null;
  })).size, 8);
  check('HORSE：棋盘内可达的（起点, 方向）组合数合理（8 方向的边界缺口都在）', horseCount > 0, true);

  const knightTargets = (i) => [[1, -2], [-1, -2], [1, 2], [-1, 2], [2, -1], [2, 1], [-2, -1], [-2, 1]]
    .map(([dx, dy]) => [xs(i) + dx, ys(i) + dy])
    .filter(([nx, ny]) => nx >= 0 && nx < COLS_ && ny >= 0 && ny < ROWS_)
    .map(([nx, ny]) => ny * COLS_ + nx).sort((a, b) => a - b);
  let horseSetOk = true;
  for (let i = 0; i < CELLS; i++) {
    const got = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => HORSE_TARGET[i * 8 + d]).filter((j) => j >= 0);
    got.sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(knightTargets(i))) horseSetOk = false;
  }
  check('HORSE_TARGET：每格的目标集合正好是棋盘内的八个日字点', horseSetOk, true);
}

// --- isAttacked 的交叉验证 ---
// 上面「攻击判定」那一组是**手写的规则点**（车 / 炮隔 0/1/2 子、蹩马腿、兵过河、照面各一条）。
// 这一组换一个**结构完全不同**的写法：枚举棋盘上每一个攻击子，问「它攻击 idx 吗」——
// 而 `isAttacked` 是「从 idx 往外扫」。E10 那条教训的正面用法：
// **自洽的测试发现不了规则写错**，得让两套互不相同的实现互相印证。
// 覆盖面：若干局面 × 90 格 × 双方，逐格比对。
{
  const { isAttacked } = await load('rules.js');
  const cfg = await load('config.js');
  const C_ = cfg.COLS, R_ = cfg.ROWS;

  /** 从 `from` 出发的那枚子，攻击 `to` 吗？（士 / 象 不在射程内，见下面那条断言） */
  const attacks = (cells, from, to, bySide) => {
    // **自己不算攻击自己**：`isAttacked` 的契约是「从 idx 往外扫」，靶子格上那个子不参与
    // （这一条不是细节 —— `orderScore` 的「坏吃子降级」正是拿它问「这个吃子格受不受对方保护」，
    //  而受害子**不能算自己那一方的保护者**，否则每个吃子都被判成「受保护」）。
    if (from === to) return false;
    const p = cells[from];
    const fx = from % C_, fy = (from - fx) / C_;
    const tx = to % C_, ty = (to - tx) / C_;
    const dx = tx - fx, dy = ty - fy;
    const abs = Math.abs(p);
    const sx = Math.sign(dx), sy = Math.sign(dy);

    if (abs === cfg.R) {
      if (dx !== 0 && dy !== 0) return false;
      for (let cx = fx + sx, cy = fy + sy; cx !== tx || cy !== ty; cx += sx, cy += sy) {
        if (cells[cy * C_ + cx] !== 0) return false;
      }
      return true;
    }
    if (abs === cfg.C) {
      if (dx !== 0 && dy !== 0) return false;
      let screens = 0;
      for (let cx = fx + sx, cy = fy + sy; cx !== tx || cy !== ty; cx += sx, cy += sy) {
        if (cells[cy * C_ + cx] !== 0) screens++;
      }
      return screens === 1;                       // 炮：中间**正好一个**子
    }
    if (abs === cfg.N) {
      if (!((Math.abs(dx) === 2 && Math.abs(dy) === 1)
            || (Math.abs(dx) === 1 && Math.abs(dy) === 2))) return false;
      const lx = fx + (Math.abs(dx) === 2 ? sx : 0);      // 腿是长边那一格
      const ly = fy + (Math.abs(dy) === 2 ? sy : 0);
      return cells[ly * C_ + lx] === 0;                   // 蹩马腿
    }
    if (abs === cfg.K) {
      if (Math.abs(dx) + Math.abs(dy) === 1) return true;              // 贴身
      if (dx === 0 && cells[to] === -p) {                              // 照面：同一**纵线**、中间无子
        for (let cy = Math.min(fy, ty) + 1; cy < Math.max(fy, ty); cy++) {
          if (cells[cy * C_ + fx] !== 0) return false;
        }
        return true;
      }
      return false;
    }
    if (abs === cfg.P) {
      // y 轴**向下**：红兵朝 y 减小的方向走，所以它攻击的格子是 (fx, fy − 1)。
      if (dx === 0 && ty === fy - bySide) return true;                 // 正前方一格
      if (Math.abs(dx) === 1 && dy === 0 && (bySide === 1 ? fy <= 4 : fy >= 5)) return true;  // 过河后左右
      return false;
    }
    return false;
  };
  const isAttackedRef = (cells, idx, bySide) => {
    for (let i = 0; i < CELLS; i++) {
      const v = cells[i];
      if (v === 0 || Math.sign(v) !== bySide) continue;
      if (attacks(cells, i, idx, bySide)) return true;
    }
    return false;
  };

  const samples = [
    parseFen(START_FEN).cells,
    parseFen('1rbakabnr/9/1cn4c1/p1p1p1p1p/9/9/P1P1P1P1P/4CC3/9/RNBAKABNR w - - 0 1').cells,
    parseFen('1nbak4/4a1c2/4bC3/p1C1p3p/9/2Pn1N3/P3P3P/N8/9/2BAKAB2 b - - 0 1').cells,
    build(['K@4,9', 'k@4,0', 'R@0,4', 'r@8,0', 'C@2,5', 'c@7,2', 'N@6,6', 'n@1,8',
      'P@2,3', 'p@6,6', 'P@5,4', 'p@3,5']).cells,
    build(['K@3,9', 'k@5,0', 'P@0,8', 'p@8,1', 'c@0,2', 'n@4,4']).cells,
  ];
  let mismatch = 0;
  for (const cells of samples) {
    for (let idx = 0; idx < CELLS; idx++) {
      for (const bySide of [1, -1]) {
        if (isAttacked(cells, idx, bySide) !== isAttackedRef(cells, idx, bySide)) mismatch++;
      }
    }
  }
  check(`isAttacked 与「从每个攻击子出发」的参考实现逐格一致（${samples.length} 个局面 × 90 格 × 2 方）`,
    mismatch, 0);

  // 射程的**边界**单独钉住：士 / 象 不算攻击者。
  // 对「将帅是否被攻击」无害（士出不了自己的九宫、象过不了河，两者永远够不到对方的将）；
  // 但 `orderScore` 的「坏吃子降级」也拿它问「这个格子受不受保护」—— 那里会漏掉士象，
  // 是**已知的近似**（`decisions.md` 第 34 条与 `future-work.md` 的 C2 都记着）。
  // 谁要是给 isAttacked 加上士象，这条会红：那是个会改排序的行为改动，得重新量。
  check('isAttacked 的射程不含士 / 象（几何上够不到对方将，所以对「被将军」无害）',
    [isAttacked(build(['P@4,4', 'A@3,3']).cells, idxOf('4,4'), 1),
      isAttacked(build(['P@4,4', 'B@2,2']).cells, idxOf('4,4'), 1)],
    [false, false]);

  // 「靶子格上那个子算不算自己的保护者」= 不算（见 attacks 开头那段说明）。
  // 这里的**提问方就是靶子那一方**（`orderScore` 的用法：问「受不受对方保护」，保护者属于
  // 受害子那一方），所以用黑车当靶子、bySide = −1。
  check('isAttacked：不算「靶子格上那个子攻击自己」（否则每个吃子都会被判成受保护）',
    [isAttacked(build(['r@4,4']).cells, idxOf('4,4'), -1),
      isAttacked(build(['r@4,4', 'c@4,0']).cells, idxOf('4,4'), -1),           // 炮没炮架 → 保护不到
      isAttacked(build(['r@4,4', 'c@4,0', 'p@4,2']).cells, idxOf('4,4'), -1)], // 有炮架 → 真的受保护
    [false, false, true]);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
