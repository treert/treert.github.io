#!/usr/bin/env node
/**
 * 位置表（piece-square）蒸馏器 —— **离线开发工具，不参与网页运行**。
 *
 * 把 Pikafish 的判断**拟合**成 `config.js` 里那两块手写的位置表：拿大量局面当样本、
 * 引擎的分当老师，用最小二乘解出「子力 + 开局表 + 残局表」这一组数。
 *
 * 用法（从仓库根跑）：
 *
 *   node chinese-chess/tools/gen-pst.mjs snapshot   # 先把当前手写表存到 tmp/pst-old.json（做对照用）
 *   node chinese-chess/tools/gen-pst.mjs sample --n 20000 --budget-ms 240000
 *   node chinese-chess/tools/gen-pst.mjs fit        # 解最小二乘 + 与手写表对照
 *   node chinese-chess/tools/gen-pst.mjs agree      # 尺度无关的体检（同局面内排名相关）
 *   node chinese-chess/tools/gen-pst.mjs nn --samples games --hidden 32   # 小网络（2026-10-07 加的）
 *   node chinese-chess/tools/gen-pst.mjs emit       # 写成 js/pst-generated.js（**目前没跑，见下**）
 *
 * `nn` 是「**换个形式**」那一问的仪器：与线性拟合**用同一套特征**（子力 6 + 7 类 × 50 组折叠格
 * × 2 相位 = 706），只在中间加一层 ReLU 隐藏单元。训练集切法与 `fit` 一致（6 : 2 : 2 ——
 * 训练 / 早停 / 留出），`agree` 用的留出集（最后 20%）**不参与训练也不参与早停**，
 * 所以 `agree` 上比出来的差距不是过拟合。权重存 `tmp/nn-*.json`，`agree` 会自动把它们
 * 一起体检（这是 next-session-prompt §3.2 那件事：**同样这些信息，换个形式能更准吗**）。
 *
 * ## 线程数分两处（别搞混）
 *
 * - **采样**（`sample`）= `--threads`，默认 **4**：要的是吞吐，数据采完就冻结成 json 复用。
 * - **裁判**（`agree` 里的 Pikafish）= `--pf-threads`，默认 **1**：ρ 的基线随线程数漂 ±0.05
 *   （同一份手写表 4 线程 0.288 / 单线程 0.240），而**单线程两次跑逐位相同** ——
 *   0.05 正好是「明显」那个阈值。详见 `decisions.md` 第 36 条。
 *
 * ## 为什么是「拟合」而不是「探测」
 *
 * 直觉上的做法是「把某个子摆在某个格子上，问引擎这个子值多少」—— 但 Pikafish 的
 * `eval` 只给**桶级**分项（16 个 bucket 的 PSQT / Positional / Total），**没有逐子分值**，
 * 摆一个子测一次这条路走不通。
 *
 * 那就反过来：**让模型去迁就数据**。模块的评估是
 *
 *   score = (开局分 × φ + 残局分 × (1-φ))，  开局分 = Σ 子力 + 位置表 + 过河兵
 *
 * 这个式子对「子力值」和「每个格子上的位置分」**是线性的**（φ 由局面已知，不是未知数），
 * 所以给一堆 (局面, 引擎分) 就能解出来。逐子探测是在测**非线性**系统的一个切片，
 * 拟合是在解它在一个线性子空间上的投影 —— 后者才是「换掉这一块数据」该做的事。
 *
 * ## 老师是谁、样本从哪来
 *
 * - **老师**：`go depth 8` 的 cp 分（轮走方视角，换算成红方视角）。
 *   `depth 8` 是刻意的：再深，分里混进越来越多「静态评估原理上表达不了」的战术，
 *   拟合成静态表反而是噪声；再浅则排序不可靠。12 层以上留给棋力，不是留给拟合。
 * - **样本**：从[生成的开局谱](../js/openings-generated.js)里随机挑一个局面开局，
 *   之后**随机合法着法**走下去，一路上抽样。只收**安静局面**（双方都没有可吃的子）——
 *   静态评估本来就只该对安静局面负责，吵闹的局面对应的是静态搜索的活。
 * - 收样本还要求：不走棋方被将军、分差不超过 8 个兵（已经分出胜负的局面拟不出来）。
 *
 * ## 结论：2026-10-05 试过，**没有换成**（所以现在没有 `js/pst-generated.js` 这个产物）
 *
 * 三组实测（20,000 个安静局面，Pikafish depth 8 当老师，8:2 切出留出集）：
 *
 * 两次采样、两组留出集。ρ = 同局面内与引擎排序的相关（尺度无关），**它才是判据**；
 * MAE 列放在这儿只是为了说明「MAE 会骗人」。
 *
 * **留出集 A：随机走子采的局面**（`--policy random`，20,000 样本）
 *
 * | 表 | MAE | ρ | 与引擎首选一致 |
 * |---|---|---|---|
 * | **现有手写表** | 267 | **0.324** | **27.3%** |
 * | 只拟合位置表（固定模块子力，700 自由格） | 574 | 0.157 | 25.3% |
 * | 子力 + 位置表一起拟合（700 自由格） | **157** | 0.155 | 24.7% |
 * | 结构化拟合（纵线分 + 行分 + 单点，104 参数） | 228 | 0.140 | 18.0% |
 *
 * **留出集 B：引擎对局采的局面**（`--policy engine`，3,217 样本）
 *
 * | 表 | MAE | ρ | 与引擎首选一致 |
 * |---|---|---|---|
 * | **现有手写表** | 220 | **0.218** | **28.7%** |
 * | 结构化拟合（用 B 自己训练） | 189 | 0.111 | 16.7% |
 *
 * 四条教训比结论本身值钱：
 *
 * 1. **只换位置表不行。** 引擎的分值刻度与模块的子力比差得远（它认的车≈690、兵≈22，
 *    模块是 900 / 100）：固定模块子力之后，位置表怎么拟合都比手写的差。
 * 2. **MAE 是错的指标。** 同一局面内子力项几乎不变，MAE 主要在量「两边刻度差多少」，
 *    于是它奖励「把刻度对齐」而不是「把位置判断学对」—— 每一版拟合的 MAE 都「更好」，
 *    排序却全都更差。用**排名相关**（`agree` 子命令）才看得见真相。
 * 3. **形状要体检，而且结构化也救不回来。** 自由 700 格解出的表是锯齿噪声
 *    （兵在 y=2 值 +63、y=1 却 −25）；换回模块原有的「纵线分 + 行分 + 单点」结构
 *    （104 个参数、条件数好得多）之后 ρ 反而更低 —— 因为**病根不在参数个数**：
 *    位置表被拿去替子力做补偿，车的行分解出 −973 ~ −354（让一个车在不同行上差 600 分），
 *    排序自然崩。
 * 4. **样本换成像样对局也不行，但换出一个额外发现。** `--policy engine` 让采样命中率从
 *    1.0% 升到 ~10%（局面确实安静得多），拟合版 ρ 反而更低（0.111）；
 *    同时**手写表自己的 ρ 也从 0.324 掉到 0.218** —— 随机局面里「大方向」的错更容易被抓到，
 *    真实对局里着法之间的差别更细。**结论：指标该在真实分布上量；但换分布没有让拟合版翻盘。**
 *
 * 想真做成，剩下的方向：老师换成**静态评估或对局结果**（搜索分里的战术噪声压过位置信号）、
 * **从手写值出发拟合残差**（强正则，只许小改不许推翻 —— 最便宜，上限也最低）、
 * 或者干脆认了「这一点数据量的位置表撑不起把引擎的判断搬过来」，改走别的棋力抓手。
 * 做完别忘了**尺度无关的验收**（`agree`）与自对弈对照。
 *
 * ## 边界（就算拟合成功也别期待它治不了的事）
 *
 * 这是**把引擎的判断压进一个小模型**，不是把引擎搬进来。模型里没有战术、没有搜索、
 * 没有「这子是不是无根」这类需要生成着法的项（`engine.js` 明确不加：评估在叶节点
 * 被调用上百万次）。它能做的是**同样一次查表，值更准** —— 于是同样时间搜得更深、
 * 排序更好。详见 `docs/future-work.md` C1。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  START_FEN, COLS, ROWS, CELLS, EMPTY, RED, BLACK, K, A, B, N, R, C, P,
  PIECE_VALUE, PHASE_WEIGHT, PHASE_MAX, MIRROR_INDEX,
  PAWN_BONUS_OPENING, PAWN_BONUS_ENDGAME, PIECE_SQUARE_OPENING, PIECE_SQUARE_ENDGAME,
} from '../js/config.js';
import { parseFen, toFen, yOf, clonePosition } from '../js/position.js';
import { generateMoves, generateLegalMoves, inCheck } from '../js/rules.js';
import { moveOfIccs } from '../js/iccs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
// SAMPLE_TAG / SAMPLE_FILE 在下面（要先有 opt 才能读 --samples）
const OLD_FILE = resolve(ROOT, 'tmp/pst-old.json');
const OUT_FILE = resolve(HERE, '../js/pst-generated.js');
const ENGINE = 'Pikafish 2026-09-06';
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');

const argv = process.argv.slice(2);
const stage = (argv[0] || 'report').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const N_SAMPLES = Number(opt('n', 12000));
const BUDGET = Number(opt('budget-ms', 240000));
const TEACHER_DEPTH = Number(opt('depth', 8));
const RIDGE = Number(opt('ridge', 1));
/**
 * **采样**那一侧的线程数（`sample`）：要的是吞吐（一次性采两万条，采完冻结成 json 复用），
 * 数据的「可复现」没有意义 —— 所以这里保持 4。
 */
