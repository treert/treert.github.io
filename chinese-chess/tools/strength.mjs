#!/usr/bin/env node
/**
 * **棋力尺子** —— 拿本地 Pikafish 当裁判，量模块引擎「走得有多好」。
 *
 * 这是回答「AI 是不是变强了」的那个仪器。没有它，任何评估 / 搜索改动都只能靠感觉；
 * 有了它，改动前后是几个数字的差别（这一条是 2026-10-05 那轮教训换来的：
 * 当时用「离老师的 MAE」当判据，结果 MAE 好 41% 而排序反而更差 —— 判据选错，
 * 努力全白费。见 `docs/future-work.md` C1）。
 *
 * ## 它怎么量
 *
 * 对每个局面：
 *   1. 模块引擎自己走一手（默认 1.5 秒 = 高级挡位的预算，去掉随机性与开局库 ——
 *      量的是**搜索 + 评估**，不是谱）；
 *   2. 问 Pikafish：这个局面最优能有多少分（走子方视角）；
 *   3. 问 Pikafish：走了模块那一步之后，走子方还剩多少分（对手视角，取负）；
 *   4. 两者之差 = 这一手的**损失 cp**（夹到 ≥ 0）。
 *
 * 输出**按局面集分组**的平均损失、中位数、漏着率（>100cp 的比例）。
 *
 * ## 局面集（这是 2026-10-06 补的，也是它现在最有用的地方）
 *
 * | 组 | 来源 | 关心什么 |
 * |---|---|---|
 * | `opening` | 从 `js/openings-generated.js` 现扫（4~8 半回合） | 开局阶段「评估不犯傻」 |
 * | `middlegame` | `tools/strength-positions.mjs` 冻结的 20 个（引擎自对弈走出来的中局） | 评估 + 深度都说了算 |
 * | `endgame` | 同上文件的 10 个（子力 ≤ 6 大子） | 残局位置表、相位权重 |
 * | `regression` | 同上文件的 5 个（**历史上的漏着**） | 「修好没」—— 最硬的判据 |
 *
 * **为什么要分组**：原来只有「开局谱局面 + 1 个★局面」混在一起，
 * 改进容易被平均掉（一处 −20cp 与一处 +20cp 相消，看起来「没变」）。
 * 分组之后，「中局变好了、但残局变差了」这种话才说得出来。
 * 分组的口径、局面怎么采的、为什么不能手改，都写在 `tools/strength-positions.mjs` 的文件头。
 *
 * ## 怎么读（别只看第一列）
 *
 * - **平均损失容易被一个 400cp 的漏着带跑**，所以同时给中位数与「去掉最大一个」的均值。
 *   判改动好不好，**先看中位数与漏着数**。
 * - **回归集看的是逐条 ✅/❌**（模块这一手与裁判首选是否一致），不是它的平均损失 ——
 *   五个局面里四个是同一个毛病（炮往前顶 / 横挪），平均一下就把最严重的那条埋了。
 * - **局面集决定结论**：开局局面里**多是安静局面**，那里评估说了算、深度体现不出来。
 *   想量深度收益得看 `middlegame`。`--tactical` 只对 `opening` 生效
 *   （只取走子方有吃子的局面）—— 中局 / 残局那两组本来就是照真实对弈采的，不再筛。
 * - 时间预算是**有抖动**的：同一配置连跑两次差几个 cp 是正常的，差别要明显才算数。
 *
 * ## 用法
 *
 *   node chinese-chess/tools/strength.mjs                      # opening + regression（默认，最快）
 *   node chinese-chess/tools/strength.mjs --set all             # 四组全跑（要十几分钟）
 *   node chinese-chess/tools/strength.mjs --set middlegame
 *   node chinese-chess/tools/strength.mjs --set all --tactical  # opening 组只取有吃子的
 *   node chinese-chess/tools/strength.mjs --ms 3000 --pf 18     # 给更多时间 / 更深的裁判
 *   node chinese-chess/tools/strength.mjs --no-null             # 对照：关掉空着裁剪
 *   node chinese-chess/tools/strength.mjs --no-mobility         # 对照：关掉某个评估项
 *
 * `--n N` 是**每组**取多少个（默认 30）。
 * **需要本地有 Pikafish**（路径与 `gen-solutions.mjs` 等工具一致）。裁判默认搜到
 * depth 16 —— 再深出分很慢，而它对「这一手差多少」的判断已经足够了。
 * 进度打在 **stderr**，报错表打在 stdout（这样 `... > 报告.txt` 拿到的还是干净的报告）。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');
const load = (rel) => import(pathToFileURL(resolve(HERE, '../js', rel)).href);

const { CELLS, EMPTY, COLS, ROWS } = await load('config.js');
const { search } = await load('engine.js');
const { toNotation } = await load('notation.js');
const { parseFen, toFen } = await load('position.js');
const { iccsOfMove } = await load('iccs.js');
const { generateLegalMoves } = await load('rules.js');
// 局面集与「怎么取局面」都在这里（与 tools/move-diff.mjs、tools/eval-compare.mjs 共用一份）
const { resolveSets, strengthPositions } =
  await import(pathToFileURL(resolve(HERE, 'strength-positions.mjs')).href);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MS = Number(arg('ms', 1500));          // 模块的时间预算（0 = 用 --depth 的固定深度）
const DEPTH = Number(arg('depth', 6));       // MS 为 0 时用它
const PF = Number(arg('pf', 16));            // 裁判搜多深
const N = Number(arg('n', 30));              // **每组**用多少个局面
const NO_NULL = process.argv.includes('--no-null');
const NO_MOBILITY = process.argv.includes('--no-mobility');
/** 只要「有接触」的局面（走子方至少有一个吃子）—— 只作用于 opening 组 */
const TACTICAL = process.argv.includes('--tactical');

