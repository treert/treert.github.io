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
import { saveSoon, restoreInto, defaultStorage } from './persist.js';
import { CATEGORIES, RESULTS, endgamesByCategory, setCustomEndgames } from './endgames.js';
import { loadCustom, addCustom, removeCustom } from './custom-endgames.js';

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
  endgameGoal: document.getElementById('endgame-goal'),
  // 局面库弹窗
  picker: document.getElementById('picker'),
  btnOpenPicker: document.getElementById('btn-open-picker'),
  btnClosePicker: document.getElementById('btn-close-picker'),
  tabs: document.getElementById('endgame-tabs'),
  endgameList: document.getElementById('endgame-list'),
  btnExitEndgame: document.getElementById('btn-exit-endgame'),
  customName: document.getElementById('custom-name'),
  btnSaveCurrent: document.getElementById('btn-save-current'),
  fenInput: document.getElementById('fen-input'),
  btnImportFen: document.getElementById('btn-import-fen'),
  btnExportFen: document.getElementById('btn-export-fen'),
  pickerMsg: document.getElementById('picker-msg'),
};

// localStorage 只取一次。拿不到（隐私模式）时自定义局面存不了，
// 但静态残局库和对弈本身不受影响 —— 降级而不是报错。
const storage = defaultStorage();

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
  // 残局模式：给出目标，终局时判定是否达成。
  // 自定义局面没有结论（程序无从知道那个局面的胜负），所以跳过判定 ——
  // 编一个「达成目标」出来比不判定更糟。
  const eg = G.endgameOf(app.game);
  if (eg && eg.result && over) {
    // 「胜」局看先手方有没有赢；「和」局看有没有走到判和
    const met = eg.result === 'win' ? st.winner === 1 : st.type === 'repetition';
    text += met ? ' · 达成目标' : ' · 未达成目标';
  }

  dom.status.textContent = text;
  dom.status.classList.toggle('xq-status--over', over);

  dom.endgameGoal.hidden = !eg;
  if (eg) {
    // 自定义局面没有结论，不要编一个出来
    const label = eg.result ? `谱载${RESULTS[eg.result]}` : '自定义局面';
    dom.endgameGoal.textContent = `「${eg.name}」· ${label} · 已走 ${app.game.cursor} 步`;
  }
  dom.btnExitEndgame.hidden = !eg;

  renderMoveList();
  syncEndgameList();
  renderPickerButton();
  updateButtons();
}

// 上次渲染时的着法总数 / 当前着法元素 / 上次滚动到的游标。
// 三个都是为了让 refresh() 不重复做无谓的工作 —— 见 renderMoveList 的注释。
let renderedMoveCount = -1;
let currentMoveEl = null;
let scrolledCursor = -1;

function renderMoveList() {
  const moves = app.game.moves;
  const cursor = app.game.cursor;

  // 只在「着法列表本身变了」时才重建 DOM。
  // refresh() 在选中棋子、显示提示、AI 思考状态变化时都会被调到，
  // 而那些情况下列表一个字都没变 —— 重建会把列表的滚动位置冲回顶部，
  // 也会白白丢掉所有 span。（syncEndgameList 用的是同一个思路。）
  if (moves.length !== renderedMoveCount) {
    renderedMoveCount = moves.length;
    buildMoveList(moves);
  }

  // 只挪高亮类，不重建。
  if (currentMoveEl) currentMoveEl.classList.remove('xq-move--current');
  currentMoveEl = cursor > 0
    ? dom.moveList.querySelector(`.xq-move[data-ply="${cursor}"]`)
    : null;
  if (currentMoveEl) currentMoveEl.classList.add('xq-move--current');

  // 只在游标真的移动了的时候才滚。
  // **选中棋子不改游标**，所以不会触发 —— 这正是「点一下棋子、列表就跳到底部」的来源。
  if (cursor !== scrolledCursor) {
    scrolledCursor = cursor;
    scrollCurrentIntoView();
  }
}

