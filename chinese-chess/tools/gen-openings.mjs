#!/usr/bin/env node
/**
 * 开局库生成器 —— **离线开发工具，不参与网页运行**。
 *
 * 用 Pikafish（UCI 中国象棋引擎）把开局阶段展开成一棵「局面 → 候选着法」的表，
 * 固化成 `js/openings-generated.js`。运行时不需要引擎、不联网。
 *
 * 用法（从仓库根跑）：
 *
 *   node chinese-chess/tools/gen-openings.mjs grow --budget-ms 240000   # 分批长树
 *   node chinese-chess/tools/gen-openings.mjs grow --budget-ms 240000   # 再跑一次接着长
 *   node chinese-chess/tools/gen-openings.mjs emit                     # 写成 js/openings-generated.js
 *   node chinese-chess/tools/gen-openings.mjs report                    # 只看覆盖与体积
 *
 * 中间结果累积在 `tmp/openings-work.json`（tmp 已被 git 忽略），**可中断、可分批、可重跑**：
 * 每个局面记一条「候选 + 分值」，重跑时已经算过的局面不会再算。
 * 于是「跑一次要十几分钟」这件事不挡路 —— 分几次 `--budget-ms` 喂它就行。
 *
 * ## 三个参数
 *
 *   --ply N        谱的深度（半回合）。**第 N 手之前**的每个局面都要有应着，默认 8（与手写线同深）。
 *   --k a,b,...    每一层保留的候选**个数上限**（按分值取前 K）。默认见 DEFAULTS。
 *   --cp a,b,...   每一层保留候选的**分值阈值**（比最优差超过它的不要）。
 *   --pf N         每个局面让 Pikafish 搜多深（默认 12）。开局着法之间的分差本来就只有几十 cp，
 *                  12 层 NNUE 足够排序；调高只是白烧时间。
 *
 * K 与阈值是**两个不同的旋钮**，别混：
 *   - 阈值管**质量**（这个着法坏不坏）—— 放宽它，谱里会出现「人可能走、但引擎认为不最优」的着法；
 *   - K 管**数量**（每个局面最多给几个选择）—— 放宽它，AI 的变着更多、对「对手走偏」更宽容。
 * 两者都放 → 树按层数指数膨胀。所以默认是**由宽到窄**：前几手宽（人类在这里变化最多），越深越窄。
 *
 * ## 为什么整棵树在「归一朝向」里长
 *
 * 每个局面的代表 = 自身与左右镜像中 FEN 小的那个（与 `js/openings.js` 查表时同一套规则）。
 * 这一步**省掉近一半引擎调用与一半数据**：开局阶段左右对称的局面一大把
 * （炮二平五 / 炮八平五 就是一对），它们是同一件事，没必要各算一遍。
 * 生成物里因此**只出现归一后的局面**，运行时查表时镜像回来即可。
 *
 * ## 这个谱**修不了什么**
 *
 * 谱里只有「引擎认为可走」的着法。**对手走一步次优着，就掉出谱了**，AI 立刻回退搜索 ——
 * 而搜索的强弱是另一条战线（见 `docs/future-work.md` C1：先分清估值问题还是视野问题）。
 * 所以这个文件治的是「开局不像人」，不是「棋力不够」。
 *
 * 引擎与权重**不进仓库**（GPL-3 / ODbL，且体积大）：下载通用二进制 + `pikafish.nnue`
 * 解压到 `tmp/pikafish/`，或用环境变量 `PIKAFISH` 指向别处。见 `docs/pikafish.md`。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { START_FEN, CELLS, EMPTY } from '../js/config.js';
import { parseFen, toFen, clonePosition, mirrorPosition } from '../js/position.js';
import { generateLegalMoves } from '../js/rules.js';
import { moveOfIccs } from '../js/iccs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WORK_FILE = resolve(ROOT, 'tmp/openings-work.json');
const OUT_FILE = resolve(HERE, '../js/openings-generated.js');
/** 生成这批数据的引擎版本（换引擎重跑时这里要跟着改，并把来源写进生成物） */
const ENGINE = 'Pikafish 2026-09-06';
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');

/** 默认参数：由宽到窄。前几手宽（人类在这里变化最多），越深越窄 */
const DEFAULTS = {
  ply: 8,
  k: '6,5,4,3,2,2,2,2',
  cp: '50,45,40,30,25,25,20,20',
  pf: 12,
  threads: 4,
  hash: 512,
  'budget-ms': 240000,
};

