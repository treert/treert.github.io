/**
 * 入口：状态中枢 + 模块装配 + Worker 通信 + 结算。
 *
 * 分工与象棋一致（design.md §2 末尾）：**状态集中在 `app` 上**，
 * 其他模块之间不互相 import，统一通过 `app` 上的回调协作，避免依赖成网。
 *
 * 三条要点：
 *
 *   1. **`app.game` 是引擎真相，`app.view` 是给界面与 AI 看的那一份。**
 *      页面自己画的也是 view —— 界面不越过 view 去读 `game.hands`，
 *      这样"AI 看不到别人的牌"和"界面不会不小心显示出来"是同一件事在兜底。
 *
 *   2. **AI 跑在 Worker 里，只收 view。** 主线程发 `{ view, levelId, seed }`，
 *      收回一个着法（§7.6）。这是"不偷看"的第三道防线（§3.1）。
 *
 *   3. 一局的节奏由 `tick()` 驱动：该谁行动就派发谁，AI 之间留 420ms 的停顿 ——
 *      不然两个 AI 会瞬间打完一轮，人根本看不清刚才发生了什么（§9.3）。
 */

import { legalPlays, isPass } from './moves.js';
import { viewOf, canPass } from './view.js';
import { rankMoves } from './ai/greedy.js';
import { decideBid } from './ai/index.js';
import {
  createGame, bid, play, biddingSeat, currentBestScore, multiplierOf,
} from './game.js';
import { findLevel, LEVELS, DEFAULT_LEVEL, STORAGE_KEY } from './config.js';
import { mulberry32 } from './cards.js';
import { collectRefs, renderAll, layoutHand } from './renderer.js';
import { attachInteraction } from './interaction.js';
import {
  load as loadSave, saveSoon, flush, loadStats, recordResult, defaultStorage,
} from './persist.js';

const HUMAN = 0;          // 真人固定坐下方的 0 号位
const BID_PAUSE_MS = 500; // AI 叫分之间的停顿（§9.3 的"逐条播报"）
const AI_PAUSE_MS = 420;  // AI 出牌之间的停顿

const refs = collectRefs();

const app = {
  game: null,
  level: findLevel(DEFAULT_LEVEL),
  view: null,
  selected: new Set(),
  hintMoves: [],
  hintIdx: -1,
  status: '',
  narrate: '',
  note: '',
  multiplier: 1,
  busy: false,
  resultShown: false,
  biddingSeat: null,
  rng: null,
  aiSeed: 1,
};

// === Worker ===

let worker = null;
let seq = 0;
const pending = new Map();

function startWorker() {
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
}

/** 派发一次决策给 Worker。`view` 是**唯一**传出去的东西 */
function ask(type, view) {
  if (!worker) return Promise.reject(new Error('Worker 不可用 —— 请用 http 打开（见 README）'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({
      id, type, view, levelId: app.level.id, seed: (app.aiSeed += 7919),
    });
  });
}

// === 状态查询 ===

function humanTurn() {
  const g = app.game;
  if (g.phase === 'bidding') return biddingSeat(g) === HUMAN;
  if (g.phase === 'playing') return g.turn === HUMAN;
  return false;
}

function canAct() {
  return humanTurn() && !app.busy;
}

function seatName(seat) {
  if (seat === HUMAN) return '你';
  if (seat === 1) return '下家';
  if (seat === 2) return '上家';
  return `${seat} 号位`;
}

function resetHint() {
  app.hintMoves = [];
  app.hintIdx = -1;
}

// === 渲染 ===

function refresh() {
  const g = app.game;
  app.view = viewOf(g, HUMAN);
  app.biddingSeat = g.phase === 'bidding' ? biddingSeat(g) : null;
  app.multiplier = multiplierOf(g);
  app.status = app.narrate || statusText();
  renderAll(refs, app);
  updateButtons();
  // 每两次 tick 之间状态都是自洽的（§8.1 的变更函数要么整体成功要么整体拒绝），
  // 所以放在这里存是安全的。防抖 300ms，一轮 AI 只会写一次。
  saveSoon(g, app.level.id);
}