const THREADS = Number(opt('threads', 4));
/**
 * **裁判**那一侧的线程数（`agree`）：默认 1。
 *
 * `agree` 量的是 ρ，而多线程 Pikafish（Lazy SMP）同一局面同一深度两次跑会给不同的分 ——
 * 实测（`decisions.md` 第 36 条）：同一份手写表，4 线程量出 0.288、单线程 0.240，
 * 而**单线程两次跑逐位相同**。0.05 正好是判据里「明显」的阈值，所以这不设默认值就等于
 * 每次都在踩坑（这名字与 `strength.mjs` / `eval-compare.mjs` / `move-diff.mjs` 一致）。
 */
const PF_THREADS = Number(opt('pf-threads', 1));
/** 固定模块自己的子力值、只拟合位置表（默认）。`--fix-mat 0` 则连子力一起拟合（对照用） */
const FIX_MAT = opt('fix-mat', '1') !== '0';
/** `free` = 700 个自由格子；`struct` = 模块原有的「纵线分 + 行分 + 单点」结构（默认试 struct） */
const MODE = opt('mode', 'struct');
/**
 * 采样时怎么走子：`random` = 随机合法着法（快，但局面很吵）；`engine` = 用模块自己的引擎走
 * （慢几十倍，但走出来的局面「像样对局」—— 这是这一轮要试的变量）。
 */
const POLICY = opt('policy', 'random');
/**
 * 样本文件按 `--samples <标签>` 分开存：换采样方式时**别覆盖上一次的**，
 * 因为「手写表在留出集上的 ρ」是随分布变的 —— 换了分布要重新量基线才比得公平。
 */
const SAMPLE_TAG = opt('samples', opt('teacher', 'search'));
const SAMPLE_FILE = resolve(ROOT, `tmp/pst-samples-${SAMPLE_TAG}.json`);

// === 小网络（`nn` 阶段）的参数 ==============================================
const HIDDEN = Number(opt('hidden', 32));      // 隐藏单元数；0 = 退化成线性（对照组）
const EPOCHS = Number(opt('epochs', 300));     // 上限，早停会先停
const LR = Number(opt('lr', 0.003));           // Adam 的学习率
const L2 = Number(opt('l2', 1e-3));            // 权重衰减（AdamW 的解耦那一项）
const BATCH = Number(opt('batch', 64));
const SEED = Number(opt('seed', 12345));

// === 特征布局 =================================================================
// 6 个子力（士象马车炮兵，帅恒 0）+ 7 类 × 50 组「左右折叠后的格子」× 2 个相位。
// 「左右折叠」：位置表左右对称（模块的断言之一：左右对称的局面评估必须为 0），
// 所以把 (|x-4|, y) 当一个未知数，x=4 那列单独算 —— 5 × 10 = 50 组。
const N_MAT = 6;
const N_PAIR = 5 * ROWS;                       // 50
const N_TYPE = 7;                              // 帅 士 象 马 车 炮 兵
const OP_OFF = N_MAT;
const EG_OFF = OP_OFF + N_TYPE * N_PAIR;
const N_FEAT = EG_OFF + N_TYPE * N_PAIR;
const pairOf = (idx) => Math.abs((idx % COLS) - 4) * ROWS + yOf(idx);
const matIdx = (abs) => abs - A;               // 士=2 → 0 … 兵=7 → 5
const matAbs = (i) => i + A;

// === 老师：Pikafish ===========================================================
let proc = null; const pending = []; let waiter = null;
if (stage === 'sample' || stage === 'agree') {
  proc = spawn(EXE, [], { cwd: dirname(EXE) });
  proc.on('error', (e) => { console.log('引擎启动失败：', e.message); process.exit(1); });
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (waiter && waiter.pred(line)) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(line); return; }
    pending.push(line);
  });
}
const send = (s) => proc.stdin.write(`${s}\n`);
const waitLine = (pred, ms, what) => new Promise((res, rej) => {
  const i = pending.findIndex(pred);
  if (i >= 0) { res(pending.splice(i, 1)[0]); return; }
  const timer = setTimeout(() => { waiter = null; rej(new Error(`等「${what}」超时`)); }, ms);
  waiter = { pred, resolve: res, timer };
});

/** 问引擎：这个局面（轮走方视角）多少分 */
async function teacherScore(fen) {
  send(`position fen ${fen}`);
  send(`go depth ${TEACHER_DEPTH}`);
  let last = null;
  for (;;) {
    // 超时短一点并把局面带进错误里 —— 引擎对非法局面是**不回复**的，
    // 卡住时最想知道的就是「哪个局面不合法」（踩过一次：随机走子走出吃老将的局面）
    const l = await waitLine((x) => x.startsWith('info ') || x.startsWith('bestmove'),
      20000, `info（局面 ${fen}）`);
    const m = /score (cp|mate) (-?\d+)/.exec(l);
    if (m) last = m[1] === 'mate' ? (m[2] > 0 ? 30000 : -30000) : Number(m[2]);
    if (l.startsWith('bestmove')) break;
  }
  return last;
}