function buildMoveList(moves) {
  dom.moveList.textContent = '';
  currentMoveEl = null;

  if (moves.length === 0) {
    const p = document.createElement('p');
    p.className = 'xq-empty';
    p.textContent = '还没有走棋';
    dom.moveList.appendChild(p);
    return;
  }

  // 列出**全部**着法（包括游标后面的），这样才能点着法列表往前跳（重做）。
  // 当前这一步的高亮由 renderMoveList 统一处理，这里不打。
  for (let i = 0; i < moves.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'xq-move-row';

    const no = document.createElement('span');
    no.className = 'xq-move-no';
    no.textContent = `${i / 2 + 1}.`;
    row.appendChild(no);

    row.appendChild(moveSpan(i));
    if (moves[i + 1]) row.appendChild(moveSpan(i + 1));
    dom.moveList.appendChild(row);
  }
}

/**
 * 把当前着法滚进可见区域。
 *
 * **只动着法列表自己的 scrollTop，不用 scrollIntoView** ——
 * scrollIntoView 会把**所有**可滚动祖先一起滚，包括页面本身，
 * 于是点一下棋盘整页都会跟着跳。
 *
 * 用 getBoundingClientRect 而不是 offsetTop：列表没有 position: relative，
 * offsetTop 的参照物不确定，rect 则永远是视口坐标，不会算错。
 */
function scrollCurrentIntoView() {
  if (!currentMoveEl) return;

  const listRect = dom.moveList.getBoundingClientRect();
  const elRect = currentMoveEl.getBoundingClientRect();

  if (elRect.top < listRect.top) {
    dom.moveList.scrollTop -= listRect.top - elRect.top;
  } else if (elRect.bottom > listRect.bottom) {
    dom.moveList.scrollTop += elRect.bottom - listRect.bottom;
  }
}

function moveSpan(i) {
  const el = document.createElement('span');
  el.className = 'xq-move';
  el.dataset.ply = String(i + 1);   // renderMoveList 靠它找当前着法
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

// === 局面库（残局 + 自定义局面） ===

let endgameFilter = 'all';
// 自定义局面在内存里的副本。它是 endgames.js 注册表的来源 ——
// 每次增删后重新读一遍 localStorage 并重新注册，其它地方（game.js / persist.js）
// 就完全不需要知道「自定义」这回事。
let customList = [];

// 上次渲染列表用的签名（当前选中哪一局 + 自定义有几条）。
// 避免每次 refresh 都重建几十个按钮、把用户滚动的位置冲掉。
let renderedListKey = '\u0000';

function refreshCustom() {
  customList = loadCustom(storage);
  setCustomEndgames(customList);
}

// === 分类页签 ===
//
// 原来是下拉框。下拉框把「内置残局」和「自定义局面」混在同一个列表里，
// 看不出边界；换成页签之后两者是并列的、随时能切。

/** 每个分类有几条 —— 页签上的徽标用 */
function countByCategory() {
  const counts = { all: 0 };
  for (const eg of endgamesByCategory('all')) {
    counts.all++;
    counts[eg.category] = (counts[eg.category] || 0) + 1;
  }
  return counts;
}

/** 建页签。只在初始化时调一次，之后靠 syncTabs 更新选中态和条数 */
function renderTabs() {
  dom.tabs.textContent = '';

  // 「全部」不是 CATEGORIES 里的分类，但它是最常用的入口，单独放第一个
  const items = [['all', '全部'], ...Object.entries(CATEGORIES)];
  for (const [key, label] of items) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'xq-tab';
    tab.dataset.filter = key;
    tab.setAttribute('role', 'tab');
    tab.textContent = label;

    const count = document.createElement('span');
    count.className = 'xq-tab-count';
    tab.appendChild(count);

    tab.addEventListener('click', () => setFilter(key));
    dom.tabs.appendChild(tab);
  }
  syncTabs();
}

/**
 * 更新页签的选中态与条数。
 *
 * 用 **roving tabindex**（只有选中的那个 `tabIndex = 0`）——
 * 这是 ARIA tabs 的标准做法：Tab 键整组跳过，组内用左右方向键切换（见 bindTabs）。
 * 好处是「弹窗里要按几次 Tab 才能到列表」不会随页签数量增长。
 */
function syncTabs() {
  const counts = countByCategory();
  for (const tab of dom.tabs.children) {
    const key = tab.dataset.filter;
    const on = key === endgameFilter;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const badge = tab.querySelector('.xq-tab-count');
    if (badge) badge.textContent = String(counts[key] || 0);
  }
}

