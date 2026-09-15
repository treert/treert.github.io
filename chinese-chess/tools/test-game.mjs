#!/usr/bin/env node
/**
 * 对局状态机测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-game.mjs
 *
 * 这里测的是「悔棋 / 复盘跳转 / 截断」这些**只在多步之后才暴露**的行为。
 * 单步走子错了会立刻看出来，但 cursor 管理错了只会表现为「点了几下之后棋盘不对」，
 * 而且极难复现，所以必须钉住。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { START_FEN } = await load('config.js');
const G = await load('game.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const idx = (coord) => {
  const [x, y] = coord.split(',').map(Number);
  return y * 9 + x;
};
/** 用坐标写一步棋，避免手算 from * 90 + to 出错 */
const mk = (from, to) => idx(from) * 90 + idx(to);

/** 挑一个合法着法：优先吃子，其次第一个 */
function pickMove(game) {
  const legal = G.legalMoves(game);
  const pos = G.currentPosition(game);
  const capture = legal.find((m) => pos.cells[m % 90] !== 0);
  return capture !== undefined ? capture : legal[0];
}

console.log('对局状态机测试\n');

// --- 基本走子 ---
{
  const g = G.createGame();
  check('新对局：cursor 为 0', g.cursor, 0);
  check('新对局：当前局面就是起始局面', G.currentFen(g), START_FEN);
  check('新对局：没有上一步', G.lastMove(g), 0);
  check('新对局：轮到红方', G.sideToMove(g), 1);
  check('新对局：不能悔棋', G.canUndo(g), false);
  check('新对局：不在回看状态', G.isReviewing(g), false);

  const before = G.currentFen(g);
  const r = G.playMove(g, pickMove(g));
  check('走一步成功', r.ok, true);
  check('走一步后 cursor 为 1', g.cursor, 1);
  check('走一步后轮到黑方', G.sideToMove(g), -1);
  check('走一步后局面变了', G.currentFen(g) !== before, true);
  check('走一步后可以悔棋', G.canUndo(g), true);
  check('着法列表长度为 1', G.moveList(g).length, 1);
  check('着法列表里有中文记谱', typeof G.moveList(g)[0].notation, 'string');
  check('上一步就是刚走的那一步', G.lastMove(g), g.moves[0].move);
}

// --- 非法着法必须被拒 ---
{
  const g = G.createGame();
  check('全 0 的着法被拒', G.playMove(g, 0).ok, false);
  check('被拒之后 cursor 不变', g.cursor, 0);
  check('被拒之后着法表为空', g.moves.length, 0);

  const legal = new Set(G.legalMoves(g));
  let bad = -1;
  for (let m = 0; m < 8100; m++) {
    const from = Math.floor(m / 90), to = m % 90;
    if (from !== to && !legal.has(m)) { bad = m; break; }
  }
  check('任意非合法着法都被拒', G.playMove(g, bad).ok, false);
  check('连续被拒后状态仍然干净', [g.cursor, g.moves.length], [0, 0]);
}

// --- 悔棋：只移动游标，不删着法 ---
{
  const g = G.createGame();
  const start = G.currentFen(g);
  for (let i = 0; i < 4; i++) G.playMove(g, pickMove(g));
  check('走 4 步后 cursor 为 4', g.cursor, 4);
  check('走 4 步后着法数 4', g.moves.length, 4);

  const fen4 = G.currentFen(g);
  G.undo(g);
  check('悔棋后 cursor 为 3', g.cursor, 3);
  check('悔棋后着法数仍是 4（只移游标）', g.moves.length, 4);
  check('悔棋后局面确实变了', G.currentFen(g) !== fen4, true);
  check('悔棋后处于回看状态', G.isReviewing(g), true);

  G.undo(g, 3);
  check('一次退 3 步回到起始局面', G.currentFen(g), start);
  check('退到底后不能继续悔棋', G.undo(g), false);
  check('退到底后 cursor 不会变负', g.cursor, 0);
}

// --- 回看状态下走新着法：必须截断后面的分支 ---
{
  const g = G.createGame();
  for (let i = 0; i < 4; i++) G.playMove(g, pickMove(g));
  const dropped = g.moves[3].notation;

  G.gotoPly(g, 2);
  check('跳回第 2 步后处于回看状态', G.isReviewing(g), true);

  const r = G.playMove(g, pickMove(g));
  check('回看状态下可以走新着法', r.ok, true);
  check('走新着法后着法数变成 3（旧分支被截断）', g.moves.length, 3);
  check('走新着法后不再是回看状态', G.isReviewing(g), false);
  check('被截断的那一步已经不在列表里',
    g.moves.some((m) => m.notation === dropped), false);
}

// --- 复盘跳转 ---
{
  const g = G.createGame();
  const fens = [START_FEN];
  for (let i = 0; i < 5; i++) { G.playMove(g, pickMove(g)); fens.push(G.currentFen(g)); }

  let allMatch = true;
  for (let n = 0; n <= 5; n++) {
    G.gotoPly(g, n);
    if (G.currentFen(g) !== fens[n]) allMatch = false;
  }
  check('跳转到任意一步都能还原当时的局面', allMatch, true);
  check('跳转越界被拒', G.gotoPly(g, 99), false);
  check('跳转负数被拒', G.gotoPly(g, -1), false);
}

// --- 重置 ---
{
  const g = G.createGame();
  for (let i = 0; i < 3; i++) G.playMove(g, pickMove(g));
  G.reset(g);
  check('重置后 cursor 为 0', g.cursor, 0);
  check('重置后着法清空', g.moves.length, 0);
  check('重置后回到起始局面', G.currentFen(g), START_FEN);
}