// === 样本 =====================================================================
/** 双方都没有可吃的子 —— 静态评估只该对安静局面负责 */
function isQuiet(cells, side) {
  for (const s of [side, -side]) {
    for (const mv of generateMoves(cells, s)) if (cells[mv % CELLS] !== EMPTY) return false;
  }
  return true;
}
function phaseOf(cells) {
  let phase = 0;
  for (let i = 0; i < CELLS; i++) if (cells[i] !== EMPTY) phase += PHASE_WEIGHT[Math.abs(cells[i])];
  return phase > PHASE_MAX ? PHASE_MAX : phase;
}
/**
 * 红方视角的子力分（用**模块自己的** `PIECE_VALUE`）。
 *
 * `--fix-mat 1`（默认）时这一项从老师分里扣掉、也不参与拟合 —— 也就是只拟合位置表。
 * 理由见 fit() 里那行报告：子力与位置表在样本里高度简并，放开拟合会解出
 * 「车277、炮22」这种不成比例的数（它们凑出的**总和**是准的，但拆法没有意义）。
 */
function matTerm(cells) {
  let s = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    s += v > 0 ? PIECE_VALUE[Math.abs(v)] : -PIECE_VALUE[Math.abs(v)];
  }
  return s;
}

/** 红方视角：子力 + 过河兵加分（模型里含这一项，拟合时要从老师分里扣掉） */
function bonusTerm(cells, phase) {
  const phi = phase / PHASE_MAX;
  let s = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY || Math.abs(v) !== P) continue;
    const y = yOf(i);
    const past = v > 0 ? y <= 4 : y >= 5;
    if (!past) continue;
    const b = PAWN_BONUS_OPENING * phi + PAWN_BONUS_ENDGAME * (1 - phi);
    s += v > 0 ? b : -b;
  }
  return s;
}

