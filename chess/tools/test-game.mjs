#!/usr/bin/env node
/**
 * 对局状态机测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-game.mjs
 *
 * 这里测的是「改状态机时最容易悄悄弄坏」的地方：悔棋只挪游标（重做免费）、
 * 回看状态下走新着法要截断分支、三次重复只看当前这条线、
 * 悔棋在人机模式退两步而双人模式退一步。
 *
 * 另外钉两条**容易被忽略但会让界面直接坏掉**的性质：
 *   - 走子记录里的着法是**规范编码**（带易位 / 吃过路兵标记位）；
 *   - 只带 from/to/promo 的着法（Worker 的回复就长这样）也能被接受并补齐成规范编码。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN, WHITE, BLACK } = await load('config.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');
const G = await load('game.js');
const Eg = await load('endgames.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const PROMO_CODE = { q: 5, r: 4, b: 3, n: 2 };

/** 把 UCI 文本（`e2e4` / `e7e8q`）变成着法编码。**故意不带标记位** —— 与 Worker 的回复同形 */
function uci(text) {
  const promo = text.length > 4 ? PROMO_CODE[text[4]] : 0;
  return Ru.encodeMove(Pos.squareOf(text.slice(0, 2)), Pos.squareOf(text.slice(2, 4)), promo);
}
const play = (game, text) => G.playMove(game, uci(text));

console.log('对局状态机测试\n');

// --- 初始状态 ---
{
  const g = G.createGame();
  check('起始局面', G.currentFen(g), START_FEN);
  check('没有着法', [g.moves.length, g.cursor], [0, 0]);
  check('轮走白方', G.sideToMove(g), WHITE);
  check('不能悔棋', G.canUndo(g), false);
  check('不在回看状态', G.isReviewing(g), false);
  check('没有上一步（0 = 不画高亮）', G.lastMove(g), 0);
  check('状态是 playing', G.evaluateStatus(g).type, 'playing');
  check('开局 20 个合法着法', G.legalMoves(g).length, 20);
}

