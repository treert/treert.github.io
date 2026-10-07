#!/usr/bin/env node
/**
 * **着法对照** —— 「这个改动到底换了几步棋？」的仪器（离线工具，不参与网页运行）。
 *
 * ## 为什么需要它（它补尺子，不是替尺子）
 *
 * `tools/strength.mjs` 比的是「平均损失 cp」，而它自己的抖动就有几个 cp ——
 * 小幅改动（评估权重、位置表数据、排序细节）根本分辨不出来。2026-10-06 有两个现成的例子：
 *
 *   - **兵的行分**那个改动，尺子只差 1~3cp（看着像「没影响」），
 *     固定深度对照直接指出**它一步棋都没换**（0 / 65）；
 *   - **机动性权重写反**那次，尺子同样只能说「差不多」，
 *     对照 + 定向判分才给出硬结论（7 步不同、写反的 347cp vs 写对的 237cp）。
 *
 * 它靠三件事把噪声消掉：
 *
 *   1. **固定深度 + noise 0 + 无连将杀探测** ⇒ 同一个配置**每次跑出完全一样的着法**
 *      （尺子量的是「1.5 秒里搜到哪」，那会随时间抖动）；
 *   2. 比的是**离散量**「选了哪一步」，不是 cp 均值；
 *   3. `--judge` **只在两者不同的那几个局面**上让裁判判分 —— 信噪比最高的地方。
 *
 * ## 用法（两步：先倒基线，改完代码再比）
 *
 *   node chinese-chess/tools/move-diff.mjs dump --out tmp/a.json
 *   ... 改代码（权重、数据、排序…）...
 *   node chinese-chess/tools/move-diff.mjs compare tmp/a.json           # 只列不同的局面
 *   node chinese-chess/tools/move-diff.mjs compare tmp/a.json --judge   # 再让 Pikafish 判那些
 *
 * `--set` / `--n` / `--tactical` 与 `strength.mjs` 完全一样 —— **取局面用的是同一个函数**
 * （`strength-positions.mjs` 的 `strengthPositions()`），两把仪器跑的一定是同一批局面。
 * `--depth` 默认 6。`--judge` 需要本地有 Pikafish（路径与其它工具一致，见 `docs/pikafish.md`）。
 *
 * ## 怎么读
 *
 * - **「换了 0 步」是筛掉了，不是判决** ⚠️：它说明这个改动碰不到**浅层**的着法选择。
 *   静态形状类的评估项（位置表数据）经常如此，见 `docs/decisions.md` 第 21 条。
 *   但它**会低估真实预算下的效果**：实测反例（第 22 条那次机动性权重修复）——
 *   固定深度 6 的快照里**中局一步没变**，真实预算下中局平均损失 **37.0 → 14.9、漏着 2 → 0**。
 *   **所以准备采纳的改动，`strength.mjs` 的真实预算对照必须跑，哪怕这里显示 0 步。**
 * - **只看 `--judge` 的合计**：那是在「行为真的不同」的地方量的，比全量均值灵敏得多。
 *   但它是单个局面各判一次，抖动仍在（Pikafish 4 线程下就有）—— 结论要能复跑出来才算数。
 * - **它回答的是「着法选择变没变」，不是「真实预算下更强没有」。**
 *   两个都答完才能下结论：先用它筛（0 步就不必上尺子），再用尺子量全量。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');
const load = (rel) => import(pathToFileURL(resolve(HERE, '../js', rel)).href);

const { CELLS, EMPTY } = await load('config.js');
const { search } = await load('engine.js');
const { toNotation } = await load('notation.js');
const { parseFen, toFen } = await load('position.js');
const { iccsOfMove, moveOfIccs } = await load('iccs.js');
const { resolveSets, strengthPositions } =
  await import(pathToFileURL(resolve(HERE, 'strength-positions.mjs')).href);

const argv = process.argv.slice(2);
const stage = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'dump').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const DEPTH = Number(opt('depth', 6));
const N = Number(opt('n', 30));
const TACTICAL = flag('tactical');
let SETS;
try {
  SETS = resolveSets(opt('set', 'opening,regression'));
} catch (e) {
  console.log(e.message);
  process.exit(1);
}
const OUT = opt('out', resolve(ROOT, 'tmp/moves.json'));

/** 与「高级」挡位同参数，但去掉一切随机性与时间因素 —— 于是它**完全确定** */
const lv = {
  id: 'fixed', name: '固定深度',
  depth: DEPTH, timeLimitMs: 600000,
  quiescence: true, noise: 0, blunderRate: 0, checkExtension: 6, mateProbePly: 0, book: 0,
};

