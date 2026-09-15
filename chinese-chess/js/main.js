/**
 * 入口：状态中枢 + 模块装配 + Worker 通信 + 工具栏绑定。
 *
 * 装配方式照 conway-life-game：状态集中在一个 app 对象上，
 * 模块之间不互相 import，统一通过 app 上的回调协作 —— 避免依赖成网。
 *
 * 这里不含任何棋类规则：走子合法性、终局判定、记谱全在 game.js / rules.js 里。
 */

import { LEVELS, RED } from './config.js';
import { findKing, isAttacked, moveFrom, moveTo, encodeMove } from './rules.js';
import * as G from './game.js';
import { createRenderer } from './renderer.js';
import { attachInteraction } from './interaction.js';
import { saveSoon, restoreInto } from './persist.js';
import { CATEGORIES, RESULTS, endgamesByCategory } from './endgames.js';

const dom = {
  board: document.getElementById('board'),
  boardWrap: document.getElementById('board-wrap'),
  status: document.getElementById('status-text'),
  thinking: document.getElementById('thinking'),
  levelSelect: document.getElementById('level-select'),
  sideSelect: document.getElementById('side-select'),
  moveList: document.getElementById('move-list'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnReset: document.getElementById('btn-reset'),
  btnFlip: document.getElementById('btn-flip'),
  btnHint: document.getElementById('btn-hint'),
  help: document.getElementById('page-help'),
  endgameCategory: document.getElementById('endgame-category'),
  endgameList: document.getElementById('endgame-list'),
  btnExitEndgame: document.getElementById('btn-exit-endgame'),
  endgameGoal: document.getElementById('endgame-goal'),
};

const app = {
  game: G.createGame(),
  renderer: null,
  worker: null,
  searchId: 0,          // 递增的请求 id，用来丢弃过期响应
  pending: null,        // 'ai' | 'hint' —— 当前在飞的那条请求是干什么的
  busy: false,
  selected: -1,
  targets: [],
  hint: 0,
  pos: null,
  status: { type: 'playing', winner: null },

  get playerSide() { return this.game.playerSide; },

  canAct() {
    return !this.busy
      && this.status.type === 'playing'
      && G.sideToMove(this.game) === this.game.playerSide;
  },
  ownerOf(idx) {
    const v = this.pos.cells[idx];
    return v === 0 ? 0 : Math.sign(v);
  },
  isTarget(idx) { return this.targets.includes(idx); },
  cellIndexOf(node) { return this.renderer.cellIndexOf(node); },
  onCellClick(idx) { handleCellClick(idx); },
};

const sideName = (side) => (side === RED ? '红方' : '黑方');

/** 当前被将军的将 / 帅所在格；没有则 -1 */
function checkedKingIdx(pos) {
  const king = findKing(pos.cells, pos.side);
  if (king < 0) return -1;
  return isAttacked(pos.cells, king, -pos.side) ? king : -1;
}

// === 渲染 ===

/** 重绘棋盘 + 刷新面板。animate 传 { from, to } 时走子有补间动画 */
function refresh(animate = null) {
  app.pos = G.currentPosition(app.game);
  app.status = G.evaluateStatus(app.game);

  const highlight = {
    last: G.lastMove(app.game),
    targets: app.targets,
    selected: app.selected,
    hint: app.hint,
    checked: checkedKingIdx(app.pos),
  };
  if (animate) app.renderer.drawAnimated(app.pos, highlight, animate.from, animate.to);
  else app.renderer.draw(app.pos, highlight);

  updateChrome();
}

/** 只刷新面板文字与按钮状态，不重绘棋盘 */
function updateChrome() {
  const st = app.status;
  let text;
  let over = false;

  if (st.type === 'checkmate') { text = `将死 · ${sideName(st.winner)}胜`; over = true; }
  else if (st.type === 'stalemate') { text = `困毙 · ${sideName(st.winner)}胜`; over = true; }
  else if (st.type === 'repetition') { text = '三次重复 · 判和'; over = true; }
  else {
    const side = G.sideToMove(app.game);
    const who = side === app.game.playerSide ? '你' : 'AI';
    text = `轮到${sideName(side)}（${who}）`;
    if (app.busy && app.pending === 'ai') text = `轮到${sideName(side)} · AI 思考中`;
    // cursor 为 0 时说「第 0 步」很别扭 —— 那是开局
    if (G.isReviewing(app.game)) {
      const where = app.game.cursor === 0 ? '开局' : `第 ${app.game.cursor} 步`;
      text = `正在回看${where} · ${text}`;
    }
  }
  // 残局模式：给出目标，终局时判定是否达成
  const eg = G.endgameOf(app.game);
  if (eg && over) {
    // 「胜」局看先手方有没有赢；「和」局看有没有走到判和
    const met = eg.result === 'win' ? st.winner === 1 : st.type === 'repetition';
    text += met ? ' · 达成目标' : ' · 未达成目标';
  }

  dom.status.textContent = text;
  dom.status.classList.toggle('xq-status--over', over);

  dom.endgameGoal.hidden = !eg;
  if (eg) {
    dom.endgameGoal.textContent =
      `残局「${eg.name}」· 谱载${RESULTS[eg.result]} · 已走 ${app.game.cursor} 步`;
  }
  dom.btnExitEndgame.hidden = !eg;

  renderMoveList();
  syncEndgameList();
  updateButtons();
}

function renderMoveList() {
  dom.moveList.textContent = '';
  const all = app.game.moves;

  if (all.length === 0) {
    const p = document.createElement('p');
    p.className = 'xq-move-empty';
    p.textContent = '还没有走棋';
    dom.moveList.appendChild(p);
    return;
  }

  // 列出**全部**着法（包括游标后面的），这样才能点着法列表往前跳（重做）。
  // 当前这一步用高亮标出来。
  for (let i = 0; i < all.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'xq-move-row';

    const no = document.createElement('span');
    no.className = 'xq-move-no';
    no.textContent = `${i / 2 + 1}.`;
    row.appendChild(no);

    row.appendChild(moveSpan(i));
    if (all[i + 1]) row.appendChild(moveSpan(i + 1));
    dom.moveList.appendChild(row);
  }

  const current = dom.moveList.querySelector('.xq-move--current');
  if (current) current.scrollIntoView({ block: 'nearest' });
}

function moveSpan(i) {
  const el = document.createElement('span');
  el.className = 'xq-move';
  if (app.game.cursor === i + 1) el.classList.add('xq-move--current');
  el.textContent = app.game.moves[i].notation;
  el.title = `跳到第 ${i + 1} 步`;
  el.addEventListener('click', () => {
    if (app.busy) return;
    if (app.game.cursor === i + 1) return; // 已经在这一步
    G.gotoPly(app.game, i + 1);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
  });
  return el;
}

function updateButtons() {
  const playing = app.status.type === 'playing';
  dom.btnUndo.disabled = app.busy || !G.canUndo(app.game);
  dom.btnRedo.disabled = app.busy || !G.isReviewing(app.game);
  dom.btnReset.disabled = app.busy;
  dom.btnFlip.disabled = false;
  dom.btnHint.disabled = app.busy || !playing
    || G.sideToMove(app.game) !== app.game.playerSide;
  dom.levelSelect.disabled = app.busy;
  dom.sideSelect.disabled = app.busy;
}

// === 走子 ===

function clearSelection() {
  app.selected = -1;
  app.targets = [];
}

function selectCell(idx) {
  app.selected = idx;
  app.targets = G.legalMoves(app.game)
    .filter((m) => moveFrom(m) === idx)
    .map(moveTo);
  app.hint = 0;
  refresh();
}

function handleCellClick(idx) {
  if (!app.canAct()) return;

  // 已经选中了棋子，点的又是合法目标 → 走子
  if (app.selected >= 0 && app.targets.includes(idx)) {
    applyMove(encodeMove(app.selected, idx), true);
    return;
  }
  // 再点一次自己 → 保持选中（不做「再点取消」，那样容易误操作）
  if (app.selected === idx) return;
  // 点自己的另一个子 → 改选
  if (app.ownerOf(idx) === app.game.playerSide) {
    selectCell(idx);
    return;
  }
  // 点空位或对方的子 → 取消选中
  clearSelection();
  refresh();
}

/**
 * 走一步棋。玩家的着法和 AI 的着法走同一条路径 ——
 * 这样「记谱、存档、派发下一次搜索」只会有一份逻辑。
 */
function applyMove(move, animate) {
  const from = moveFrom(move), to = moveTo(move);
  if (!G.playMove(app.game, move).ok) return false;

  clearSelection();
  app.hint = 0;
  refresh(animate ? { from, to } : null);
  saveSoon(app.game);
  requestAiMove();
  return true;
}

// === Worker ===

/**
 * 派发一次 AI 搜索。不是 AI 的回合、或者已经有请求在飞，就直接返回。
 */
function requestAiMove() {
  if (app.busy) return;
  if (app.status.type !== 'playing') return;
  if (G.sideToMove(app.game) === app.game.playerSide) return;

  app.busy = true;
  app.pending = 'ai';
  dom.thinking.hidden = false;
  updateChrome();

  app.worker.postMessage({
    type: 'search',
    id: ++app.searchId,
    fen: G.currentFen(app.game),
    level: app.game.level,
  });
}

function requestHint() {
  if (!app.canAct()) return;

  app.busy = true;
  app.pending = 'hint';
  dom.thinking.hidden = false;
  updateChrome();

  app.worker.postMessage({
    type: 'search',
    id: ++app.searchId,
    fen: G.currentFen(app.game),
    level: app.game.level,
  });
}

function onWorkerMessage(e) {
  const msg = e.data;

  // 过期响应：用户可能在 AI 思考期间悔棋、重开或换了挡位，
  // 这时候回来的着法已经不该走了。递增的 searchId 就是用来丢弃它们的。
  if (msg.id !== app.searchId) return;

  // 先把「这条响应是干什么的」记下来再清空 —— 反过来写的话下面永远判断不到 'hint'
  const kind = app.pending;
  app.busy = false;
  app.pending = null;
  dom.thinking.hidden = true;

  if (msg.type === 'error') {
    dom.status.textContent = `引擎出错：${msg.message}`;
    updateChrome();
    return;
  }

  if (kind === 'hint') {
    app.hint = msg.move ? encodeMove(msg.move.from, msg.move.to) : 0;
    refresh();
    return;
  }

  if (!msg.move) { refresh(); return; } // 无着法 = 已经终局
  applyMove(encodeMove(msg.move.from, msg.move.to), true);
}

// === 残局 ===

let endgameFilter = 'all';
// 记住上次按哪个 endgameId 渲染过列表，避免每次 refresh 都重建 23 个按钮、丢掉滚动位置
let renderedEndgameId = '\u0000';

function renderEndgameList() {
  dom.endgameList.textContent = '';
  for (const eg of endgamesByCategory(endgameFilter)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xq-endgame';
    if (app.game.endgameId === eg.id) btn.classList.add('xq-endgame--current');

    const name = document.createElement('span');
    name.className = 'xq-endgame-name';
    name.textContent = eg.name;

    const meta = document.createElement('span');
    meta.className = 'xq-endgame-meta';
    meta.textContent = `${RESULTS[eg.result]}·难度${eg.difficulty}`;

    btn.append(name, meta);
    btn.title = `${eg.name}（谱载${RESULTS[eg.result]}）\n出处：${eg.source}`
      + (eg.note ? `\n${eg.note}` : '');
    btn.addEventListener('click', () => loadEndgame(eg.id));
    dom.endgameList.appendChild(btn);
  }
}

/** 只在选中的残局变了时才重建列表 */
function syncEndgameList() {
  const id = app.game.endgameId || '';
  if (id === renderedEndgameId) return;
  renderedEndgameId = id;
  renderEndgameList();
}

function loadEndgame(id) {
  if (app.busy) return;
  app.searchId++; // 作废在飞的响应
  if (!G.startEndgame(app.game, id)) return;
  clearSelection();
  app.hint = 0;
  refresh();
  saveSoon(app.game);
  requestAiMove(); // 残局都是红先，玩家执黑时 AI 先走
}

function bindEndgames() {
  const opt = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  };
  dom.endgameCategory.appendChild(opt('all', '全部'));
  for (const [key, label] of Object.entries(CATEGORIES)) {
    dom.endgameCategory.appendChild(opt(key, label));
  }
  dom.endgameCategory.value = endgameFilter;
  dom.endgameCategory.addEventListener('change', () => {
    endgameFilter = dom.endgameCategory.value;
    renderEndgameList();
  });

  dom.btnExitEndgame.addEventListener('click', () => {
    if (app.busy) return;
    app.searchId++;
    G.exitEndgame(app.game);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
  });
}