function setFilter(key) {
  if (endgameFilter === key) return;
  endgameFilter = key;
  syncTabs();
  syncEndgameList();
}

function bindTabs() {
  dom.tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...dom.tabs.children];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : tabs.length - 1;
    const next = tabs[(i + step) % tabs.length];
    next.focus();
    setFilter(next.dataset.filter);
  });
}

/** 一局在列表里显示的元信息。自定义局面没有结论和难度 */
function endgameMeta(eg) {
  return eg.custom ? '自定义' : `${RESULTS[eg.result]}·难度${eg.difficulty}`;
}

function endgameTooltip(eg) {
  if (eg.custom) {
    return `${eg.name}（自定义局面）\n没有结论 —— 程序无从知道你存这个局面时的胜负`;
  }
  return `${eg.name}（谱载${RESULTS[eg.result]}）\n出处：${eg.source}`
    + (eg.note ? `\n${eg.note}` : '');
}

function renderEndgameList() {
  dom.endgameList.textContent = '';

  const list = endgamesByCategory(endgameFilter);
  if (list.length === 0) {
    const p = document.createElement('p');
    p.className = 'xq-empty';
    p.textContent = endgameFilter === 'custom'
      ? '还没有自定义局面。把当前下到一半的棋存一个，或者粘一段 FEN 进来。'
      : '这个分类下还没有局面。';
    dom.endgameList.appendChild(p);
    return;
  }

  for (const eg of list) {
    const row = document.createElement('div');
    row.className = 'xq-endgame-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xq-endgame';
    if (app.game.endgameId === eg.id) btn.classList.add('xq-endgame--current');

    const name = document.createElement('span');
    name.className = 'xq-endgame-name';
    name.textContent = eg.name;

    const meta = document.createElement('span');
    meta.className = 'xq-endgame-meta';
    meta.textContent = endgameMeta(eg);

    btn.append(name, meta);
    btn.title = endgameTooltip(eg);
    btn.addEventListener('click', () => loadEndgame(eg.id));
    row.appendChild(btn);

    // 只有自定义局面能删 —— 静态残局库是代码里的数据，删了下次刷新又回来
    if (eg.custom) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'xq-endgame-del';
      del.textContent = '✕';
      del.title = `删除「${eg.name}」`;
      del.setAttribute('aria-label', `删除 ${eg.name}`);
      del.addEventListener('click', () => deleteCustom(eg));
      row.appendChild(del);
    }

    dom.endgameList.appendChild(row);
  }
}

/** 列表内容取决于三件事：选中的是哪一局、自定义有几条、当前在哪个页签 */
function listKey() {
  return `${app.game.endgameId || ''}:${customList.length}:${endgameFilter}`;
}

/** 只在列表内容真的可能变了时才重建 */
function syncEndgameList() {
  const key = listKey();
  if (key === renderedListKey) return;
  renderedListKey = key;
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
  closePicker();
  requestAiMove(); // 残局都是红先，玩家执黑时 AI 先走
}

function deleteCustom(eg) {
  if (!window.confirm(`删除自定义局面「${eg.name}」？`)) return;

  removeCustom(storage, eg.id);
  refreshCustom();

  if (app.game.endgameId === eg.id) {
    // 删掉的正是当前这一局 —— 不退回标准开局的话，
    // 会停在一个查不到元信息的局面上（标题行、目标提示都会变空）
    app.searchId++;
    G.exitEndgame(app.game);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
  } else {
    renderedListKey = '\u0000';
    syncTabs();
    syncEndgameList();
    renderPickerButton();
  }
}

// === 弹窗 ===

function setPickerMsg(text, isError = false) {
  dom.pickerMsg.hidden = !text;
  dom.pickerMsg.textContent = text || '';
  dom.pickerMsg.classList.toggle('xq-picker-msg--error', !!isError);
}

function openPicker() {
  setPickerMsg('');
  dom.customName.value = '';
  dom.fenInput.value = '';
  // 强制重建：自定义局面可能在别处被删过
  renderedListKey = '\u0000';
  syncTabs();
  syncEndgameList();
  if (!dom.picker.open) dom.picker.showModal();
}

function closePicker() {
  if (dom.picker.open) dom.picker.close();
}

