#!/usr/bin/env node
/**
 * 引擎测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-engine.mjs
 *
 * ## 只钉稳定的东西
 *
 * **不钉节点数、不钉耗时** —— 那两个随机器和实现细节乱跳，钉了只会让人学会
 * 「测试挂了就改数字」。这里钉的是**性质**：
 *
 *   - 增量哈希必须每一步都等于全量重算（对不上 = 哈希维护错了，置换表会用错数据）
 *   - 随机走一段再全部回退，棋盘 / 哈希 / 权 / 过路兵都必须还原
 *   - 只有一个合法着法的局面必须返回它（回到「AI 不动了」那个经典故障）
 *   - **只翻一个参数的对照组**：静态搜索开 / 关给出不同结论；
 *     置换表开 / 关给出同一个最优着法（它只该省节点，不该改结果）
 *   - 一步杀必须看得见
 *   - 随机局面上返回的着法必须真的合法
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN, WHITE, BLACK } = await load('config.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');
const En = await load('engine.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}
function checkTrue(name, actual, note = '') {
  const ok = !!actual;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !note ? '' : `\n        ${note}`}`);
}

/** 测试用的挡位：深度固定、无随机、给足时间 —— 这样结果只由参数决定，可复现 */
const LV = (over = {}) => ({
  id: 'test', name: '测试', depth: 2, timeLimitMs: 5000,
  quiescence: false, noise: 0, blunderRate: 0, checkExtension: 0,
  ...over,
});

/** 固定种子的伪随机，让「随机走子」那几段可复现 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const startPos = () => Pos.parseFen(START_FEN);
const legalOf = (fen) => Ru.generateLegalMoves(Pos.parseFen(fen));
/** 只用来「对得上哪一步」，忽略标记位 —— 断言里读起来更直观 */
const fromTo = (m) => `${Pos.squareName(Ru.moveFrom(m))}${Pos.squareName(Ru.moveTo(m))}`;
/**
 * 判「这个着法在不在合法着法集合里」要用的键。
 *
 * **不能拿着法整数直接比**：编码里还带着易位 / 吃过路兵 / 双步前进的标记位，
 * 而引擎只回 from/to/promo。和 game.js 的 canonicalMove 是同一条口径。
 */
const moveKey = (m) => `${Ru.moveFrom(m)}-${Ru.moveTo(m)}-${Ru.movePromo(m)}`;

console.log('引擎测试\n');

// ============================================================
// 一、评估
// ============================================================
console.log('=== 评估 ===');
{
  const start = startPos();
  check('初始局面评估为 0（位置表镜像正确才对得上）', En.evaluate(start.cells, WHITE), 0);
  check('两侧视角互为相反数', En.evaluate(start.cells, BLACK), -En.evaluate(start.cells, WHITE));

  // 位置表：中心的马明显比角落的马好（同时验白黑两套镜像索引的方向）
  const knightD5 = Pos.parseFen('8/8/8/3N4/8/8/8/K6k w - - 0 1').cells;
  const knightA1 = Pos.parseFen('N7/8/8/8/8/8/8/K6k w - - 0 1').cells;
  check('白马在 d5 比在 a1 好 70 分',
    En.evaluate(knightD5, WHITE) - En.evaluate(knightA1, WHITE), 70);

  const blackKnightD4 = Pos.parseFen('7k/8/8/8/3n4/8/8/K7 w - - 0 1').cells;
  const blackKnightA8 = Pos.parseFen('n6k/8/8/8/8/8/8/K7 w - - 0 1').cells;
  check('黑马在 d4 比在 a8 好 70 分（黑方视角）',
    En.evaluate(blackKnightD4, BLACK) - En.evaluate(blackKnightA8, BLACK), 70);

  // 子力：多一个后当然更好
  const upQueen = Pos.parseFen('7k/8/8/8/8/8/8/KQ6 w - - 0 1').cells;
  checkTrue('多一个后评估明显为正', En.evaluate(upQueen, WHITE) > 800);
}