const argv = process.argv.slice(2);
const stage = (argv[0] || 'report').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SCHED = (s, n) => {
  const a = String(s).split(',').map((v) => Number(v.trim()));
  return Array.from({ length: n }, (_, i) => a[Math.min(i, a.length - 1)]);
};
const PLY = Number(opt('ply', DEFAULTS.ply));
const K = SCHED(opt('k', DEFAULTS.k), PLY);
const CP = SCHED(opt('cp', DEFAULTS.cp), PLY);
const PF = Number(opt('pf', DEFAULTS.pf));
const THREADS = Number(opt('threads', DEFAULTS.threads));
const HASH = Number(opt('hash', DEFAULTS.hash));
const BUDGET = Number(opt('budget-ms', DEFAULTS['budget-ms']));

// ---------------------------------------------------------------- 局面小工具
/** 归一朝向：返回代表局面与它的 FEN（与 openings.js 同一套规则） */
function canonical(pos) {
  const own = toFen(pos);
  const mirror = mirrorPosition(pos);
  const mFen = toFen(mirror);
  return mFen < own ? { pos: mirror, fen: mFen } : { pos, fen: own };
}
function applyMove(pos, move) {
  const p = clonePosition(pos);
  p.cells[move % CELLS] = p.cells[Math.floor(move / CELLS)];
  p.cells[Math.floor(move / CELLS)] = EMPTY;
  p.side = -p.side;
  return p;
}
const ROOT_NODE = canonical(parseFen(START_FEN));

// ---------------------------------------------------------------- 工作文件
function loadWork() {
  try {
    const w = JSON.parse(readFileSync(WORK_FILE, 'utf8'));
    if (w && w.nodes && w.engine === ENGINE) return w;
    if (w) console.log(`（工作文件是 ${w.engine} 生成的，与当前 ${ENGINE} 不同 —— 从头开始）`);
  } catch { /* 没有就从零开始 */ }
  return { engine: ENGINE, nodes: {} };
}
function saveWork(w) {
  mkdirSync(dirname(WORK_FILE), { recursive: true });
  writeFileSync(WORK_FILE, JSON.stringify(w));
}

/**
 * 从根 BFS 一路推出「还没算的局面」，按层给出来。
 *
 * 不存前沿队列 —— 前沿完全由已算的局面**推导**出来（把每条的候选走一遍、归一），
 * 这样工作文件里只有一张 `局面 → 候选` 表，中途改参数重跑也不会自相矛盾。
 */
function frontierByPly(work) {
  const layers = [];
  let keys = [ROOT_NODE.fen];
  const seen = new Set(keys);
  for (let ply = 0; ply < PLY; ply++) {
    const todo = keys.filter((f) => !work.nodes[f]);
    layers.push(todo);
    const next = [];
    for (const f of keys) {
      const rec = work.nodes[f];
      if (!rec) continue;                                    // 没算过的局面推不下去
      const bd = parseFen(f);
      for (const [iccs] of rec.cand) {
        const child = canonical(applyMove(bd, moveOfIccs(iccs))).fen;
        if (!seen.has(child)) { seen.add(child); next.push(child); }
      }
    }
    keys = next;
  }
  return layers;
}

// ---------------------------------------------------------------- Pikafish 驱动
let proc = null; let rl = null; const pending = []; let waiter = null;
if (stage === 'grow') {
  proc = spawn(EXE, [], { cwd: dirname(EXE) });
  proc.on('error', (e) => { console.log('引擎启动失败：', e.message); process.exit(1); });
  rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (waiter && waiter.pred(line)) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(line); return; }
    pending.push(line);
  });
}
const send = (s) => proc.stdin.write(`${s}\n`);
const waitLine = (pred, ms, what) => new Promise((res, rej) => {
  const i = pending.findIndex(pred);
  if (i >= 0) { res(pending.splice(i, 1)[0]); return; }
  const timer = setTimeout(() => { waiter = null; rej(new Error(`等「${what}」超时（${ms}ms）`)); }, ms);
  waiter = { pred, resolve: res, timer };
});

async function engineInit() {
  send('uci');
  await waitLine((l) => l === 'uciok', 20000, 'uciok');
  send(`setoption name Threads value ${THREADS}`);
  send(`setoption name Hash value ${HASH}`);
  send('isready');
  await waitLine((l) => l === 'readyok', 60000, 'readyok');
  send('ucinewgame');
  send('isready');
  await waitLine((l) => l === 'readyok', 20000, 'readyok');
}

/**
 * 问引擎要一个局面的候选：`go depth PF`，MultiPV 取 `K+1`（够阈值过滤用就行）。
 * 返回 `[[iccs, cp], ...]`，按分值降序，**已经过本模块规则层复核合法**。
 */