let SETS;
try {
  SETS = resolveSets(arg('set', 'opening,regression'));
} catch (e) {
  console.log(e.message);
  process.exit(1);
}

// === FEN 自检 ===
// Pikafish 碰到**非法局面是直接不回复**的（不是报错，是卡住 → 只会看到超时），
// 所以喂进去之前先自己验一遍：行数 / 每行 9 格 / 两边将帅都在 / 至少有一个合法着法。
// 这一条是拿 `future-work.md` 的坑 1 换来的。
function fenProblem(fen) {
  const board = String(fen).trim().split(/\s+/)[0];
  const rows = board.split('/');
  if (rows.length !== ROWS) return `棋盘 ${rows.length} 行（应为 ${ROWS}）`;
  for (const row of rows) {
    let w = 0;
    for (const ch of row) w += /[1-9]/.test(ch) ? Number(ch) : 1;
    if (w !== COLS) return `有一行是 ${w} 格（应为 ${COLS}）`;
  }
  if (!board.includes('K') || !board.includes('k')) return '少一个将 / 帅';
  try {
    if (generateLegalMoves(parseFen(fen)).length === 0) return '没有合法着法';
  } catch (e) { return e.message; }
  return null;
}

// === 局面集 ===
// 取法只有一份，在 strength-positions.mjs 里（着法对照与配置对照用的是同一个函数）——
// 两把仪器必须跑同一批局面，否则结果没法比。
const picked = strengthPositions({ sets: SETS, tactical: TACTICAL, n: N });
const groups = SETS.map((name) => ({
  name,
  positions: picked.filter((p) => p.set === name).map((p) => [p.id, p.fen, p.meta]),
}));
const TOTAL = picked.length;

// 喂给引擎之前先自检（有问题的那一个直接停，免得卡在「等 info」上十几分钟）
for (const g of groups) {
  for (const [id, fen] of g.positions) {
    const bad = fenProblem(fen);
    if (bad) {
      console.log(`局面非法（${g.name} ${id}）：${bad}\n  ${fen}\n修好再跑 —— 非法局面会让 Pikafish 卡住。`);
      process.exit(1);
    }
  }
}

// === 裁判 ===
const proc = spawn(EXE, [], { cwd: dirname(EXE) });
proc.on('error', (e) => { console.log('引擎启动失败：', e.message); process.exit(1); });
const pending = []; let waiter = null;
createInterface({ input: proc.stdout }).on('line', (line) => {
  if (waiter && waiter.pred(line)) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(line); return; }
  pending.push(line);
});
const send = (s) => proc.stdin.write(`${s}\n`);
const waitLine = (pred, ms, what) => new Promise((res, rej) => {
  const i = pending.findIndex(pred);
  if (i >= 0) { res(pending.splice(i, 1)[0]); return; }
  const timer = setTimeout(() => { waiter = null; rej(new Error(`等「${what}」超时`)); }, ms);
  waiter = { pred, resolve: res, timer };
});