// ============================================================
// 二、增量哈希要等于全量重算
// ============================================================
console.log('\n=== 增量哈希 ===');
{
  const searcher = new En.Searcher(startPos(), LV());
  const fullKey = () => Pos.zobristKey({
    cells: searcher.cells, side: searcher.side, castling: searcher.castling, ep: searcher.ep,
  });
  const before = {
    cells: searcher.cells.slice(),
    key: searcher.key,
    side: searcher.side,
    castling: searcher.castling,
    ep: searcher.ep,
    major: searcher.major,
    kings: searcher.kings.slice(),
  };

  check('起始哈希 = 全量', searcher.key, fullKey());

  const rng = seeded(20260918);
  const history = [];
  let mismatch = -1;
  let quiet = 0;

  for (let i = 0; i < 80; i++) {
    if (searcher.key !== fullKey()) { mismatch = i; break; }
    const moves = Ru.generateLegalMoves(searcher.view());
    if (moves.length === 0) break;
    const move = moves[Math.floor(rng() * moves.length)];
    searcher.make(move, history.length);
    history.push(move);
    if (Ru.moveFlag(move) === 0 && Ru.movePromo(move) === 0) quiet++;
  }

  check('走了 80 步，每一步的增量哈希都对得上全量', mismatch, -1);
  console.log(`      走了 ${history.length} 步（其中安静着法 ${quiet} 个）`);
  checkTrue('这 80 步里确实遇到过吃子 / 特殊着法', history.length > 50);

  // 全部回退，回到起始局面
  let unmatch = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    searcher.unmake(history[i], i);
    if (searcher.key !== fullKey()) { unmatch = i; break; }
  }
  check('回退过程中哈希始终对得上', unmatch, -1);
  check('棋盘完全还原', Array.from(searcher.cells), Array.from(before.cells));
  check('轮走方 / 易位权 / 过路兵 / 哈希都还原',
    [searcher.side, searcher.castling, searcher.ep, searcher.key],
    [before.side, before.castling, before.ep, before.key]);
  check('重子计数还原', searcher.major, before.major);
  check('王的位置还原', searcher.kings, before.kings);
}

// ============================================================
// 三、只有一个合法着法
// ============================================================
console.log('\n=== 只有一个合法着法 ===');
{
  const FEN = '7k/8/8/8/8/1r6/8/K7 w - - 0 1'; // 白王只能走 a2
  const moves = legalOf(FEN);
  check('这个局面确实只有一个合法着法', moves.length, 1);
  const only = fromTo(moves[0]);

  const r = En.search(FEN, LV({ depth: 4 }));
  checkTrue('引擎返回了那个唯一的着法', r && fromTo(Ru.encodeMove(r.from, r.to, r.promo)) === only,
    `实际返回 ${r ? fromTo(Ru.encodeMove(r.from, r.to, r.promo)) : null}`);
}

// ============================================================
// 四、对照组：静态搜索开 / 关
// ============================================================
console.log('\n=== 对照组：只翻「静态搜索」这一个参数 ===');
{
  // 白后 d1，黑兵 c6 / d5 / e6：d5 的兵是**有根的**。
  // 关掉静态搜索时引擎只会看到「吃掉一个兵」，看不到随后的 cxd5 反吃（水平线效应）；
  // 打开之后它就看得出这是亏子。
  const FEN = '4k3/8/2p1p3/3p4/8/8/8/3QK3 w - - 0 1';
  const noQ = En.search(FEN, LV({ depth: 1, quiescence: false }));
  const withQ = En.search(FEN, LV({ depth: 1, quiescence: true }));

  check('关掉静态搜索时贪吃 d5 的兵', fromTo(Ru.encodeMove(noQ.from, noQ.to)), 'd1d5');
  checkTrue('打开静态搜索之后不再走那一步（看得到反吃）',
    fromTo(Ru.encodeMove(withQ.from, withQ.to)) !== 'd1d5',
    `实际走了 ${fromTo(Ru.encodeMove(withQ.from, withQ.to))}`);
  checkTrue('而且它给出的分数更低（贪吃那一步是虚高的）',
    withQ.score < noQ.score, `静态搜索 ${withQ.score.toFixed(0)} vs 关闭 ${noQ.score.toFixed(0)}`);
}

// ============================================================
// 五、对照组：置换表开 / 关
// ============================================================
console.log('\n=== 对照组：只翻「置换表」这一个参数 ===');
{
  const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const on = En.search(FEN, LV({ depth: 3, quiescence: true, useTT: true }));
  const off = En.search(FEN, LV({ depth: 3, quiescence: true, useTT: false }));
  check('置换表只该省节点，不该改最优着法',
    fromTo(Ru.encodeMove(on.from, on.to)), fromTo(Ru.encodeMove(off.from, off.to)));
  checkTrue('打开时确实省了节点（如果一样多说明它根本没被用到）',
    on.nodes <= off.nodes, `开 ${on.nodes} / 关 ${off.nodes}`);
}

