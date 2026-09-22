#!/usr/bin/env node
/**
 * 残局「解法 / 参考线」的中控流程 —— **加一局、改一局，跑这一条就够**。
 *
 * 用法（从仓库根跑）：
 *
 *   node chinese-chess/tools/solve.mjs --ids shiqingyaqu-551-004      # 新加的 / 改过 FEN 的局
 *   node chinese-chess/tools/solve.mjs                                # 补跑「还没解法、账本里也没记录」的局
 *   node chinese-chess/tools/solve.mjs --status                       # 只看现状，不开引擎
 *   node chinese-chess/tools/solve.mjs --ids a,b --dry-run            # 只打印要跑的命令
 *
 * 开关：
 *   --ids a,b       只处理这几局（会顺带 `--force` 重跑，见下）
 *   --movetime MS   每个节点给引擎多少毫秒（默认 1500）
 *   --rules N       走到底时最多多少**回合**（默认 30）
 *   --no-slow       跳过 `gen-solutions slow`（长预算那轮）
 *   --status        只打现状表（库里每局的账本 / 解法 / 候选线 / 前缀），不跑引擎
 *   --dry-run       只打印每一步的命令，不执行
 *
 * ## 它到底是什么
 *
 * **它不自己算棋**：只是把四个既有工具**按顺序当子进程调一遍**，失败即停，
 * 并在最后给出「这次多了几条解法 / 几条参考线」。所以每一步都可以单独重跑
 * （`--dry-run` 会把每条命令打出来，直接复制）。
 *
 *   1. verify-endgames   局面合法性（非法 FEN / 字段错在这里先挡住）
 *   2. gen-solutions fast  引擎在根上找杀（新局自动捡起）
 *   3. gen-solutions slow  没解出的再来一轮长预算
 *   4. prefix-scan gen --playout   让引擎沿自己的着法走到底（走成完整线就成候选）
 *   5. prefix-scan promote 用本模块规则层复核候选线（不需要引擎）
 *   6. gen-solutions emit  写 js/solutions.js（候选线当兜底）
 *   7. prefix-scan emit    写 js/prefixes.js（跳过「已有解法」的局，所以要排在 6 之后）
 *   8. verify-solutions    逐步合法 + 末局将死 + 长度自洽
 *   9. test-solution-book  查表与**措辞**（有解法 / 参考线必须分开）
 *  10. gen-solutions issues 重生成「没解出来的局面」清单
 *
 * ## 三个必须知道的约定
 *
 * **第 6、7 步的顺序不能换。** `prefix-scan emit` 要读 `js/solutions.js` 才知道「哪些局
 * 已经有更可信的解法、不该再写一份前缀」——排在写解法之前的话，读到的还是上一轮那份，
 * 于是本轮刚解出的局会在 `prefixes.js` 里留一条永远用不上的副本（界面只认 solutions.js
 * 那条），`test-solution-book.mjs` 里「只有前缀的局」那条断言也会跟着红。
 *
 * **`--ids` 会带 `--force`。** 账本是按 id 存的：改了 FEN 之后，旧记录还在，
 * 不带 force 的话第 4 步会直接跳过它（跑的其实是旧局面）。带上 force 才会重跑并覆盖。
 * 反过来，**不带 `--ids`** 时故意**不**带 force —— 那样只补「还没有记录」的局，
 * 不会把已有的结果重算一遍。
 *
 * **失败就停，不往下滚。** 尤其是第 1 步（局面非法）和第 8 步（数据不自洽）——
 * 带着错继续跑只会把脏数据写进 `js/`，而那两个文件是要发布的。
 *
 * 另外：`promote` 会**保留上一次的候选**（只要它还和当前 FEN 对得上），
 * 所以某局一次失败的重跑**不会**把它从 `solutions.js` 里踢出去（见 prefix-scan.mjs）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const load = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);
/**
 * 重新读一遍数据文件（**带缓存破坏参数**）。
 *
 * `import` 同一个 URL 回来的永远是**第一次那个模块对象** —— 而 `emit` 步骤是**重写文件**，
 * 不破缓存的话，汇总里读到的还是跑之前那份数据（数字一动不动，看着像"什么都没发生"）。
 */
const loadFresh = (rel) => import(`${pathToFileURL(resolve(ROOT, rel)).href}?t=${Date.now()}`);
const readJson = (rel) => {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
};