async function sample() {
  const { GENERATED_TREE } = await import(
    pathToFileURL(resolve(HERE, '../js/openings-generated.js')).href);
  // 走子策略：`engine` 用模块自己的引擎走（慢几十倍，但局面像样对局）
  let policy = null;
  if (POLICY === 'engine') {
    const { search } = await import(pathToFileURL(resolve(HERE, '../js/engine.js')).href);
    policy = {
      id: 'policy', name: 'policy', depth: 3, timeLimitMs: 50, quiescence: true,
      noise: 25, blunderRate: 0, checkExtension: 0, mateProbePly: 0, book: 0, search,
    };
  }
  send('uci');
  await waitLine((l) => l === 'uciok', 20000, 'uciok');
  send(`setoption name Threads value ${THREADS}`);
  send('setoption name Hash value 256');
  send('isready');
  await waitLine((l) => l === 'readyok', 60000, 'readyok');

  let samples = [];
  try { samples = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8')); } catch { /* 从头开始 */ }
  const seen = new Set(samples.map((s) => s.fen));
  console.log(`老师：Pikafish depth ${TEACHER_DEPTH}｜走子策略：${POLICY}｜`
    + `已有样本 ${samples.length}，目标 ${N_SAMPLES}`);

  const t0 = Date.now();
  let tries = 0; let rejected = 0; let games = 0;
  const rnd = (n) => Math.floor(Math.random() * n);

  while (samples.length < N_SAMPLES && Date.now() - t0 < BUDGET) {
    games++;
    // 一半从标准开局走（喂饱「接近满盘」的样本，开局表才有支撑），
    // 一半从生成谱里随机挑一个局面（中残局样本来得快）
    const [startFen] = Math.random() < 0.5
      ? [START_FEN]
      : GENERATED_TREE[rnd(GENERATED_TREE.length)];
    const pos = parseFen(startFen);
    const fens = [startFen];
    const warmup = 2 + rnd(5);   // 开局几步随机走，保证每局的走向不一样
    for (let ply = 0; ply < 200; ply++) {
      // **必须用合法着法**：伪合法着法会走出「老将被吃 / 双将照面」的非法局面，
      // 而引擎对非法局面是不回复的（见 teacherScore 的注释）
      const legal = generateLegalMoves(clonePosition(pos));
      if (!legal.length) break;
      const fen = toFen(pos);
      tries++;
      const phase = phaseOf(pos.cells);
      const checked = inCheck(pos.cells, pos.side);
      if (!checked && !seen.has(fen) && isQuiet(pos.cells, pos.side)) {
        const cp = await teacherScore(fen);
        const redCp = pos.side === RED ? cp : -cp;
        if (Math.abs(redCp) <= 800) {
          samples.push({ fen, cp: redCp, phase });
          seen.add(fen);
          if (samples.length % 250 === 0) {
            writeFileSync(SAMPLE_FILE, JSON.stringify(samples));
            console.log(`  样本 ${samples.length}/${N_SAMPLES}（${((Date.now() - t0) / 1000).toFixed(0)}s，`
              + `局数 ${games}，抽样命中率 ${(samples.length / tries * 100).toFixed(1)}%）`);
          }
        } else rejected++;
      }
      // 走子：默认随机（快）；`--policy engine` 时用模块自己的引擎走
      let mv;
      if (!policy || ply < warmup) {
        mv = legal[rnd(legal.length)];
      } else {
        const r = policy.search(toFen(pos), policy, { history: fens });
        mv = r && legal.includes(r.move) ? r.move : legal[rnd(legal.length)];
      }
      pos.cells[mv % CELLS] = pos.cells[Math.floor(mv / CELLS)];
      pos.cells[Math.floor(mv / CELLS)] = EMPTY;
      pos.side = -pos.side;
      fens.push(toFen(pos));
    }
  }
  writeFileSync(SAMPLE_FILE, JSON.stringify(samples));
  const phases = samples.map((s) => s.phase);
  const bucket = [0, 0, 0, 0, 0];
  for (const p of phases) bucket[Math.min(4, Math.floor(p / 11))]++;
  console.log(`\n采样结束：${samples.length} 个样本，${games} 局，${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`分差过大的丢掉 ${rejected} 个`);
  console.log(`相位分布（0=残局…4=满盘）：${bucket.join(' / ')}`);
  send('quit');
  setTimeout(() => process.exit(0), 200);
}

// === 结构化那一路（`--mode struct`）=========================================
// 不拟合 700 个自由格子，而是拟合**模块原有的结构**：纵线分 + 行分 + 单点分。
// 每条参数都能讲出理由（「马越靠边越别扭」「中路比边路值钱」），条件数也好得多 ——
// 上一轮自由拟合解出的表像噪声（兵在 y=2 值 +63、y=1 却 −25），这一路就是针对那个来的。
//
// 结构与 config.js 一致：纵线分只有马 / 炮，行分有马 / 炮 / 车 / 帅，单点分有仕 / 相。
// **兵没有表**（它的位置分就是过河加分），这一版先照旧。
const S_FILE = [N, C];
const S_RANK = [N, C, R, K];
const S_SPOT = [[A, indexOfCell(4, 8)], [B, indexOfCell(4, 7)]];
const N_SFILE = S_FILE.length * 5;
const N_SRANK = S_RANK.length * ROWS;
const N_SSPOT = S_SPOT.length;
const S_OP = 0;
const S_EG = N_SFILE + N_SRANK + N_SSPOT;
const N_FEAT_STRUCT = 2 * S_EG;
const S_NAME = ['帅', '士', '象', '马', '车', '炮', '兵'];
function indexOfCell(x, y) { return y * COLS + x; }

/** 结构化模型的一行特征：同一套「纵线/行/单点」在开局与残局各一份参数 */
function featuresStruct(cells, phase) {
  const phi = phase / PHASE_MAX;
  const idxs = []; const vals = [];
  const add = (i, v) => { idxs.push(i); vals.push(v); };
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const s = red ? 1 : -1;
    const c = red ? i : MIRROR_INDEX[i];   // 与 evaluate() 一致：黑方 y 镜像
    const x = c % COLS; const y = yOf(c);
    for (const [off, w] of [[S_OP, phi], [S_EG, 1 - phi]]) {
      const fi = S_FILE.indexOf(abs);
      if (fi >= 0) add(off + fi * 5 + Math.abs(x - 4), s * w);
      const ri = S_RANK.indexOf(abs);
      if (ri >= 0) add(off + N_SFILE + ri * ROWS + y, s * w);
      for (let k = 0; k < N_SSPOT; k++) {
        if (S_SPOT[k][0] === abs && S_SPOT[k][1] === c) add(off + N_SFILE + N_SRANK + k, s * w);
      }
    }
  }
  return { idxs, vals };
}

/** 结构化模型的预测（子力用模块自己的值，与 predictPstOnly 同一口径） */
function predictStruct(w, cells, phase) {
  const phi = phase / PHASE_MAX;
  let s = bonusTerm(cells, phase) + matTerm(cells);
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const sg = red ? 1 : -1;
    const c = red ? i : MIRROR_INDEX[i];
    const x = c % COLS; const y = yOf(c);
    for (const [off, ww] of [[S_OP, phi], [S_EG, 1 - phi]]) {
      const fi = S_FILE.indexOf(abs);
      if (fi >= 0) s += sg * ww * w[off + fi * 5 + Math.abs(x - 4)];
      const ri = S_RANK.indexOf(abs);
      if (ri >= 0) s += sg * ww * w[off + N_SFILE + ri * ROWS + y];
      for (let k = 0; k < N_SSPOT; k++) {
        if (S_SPOT[k][0] === abs && S_SPOT[k][1] === c) s += sg * ww * w[off + N_SFILE + N_SRANK + k];
      }
    }
  }
  return Math.round(s);
}

/** 把结构化系数按「模块那张表的样子」打出来 —— 好和手写值逐个对照 */
function printStruct(w) {
  for (const [labelText, off] of [['开局', S_OP], ['残局', S_EG]]) {
    console.log(`\n${labelText}表：`);
    for (const t of S_FILE) {
      const row = [];
      for (let x = 0; x < COLS; x++) row.push(Math.round(w[off + S_FILE.indexOf(t) * 5 + Math.abs(x - 4)]));
      console.log(`  纵线 ${S_NAME[t - 1]}  ${row.map((v) => String(v).padStart(5)).join('')}`);
    }
    for (const t of S_RANK) {
      const row = [];
      for (let y = 0; y < ROWS; y++) row.push(Math.round(w[off + N_SFILE + S_RANK.indexOf(t) * ROWS + y]));
      console.log(`  行分 ${S_NAME[t - 1]}  ${row.map((v) => String(v).padStart(5)).join('')}`);
    }
    const spot = S_SPOT.map(([t], k) => `${S_NAME[t - 1]}=${Math.round(w[off + N_SFILE + N_SRANK + k])}`);
    console.log(`  单点 ${spot.join('  ')}`);
  }
}

// === 最小二乘 =================================================================
/** 设计矩阵一行：只填非零特征（每个子 3 项） */
function featuresOf(cells, phase) {
  const phi = phase / PHASE_MAX;
  const idxs = []; const vals = [];
  const add = (i, v) => { idxs.push(i); vals.push(v); };
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const s = red ? 1 : -1;
    const cell = red ? i : MIRROR_INDEX[i];   // 与 evaluate() 完全一致：黑方 y 镜像
    if (abs >= A && !FIX_MAT) add(matIdx(abs), s);
    add(OP_OFF + (abs - 1) * N_PAIR + pairOf(cell), s * phi);
    add(EG_OFF + (abs - 1) * N_PAIR + pairOf(cell), s * (1 - phi));
  }
  return { idxs, vals };
}

/** 解 (XᵀX + λI) w = Xᵀy —— 高斯消元带部分主元 */
function solveNormal(samples, lambda, n, featFn, targetFn) {
  const XtX = new Float64Array(n * n);
  const Xty = new Float64Array(n);
  const rows = [];
  for (const s of samples) {
    const pos = parseFen(s.fen);
    const { idxs, vals } = featFn(pos.cells, s.phase);
    rows.push({ idxs, vals, y: targetFn(pos.cells, s.phase, s.cp) });
  }
  for (const r of rows) {
    for (let a = 0; a < r.idxs.length; a++) {
      const ia = r.idxs[a]; const va = r.vals[a];
      Xty[ia] += va * r.y;
      for (let b = 0; b < r.idxs.length; b++) XtX[ia * n + r.idxs[b]] += va * r.vals[b];
    }
  }
  for (let i = 0; i < n; i++) XtX[i * n + i] += lambda;

  // 增广矩阵 [XtX | Xty]，就地消元
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    M.set(XtX.subarray(i * n, i * n + n), i * (n + 1));
    M[i * (n + 1) + n] = Xty[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r * (n + 1) + col]) > Math.abs(M[piv * (n + 1) + col])) piv = r;
    }
    if (piv !== col) {
      for (let c = col; c <= n; c++) {
        const t = M[col * (n + 1) + c];
        M[col * (n + 1) + c] = M[piv * (n + 1) + c];
        M[piv * (n + 1) + c] = t;
      }
    }
    const d = M[col * (n + 1) + col];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = M[r * (n + 1) + col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r * (n + 1) + c] -= f * M[col * (n + 1) + c];
    }
  }
  const w = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r * (n + 1) + n];
    for (let c = r + 1; c < n; c++) s -= M[r * (n + 1) + c] * w[c];
    const d = M[r * (n + 1) + r];
    w[r] = Math.abs(d) < 1e-12 ? 0 : s / d;
  }
  return w;
}

/** 用一组「系数」预测红方视角分值（与 evaluate() 的式子等价） */
function predictWith(w, cells, phase) {
  const phi = phase / PHASE_MAX;
  let s = bonusTerm(cells, phase);
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const sg = red ? 1 : -1;
    const cell = red ? i : MIRROR_INDEX[i];
    if (abs >= A && !FIX_MAT) s += sg * w[matIdx(abs)];
    s += sg * phi * w[OP_OFF + (abs - 1) * N_PAIR + pairOf(cell)];
    s += sg * (1 - phi) * w[EG_OFF + (abs - 1) * N_PAIR + pairOf(cell)];
  }
  return Math.round(s);
}
/** 用手写表预测（对照用） */
function predictOld(cells, phase) {
  const phi = phase / PHASE_MAX;
  let opening = 0; let endgame = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const sg = red ? 1 : -1;
    const sq = abs * CELLS + (red ? i : MIRROR_INDEX[i]);
    opening += sg * (PIECE_VALUE[abs] + PIECE_SQUARE_OPENING[sq]);
    endgame += sg * (PIECE_VALUE[abs] + PIECE_SQUARE_ENDGAME[sq]);
  }
  return Math.round((opening * phase + endgame * (PHASE_MAX - phase)) / PHASE_MAX) + bonusTerm(cells, phase);
}
const stats = (errs) => {
  const n = errs.length;
  const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / n);
  const bias = errs.reduce((a, b) => a + b, 0) / n;
  return { mae, rmse, bias, n };
};

function fit() {
  const struct = MODE === 'struct';
  const all = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
  // 8 : 2 切分，拟合只用前 80%
  const cut = Math.floor(all.length * 0.8);
  const train = all.slice(0, cut);
  const test = all.slice(cut);
  const nFeat = struct ? N_FEAT_STRUCT : N_FEAT;
  const featFn = struct ? featuresStruct : featuresOf;
  // 两种模式都**固定模块自己的子力值**（`free` 模式下由 --fix-mat 控制），
  // 于是目标里要把子力项与过河兵加分扣掉，剩下的才是位置表要解释的部分
  const targetFn = (cells, phase, cp) => cp - bonusTerm(cells, phase)
    - ((struct || FIX_MAT) ? matTerm(cells) : 0);
  const predict = struct
    ? (w, cells, phase) => predictStruct(w, cells, phase)
    : (w, cells, phase) => (FIX_MAT ? predictPstOnly(w, cells, phase) : predictWith(w, cells, phase));

  console.log(`样本 ${all.length}（拟合 ${train.length} / 留出 ${test.length}）｜`
    + `模式 ${MODE}｜未知数 ${nFeat}｜脊 ${RIDGE}`);
  const t0 = Date.now();
  const w = solveNormal(train, RIDGE, nFeat, featFn, targetFn);
  console.log(`解出用了 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const errNew = []; const errOld = [];
  for (const s of test) {
    const pos = parseFen(s.fen);
    errNew.push(predict(w, pos.cells, s.phase) - s.cp);
    errOld.push(predictOld(pos.cells, s.phase) - s.cp);
  }
  const A_ = stats(errNew); const B_ = stats(errOld);
  console.log('留出集上与老师的偏差（红方视角，单位 cp）：');
  console.log(`  这一版拟合：   MAE ${A_.mae.toFixed(1)}  RMSE ${A_.rmse.toFixed(1)}  偏置 ${A_.bias.toFixed(1)}`);
  console.log(`  现有手写表：   MAE ${B_.mae.toFixed(1)}  RMSE ${B_.rmse.toFixed(1)}  偏置 ${B_.bias.toFixed(1)}`);
  console.log(`  → MAE 改善 ${((1 - A_.mae / B_.mae) * 100).toFixed(1)}%`);
  console.log('  注意：**MAE 不是判据**（同局面内子力项不变，它主要在量刻度差）——'
    + ' 真正的判据是 `agree` 里的排名相关。\n');

  if (struct) {
    console.log('子力：固定用模块自己的值（士200 象200 马400 车900 炮450 兵100）');
    printStruct(w);
  } else {
    if (FIX_MAT) {
      console.log('子力：固定用模块自己的值，只拟合位置表');
    } else {
      const NAMES = ['士', '象', '马', '车', '炮', '兵'];
      const mat = [];
      for (let t = A; t <= P; t++) mat.push(`${NAMES[t - A]}=${w[matIdx(t)].toFixed(0)}`);
      console.log(`拟合出的子力值：${mat.join('  ')}   （现有：士200 象200 马400 车900 炮450 兵100）`);
    }
    // 形状体检：把几类子的表按「行」平均成一行，人眼一扫就知道棋理对不对
    const NAMES = ['帅', '士', '象', '马', '车', '炮', '兵'];
    for (const [labelText, off] of [['开局表', OP_OFF], ['残局表', EG_OFF]]) {
      console.log(`\n${labelText}（按行平均，y=0 是黑方底线、y=9 是红方底线）：`);
      for (const t of [P, N, R]) {
        const row = [];
        for (let y = 0; y < ROWS; y++) {
          let s = 0;
          for (let dx = 0; dx < 5; dx++) s += w[off + (t - 1) * N_PAIR + dx * ROWS + y];
          row.push(Math.round(s / 5));
        }
        console.log(`  ${NAMES[t - 1]}  ${row.map((v) => String(v).padStart(5)).join('')}`);
      }
    }
  }

  const out = resolve(ROOT, struct ? 'tmp/pst-struct.json'
    : (FIX_MAT ? 'tmp/pst-new.json' : 'tmp/pst-new-free.json'));
  writeFileSync(out, JSON.stringify({
    w: [...w], engine: ENGINE, teacherDepth: TEACHER_DEPTH, mode: MODE, fixMat: FIX_MAT,
    ridge: RIDGE, samples: all.length, mae: A_.mae, maeOld: B_.mae,
  }));
  console.log(`\n系数已存 ${out.replace(/\\/g, '/').split('/').slice(-1)[0]}`);
}

// === 快照 / 产出 ==============================================================
function snapshot() {
  const pack = (t) => [...t];
  writeFileSync(OLD_FILE, JSON.stringify({
    pieceValue: [...PIECE_VALUE],
    pawnBonus: [PAWN_BONUS_OPENING, PAWN_BONUS_ENDGAME],
    opening: pack(PIECE_SQUARE_OPENING),
    endgame: pack(PIECE_SQUARE_ENDGAME),
    phaseMax: PHASE_MAX,
  }));
  console.log(`当前手写表已存 ${OLD_FILE}（${pack(PIECE_SQUARE_OPENING).length} + `
    + `${pack(PIECE_SQUARE_ENDGAME).length} 个数）`);
}

/** 系数 → 7 × 90 平表（50 组折回 90 格） */
function unfold(w, off) {
  const t = new Int16Array(8 * CELLS);
  for (let abs = 1; abs <= P; abs++) {
    for (let idx = 0; idx < CELLS; idx++) {
      t[abs * CELLS + idx] = Math.round(w[off + (abs - 1) * N_PAIR + pairOf(idx)]);
    }
  }
  return t;
}

/**
 * 尺度无关的体检：**同一个局面内**，模块评估对各候选着法的排序与引擎的排序一致吗？
 *
 * 为什么不用 MAE：同一个局面下所有着法的**子力项几乎一样**（只有走动的那个子变了），
 * 所以 MAE 主要在量「两边的子力刻度差多少」，而不是「位置判断准不准」——
 * 拿它评价位置表会被刻度差淹没（实测：固定模块子力只拟合位置表时 MAE 574，
 * 但那个数字里绝大部分与位置表无关）。排名相关只看**序**，两边各自的刻度自动抵消。
 */
async function agree() {
  const N = Number(opt('n', 200));
  const all = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
  const test = all.slice(Math.floor(all.length * 0.8)).slice(0, N);
  const models = [];
  models.push({
    name: '现有手写表',
    predict: (cells, phase) => predictOld(cells, phase),
  });
  const free = JSON.parse(readFileSync(resolve(ROOT, 'tmp/pst-new-free.json'), 'utf8'));
  models.push({
    name: '放开拟合（子力+表）',
    predict: (cells, phase) => predictWith(Float64Array.from(free.w), cells, phase),
  });
  try {
    const fixed = JSON.parse(readFileSync(resolve(ROOT, 'tmp/pst-new.json'), 'utf8'));
    const w = Float64Array.from(fixed.w);
    models.push({
      name: '固定子力只拟合表',
      predict: (cells, phase) => predictPstOnly(w, cells, phase),
    });
  } catch { /* 没跑过 fix-mat 1 就算了 */ }
  try {
    const st = JSON.parse(readFileSync(resolve(ROOT, 'tmp/pst-struct.json'), 'utf8'));
    const w = Float64Array.from(st.w);
    models.push({
      name: '结构化拟合（纵线+行+单点）',
      predict: (cells, phase) => predictStruct(w, cells, phase),
    });
  } catch { /* 没跑过 --mode struct 就算了 */ }
  // 小网络（`nn` 阶段训出来的）：扫 tmp/nn-*.json，有几个体检几个。
  // 它们与上面那几个**用同一套特征**，区别只在「线性 → 一层 ReLU」—— 这正是要问的那件事。
  // tmp/ 是随时可以整个删掉的（见根目录 AGENTS.md），所以这里必须容错。
  try {
    for (const f of readdirSync(resolve(ROOT, 'tmp'))) {
      if (!/^nn-.+\.json$/.test(f)) continue;
      const nnw = JSON.parse(readFileSync(resolve(ROOT, 'tmp', f), 'utf8'));
      const rt = runtimeNet(nnw);
      models.push({
        name: rt.label || f,
        predict: (cells, phase) => predictNet(rt, cells, phase),
      });
    }
  } catch { /* 没有 tmp/ 或者文件坏了：当作没有小网络 */ }

  send('uci');
  await waitLine((l) => l === 'uciok', 20000, 'uciok');
  send(`setoption name Threads value ${PF_THREADS}`);
  send('setoption name MultiPV value 8');
  send('isready');
  await waitLine((l) => l === 'readyok', 30000, 'readyok');

  const sum = new Map(models.map((m) => [m.name, 0]));
  const top1 = new Map(models.map((m) => [m.name, 0]));
  let used = 0;
  for (const s of test) {
    const pos = parseFen(s.fen);
    send(`position fen ${s.fen}`);
    send(`go depth ${TEACHER_DEPTH}`);
    const byPv = [];
    for (;;) {
      const l = await waitLine((x) => x.startsWith('info ') || x.startsWith('bestmove'), 30000, 'info');
      const m = /multipv (\d+).*score cp (-?\d+).* pv (\S+)/.exec(l);
      if (m) byPv[Number(m[1]) - 1] = { cp: Number(m[2]), iccs: m[3] };
      if (l.startsWith('bestmove')) break;
    }
    const list = byPv.filter(Boolean);
    if (list.length < 4) continue;
    used++;
    const engineRank = new Map();
    [...list].sort((a, b) => b.cp - a.cp).forEach((e, i) => engineRank.set(e.iccs, i));

    for (const model of models) {
      const deltas = list.map((e) => {
        const after = parseFen(s.fen);
        const mv = moveOfIccs(e.iccs);
        after.cells[mv % CELLS] = after.cells[Math.floor(mv / CELLS)];
        after.cells[Math.floor(mv / CELLS)] = EMPTY;
        after.side = -after.side;
        const d = model.predict(after.cells, phaseOf(after.cells))
          - model.predict(pos.cells, s.phase);
        return pos.side === RED ? d : -d;
      });
      // 两边各自排名，算 Spearman（只用名次差）
      const myRank = new Map();
      deltas.map((d, i) => [i, d]).sort((a, b) => b[1] - a[1])
        .forEach(([i], r) => myRank.set(list[i].iccs, r));
      let sq = 0;
      for (const e of list) {
        const diff = myRank.get(e.iccs) - engineRank.get(e.iccs);
        sq += diff * diff;
      }
      const k = list.length;
      const rho = 1 - (6 * sq) / (k * (k * k - 1));
      sum.set(model.name, sum.get(model.name) + rho);
      if (myRank.get(list[0].iccs) === engineRank.get(list[0].iccs)) {
        top1.set(model.name, top1.get(model.name) + 1);
      }
    }
  }
  console.log(`用 ${used} 个留出局面（每个取引擎 MultiPV 8 的着法与分）体检`
    + `（裁判 depth ${TEACHER_DEPTH} / ${PF_THREADS} 线程）：\n`);
  console.log('  模型                      平均排名相关 ρ    与引擎首选一致率');
  for (const m of models) {
    console.log(`  ${m.name.padEnd(22)} ${(sum.get(m.name) / used).toFixed(3)}`
      + `            ${(top1.get(m.name) / used * 100).toFixed(1)}%`);
  }
  console.log('\n（ρ 越接近 1 越好，0 = 与引擎的排序无关。这个指标两边刻度自动抵消）');
  send('quit');
  setTimeout(() => process.exit(0), 200);
}

// === 小网络（`nn` 阶段）=====================================================
// 「换个**形式**」那一问的仪器。特征与线性拟合完全同一套（见 nnFeatures 的注释），
// 区别只在中间加一层 ReLU 隐藏单元；`--hidden 0` 退化成线性，作为**同一套特征、同一套
// 训练过程**下的对照组 —— 这样「非线性有没有用」才是干净的对照。

/** 小网络的稀疏特征：与 `featuresOf` 同一个布局，但**子力恒在**（不受 --fix-mat 影响） */
function nnFeatures(cells, phase) {
  const phi = phase / PHASE_MAX;
  const idxs = [];
  const vals = [];
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const sg = red ? 1 : -1;
    const cell = red ? i : MIRROR_INDEX[i];   // 黑方 y 镜像，与 evaluate() 一致
    if (abs >= A) { idxs.push(matIdx(abs)); vals.push(sg); }
    idxs.push(OP_OFF + (abs - 1) * N_PAIR + pairOf(cell));
    vals.push(sg * phi);
    idxs.push(EG_OFF + (abs - 1) * N_PAIR + pairOf(cell));
    vals.push(sg * (1 - phi));
  }
  return { idxs, vals };
}

/** 可复现的随机源（初始化 + 打乱样本） */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把样本预处理成「稀疏特征 + 目标」，训练时不再解析 FEN。
 *
 * 目标与 `fit` 的 `targetFn` **同一个口径**（这样两种形式才可比）：
 *
 *   - `--fix-mat 1`（默认）：目标里扣掉子力与过河兵分 ⇒ **网络只扮演位置表的角色**，
 *     预测时再加回来。这正是「线性位置表拟合失败」那件事的**同口径对照**。
 *   - `--fix-mat 0`：目标就是老师分本身（子力一起学）。
 */
function nnPrepare(samples) {
  return samples.map((s) => {
    const pos = parseFen(s.fen);
    const { idxs, vals } = nnFeatures(pos.cells, s.phase);
    const y = FIX_MAT
      ? s.cp - matTerm(pos.cells) - bonusTerm(pos.cells, s.phase)
      : s.cp;
    return { idxs, vals, y };
  });
}

/** ReLU 前向。`h` 是调用方给的缓冲，**回来时已经被 ReLU 就地改过**（反向要用它当掩码） */
function netForward(net, idxs, vals, h) {
  const { w1, b1, w2, b2, nHid } = net;
  for (let k = 0; k < nHid; k++) h[k] = b1[k];
  for (let a = 0; a < idxs.length; a++) {
    const base = idxs[a] * nHid;
    const v = vals[a];
    for (let k = 0; k < nHid; k++) h[k] += w1[base + k] * v;
  }
  let out = b2[0];
  for (let k = 0; k < nHid; k++) {
    if (h[k] < 0) h[k] = 0; else out += w2[k] * h[k];
  }
  return out;
}

/**
 * 训练一个小网络（Adam + 早停）。
 *
 * 目标做了**标准化**（减均值除标准差）：它的倒数正好放进输出层，于是学习率不必随
 * 老师分的刻度调 —— 与 `agree` 的 ρ 尺度无关这一点也是一致的。
 *
 * **线性对照不在这里**：`--hidden 0` 会被拒掉。理由是同口径的线性基线已经有了，
 * 而且比随机梯度下降强 —— `fit` 阶段用最小二乘（`solveNormal`）解的就是这套特征。
 */
function trainNet(train, val, nIn, nHid, rng, log) {
  const ys = train.map((s) => s.y);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const std = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length) || 1;
  const scale = (y) => (y - mean) / std;

  const w1 = new Float64Array(nIn * nHid);
  const b1 = new Float64Array(nHid);
  const w2 = new Float64Array(nHid);
  const b2 = new Float64Array(1);
  const lim = 1 / Math.sqrt(nIn);
  for (let i = 0; i < w1.length; i++) w1[i] = (rng() * 2 - 1) * lim;
  for (let i = 0; i < w2.length; i++) w2[i] = (rng() * 2 - 1) * lim * 4;
  const net = { w1, b1, w2, b2, nHid, nIn, mean, std };
  const h = new Float64Array(nHid);
  const dz = new Float64Array(nHid);
  const g1 = new Float64Array(nIn * nHid);
  const gb1 = new Float64Array(nHid);
  const g2 = new Float64Array(nHid);
  const gb2 = new Float64Array(1);
  // Adam 的一阶 / 二阶动量
  const m1 = new Float64Array(w1.length); const v1 = new Float64Array(w1.length);
  const mb1 = new Float64Array(nHid); const vb1 = new Float64Array(nHid);
  const m2 = new Float64Array(nHid); const v2 = new Float64Array(nHid);
  const mb2 = new Float64Array(1); const vb2 = new Float64Array(1);
  let step = 0;

  const mse = (set) => {
    let s = 0;
    for (const x of set) s += (netForward(net, x.idxs, x.vals, h) - scale(x.y)) ** 2;
    return s / set.length;
  };
  const order = train.map((_, i) => i);
  let best = { val: Infinity, epoch: 0, copy: null };
  const copy = () => ({
    w1: w1.slice(), b1: b1.slice(), w2: w2.slice(), b2: b2.slice(),
  });

  for (let epoch = 1; epoch <= EPOCHS; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {   // 每个 epoch 重新打乱
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let start = 0; start < order.length; start += BATCH) {
      const end = Math.min(start + BATCH, order.length);
      g1.fill(0); gb1.fill(0); g2.fill(0); gb2.fill(0);
      for (let b = start; b < end; b++) {
        const x = train[order[b]];
        const out = netForward(net, x.idxs, x.vals, h);
        // h 已经被 ReLU 就地改过：<=0 的就是被截掉的单元，反向时梯度为 0
        const dOut = 2 * (out - scale(x.y));
        gb2[0] += dOut;
        for (let k = 0; k < nHid; k++) {
          if (h[k] <= 0) { dz[k] = 0; continue; }
          g2[k] += dOut * h[k];
          dz[k] = dOut * w2[k];
        }
        for (let k = 0; k < nHid; k++) {
          if (dz[k] === 0) continue;
          gb1[k] += dz[k];
          const d = dz[k];
          for (let a = 0; a < x.idxs.length; a++) g1[x.idxs[a] * nHid + k] += d * x.vals[a];
        }
      }
      const n = end - start;
      step++;
      // AdamW：权重衰减是**解耦**的那一项（不经过 Adam 归一化）。
      // 不这么做的话 L2 会被 Adam 的自适应步长吃掉 —— 实测过：衰减 1e-5 那版第 2 轮就开始过拟合。
      const adam = (p, g, m, v, decay) => {
        const bc1 = 1 - 0.9 ** step;
        const bc2 = 1 - 0.999 ** step;
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / n;
          m[i] = 0.9 * m[i] + 0.1 * gi;
          v[i] = 0.999 * v[i] + 0.001 * gi * gi;
          p[i] -= LR * ((m[i] / bc1) / (Math.sqrt(v[i] / bc2) + 1e-8) + decay * p[i]);
        }
      };
      adam(w1, g1, m1, v1, L2);
      adam(w2, g2, m2, v2, L2);
      adam(b1, gb1, mb1, vb1, 0);
      adam(b2, gb2, mb2, vb2, 0);
    }
    const vNow = mse(val);
    if (vNow < best.val - 1e-4) {
      best = { val: vNow, epoch, copy: copy() };
    } else if (epoch - best.epoch >= 30) {
      log(`  早停于第 ${epoch} 轮（最好在 ${best.epoch} 轮，留出 MSE ${best.val.toFixed(4)}）`);
      break;
    }
  }
  Object.assign(net, best.copy);
  return { net, scale, trainMse: mse(train), valMse: best.val, epoch: best.epoch };
}

