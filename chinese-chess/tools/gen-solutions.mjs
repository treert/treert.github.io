#!/usr/bin/env node
/**
 * 残局解法生成器 —— **离线开发工具，不参与网页运行**。
 *
 * 用 Pikafish（UCI 中国象棋引擎）对残局库里的局面跑 `go mate`，把解出的主变（PV）
 * 固化成 `js/solutions.js`。运行时不需要引擎，也不联网 —— 与 FEN 数据一次性整理进
 * `endgames.js` 是同一套做法。
 *
 * 用法（从仓库根跑）：
 *
 *   node chinese-chess/tools/gen-solutions.mjs fast --from 0 --count 140
 *   node chinese-chess/tools/gen-solutions.mjs slow --from 0 --count 140
 *   node chinese-chess/tools/gen-solutions.mjs emit      # 写成 js/solutions.js
 *   node chinese-chess/tools/gen-solutions.mjs issues    # 疑点清单 → tmp/solutions-issues.md
 *
 * 两个附加开关：
 *   --normal   用普通搜索（`go movetime`）代替 `go mate`。**mate 模式下引擎给的 PV 会被截断**
 *              （实测 7 局走完 PV 后对方还有着法），这些局用 `slow --normal --ids <id,...>` 补跑。
 *   --ids a,b  只跑这几局（配合 --normal 做定点补跑）
 *
 * 四个阶段：
 *   fast    对**还没有记录**的局跑短预算（默认 mate 40 / 3 秒）
 *   slow    对 fast 没解出、且谱载为「先手胜」的局跑长预算（默认 mate 40 / 30 秒）
 *   emit    把解出的局写成 js/solutions.js
 *   issues  输出疑点：反杀 / 未解出 / 「和局」却找到杀 / 「胜局」却评估偏低
 *
 * **慢预算也封顶 mate 40**：排局是设计出来的题，红方 40 步内该有结果；
 * 封了顶，没有杀的局就不会白耗 30 秒。和局局（谱载 `draw`）不期待解法，
 * 所以 slow 阶段直接跳过它们。
 *
 * 中间结果累积在 `tmp/solutions-work.json`（tmp 已被 git 忽略），每局按 id 记一条 ——
 * 于是**可中断、可分批、可重跑**：已经解出的局重跑时不会再算。
 *
 * 引擎与权重**不进仓库**。下载（通用二进制 + `pikafish.nnue`）：
 *   https://github.com/official-pikafish/Pikafish/releases
 * 解压到 `tmp/pikafish/`，或用环境变量 `PIKAFISH` 指向别处的可执行文件。
 * 引擎是 GPL-3，我们只离线运行它、只取输出；权重来自 Pika Xiangqi Zero（ODbL）。
 *
 * 为什么不用现成的棋谱数据：网上流传的《适情雅趣》PGN 授权不明、链接易失效，
 * 而且那份解法本身就是老引擎（EleEye / sjaakii）跑出来的。详见 future-work.md C8。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDGAMES } from '../js/endgames.js';
import { parseFen } from '../js/position.js';
import { encodeMove, generateLegalMoves } from '../js/rules.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WORK_FILE = resolve(ROOT, 'tmp/solutions-work.json');
/**
 * `prefix-scan.mjs promote` 的产物：**候选完整杀线**（引擎沿着自己选的路走到将死）。
 * emit 把它当**兜底**读 —— 某局如果已经有"引擎证明了强制杀"的记录，就不用它。
 * 分开一个文件是因为这份账本每局一条、fast/slow 会无条件覆盖，塞进来会被冲掉。
 */
const CAND_FILE = resolve(ROOT, 'tmp/prefix-candidates.json');
const ISSUES_FILE = resolve(ROOT, 'tmp/solutions-issues.md');
const OUT_FILE = resolve(HERE, '../js/solutions.js');
/** 「没解出来的局面」清单 —— 这一份**进仓库**（tmp 里那份是全量疑点，随跑批更新） */
const UNFINISHED_FILE = resolve(HERE, '../docs/pikafish-unfinished.md');
/** 引擎版本。写进生成物头部 —— 换引擎重跑时只改这一处 */
const ENGINE = 'Pikafish 2026-09-06';
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');

