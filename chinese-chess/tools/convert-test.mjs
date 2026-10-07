#!/usr/bin/env node
/**
 * **定式转换测试** —— 拿**结果已知**的残局，让模块自己走到终局，看它**赢了没有 / 和住了没有**。
 * （离线工具，不参与网页运行；`--defender pf:*` 那档需要本地有 Pikafish。）
 *
 * ## 实测（2026-10-06，防守方 Pikafish depth 12 / 16）
 *
 * | 局面集 | 盘数 | 结果 |
 * |---|---|---|
 * | 实用残局（`practical`，8 局） | 8 | **8 / 8**，depth 16 上同样 8/8 |
 * | 卷六「和局研究」（`composed-endgame`，**全 84 局**） | 84 | `--depth 6` **69 / 84**（71 秒）；真实预算复核后真失败 **7** 局 |

 * ⚠️ **汇总稳、逐局不稳**（2026-10-07 查清，见 `decisions.md` 第 28 条）：同一配置只换对手线程数，
 * 汇总 69/84 vs 70/84（差 1 局），但**失败清单只重合 9 个**（14 个里）。两个抖动源已查明 ——
 * Pikafish 多线程（**已修**：默认 `--pf-threads 1`）与连将杀探测的 1400ms 墙钟上限（未修）。
 * **所以它只能看「总数有没有掉」，别把某一局的 ✅/❌ 当回归项。**
 *
 * **固定深度还会明显高估失败**：84 局里 `--depth 6` 报 15 个 ❌，逐个拿真实预算复核后只剩 **7** 个
 * （浅一层就差得远：`第493局` 在深度 6 上自己走成长将判负，真实预算下 15 半回合就将死对方）。
 * 推荐的用法：`--depth 6` 跑总数，**任何看不懂的 ❌ 再拿真实预算复核一局**（约 1 分钟）。
 * 那 7 个真失败：`第470局` 和棋走输、`第480局` **赢棋走和**、`第495局`/`第527局` 被将死、
 * `第518局` **自己长将判负**、`第532局`/`第536局` **被困毙**（象棋里困毙判负）。
 *
 * ⚠️ 8 局实用残局的**难度很不均匀**：`单车例胜单士` 其实是 **3 步的困毙小技**
 * （`车九进九 将5进1 车九平四 将5进1 车四退一` 困毙），`单马必胜单将` 3 半回合，
 * 而 `马擒单士` 要 37~41 半回合。所以 8/8 **不代表残局功力够**，只说明「这几道快题不会错」。
 *
 * ## 它补的是哪个缺口
 *
 * `strength.mjs` / `eval-compare.mjs` 量的是「**这一步**亏多少 cp」—— 那是逐手的平均值。
 * 有一类毛病会被它平均掉：**赢棋走和、和棋走输**（残局里磨了半天没进展、
 * 或者把理论上和的局面走输了）。2026-10-06 试着建「跟 Pikafish 打盘数」的指标来补这个缺口，
 * 结论是**不划算**（每盘 1.5~2 分钟，分辨 5 个百分点要 ~380 盘 ≈ 10 小时，而且一半的胜局
 * 来自「对方长将判负」这种规则性胜利 —— 见 `decisions.md` 第 26 条）。
 * 但那次也确认了缺口是真的（有几局撞上限判和），所以改用这个**便宜得多**的定向测试。
 *
 * 它便宜在两处：**不用裁判**（模块自己走完就行）、**结果是二值的**（赢 / 没赢，
 * 噪声远小于胜率）。用的局面是仓库里现成的：`js/endgames.js` 的**实用残局**那一页
 * （教材定式，`result` 字段就是权威结论）。
 *
 * ## 谁执哪一方
 *
 * - `result: 'win'`（先手必胜）⇒ 模块执**走子方**，期望**赢**；
 * - `result: 'draw'`（和棋）⇒ 模块执**另一方**，期望**和**（测「守得住吗」）；
 * - `result: 'loss'`（先手必负）⇒ 模块执**另一方**，期望**赢**。
 *
 * `--defender` 决定对手是谁：`pf:12`（默认，Pikafish 限深 —— 一个**认真的防守方**）
 * 或 `self`（模块自己走两边 —— 更便宜，但防守方也只有模块的水平，会**高估**通过率）。
 *
 * ## 判和的三条（都算「没赢下来」）
 *
 * - 三次重复判和（用模块自己的规则层）；
 * - **自然限着**：连续 120 个半回合没有吃子（棋规是 60 回合）—— 这条正是「赢棋走和」的探测器；
 * - 撞上 `--max-ply` 上限。
 *
 * ## 用法
 *
 *   node chinese-chess/tools/convert-test.mjs                       # 实用残局 8 局，防守方 Pikafish depth 12
 *   node chinese-chess/tools/convert-test.mjs --defender self       # 模块自己走两边（快，不用引擎）
 *   node chinese-chess/tools/convert-test.mjs --ids ma-qin-dan-shi
 *   node chinese-chess/tools/convert-test.mjs --depth 6             # 固定深度 ⇒ **可复现**
 *   node chinese-chess/tools/convert-test.mjs --category composed-endgame --limit 20  # 和局研究那一页
 *
 * 一整页跑不完就**分批**（`--skip` 从第几局开始 + `--out` 逐局追加 JSONL，跑完再汇总）：
 *
 *   node chinese-chess/tools/convert-test.mjs --category composed-endgame --depth 6 --skip 0  --limit 20 --out tmp/convert.jsonl
 *   node chinese-chess/tools/convert-test.mjs --category composed-endgame --depth 6 --skip 20 --limit 20 --out tmp/convert.jsonl
 *   ...  --skip 40 / --skip 60 / --skip 80 ...
 *
 * ## 怎么读
 *
 * - **它是回归护栏，不是棋力尺子**：局面几十个，分辨不了「强了 2cp」；
 *   它回答的是「**已经能赢的，还赢不赢得了**」。
 * - **默认用挡位的时间预算 ⇒ 每次跑都不一样**（同一个局面两次跑出过不同的结局）。
 *   要拿它当护栏就加 `--depth`（固定深度、确定性），代价是「真实预算下会怎样」不再被覆盖。
 * - `self` 与 `pf:12` 的差距本身有信息：前者明显更高，说明失分主要发生在
 *   「对手不配合」的时候。
 * - **判和的三种都算「没赢下来」**，其中「连续 120 半回合无吃子」是那条真正管用的
 *   「赢棋走和」探测器（棋规的自然限着就是 60 回合）。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');
const load = (rel) => import(pathToFileURL(resolve(HERE, '../js', rel)).href);

const { CELLS, EMPTY, RED, LEVELS } = await load('config.js');
const { search, evaluate } = await load('engine.js');
const { generateLegalMoves, gameStatus, classifyRepetition, inCheck } = await load('rules.js');
const { parseFen, toFen, positionSignature } = await load('position.js');
const { moveOfIccs, iccsOfMove } = await load('iccs.js');
const { toNotation } = await load('notation.js');
const { endgamesByCategory, findEndgame } = await load('endgames.js');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const CATEGORY = arg('category', 'practical');
const IDS = arg('ids', '');
const LIMIT = Number(arg('limit', 999));
const SKIP = Number(arg('skip', 0));         // 分批跑：从第几局开始
const OUT = arg('out', '');                  // 逐局追加 JSONL（分批跑完再汇总）
const DEFENDER = arg('defender', 'pf:12');
/**
 * 防守方（Pikafish）的线程数。
 *
 * **默认 1 —— 这是「可复现」的关键**：多线程搜索（4 线程）在固定深度下**每次跑出的着法都可能不同**，
 * 于是对局会分岔。2026-10-07 实测：同一个局面、同样 `--depth 6`，两次跑出完全不同的过程
 * （一次 37 半回合被将死、另一次约 100 半回合）。而把防守方换成模块自己（`--defender self`）
 * 两遍一模一样 —— 所以抖动**只来自引擎的多线程**，不是模块侧。
 * 单线程在固定深度下是确定的；代价是引擎每步慢一些（可接受：84 局也就一两分钟）。
 */