/** 存储态（JSON 里的普通数组）→ 运行态（TypedArray）。每张网只转一次 */
function runtimeNet(nnw) {
  return {
    label: nnw.label, nHid: nnw.nHid, mean: nnw.mean, std: nnw.std, pstOnly: !!nnw.pstOnly,
    w1: Float64Array.from(nnw.w1), b1: Float64Array.from(nnw.b1),
    w2: Float64Array.from(nnw.w2), b2: Float64Array.from(nnw.b2),
  };
}

/**
 * 用训好的权重预测**红方视角的分值**（`agree` 的 model.predict 接口）。
 * `net` 是 runtimeNet() 的产物。`pstOnly` 的那一版要把子力与过河兵分加回来 ——
 * 训练时它们被扣掉了（见 nnPrepare），这样网络的角色与「位置表」完全对齐。
 */
function predictNet(net, cells, phase) {
  const { idxs, vals } = nnFeatures(cells, phase);
  let s = net.mean + net.std * netForward(net, idxs, vals, new Float64Array(net.nHid));
  if (net.pstOnly) s += matTerm(cells) + bonusTerm(cells, phase);
  return Math.round(s);
}

function nn() {
  if (HIDDEN < 1) {
    console.log('--hidden 至少 1（线性那一版用 `fit` 的最小二乘，比 SGD 强，不在这儿比）');
    return;
  }
  const all = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
  // 6 : 2 : 2 —— 训练 / 早停 / 留出。**留出集与 agree() 用的是同一段**（最后 20%），
  // 但它不参与训练也不参与早停，所以 agree 上的差距不是过拟合。
  const nTrain = Math.floor(all.length * 0.6);
  const nVal = Math.floor(all.length * 0.2);
  const train = nnPrepare(all.slice(0, nTrain));
  const val = nnPrepare(all.slice(nTrain, nTrain + nVal));
  const nIn = N_FEAT;
  console.log(`样本 ${all.length}（训练 ${train.length} / 早停 ${val.length} / 留出 ${all.length - nTrain - nVal}）`
    + `｜特征 ${nIn}｜隐藏 ${HIDDEN}｜分布 ${SAMPLE_TAG}｜种子 ${SEED}`
    + `｜目标 ${FIX_MAT ? '只学位置项（子力 + 过河兵固定）' : '老师分全体'}`);
  const t0 = Date.now();
  const { net, trainMse, valMse, epoch } = trainNet(train, val, nIn, HIDDEN, mulberry32(SEED), console.log);
  console.log(`训练用了 ${((Date.now() - t0) / 1000).toFixed(1)}s｜最好第 ${epoch} 轮｜`
    + `训练 MSE ${trainMse.toFixed(4)}｜早停 MSE ${valMse.toFixed(4)}（目标是标准化后的老师分，`
    + `所以 MSE 的量纲是「标准差」）`);
  const label = `小网络 H${HIDDEN}（${SAMPLE_TAG}${FIX_MAT ? '，只换位置项' : ''}）`;
  const file = `nn-${SAMPLE_TAG}-h${HIDDEN}${FIX_MAT ? '-pst' : ''}.json`;
  const out = resolve(ROOT, `tmp/${file}`);
  const saved = {
    label, hidden: HIDDEN, samples: SAMPLE_TAG, n: all.length, seed: SEED, epochs: epoch,
    pstOnly: FIX_MAT, mean: net.mean, std: net.std,
    nIn: net.nIn, nHid: net.nHid,
    w1: [...net.w1], b1: [...net.b1], w2: [...net.w2], b2: [...net.b2],
  };
  writeFileSync(out, JSON.stringify(saved));

  // **公平性对照**：留出集（最后 20%，与 agree() 用的是同一段）上的 cp 误差，
  // 与手写表在**同一批样本**上的误差并排打出来。只报 ρ 的话，没法区分
  // 「网络拟合得更准、只是排序差」与「网络根本没训好」—— 这两件事的结论完全不同。
  const rt = runtimeNet(saved);
  const holdout = all.slice(nTrain + nVal);
  let eNet = 0; let eOld = 0;
  for (const s of holdout) {
    const pos = parseFen(s.fen);
    eNet += (predictNet(rt, pos.cells, s.phase) - s.cp) ** 2;
    eOld += (predictOld(pos.cells, s.phase) - s.cp) ** 2;
  }
  const rmse = (e) => Math.sqrt(e / holdout.length);
  console.log(`留出集（${holdout.length} 个样本）上的 RMSE（cp）：`
    + `小网络 ${rmse(eNet).toFixed(1)}｜现有手写表 ${rmse(eOld).toFixed(1)}`
    + `  —— MAE/RMSE 不是判据（见文件头），这里只用来分辨「拟合得准不准」`);
  console.log(`权重已存 tmp/${file}（${label}）`
    + ` —— 跑 agree --samples ${SAMPLE_TAG} 就会把它一起体检`);
}