const argv = process.argv.slice(2);
const stage = (argv[0] || '').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const FROM = Number(opt('from', 0));
const COUNT = Number(opt('count', Number.MAX_SAFE_INTEGER));
const MOVETIME = Number(opt('movetime', stage === 'slow' ? 30000 : 3000));
/** mate 上限，单位是**红方步数**（`go mate N` 的 N）—— 快慢两轮都封顶 */
const MATE = Number(opt('mate', 40));

/**
 * `--normal`：用普通搜索（`go movetime`，不带 mate 参数）代替 `go mate`。
 *
 * 为什么需要它：**`go mate` 模式下引擎给的 PV 会被截断** —— 实测 7 局
 * 「走完 PV 之后对方还有合法着法」，也就是说那条线并没有杀完（普通搜索的 PV 是完整的）。
 * 这些局用 `slow --normal` 补跑一轮。
 */
const NORMAL = argv.includes('--normal');
/** `--ids a,b,c`：只跑这几局（补跑指定局面用） */
const IDS = (opt('ids', '') || '').split(',').filter(Boolean);

// === 中间结果 ===

function loadWork() {
  if (!existsSync(WORK_FILE)) return {};
  try {
    return JSON.parse(readFileSync(WORK_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`中间结果读不动（${WORK_FILE}）：${e.message}`);
  }
}

function saveWork(work) {
  mkdirSync(dirname(WORK_FILE), { recursive: true });
  writeFileSync(WORK_FILE, JSON.stringify(work, null, 1));
}

/** 读候选线（`prefix-scan.mjs promote` 写的）。没有就是一局都不加 —— 缺文件不算错。 */
function loadCandidates() {
  if (!existsSync(CAND_FILE)) return {};
  try { return JSON.parse(readFileSync(CAND_FILE, 'utf8')); } catch (e) {
    throw new Error(`候选线读不动（${CAND_FILE}）：${e.message}`);
  }
}

// === 引擎会话 ===

/** 起引擎，返回 { run(fen, mate, movetime), close() } */
function startEngine() {
  if (!existsSync(EXE)) {
    throw new Error(`找不到引擎：${EXE}\n先从 official-pikafish/Pikafish 的 releases 下通用二进制 + pikafish.nnue，解压到 tmp/pikafish/，或设 PIKAFISH 环境变量。`);
  }
  const proc = spawn(EXE, [], { cwd: dirname(EXE) });
  const rl = createInterface({ input: proc.stdout });

  let pending = null;
  rl.on('line', (line) => {
    if (!pending) return;
    if (line.startsWith('info ') && line.includes(' pv ')) pending.last = line;
    else if (line.startsWith('bestmove')) {
      pending.bestmove = line;
      const p = pending;
      pending = null;
      p.resolve();
    } else if (/CRITICAL ERROR|Unknown command/.test(line)) {
      pending.noise.push(line);
    }
  });
  proc.on('close', (code) => {
    if (pending) { pending.resolve(); pending = null; }
    if (code !== 0 && code !== null) console.error(`!! 引擎退出，code=${code}`);
  });

  const send = (cmd) => proc.stdin.write(`${cmd}\n`);
  send('uci');
  send('setoption name Threads value 16');
  send('setoption name Hash value 2048');
  send('isready');

  return {
    /** goLine 是完整的 go 命令 —— 普通搜索与 mate 搜索的差别只在这一行 */
    async run(fen, goLine) {
      send('ucinewgame');
      send(`position fen ${fen}`);
      const state = { last: null, bestmove: null, noise: [], resolve: null, promise: null };
      state.promise = new Promise((res) => { state.resolve = res; });
      pending = state;
      const t0 = Date.now();
      send(goLine);
      await state.promise;
      const ms = Date.now() - t0;

      const last = state.last || '';
      const mMate = /score mate (-?\d+)/.exec(last);
      const mCp = /score cp (-?\d+)/.exec(last);
      return {
        ms,
        mate: mMate ? Number(mMate[1]) : null,
        cp: mCp ? Number(mCp[1]) : null,
        best: (state.bestmove || '').replace('bestmove ', '').split(' ')[0],
        pv: (/(?: pv )(.+)$/.exec(last) || [, ''])[1],
        noise: state.noise,
      };
    },
    close() { send('quit'); },
  };
}

// === fast / slow ===

async function search() {
  const work = loadWork();
  const list = ENDGAMES.slice(FROM, FROM + COUNT);

  const todo = list.filter((eg) => {
    // --ids 是**定点补跑**：指定了就只认这几个 id，不再看「解出没解出」——
    // 需要补跑的恰恰是「已经解出、但 PV 被截断」的那些。
    if (IDS.length) return IDS.includes(eg.id);
    const r = work[eg.id];
    if (stage === 'fast') return !r;                    // 没记录过的
    // slow：只有「谱载先手胜、fast 没解出」的才值得再花时间。
    // startsWith('slow') 把 slow 与 slow-normal（补跑）一起算进去 ——
    // 同一个局面不该被同一档预算反复跑。
    return r && eg.result === 'win' && !(r.mate > 0) && !String(r.stage).startsWith('slow');
  });

  const goLine = NORMAL ? `go movetime ${MOVETIME}` : `go mate ${MATE} movetime ${MOVETIME}`;
  console.log(`阶段 ${stage}：本轮 ${todo.length} 局（下标 ${FROM}..${FROM + list.length - 1}）`);
  console.log(`参数：${goLine}`);
  if (todo.length === 0) return;

  const engine = startEngine();
  let done = 0;
  let solved = 0;

  for (const eg of todo) {
    const r = await engine.run(eg.fen, goLine);
    work[eg.id] = {
      name: eg.name,
      result: eg.result,
      stage: NORMAL ? `${stage}-normal` : stage,
      mate: r.mate,
      cp: r.cp,
      best: r.best,
      pv: r.pv,
      ms: r.ms,
    };
    done++;
    if (r.mate > 0) solved++;
    if (done % 20 === 0 || done === todo.length) {
      console.log(`  ${done}/${todo.length}  解出 ${solved}  当前：${eg.name} → ${r.mate !== null ? `mate ${r.mate}` : `cp ${r.cp}`}  ${(r.ms / 1000).toFixed(1)}s`);
      saveWork(work);
    }
  }
  saveWork(work);
  engine.close();
  console.log(`阶段 ${stage} 结束：解出 ${solved}/${todo.length}，中间结果已存 ${WORK_FILE}`);
}

// === emit ===

/**
 * 从 PV 头部开始走，返回**走到将死为止实际用掉的着法数**（奇数）；
 * 走不通、或走完整条还没杀完，就返回 0。
 *
 * 为什么不直接用「长度 = 2*mate-1」对账：引擎在两种模式下给出的 PV 形状不一样 ——
 *   `go mate`      PV 会被**截断**（实测 7 局走到底对方还有着法）
 *   `go movetime`  PV 可能**多延伸**几步（走到一半对方就已经无着法了）
 * 所以认「走到杀完为止」这一段：**多出来的截掉，不够的算不合格**。
 * 局部走子用 `side` 翻转 + 手改 cells —— 与 game.js 的走子无关，只是把 PV 复现一遍。
 */
function pvLengthToMate(eg, pv) {
  try {
    const pos = parseFen(eg.fen);
    const toks = pv.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const moves = generateLegalMoves(pos);
      // 对方一步都走不出 = 杀完了。**必须发生在对方的回合**（奇数个半层之后），
      // 否则说明是轮走方自己被将死，那不是我们要的解。
      if (moves.length === 0) return i > 0 && i % 2 === 1 ? i : 0;

      const tok = toks[i];
      const from = (9 - Number(tok[1])) * 9 + (tok.charCodeAt(0) - 97);
      const to = (9 - Number(tok[3])) * 9 + (tok.charCodeAt(2) - 97);
      const move = encodeMove(from, to);
      if (!moves.includes(move)) return 0;

      pos.cells[to] = pos.cells[from];
      pos.cells[from] = 0;
      pos.side = -pos.side;
    }
    return toks.length % 2 === 1 && generateLegalMoves(pos).length === 0 ? toks.length : 0;
  } catch {
    return 0;
  }
}