const PF_THREADS = Number(arg('pf-threads', 1));
const MAX_PLY = Number(arg('max-ply', 300));
const VERBOSE = process.argv.includes('--verbose');
/** 诊断模式：逐步打印 走子方 / 着法 / 合法着法数 / 静态评估 /（模块的）自评 —— 用来查「哪一步开始输」 */
const WHY = process.argv.includes('--why');
const NO_CAPTURE_PLY = Number(arg('no-capture', 120));   // 棋规：60 回合（=120 半回合）无吃子判和
const LEVEL = String(arg('level', 'hard'));
// >0 = 固定深度（**模块这一侧确定**；要整局可复现还得 `--pf-threads 1`）；0 = 用挡位的时间预算
const DEPTH = Number(arg('depth', 0));
const baseLevel = LEVELS.find((l) => l.id === LEVEL);
const level = DEPTH > 0
  ? { ...baseLevel, depth: DEPTH, timeLimitMs: 600000, noise: 0, blunderRate: 0 }
  : baseLevel;

const all = endgamesByCategory(CATEGORY);
const picked = (IDS ? IDS.split(',').map((s) => s.trim()) : all.map((e) => e.id))
  .map((id) => all.find((e) => e.id === id) || findEndgame(id))
  .filter(Boolean)
  .slice(SKIP, SKIP + LIMIT);