/** 让裁判判分：返回**走子方视角**的 cp（杀棋折成 ±9000）、最优线与首选着法 */
async function judge(fen) {
  send(`position fen ${fen}`);
  send(`go depth ${PF}`);
  let score = null; let pv = ''; let bestMove = '';
  for (;;) {
    const l = await waitLine((x) => x.startsWith('info ') || x.startsWith('bestmove'), 60000, 'info');
    const m = /score (cp|mate) (-?\d+)/.exec(l);
    if (m) {
      score = m[1] === 'mate' ? (Number(m[2]) > 0 ? 9000 : -9000) : Number(m[2]);
      const p = / pv (.+)$/.exec(l);
      if (p) pv = p[1];
    }
    if (l.startsWith('bestmove')) { bestMove = l.split(/\s+/)[1] || ''; break; }
  }
  return { score, pv, bestMove };
}

send('uci');
await waitLine((l) => l === 'uciok', 20000, 'uciok');
send('setoption name Threads value 4');
send('setoption name Hash value 256');
send('isready');
await waitLine((l) => l === 'readyok', 30000, 'readyok');

// 与「高级」挡位同参数，但去掉随机性与开局库
const lv = {
  id: 'hard', name: '高级',
  depth: MS > 0 ? 64 : DEPTH,
  timeLimitMs: MS > 0 ? MS : 60000,
  quiescence: true, noise: 0, blunderRate: 0, checkExtension: 6, mateProbePly: 0, book: 0,
  ...(NO_NULL ? { useNullMove: false } : {}),
  ...(NO_MOBILITY ? { useMobility: false } : {}),
};

console.log(`模块：${MS > 0 ? `真实预算 ${MS}ms` : `固定深度 ${DEPTH}`}｜空着裁剪 ${NO_NULL ? '关' : '开'}`
  + `｜机动性 ${NO_MOBILITY ? '关' : '开'}｜裁判 Pikafish depth ${PF}`
  + `｜${groups.map((g) => `${g.name} ${g.positions.length}`).join(' + ')} = ${TOTAL} 个局面`
  + `${TACTICAL ? '（opening 只取有吃子的）' : ''}\n`);

// === 跑 ===
const done = [];
const mateRows = [];      // 裁判判为杀棋的局面：损失变成 ±9000 的二元量，不计入统计
const noMove = [];
let step = 0;
for (const g of groups) {
  for (const [id, fen, meta] of g.positions) {
    step += 1;
    const r = search(fen, lv, { history: [fen] });
    if (!r) {                                     // 没有合法着法（将死 / 困毙）
      noMove.push([g.name, id, fen]);
      process.stderr.write(`  [${step}/${TOTAL}] ${g.name} ${id} —— 模块没有着法可走，跳过\n`);
      continue;
    }
    const ref = await judge(fen);
    const after = parseFen(fen);
    const from = Math.floor(r.move / CELLS), to = r.move % CELLS;
    after.cells[to] = after.cells[from];
    after.cells[from] = EMPTY;
    after.side = -after.side;
    const afterRef = await judge(toFen(after));
    const row = {
      group: g.name, id, fen, meta,
      move: toNotation(parseFen(fen), r.move), iccs: iccsOfMove(r.move),
      score: r.score,
      refScore: ref.score, refMove: ref.bestMove, refPv: ref.pv,
      hit: ref.bestMove === iccsOfMove(r.move),
      // 走子方视角：走了这一手之后还剩多少 = 对手的分数取负
      loss: Math.max(0, ref.score + afterRef.score),
    };
    if (Math.abs(ref.score) >= 9000 || Math.abs(afterRef.score) >= 9000) mateRows.push(row);
    else done.push(row);
    process.stderr.write(`  [${step}/${TOTAL}] ${g.name} ${id}  ${row.move}（${row.iccs}）`
      + ` 损失 ${mateRows.includes(row) ? '（杀棋，不计）' : `${row.loss}cp`}\n`);
  }
}