function emit() {
  const work = loadWork();
  const candidates = loadCandidates();
  const rows = [];
  const incomplete = [];
  let truncated = 0;
  let fromWork = 0;
  let fromWalk = 0;

  for (const eg of ENDGAMES) {
    const r = work[eg.id];
    // 两条来源，**优先已证明的那条**：
    //   work.id.mate > 0      → `src: 'mate'`：`go mate` 在**根上**证明了强制杀
    //   candidates[id]        → `src: 'walk'`：引擎沿自己选的路走到底能杀，但**前段没有证明**
    // 两者都要过 `pvLengthToMate`（走到杀完为止）—— 规则层说了算，引擎的说法不算。
    const source = (r && r.mate > 0) ? 'mate' : (candidates[eg.id] ? 'walk' : null);
    if (!source) continue;
    const pvText = source === 'mate' ? r.pv : candidates[eg.id].pv;
    const ms = source === 'mate' ? r.ms : candidates[eg.id].ms;

    // **以「走到杀完为止」的那一段为准**（见 pvLengthToMate 的注释）：
    //   多延伸的截掉、被截断的（PV 没杀完）直接不要 ——
    //   界面拿这条线给「提示」，走到一半断掉比没有解法更糟。
    const raw = pvText.trim().split(/\s+/);
    const n = pvLengthToMate(eg, pvText);
    if (!n) { incomplete.push(eg.id); continue; }
    if (raw.length > n) truncated++;
    const pv = raw.slice(0, n).join(' ');
    // mate 由**实际走出来的长度**推，而不是照抄引擎报的值：
    // 这样 `pv` 长度与 `mate` 在任何模式下都自洽（verify-solutions 会再钉一遍）。
    const mate = (n + 1) / 2;
    if (source === 'mate') fromWork++; else fromWalk++;
    rows.push({ id: eg.id, pv, mate, ms, src: source });
  }

  const body = rows.map((r) => `  '${r.id}': { pv: '${r.pv}', mate: ${r.mate}, ms: ${r.ms}, src: '${r.src}' },`).join('\n');
  const text = `/**
 * 残局解法 —— **这个文件是生成的，别手改**。
 *
 * 生成：\`node chinese-chess/tools/gen-solutions.mjs fast/slow\` 跑引擎，
 * 再 \`emit\` 写出来；校验：\`node chinese-chess/tools/verify-solutions.mjs\`。
 * 生成器只取**引擎证明了强制杀**的局（\`go mate\`；PV 被 mate 模式截断的那几局用
 * \`go movetime\` 补跑）。没找到的不编 —— 界面显示「暂无谱载解法」，回退引擎搜索。
 *
 * ## 里面是什么
 *
 * \`pv\` 是本局**从初始局面开始**的一条主线着法序列，用 ICCS 坐标（列 a-i 从左到右、
 * 行 0-9 从红方底线往上），与引擎同格式，方便直接拿 Pikafish / 别的工具复核。
 * \`mate\` 是**红方步数**，由实际走出来的 PV 长度推得 —— 所以 \`pv\` 长度恒等于
 * \`2 * mate - 1\` 个半层（引擎报的 mate 值在 mate 模式下会被截断，不能直接照抄）。
 * \`ms\` 是生成时该局的搜索耗时，只为留痕，不是质量指标。
 *
 * \`src\` 是**这条线的来源**，界面要按它分开措辞，不能一律说「N 步杀」：
 *   \`'mate'\` 引擎在**根上**证明了强制杀（\`go mate\`，对手怎么走都杀）—— 可以放心跟着走
 *   \`'walk'\` 引擎沿自己选的着法走到底**能**杀，但**前段没有证明**（引擎那时只给 cp 分）——
 *              界面得说「引擎参考线」；走岔了照样回退引擎搜索
 * \`walk\` 这一批来自 \`tools/prefix-scan.mjs --playout\` + \`promote\`（用本模块规则层复核过：
 * 每步合法 + 末局将死），生成后 \`verify-solutions.mjs\` 会再钉一遍。
 *
 * 数据来源：Pikafish（见 tools/gen-solutions.mjs 头部）。它是**搜索结果**，
 * 不是古籍原谱 —— 但同一批局面已与谱载解法逐手比对过（第 002 局 20 回合完全一致），
 * 且每条都过了 verify-solutions 的「每步合法 + 末局将死」校验。
 * 谱载结论与实际不符的局（例如第 020 局引擎判定红方反被杀）**不进这个文件**，
 * 单列在 tmp/solutions-issues.md 里等人工核查，见 future-work.md B6。
 *
 * ## 为什么单独一个文件
 *
 * \`endgames.js\` 已经背着 551 条 FEN 了；解法是**可选附加数据**（有的局没有），
 * 分开之后「有没有解法」这件事在文件层面就看得见，tools 脚本也只碰这一个文件。
 */

/** 生成这批数据的引擎版本（换引擎重跑时这里要跟着改） */
export const SOLUTIONS_SOURCE = '${ENGINE}';

/**
 * id → 解法。**只有引擎证明了强制杀的局才在这里**（${rows.length} 条）。
 * 查不到就是没有 —— 调用方要能接受这一点。
 */
export const SOLUTIONS = {
${body}
};

/** 取某一局的解法；没有则返回 null */
export function solutionOf(id) {
  return Object.prototype.hasOwnProperty.call(SOLUTIONS, id) ? SOLUTIONS[id] : null;
}
`;

  writeFileSync(OUT_FILE, text);
  console.log(`已写出 ${rows.length} 条解法 → ${OUT_FILE}`);
  console.log(`  其中 src='mate'（根上证明了强制杀）${fromWork} 条，`
    + `src='walk'（引擎走到底能杀、前段未证明）${fromWalk} 条`);
  if (truncated) console.log(`（其中 ${truncated} 条的 PV 被截到 2*mate-1 个半层）`);
  if (incomplete.length) {
    console.log(`（跳过 ${incomplete.length} 条 **PV 不完整**的 —— 走完那条线对方还有着法：`);
    console.log(`  ${incomplete.join(', ')}`);
    console.log('   用 `slow --normal --ids <这些 id>` 补跑一轮普通搜索再 emit）');
  }
}