if (!picked.length) { console.log(`「${CATEGORY}」里没有找到局面`); process.exit(1); }

const pfDepth = DEFENDER.startsWith('pf:') ? Number(DEFENDER.slice(3)) : 0;
let proc = null;
let send = null;
let waitLine = null;
async function startEngine() {
  proc = spawn(EXE, [], { cwd: dirname(EXE) });
  proc.on('error', (e) => { console.log('引擎启动失败：', e.message); process.exit(1); });
  const pending = []; let waiter = null;
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (waiter && waiter.pred(line)) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(line); return; }
    pending.push(line);
  });
  send = (s) => proc.stdin.write(`${s}\n`);
  waitLine = (pred, ms, what) => new Promise((res, rej) => {
    const i = pending.findIndex(pred);
    if (i >= 0) { res(pending.splice(i, 1)[0]); return; }
    const timer = setTimeout(() => { waiter = null; rej(new Error(`等「${what}」超时`)); }, ms);
    waiter = { pred, resolve: res, timer };
  });
  send('uci');
  await waitLine((l) => l === 'uciok', 20000, 'uciok');
  send(`setoption name Threads value ${PF_THREADS}`);
  send('setoption name Hash value 128');
  send('isready');
  await waitLine((l) => l === 'readyok', 30000, 'readyok');
}
async function pfMove(fen) {
  send(`position fen ${fen}`);
  send(`go depth ${pfDepth}`);
  for (;;) {
    const l = await waitLine((x) => x.startsWith('bestmove'), 120000, 'bestmove');
    const bm = l.split(/\s+/)[1] || '';
    if (/^[a-i][0-9][a-i][0-9]$/.test(bm)) return bm;
    return null;
  }
}

console.log(`定式转换测试｜「${CATEGORY}」${picked.length} 局｜模块挡位 ${LEVEL}`
  + `（${DEPTH > 0 ? `固定深度 ${DEPTH}，可复现` : `${level.timeLimitMs}ms/步，每次会不一样`}）`
  + `｜防守方 ${DEFENDER === 'self' ? '模块自己' : `Pikafish depth ${pfDepth}`}`
  + `｜上限 ${MAX_PLY} 半回合、自然限着 ${NO_CAPTURE_PLY} 半回合\n`);
if (pfDepth > 0) await startEngine();

