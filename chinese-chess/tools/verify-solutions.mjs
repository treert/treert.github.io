#!/usr/bin/env node
/**
 * 残局解法校验。直接跑 Node —— 不需要浏览器、不需要装依赖、**不需要引擎**。
 *
 * 用法：
 *   node chinese-chess/tools/verify-solutions.mjs          # 校验全部（默认）
 *   node chinese-chess/tools/verify-solutions.mjs <id>     # 只验一局，并把整条杀线打成中文记谱
 *
 * `<id>` 就是 `js/solutions.js` 里的键，例如 `shiqingyaqu-551-002`。
 *
 * ## 它查什么
 *
 *   1. `id` 在残局库里找得到（解法文件与 endgames.js 不能对不上）
 *   2. `pv` 里的**每一手都在该局面的合法着法里**（坐标换算方向错了会在这里现形）
 *   3. 走完 `pv` 之后，对方**一步都走不出**（将死或困毙，在中国象棋里都是负）
 *   4. 长度对得上：`pv` 应为 `2 * mate - 1` 个半层（红方 N 步杀 = 2N-1 ply）
 *   5. 整条线能一路生成中文记谱（记谱层要是被改坏，这里会先炸）
 *
 * ## 为什么这层校验是必要的（不是走过场）
 *
 * 解法由外部引擎（Pikafish）生成，而外部工具的输出要当**数据**用，就得过一遍
 * **本模块自己的规则层**：坐标换算对不对、FEN 是不是同一个局面、杀棋是不是真杀。
 * 它验证的是「我们的规则 / 记谱 / 引擎都认同这条线」，而不只是「Pikafish 自己说它对」。
 *
 * 这是 E10 那条教训的正面用法：外部工具的产出，必须用**独立的**一层去钉。
 * 生成与校验分开也意味着 —— 换引擎重跑生成器之后，校验不用跟着改。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const { parseFen } = await load('position.js');
const { encodeMove, generateLegalMoves } = await load('rules.js');
const { toNotation } = await load('notation.js');
const { ENDGAMES } = await load('endgames.js');
const { SOLUTIONS, SOLUTIONS_SOURCE } = await load('solutions.js');

/** ICCS 坐标 → 我们的格子下标：列 a-i 从左到右（x = 0..8），行 0-9 从红方底线往上（y = 9..0） */
const idxOf = (tok) => (9 - Number(tok.slice(1))) * 9 + (tok.charCodeAt(0) - 97);

const byId = new Map(ENDGAMES.map((e) => [e.id, e]));

let failed = 0;
function fail(id, name, reason) {
  failed++;
  console.log(`FAIL  ${name}  (${id})\n        原因：${reason}`);
}

/** 传一个 id 就只看那一局（并把整条杀线打成中文记谱，方便手动核对） */
const only = process.argv[2] || '';
const entries = Object.entries(SOLUTIONS).filter(([id]) => !only || id === only);
if (only && entries.length === 0) {
  console.log(`解法库里没有「${only}」—— id 见 js/solutions.js，如 shiqingyaqu-551-002`);
  process.exit(1);
}

console.log(`残局解法校验：${only ? `只看 ${only}` : `共 ${entries.length} 条`}（生成自 ${SOLUTIONS_SOURCE}）\n`);

for (const [id, sol] of entries) {
  const eg = byId.get(id);
  if (!eg) {
    fail(id, '(库里没有这一局)', 'id 不在 endgames.js 的残局库里');
    continue;
  }

  const toks = sol.pv.trim().split(/\s+/).filter(Boolean);

  // **长度只当警告，不当失败。** 引擎（Pikafish）在 mate 搜索模式下 PV 会被截断 ——
  // 实测第 005 局报 `mate 20` 而 PV 只有 11 个半层（`gen-solutions.mjs` 里记了原始值）。
  // 真正的判据是下面那条：**走完 PV 之后对方一步都走不出**。
  // 长度对不上只说明这条 PV 比引擎报的杀棋更早结束，不影响「它是不是一条完整的杀线」。
  const want = 2 * sol.mate - 1;
  const lenWarn = toks.length !== want
    ? `  ⚠ PV ${toks.length} 半层 ≠ mate ${sol.mate} 推算的 ${want}`
    : '';

  const pos = parseFen(eg.fen);
  let bad = '';
  const notes = []; // 全部着法（红黑都收）—— 指定单局时打出来给人工核对

  for (let i = 0; i < toks.length; i++) {
    const from = idxOf(toks[i].slice(0, 2));
    const to = idxOf(toks[i].slice(2));
    const move = encodeMove(from, to);

    if (!generateLegalMoves(pos).includes(move)) {
      bad = `第 ${i + 1} 手 ${toks[i]} 不在合法着法里`;
      break;
    }
    // 顺带过一遍记谱：改坏了记谱层，这里就会抛
    notes.push(toNotation(pos, move));

    pos.cells[to] = pos.cells[from];
    pos.cells[from] = 0;
    pos.side = -pos.side;
  }

  if (bad) {
    fail(id, eg.name, bad);
    continue;
  }
  if (generateLegalMoves(pos).length !== 0) {
    fail(id, eg.name, '走完 PV 之后对方还有合法着法 —— 这不是一个杀局');
    continue;
  }

  console.log(`ok    ${eg.name}  (${id})  ${sol.mate} 步杀 / ${toks.length} 半层${lenWarn}`);
  if (only) {
    // 单局模式才打整条杀线 —— 全量跑 395 条会把屏幕刷没
    console.log(`        初始局面：${eg.fen}`);
    for (let i = 0; i < notes.length; i += 2) {
      const black = notes[i + 1] ? `  ${notes[i + 1]}` : '';
      console.log(`        ${String(i / 2 + 1).padStart(2)}. ${notes[i]}${black}`);
    }
    console.log('');
  }
}

const total = ENDGAMES.length;
const solved = Object.keys(SOLUTIONS).length;
console.log(`\n覆盖：${solved}/${total} 局有解法（其余局要么是和局、要么引擎没找到强制杀）`);
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
