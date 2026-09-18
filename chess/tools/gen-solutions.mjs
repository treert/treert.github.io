#!/usr/bin/env node
/**
 * 残局解法生成器 —— **离线开发工具，不参与网页运行**。
 *
 * 用法（从仓库根跑）：
 *
 *   node chess/tools/gen-solutions.mjs local          # 用内置的精确杀棋搜索（不需要引擎）
 *   node chess/tools/gen-solutions.mjs stockfish      # 用原生 Stockfish（UCI），需要先装好
 *   node chess/tools/gen-solutions.mjs emit           # 写成 js/solutions.js
 *   node chess/tools/gen-solutions.mjs check          # 只复核 js/solutions.js 里的线
 *
 * 两种来源：
 *
 *   - **local**：内置的**精确**强制杀搜索（攻方 ∃ / 守方 ∀），只证明短杀（默认 ≤ 5 个半层
 *     = 3 步杀）。不需要任何外部程序，跑出来的线一定是对的 —— 但它找不到长杀。
 *   - **stockfish**：用原生 Stockfish 的 UCI 协议算主变（`go depth` / `go movetime`），
 *     挂了 Syzygy 表库就是 DTZ 口径的可证明结论（见 docs/stockfish.md）。
 *     引擎不进仓库，用 `STOCKFISH` 环境变量或默认路径指向可执行文件。
 *
 * **两条路都必须用本模块的规则层复核**：生成时每走一步都调 `generateLegalMoves`
 * 确认这一步真的合法（UCI 是文本协议，升变 `e7e8q`、易位 `e1g1` 最容易解析错），
 * 走完还要确认终局达成 `result`。`verify-endgames.mjs` 会再复核一遍。
 *
 * 数据来源要写清楚：写入 `solutions.js` 的 `SOLUTIONS_SOURCE` 会记下这次用了哪条路。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { allEndgames } from '../js/endgames.js';
import { parseFen, positionSignature } from '../js/position.js';
import { generateLegalMoves, makeMove, inCheck, moveToUci } from '../js/rules.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(HERE, '../js/solutions.js');
const ROOT = resolve(HERE, '../..');

const argv = process.argv.slice(2);
const stage = (argv[0] || '').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

/** 本地求解器的层数上限。5 = 三步杀；7 已经能在稀疏局面里找到五步杀（慢） */
const MAX_PLY = Number(opt('ply', 5));
/** Stockfish 的搜索方式 */
const MOVETIME = Number(opt('movetime', 3000));
const DEPTH = Number(opt('depth', 30));
const EXE = process.env.STOCKFISH
  || resolve(ROOT, 'tmp/stockfish/stockfish-windows-x86-64-avx2.exe');

// ============================================================
// 本地：精确强制杀搜索
// ============================================================
//
// 「攻方存在一步，使得对手**所有**应法之后攻方仍能在剩余层数内将死」——
// ∃ / ∀ 的结构让剪枝非常有效（∀ 只要找到一条撑得住的应法就能立刻返回）。
// 结果缓存按「局面签名 + 剩余层数」记，避免同一个局面被反复展开。

const solveCache = new Map();

/** 该方在 ply 个半层内能否强制将死；能则返回第一步，否则返回 0 */
function solve(pos, ply) {
  if (ply <= 0) return 0;
  const key = `${positionSignature(pos)}|${ply}`;
  const hit = solveCache.get(key);
  if (hit !== undefined) return hit;

  const moves = generateLegalMoves(pos);
  let best = 0;
  for (const m of moves) {
    const next = makeMove(pos, m).pos;
    const defs = generateLegalMoves(next);
    if (defs.length === 0 && inCheck(next.cells, next.side)) { best = m; break; }
    if (ply < 3) continue;

    let all = true;
    for (const d of defs) {
      const after = makeMove(next, d).pos;
      if (!solve(after, ply - 2)) { all = false; break; }
    }
    if (all) { best = m; break; }
  }
  solveCache.set(key, best);
  return best;
}

/** 剩余的最短杀棋层数（找不到就返回 Infinity） */
function mateDistance(pos, maxPly) {
  for (let d = 1; d <= maxPly; d += 2) if (solve(pos, d)) return d;
  return Infinity;
}

/**
 * 展开成一条完整杀线（UCI 文本）。
 *
 * 攻方每次都走**最快**的杀法；守方每次都走**最顽强**的应法（让攻方需要更多层数）。
 * 这样拿到的线在界面上看起来像正常应对，而不是「对手随手送死」。
 */