const rows = [];
for (const game of picked) {
  const start = parseFen(game.fen);
  // 谁执哪一方：见文件头
  const moduleSide = game.result === 'win' ? start.side : -start.side;
  const expect = game.result === 'draw' ? 'draw' : 'win';
  let pos = start;
  const fens = [game.fen];
  const signatures = [positionSignature(game.fen)];
  const sides = [];
  const checks = [];
  let plies = 0;
  let sinceCapture = 0;
  let outcome = null;
  let why = '';
  const notations = [];
  while (plies < MAX_PLY) {
    const st = gameStatus(pos);
    if (st.type !== 'playing') {
      outcome = st.winner === moduleSide ? 'win' : 'lose';
      why = st.winner === moduleSide ? `将死/困毙对方` : `被${st.type === 'checkmate' ? '将死' : '困毙'}`;
      break;
    }
    const rep = classifyRepetition(signatures, sides, checks);
    if (rep) {
      if (rep.type === 'perpetual-check') {
        outcome = -rep.loser === moduleSide ? 'win' : 'lose';
        why = rep.loser === moduleSide ? '自己长将判负' : '对方长将判负';
      } else { outcome = 'draw'; why = '三次重复判和'; }
      break;
    }
    if (sinceCapture >= NO_CAPTURE_PLY) { outcome = 'draw'; why = `自然限着（${NO_CAPTURE_PLY} 半回合无吃子）`; break; }
    const fen = toFen(pos);
    let iccs;
    let selfScore = null;
    const mine = pos.side === moduleSide || pfDepth === 0;
    if (mine) {
      // 防守方也是模块时（self），两边都用模块走
      const r = search(fen, level, { history: fens });
      if (!r) { outcome = 'lose'; why = '模块没有着法'; break; }
      iccs = iccsOfMove(r.move);
      selfScore = r.score;
    } else {
      iccs = await pfMove(fen);
      if (!iccs) { outcome = 'lose'; why = 'Pikafish 没有着法'; break; }
    }
    const legal = generateLegalMoves(pos).map((m) => iccsOfMove(m));
    if (!legal.includes(iccs)) { outcome = 'abort'; why = `非法着法 ${iccs}`; break; }
    if (WHY) {
      console.log(`  ${String(plies).padStart(3)} ${mine ? '我' : '对'} `
        + `${toNotation(pos, moveOfIccs(iccs)).padEnd(6)} [${iccs}]`
        + `　合法着法 ${String(legal.length).padStart(2)}`
        + `　静态评估(我) ${String(evaluate(pos.cells, moduleSide)).padStart(5)}`
        + (mine ? `　自评 ${String(selfScore).padStart(6)}` : '　（对手）'));
      console.log(`      ${fen}`);
    }
    notations.push(`${pos.side === moduleSide ? '我' : '对'}${toNotation(pos, moveOfIccs(iccs))}`);
    const mv = moveOfIccs(iccs);
    const from = Math.floor(mv / CELLS), to = mv % CELLS;
    const captured = pos.cells[to] !== EMPTY;
    pos.cells[to] = pos.cells[from];
    pos.cells[from] = EMPTY;
    pos.side = -pos.side;
    plies += 1;
    sinceCapture = captured ? 0 : sinceCapture + 1;
    fens.push(toFen(pos));
    signatures.push(positionSignature(fens[fens.length - 1]));
    sides.push(-pos.side);
    checks.push(inCheck(pos.cells, pos.side));
  }
  if (!outcome) { outcome = 'draw'; why = `超过 ${MAX_PLY} 半回合`; }
  // 期望赢的：必须赢下来；期望和的：**只要没输**就算通过 ——
  // 「和局研究」里模块是防守方，赢了说明对手走岔了，那不该记成失败
  // （2026-10-06 第一次跑时按「必须和」判，把一局实际赢下来的记成了 ❌）。
  const ok = expect === 'win' ? outcome === 'win' : (outcome === 'draw' || outcome === 'win');
  rows.push({ game, moduleSide, expect, outcome, why, plies, notations, ok });
  console.log(`${ok ? '✅' : '❌'} ${game.name.padEnd(12)} 期望 ${expect === 'win' ? '赢' : '和'}`
    + `　实际 ${outcome === 'win' ? '赢' : (outcome === 'draw' ? '和' : (outcome === 'lose' ? '输' : '中止'))}`
    + `　（模块执${moduleSide === RED ? '红' : '黑'}，${plies} 半回合）${why}`);
  if (VERBOSE) console.log(`     全谱：${notations.join(' ')}\n     终局：${fens[fens.length - 1]}`);
  else if (!ok) {
    console.log(`     最后几手：${notations.slice(-6).join(' ')}`);
    console.log(`     终局：${fens[fens.length - 1]}`);
  }
  if (OUT) {
    appendFileSync(resolve(ROOT, OUT), `${JSON.stringify({
      id: game.id, name: game.name, category: CATEGORY, declared: game.result,
      expect, outcome, ok, plies, why,
      moduleSide: moduleSide === RED ? 'red' : 'black',
      depth: DEPTH, defender: DEFENDER, level: LEVEL,
      tail: notations.slice(-6).join(' '),
    })}\n`);
  }
}
if (proc) { send('quit'); proc.kill(); }
const pass = rows.filter((r) => r.ok).length;
console.log(`\n通过 ${pass} / ${rows.length}`
  + `　（期望赢的 ${rows.filter((r) => r.expect === 'win').length} 局里赢下 ${rows.filter((r) => r.expect === 'win' && r.outcome === 'win').length}；`
  + `期望和的 ${rows.filter((r) => r.expect === 'draw').length} 局里守住 ${rows.filter((r) => r.expect === 'draw' && r.outcome === 'draw').length}）`);
console.log('（这是**回归护栏**，不是棋力尺子：8 局分辨不了「强了 2cp」，它回答的是「已经能赢的还赢不赢得了」。）');
process.exit(0);