// === 装配 ===

function bindToolbar() {
  for (const lv of LEVELS) {
    const opt = document.createElement('option');
    opt.value = lv.id;
    opt.textContent = lv.name;
    dom.levelSelect.appendChild(opt);
  }
  dom.levelSelect.value = app.game.level;
  dom.levelSelect.addEventListener('change', () => {
    app.game.level = dom.levelSelect.value;
    saveSoon(app.game);
  });

  dom.sideSelect.value = String(app.game.playerSide);
  dom.sideSelect.addEventListener('change', () => {
    if (app.busy) return;
    app.game.playerSide = Number(dom.sideSelect.value);
    app.searchId++; // 作废在飞的响应
    G.reset(app.game);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
    requestAiMove(); // 执黑时 AI 先走
  });

  dom.btnUndo.addEventListener('click', () => {
    if (app.busy) return;
    // 用 undoToPlayer：只退一步的话，玩家会看到 AI 立刻又走一步，等于「悔棋没生效」
    if (!G.undoToPlayer(app.game)) return;
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
  });

  dom.btnRedo.addEventListener('click', () => {
    if (app.busy) return;
    if (!G.gotoPly(app.game, app.game.cursor + 1)) return;
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
  });

  dom.btnReset.addEventListener('click', () => {
    if (app.busy) return;
    app.searchId++;
    G.reset(app.game);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
    requestAiMove();
  });

  dom.btnFlip.addEventListener('click', () => {
    app.renderer.setFlipped(!app.renderer.isFlipped());
  });

  dom.btnHint.addEventListener('click', requestHint);
  bindEndgames();
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (e.key === 'Escape') {
      clearSelection();
      refresh();
    } else if (e.key === 'h' || e.key === 'H') {
      requestHint();
    } else if (e.key === 'f' || e.key === 'F') {
      app.renderer.setFlipped(!app.renderer.isFlipped());
    } else if (e.key === '?' ) {
      dom.help.open = !dom.help.open;
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      dom.btnUndo.click();
    }
  });
}

function init() {
  app.renderer = createRenderer(dom.board, dom.boardWrap);

  app.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  app.worker.onmessage = onWorkerMessage;

  attachInteraction(dom.board, app);
  bindToolbar();
  bindKeyboard();

  // 尝试恢复上次的对局；失败就全新开局（persist.js 内部已经做了容错）
  restoreInto(app.game);

  dom.sideSelect.value = String(app.game.playerSide);
  dom.levelSelect.value = app.game.level;
  app.renderer.setFlipped(app.game.playerSide === -1); // 执黑默认翻转

  refresh();
  requestAiMove();
}

init();