/** 只用 PST、子力取模块自己的值（对应 --fix-mat 1 的产物） */
function predictPstOnly(w, cells, phase) {
  const phi = phase / PHASE_MAX;
  let s = bonusTerm(cells, phase) + matTerm(cells);
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = Math.abs(v);
    const red = v > 0;
    const sg = red ? 1 : -1;
    const cell = red ? i : MIRROR_INDEX[i];
    s += sg * phi * w[OP_OFF + (abs - 1) * N_PAIR + pairOf(cell)];
    s += sg * (1 - phi) * w[EG_OFF + (abs - 1) * N_PAIR + pairOf(cell)];
  }
  return Math.round(s);
}

function emit() {
  const { w } = JSON.parse(readFileSync(resolve(ROOT, 'tmp/pst-new.json'), 'utf8'));
  const value = new Int16Array(8);
  for (let abs = A; abs <= P; abs++) value[abs] = Math.round(w[matIdx(abs)]);
  const opening = unfold(w, OP_OFF);
  const endgame = unfold(w, EG_OFF);
  const arr = (t) => {
    const rows = [];
    for (let abs = 1; abs <= P; abs++) {
      rows.push(`  // ${'帅士象马车炮兵'[abs - 1]}\n    [` +
        [...t.subarray(abs * CELLS, abs * CELLS + CELLS)].join(',') + '],');
    }
    return rows.join('\n');
  };
  const content = `/**
 * 位置表与子力值（Pikafish 蒸馏的那一版）—— **这个文件是生成的，别手改**。
 *
 * 生成：\`node chinese-chess/tools/gen-pst.mjs snapshot/sample/fit/emit\`。
 * 它把 Pikafish 的判断**拟合**成 \`config.js\` 里评估的形状（子力 + 开局表 + 残局表，
 * 按相位插值）—— 为什么是拟合而不是逐子探测、老师是谁、样本怎么取，
 * 见 \`tools/gen-pst.mjs\` 头部与 \`docs/pst.md\`。
 *
 * 数据来源：${ENGINE}（只离线跑，运行时不需要引擎）。
 *
 * 索引习惯与 \`config.js\` 一致：\`表[棋子编码 * 90 + 格子]\`，格子是**红方视角**
 * （黑方查表时 y 镜像，见 \`MIRROR_INDEX\`）。左右对称 —— 拟合时就把 (|x-4|, y) 当一个
 * 未知数，所以左右对称的局面评估仍然恰好为 0（\`test-engine.mjs\` 钉着这条）。
 */

export const PST_SOURCE = '${ENGINE}';

/** 子力值，索引 = 棋子编码（1..7）。帅恒 0。 */
export const GENERATED_PIECE_VALUE = [${[...value].join(', ')}];

/** 开局位置表 */
export const GENERATED_PST_OPENING = [
${arr(opening)}
];

/** 残局位置表 */
export const GENERATED_PST_ENDGAME = [
${arr(endgame)}
];
`;
  writeFileSync(OUT_FILE, content);
  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB（gzip 后 ${(gzipSync(s).length / 1024).toFixed(1)} KB）`;
  console.log(`已写出 ${OUT_FILE.replace(/\\/g, '/').split('/').slice(-2).join('/')}`);
  console.log(`  子力 ${[...value].join(', ')} —— ${kb(content)}`);
}

if (stage === 'sample') await sample();
else if (stage === 'fit') fit();
else if (stage === 'agree') await agree();
else if (stage === 'nn') nn();
else if (stage === 'snapshot') snapshot();
else if (stage === 'emit') emit();
else console.log('用法：snapshot｜sample｜fit｜nn｜agree｜emit（详见文件头部注释）');
