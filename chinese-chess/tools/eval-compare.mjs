#!/usr/bin/env node
/**
 * **配置对照** —— 一次比一组「评估参数」，逐局面配对，回答「哪一组更好，好多少」。
 * （离线工具，不参与网页运行；`--judge` 那部分需要本地有 Pikafish。）
 *
 * ## 它补的是哪个缺口
 *
 * 这个仓库量棋力有四把家伙，各有各的短处，这一把是补最短的那块：
 *
 * | 工具 | 量什么 | 短处 |
 * |---|---|---|
 * | `strength.mjs`（棋力尺子） | 真实预算下每步亏多少 cp | **时间预算会抖**，几个 cp 的差别读不出来 |
 * | `move-diff.mjs`（着法对照） | 两个**代码状态**之间换了几步棋 | 只能比两个状态，换一组参数得改代码、跑两轮 |
 * | `gen-pst.mjs agree`（ρ） | 同局面内排序相关 | **不能给「加不加某一项」投票**（见 decisions.md 第 24 条） |
 * | **本工具** | 多组参数各走一遍，**逐局面配对** | 固定深度 ⇒ 看不见「评估变贵/变便宜」 |
 *
 * 三件事让它比尺子灵敏得多：
 *   1. **固定深度 + noise 0 + 无连将杀探测** ⇒ 每组配置的着法**完全确定**，
 *      不受时间抖动影响（尺子量的是「1.5 秒里搜到哪」）；
 *   2. **配对对照**：逐局面比两组的损失，报「胜 / 平 / 负」几局 ——
 *      总损失会被一个局面的运气骗（decisions.md 第 24 条那次，−182cp 的「改进」只来自 1 个局面）；
 *   3. **裁判评分按 `(局面, 着法)` 缓存**：同一个 `(局面, 着法)` 只判一次，
 *      所以扫一组配置的总开销只与「**不同着法的个数**」成正比，不与「配置数 × 局面数」成正比。
 *      缓存还能落到 json 里跨次复用（默认 `tmp/eval-cache.json`，在 tmp/ 里随时可删）。
 *
 * ## 用法
 *
 *   # 机动性权重：现状 / 车3马3炮4 / 关掉
 *   node chinese-chess/tools/eval-compare.mjs --configs "mobility=3/2/3,mobility=3/3/4,mobility=0/0/0"
 *
 *   # 子力值：士/相/马/车/炮/兵（第 0 组是基线）
 *   node chinese-chess/tools/eval-compare.mjs --configs "piece=200/200/400/900/450/100,piece=200/200/400/900/500/100"
 *
 * 参数：`--set`（默认 `all`）/ `--n`（每组取多少个，默认 300）/ `--depth`（默认 6）/
 * `--pf`（裁判深度，默认 16）/ `--base`（第几组当基线，默认 0）/ `--no-cache`（不用磁盘缓存）。
 *
 * ## 怎么读（三条都是踩出来的）
 *
 * - **先看配对那一列**（对基线的 胜/平/负）：接近对半就是噪声，别信总损失的小差距。
 * - 再看**中位数与漏着数**（均值被一个 400cp 的漏着带跑），以及**分组**：
 *   同一个参数在开局与中局的表现经常相反。
 * - ⚠️ **准备采纳一个改动时，固定深度的结论必须在至少两个深度上复核**，别只跑一个深度就拍板。
 *   （只跑了深度 6 就已经是「平局」或「明显更差」的，不必再跑第二个 —— 没有要采纳的东西，
 *   多跑一个深度也改不了动作。）
 *   实测教训：`piece=.../600/...`（把炮的基础值从 450 提到 600）在**深度 6** 上看着漂亮 ——
 *   总损失 −979、配对 20 胜 / 242 平 / 7 负、四个组全变好、而且扫 450~900 是个**有内部最优的
 *   光滑曲线**（600 最好、900 远差于基线）—— 看着像真信号。**换到深度 7，它当场消失**
 *   （同 124 个开局局面：深度 6 是 −457 / 9 胜 2 负，深度 7 只剩 −54 / **5 胜 8 负**），
 *   真实预算的尺子也不支持（opening 43.2 → 44.9）。**那个改动最后被撤销了。**
 *   对照：机动性开关那条在两个深度上量级一致（中局 +322 → +447、残局 +15 → +22），
 *   才算站得住。
 * - **它回答不了「变快还是变慢」**：改评估开销（比如给每个子算机动性）之后，
 *   仍然要补一次 `strength.mjs` 的真实预算对照。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');
const load = (rel) => import(pathToFileURL(resolve(HERE, '../js', rel)).href);

const { CELLS, EMPTY, A, B, N, R, C, P, MOBILITY_WEIGHT, PIECE_VALUE } = await load('config.js');
const { search } = await load('engine.js');
const { parseFen, toFen } = await load('position.js');
const { iccsOfMove, moveOfIccs } = await load('iccs.js');
const { resolveSets, strengthPositions } =
  await import(pathToFileURL(resolve(HERE, 'strength-positions.mjs')).href);

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DEPTH = Number(arg('depth', 6));
const PF = Number(arg('pf', 16));
const COUNT = Number(arg('n', 300));
const BASE = Number(arg('base', 0));
const SETS = resolveSets(arg('set', 'all'));
const CACHE_FILE = resolve(ROOT, arg('cache', 'tmp/eval-cache.json'));
let CACHE = { pf: PF, before: {}, after: {} };
if (!argv.includes('--no-cache') && existsSync(CACHE_FILE)) {
  const old = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  if (old.pf === PF) CACHE = old;      // 换了裁判深度就重判（分数不可比）
}

/**
 * 可调的评估参数表。
 *
 * 每一项 = 一个**运行时同一个数组**（改它就是改评估），槽位按名字给（不数位置 ——
 * 第 22 条那个 bug 就是数位置数出来的）。
 */
