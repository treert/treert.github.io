/**
 * 存档的测试（design.md §10、§11.3 里的「存档容错」）。
 *
 * 跑法：node doudizhu/tools/test-persist.mjs
 *
 * 重点不是"能不能存"，而是**输入校验**：坏数据必须被整份拒绝，
 * 而且拒绝之后不能抛、不能影响页面启动。storage 是注入的，所以这些
 * "坏掉的情况"全都能在 Node 里造出来 —— 不需要真的去改浏览器数据。
 */

import { createGame, play, bid, biddingSeat } from '../js/game.js';
import { legalPlays } from '../js/moves.js';
import { viewOf } from '../js/view.js';
import {
  save, load, clear, isValidSave, saveSoon, flush,
  loadStats, recordResult, clearStats, STORAGE_KEY, STATS_KEY,
} from '../js/persist.js';
import { mulberry32 } from '../js/cards.js';

let passed = 0;
const failures = [];

function eq(got, want, msg) {
  if (Object.is(got, want)) { passed++; return; }
  failures.push(`${msg}\n    期望 ${JSON.stringify(want)}\n    实际 ${JSON.stringify(got)}`);
}
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failures.push(msg);
}

/** 一个假的 storage：可以塞初值、可以让它抛 */
function fakeStorage(initial = {}, opts = {}) {
  const data = { ...initial };
  return {
    setItem(k, v) { if (opts.throwOnSet) throw new Error('配额满'); data[k] = String(v); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    removeItem(k) { delete data[k]; },
    _data: data,
  };
}

function rngFrom(seed) {
  return mulberry32(seed);
}

/** 打几手，让对局进入一个"有历史、有底牌、有角色"的状态 */
function playSome(seed, steps) {
  const rng = rngFrom(seed);
  const game = createGame({ rng });
  while (game.phase === 'bidding') {
    const seat = biddingSeat(game);
    const r = bid(game, seat, 3, rng);
    if (!r.ok) break;
  }
  const moveRng = rngFrom(seed + 1);
  let n = 0;
  while (game.phase === 'playing' && n < steps) {
    const seat = game.turn;
    const last = game.trick.lastPlay ? game.trick.lastPlay.combo : null;
    const moves = legalPlays(game.hands[seat], last);
    const r = play(game, seat, moves[Math.floor(moveRng() * moves.length)]);
    if (!r.ok) break;
    n++;
  }
  return game;
}

// ─────────────────────────────────────────────
// 1. 往返：三个阶段的状态都能原样读回来
// ─────────────────────────────────────────────

{
  const cases = [
    ['叫分阶段', createGame({ rng: rngFrom(11) })],
    ['出牌阶段', playSome(23, 9)],
  ];
  // 再补一个"打到结束"的
  const done = playSome(37, 400);
  cases.push(['终局', done]);

  for (const [label, game] of cases) {
    const storage = fakeStorage();
    eq(save(storage, game, 'hard'), true, `${label}：写盘成功`);
    const back = load(storage);
    ok(back !== null, `${label}：能读回来`);
    eq(JSON.stringify(back.game), JSON.stringify(game), `${label}：往返后逐字段一致`);
    eq(back.levelId, 'hard', `${label}：挡位一起存了`);
    ok(isValidSave(back), `${label}：通过校验`);
  }
  eq(done.phase, 'finished', '第三个用例真的打到了终局');

  // 读回来之后还能继续打（不是"看起来像对局、其实不能操作"）
  const mid = playSome(23, 5);
  const storage = fakeStorage();
  save(storage, mid, 'medium');
  const restored = load(storage).game;
  const last = restored.trick.lastPlay ? restored.trick.lastPlay.combo : null;
  const moves = legalPlays(restored.hands[restored.turn], last);
  ok(moves.length > 0, '读回来的对局还能继续出牌');
  const r = play(restored, restored.turn, moves[0]);
  eq(r.ok, true, '读回来的对局里出的第一手是合法的');
  const stillValid = isValidSave({ v: 1, game: restored });
  eq(stillValid, true, '继续打过之后依然通过守恒校验');
}

// ─────────────────────────────────────────────
// 2. 坏数据一律整份拒绝
// ─────────────────────────────────────────────

{
  const good = playSome(51, 6);
  const clone = () => JSON.parse(JSON.stringify(good));
  const wrap = (g) => ({ v: 1, game: g, levelId: 'medium' });

  const badCases = [
    ['不是对象', null],
    ['是字符串', 'nope'],
    ['没有 game', { v: 1 }],
    ['版本不匹配', { v: 99, game: clone() }],
    ['phase 非法', wrap({ ...clone(), phase: 'wat' })],
    ['hands 不是 3 组', wrap({ ...clone(), hands: [[], []] })],
    ['手牌里有越界的牌', wrap((() => { const g = clone(); g.hands[0][0] = 99; return g; })())],
    ['手牌里有重复的牌', wrap((() => { const g = clone(); g.hands[1][0] = g.hands[0][0]; return g; })())],
    ['少了一张牌（不守恒）', wrap((() => { const g = clone(); g.hands[0].pop(); return g; })())],
    ['landlord 越界', wrap({ ...clone(), landlord: 7 })],
    ['turn 越界', wrap({ ...clone(), turn: -1 })],
    ['bidding.order 不是排列', wrap((() => { const g = clone(); g.bidding.order = [0, 0, 1]; return g; })())],
    ['bidding.index 越界', wrap((() => { const g = clone(); g.bidding.index = 9; return g; })())],
    ['calls 里有非法值', wrap((() => { const g = clone(); g.bidding.calls = [9, 0, 0]; return g; })())],
    ['trick.passes 越界', wrap((() => { const g = clone(); g.trick.passes = 5; return g; })())],
    // 注意：不能去改 `trick.lastPlay` —— 有些局面里它是 null（这一墩刚被两家"不要"结束），
    // 那条数据就是合法的、不该被拒。改 history 里的 combo 才是稳定的坏数据。
    ['history 里的 combo.mainRank 越界', wrap((() => {
      const g = clone();
      g.history[0].combo.mainRank = 999;
      return g;
    })())],
    ['history 里的 combo.cards 与 length 对不上', wrap((() => {
      const g = clone();
      g.history[0].combo.cards.pop();
      return g;
    })())],
    ['history 里的 combo.type 不是字符串', wrap((() => {
      const g = clone();
      g.history[0].combo.type = 123;
      return g;
    })())],
    ['history 里的座位越界', wrap((() => {
      const g = clone();
      g.history[0].seat = 5;
      return g;
    })())],
    ['trick.leader 越界', wrap((() => {
      const g = clone();
      g.trick.leader = 3;
      return g;
    })())],
    ['history 里有一条不是对象', wrap((() => { const g = clone(); g.history = [null]; return g; })())],
    ['playedCounts 长度不对', wrap((() => { const g = clone(); g.playedCounts = [0, 0]; return g; })())],
    ['bombs 是负数', wrap((() => { const g = clone(); g.bombs = -1; return g; })())],
  ];

  for (const [label, data] of badCases) {
    eq(isValidSave(data), false, `拒绝：${label}`);
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(data) });
    eq(load(storage), null, `读盘时也拒绝：${label}`);
  }

  // 好数据必须被接受（否则上面那批"拒绝"可能只是因为全都坏了）
  eq(isValidSave(wrap(clone())), true, '同一份数据改成合法之后必须被接受');
}

