/**
 * AI 层的测试（design.md §11.4）。**本模块最重要的一组。**
 *
 * 跑法：node doudizhu/tools/test-ai.mjs
 *
 * 组内四条。(c) 挡位开关对照组**还没写** —— 原计划是"等第 6 步 PIMC 接上再补"，
 * 第 6 步做完了但没回头补，记在 future-work 的 A 节（设计里唯一一处"写了没做"的缺口）。
 * 目前 `tools/diag-ai.mjs` 在运行期量着同一件事（关掉采样 20.1% 的着法会变、
 * 关掉搜索 10.3% 会变），但那是读数不是断言，不会变红。
 *
 *   (a) **不含偷看** —— 本文件的核心
 *   (b) 只出合法牌
 *   (d) 可复现
 *
 * (a) 的构造值得说清楚，因为它容易被误解成"循环论证"：
 *
 *   造两份**公开信息完全相同、只有隐藏信息不同**的对局，
 *   断言 ① `viewOf` 给出的两个 view 完全相同，② `decide` 的结论也完全相同。
 *
 *   第 ② 条在 `decide` 纯函数的前提下是自动成立的（同样的输入当然同样的输出）——
 *   它真正防的是 **AI 里藏了模块级可变状态**（缓存、全局变量），
 *   那种东西会让"看起来纯"的函数在第二次调用时给出不同结果。
 *   而第 ① 条才是那个正面证明：**view 不随隐藏信息变化**。
 *   如果哪天有人图省事把 `game` 整个塞进 view，第 ① 条立刻红。
 */

import { sortHand, shuffle } from '../js/cards.js';
import { createGame, play, bid, biddingSeat } from '../js/game.js';
import { viewOf } from '../js/view.js';
import { decide } from '../js/ai/index.js';
import { LEVELS, findLevel } from '../js/config.js';

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

function rngFrom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 深拷贝一份对局 —— 顺带验证了 §4.4 那句"状态是纯 JSON 可序列化的" */
function clone(game) {
  return JSON.parse(JSON.stringify(game));
}

/**
 * 造一个「公开信息相同、隐藏信息不同」的孪生对局。
 *
 * 做法：把**除底牌之外**的、属于另外两家的牌合起来重新洗一遍，再按原来的张数分回去。
 * 底牌保持不动 —— 它是公开信息，动了就不叫"只有隐藏信息不同"了。
 *
 * 比"交换两张牌"强得多：那种只差两张，如果泄漏恰好对交换不变就漏过去了。
 */
function retwin(game, seat, rng) {
  const g = clone(game);
  const a = (seat + 1) % 3;
  const b = (seat + 2) % 3;
  const trumpSet = new Set(g.trump);

  const held = (s) => g.hands[s].filter((c) => trumpSet.has(c));
  const rest = (s) => g.hands[s].filter((c) => !trumpSet.has(c));
  const aHeld = held(a);
  const bHeld = held(b);

  const pool = shuffle([...rest(a), ...rest(b)], rng);
  const aRest = pool.slice(0, g.hands[a].length - aHeld.length);
  g.hands[a] = sortHand([...aHeld, ...aRest]);
  g.hands[b] = sortHand([...bHeld, ...pool.slice(aRest.length)]);
  return g;
}

/** 走几步，好让 view 里带上出牌历史、底牌、角色这些东西 */
function advance(game, rng, steps) {
  let guard = 0;
  while (game.phase === 'bidding' && guard++ < 20) {
    const seat = biddingSeat(game);
    const r = bid(game, seat, rng() < 0.5 ? 0 : 3, rng);
    if (!r.ok) break;
  }
  let n = 0;
  while (game.phase === 'playing' && n < steps) {
    const seat = game.turn;
    const view = viewOf(game, seat);
    const move = decide(view, findLevel('medium'), rng);
    const r = play(game, seat, move);
    if (!r.ok) break;
    n++;
  }
  return game;
}

// ─────────────────────────────────────────────
// (a) 不含偷看 —— 核心
// ─────────────────────────────────────────────