// --- 走子与记录 ---
{
  const g = G.createGame();
  const r = play(g, 'e2e4');
  check('走子成功', r.ok, true);
  check('FEN 快照正确', G.currentFen(g),
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  check('记谱算出来了（SAN）', g.moves[0].san, 'e4');
  check('没吃到子时 captured 为 0', g.moves[0].captured, 0);
  check('游标前进', g.cursor, 1);
  check('上一步就是那一步', Ru.moveTo(G.lastMove(g)), Pos.squareOf('e4'));
  check('轮走方变成黑', G.sideToMove(g), BLACK);

  const bad = play(g, 'e7e5'); // 轮到黑，e7e5 其实合法 —— 先试一个真非法的
  check('黑方走 e7e5 也成功', bad.ok, true);

  const g2 = G.createGame();
  const illegal = play(g2, 'e2e5');
  check('非法着法被拒', illegal.ok, false);
  check('非法着法不改状态', [g2.moves.length, g2.cursor], [0, 0]);
  check('被拒时给出原因', typeof illegal.reason === 'string' && illegal.reason.length > 0, true);

  // 吃子记录
  const g3 = G.createGame();
  G.startPosition(g3, '4k3/8/8/4p3/3P4/8/8/4K3 w - - 0 1');
  const cap = play(g3, 'd4e5');
  check('吃子成功', cap.ok, true);
  check('吃子记下被吃的子', g3.moves[0].captured, -1);
  check('吃子的 SAN', g3.moves[0].san, 'dxe5');
  check('吃子把半步计数归零', Pos.parseFen(G.currentFen(g3)).halfmove, 0);
}

// --- Worker 回复那种「只带 from/to/promo」的着法 ---
console.log('\n=== 着法规范化（Worker 只回 from/to/promo）===');
{
  // 易位：引擎（或任何外部调用方）只会说「王从 e1 到 g1」，不带标记位
  const g = G.createGame();
  G.startPosition(g, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const r = play(g, 'e1g1');
  check('不带标记位的易位也能走', r.ok, true);
  check('易位之后的 FEN（车跟着越过王了）', G.currentFen(g),
    'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
  check('存下来的是带 FLAG_CASTLE 的规范编码', Ru.moveFlag(g.moves[0].move), Ru.FLAG_CASTLE);
  check('SAN 是 O-O', g.moves[0].san, 'O-O');

  // 吃过路兵
  const g2 = G.createGame();
  G.startPosition(g2, '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  check('不带标记位的吃过路兵也能走', play(g2, 'e5d6').ok, true);
  check('吃过路兵之后 d5 上的黑兵没了', G.currentFen(g2), '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1');
  check('SAN 按普通吃子形态写', g2.moves[0].san, 'exd6');

  // 升变必须指定升变成什么（不指定就找不到对应的合法着法）
  const g3 = G.createGame();
  G.startPosition(g3, '7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  check('不说升变成什么 → 被拒', play(g3, 'e7e8').ok, false);
  check('说了升变成后 → 通过', play(g3, 'e7e8q').ok, true);
  check('SAN 带 =Q 与将军后缀', g3.moves[0].san, 'e8=Q+');
}

// --- 悔棋与重做 ---
console.log('\n=== 悔棋与重做 ===');
{
  const g = G.createGame({ twoPlayer: true });
  const fens = [G.currentFen(g)];
  for (const m of ['e2e4', 'e7e5', 'g1f3', 'b8c6']) {
    play(g, m);
    fens.push(G.currentFen(g));
  }
  check('走了四步', [g.moves.length, g.cursor], [4, 4]);

  check('悔棋成功', G.undoToPlayer(g), true);
  check('双人模式只退一步', g.cursor, 3);
  check('悔棋后局面回到第三步之后', G.currentFen(g), fens[3]);
  check('着法**没有**被删掉（重做才免费）', g.moves.length, 4);
  check('此刻处在回看状态', G.isReviewing(g), true);

  check('重做（gotoPly 前进）', G.gotoPly(g, 4), true);
  check('重做回到原局面', G.currentFen(g), fens[4]);
  check('重做之后不在回看状态', G.isReviewing(g), false);

  check('跳到起点', G.gotoPly(g, 0), true);
  check('起点就是起始局面', G.currentFen(g), START_FEN);
  check('越界的跳转被拒且不动状态', G.gotoPly(g, 99), false);
  check('越界之后游标没变', g.cursor, 0);
}

// --- 人机模式的悔棋退两步 ---
console.log('\n=== 悔棋（人机模式退到玩家走）===');
{
  const vsAi = G.createGame({ playerSide: WHITE, twoPlayer: false });
  for (const m of ['e2e4', 'e7e5', 'g1f3', 'b8c6']) play(vsAi, m);
  check('轮到玩家（白）走', G.sideToMove(vsAi), WHITE);
  G.undoToPlayer(vsAi);
  check('人机模式退两步（我一手 + AI 应手）', vsAi.cursor, 2);
  check('退完之后确实轮到玩家', G.sideToMove(vsAi), WHITE);

  // 玩家执黑时同理：退到「轮到黑走」（五个半回合之后正好轮到黑）
  const asBlack = G.createGame({ playerSide: BLACK, twoPlayer: false });
  for (const m of ['d2d4', 'd7d5', 'c2c4', 'e7e6', 'g1f3']) play(asBlack, m);
  check('轮到玩家（黑）走', G.sideToMove(asBlack), BLACK);
  G.undoToPlayer(asBlack);
  check('执黑时也退到轮到自己走', G.sideToMove(asBlack), BLACK);
  check('而且退了两步', asBlack.cursor, 3);
}

// --- 回看状态下走新着法要截断 ---
console.log('\n=== 回看状态下走新着法 ===');
{
  const g = G.createGame({ twoPlayer: true });
  for (const m of ['e2e4', 'e7e5', 'g1f3']) play(g, m);
  check('先走三步', g.moves.length, 3);

  // 跳到第 1 步之后轮到黑走，所以「新着法」也得是黑方的（换成 c7c5 而不是原谱的 e7e5）
  G.gotoPly(g, 1);
  const r = play(g, 'c7c5');
  check('回看时走新着法成功', r.ok, true);
  check('后面的分支被截断', g.moves.length, 2);
  check('新着法落在正确的位置', g.moves[1].san, 'c5');
  check('游标在最后', g.cursor, 2);
  check('再也回不到被截断的 e5 / Nf3',
    g.moves.some((m) => m.san === 'e5' || m.san === 'Nf3'), false);
}

// --- 三次重复 ---
console.log('\n=== 三次重复判和 ===');
{
  const g = G.createGame({ twoPlayer: true });
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const m of shuffle) play(g, m);
  check('四个半回合之后回到初始局面', G.currentFen(g),
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3');
  check('这时只是第二次出现 → 还没判和', G.evaluateStatus(g).type, 'playing');

  for (const m of shuffle) play(g, m);
  check('第三次出现 → 三次重复判和', G.evaluateStatus(g).type, 'repetition');
  check('判和没有胜方', G.evaluateStatus(g).winner, null);

  const after = play(g, 'e2e4');
  check('判和之后不能再走子', after.ok, false);
  check('判和之后仍不能走子（原因）', after.reason, '对局已经结束');
}

// --- 其它终局类型 ---
console.log('\n=== 其它终局 ===');
{
  const g = G.createGame();
  G.startPosition(g, 'k7/8/1Q6/8/8/8/8/K7 b - - 0 1');
  check('逼和', G.evaluateStatus(g).type, 'stalemate');

  const g2 = G.createGame();
  G.startPosition(g2, 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1');
  check('将死', G.evaluateStatus(g2).type, 'checkmate');
  check('将死的胜方', G.evaluateStatus(g2).winner, WHITE);

  const g3 = G.createGame();
  G.startPosition(g3, 'k7/8/1Q6/8/8/8/8/K7 w - - 100 60');
  check('50 步和棋', G.evaluateStatus(g3).type, 'fifty');

  const g4 = G.createGame();
  G.startPosition(g4, '7k/8/8/8/8/8/8/KB6 w - - 0 1');
  check('子力不足', G.evaluateStatus(g4).type, 'insufficient');
}

// --- 残局与自由局面 ---
console.log('\n=== 残局与自由局面 ===');
{
  Eg.setCustomEndgames([{
    id: 'test-eg', name: '测试局面', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    result: null, difficulty: null, source: '测试', note: '', custom: true,
  }]);

  const g = G.createGame({ twoPlayer: true });
  play(g, 'e2e4');
  play(g, 'e7e5');

  check('切到残局', G.startEndgame(g, 'test-eg'), true);
  check('残局标记', [g.mode, g.endgameId], ['endgame', 'test-eg']);
  check('起始局面换成残局的 FEN', g.initialFen, '4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  check('着法与游标被清空', [g.moves.length, g.cursor], [0, 0]);
  check('endgameOf 查得到', G.endgameOf(g).name, '测试局面');

  check('切到不存在的局 → false', G.startEndgame(g, 'nope'), false);
  check('失败时不动状态', g.endgameId, 'test-eg');

  check('退出残局', (() => { G.exitEndgame(g); return true; })(), true);
  check('回到标准开局', [g.initialFen, g.mode, g.endgameId], [START_FEN, 'play', null]);
  check('endgameOf 变成 null', G.endgameOf(g), null);

  // 自由局面（分享链接 / 粘 FEN 摆上来）：endgameId 为空，但起始局面不是标准开局
  G.startPosition(g, '8/8/8/4k3/8/8/8/4K3 w - - 0 1');
  check('自由局面：endgameId 为空', g.endgameId, null);
  check('自由局面：endgameOf 为 null', G.endgameOf(g), null);
  check('自由局面：起始局面不是标准开局', g.initialFen !== START_FEN, true);
  check('自由局面的着法被清空', [g.moves.length, g.cursor], [0, 0]);
}

// --- 随机对局冒烟：走合法的着法不会崩，且状态与单步重放一致 ---
console.log('\n=== 随机走子（状态自洽）===');
{
  const g = G.createGame({ twoPlayer: true });
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  let plies = 0;
  for (; plies < 200; plies++) {
    if (G.evaluateStatus(g).type !== 'playing') break;
    const moves = G.legalMoves(g);
    if (moves.length === 0) break;
    const r = G.playMove(g, moves[Math.floor(rnd() * moves.length)]);
    if (!r.ok) { check(`第 ${plies} 步走子失败：${r.reason}`, true, false); break; }
  }
  check(`随机对局走了 ${plies} 步没有崩`, plies > 20, true);

  // 每一步的 FEN 快照都必须是「从起始局面按着法重放」得到的那一个
  let pos = Pos.parseFen(g.initialFen);
  let mismatch = -1;
  for (let i = 0; i < g.moves.length; i++) {
    pos = Ru.makeMove(pos, g.moves[i].move).pos;
    if (Pos.toFen(pos) !== g.moves[i].fenAfter) { mismatch = i; break; }
  }
  check('每一步的 FEN 快照都能重放出来', mismatch, -1);

  // 回退到任意一步，局面都应当与快照一致
  let bad = -1;
  for (let n = 0; n <= g.moves.length; n++) {
    G.gotoPly(g, n);
    const want = n === 0 ? g.initialFen : g.moves[n - 1].fenAfter;
    if (G.currentFen(g) !== want) { bad = n; break; }
  }
  check('任何一步跳转都自洽', bad, -1);
  check('终局原因合理',
    ['playing', 'checkmate', 'stalemate', 'fifty', 'insufficient', 'repetition']
      .includes(G.evaluateStatus(g).type), true);
}

// --- 存档（persist.js）---
// 存档容错放在这个文件里：它管的就是「一局棋的状态」，
// 而容错策略（坏数据整份丢弃 → 退化成全新开局）是状态机的一部分。
console.log('\n=== 存档与容错 ===');
{
  const P = await load('persist.js');

  /** 假 storage：persist.js 的 storage 是注入的，测试不需要真的 localStorage */
  const fake = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      put: (k, v) => { map.set(k, String(v)); },
      raw: (k) => map.get(k),
    };
  };

  check('存档 key 带模块前缀（模块隔离要求）', P.STORAGE_KEY, 'chess:state');

  const st = fake();
  const g = G.createGame({ twoPlayer: true });
  for (const m of ['e2e4', 'e7e5', 'g1f3']) play(g, m);
  G.gotoPly(g, 2);           // 顺手把「回看状态」也存下来
  g.level = 'hard';

  check('存盘成功', P.save(st, g), true);
  check('存的是 JSON 文本', typeof st.raw(P.STORAGE_KEY), 'string');

  const back = G.createGame({ twoPlayer: false });
  check('恢复成功', P.restoreInto(back, st), true);
  check('局面一致', G.currentFen(back), G.currentFen(g));
  check('着法一条不少', back.moves.length, 3);
  check('游标也恢复（回看状态不会丢）', back.cursor, 2);
  check('挡位与双人模式一致', [back.level, back.twoPlayer], ['hard', true]);
  check('恢复之后还能接着走', G.evaluateStatus(back).type, 'playing');
  check('恢复之后走子也正常', play(back, 'f1b5').ok, true);

  // 坏存档一律**整份丢弃**，降级成全新开局 —— 半个对局比没有对局更难查
  const bad = [
    ['不是 JSON', '{ 这不是 json'],
    ['是 JSON 但不是对象', '"hello"'],
    ['版本号不对', JSON.stringify({ v: 99, initialFen: START_FEN, moves: [], cursor: 0, playerSide: 1, level: 'medium' })],
    ['着法不是数组', JSON.stringify({ v: 1, initialFen: START_FEN, moves: 'x', cursor: 0, playerSide: 1, level: 'medium' })],
    ['游标越界', JSON.stringify({ v: 1, initialFen: START_FEN, moves: [], cursor: 3, playerSide: 1, level: 'medium' })],
    ['playerSide 不是 1/-1', JSON.stringify({ v: 1, initialFen: START_FEN, moves: [], cursor: 0, playerSide: 0, level: 'medium' })],
    ['着法缺 sig 字段', JSON.stringify({
      v: 1, initialFen: START_FEN, cursor: 1, playerSide: 1, level: 'medium',
      moves: [{ move: 1, san: 'e4', captured: 0, fenAfter: START_FEN }],
    })],
    ['着法编码越界', JSON.stringify({
      v: 1, initialFen: START_FEN, cursor: 1, playerSide: 1, level: 'medium',
      moves: [{ move: 999999, san: 'e4', captured: 0, fenAfter: START_FEN, sig: 'x' }],
    })],
  ];

  for (const [name, text] of bad) {
    const s = fake();
    s.put(P.STORAGE_KEY, text);
    check(`坏存档（${name}）→ 读出来是 null`, P.load(s), null);

    const fresh = G.createGame();
    play(fresh, 'e2e4'); // 先弄脏，再确认恢复失败时不动它
    check(`坏存档（${name}）→ 恢复失败`, P.restoreInto(fresh, s), false);
    check(`坏存档（${name}）→ 页面状态没被动过`, G.currentFen(fresh),
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  }

  check('拿不到 storage 时存盘返回 false', P.save(null, G.createGame()), false);
  check('拿不到 storage 时读取返回 null', P.load(null), null);
  check('清空存档', (() => {
    const s = fake();
    P.save(s, G.createGame());
    return [P.clear(s), P.load(s)];
  })(), [true, null]);
}

// 收尾：把注入的测试残局清掉，避免影响别的测试共享的状态
Eg.setCustomEndgames([]);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
