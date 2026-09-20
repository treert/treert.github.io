#!/usr/bin/env node
/**
 * 「引擎首选前缀」扫描 —— **离线开发工具，不参与网页运行**（同 `gen-solutions.mjs`）。
 *
 * 为什么需要它：现有的两条路都只认「完整杀线」——
 *   * `gen-solutions.mjs` 用 `go mate` 搜，搜不到就不写（`js/solutions.js` 只收已证明的杀线）
 *   * 界面上没解法的局，点「提示」只能靠本地那个弱引擎现算
 * 而库里有一大批局面是**「谱载胜，但赢法不是连击式连杀」**（`docs/pikafish-unfinished.md` C 组）。
 * 这些局给不出完整杀线，但给得出**「引擎自己也想走的前 N 手」** —— 这就是本工具产出。
 *
 * ## **前缀是「引擎也同意」，不是「必须」**
 *
 * 这是本文件最重要的一句话，写进数据 / 界面时必须原样带上：
 * 实测第 004 局（`shiqingyaqu-551-004`）把谱上的妙手换成一个次优着法，Pikafish 只差
 * 0.3~0.8 个兵 —— `炮五平一` 红方 +9.52 vs 换成 `马二进三` 红方 +8.76；
 * 第 4 步谱着 +8.70 vs 换成 `兵六平五` +8.37。
 * 也就是说：**引擎分不出「杀网还在」和「只是还大优」**，所以它给前缀，给不了必要性证明。
 * 界面上要写「引擎推荐（非证明）」，不能写「正解」。
 * （详细实测见 `tmp/pf-004*.mjs` 那批探针，结论也记在 `future-work.md` C8。）
 *
 * ## 四个阶段
 *
 *   gen       给**没解出杀线**的局面走一条「引擎首选前缀」→ `tmp/prefix-work.json`
 *             （加 `--playout` 则**碰到 mate 不停、一路走到将死**，产出完整的候选杀线）
 *   promote   把 `gen` 里走成完整杀线的记录，用**本模块规则层**复核（每步合法 + 末局将死），
 *             过得了的写成 `tmp/prefix-candidates.json`。不需要引擎
 *   compare   把一条**已知线**（谱载 / 手给）与引擎首选逐点对照，报出「同意的前缀长度」
 *   emit      把 gen 的结果写成 `js/prefixes.js`（**只有决定接入界面时才跑**）
 *
 * ## 用法（从仓库根跑）
 *
 *   node chinese-chess/tools/prefix-scan.mjs gen --ids shiqingyaqu-551-004,shiqingyaqu-551-117
 *   node chinese-chess/tools/prefix-scan.mjs gen --from 400 --count 20 --rules 12 --movetime 2000
 *   node chinese-chess/tools/prefix-scan.mjs gen --playout --movetime 1500      # 走成完整候选杀线
 *   node chinese-chess/tools/prefix-scan.mjs promote                            # 规则层复核 → 候选线
 *   node chinese-chess/tools/prefix-scan.mjs compare --id shiqingyaqu-551-004 --line "马六进七 将4进1 …"
 *   node chinese-chess/tools/prefix-scan.mjs emit
 *
 * 候选线进 `js/solutions.js` 的路子：`promote` 写完 → `gen-solutions.mjs emit`（它把候选线当**兜底**读，
 * 只在某局没有"已证明的杀线"时才用）→ `verify-solutions.mjs` 再全量校验一遍。
 * 候选线在生成物里带 `src: 'walk'` —— 界面必须与已证明的解法分开措辞（前段没有证明）。
 *
 * 开关：
 *   --playout        gen 用：碰到 mate 不停，走到底（默认上限随之放宽到 40 回合）
 *   --ids a,b        只跑这几局（gen / compare 都认）
 *   --from N --count N   按 `endgames.js` 的顺序取一段（gen 默认只取**没解法且谱载红先胜**的局）
 *   --rules N        前缀上限，单位是**回合**（默认 12；`--playout` 时默认 40）
 *   --movetime MS    每个节点给引擎多少毫秒（默认 2000。**测过：加深并不会让「必须」出现**，
 *                    2 秒够用；想更稳可以给 5000，代价是线性变慢）
 *   --line "…"       compare 用：空格分隔的中文记谱（谱上那条线）
 *   --multipv N      compare 用：每个节点收前 N 条线（默认 3）—— 「并列」判定靠它
 *   --tol CP         compare 用：谱着与首选的分数差 ≤ CP 就算「并列」（默认 50 分）
 *   --all            compare 用：不在第一处**真分歧**就停，把整条线都对完
 *   --force          gen 用：忽略账本里已有的记录，重算
 *   --mate           改用 `go mate 40` 搜索。**默认不用**，理由见 `MATE_MODE` 那段的实测记录
 *
 * 中间结果在 `tmp/prefix-work.json`（tmp 被 git 忽略）：每局一条，**可中断、可续跑**。
 * 引擎与权重不进仓库（见 `docs/pikafish.md`），引擎只在离线时运行。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDGAMES } from '../js/endgames.js';
import { SOLUTIONS } from '../js/solutions.js';
import { parseFen, toFen, positionSignature } from '../js/position.js';
import { generateLegalMoves, moveFrom, moveTo, inCheck } from '../js/rules.js';
import { toNotation } from '../js/notation.js';
import { RED, CELLS } from '../js/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WORK_FILE = resolve(ROOT, 'tmp/prefix-work.json');
const OUT_FILE = resolve(HERE, '../js/prefixes.js');
/**
 * 候选完整杀线（`promote` 的产物）。**单独一个文件、不写进 `tmp/solutions-work.json`** ——
 * 那份账本是 `gen-solutions.mjs` 的，它每局一条、会被 fast/slow 无条件覆盖，
 * 我们塞进去的线一旦被覆盖就没了。这里分开存，让 `emit` 把它当**兜底**读。
 */