{
  let checked = 0;
  let hiddenDiffers = 0;

  for (let round = 0; round < 60; round++) {
    const rng = rngFrom(1000 + round);
    const game = createGame({ rng });
    advance(game, rng, round % 12);           // 覆盖开局 / 中期 / 残局前

    for (const seat of [0, 1, 2]) {
      if (game.phase !== 'playing') continue;
      if (game.hands[(seat + 1) % 3].length === 0) continue;

      const twin = retwin(game, seat, rng);
      const v1 = viewOf(game, seat);
      const v2 = viewOf(twin, seat);

      // 两个真相必须真的不同，否则这个测试什么也没证明
      const truthDiffers = JSON.stringify(game.hands) !== JSON.stringify(twin.hands);
      if (truthDiffers) hiddenDiffers++;

      eq(JSON.stringify(v2), JSON.stringify(v1),
        `座位 ${seat}：换了隐藏信息之后 view 必须一模一样（第 ${round} 轮）`);

      // 四个挡位都要过 —— 弱挡位同样不许偷看
      for (const level of LEVELS) {
        const m1 = decide(v1, level, rngFrom(7));
        const m2 = decide(v2, level, rngFrom(7));
        eq(JSON.stringify(m2), JSON.stringify(m1),
          `座位 ${seat} 挡位 ${level.name}：同 view 不同真相 → 决策必须相同`);
      }

      // 反过来：view 里不该出现任何"别家的牌"
      ok(!('hands' in v1), 'view 里不能有 hands 键');
      ok(!('opponentHands' in v1), 'view 里不能有 opponentHands 键');
      for (const p of v1.players) {
        ok(!('hand' in p) && !('cards' in p), 'players 里只能有张数，不能有牌面');
      }
      checked++;
    }
  }

  ok(checked > 100, `覆盖足够多的局面（实际 ${checked}）`);
  eq(hiddenDiffers, checked, '每一个孪生对局的隐藏信息都真的不同（否则这个测试是空跑）');
  console.log(`  (a) 不含偷看：${checked} 个局面 × ${LEVELS.length} 个挡位`);
}

// ─────────────────────────────────────────────
// (b) 只出合法牌
// ─────────────────────────────────────────────

{
  let tried = 0;
  for (let round = 0; round < 120; round++) {
    const rng = rngFrom(5000 + round);
    const game = createGame({ rng });
    advance(game, rng, round % 30);

    for (const level of LEVELS) {
      // 每次都在**同一个局面**上问所有挡位，顺便覆盖"某个挡位恰好只剩一个候选"
      for (const seat of [0, 1, 2]) {
        if (game.phase !== 'playing' || game.turn !== seat) continue;
        const view = viewOf(game, seat);
        const move = decide(view, level, rngFrom(round * 31 + seat));
        ok(move !== null, `挡位 ${level.name}：有牌可出时不能返回 null`);
        if (!move) continue;

        // 用**独立的副本**去校验，避免这次调用改坏了原局面
        const probe = clone(game);
        const r = play(probe, seat, move);
        ok(r.ok, `挡位 ${level.name} 座位 ${seat} 出了非法着法：${r.reason}\n    ${JSON.stringify(move)}`);
        if (move.kind === 'play') {
          ok(move.cards.length > 0, '出牌不能是空数组');
          ok(new Set(move.cards).size === move.cards.length, '出牌不能有重复的牌');
        }
        tried++;
      }
    }
  }
  ok(tried > 200, `覆盖足够多的着法（实际 ${tried}）`);
  console.log(`  (b) 只出合法牌：${tried} 次决策`);
}

// ─────────────────────────────────────────────
// (d) 可复现
// ─────────────────────────────────────────────

{
  let checked = 0;
  for (let round = 0; round < 40; round++) {
    const rng = rngFrom(9000 + round);
    const game = createGame({ rng });
    advance(game, rng, round % 15);
    if (game.phase !== 'playing') continue;

    for (const seat of [0, 1, 2]) {
      const view = viewOf(game, seat);
      for (const level of LEVELS) {
        const a = decide(view, level, rngFrom(123));
        const b = decide(view, level, rngFrom(123));
        eq(JSON.stringify(b), JSON.stringify(a),
          `挡位 ${level.name}：同 view + 同 seed 必须给同一个结果`);
        checked++;
      }
    }
  }
  ok(checked > 100, `覆盖足够多的组合（实际 ${checked}）`);
  console.log(`  (d) 可复现：${checked} 次`);
}

// ─────────────────────────────────────────────
// 一个额外的哨兵：view 是纯 JSON 可序列化的（Worker 通信的前提）
// ─────────────────────────────────────────────

{
  const rng = rngFrom(777);
  const game = createGame({ rng });
  advance(game, rng, 6);
  for (const seat of [0, 1, 2]) {
    const v = viewOf(game, seat);
    eq(JSON.stringify(JSON.parse(JSON.stringify(v))), JSON.stringify(v),
      'view 必须能被 JSON 往返（不然丢不进 Worker）');
  }
  console.log('  哨兵：view 可 JSON 往返（Worker 通信的前提）');
}

// === 收尾 ===
console.log(`test-ai: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures.slice(0, 15)) console.log('  ✗ ' + f);
  if (failures.length > 15) console.log(`  …还有 ${failures.length - 15} 条`);
  process.exit(1);
}