function buildLine(fen, maxPly) {
  let pos = parseFen(fen);
  const pv = [];

  for (let guard = 0; guard < maxPly; guard++) {
    const moves = generateLegalMoves(pos);
    if (moves.length === 0) break;

    const dist = mateDistance(pos, maxPly);
    if (dist === Infinity) return { pv: [], mate: 0 };

    const m = solve(pos, dist);
    if (!m) return { pv: [], mate: 0 };
    pv.push(moveToUci(m));
    pos = makeMove(pos, m).pos;

    const defs = generateLegalMoves(pos);
    if (defs.length === 0) break;          // 已经杀完（下面按奇数层收尾）

    let bestD = 0;
    let bestDist = -1;
    for (const d of defs) {
      const after = makeMove(pos, d).pos;
      const dd = mateDistance(after, maxPly) ?? Infinity;
      const value = dd === Infinity ? 1e9 : dd; // 守方撑得越久越好
      if (bestD === 0 || value > bestDist) { bestD = d; bestDist = value; }
    }
    pv.push(moveToUci(bestD));
    pos = makeMove(pos, bestD).pos;
  }

  if (pv.length === 0 || pv.length % 2 === 0) return { pv: [], mate: 0 };
  const end = generateLegalMoves(pos);
  if (end.length !== 0 || !inCheck(pos.cells, pos.side)) return { pv: [], mate: 0 };
  return { pv, mate: (pv.length + 1) / 2 };
}

// ============================================================
// Stockfish：UCI 驱动
// ============================================================

/** 用 PV 复现一遍，确认「走到将死为止」用了几步；不合格返回 0（照搬象棋那套判据） */
function pvToMate(fen, tokens) {
  let pos = parseFen(fen);
  for (let i = 0; i < tokens.length; i++) {
    const moves = generateLegalMoves(pos);
    if (moves.length === 0) return i > 0 && i % 2 === 1 ? i : 0;
    const move = moves.find((m) => moveToUci(m) === tokens[i]);
    if (!move) return 0;                 // 引擎给的着法在当地规则下走不通 → 整条不要
    pos = makeMove(pos, move).pos;
  }
  return 0;
}

function startStockfish() {
  if (!existsSync(EXE)) {
    throw new Error(`找不到引擎：${EXE}\n从 stockfishchess.org 下载对应平台的原生二进制，`
      + '解压到 tmp/stockfish/，或用 STOCKFISH 环境变量指过去（见 docs/stockfish.md §1）。');
  }
  const proc = spawn(EXE, [], { cwd: dirname(EXE) });
  let pending = null;
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!pending) continue;
      if (line.startsWith('info ') && line.includes(' pv ')) pending.last = line;
      else if (line.startsWith('bestmove')) {
        pending.best = line.split(/\s+/)[1] || '';
        const p = pending;
        pending = null;
        p.resolve();
      }
    }
  });
  proc.on('close', () => { if (pending) { pending.resolve(); pending = null; } });

  const send = (cmd) => proc.stdin.write(`${cmd}\n`);
  send('uci');
  send('setoption name Threads value 8');
  send('setoption name Hash value 1024');
  send('isready');

  return {
    async run(fen, goLine) {
      send('ucinewgame');
      send(`position fen ${fen}`);
      const state = { last: '', best: '', resolve: null };
      state.promise = new Promise((r) => { state.resolve = r; });
      pending = state;
      send(goLine);
      await state.promise;
      const pv = (/(?: pv )(.+)$/.exec(state.last) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
      const mate = /score mate (-?\d+)/.exec(state.last);
      return { pv, best: state.best, mate: mate ? Number(mate[1]) : null };
    },
    close() { send('quit'); },
  };
}

async function runStockfish() {
  const engine = startStockfish();
  const goLine = `go depth ${DEPTH} movetime ${MOVETIME}`;
  const rows = [];
  const entries = allEndgames().filter((e) => e.result === 'white');
  console.log(`用 Stockfish 跑 ${entries.length} 个「先手胜」的局面：${goLine}\n`);

  for (const eg of entries) {
    const r = await engine.run(eg.fen, goLine);
    const n = pvToMate(eg.fen, r.pv);
    if (!n) {
      console.log(`  --  ${eg.name}：引擎没给出一条走到杀的线（${r.pv.length} 个半层）`);
      continue;
    }
    const pv = r.pv.slice(0, n);
    rows.push({ id: eg.id, pv: pv.join(' '), mate: (n + 1) / 2 });
    console.log(`  ok  ${eg.name}：${(n + 1) / 2} 步杀`);
  }
  engine.close();
  writeSolutions(rows, `Stockfish（depth ${DEPTH} / movetime ${MOVETIME}ms）`);
}