// ─────────────────────────────────────────────
// 3. storage 不可用 / 写失败 / 坏 JSON，都不能抛
// ─────────────────────────────────────────────

{
  const game = playSome(61, 4);

  eq(save(null, game, 'medium'), false, 'storage 为 null 时写盘返回 false，不抛');
  eq(load(null), null, 'storage 为 null 时读盘返回 null，不抛');
  eq(clear(null), false, 'storage 为 null 时清盘返回 false，不抛');

  eq(save(fakeStorage({}, { throwOnSet: true }), game, 'medium'), false,
    '写盘抛异常（配额满）时返回 false，不抛');

  eq(load(fakeStorage({ [STORAGE_KEY]: '{ 这不是 JSON' })), null, '坏 JSON 被吃掉');
  eq(load(fakeStorage({ [STORAGE_KEY]: 'null' })), null, '字面量 null 被吃掉');
  eq(load(fakeStorage()), null, '没有存档时返回 null');
  eq(load(fakeStorage({ [STORAGE_KEY]: '' })), null, '空串被吃掉');

  // 隐私模式：getItem / setItem 直接抛
  const hostile = {
    getItem() { throw new Error('隐私模式'); },
    setItem() { throw new Error('隐私模式'); },
    removeItem() { throw new Error('隐私模式'); },
  };
  eq(load(hostile), null, '读盘抛异常时返回 null');
  eq(save(hostile, game, 'medium'), false, '写盘抛异常时返回 false');
  eq(clear(hostile), false, '清盘抛异常时返回 false');
}