async function candidates(fen, multipv) {
  send(`setoption name MultiPV value ${multipv}`);
  send('isready');
  await waitLine((l) => l === 'readyok', 30000, 'readyok');
  send(`position fen ${fen}`);
  send(`go depth ${PF}`);
  const byPv = [];
  for (;;) {
    const l = await waitLine((x) => x.startsWith('info ') || x.startsWith('bestmove'), 300000, 'info');
    const m = /multipv (\d+).*score cp (-?\d+).* pv (\S+)/.exec(l);
    if (m) byPv[Number(m[1]) - 1] = [m[3], Number(m[2])];
    if (l.startsWith('bestmove')) break;
  }
  const bd = parseFen(fen);
  const legal = new Set(generateLegalMoves(bd));
  const out = [];
  for (const e of byPv.filter(Boolean)) {
    const move = moveOfIccs(e[0]);
    if (!legal.has(move)) throw new Error(`引擎给的 ${e[0]} 在 ${fen} 上不是合法着法`);
    out.push(e);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

// ---------------------------------------------------------------- 分值 → 权重
/**
 * 把分值差映射成权重（1..4）。只是个**占位方案**，改它不用重跑引擎 ——
 * emit 阶段现算，工作文件里存的是 cp 原文。
 *   0cp → 4 ／ 12cp → 2 ／ 25cp 以外 → 1
 */
function weightOf(cp, best) { return Math.max(1, Math.round(4 * Math.exp(-(best - cp) / 25))); }

// ---------------------------------------------------------------- grow
async function grow() {
  await engineInit();
  const work = loadWork();
  console.log(`深度 ${PLY} 半回合｜K=${K.join(',')}｜阈值=${CP.join(',')}`
    + `｜Pikafish depth ${PF}｜线程 ${THREADS}`);

  const t0 = Date.now();
  const overBudget = () => Date.now() - t0 > BUDGET;
  let done = 0; let sinceSave = 0; let outOfTime = false;

  // 一层一层往下推：每推完一轮，前沿里的新局面才会被推出来，所以要循环到没活干
  for (;;) {
    const todo = [];
    frontierByPly(work).forEach((l, ply) => l.forEach((fen) => todo.push([ply, fen])));
    if (!todo.length) break;
    if (done === 0) {
      console.log(`已算 ${Object.keys(work.nodes).length} 个局面，本轮待算 ${todo.length} 个`
        + `（预算 ${(BUDGET / 1000).toFixed(0)}s）\n`);
    }
    for (const [ply, fen] of todo) {
      if (overBudget()) { outOfTime = true; break; }
      const t = Date.now();
      const raw = await candidates(fen, Math.min(12, K[ply] + 1));
      if (!raw.length) throw new Error(`${fen} 一个候选都没有`);
      const best = raw[0][1];
      const keep = raw.filter((e) => e[1] >= best - CP[ply]).slice(0, K[ply]);
      work.nodes[fen] = { ply: ply + 1, cand: keep };
      done++; sinceSave++;
      if (sinceSave >= 25) { saveWork(work); sinceSave = 0; }
      if (done % 25 === 0) {
        const rate = (Date.now() - t0) / done;
        console.log(`  已算 ${Object.keys(work.nodes).length} 个（本轮 ${done}，`
          + `${rate.toFixed(0)}ms/局面，单点 ${Date.now() - t}ms，`
          + `第 ${ply + 1} 手前 K=${K[ply]} 保留 ${keep.length} 个）`);
      }
    }
    if (outOfTime) break;
  }

  saveWork(work);
  const left = frontierByPly(work).reduce((s, l) => s + l.length, 0);
  console.log(`\n本轮算完 ${done} 个，累计 ${Object.keys(work.nodes).length} 个，还剩 ${left} 个待算`
    + `（用了 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  if (left) console.log('再跑一次 grow 接着算（工作文件在 tmp/openings-work.json）');
  else console.log('树长完了 —— 下一步：emit');
}

// ---------------------------------------------------------------- emit / report
function buildRecords(work, { verbose }) {
  const records = [];
  let cands = 0; let worstSpread = 0;
  for (const [fen, rec] of Object.entries(work.nodes)) {
    if (fen !== canonical(parseFen(fen)).fen) {
      throw new Error(`工作文件里的局面不是归一朝向：${fen}（生成器的推断有问题）`);
    }
    const best = rec.cand[0][1];
    const moves = rec.cand.map(([iccs, cp]) => [iccs, weightOf(cp, best)]);
    cands += moves.length;
    worstSpread = Math.max(worstSpread, best - rec.cand[rec.cand.length - 1][1]);
    records.push([fen, moves]);
    if (verbose) console.log(`  ${fen}  →  ${moves.map((m) => `${m[0]}(w${m[1]})`).join(' ')}`);
  }
  records.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { records, cands, worstSpread };
}

function report(work) {
  const { records, cands, worstSpread } = buildRecords(work, { verbose: false });
  const byPly = new Map();
  const candHist = new Map();
  for (const [, moves] of records) {
    const n = moves.length;
    candHist.set(n, (candHist.get(n) || 0) + 1);
  }
  for (const rec of Object.values(work.nodes)) {
    byPly.set(rec.ply, (byPly.get(rec.ply) || 0) + 1);
  }
  console.log(`局面数 ${records.length}｜候选总数 ${cands}｜平均 ${(cands / records.length).toFixed(2)} 个/局面`
    + `｜最大候选分差 ${worstSpread}cp`);
  console.log(`每层局面数：${[...byPly.entries()].sort((a, b) => a[0] - b[0])
    .map(([p, n]) => `第${p}手前→${n}`).join('  ')}`);
  console.log(`候选个数分布：${[...candHist.entries()].sort((a, b) => a[0] - b[0])
    .map(([n, c]) => `${n}个→${c}局面`).join('  ')}`);
}

function emit(work) {
  const { records, cands } = buildRecords(work, { verbose: false });
  const body = records.map(([fen, moves]) =>
    `  ['${fen}', [${moves.map(([m, w]) => `['${m}',${w}]`).join(', ')}]],`).join('\n');
  const content = `/**
 * 开局库（Pikafish 生成的那一半）—— **这个文件是生成的，别手改**。
 *
 * 生成：\`node chinese-chess/tools/gen-openings.mjs grow\`（可分批，用 --budget-ms）
 * 再 \`emit\` 写出来；校验：\`node chinese-chess/tools/test-openings.mjs\`（会逐条查合法性）。
 * 中间过程与参数见 \`docs/openings.md\`，规则与取舍见 \`tools/gen-openings.mjs\` 头部。
 *
 * ## 里面是什么
 *
 * 一行一个局面：\`[局面 FEN, [[着法, 权重], ...]]\`，着法用 ICCS 坐标。
 * **局面是「归一朝向」的**（自身与左右镜像中 FEN 小的那个）—— 生成时就在归一空间里展开，
 * 所以这里不会出现互为镜像的两条；运行时 \`openings.js\` 查表前做同样的归一，命中镜像局面时
 * 把着法镜像回来。权重由分值差现算（0cp→4、12cp→2、25cp 以外→1），只是相对概率，不是棋力。
 *
 * ## 它治什么、不治什么
 *
 * 治「开局不像人」：这些着法都是引擎认为可走的，比手写那几条线宽得多。
 * **不治「对手走偏」**：谱里只有好棋，对手走一步次优着就掉出谱、回退搜索
 * （先分清估值问题还是视野问题 —— \`docs/future-work.md\` C1）。
 *
 * 数据来源：${ENGINE}。生成物只有引擎输出，不含任何棋谱数据库（授权问题见 \`future-work.md\` B1）。
 */

/** 生成这批数据的引擎版本（换引擎重跑时这里要跟着改） */
export const OPENINGS_SOURCE = '${ENGINE}';

/**
 * ${records.length} 个局面 / ${cands} 条候选。**归一朝向、不含镜像重复。**
 */
export const GENERATED_TREE = [
${body}
];
`;
  writeFileSync(OUT_FILE, content);
  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB（gzip 后 ${(gzipSync(s).length / 1024).toFixed(1)} KB）`;
  console.log(`已写出 ${OUT_FILE.replace(ROOT + '\\', '').replace(/\\/g, '/')}`);
  console.log(`  ${records.length} 个局面 / ${cands} 条候选 —— ${kb(content)}`);
}

// ---------------------------------------------------------------- 入口
if (stage === 'grow') {
  await grow();
  send('quit');
  setTimeout(() => process.exit(0), 200);
} else if (stage === 'emit') {
  const work = loadWork();
  const left = frontierByPly(work).reduce((s, l) => s + l.length, 0);
  if (left) console.log(`警告：还有 ${left} 个局面没算（先跑 grow）\n`);
  report(work);
  emit(work);
  process.exit(0);
} else if (stage === 'report') {
  const work = loadWork();
  report(work);
  process.exit(0);
} else {
  console.log('用法：grow｜emit｜report（详见文件头部注释）');
  process.exit(1);
}