const PARAMS = {
  mobility: { target: MOBILITY_WEIGHT, slots: { 车: R, 马: N, 炮: C } },
  piece: { target: PIECE_VALUE, slots: { 士: A, 相: B, 马: N, 车: R, 炮: C, 兵: P } },
};
const ORIGINAL = { mobility: Int8Array.from(MOBILITY_WEIGHT), piece: Int32Array.from(PIECE_VALUE) };

const configs = String(arg('configs', 'mobility=3/2/3')).split(',').map((spec) => {
  const parts = {};
  const text = [];
  for (const kv of spec.trim().split('+')) {
    const [name, values] = kv.split('=').map((s) => s.trim());
    const table = PARAMS[name];
    if (!table) {
      console.log(`不认识的参数「${name}」—— 可选：${Object.keys(PARAMS).join(' / ')}`);
      process.exit(1);
    }
    const nums = values.split('/').map(Number);
    const keys = Object.keys(table.slots);
    if (nums.length !== keys.length) {
      console.log(`「${name}」要给 ${nums.length === 0 ? '' : keys.length} 个值（${keys.join('/')}），`
        + `现在给了 ${nums.length} 个：${values}`);
      process.exit(1);
    }
    parts[name] = nums;
    text.push(`${name}=${nums.join('/')}`);
  }
  return { parts, label: text.join(' ') };
});
if (BASE < 0 || BASE >= configs.length) { console.log('--base 越界'); process.exit(1); }

function applyConfig(cfg) {
  for (const [name, nums] of Object.entries(cfg.parts)) {
    const { target, slots } = PARAMS[name];
    Object.entries(slots).forEach(([key, idx], i) => { target[idx] = nums[i]; });
  }
}

const POSITIONS = strengthPositions({ sets: SETS, n: COUNT });
const bySet = {};
for (const p of POSITIONS) bySet[p.set] = (bySet[p.set] || 0) + 1;
console.log(`局面：${Object.entries(bySet).map(([k, v]) => `${k} ${v}`).join(' + ')} = ${POSITIONS.length} 个`
  + `｜固定深度 ${DEPTH}｜裁判 depth ${PF}｜配置 ${configs.length} 组（基线：${configs[BASE].label}）\n`);

// === 第一遍：每组配置各走一遍（完全确定） ===
const runs = [];
for (const [i, cfg] of configs.entries()) {
  applyConfig(cfg);
  const moves = POSITIONS.map((p) => {
    const r = search(p.fen, {
      id: 'o', name: 'o', depth: DEPTH, timeLimitMs: 600000,
      quiescence: true, noise: 0, blunderRate: 0, checkExtension: 6, mateProbePly: 0, book: 0,
    }, { history: [p.fen] });
    return r ? iccsOfMove(r.move) : null;
  });
  runs.push({ cfg, moves });
  const changed = i === BASE ? 0 : moves.filter((m, k) => m !== runs[BASE].moves[k]).length;
  process.stderr.write(`  [${i + 1}/${configs.length}] ${cfg.label} 走完`
    + `${i === BASE ? '' : `（与基线 ${changed} 步不同）`}\n`);
}
configs.forEach((c, i) => applyConfig(configs[i]));   // 收尾恢复（本进程用完就退，纯属卫生）