/** 存完之后统一收尾：切到「自定义」页签，让用户立刻看到结果 */
function afterCustomChanged(entry, prefix) {
  refreshCustom();
  dom.customName.value = '';
  endgameFilter = 'custom';
  renderedListKey = '\u0000';
  syncTabs();
  syncEndgameList();
  renderPickerButton();
  setPickerMsg(`${prefix}「${entry.name}」，点它就能开始`);
}

function saveCurrentAsCustom() {
  const r = addCustom(storage, {
    name: dom.customName.value,
    fen: G.currentFen(app.game),
  });
  if (!r.ok) {
    setPickerMsg(r.reason, true);
    return;
  }
  afterCustomChanged(r.entry, '已存为');
}

function importFen() {
  const text = dom.fenInput.value.trim();
  if (!text) {
    setPickerMsg('先把 FEN 粘到下面的框里', true);
    return;
  }
  const r = addCustom(storage, {
    name: dom.customName.value.trim() || '粘贴的局面',
    fen: text,
  });
  if (!r.ok) {
    setPickerMsg(r.reason, true);
    return;
  }
  dom.fenInput.value = '';
  afterCustomChanged(r.entry, '已导入并存为');
}

async function exportCurrentFen() {
  const fen = G.currentFen(app.game);
  dom.fenInput.value = fen;
  try {
    await navigator.clipboard.writeText(fen);
    setPickerMsg('当前局面的 FEN 已复制，也填在下面的框里了');
  } catch {
    // 剪贴板要安全上下文（https / localhost），拿不到就退化成「已填好，你手动复制」
    setPickerMsg('当前局面的 FEN 已填在下面的框里，手动复制即可');
  }
}

/**
 * 标题右边那个按钮：**既是局面库的唯一入口，也是「我在哪一局」的指示**。
 *
 * 原先入口有两个（这个按钮 + 标题下面一行可点的「当前局面」文本），视觉上重复。
 * 合并成一个之后，「当前局面」这个信息并没有丢 —— 它变成了按钮的正文。
 */
function renderPickerButton() {
  const eg = G.endgameOf(app.game);

  dom.btnOpenPicker.textContent = '';

  const label = document.createElement('span');
  label.className = 'xq-picker-label';
  label.textContent = '局面库';

  const sep = document.createElement('span');
  sep.className = 'xq-picker-sep';
  sep.textContent = '·';

  const name = document.createElement('b');
  name.textContent = eg ? eg.name : '标准开局';

  dom.btnOpenPicker.append(label, sep, name);
  dom.btnOpenPicker.title = eg
    ? `当前：${eg.name}（点击更换）`
    : '点击选择残局，或把当前局面存起来';
}

function bindPicker() {
  dom.btnOpenPicker.addEventListener('click', openPicker);
  dom.btnClosePicker.addEventListener('click', closePicker);
  dom.btnSaveCurrent.addEventListener('click', saveCurrentAsCustom);
  dom.btnImportFen.addEventListener('click', importFen);
  dom.btnExportFen.addEventListener('click', exportCurrentFen);

  // 点遮罩关闭。<dialog> 自身铺满整个遮罩区域，所以「target 就是 dialog」
  // 说明点在了内容之外 —— 这是原生 dialog 的惯用做法。
  dom.picker.addEventListener('click', (e) => {
    if (e.target === dom.picker) closePicker();
  });

  dom.customName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrentAsCustom();
    }
  });
}

function bindEndgames() {
  renderTabs();
  bindTabs();

  dom.btnExitEndgame.addEventListener('click', () => {
    if (app.busy) return;
    app.searchId++;
    G.exitEndgame(app.game);
    clearSelection();
    app.hint = 0;
    refresh();
    saveSoon(app.game);
    closePicker();
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
    // 弹窗打开时不响应全局快捷键 —— 否则在里面打字会顺手翻转棋盘、打开说明。
    // Esc 也交给 <dialog> 自己处理（它原生就关弹窗）。
    if (dom.picker.open) return;

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

  // **必须在 restoreInto 之前**：恢复出来的 endgameId 可能指向一个自定义局面，
  // 注册表还没灌的话 endgameOf 查不到，标题行和目标提示就都是空的。
  refreshCustom();

  attachInteraction(dom.board, app);
  bindToolbar();
  bindPicker();
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