const CAND_FILE = resolve(ROOT, 'tmp/prefix-candidates.json');

/** 引擎版本写进产物头部 —— 换引擎重跑时只改这一处（与 gen-solutions.mjs 保持一致） */
const ENGINE = 'Pikafish 2026-09-06';
const EXE = process.env.PIKAFISH
  || resolve(ROOT, 'tmp/pikafish/Pikafish-Windows-x86-64-universal.exe');

// === 命令行 ===
const argv = process.argv.slice(2);
const stage = (argv[0] || 'gen').toLowerCase();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const IDS = (opt('ids', opt('id', '')) || '').split(',').filter(Boolean);
const FROM = Number(opt('from', 0));
const COUNT = Number(opt('count', Number.MAX_SAFE_INTEGER));
/**
 * `--playout`：碰到 `mate` 分**不停**，继续走到底（走到对方一步都走不出）。
 * 这样得到的是一条**完整的候选杀线**（可以直接交给 `js/solutions.js` 那条流水线去校验），
 * 而不是「走到一半就停在『引擎说这里有杀』的那一步」。
 * 代价是步数长（十几回合起），所以默认上限也跟着放宽 —— 不是规矩变了，是场景变了。
 */
const PLAYOUT = argv.includes('--playout');
const RULES = Number(opt('rules', PLAYOUT ? 40 : 12));
const MOVETIME = Number(opt('movetime', 2000));
const LINE = opt('line', '');
/** compare 用：前几条线（compare 的"并列"判定靠它，见 compareLine 的注释） */
const MULTIPV = Number(opt('multipv', 3));
/** compare 用：谱着与首选的分数差在这个范围内就算「并列」，不算分歧 */
const TOL = Number(opt('tol', 50));
const ALL = argv.includes('--all');
const FORCE = argv.includes('--force');
/**
 * `--mate`：改用 `go mate 40` 搜索。**默认不用**（走普通 `go movetime`）。
 *
 * 这条是试跑出来的，记在这里免得以后有人"顺手改回去"：
 * 同一个局面（第004局第 19 半层之前），`go mate 40 movetime 2000` 给出 `马二进三`（cp 420），
 * 而 `go movetime 3000` 给出 `炮五平一`（cp 815）——**mate 模式在"没有杀可证"的局面里
 * 选出来的最佳着法跟普通搜索不一样**，而且会让整条前缀在重复局面里打转（实测第 419 / 004 两局
 * 都是以 repeat 收场）。本工具问的是「引擎最想走什么」，那就该用普通搜索；
 * mate 模式只在**要检测"有没有杀"**时才有意义（`gen-solutions.mjs` 用它正面，见那边的说明）。
 */
const MATE_MODE = argv.includes('--mate');