function statusText() {
  const g = app.game;
  if (g.phase === 'finished') {
    const r = g.result;
    return r.winner === 'landlord' ? '地主胜' : '农民胜';
  }
  if (g.phase === 'bidding') {
    const s = biddingSeat(g);
    if (s === null) return '叫分结束';
    if (s === HUMAN) return '轮到你叫分';
    return `${seatName(s)} 正在叫分…`;
  }
  if (app.busy) return `${seatName(g.turn)} 正在出牌…`;
  return g.turn === HUMAN ? '轮到你出牌' : `${seatName(g.turn)} 出牌`;
}

function updateButtons() {
  const g = app.game;
  const bidding = g.phase === 'bidding';
  const playing = g.phase === 'playing';
  const act = canAct();

  refs.btnPlay.hidden = !playing;
  refs.btnPass.hidden = !playing;
  refs.btnHint.hidden = !playing;
  refs.btnTrustBid.hidden = !bidding;
  refs.btnBidPass.hidden = !bidding;
  for (const b of refs.btnBid) b.hidden = !bidding;

  refs.btnPlay.disabled = !act || app.selected.size === 0;
  refs.btnPass.disabled = !act || !app.view || !canPass(app.view);
  refs.btnHint.disabled = !act;

  const best = bidding ? currentBestScore(g) : 0;
  refs.btnBidPass.disabled = !act;
  refs.btnBid.forEach((b, i) => { b.disabled = !act || (i + 1) <= best; });
  refs.btnTrustBid.disabled = !act;

  // 置灰必须给原因：一排按钮里几个点不动却不解释，看起来很像 bug（§9.3）
  if (bidding && act && best > 0 && !app.note) {
    app.note = `必须高于 ${best} 分`;
    refs.note.textContent = app.note;
    refs.note.hidden = false;
  }
}

// === 驱动器 ===

function tick() {
  const g = app.game;
  if (g.phase === 'finished') { showResult(); return; }

  if (g.phase === 'bidding') {
    const seat = biddingSeat(g);
    if (seat === null) return;
    if (seat === HUMAN) {
      app.busy = false;
      app.narrate = '';
      refresh();
      return;
    }
    app.busy = true;
    refresh();
    ask('bid', viewOf(g, seat))
      .then((res) => {
        const r = bid(g, seat, res.score, app.rng);
        if (!r.ok) throw new Error(r.reason);
        const label = res.score === 0 ? '不叫' : `叫 ${res.score} 分`;
        app.narrate = r.redeal
          ? '三家都不叫，重新发牌'
          : `${seatName(seat)} ${label}`;
        refresh();
        setTimeout(() => { app.narrate = ''; tick(); }, r.redeal ? 1000 : BID_PAUSE_MS);
      })
      .catch(showError);
    return;
  }

  if (g.phase === 'playing') {
    if (g.turn === HUMAN) {
      app.busy = false;
      refresh();
      return;
    }
    app.busy = true;
    refresh();
    const seat = g.turn;
    ask('decide', viewOf(g, seat))
      .then((res) => {
        const r = play(g, seat, res.move);
        if (!r.ok) throw new Error(r.reason);
        refresh();
        setTimeout(tick, AI_PAUSE_MS);
      })
      .catch(showError);
  }
}

function showError(err) {
  app.busy = false;
  app.note = String((err && err.message) || err);
  app.narrate = '';
  refresh();
}

// === 人类操作 ===

function startGame() {
  app.rng = mulberry32(((Math.random() * 0x7fffffff) | 0) || 1);
  app.game = createGame({ rng: app.rng });
  app.selected.clear();
  resetHint();
  app.narrate = '';
  app.note = '';
  app.busy = false;
  app.resultShown = false;
  // 新开一局立刻落盘：不然用户发完牌就刷新，读到的还是上一局
  flush(app.game, app.level.id);
  refresh();
  tick();
}