function runLocal() {
  const entries = allEndgames().filter((e) => e.result === 'white');
  console.log(`用内置的精确杀棋搜索跑 ${entries.length} 个「先手胜」的局面（上限 ${MAX_PLY} 个半层）\n`);
  const rows = [];
  for (const eg of entries) {
    const line = buildLine(eg.fen, MAX_PLY);
    if (!line.mate) {
      console.log(`  --  ${eg.name}：${MAX_PLY} 层内没找到强制杀（正常的，长杀超出上限）`);
      continue;
    }
    rows.push({ id: eg.id, pv: line.pv.join(' '), mate: line.mate });
    console.log(`  ok  ${eg.name}：${line.mate} 步杀  ${line.pv.join(' ')}`);
  }
  writeSolutions(rows, `内置精确杀棋搜索（上限 ${MAX_PLY} 个半层）`);
}

// ============================================================
// 写出 / 复核
// ============================================================

const HEAD = `/**
 * 残局解法 —— **这个文件是生成的，别手改**。
 *
 * 生成：\`node chess/tools/gen-solutions.mjs local\`（内置精确杀棋搜索，不需要引擎）
 *       或 \`node chess/tools/gen-solutions.mjs stockfish\`（原生 Stockfish，可挂表库）
 * 复核：\`node chess/tools/verify-endgames.mjs\`（每一步合法 + 末局确实是将死）
 *
 * ## 里面是什么
 *
 * 每条是本局**从初始局面开始**的一条主线着法序列（\`pv\`），用 UCI 坐标
 * （\`e2e4\` / \`e7e8q\`），与 Stockfish、与任何棋谱软件同格式，拿出去核对方便。
 * \`mate\` 是**先手方步数**，由实际走出来的长度推得（\`pv\` 长度恒为 \`2 * mate - 1\`）。
 *
 * 只收「已经证明是强制杀」的局：
 *   - local 那条路是**精确**的 ∃/∀ 搜索（找不到不等于没有，但找到的一定对）；
 *   - Stockfish 那条路要求引擎给出完整走到杀的 PV，并且**每一步都用本模块的
 *     规则层走通过**（UCI 的升变与易位最容易解析错）。
 *
 * 没找到的局不编 —— 界面上显示「暂无谱载解法」，点「提示」时回退本地引擎现算。
 */

`;

function writeSolutions(rows, source) {
  const body = rows.map((r) => `  '${r.id}': { pv: '${r.pv}', mate: ${r.mate} },`).join('\n');
  const text = `${HEAD}/** 生成这批数据用的是什么 */
export const SOLUTIONS_SOURCE = '${source}';

/** id → 解法。**只有证明过强制杀的局才在这里**（${rows.length} 条） */
export const SOLUTIONS = {
${body}
};

/** 取某一局的解法；没有则返回 null */
export function solutionOf(id) {
  return Object.prototype.hasOwnProperty.call(SOLUTIONS, id) ? SOLUTIONS[id] : null;
}
`;
  writeFileSync(OUT_FILE, text);
  console.log(`\n已写出 ${rows.length} 条解法 → ${OUT_FILE}`);
}

/** 只复核现有的 solutions.js（改完规则层之后跑一次，不需要重算） */
async function checkExisting() {
  // 加时间戳绕开模块缓存；Windows 上动态 import 必须用 file:// URL
  const mod = await import(`${pathToFileURL(OUT_FILE).href}?t=${Date.now()}`);
  let bad = 0;
  for (const [id, sol] of Object.entries(mod.SOLUTIONS)) {
    const eg = allEndgames().find((e) => e.id === id);
    if (!eg) { console.log(`FAIL  ${id}：解法指向一个不存在的局面`); bad++; continue; }
    const tokens = sol.pv.split(/\s+/).filter(Boolean);
    const n = pvToMate(eg.fen, tokens);
    const okMate = n === tokens.length && n === 2 * sol.mate - 1;
    if (!okMate) { console.log(`FAIL  ${id}：这条线走不到杀（${tokens.length} 个半层）`); bad++; }
    else console.log(`ok    ${id}：${sol.mate} 步杀`);
  }
  console.log(`\n${bad === 0 ? '全部通过' : `${bad} 条不合格`}`);
  process.exit(bad === 0 ? 0 : 1);
}

// ============================================================
// 入口
// ============================================================
if (stage === 'local') {
  runLocal();
} else if (stage === 'stockfish') {
  await runStockfish();
} else if (stage === 'check') {
  await checkExisting();
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/');
  process.exit(stage ? 1 : 0);
}