// --- 终局判定：一步杀 ---
{
  // 黑将 (3,0)；红车 (4,5) 封住逃路 (4,0)；红车 (0,9) 平到 (3,9) 将军
  const g = G.createGame({ initialFen: '3k5/9/9/9/9/4R4/9/9/9/R3K4 w - - 0 1' });
  check('杀着之前是进行中', G.evaluateStatus(g).type, 'playing');

  const mate = mk('0,9', '3,9');
  check('那步杀着在合法着法表里', G.legalMoves(g).includes(mate), true);
  check('走杀着成功', G.playMove(g, mate).ok, true);

  const st = G.evaluateStatus(g);
  check('走完杀着后判定为将死', st.type, 'checkmate');
  check('胜方是红方', st.winner, 1);
  check('终局后不能再走子', G.playMove(g, 0).ok, false);
}

// --- 三次重复 ---
// 用固定循环精确制造重复，不靠「反复走第一个合法着法」碰运气：
// 车 (0,9) 和将 (4,0) 各来回一步，4 步后回到起始局面，8 步后起始局面出现第 3 次。
{
  const startFen = '4k4/9/9/9/9/9/9/9/9/R4K3 w - - 0 1';
  const cycle = [mk('0,9', '0,8'), mk('4,0', '3,0'), mk('0,8', '0,9'), mk('3,0', '4,0')];
  const g = G.createGame({ initialFen: startFen });

  let ok = true;
  for (let round = 0; round < 2; round++) {
    for (const m of cycle) {
      if (!G.playMove(g, m).ok) ok = false;
    }
  }
  check('循环着法全程合法', ok, true);
  check('走完两轮后 cursor 为 8', g.cursor, 8);
  check('回到与起始相同的局面', G.currentFen(g), startFen);
  check('起始局面出现第 3 次，判为重复', G.evaluateStatus(g).type, 'repetition');
  check('重复判和时没有胜方', G.evaluateStatus(g).winner, null);
}

// --- 人机对弈用的悔棋：一次退到玩家走棋 ---
{
  const g = G.createGame({ playerSide: 1 });
  for (let i = 0; i < 5; i++) G.playMove(g, pickMove(g));
  // cursor = 5，轮到黑方（非玩家）
  check('第 5 步后轮到黑方', G.sideToMove(g), -1);

  G.undoToPlayer(g);
  check('退到玩家走棋后轮到红方', G.sideToMove(g), 1);
  check('cursor 退到 4', g.cursor, 4);
  check('着法数没有变（只移游标）', g.moves.length, 5);
}

// --- 存档（persist.js） ---
// storage 是注入的，所以不需要真的 localStorage。这里重点测**容错**：
// 存档坏掉导致白屏是最糟糕的体验，宁可丢掉一局棋也不能让页面起不来。
{
  const P = await load('persist.js');

  const fakeStorage = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  };

  check('存档 key 带模块前缀', P.STORAGE_KEY, 'chinese-chess:state');

  // 往返一致
  {
    const g = G.createGame();
    for (let i = 0; i < 4; i++) G.playMove(g, pickMove(g));
    const st = fakeStorage();
    check('保存成功', P.save(st, g), true);

    const g2 = G.createGame();
    check('恢复成功', P.restoreInto(g2, st), true);
    check('恢复后着法数一致', g2.moves.length, g.moves.length);
    check('恢复后游标一致', g2.cursor, g.cursor);
    check('恢复后当前局面一致', G.currentFen(g2), G.currentFen(g));
    check('恢复后挡位一致', g2.level, g.level);
  }

  check('没有存档时恢复失败', P.restoreInto(G.createGame(), fakeStorage()), false);

  // 坏数据一律被拒，且绝不抛异常
  const cases = [
    ['不是 JSON', 'not json at all'],
    ['不是对象', '"hello"'],
    ['版本号不对', JSON.stringify({ v: 999, initialFen: START_FEN, moves: [], cursor: 0, playerSide: 1 })],
    ['游标越界', JSON.stringify({ v: 1, initialFen: START_FEN, moves: [], cursor: 5, playerSide: 1 })],
    ['着法字段缺失', JSON.stringify({ v: 1, initialFen: START_FEN, moves: [{ move: 1 }], cursor: 1, playerSide: 1 })],
    ['执子方非法', JSON.stringify({ v: 1, initialFen: START_FEN, moves: [], cursor: 0, playerSide: 0 })],
    ['initialFen 不是字符串', JSON.stringify({ v: 1, initialFen: 42, moves: [], cursor: 0, playerSide: 1 })],
  ];
  for (const [name, raw] of cases) {
    const st = fakeStorage({ [P.STORAGE_KEY]: raw });
    let result;
    try {
      result = P.restoreInto(G.createGame(), st);
    } catch (e) {
      result = `抛异常：${e.message}`;
    }
    check(`坏存档被拒且不抛异常（${name}）`, result, false);
  }

  // 写入失败（配额满 / 隐私模式）也不能让页面崩
  {
    const st = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    let threw = false;
    let ret = null;
    try { ret = P.save(st, G.createGame()); } catch { threw = true; }
    check('存档写入失败时返回 false 而不是抛异常', [threw, ret], [false, false]);
  }

  check('清空存档', P.clear(fakeStorage({ [P.STORAGE_KEY]: '{}' })), true);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