function onCardClick(card) {
  if (app.game.phase !== 'playing' || !canAct()) return;
  if (!app.view.myHand.includes(card)) return;
  if (app.selected.has(card)) app.selected.delete(card);
  else app.selected.add(card);
  resetHint();
  app.note = '';
  refresh();
}

function clearSelection() {
  app.selected.clear();
  resetHint();
  app.note = '';
  refresh();
}

function onPlay() {
  if (!canAct() || app.selected.size === 0) return;
  const cards = Array.from(app.selected);
  const r = play(app.game, HUMAN, { kind: 'play', cards });
  if (!r.ok) {
    // 非法**就地给原因**，不弹窗（与象棋"改选另一个子"同一态度，§9.2）
    app.note = r.reason;
    refresh();
    return;
  }
  app.selected.clear();
  resetHint();
  app.note = '';
  app.narrate = '';
  refresh();
  tick();
}

function onPass() {
  if (!canAct()) return;
  const r = play(app.game, HUMAN, { kind: 'pass' });
  if (!r.ok) { app.note = r.reason; refresh(); return; }
  app.selected.clear();
  resetHint();
  app.note = '';
  refresh();
  tick();
}

/**
 * 提示：按当前手牌能出的所有牌型**从好到坏循环**给出，并自动选中对应的牌。
 *
 * **不施加挡位弱化** —— 即使当前是「入门」，提示也用最优排序（§9.3）。
 * 理由是象棋那条结论的直接推广：提示的可信度比"像不像当前挡位"重要。
 */
function onHint() {
  if (!canAct()) return;
  if (!app.hintMoves.length) {
    const g = app.game;
    const last = g.trick.lastPlay ? g.trick.lastPlay.combo : null;
    const moves = legalPlays(g.hands[HUMAN], last);
    app.hintMoves = rankMoves(app.view, moves, app.level);
    app.hintIdx = -1;
  }
  if (!app.hintMoves.length) return;

  app.hintIdx = (app.hintIdx + 1) % app.hintMoves.length;
  const { move } = app.hintMoves[app.hintIdx];
  const nth = app.hintMoves.length > 1
    ? `（第 ${app.hintIdx + 1} / ${app.hintMoves.length} 个，再点换下一个）`
    : '';

  if (isPass(move)) {
    app.selected.clear();
    app.note = `建议：不要${nth}`;
  } else {
    app.selected = new Set(move.cards);
    app.note = `建议：出这 ${move.cards.length} 张${nth}`;
  }
  refresh();
}

function onBid(score) {
  if (!canAct() || app.game.phase !== 'bidding') return;
  const r = bid(app.game, HUMAN, score, app.rng);
  if (!r.ok) { app.note = r.reason; refresh(); return; }
  app.note = '';
  app.narrate = '';
  refresh();
  tick();
}

/** 托管叫分：交给当前挡位的 AI 代叫（§5.5）。用的是同一套评分，不存在"另一个规则" */
function onTrustBid() {
  if (!canAct() || app.game.phase !== 'bidding') return;
  const score = decideBid(app.view, app.level, app.rng);
  onBid(score);
}

function onNewGame() {
  if (refs.resultDialog.open) refs.resultDialog.close();
  startGame();
}

function onLevelChange(id) {
  app.level = findLevel(id);
  try { localStorage.setItem(`${STORAGE_KEY}:level`, id); } catch { /* 隐私模式就算了 */ }
}

function onResize() {
  layoutHand(refs);
}

// === 结算 ===