// === 没解出来的局面（进仓库的那份清单）===

/**
 * 写 `docs/pikafish-unfinished.md`：把「引擎没给出杀线」的局单独列一张清单。
 *
 * 与 `tmp/solutions-issues.md` 的分工：那份是**全量疑点**（还含「和局却找到杀」「没跑过」等），
 * 随跑批更新、留在 tmp；这一份只回答一个问题 —— **库里还剩哪些题没有答案** ——
 * 所以进仓库，换引擎重跑后重新生成一次即可。
 *
 * 分组不按 id 排，而按「该不该人工核查」排：反杀最可疑、评估≈0 次之、
 * 大优但无杀（多半只是「赢法不是连杀」）放最后；组内也按可疑程度排。
 */
function writeUnfinished(work, candidates) {
  const rows = ENDGAMES.map((eg) => ({ eg, r: work[eg.id] })).filter((x) => x.r);
  const solved = rows.filter((x) => x.r.mate > 0);
  // 「谱载非胜」= 和棋 + 黑胜。它们本来就没有「正解着一说」，找杀天然无效，单列末尾备查。
  // （`result === 'loss'` 是 2026-09 核对卷六时新加的类型：谱载黑胜、红方守不住。）
  const nonWin = rows.filter((x) => x.eg.result !== 'win');
  const draws = nonWin.filter((x) => x.eg.result === 'draw');
  const losses = nonWin.filter((x) => x.eg.result === 'loss');
  const noMate = rows.filter((x) => x.eg.result === 'win' && !(x.r.mate > 0));
  const reversed = noMate.filter((x) => x.r.mate !== null && x.r.mate <= 0)
    .sort((a, b) => a.r.mate - b.r.mate);
  const nearZero = noMate.filter((x) => x.r.mate === null && Math.abs(x.r.cp || 0) < 100)
    .sort((a, b) => Math.abs(a.r.cp || 0) - Math.abs(b.r.cp || 0));
  const bigEdge = noMate.filter((x) => x.r.mate === null && Math.abs(x.r.cp || 0) >= 100)
    .sort((a, b) => b.r.cp - a.r.cp);

  const HEAD = '| id | 局名 | 难度 | 引擎给出 | 耗时 |\n|---|---|---|---|---|';
  // 有**引擎参考线**的局单独标出来：它们在界面上不是"什么都没有"，
  // 而是「提示」会沿着 `prefixes.js` 那条线给着法（**前段未经证明**，措辞与「有解法」不同）。
  const ref = (id) => (candidates[id] ? '　*（有引擎参考线）*' : '');
  const line = ({ eg, r }) => `| \`${eg.id}\` | ${eg.name}${ref(eg.id)} | ${eg.difficulty} | `
    + `${r.mate !== null ? `mate ${r.mate}` : `cp ${r.cp}`} | ${(r.ms / 1000).toFixed(1)}s |`;
  const refIds = Object.keys(candidates);

  const md = `# Pikafish 没解出来的局面

> **生成物，别手改。** 重新生成：\`node chinese-chess/tools/gen-solutions.mjs issues\`
> （引擎 ${ENGINE}；数据来自 \`tmp/solutions-work.json\` 与 \`tmp/prefix-candidates.json\`）

「没解出来」= 引擎没能给出一条**已证明的杀线**，所以这些局在界面上没有「有解法」这个标记，
点「提示」时走的是**引擎参考线**（如果有）或本地引擎现算。**它不等于这些局是错的** ——
大多数只是「赢法不是连击式连杀」。真正需要人工核查的是 A、B 两组。

**「引擎参考线」是什么**：\`tools/prefix-scan.mjs --playout\` 让引擎沿自己选的着法一路走到底，
走成的完整线（再用本模块规则层复核：每步合法 + 末局将死）。它**不是**已证明的强制杀 ——
前段只是「引擎也想这么走」（实测把第 004 局谱上的妙手换成次优着法，引擎只差 0.3~0.8 个兵，
它分不出「杀网还在」和「只是还大优」）。界面按 \`src\` 分开措辞：\`mate\` → 「有解法」，
\`walk\` → 「参考线」。

| | 局数 | 说明 |
|---|---|---|
| 全库 | ${rows.length} | |
| 已解出（在 \`js/solutions.js\` 里，\`src='mate'\`） | ${solved.length} | 「提示」直接给正解、AI 按谱应着 |
| 另外有引擎参考线（\`src='walk'\`） | ${refIds.length} | 走到底能杀，但**前段未经证明** —— 界面标「参考线」 |
| **没解出来** | ${noMate.length + nonWin.length - refIds.length} | 下面逐个列出（标了「有引擎参考线」的除外） |
| └ 其中谱载「和」 | ${draws.length} | **不是问题**：和局本来就没有「正解着一说」，列在文件末尾备查 |
| └ 其中谱载「黑胜」 | ${losses.length} | 同上 —— 红方守不住的局，也没有「正解着一说」 |
| └ 其中谱载「胜」 | ${noMate.length - refIds.length} | 即 A + B + C 三组里还剩这些 |

## A. 反杀（谱载「胜」，引擎却判定红方被杀）—— ${reversed.length} 局

最可疑的一类：要么题面 FEN 与谱上不一致，要么谱载结论有误。
建议拿棋谱站的题面与解法逐手对一遍（第 020 局我在排查 B6 时已经对过一次）。

${HEAD}
${reversed.map(line).join('\n')}

## B. 评估 ≈ 0（更像和局，或者结论本身有问题）—— ${nearZero.length} 局

引擎搜满预算后给的是「均势」。如果它们其实该是「和」，那库里的胜局数就有水分 ——
这一组比 A 组更值得优先看，因为它影响的是**库的整体可信度**。

${HEAD}
${nearZero.map(line).join('\n')}

## C. 大优但没有强制杀 —— ${bigEdge.length} 局

引擎认为红方能赢（cp 越高越确信），但**赢法不是连击式连杀**，所以给不出杀线。
加大预算基本救不回来（4 局给 60 秒 / mate 60，只多解出 1 局）。
**但有一条另辟的路**：\`tools/prefix-scan.mjs --playout\` 让引擎沿自己选的着法走到底 ——
有一批局面在走过几步之后引擎就能给出 mate 证明，于是整条线走成了完整的杀线（见上表
「只有引擎参考线」那一行）。走不成的会停在这里：\`repeat\`（来回拉抽屉，**往往就意味着真的没有强制杀**）、
\`notWinning\`（红方优势掉到 +1.5 兵以下，多半是 B 组那类"其实和棋"）。详见 \`future-work.md\` C8。

${HEAD}
${bigEdge.map(line).join('\n')}

## 谱载非胜的 ${nonWin.length} 局（不解，仅备查）

和棋与黑胜本来就没有「正解着一说」，找杀对它们天然无效 —— 与谱载判定一致。
其中 ${losses.length} 局是**黑胜**（红方守不住，本模块标 \`result: 'loss'\`）。

${nonWin.map((x) => `- \`${x.eg.id}\`　${x.eg.name}${x.eg.result === 'loss' ? '　**黑胜**' : ''}`).join('\n')}
`;

  writeFileSync(UNFINISHED_FILE, md);
  console.log(`没解出的清单 → ${UNFINISHED_FILE}`);
}

// === issues ===

function issues() {
  const work = loadWork();
  const groups = { reversed: [], unsolved: [], drawWithMate: [], winLowCp: [], notRun: [] };

  for (const eg of ENDGAMES) {
    const r = work[eg.id];
    if (!r) { groups.notRun.push(eg); continue; }

    // 谱载「胜」却被判被杀 = 反杀，最可疑；谱载「和 / 黑胜」被杀是**一致**，不是疑点
    if (r.mate !== null && r.mate <= 0) {
      if (eg.result === 'win') groups.reversed.push({ eg, r });
    } else if (!(r.mate > 0)) {
      if (eg.result !== 'win') {
        if (r.cp !== null && Math.abs(r.cp) > 200) {
          groups.winLowCp.push({ eg, r, why: `${eg.result === 'draw' ? '和局' : '黑胜'}但评估偏离 0` });
        }
      } else groups.unsolved.push({ eg, r });
    } else if (eg.result === 'draw') {
      groups.drawWithMate.push({ eg, r });
    } else if (r.cp !== null && r.cp < 100) {
      // 解出了杀，但同一轮的 cp 是别的着法的分 —— 这里只在意「胜局却评估低」，作为参考信号
      groups.winLowCp.push({ eg, r, why: '谱载胜、评估偏低' });
    }
  }

  const line = ({ eg, r, why }) => `| ${eg.id} | ${eg.name} | 谱载${eg.result === 'win' ? '胜' : '和'} | ${r.mate !== null ? `mate ${r.mate}` : `cp ${r.cp}`} | ${why || ''} |`;
  const head = '| id | 局名 | 谱载 | 引擎 | 备注 |\n|---|---|---|---|---|';

  const md = [
    '# 残局库疑点清单（生成物，人工核查用）',
    '',
    `引擎：${EXE}`,
    '',
    `## 1. 反杀（谱载「先手胜」，引擎说红方被杀）—— ${groups.reversed.length} 局`,
    '',
    '最可疑的一类：要么题面 FEN 与谱上不一致，要么谱载结论有误。',
    '',
    head, ...groups.reversed.map(line),
    '',
    `## 2. 谱载「先手胜」但没找到杀 —— ${groups.unsolved.length} 局`,
    '',
    '引擎给了优势分但没有强制杀：可能是「需要慢慢赢」而不是排局式的连杀，也可能确实有杀但超出了搜索范围。',
    '',
    head, ...groups.unsolved.map((x) => line(x)),
    '',
    `## 3. 谱载「和」但引擎说有杀 —— ${groups.drawWithMate.length} 局`,
    '',
    head, ...groups.drawWithMate.map((x) => line(x)),
    '',
    `## 4. 其他参考（和局评估偏离 / 胜局评估偏低）—— ${groups.winLowCp.length} 局`,
    '',
    head, ...groups.winLowCp.map((x) => line(x)),
    '',
    `## 5. 还没跑过的局 —— ${groups.notRun.length} 局`,
    '',
    groups.notRun.map((e) => e.id).join('  '),
    '',
  ].join('\n');

  writeFileSync(ISSUES_FILE, md);
  console.log(`疑点清单 → ${ISSUES_FILE}`);
  console.log(`  反杀 ${groups.reversed.length} / 未解出 ${groups.unsolved.length} / 和局却有杀 ${groups.drawWithMate.length} / 参考 ${groups.winLowCp.length} / 未跑 ${groups.notRun.length}`);
  writeUnfinished(work, loadCandidates());
}

// === 入口 ===

if (stage === 'fast' || stage === 'slow') {
  await search();
} else if (stage === 'emit') {
  emit();
} else if (stage === 'issues') {
  issues();
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/');
  process.exit(stage ? 1 : 0);
}