// === 第二遍：裁判判分（带缓存） ===
const need = new Map();
for (const { moves } of runs) {
  POSITIONS.forEach((p, i) => {
    if (!moves[i]) return;
    if (!need.has(p.fen)) need.set(p.fen, new Set());
    need.get(p.fen).add(moves[i]);
  });
}
const todo = [];
for (const [fen, moves] of need) {
  if (CACHE.before[fen] === undefined) todo.push(['before', fen, null]);
  for (const iccs of moves) if (CACHE.after[`${fen}|${iccs}`] === undefined) todo.push(['after', fen, iccs]);
}
console.log(`裁判要判：${todo.length} 次（局面 ${need.size} 个，已缓存 ${Object.keys(CACHE.before).length} 个）`);
if (todo.length) {
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
  async function judge(fen) {
    send(`position fen ${fen}`);
    send(`go depth ${PF}`);
    let score = null;
    for (;;) {
      const l = await waitLine((x) => x.startsWith('info ') || x.startsWith('bestmove'), 60000, 'info');
      const m = /score (cp|mate) (-?\d+)/.exec(l);
      if (m) score = m[1] === 'mate' ? (Number(m[2]) > 0 ? 9000 : -9000) : Number(m[2]);
      if (l.startsWith('bestmove')) break;
    }
    return score;
  }
  send('uci');
  await waitLine((l) => l === 'uciok', 20000, 'uciok');
  send('setoption name Threads value 4');
  send('setoption name Hash value 256');
  send('isready');
  await waitLine((l) => l === 'readyok', 30000, 'readyok');
  for (const [kind, fen, iccs] of todo) {
    if (kind === 'before') CACHE.before[fen] = await judge(fen);
    else {
      const pos = parseFen(fen);
      const mv = moveOfIccs(iccs);
      const from = Math.floor(mv / CELLS), to = mv % CELLS;
      pos.cells[to] = pos.cells[from];
      pos.cells[from] = EMPTY;
      pos.side = -pos.side;
      // 裁判给的是「走完之后轮走方」的视角，取负换成**走子方**的视角
      CACHE.after[`${fen}|${iccs}`] = -(await judge(toFen(pos)));
    }
  }
  send('quit');
  proc.kill();
  if (!argv.includes('--no-cache')) writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  console.log('');
}

/**
 * 某个配置在某个局面上的损失（null = 杀棋局面或没有着法，不计入）。
 *
 * 符号约定（这里是全工具最容易写反的地方）：
 *   `CACHE.before[fen]` = 裁判对局面的评分，**走子方视角**（存的就是裁判原值）；
 *   `CACHE.after[fen|着法]` = **走完那一步之后、走子方还剩多少分**（存的是裁判值的相反数，
 *     因为裁判给的是「走完之后轮走方（对手）」的视角）。
 * 于是 `损失 = 走之前 − 走之后`。
 */
const lossOf = (moves, i) => {
  const iccs = moves[i];
  if (!iccs) return null;
  const fen = POSITIONS[i].fen;
  const before = CACHE.before[fen];
  const after = CACHE.after[`${fen}|${iccs}`];
  if (before === undefined || after === undefined) return null;
  if (Math.abs(before) >= 9000 || Math.abs(after) >= 9000) return null;   // 杀棋局面不计
  return Math.max(0, before - after);
};

function stats(rows) {
  const ls = rows.filter((v) => v !== null).sort((a, b) => a - b);
  if (!ls.length) return null;
  const sum = ls.reduce((s, v) => s + v, 0);
  return {
    n: ls.length, total: sum, mean: sum / ls.length,
    median: ls[Math.floor(ls.length / 2)],
    blunders: ls.filter((v) => v > 100).length,
  };
}
const lossesByConfig = runs.map(({ moves }) => POSITIONS.map((_, i) => lossOf(moves, i)));
const baseLoss = lossesByConfig[BASE];

const pad = (s, w) => String(s).padStart(w);
const head = '配置'.padEnd(22) + '组'.padEnd(12) + pad('局面', 5) + pad('总损失', 8)
  + pad('平均', 7) + pad('中位数', 7) + pad('漏着', 5) + pad('对基线(胜/平/负)', 18) + pad('净差', 7);
console.log(head);
console.log('-'.repeat(head.length));
for (const [i, { cfg }] of runs.entries()) {
  const groups = [[null, null], ...Object.keys(bySet).map((s) => [s, s])];
  for (const [setName, filter] of groups) {
    const idx = POSITIONS.map((p, k) => (filter && p.set !== filter ? -1 : k)).filter((k) => k >= 0);
    const rows = idx.map((k) => lossesByConfig[i][k]);
    const st = stats(rows);
    if (!st) continue;
    let win = 0; let tie = 0; let lose = 0;
    for (const k of idx) {
      const a = lossesByConfig[i][k]; const b = baseLoss[k];
      if (a === null || b === null) continue;
      if (a < b) win += 1; else if (a > b) lose += 1; else tie += 1;
    }
    const baseTotal = stats(idx.map((k) => baseLoss[k]))?.total ?? 0;
    const mark = i === BASE ? '　← 基线' : '';
    console.log(`${(setName ? '' : cfg.label).padEnd(22)}${(setName || '全部').padEnd(12)}`
      + pad(st.n, 5) + pad(st.total, 8) + st.mean.toFixed(1).padStart(7)
      + pad(st.median, 7) + pad(st.blunders, 5)
      + pad(i === BASE ? '—' : `${win}/${tie}/${lose}`, 18)
      + pad(i === BASE ? '—' : (st.total - baseTotal >= 0 ? `+${st.total - baseTotal}` : st.total - baseTotal), 7)
      + mark);
  }
}
console.log('\n（**先看配对那列**：接近对半就是噪声，别信总损失的小差距；'
  + '再看中位数与漏着。它量不了「评估变快/变慢」，那要补 `strength.mjs`。）');