// ─────────────────────────────────────────────
// 4. 防抖与立刻写
// ─────────────────────────────────────────────

{
  const storage = fakeStorage();
  const game = playSome(71, 3);

  for (let i = 0; i < 5; i++) saveSoon(game, 'easy', 50, storage);
  eq(storage.getItem(STORAGE_KEY), null, '防抖窗口内还没落盘');

  await new Promise((r) => setTimeout(r, 120));
  ok(storage.getItem(STORAGE_KEY) !== null, '窗口过去之后落盘了');
  eq(JSON.parse(storage.getItem(STORAGE_KEY)).levelId, 'easy', '存进去的是最后一次的挡位');

  // flush 立刻写
  const s2 = fakeStorage();
  saveSoon(game, 'hard', 5000, s2);
  eq(flush(game, 'hard', s2), true, 'flush 返回成功');
  ok(s2.getItem(STORAGE_KEY) !== null, 'flush 立刻落了盘');

  // clear
  eq(clear(storage), true, 'clear 成功');
  eq(load(storage), null, 'clear 之后读不到');
}

// ─────────────────────────────────────────────
// 5. 战绩累计
// ─────────────────────────────────────────────

{
  const storage = fakeStorage();
  let s = loadStats(storage);
  eq(s.games, 0, '初始战绩是空的');
  eq(s.bestMultiplier, 1, '初始最高倍数是 1');

  recordResult(storage, { myRole: 'landlord', myTeamWon: true, multiplier: 6 });
  recordResult(storage, { myRole: 'farmer', myTeamWon: true, multiplier: 2 });
  recordResult(storage, { myRole: 'farmer', myTeamWon: false, multiplier: 12 });
  s = loadStats(storage);
  eq(s.games, 3, '累计 3 局');
  eq(s.wins, 2, '赢了 2 局');
  eq(s.landlordGames, 1, '当过一次地主');
  eq(s.landlordWins, 1, '当地主那次赢了');
  eq(s.bestMultiplier, 12, '最高倍数记到了 12');

  // 坏战绩数据不能让页面炸，也不能污染显示
  const broken = fakeStorage({ [STATS_KEY]: '{"v":1,"games":"很多","wins":-5,"bestMultiplier":"x"}' });
  const b = loadStats(broken);
  eq(b.games, 0, '坏字段被当成 0');
  eq(b.wins, 0, '负数被当成 0');
  eq(b.bestMultiplier, 1, '非数字的倍数被当成 1');

  eq(loadStats(fakeStorage({ [STATS_KEY]: '不是 JSON' })).games, 0, '坏 JSON 的统计被吃掉');
  eq(loadStats(null).games, 0, 'storage 为 null 时统计为空');

  eq(clearStats(storage), true, '清空战绩成功');
  eq(loadStats(storage).games, 0, '清空之后是 0');

  // 写不进去也不能抛
  const hostile = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  ok(recordResult(hostile, { myRole: 'farmer', myTeamWon: false, multiplier: 1 }) !== null,
    '战绩写不进去时也要返回一份可用的统计，不抛');
}

// ─────────────────────────────────────────────
// 6. 一个真实的"关掉再打开"流程
// ─────────────────────────────────────────────

{
  const storage = fakeStorage();
  const game = playSome(83, 12);
  save(storage, game, 'hard');

  // 模拟重新打开页面：新建一个 game，然后看看读回来的那份跟原来一模一样
  const restored = load(storage);
  ok(restored !== null, '模拟重启：读到了存档');
  eq(JSON.stringify(restored.game), JSON.stringify(game), '模拟重启：对局状态完全一致');

  // view 也必须一致 —— 这是界面与 AI 看到的那一份
  for (let seat = 0; seat < 3; seat++) {
    eq(JSON.stringify(viewOf(restored.game, seat)), JSON.stringify(viewOf(game, seat)),
      `模拟重启：座位 ${seat} 的 view 一致`);
  }
}

// === 收尾 ===
console.log(`test-persist: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures.slice(0, 20)) console.log('  ✗ ' + f);
  if (failures.length > 20) console.log(`  …还有 ${failures.length - 20} 条`);
  process.exit(1);
}
