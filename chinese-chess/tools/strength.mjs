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
 *   3. 问 Pikafish：走了模块那一步之后，走子方还剩多少分；
 *   4. 两者之差 = 这一手的**损失 cp**（夹到 ≥ 0）。
 *
 * 输出平均损失、中位数、漏着率（损失 > 100cp 的比例），以及最差几手的**裁判推荐线**
 * （方便复盘：它到底看不到什么）。
 *
 * ## 怎么读（别只看第一列）
 *
 * - **平均损失容易被一个 400cp 的漏着带跑**，所以同时给中位数与「去掉最大一个」的均值。
 *   判改动好不好，先看中位数与漏着数。
 * - **局面集决定结论**：默认取自生成的开局谱（4~8 半回合），**多是安静局面** ——
 *   那里评估说了算，深度体现不出来。想量深度收益就加 `--tactical`
 *   （只取走子方有吃子的「有接触」局面）。
 * - 时间预算是**有抖动**的：同一配置连跑两次差几个 cp 是正常的，差别要明显才算数。
 *
 * ## 用法
 *
 *   node chinese-chess/tools/strength.mjs                        # 真实 1.5 秒，安静局面 30 个
 *   node chinese-chess/tools/strength.mjs --tactical --n 40      # 只要「有接触」的局面
 *   node chinese-chess/tools/strength.mjs --ms 3000 --pf 18      # 给更多时间 / 更深的裁判
 *   node chinese-chess/tools/strength.mjs --no-null              # 对照：关掉空着裁剪
 *
 * **需要本地有 Pikafish**（路径与 `gen-solutions.mjs` 等工具一致）。裁判默认搜到
 * depth 16 —— 再深出分很慢，而它对「这一手差多少」的判断已经足够了。
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

const { CELLS, EMPTY, START_FEN } = await load('config.js');
const { search } = await load('engine.js');
const { toNotation } = await load('notation.js');
const { parseFen, toFen } = await load('position.js');
const { iccsOfMove } = await load('iccs.js');
const { generateMoves } = await load('rules.js');
const { GENERATED_TREE } = await load('openings-generated.js');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MS = Number(arg('ms', 1500));          // 模块的时间预算（0 = 用 --depth 的固定深度）
const DEPTH = Number(arg('depth', 6));       // MS 为 0 时用它
const PF = Number(arg('pf', 16));            // 裁判搜多深
const N = Number(arg('n', 30));              // 用多少个局面
const NO_NULL = process.argv.includes('--no-null');
const NO_MOBILITY = process.argv.includes('--no-mobility');
/** 只要「有接触」的局面（走子方至少有一个吃子）—— 安静局面上评估说了算，深度体现不出来 */
const TACTICAL = process.argv.includes('--tactical');

// === 局面集 ===
// 从生成谱里按步长扫（大部分局面是黑走的，扫密一点才凑得够数），只取红走的便于比较；
// 最后固定补上那个「★关键局面」—— 就是用户那盘 炮八平五 炮8平5 炮五进四 之后，
// 引擎在这里走过 炮5进4（亏 400+cp），它是最好的回归样本。
const positions = [];
{
  const seen = new Set();
  for (let i = 0; i < GENERATED_TREE.length && positions.length < N - 1; i += 5) {
    const [fen] = GENERATED_TREE[i];
    const pos = parseFen(fen);
    if (pos.side !== 1) continue;
    if (TACTICAL && !generateMoves(pos.cells, pos.side).some((m) => pos.cells[m % CELLS] !== EMPTY)) {
      continue;
    }
    if (seen.has(fen)) continue;
    seen.add(fen);
    positions.push([(TACTICAL ? '战术#' : '谱#') + positions.length, fen]);
  }
}
positions.push(['★关键局面（炮五进四 之后）',
  'rnbakabnr/9/1c2c4/p1p1C1p1p/9/9/P1P1P1P1P/7C1/9/RNBAKABNR b - - 0 1']);

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
  + `｜机动性 ${NO_MOBILITY ? '关' : '开'}｜裁判 Pikafish depth ${PF}｜局面 ${positions.length} 个`
  + `${TACTICAL ? '（只取有吃子的）' : ''}\n`);

const rows = [];
for (const [name, fen] of positions) {
  const r = search(fen, lv, { history: [fen] });
  if (!r) continue;
  const best = await judge(fen);
  const after = parseFen(fen);
  const from = Math.floor(r.move / CELLS), to = r.move % CELLS;
  after.cells[to] = after.cells[from];
  after.cells[from] = EMPTY;
  after.side = -after.side;
  const afterJudge = await judge(toFen(after));         // 这一步之后，对手视角
  rows.push({
    name, fen, move: toNotation(parseFen(fen), r.move), iccs: iccsOfMove(r.move),
    score: r.score, loss: Math.max(0, best.score - (-afterJudge.score)),
    refMove: best.bestMove, refPv: best.pv,
  });
}

const sorted = rows.map((r) => r.loss).sort((a, b) => a - b);
const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
const median = sorted[Math.floor(sorted.length / 2)];
const meanTrim = sorted.slice(0, sorted.length - 1).reduce((s, v) => s + v, 0)
  / Math.max(1, sorted.length - 1);
const blunders = rows.filter((r) => r.loss > 100).length;
console.log(`平均损失 ${mean.toFixed(1)} cp｜中位数 ${median}｜去掉最大一个后 ${meanTrim.toFixed(1)}`
  + `｜漏着（>100cp）${blunders}/${rows.length} = ${(blunders / rows.length * 100).toFixed(0)}%\n`);
console.log('最差的几手（含裁判推荐线与局面，便于复盘）：');
for (const r of [...rows].sort((a, b) => b.loss - a.loss).slice(0, 5)) {
  console.log(`  损失 ${String(r.loss).padStart(5)}cp  ${r.move.padEnd(6)} [${r.iccs}]  ${r.name}`
    + `  自评 ${r.score}  裁判首选 ${r.refMove}`);
  console.log(`     裁判线：${r.refPv}`);
  console.log(`     局面：${r.fen}`);
}
console.log('\n（判改动好坏：先看**中位数与漏着数**，再看均值 —— 均值容易被一个 400cp 带跑）');

send('quit');
setTimeout(() => process.exit(0), 200);
void START_FEN;