function showResult() {
  if (app.resultShown) return;
  app.resultShown = true;
  const r = app.game.result;
  refs.resultTitle.textContent = r.winner === 'landlord' ? '地主胜' : '农民胜';

  const spring = r.spring === 'none' ? '无'
    : (r.spring === 'spring' ? '春天 ×2' : '反春天 ×2');
  const rows = [
    ['我', app.view.role === 'landlord' ? '地主' : '农民'],
    ['叫分', `${r.bid} 分`],
    ['炸弹 / 王炸', `${r.bombs} 个`],
    ['春天', spring],
    ['本局倍数', `×${r.multiplier}`],
  ];
  refs.resultBody.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    refs.resultBody.appendChild(dt);
    refs.resultBody.appendChild(dd);
  }

  // 记战绩。**标记写在 game.result 上** —— 它跟着存档走，所以
  // "打完一局之后刷新页面"不会把同一局重复计一次。
  if (!r.recorded) {
    r.recorded = true;
    const myTeam = app.view.role === 'landlord' ? 'landlord' : 'farmers';
    recordResult(defaultStorage(), {
      myRole: app.view.role,
      myTeamWon: r.winner === myTeam,
      multiplier: r.multiplier,
    });
    flush(app.game, app.level.id);
  }

  const s = loadStats(defaultStorage());
  refs.resultStats.textContent = `累计 ${s.games} 局 · 胜 ${s.wins} · 当 ${s.landlordGames} 次地主赢 ${s.landlordWins}`
    + ` · 最高倍数 ×${s.bestMultiplier}`;

  refresh();
  refs.resultDialog.showModal();
}

// === 装配 ===
//
// **这些回调必须挂到 `app` 上。** 本模块的其余部分（renderer / interaction）
// *不 import main.js*，它们只认 `app` 上的回调 —— 这是本仓库"状态集中在 app 上、
// 模块之间不互相 import"的做法（与象棋的 main.js 一致）。
//
// 踩过的坑：实现时把回调都写成了模块级的函数声明，忘了挂上 `app`，
// 结果点「提示」报 `app.onHint is not a function`。
// **Node 侧的测试碰不到这条路径**（它们直接调 `js/` 里的纯逻辑，不经过 main.js），
// 是拿真实浏览器点出来的 —— 见 future-work.md 的 E5。
Object.assign(app, {
  onCardClick,
  clearSelection,
  onPlay,
  onPass,
  onHint,
  onBid,
  onTrustBid,
  onNewGame,
  onLevelChange,
  onResize,
});

// === 启动 ===

/**
 * 恢复上一局。读不到 / 校验不过就返回 false，由调用方开新局。
 *
 * **恢复出来的是"整局"**（含三家的手牌），所以不需要 rng ——
 * 状态全在数据里（§4.4 那句"状态是纯 JSON 可序列化的"就是为了这一步）。
 */
function tryRestore() {
  const saved = loadSave(defaultStorage());
  if (!saved) return false;

  app.game = saved.game;
  if (saved.levelId) app.level = findLevel(saved.levelId);
  app.rng = mulberry32(((Math.random() * 0x7fffffff) | 0) || 1);
  app.selected.clear();
  resetHint();
  app.narrate = '';
  app.note = '';
  app.busy = false;
  app.resultShown = false;
  refresh();
  tick();
  return true;
}

function init() {
  for (const lv of LEVELS) {
    const opt = document.createElement('option');
    opt.value = lv.id;
    opt.textContent = lv.name;
    refs.levelSelect.appendChild(opt);
  }

  // 挡位有三个来源，优先级从高到低：存档里的 > 上次手动选的 > 默认。
  // 存档优先是因为"刷新回来接着打"时，用户期待的是那局牌当时的挡位。
  let savedLevel = DEFAULT_LEVEL;
  try { savedLevel = localStorage.getItem(`${STORAGE_KEY}:level`) || DEFAULT_LEVEL; } catch { /* ignore */ }
  app.level = findLevel(savedLevel);

  attachInteraction(refs, app);
  startWorker();

  refs.levelSelect.value = app.level.id;
  if (!tryRestore()) startGame();
  refs.levelSelect.value = app.level.id;

  // 关页面/切走之前把最后一次状态写进去（防抖窗口里可能还没落盘）
  window.addEventListener('beforeunload', () => flush(app.game, app.level.id));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(app.game, app.level.id);
  });

  // 开局就显示一次战绩，免得它只在结算时才出现
  const s = loadStats(defaultStorage());
  if (s.games > 0) app.note = `累计 ${s.games} 局 · 胜 ${s.wins} · 最高倍数 ×${s.bestMultiplier}`;
  refresh();
}

init();