// === 分数处理 ===
//
// 引擎给的分数是**轮走方视角**，而我们要的是「红方优势」——
// 走一步就换一次号，这里统一成一个数，免得后面每处都记着乘 -1。
/** `score mate 12` / `score cp 340` → { mate } 或 { cp } */
const parseScore = (text) => {
  const mate = text.match(/^mate (-?\d+)$/);
  if (mate) return { mate: Number(mate[1]) };
  const cp = text.match(/^cp (-?\d+)$/);
  return { cp: cp ? Number(cp[1]) : 0 };
};
/** 折算成红方视角的一个数（mate 折算成很大的分，保证排序正确） */
const redValue = (score, side) => {
  const v = 'mate' in score ? (score.mate > 0 ? 100000 - score.mate : -100000 - score.mate) : score.cp;
  return side === RED ? v : -v;
};
/** 同轮走方视角下比较两条线用（不换号，只把 mate 折成一个大数） */
const value = (score) => ('mate' in score
  ? (score.mate > 0 ? 100000 - score.mate : -100000 - score.mate)
  : score.cp);
const scoreText = (score, side) => {
  const sign = side === RED ? 1 : -1;
  if ('mate' in score) return `mate ${score.mate * sign}`;
  return `cp ${score.cp * sign}`;
};

// === 棋盘小工具 ===
const apply = (pos, move) => {
  const from = moveFrom(move), to = moveTo(move);
  pos.cells[to] = pos.cells[from];
  pos.cells[from] = 0;
  pos.side = -pos.side;
};
const idxOfIccs = (tok) => (9 - Number(tok[1])) * 9 + (tok.charCodeAt(0) - 97);
const iccsToMove = (tok) => (idxOfIccs(tok.slice(0, 2)) * CELLS) + idxOfIccs(tok.slice(2));
const moveToIccs = (move) => {
  const tok = (i) => `${String.fromCharCode(97 + (i % CELLS))}${9 - Math.floor(i / CELLS)}`;
  return tok(moveFrom(move)) + tok(moveTo(move));
};
/** 用记谱反查着法（记谱层只生成、不解析，所以只能正着匹配） */
const movesByNotation = (pos, text) =>
  generateLegalMoves(pos).filter((m) => toNotation(pos, m) === text);

/**
 * 把一串 ICCS 着法在**规则层**上走一遍，判断它是不是「走到对方无着法为止」的杀线。
 *
 * 判据与 `gen-solutions.mjs` 的 `pvLengthToMate` 是同一条：
 *   每一步都得在该局面的合法着法里；结束必须发生在**对方的回合**（奇数个半层之后）。
 * **引擎说「mate」不算数** —— 它给的 PV 可能被截断、坐标也可能对不上，
 * 只有本模块自己的规则层走通了才算（同 E10 的教训）。
 */
function lineReachesMate(fen, toks) {
  const pos = parseFen(fen);
  for (let i = 0; i < toks.length; i++) {
    const legal = generateLegalMoves(pos);
    if (legal.length === 0) return i > 0 && i % 2 === 1;
    const move = iccsToMove(toks[i]);
    if (!legal.includes(move)) return false;
    apply(pos, move);
  }
  return toks.length % 2 === 1 && generateLegalMoves(pos).length === 0;
}