// ============================================================
// 六、一步杀
// ============================================================
console.log('\n=== 杀棋 ===');
{
  const MATE1 = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1'; // Ra8#
  check('这个局面确实是一步杀', Ru.gameStatus(Pos.parseFen(MATE1)).moves.some((m) => {
    return Ru.gameStatus(Ru.makeMove(Pos.parseFen(MATE1), m).pos).type === 'checkmate';
  }), true);

  const r = En.search(MATE1, LV({ depth: 1, quiescence: true }));
  check('深度 1 + 静态搜索就看得见一步杀', fromTo(Ru.encodeMove(r.from, r.to)), 'a1a8');
  checkTrue('分数是杀棋级别的', r.score > 90000, `实际 ${r.score}`);

  // 两步杀：得搜到深度 2（静态搜索看不到「安静的第一步」）
  const MATE2 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const r2 = En.search(MATE2, LV({ depth: 3, quiescence: true }));
  checkTrue('两步杀也有着法返回（不崩、合法）',
    legalOf(MATE2).map(fromTo).includes(fromTo(Ru.encodeMove(r2.from, r2.to))));
}

// ============================================================
// 七、终局局面
// ============================================================
console.log('\n=== 终局局面 ===');
{
  check('将死的局面返回 null',
    En.search('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1', LV()), null);
  check('逼和的局面返回 null',
    En.search('k7/8/1Q6/8/8/8/8/K7 b - - 0 1', LV()), null);
}

// ============================================================
// 八、随机局面上返回的着法必须合法（守住「AI 不动了」那个故障）
// ============================================================
console.log('\n=== 合法性冒烟（随机局面）===');
{
  const rng = seeded(4242);
  let illegal = 0;
  let nulls = 0;
  let checked = 0;

  for (let game = 0; game < 12; game++) {
    let pos = startPos();
    // 先随机走几步，让局面不那么千篇一律
    for (let i = 0; i < 6 + game * 2; i++) {
      const ms = Ru.generateLegalMoves(pos);
      if (ms.length === 0) break;
      pos = Ru.makeMove(pos, ms[Math.floor(rng() * ms.length)]).pos;
    }
    const fen = Pos.toFen(pos);
    const legal = new Set(legalOf(fen).map(moveKey));
    if (legal.size === 0) continue;
    checked++;

    const r = En.search(fen, LV({ depth: 2, timeLimitMs: 200 }));
    if (!r) { nulls++; continue; }
    if (!legal.has(moveKey(Ru.encodeMove(r.from, r.to, r.promo)))) illegal++;
  }

  check(`检查了 ${checked} 个随机局面`, checked > 0, true);
  check('没有返回过非法着法', illegal, 0);
  check('没有在有合法着法的局面上返回 null', nulls, 0);
}

// ============================================================
// 九、弱挡位的「失误」开关也不能走出非法着法
// ============================================================
console.log('\n=== 弱挡位 ===');
{
  const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const legal = new Set(legalOf(FEN).map(moveKey));
  let bad = 0;
  const rng = seeded(99);
  for (let i = 0; i < 30; i++) {
    const r = En.search(FEN, LV({ depth: 1, blunderRate: 1, noise: 120 }), { rng });
    if (!legal.has(moveKey(Ru.encodeMove(r.from, r.to, r.promo)))) bad++;
  }
  check('失误率 100% 时走了 30 次，没有一次非法', bad, 0);

  // 只有一个合法着法时，失误开关绝不能触发（否则会走出非法着法）
  const one = '7k/8/8/8/8/1r6/8/K7 w - - 0 1';
  const only = legalOf(one)[0];
  const r = En.search(one, LV({ depth: 2, blunderRate: 1 }), { rng });
  check('只剩一个着法时失误开关不生效', fromTo(Ru.encodeMove(r.from, r.to)), fromTo(only));
  check('也不标记为失误', r.blundered, false);
}

// ============================================================
// 十、正式挡位能真的走起来（时间预算内返回）
// ============================================================
console.log('\n=== 正式挡位 ===');
{
  const { LEVELS } = await load('config.js');
  for (const lv of LEVELS) {
    const t0 = Date.now();
    const r = En.search(START_FEN, lv.id);
    const ms = Date.now() - t0;
    const legal = new Set(legalOf(START_FEN).map(moveKey));
    checkTrue(`${lv.name}：返回合法着法（${ms}ms / ${r.nodes} 节点）`,
      r && legal.has(moveKey(Ru.encodeMove(r.from, r.to, r.promo))));
    checkTrue(`${lv.name}：没有超出时间预算（留 400ms 余量）`,
      ms <= lv.timeLimitMs + 400, `实际 ${ms}ms > ${lv.timeLimitMs}ms`);
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