// === 报告 ===
function stats(rows) {
  const ls = rows.map((r) => r.loss).sort((a, b) => a - b);
  const sum = ls.reduce((s, v) => s + v, 0);
  return {
    n: rows.length,
    mean: sum / ls.length,
    median: ls[Math.floor(ls.length / 2)],
    trim: ls.slice(0, ls.length - 1).reduce((s, v) => s + v, 0) / Math.max(1, ls.length - 1),
    blunders: rows.filter((r) => r.loss > 100).length,
  };
}
const num = (v, w) => v.toFixed(1).padStart(w);
const head = '组'.padEnd(11) + '局面'.padStart(5) + '平均损失'.padStart(10)
  + '中位数'.padStart(8) + '去掉最大'.padStart(10) + '漏着(>100cp)'.padStart(15);
console.log(head);
console.log('-'.repeat(head.length + 14));
for (const g of groups) {
  const rows = done.filter((r) => r.group === g.name);
  if (!rows.length) { console.log(`${g.name.padEnd(11)}${String(0).padStart(5)}   （没有可统计的局面）`); continue; }
  const s = stats(rows);
  console.log(`${g.name.padEnd(11)}${String(s.n).padStart(5)}${num(s.mean, 10)}${num(s.median, 8)}`
    + `${num(s.trim, 10)}${`${s.blunders}/${s.n} = ${(s.blunders / s.n * 100).toFixed(0)}%`.padStart(15)}`);
}
if (SETS.length > 1 && done.length) {
  const s = stats(done);
  console.log('-'.repeat(head.length + 14));
  console.log(`${'ALL'.padEnd(11)}${String(s.n).padStart(5)}${num(s.mean, 10)}${num(s.median, 8)}`
    + `${num(s.trim, 10)}${`${s.blunders}/${s.n} = ${(s.blunders / s.n * 100).toFixed(0)}%`.padStart(15)}`);
}

if (mateRows.length) {
  console.log(`\n（另有 ${mateRows.length} 个局面裁判判为杀棋 —— 损失会变成 ±9000 的二元量，不计入上面的统计）`);
  for (const r of mateRows) console.log(`  ${r.group} ${r.id}  ${r.move}  裁判 ${r.refMove}（${r.refScore}）`);
}
if (noMove.length) console.log(`\n（另有 ${noMove.length} 个局面模块没有着法可走，已跳过）`);

// 逐条列出回归集 —— 这是比任何平均数都硬的一条判据
const reg = done.filter((r) => r.group === 'regression');
if (reg.length) {
  console.log(`\n回归集（历史上踩过的坑，逐条看「改主意了吗」）：`
    + `命中裁判首选 ${reg.filter((r) => r.hit).length}/${reg.length}`);
  for (const r of reg) {
    const was = r.meta && r.meta.wasMove ? `（当年走 ${r.meta.wasMove}，亏 ${r.meta.loss}cp）` : '';
    console.log(`  ${r.hit ? '✅' : '❌'} ${r.id.padEnd(10)} 走 ${r.move.padEnd(6)} 损失 ${String(r.loss).padStart(4)}cp`
      + `  自评 ${String(r.score).padStart(4)}  裁判首选 ${r.refMove} ${was}`);
    console.log(`     裁判线：${r.refPv}`);
    console.log(`     局面：${r.fen}`);
  }
}

console.log('\n最差的几手（含裁判推荐线与局面，便于复盘）：');
for (const r of [...done].sort((a, b) => b.loss - a.loss).slice(0, 6)) {
  console.log(`  损失 ${String(r.loss).padStart(5)}cp  ${r.move.padEnd(6)} [${r.iccs}]  ${r.group} ${r.id}`
    + `  自评 ${r.score}  裁判首选 ${r.refMove}`);
  console.log(`     裁判线：${r.refPv}`);
  console.log(`     局面：${r.fen}`);
}
console.log('\n（判改动好坏：**先看中位数、漏着数与回归集逐条**，再看均值 —— 均值容易被一个 400cp 带跑）');

send('quit');
setTimeout(() => process.exit(0), 200);