// === 引擎会话 ===
function startEngine() {
  if (!existsSync(EXE)) {
    throw new Error(`找不到引擎：${EXE}\n先把 Pikafish 通用二进制 + pikafish.nnue 解压到 tmp/pikafish/，或设 PIKAFISH 环境变量（见 docs/pikafish.md）。`);
  }
  const proc = spawn(EXE, [], { cwd: dirname(EXE) });
  const rl = createInterface({ input: proc.stdout });
  let buf = [];
  let waiter = null;
  rl.on('line', (line) => {
    buf.push(line);
    if (waiter && waiter.match(line)) {
      const w = waiter;
      waiter = null;
      w.resolve();
    }
  });
  const send = (s) => proc.stdin.write(s + '\n');
  const wait = (match) => new Promise((resolve) => { waiter = { match, resolve }; });

  return {
    async boot() {
      send('uci');
      await wait((l) => l === 'uciok');
      send('setoption name Threads value 16\nsetoption name Hash value 1024\nisready');
      await wait((l) => l === 'readyok');
    },
    /**
     * 摆一个局面并搜索，返回 { best, score, depth, lines }。
     *
     * `multipv > 1` 时把前 K 条线都收回来 —— **这是 compare 判「一致 / 并列 / 分歧」的依据**：
     * 实测第 004 局第 7 回合，mate 模式首选 `马二进三`、普通搜索首选 `马二退三`，
     * 两者只差 0.3 兵。只看第 1 名的话，这种节点会被报成"分歧"，那是假警报；
     * 得看谱着与首选**差多少分**才说得清。
     */
    async search(fen, movetime, multipv = 1, useMate = false) {
      if (multipv > 1) {
        send(`setoption name MultiPV value ${multipv}\nisready`);
        await wait((l) => l === 'readyok');
      }
      buf = [];
      const go = (MATE_MODE || useMate) ? `go mate 40 movetime ${movetime}` : `go movetime ${movetime}`;
      send(`ucinewgame\nposition fen ${fen}\n${go}`);
      await wait((l) => l.startsWith('bestmove'));

      // 每个 multipv 序号取最后一条（同一次搜索里它会被不断刷新）
      const byMpv = new Map();
      for (const line of buf) {
        if (!line.startsWith('info ') || !line.includes(' pv ')) continue;
        const k = Number((line.match(/multipv (\d+)/) || [])[1] || 1);
        const scoreStr = (line.match(/score (mate -?\d+|cp -?\d+)/) || [])[1] || 'cp 0';
        byMpv.set(k, {
          iccs: ((line.match(/ pv (\S+)/) || [])[1] || ''),
          score: parseScore(scoreStr),
          scoreStr,
          depth: Number((line.match(/depth (\d+)/) || [])[1] || 0),
          pv: (line.match(/ pv (.*)$/) || [])[1] || '',
        });
      }
      if (multipv > 1) {
        send('setoption name MultiPV value 1\nisready');
        await wait((l) => l === 'readyok');
      }

      const lines = [...byMpv.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      const top = lines[0] || { iccs: '', score: { cp: 0 }, scoreStr: 'cp 0', depth: 0, pv: '' };
      return {
        best: top.iccs,
        score: top.score,
        scoreStr: top.scoreStr,
        depth: top.depth,
        pv: top.pv || '',
        lines,
      };
    },
    close() { send('quit'); },
  };
}

// === 账本 ===
function loadWork() {
  if (!existsSync(WORK_FILE)) return {};
  try { return JSON.parse(readFileSync(WORK_FILE, 'utf8')); } catch (e) {
    throw new Error(`中间结果读不动（${WORK_FILE}）：${e.message}`);
  }
}
const saveWork = (work) => {
  mkdirSync(dirname(WORK_FILE), { recursive: true });
  writeFileSync(WORK_FILE, JSON.stringify(work, null, 1));
};

// === gen：走一条「引擎首选前缀」（`--playout` 时走成一条完整线） ===
//
// 每一步都问引擎「你现在想走什么」，走它自己给的那一手，记下来。
// 停下来有五个理由，都写进记录里 —— 用户看到「为什么只算了 5 步」比看到空白有用：
//   cap        到了 --rules 的上限
//   mate       引擎给出了 mate 分，且**没开 --playout**（记录里 mateAt 标明从哪一手指起有杀证明）
//   notWinning 红方优势掉到 +1.5 兵以下（再往下就是"赢不下来"，不该当推荐给用户）
//   repeat     局面重复了（来回拉抽屉；排局里它往往就意味着"没有强制杀"）
//   terminal   已经终局（**开 --playout 时这就是我们想要的结果**：一条杀完的完整线）
async function genOne(eng, eg) {
  const steps = [];
  const seen = new Set();
  const pos = parseFen(eg.fen);
  const t0 = Date.now();
  let stop = 'cap';
  let note = '';
  /** 从第几半层起引擎给出了 mate 证明（0 = 全程没出现） */
  let mateAt = 0;
  /** 杀线尾巴：出现 mate 证明时，从那次搜索的 PV 里直接取的后续着法（ICCS） */
  let tail = [];

  for (let ply = 0; ply < RULES * 2; ply++) {
    const legal = generateLegalMoves(pos);
    if (legal.length === 0) { stop = 'terminal'; break; }
    const fen = toFen(pos);
    const sig = positionSignature(fen);
    if (seen.has(sig)) { stop = 'repeat'; break; }
    seen.add(sig);

    // `--playout` 且**这里已经有 mate 证明**时改用 mate 模式：
    // 实测第 282 局，全程用普通搜索一步步走会在 mate 9 → mate 10 → mate 9 里打转、最后 repeat，
    // 走不完那条杀线。mate 模式在"已有证明"的局面里正是对路的工具
    //（它在**没有**证明的局面里会选另一套着法，那是另一回事，见 MATE_MODE 那段）。
    const r = await eng.search(fen, MOVETIME, 1, PLAYOUT && mateAt > 0);
    const move = iccsToMove(r.best);
    if (!legal.includes(move)) {
      stop = 'illegal';
      note = `引擎给了非法着法 ${r.best}`;
      break;
    }
    const side = pos.side;
    const redv = redValue(r.score, side);
    steps.push({
      iccs: r.best,
      notation: toNotation(pos, move),
      side: side === RED ? 'red' : 'black',
      score: scoreText(r.score, side),
      redV: redv,
      depth: r.depth,
      legal: legal.length,
      /** 只有 1 个合法着法 = 无条件强制（被将军时最常见） */
      forced: legal.length === 1,
      check: inCheck(pos.cells, side),
    });
    if ('mate' in r.score && !mateAt) mateAt = steps.length;

    apply(pos, move);

    if ('mate' in r.score) {
      // 引擎在这一步给出了「N 步杀」的证明
      if (!PLAYOUT) {
        stop = 'mate';
        note = `${side === RED ? '红' : '黑'}方视角 ${scoreText(r.score, side)}`;
        break;
      }
      // --playout：**把这次搜索自己给出的整条杀线（PV）接在后面**，不要一步步重搜。
      // 为什么：实测「已有证明之后每步再搜一次」会在 mate 距离上来回跳（mate 9→10→9）、
      // 最后打转 repeat（第 282 局两次都这样），换成 mate 模式也一样。
      // 一次搜索的 PV 是引擎自己那条杀线，接上就走得完。
      const cand = steps.map((s) => s.iccs).concat(r.pv.trim().split(/\s+/).filter(Boolean).slice(1));
      if (lineReachesMate(eg.fen, cand)) {
        tail = cand.slice(steps.length);
        stop = 'mate-pv';
        note = `从第 ${mateAt} 半层起有 mate 证明，后续 ${tail.length} 手取自引擎给出的杀线`;
        break;
      }
      // PV 被截断（没走完）→ 回来继续一步步走，下一手起改用 mate 模式
      note = `从第 ${mateAt} 半层起有 mate 证明（PV 截断，继续逐手走）`;
      continue;
    }
    if (redv < 150) { stop = 'notWinning'; note = `红方只剩 ${(redv / 100).toFixed(2)} 兵优势`; break; }
  }

  // 一条**完整**杀线有两种来路（判据都与 `gen-solutions.mjs` 的 `pvLengthToMate` 一致）：
  //   terminal  自己一步步走到底（对方一步都走不出），半层数必须是奇数（最后一步是红方走）
  //   mate-pv   杀线尾巴取自引擎那一次搜索的 PV —— 上面已经用规则层确认过走到杀完
  const line = steps.map((s) => s.iccs).concat(tail);
  const complete = (stop === 'terminal' && tail.length === 0 && steps.length % 2 === 1)
    || stop === 'mate-pv';
  return {
    id: eg.id,
    name: eg.name,
    fen: eg.fen,
    result: eg.result || 'win',
    stop,
    note,
    mateAt,
    mate: complete ? (line.length + 1) / 2 : null,
    ms: Date.now() - t0,
    tail,
    steps,
  };
}

// === compare：把一条已知线和引擎首选逐点对照 ===
//
// 判定分三态，**不要只看第 1 名**：
//   same  引擎首选就是谱着
//   close 谱着在引擎的前 K 条线里、且与首选分差 ≤ --tol（默认 50 分）→ 算「并列」，仍计入一致前缀
//   diff  谱着没进前 K，或分差超过容差 → 真分歧
// 为什么要有 close：实测第 7 回合 mate 模式选 `马二进三`、普通搜索选 `马二退三`，两者同分。
// 把它们报成"谱错了"是假警报；报成"一致"又不诚实 —— 所以单独一态，并且把分差打出来。
async function compareLine(eng, eg, line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const rows = [];
  const pos = parseFen(eg.fen);
  let agree = 0;
  let firstDiff = -1;

  for (let i = 0; i < tokens.length; i++) {
    const hits = movesByNotation(pos, tokens[i]);
    if (hits.length !== 1) {
      rows.push({ ply: i + 1, line: tokens[i], error: `匹配到 ${hits.length} 个合法着法` });
      break;
    }
    const legal = generateLegalMoves(pos);
    const r = await eng.search(toFen(pos), MOVETIME, MULTIPV);
    const named = r.lines.map((l) => {
      const move = iccsToMove(l.iccs);
      return { ...l, note: legal.includes(move) ? toNotation(pos, move) : l.iccs };
    });
    const top = named[0];
    const hit = named.find((l) => l.note === tokens[i]);
    const gap = hit ? value(top.score) - value(hit.score) : Infinity;
    const verdict = (!hit || gap > TOL) ? 'diff' : (hit === top ? 'same' : 'close');
    rows.push({
      ply: i + 1,
      side: pos.side === RED ? 'red' : 'black',
      line: tokens[i],
      engine: top.note,
      tops: named,
      gap,
      verdict,
      score: top.scoreStr,
      depth: r.depth,
      legal: legal.length,
      forced: legal.length === 1,
    });
    if (verdict !== 'diff') agree++;
    else if (firstDiff < 0) firstDiff = i + 1;
    if (verdict === 'diff' && !ALL) break;

    apply(pos, hits[0]);
  }

  return { rows, agree, firstDiff, total: tokens.length };
}

// === 选目标 ===
function pickTargets() {
  const byId = new Map(ENDGAMES.map((e) => [e.id, e]));
  if (IDS.length) {
    return IDS.map((id) => {
      const eg = byId.get(id);
      if (!eg) throw new Error(`endgames.js 里没有「${id}」`);
      return eg;
    });
  }
  // 默认：**没解法、且谱载红先胜**的局（和局 / 黑胜给前缀没有意义）
  return ENDGAMES
    .slice(FROM, FROM + COUNT)
    .filter((eg) => !SOLUTIONS[eg.id] && (eg.result || 'win') === 'win');
}

// === 主流程 ===

// `promote` 只用规则层复核、不碰引擎 —— 提前处理，没装引擎时也能跑。
if (stage === 'promote') {
  promote();
  process.exit(0);
}

const eng = startEngine();
await eng.boot();

if (stage === 'gen') {
  const work = loadWork();
  const targets = pickTargets();
  console.log(`引擎 ${ENGINE} · ${MOVETIME}ms/手 · 上限 ${RULES} 回合 · 目标 ${targets.length} 局\n`);

  let done = 0;
  for (const eg of targets) {
    if (work[eg.id] && !FORCE) { done++; continue; }
    const rec = await genOne(eng, eg);
    work[eg.id] = rec;
    saveWork(work); // 每局都落盘 —— 断了也不白跑
    done++;
    console.log(`[${done}/${targets.length}] ${eg.name} (${eg.id})  停在 ${rec.stop}${rec.note ? '：' + rec.note : ''}`);
    for (const [i, s] of rec.steps.entries()) {
      console.log(`    ${String(i + 1).padStart(2)}. ${s.notation.padEnd(6)} ${s.iccs}  `
        + `红方 ${s.score.padEnd(9)} depth=${String(s.depth).padStart(2)} `
        + `合法${String(s.legal).padStart(3)} 手${s.forced ? '（唯一）' : ''}${s.check ? ' [被将]' : ''}`);
    }
    if (rec.tail && rec.tail.length) {
      console.log(`    ↳ 杀线尾巴 ${rec.tail.length} 半层（取自引擎那一次搜索的 PV，未逐手搜）：${rec.tail.join(' ')}`);
    }
    console.log('');
  }
  console.log(`账本：${WORK_FILE}（共 ${Object.keys(work).length} 局）`);
}

// === promote：把「走成完整杀线」的记录复核后写成候选线 ===
//
// 复核用**本模块自己的规则层**（与 `verify-solutions.mjs` 同一条判据）：
//   1. 每一步都在该局面的合法着法里
//   2. 走完之后**轮到对方、对方一步都走不出**
// 只有过了这两条的才写进 `tmp/prefix-candidates.json`。
// 为什么要自己再钉一遍：引擎说「mate」是它的说法，走到一半断掉、或坐标换算错位，
// 都会让它看起来"解出来了"（E10 的教训：**外部工具的产出必须用自己的规则层复核**）。
//
// **候选 ≠ 已证明的杀。** 一条候选线由两段拼成：
//   前段（`mateAt` 之前）引擎只给过 cp，是「引擎也想这么走」；
//   后段（`mateAt` 起）引擎给出了 mate 证明，是对手怎么走都杀。
// 所以进 `js/solutions.js` 时带 `src: 'walk'` 标记，界面要分开措辞。
function promote() {
  const work = loadWork();
  const out = {};
  const failed = [];
  const rows = [];

  for (const id of Object.keys(work).sort()) {
    const rec = work[id];
    if (!rec.mate) continue;
    const toks = rec.steps.map((s) => s.iccs).concat(rec.tail || []);
    const pos = parseFen(rec.fen);
    let bad = '';
    for (let i = 0; i < toks.length; i++) {
      const legal = generateLegalMoves(pos);
      if (legal.length === 0) { bad = `第 ${i + 1} 手时已无着法`; break; }
      const move = iccsToMove(toks[i]);
      if (!legal.includes(move)) { bad = `第 ${i + 1} 手 ${toks[i]} 不在合法着法里`; break; }
      apply(pos, move);
    }
    if (!bad && generateLegalMoves(pos).length !== 0) bad = '走完对方还有合法着法，不是杀局';
    if (bad) { failed.push(`${id}: ${bad}`); continue; }

    out[id] = {
      pv: toks.join(' '),
      mate: (toks.length + 1) / 2,
      mateAt: rec.mateAt,
      ms: rec.ms,
      src: 'walk',
    };
    rows.push({
      id,
      name: rec.name,
      mate: out[id].mate,
      mateAt: rec.mateAt,
      plies: toks.length,
      tail: (rec.tail || []).length,
    });
  }

  writeFileSync(CAND_FILE, JSON.stringify(out, null, 1));
  console.log(`复核通过 ${rows.length} 条候选杀线 → ${CAND_FILE}\n`);
  for (const r of rows) {
    const provenFrom = r.mateAt ? `第 ${Math.ceil(r.mateAt / 2)} 回合起有杀证明` : '（没有 mate 证明段 —— 不该在这里）';
    console.log(`  ${r.name} (${r.id})  ${r.mate} 步杀 / ${r.plies} 半层   ${provenFrom}`);
  }
  if (failed.length) {
    console.log(`\n被规则层挡下 ${failed.length} 条（引擎说杀、实际走不到）：`);
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log('\n下一步：node chinese-chess/tools/gen-solutions.mjs emit  →  再 verify-solutions.mjs 全量校验');
}

if (stage === 'compare') {
  // `--line` 是"某一条具体的线"，只能对**一个**局面用 —— 不给 --id 就拿默认那批局去套同一条线，
  // 是没意义的（第一版就这么错过了，输出一屏「匹配到 0 个合法着法」）。
  if (LINE && !IDS.length) throw new Error('用 --line 时必须同时给 --id <某局>：一条线只对一个局面有意义');
  const targets = pickTargets();
  if (!targets.length) throw new Error('没有目标：compare 需要 --ids 或 --line');
  console.log(`引擎 ${ENGINE} · ${MOVETIME}ms/手\n`);
  for (const eg of targets) {
    const line = LINE || (SOLUTIONS[eg.id] && SOLUTIONS[eg.id].pv);
    if (!line) { console.log(`跳过 ${eg.id}：既没有 --line，js/solutions.js 里也没有它的杀线\n`); continue; }
    const src = LINE ? '手给' : 'solutions.js';
    const r = await compareLine(eng, eg, line);
    const header = `【${src}】${eg.name} (${eg.id})`;
    console.log(header);
    for (const row of r.rows) {
      if (row.error) { console.log(`  ${String(row.ply).padStart(2)}. ${row.line}  !! ${row.error}`); continue; }
      // **单位不能省**：省掉 `mate` 前缀之后 `mate 6` 会显示成 `6`，
      // 和 `cp 6` 长得一模一样 —— 而这两者的意思差着十万八千里（第一次跑就踩了）。
      const tops = row.tops.slice(0, 3).map((t) => `${t.note}(${t.scoreStr})`).join(' ');
      const mark = row.verdict === 'same' ? '一致'
        : row.verdict === 'close' ? `并列（差 ${row.gap} 分）`
          : '← 分歧';
      console.log(`  ${String(row.ply).padStart(2)}. ${row.side === 'red' ? '红' : '黑'} `
        + `${row.line.padEnd(6)} 引擎前三：${tops.padEnd(30)} depth=${String(row.depth).padStart(2)} `
        + `合法${String(row.legal).padStart(3)} 手${row.forced ? ' 唯一' : ''} ${mark}`);
    }
    const turns = Math.ceil(r.agree / 2);
    const tail = r.firstDiff < 0 && r.rows.length === r.total
      ? '，全程一致'
      : `，第一处分歧在第 ${r.firstDiff} 半层（第 ${Math.ceil(r.firstDiff / 2)} 回合）`;
    console.log(`  → 引擎同意的前缀：${r.agree} 半层 ≈ ${turns} 回合${tail}\n`);
  }
}

if (stage === 'emit') {
  const work = loadWork();
  const all = Object.keys(work);
  if (!all.length) throw new Error(`账本是空的（${WORK_FILE}）—— 先跑 gen`);

  // **排除「引擎认为红方不行」的记录**。第 020 / 190 / 267 局是 A 组「反杀」：
  // 谱载红先胜，引擎却判定红方被杀 —— 沿着走出来的那条线是**黑方将死红方**的线
  // （stop=terminal 且半层数为偶数）。把它当"参考线"给用户跟着走，等于教他怎么输。
  // 判据用第一步的红方优势（< 0 = 引擎认为红方处于下风），比"看结尾半层奇偶"更直白。
  // 这类局照旧回退引擎搜索，界面上什么都不标。
  const ids = [];
  const skipped = [];
  for (const id of all) {
    const first = work[id].steps && work[id].steps[0];
    if (!first || first.redV < 0) { skipped.push(id); continue; }
    ids.push(id);
  }

  const body = ids
    .sort()
    .map((id) => {
      const r = work[id];
      // `pv` 是**完整**的（含 mate 证明节点上取回来的杀线尾巴）；
      // `notes` / `scores` 只覆盖「一步步走出来」的那一段 —— 尾巴那几手没逐手搜过，
      // 没有记谱与分数可信（它们来自引擎的 PV），别编一个出来。
      const pv = r.steps.map((s) => s.iccs).concat(r.tail || []).join(' ');
      const notes = r.steps.map((s) => s.notation).join(' ');
      const scores = r.steps.map((s) => s.score).join(' ');
      // `mate` / `mateAt` 只在 `--playout` 走成完整杀线时才有 ——
      // 界面据此把「一条走到底能杀的线」和「只是一段前缀」分开措辞（C 阶段接的）。
      const extra = r.mate
        ? `    mate: ${r.mate},\n    mateAt: ${r.mateAt},\n`
        : '';
      return `  '${id}': {\n`
        + `    pv: '${pv}',\n`
        + `    notes: '${notes}',\n`
        + `    scores: '${scores}',\n`
        + `    stop: '${r.stop}',\n`
        + extra
        + `  },`;
    })
    .join('\n');
  const head = `/**\n`
    + ` * 「引擎首选前缀」——**生成物，别手改**。生成：\`node chinese-chess/tools/prefix-scan.mjs emit\`\n`
    + ` * （引擎 ${ENGINE}；账本 tmp/prefix-work.json，被 git 忽略）\n`
    + ` *\n`
    + ` * **这是「引擎也同意」，不是「正解」，也不是「必须」**：\n`
    + ` * 实测把谱上的妙手换成次优着法，Pikafish 只差 0.3~0.8 个兵（第004局 炮五平一 +9.52\n`
    + ` * vs 马二进三 +8.76），说明它分不出「杀网还在」和「只是还大优」。\n`
    + ` * 所以界面上只能写「引擎推荐前 N 步（非证明）」，不能写「解法 / 正解」。\n`
    + ` *\n`
    + ` * stop 的含义：cap=到上限 / mate=引擎给了杀（没开 --playout 时会停在这里）/\n`
    + ` *              notWinning=红方优势掉到 +1.5 兵以下 / repeat=局面重复 / terminal=终局 / illegal=引擎给非法着法\n`
    + ` *\n`
    + ` * 带 \`mate\` 字段的条目是 --playout 走到底的**完整线**：从 \`mateAt\` 那一半层起引擎给出了\n`
    + ` * mate 证明（对手怎么走都杀），之前的那一段只是「引擎也想这么走」。\n`
    + ` */\n\n`
    + `export const PREFIXES = {\n${body}\n};\n\n`
    + `export const PREFIXES_SOURCE = '${ENGINE} · ${MOVETIME}ms/手 · 上限 ${RULES} 回合${PLAYOUT ? ' · --playout' : ''}';\n`;
  writeFileSync(OUT_FILE, head);
  console.log(`已写出 ${OUT_FILE}（${ids.length} 局）`);
  if (skipped.length) {
    console.log(`（跳过 ${skipped.length} 局「引擎认为红方不行」的，不写进去：${skipped.join(', ')}）`);
  }
}

eng.close();