function run() {
  const rows = [];
  for (const p of strengthPositions({ sets: SETS, tactical: TACTICAL, n: N })) {
    const r = search(p.fen, lv, { history: [p.fen] });
    rows.push({
      set: p.set, id: p.id, fen: p.fen,
      iccs: r ? iccsOfMove(r.move) : null,
      notation: r ? toNotation(parseFen(p.fen), r.move) : null,
      score: r ? r.score : null,
    });
  }
  return rows;
}
const config = { depth: DEPTH, sets: SETS, n: N, tactical: TACTICAL };

if (stage === 'dump') {
  const rows = run();
  writeFileSync(OUT, `${JSON.stringify({ config, rows }, null, 1)}\n`);
  console.log(`固定深度 ${DEPTH}｜${SETS.join(' + ')} = ${rows.length} 个局面 → ${OUT}`);
  process.exit(0);
}

if (stage !== 'compare') {
  console.log(`不认识的阶段「${stage}」—— 可选：dump / compare`);
  process.exit(1);
}

// === compare：现跑一遍，与基线比 ===
const BASE = argv.slice(1).find((a) => !a.startsWith('--'));
if (!BASE) { console.log('用法：move-diff.mjs compare <基线.json> [--judge]'); process.exit(1); }
const base = JSON.parse(readFileSync(resolve(ROOT, BASE), 'utf8'));
for (const k of Object.keys(config)) {
  if (JSON.stringify(base.config[k]) !== JSON.stringify(config[k])) {
    console.log(`基线与现在的配置不一致（${k}：基线 ${JSON.stringify(base.config[k])}，`
      + `现在 ${JSON.stringify(config[k])}）—— 换了配置就没法比了，请重新 dump。`);
    process.exit(1);
  }
}
const rows = run();
const diff = [];
for (let i = 0; i < rows.length; i++) {
  if (rows[i].fen !== base.rows[i].fen) {
    console.log(`局面集不一致（第 ${i + 1} 个就不一样）—— 局面数据改过了，请重新 dump。`);
    process.exit(1);
  }
  if (rows[i].iccs !== base.rows[i].iccs) diff.push([rows[i], base.rows[i]]);
}

console.log(`固定深度 ${DEPTH}（完全确定）｜基线 ${BASE}`);
console.log(`**换了 ${diff.length} / ${rows.length} 步**\n`);
for (const [now, old] of diff) {
  console.log(`  ${now.set} ${now.id}`);
  console.log(`      现在：${(now.notation || '—').padEnd(6)} [${now.iccs || '—'}] 自评 ${now.score}`);
  console.log(`      基线：${(old.notation || '—').padEnd(6)} [${old.iccs || '—'}] 自评 ${old.score}`);
  console.log(`      ${now.fen}`);
}
if (!diff.length) {
  console.log('（一步都没换：这个改动碰不到**浅层**的着法选择 —— 但这不等于它没用：'
    + '固定深度会低估真实预算下的效果，实测反例见 decisions.md 第 21 条末尾那次更正。'
    + '准备采纳的话，strength.mjs 的真实预算对照还是要跑。）');
  process.exit(0);
}
if (!flag('judge')) process.exit(0);
await judgeDiff(diff);

/** 只在两者不同的局面上让裁判判：两种配置各自那一步，走完之后还剩多少分 */
async function judgeDiff(changed) {
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
  const PF = Number(opt('pf', 16));
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

  console.log(`\n裁判（Pikafish depth ${PF}）只判这 ${changed.length} 个局面：`);
  let sumNow = 0; let sumOld = 0;
  for (const [now, old] of changed) {
    const before = await judge(now.fen);
    const loss = async (iccs) => {
      const pos = parseFen(now.fen);
      const m = moveOfIccs(iccs);
      const from = Math.floor(m / CELLS), to = m % CELLS;
      pos.cells[to] = pos.cells[from];
      pos.cells[from] = EMPTY;
      pos.side = -pos.side;
      return Math.max(0, before + await judge(toFen(pos)));
    };
    const ln = await loss(now.iccs);
    const lo = await loss(old.iccs);
    sumNow += ln; sumOld += lo;
    console.log(`  ${now.set} ${now.id}`);
    console.log(`      现在 ${now.notation} 亏 ${ln}cp   基线 ${old.notation} 亏 ${lo}cp`
      + `   → ${ln === lo ? '打平' : (ln < lo ? '现在好' : '基线好')}`);
  }
  console.log(`\n合计：现在 ${sumNow}cp｜基线 ${sumOld}cp → `
    + `${sumNow === sumOld ? '打平' : (sumNow < sumOld ? '现在好' : '基线好')}`);
  console.log('（单个局面各判一次，抖动仍在 —— 结论要能复跑出来才算数）');
  send('quit');
  setTimeout(() => process.exit(0), 200);
}