// === 命令行 ===
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const IDS = (opt('ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MOVETIME = Number(opt('movetime', 1500));
const RULES = Number(opt('rules', 30));
const NO_SLOW = argv.includes('--no-slow');
const STATUS_ONLY = argv.includes('--status');
const DRY = argv.includes('--dry-run');

const { ENDGAMES } = await load('chinese-chess/js/endgames.js');
const { SOLUTIONS } = await load('chinese-chess/js/solutions.js');
const { PREFIXES } = await load('chinese-chess/js/prefixes.js');

const byId = new Map(ENDGAMES.map((e) => [e.id, e]));

// 先挡住「id 写错」—— 不然它会一路跑到第 2 步才报，白等一次引擎启动
if (IDS.length) {
  const unknown = IDS.filter((id) => !byId.has(id));
  if (unknown.length) {
    console.error(`endgames.js 里没有这些 id：${unknown.join(', ')}`);
    process.exit(2);
  }
}

// === 现状 ===
//
// 四份数据各自的来源不同，所以「一局现在什么状态」要把它们对起来看：
//   tmp/solutions-work.json    引擎在根上搜索的结果（mate>0 = 已证明，是个候选解法）
//   tmp/prefix-work.json       走到底的记录（stop=mate-pv/terminal 才有 mate）
//   js/solutions.js            线上真正在用的解法（含 src）
//   js/prefixes.js             线上真正在用的参考线
const work = readJson('tmp/solutions-work.json');
const walkWork = readJson('tmp/prefix-work.json');
const candidates = readJson('tmp/prefix-candidates.json');

function rowOf(id) {
  const eg = byId.get(id);
  const r = work[id];
  const w = walkWork[id];
  const sol = SOLUTIONS[id];
  const pre = PREFIXES[id];
  // 引擎搜索那一列：mate > 0 是它证明的杀；mate <= 0 是**它认为红方被杀**（反杀那几局）；
  // mate 为 null 才是纯评估分。这三种必须分得开 —— 看表的人全靠这一列判断该不该人工核查。
  const engineCell = !r ? '—'
    : r.mate === null || r.mate === undefined ? `cp ${r.cp ?? '-'}`
      : `mate ${r.mate}${r.mate <= 0 ? '(被杀)' : ''}`;
  return [
    id.padEnd(24),
    eg ? (eg.result || 'win').padEnd(5) : '??',
    engineCell.padEnd(14),
    w ? w.stop.padEnd(9) : '—'.padEnd(9),
    (sol ? `${sol.mate}步/${sol.src || 'mate'}` : '—').padEnd(16),
    (candidates[id] ? `候选 ${candidates[id].mate}步` : '—').padEnd(9),
    pre ? (pre.mate ? `线 ${pre.mate}步` : `前缀 ${pre.pv.trim().split(/\s+/).length}半`) : '—',
  ].join(' ');
}

function printStatus() {
  const solved = Object.values(SOLUTIONS).filter((s) => (s.src || 'mate') === 'mate').length;
  const walk = Object.values(SOLUTIONS).filter((s) => s.src === 'walk').length;
  const noLine = ENDGAMES.filter((eg) => !SOLUTIONS[eg.id] && !PREFIXES[eg.id]).length;
  console.log('id                       结论  引擎搜索   走到底    solutions.js     候选线     prefixes.js');
  const list = IDS.length ? IDS : ENDGAMES.filter((eg) => IDS.length || !SOLUTIONS[eg.id]).map((e) => e.id);
  for (const id of list) console.log(rowOf(id));
  console.log(`\n汇总：解法 ${solved + walk} 条（已证明 ${solved} + 参考线 ${walk}）`
    + ` · 参考线/前缀 ${Object.keys(PREFIXES).length} 局 · 什么线都没有 ${noLine} 局`
    + ` · 共 ${ENDGAMES.length} 局`);
  if (!IDS.length) {
    console.log('（只列了还没有解法的局；想看某一局加 --ids）');
  }
}

if (STATUS_ONLY) {
  printStatus();
  process.exit(0);
}

// === 步骤表 ===
//
// 第 4 步的 `--force` 只在 `--ids` 时加，理由见文件头。
const idsArgs = IDS.length ? ['--ids', IDS.join(',')] : [];
const STEPS = [
  {
    name: '校验局面',
    cmd: ['verify-endgames.mjs'],
    why: '非法 FEN / 字段错在这里先挡住（它抓出过把「将」「士」写反的局面）',
  },
  {
    name: '引擎找杀（快轮）',
    cmd: ['gen-solutions.mjs', 'fast', ...idsArgs],
    why: '在根上搜 `go mate`；新局会被自动捡起',
  },
  {
    name: '引擎找杀（慢轮）',
    cmd: ['gen-solutions.mjs', 'slow', ...idsArgs],
    why: '快轮没解出的再来一轮长预算',
    skip: NO_SLOW,
  },
  {
    name: '走到底（playout）',
    cmd: ['prefix-scan.mjs', 'gen', '--playout', '--movetime', String(MOVETIME), '--rules', String(RULES),
      ...idsArgs, ...(IDS.length ? ['--force'] : [])],
    why: '让引擎沿自己的着法走到底：走成完整线就是候选解法，否则留下引擎首选前缀',
  },
  {
    name: '规则层复核候选线',
    cmd: ['prefix-scan.mjs', 'promote'],
    why: '每步合法 + 末局将死才写进 candidates（不需要引擎）',
  },
  {
    name: '写解法',
    cmd: ['gen-solutions.mjs', 'emit'],
    why: '→ js/solutions.js（候选线当兜底，带 src=walk）',
  },
  {
    name: '写参考线',
    // **顺序要紧**：这一步读 js/solutions.js，跳过「已经有已证明解法」的局
    // （那条线更可信，界面 `lineOf` 也优先用它）。写在「写解法」之前，
    // 读到的就是上一轮那份 —— 本轮刚解出的局会在这里留一条永远用不上的副本。
    cmd: ['prefix-scan.mjs', 'emit'],
    why: '→ js/prefixes.js（与当前 FEN 对不上的记录、已有解法的局都会被跳过并说明）',
  },
  {
    name: '校验解法',
    cmd: ['verify-solutions.mjs'],
    why: '逐步合法 + 末局将死 + 长度自洽',
  },
  {
    name: '查表与措辞测试',
    cmd: ['test-solution-book.mjs'],
    why: '「有解法」与「参考线」的措辞必须分开，这条断言钉的就是它',
  },
  {
    name: '更新「没解出来」清单',
    cmd: ['gen-solutions.mjs', 'issues'],
    why: '→ docs/pikafish-unfinished.md',
  },
];

// === 跑 ===
const before = { sol: Object.keys(SOLUTIONS).length, pre: Object.keys(PREFIXES).length };
const total = STEPS.length;

console.log(`残局解法流水线：${IDS.length ? IDS.join(', ') : '（全部还没解法的局）'}`
  + ` · ${MOVETIME}ms/手 · 上限 ${RULES} 回合${DRY ? ' · DRY RUN' : ''}\n`);

for (let i = 0; i < total; i++) {
  const step = STEPS[i];
  const head = `[${String(i + 1).padStart(2)}/${total}] ${step.name}`;
  if (step.skip) { console.log(`${head} —— 跳过（--no-slow）`); continue; }
  const line = `node chinese-chess/tools/${step.cmd.join(' ')}`;
  console.log(`\n${head}\n  ${line}`);
  if (DRY) continue;

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [resolve(HERE, step.cmd[0]), ...step.cmd.slice(1)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\n✗ 第 ${i + 1} 步「${step.name}」失败（退出码 ${r.status}，${secs}s）—— 后面的步骤没跑。`);
    console.error(`  这一步在干什么：${step.why}`);
    console.error(`  单独重跑：${line}`);
    process.exit(1);
  }
  console.log(`  ✓ ${secs}s`);
}

if (DRY) {
  console.log('\n（--dry-run：什么都没执行）');
  process.exit(0);
}

// === 汇总 ===
//
// 数据文件刚被重写过，要**重新导入**才能看到新数字（模块缓存是旧的）。
const after = await loadFresh('chinese-chess/js/solutions.js');
const afterPre = await loadFresh('chinese-chess/js/prefixes.js');
const mate = Object.values(after.SOLUTIONS).filter((s) => (s.src || 'mate') === 'mate').length;
const walk = Object.values(after.SOLUTIONS).filter((s) => s.src === 'walk').length;
const noLine = ENDGAMES.filter((eg) => !after.SOLUTIONS[eg.id] && !afterPre.PREFIXES[eg.id]).length;

console.log('\n=== 汇总 ===');
console.log(`  解法：${before.sol} → **${Object.keys(after.SOLUTIONS).length}** 条`
  + `（已证明 ${mate} + 参考线 ${walk}）`);
console.log(`  参考线 / 前缀：${before.pre} → **${Object.keys(afterPre.PREFIXES).length}** 局`);
console.log(`  仍然什么线都没有：${noLine} 局（共 ${ENDGAMES.length} 局）`);
if (IDS.length) {
  console.log(`\n  本批（${IDS.join(', ')}）：`);
  for (const id of IDS) console.log(`    ${rowOf(id)}`);
}
console.log('\n剩下没解出来的局与原因见 chinese-chess/docs/pikafish-unfinished.md');
