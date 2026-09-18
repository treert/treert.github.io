/**
 * 入口：状态中枢 + 模块装配 + Worker 通信 + 工具栏绑定。
 *
 * 装配方式照象棋：状态集中在一个 app 对象上，模块之间不互相 import，
 * 统一通过 app 上的回调协作 —— 避免依赖成网。
 *
 * 这里不含任何棋类规则：走子合法性、终局判定、记谱全在 game.js / rules.js / notation.js 里。
 */

import { LEVELS, PROMO_PIECES, P, WHITE, BLACK, START_FEN } from './config.js';
import { rankOf } from './position.js';
import { findKing, isAttacked, moveFrom, moveTo, encodeMove } from './rules.js';
import * as G from './game.js';
import { createRenderer, createPieceSvg } from './renderer.js';
import { attachInteraction } from './interaction.js';
import { PIECE_NAMES } from './notation.js';
import { saveSoon, restoreInto, defaultStorage } from './persist.js';
import { shareUrl, readShareFen } from './share.js';

const dom = {
  board: document.getElementById('board'),
  boardWrap: document.getElementById('board-wrap'),
  status: document.getElementById('status-text'),
  thinking: document.getElementById('thinking'),
  levelSelect: document.getElementById('level-select'),
  sideSelect: document.getElementById('side-select'),
  twoPlayerToggle: document.getElementById('two-player-toggle'),
  moveList: document.getElementById('move-list'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnReset: document.getElementById('btn-reset'),
  btnFlip: document.getElementById('btn-flip'),
  btnHint: document.getElementById('btn-hint'),
  btnCopyFen: document.getElementById('btn-copy-fen'),
  btnCopyUrl: document.getElementById('btn-copy-url'),
  btnCopyMoves: document.getElementById('btn-copy-moves'),
  btnStepBack: document.getElementById('btn-step-back'),
  btnStepFwd: document.getElementById('btn-step-fwd'),
  btnHelp: document.getElementById('btn-help'),
  helpBody: document.getElementById('help-body'),
  endgameGoal: document.getElementById('endgame-goal'),
  // 弹窗（骨架里已经都在，这里只取引用；各自的绑定在后面的 Task 里补）
  picker: document.getElementById('picker'),
  btnOpenPicker: document.getElementById('btn-open-picker'),
  btnClosePicker: document.getElementById('btn-close-picker'),
  pickerFoot: document.getElementById('picker-foot'),
  tabs: document.getElementById('endgame-tabs'),
  endgameSearch: document.getElementById('endgame-search'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  endgameList: document.getElementById('endgame-list'),
  btnExitEndgame: document.getElementById('btn-exit-endgame'),
  ioDialog: document.getElementById('io-dialog'),
  btnOpenIo: document.getElementById('btn-open-io'),
  btnCloseIo: document.getElementById('btn-close-io'),
  ioMsg: document.getElementById('io-msg'),
  customName: document.getElementById('custom-name'),
  fenInput: document.getElementById('fen-input'),
  btnLoadFen: document.getElementById('btn-load-fen'),
  btnImportFen: document.getElementById('btn-import-fen'),
  renameDialog: document.getElementById('rename-dialog'),
  btnCloseRename: document.getElementById('btn-close-rename'),
  renameHint: document.getElementById('rename-hint'),
  renameInput: document.getElementById('rename-input'),
  btnDoRename: document.getElementById('btn-do-rename'),
  renameMsg: document.getElementById('rename-msg'),
  promoDialog: document.getElementById('promo-dialog'),
  btnClosePromo: document.getElementById('btn-close-promo'),
  promoChoices: document.getElementById('promo-choices'),
};

const app = {
  game: G.createGame(),
  renderer: null,
  worker: null,
  searchId: 0,        // 递增的请求 id，用来丢弃过期响应
  pending: null,      // 'ai' | 'hint' —— 当前在飞的那条请求是干什么的
  busy: false,
  selected: -1,
  targets: [],
  hint: 0,
  promo: null,        // 待确认的升变：{ from, to }，null = 没有
  pos: null,
  status: { type: 'playing', winner: null },

  get playerSide() { return this.game.playerSide; },
  get sideToMove() { return G.sideToMove(this.game); },

  canAct() {
    if (this.busy) return false;
    if (this.status.type !== 'playing') return false;
    // 双人对弈：两边都由人点，不按 playerSide 拦
    if (this.game.twoPlayer) return true;
    return this.sideToMove === this.game.playerSide;
  },
  ownerOf(idx) {
    const v = this.pos.cells[idx];
    return v === 0 ? 0 : Math.sign(v);
  },
  isTarget(idx) { return this.targets.includes(idx); },
  cellIndexOf(node) { return this.renderer.cellIndexOf(node); },
  onCellClick(idx) { handleCellClick(idx); },
};

const sideName = (side) => (side === WHITE ? '白方' : '黑方');

/** 当前被将军的王所在格；没有则 -1 */
function checkedKingIdx(pos) {
  const king = findKing(pos.cells, pos.side);
  if (king < 0) return -1;
  return isAttacked(pos.cells, king, -pos.side) ? king : -1;
}

// === 渲染 ===

/** 重绘棋盘 + 刷新面板。animate 传 { from, to }（或数组）时走子有补间 */
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
  // animate：null / { from, to } / [{ from, to }, ...]，见 renderer.js 的 draw()。
  // 走子、悔棋、回看都从这一条路进来，区别只在传不传、传几个 mover。
  if (animate) app.renderer.drawAnimated(app.pos, highlight, animate);
  else app.renderer.draw(app.pos, highlight);

  updateChrome();
}

/**
 * 设置状态栏内容。
 *
 * 参数是「片段」：字符串原样输出，`{ side }` 输出**带颜色的**方名。
 *
 * 为什么不拼字符串 + innerHTML：
 *   1. 拼成字符串之后就没法只给方名着色了（那是这次要做的效果）
 *   2. 状态文案里会混进用户输入（残局名、引擎报错），走 innerHTML 有注入风险
 */
function setStatus(...parts) {
  dom.status.textContent = '';
  for (const p of parts) {
    if (typeof p === 'string') {
      dom.status.appendChild(document.createTextNode(p));
      continue;
    }
    const span = document.createElement('span');
    span.className = p.side === WHITE ? 'chess-status--white' : 'chess-status--black';
    span.textContent = sideName(p.side);
    dom.status.appendChild(span);
  }
}

/**
 * 现在是不是处在一个**临时局面**（代码里叫「自由局面」）上 ——
 * 起始局面既不是标准开局、也不在残局库里。
 *
 * 来源有两个，都**不进库**：点开别人分享的链接，或者在「保存 / 导入」里
 * 粘一段 FEN 直接载入。之所以不另存一个标志位，是为了让**从存档恢复出来的也认得出来** ——
 * 刷新前后表现一致，因为状态只有一个来源：`game.initialFen`。
 */
function isFreePosition() {
  return !G.endgameOf(app.game) && app.game.initialFen !== START_FEN;
}

const OVER_TEXT = {
  checkmate: (st) => ['将死 · ', { side: st.winner }, '胜'],
  stalemate: () => ['逼和 · 和棋'],
  fifty: () => ['50 步 · 和棋'],
  repetition: () => ['三次重复 · 判和'],
  insufficient: () => ['子力不足 · 和棋'],
};

/** 只刷新面板文字与按钮状态，不重绘棋盘 */
function updateChrome() {
  const st = app.status;
  const over = st.type !== 'playing';
  let parts;

  if (over) {
    parts = OVER_TEXT[st.type](st);
  } else {
    const side = G.sideToMove(app.game);
    // 双人对弈时不说「你 / AI」—— 两边都是人，标出来反而误导
    const tail = app.game.twoPlayer
      ? ''
      : `（${side === app.game.playerSide ? '你' : 'AI'}）`;
    parts = ['轮到', { side }, tail];
    if (app.busy && app.pending === 'ai') parts = ['轮到', { side }, ' · AI 思考中'];
    // cursor 为 0 时说「第 0 步」很别扭 —— 那是开局
    if (G.isReviewing(app.game)) {
      const where = app.game.cursor === 0 ? '开局' : `第 ${app.game.cursor} 步`;
      parts = [`正在回看${where} · `, ...parts];
    }
  }

  setStatus(...parts);
  dom.status.classList.toggle('chess-status--over', over);

  // 残局 / 临时局面都要有一行说明「这是什么、走了几步」，也都要能退出去 ——
  // 否则用户会卡在一个不知道从哪来的局面上
  const eg = G.endgameOf(app.game);
  const free = isFreePosition();
  const showStart = !!(eg || free);
  dom.endgameGoal.hidden = !showStart;
  if (eg) {
    const label = eg.result ? `谱载${RESULTS_TEXT[eg.result] || ''}` : '自定义局面';
    dom.endgameGoal.textContent = `「${eg.name}」· ${label} · 已走 ${app.game.cursor} 步`;
  } else if (free) {
    dom.endgameGoal.textContent = `临时局面 · 已走 ${app.game.cursor} 步`;
  }
  dom.btnExitEndgame.hidden = !showStart;
  dom.pickerFoot.hidden = !showStart;

  renderMoveList();
  renderPickerButton();
  updateButtons();
}

const RESULTS_TEXT = { white: '先手胜', black: '先手负', draw: '和棋' };

/**
 * 标题右边那个按钮：**既是局面库的唯一入口，也是「我在哪一局」的指示**。
 *
 * 合并成一个之后，「当前局面」这个信息并没有丢 —— 它变成了按钮的正文。
 */
function renderPickerButton() {
  const eg = G.endgameOf(app.game);
  const free = isFreePosition();

  dom.btnOpenPicker.textContent = '';

  const label = document.createElement('span');
  label.className = 'chess-picker-label';
  label.textContent = '局面库';

  const sep = document.createElement('span');
  sep.className = 'chess-picker-sep';
  sep.textContent = '·';

  const name = document.createElement('b');
  name.textContent = eg ? eg.name : (free ? '临时局面' : '标准开局');

  dom.btnOpenPicker.append(label, sep, name);
  dom.btnOpenPicker.title = eg
    ? `当前：${eg.name}（点击更换）`
    : free
      ? '当前是一个临时局面（点击换成残局）'
      : '点击选择残局，或把当前局面存起来';
}

// === 着法列表 ===

// 上次渲染时的着法总数 / 当前着法元素 / 上次滚动到的游标。
// 三个都是为了让 refresh() 不重复做无谓的工作 —— 见 renderMoveList 的注释。
let renderedMoveCount = -1;
let currentMoveEl = null;
let scrolledCursor = -1;

function renderMoveList() {
  const moves = app.game.moves;
  const cursor = app.game.cursor;

  // 只在「着法列表本身变了」时才重建 DOM。
  // refresh() 在选中棋子、AI 思考状态变化时都会被调到，而那些情况下列表一个字都没变 ——
  // 重建会把列表的滚动位置冲回顶部。
  if (moves.length !== renderedMoveCount) {
    renderedMoveCount = moves.length;
    buildMoveList(moves);
  }

  // 只挪高亮类，不重建。
  if (currentMoveEl) currentMoveEl.classList.remove('chess-move--current');
  currentMoveEl = cursor > 0
    ? dom.moveList.querySelector(`.chess-move[data-ply="${cursor}"]`)
    : null;
  if (currentMoveEl) currentMoveEl.classList.add('chess-move--current');

  // 只在游标真的移动了的时候才滚（选中棋子不改游标，所以不会触发）
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
    p.className = 'chess-empty';
    p.textContent = '还没有走棋';
    dom.moveList.appendChild(p);
    return;
  }

  // 列出**全部**着法（包括游标后面的），这样才能点着法列表往前跳（重做）。
  // 白黑各一列，一行一个回合 —— 和棋谱的写法一致。
  for (let i = 0; i < moves.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'chess-move-row';

    const no = document.createElement('span');
    no.className = 'chess-move-no';
    no.textContent = `${i / 2 + 1}.`;
    row.appendChild(no);

    row.appendChild(moveSpan(i));
    if (moves[i + 1]) row.appendChild(moveSpan(i + 1));
    dom.moveList.appendChild(row);
  }
}

function moveSpan(i) {
  const el = document.createElement('span');
  el.className = 'chess-move';
  el.dataset.ply = String(i + 1);   // renderMoveList 靠它找当前着法
  el.textContent = app.game.moves[i].san;
  el.title = `跳到第 ${i + 1} 步`;
  el.addEventListener('click', () => {
    if (app.game.cursor === i + 1) return; // 已经在这一步
    gotoPlyAnimated(i + 1);
  });
  return el;
}

/**
 * 把当前着法滚进可见区域。
 *
 * **只动着法列表自己的 scrollTop，不用 scrollIntoView** ——
 * scrollIntoView 会把**所有**可滚动祖先一起滚，包括页面本身，
 * 于是点一下棋盘整页都会跟着跳。
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

// 超过这个步数就不做补间：那已经不是「走了一步」，而是「换了个局面」。
// 2 是留给悔棋的 —— 人机模式下它一次退两步（玩家那手 + AI 的应手），
// 那是一个来回，两个子一起滑回去正好读成「把刚才那回合收回来」。
const MAX_ANIMATED_PLIES = 2;

/**
 * 从 fromPly 走到 toPly，哪些棋子该滑过去。返回值直接给 refresh() 当 animate 用，
 * 不需要动画时返回 null。
 *
 * **只给相邻一两步动画。** 跨多步跳转（点第 30 步跳回第 3 步）如果也动画，
 * 要么整盘棋子一起飞、要么得逐步回放等好几秒 —— 两种都看不出「发生了什么」；
 * 单步时「哪个子从哪来、到哪去」是唯一的，滑一下正好帮人看清。
 *
 * 反向（往回想）时 from / to 要**对调**：现在停在落点上的那个子要滑回起点。
 */
function stepAnimation(fromPly, toPly) {
  const step = Math.abs(toPly - fromPly);
  if (step === 0 || step > MAX_ANIMATED_PLIES) return null;

  const forward = toPly > fromPly;
  const lo = Math.min(fromPly, toPly);
  const movers = [];
  for (let p = lo; p < lo + step; p++) {
    const m = app.game.moves[p];
    if (!m) return null; // 越界（理论上到不了），宁可不动画
    movers.push(forward
      ? { from: moveFrom(m.move), to: moveTo(m.move) }
      : { from: moveTo(m.move), to: moveFrom(m.move) });
  }
  return movers;
}

/**
 * 光标挪到第 toPly 步，并把界面刷一遍。
 *
 * 着法列表点击、重做、以及（Task 8 的）着法面板上的「上一步 / 下一步」全走这里 ——
 * 它们是同一件事的多个入口（挪光标），区别只在怎么算出 toPly。
 * 越界由 gotoPly 自己挡掉，所以「上一步」在 0 步、「下一步」在最后一步都不用特判。
 */
function gotoPlyAnimated(toPly) {
  if (app.busy) return;
  const animate = stepAnimation(app.game.cursor, toPly);
  if (!G.gotoPly(app.game, toPly)) return;
  clearSelection();
  app.hint = 0;
  refresh(animate);
  saveSoon(app.game);
}

function updateButtons() {
  const playing = app.status.type === 'playing';
  const two = app.game.twoPlayer;

  dom.btnUndo.disabled = app.busy || !G.canUndo(app.game);
  dom.btnRedo.disabled = app.busy || !G.isReviewing(app.game);
  dom.btnReset.disabled = app.busy;
  dom.btnFlip.disabled = false;
  // 双人对弈时两边都能要提示 —— 它是给「当前走棋的人」用的，不专属某一方
  dom.btnHint.disabled = app.busy || !playing
    || (!two && G.sideToMove(app.game) !== app.game.playerSide);
  // 复制着法跟「轮到谁」「AI 在不在想」都无关 —— 它只读列表。
  // 唯一的门槛是列表里得有东西：一步都没走时复制出来是空串，不如置灰。
  dom.btnCopyMoves.disabled = app.game.moves.length === 0;
  // 回看单步：到两头就灰。busy 时也灰 —— 和工具栏那几个一样，
  // AI 思考（含等补间跑完的那一段）期间不让用户改光标，否则会撞上「AI 落在回看状态上」。
  dom.btnStepBack.disabled = app.busy || app.game.cursor <= 0;
  dom.btnStepFwd.disabled = app.busy || app.game.cursor >= app.game.moves.length;
  dom.levelSelect.disabled = app.busy;
  // 双人模式下「执子」没有意义（两边都是人），禁掉免得让人以为它还有作用。
  // 想让黑方在下方，用「翻转」。
  dom.sideSelect.disabled = app.busy || two;
  dom.twoPlayerToggle.disabled = app.busy;
}

// === 选中与走子 ===

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

/** 这一步是不是「兵走到最后一排」（要走升变浮层问一句） */
function isPromotion(pos, from, to) {
  const piece = pos.cells[from];
  if (piece !== P && piece !== -P) return false; // 只有兵会升变
  const lastRank = piece > 0 ? 7 : 0;
  return rankOf(to) === lastRank;
}

function handleCellClick(idx) {
  if (app.promo) return;          // 升变浮层开着时，棋盘不响应
  if (!app.canAct()) return;

  // 已经选中了棋子，点的又是合法目标 → 走子
  if (app.selected >= 0 && app.targets.includes(idx)) {
    if (isPromotion(app.pos, app.selected, idx)) openPromotion(app.selected, idx);
    else applyMove(encodeMove(app.selected, idx), true);
    return;
  }
  // 再点一次自己 → 保持选中（不做「再点取消」，那样容易误操作）
  if (app.selected === idx) return;
  // 点自己这一方的另一个子 → 改选。
  // **判据是「轮到谁走」，不是 playerSide** —— 双人对弈时两边都得能选子。
  if (app.ownerOf(idx) === G.sideToMove(app.game)) {
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
  const r = G.playMove(app.game, move);
  if (!r.ok) return false;
  const made = r.move;

  clearSelection();
  app.hint = 0;
  refresh(animate ? { from: moveFrom(made), to: moveTo(made) } : null);
  saveSoon(app.game);
  requestAiMove();
  return true;
}

// === 升变选择 ===
//
// **必须在走子之前问**：兵到末排时先弹这一层，选定后才真正落子；
// Esc 取消等于没走。用原生 <dialog>：Esc 关闭、焦点陷阱、背景遮罩都是白送的。

function openPromotion(from, to) {
  app.promo = { from, to };
  const side = Math.sign(app.pos.cells[from]);

  dom.promoChoices.textContent = '';
  PROMO_PIECES.forEach((piece, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chess-promo-btn chess-promo-btn--${side === WHITE ? 'white' : 'black'}`;
    btn.appendChild(createPieceSvg(side * piece));
    const label = document.createElement('span');
    label.textContent = PIECE_NAMES[piece];
    btn.appendChild(label);
    btn.addEventListener('click', () => choosePromotion(piece));
    if (i === 0) btn.dataset.first = '1';
    dom.promoChoices.appendChild(btn);
  });

  if (!dom.promoDialog.open) dom.promoDialog.showModal();
  // 焦点放在第一个（后）—— 绝大多数情况下它就是用户要的那一个
  const first = dom.promoChoices.querySelector('[data-first]');
  if (first) first.focus();
}

function closePromotion() {
  if (dom.promoDialog.open) dom.promoDialog.close();
  app.promo = null;
}

function choosePromotion(piece) {
  const pending = app.promo;
  closePromotion();
  if (!pending) return;
  applyMove(encodeMove(pending.from, pending.to, piece), true);
}

// === Worker ===

/**
 * 派发一次搜索。不是 AI 的回合、或者已经有请求在飞，就直接返回。
 */
function requestAiMove() {
  if (app.busy) return;
  if (app.status.type !== 'playing') return;
  // 双人对弈：不派发。这里是唯一的派发点，所以挡这一处就够 ——
  // 而关掉开关时又需要能立刻把 AI 拉回来接着走，那由下面的判断自然处理。
  if (app.game.twoPlayer) return;
  if (G.sideToMove(app.game) === app.game.playerSide) return;

  // 棋子还在滑就等它滑完再动。不等的话，AI 那一步（引擎常常两百毫秒就回来）
  // 会在玩家的棋子还在半路上时落下来，看着像「没轮到它就动了」。
  // 等待期间**照样占住 busy** —— 不然这 200ms 里用户能点着法列表跳转，
  // 回来 AI 却落在回看状态上，那一步会把后面的分支截掉。
  if (app.renderer.isAnimating()) {
    app.busy = true;
    app.pending = 'ai';
    dom.thinking.hidden = false;
    updateChrome();
    app.renderer.afterAnimation(() => {
      app.busy = false;
      app.pending = null;
      dom.thinking.hidden = true;
      requestAiMove(); // 递归一层：里面会把上面的前置条件重判一遍
    });
    return;
  }

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
    app.hint = msg.move
      ? encodeMove(msg.move.from, msg.move.to, msg.move.promo || 0)
      : 0;
    refresh();
    return;
  }

  if (!msg.move) { refresh(); return; } // 无着法 = 已经终局
  applyMove(encodeMove(msg.move.from, msg.move.to, msg.move.promo || 0), true);
}

/**
 * 提示：让当前挡位的 AI 给一步建议，画在棋盘上。
 *
 * 高亮画在**起点和终点**（见 renderer 的 chess-piece--hint），不真的走子 ——
 * 用户要的是「建议」，不是「帮我把棋走了」。
 */
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

// === 把局面 / 棋谱拿出去 ===
//
// 三个入口，给的东西不同，但都是同一族动作（「出」）：
//   复制 FEN    一段文本，对方自己找地方粘
//   复制链接    一条链接，点开就是同一个局面（Task 9 用 share.js 生成）
//   复制（着法） 棋谱文本，贴进棋谱软件 / 论坛 / 聊天里
//
// 复制成功的提示做在按钮自己身上（文字短暂变成「已复制」）——
// 它们没有弹窗可以显示提示，而工具栏就在棋盘下方、视线落点上。
// 每个按钮各记一个定时器：连点两个按钮时，不会互相把对方的提示提前收掉。
const copyFlashTimers = new WeakMap();

function flashCopied(btn, original) {
  btn.textContent = '已复制';
  clearTimeout(copyFlashTimers.get(btn));
  copyFlashTimers.set(btn, setTimeout(() => { btn.textContent = original; }, 1600));
}

/** 弹窗底部的提示行（几个弹窗共用一套样式，各用各的元素） */
function setMsg(el, text, isError = false) {
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('chess-dialog-msg--error', !!isError);
}

const setIoMsg = (text, isError = false) => setMsg(dom.ioMsg, text, isError);

/**
 * 剪贴板不可用时的退路：把要复制的东西塞进「保存 / 导入」弹窗的文本框，
 * 让人手动复制。
 *
 * 剪贴板 API 要安全上下文（https / localhost），而 `file://` 打开本模块时它就没有
 *（本模块本来也不推荐 file://，但分享链接这类操作很容易在那时候撞上）。
 * 那个框本来是用来粘贴导入的，这里借它当缓冲区 —— 少见路径，不值得为它单独做界面。
 *
 * **顺序不能反**：先填值再开弹窗。Task 11 的 openIo 会把 FEN 框预填成当前局面，
 * 所以它那边必须先 openIo 再填值 —— 两条路径的填值时机是相反的，别合并。
 */
function clipboardFallback(text, label) {
  dom.fenInput.value = text;
  if (!dom.ioDialog.open) dom.ioDialog.showModal();
  setIoMsg(`剪贴板不可用，${label}已填在下面的框里，手动复制即可`);
  dom.fenInput.focus();
  dom.fenInput.select(); // 顺手全选：Ctrl+C 一步就能拿走
}

/** 把当前局面的 FEN 复制到剪贴板。入口在棋盘下方的工具栏 */
async function copyCurrentFen() {
  const fen = G.currentFen(app.game);
  try {
    await navigator.clipboard.writeText(fen);
    flashCopied(dom.btnCopyFen, '复制 FEN');
  } catch {
    clipboardFallback(fen, 'FEN ');
  }
}

/**
 * 复制**分享链接** —— 别人打开链接就能直接看到当前这个局面。
 *
 * 和复制 FEN 的差别只有一个：FEN 要对方自己找地方粘，链接点开就是。
 * 两个按钮并列放着，都是「把当前局面拿出去」，只是拿出去的形式不同。
 */
async function copyShareUrl() {
  const url = shareUrl(G.currentFen(app.game), location.href);
  try {
    await navigator.clipboard.writeText(url);
    flashCopied(dom.btnCopyUrl, '复制链接');
  } catch {
    clipboardFallback(url, '链接');
  }
}

/**
 * 把着法列表拼成一段文本 —— 一行一个回合，「1. e4 e5」。
 *
 * 抄的是**列表里显示的全部着法**（`game.moves`，不是 `moveList()` 那个到游标为止的切片）：
 * 界面上列出来多少就复制多少。回看状态下若只复制到游标，用户会发现自己
 * 「照着屏幕数出来的步数」和复制出来的对不上。
 *
 * 不做列对齐：SAN 长短不一，按字符数补空格在等宽字体里也未必好看，
 * 单空格分隔在各种编辑器里都不会错位。
 */
function movesText() {
  const moves = app.game.moves;
  const lines = [];
  for (let i = 0; i < moves.length; i += 2) {
    const head = `${i / 2 + 1}. ${moves[i].san}`;
    // 奇数步数时最后一回合没有黑方着法，别留个尾空格
    lines.push(moves[i + 1] ? `${head} ${moves[i + 1].san}` : head);
  }
  return lines.join('\n');
}

/**
 * 复制着法列表。入口在「着法」面板标题右边。
 *
 * 它给的是**过程**，FEN 给的是**局面** —— 两者刚好互补，都放在「拿出去」这一族里。
 */
async function copyMoves() {
  const text = movesText();
  if (!text) return; // 没走过棋（按钮本来也是灰的）
  try {
    await navigator.clipboard.writeText(text);
    flashCopied(dom.btnCopyMoves, '复制');
  } catch {
    clipboardFallback(text, '着法');
  }
}

// === 工具栏 ===

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

  dom.twoPlayerToggle.addEventListener('change', () => {
    if (app.busy) return;
    app.game.twoPlayer = dom.twoPlayerToggle.checked;
    app.searchId++; // 作废在飞的响应
    app.hint = 0;
    updateChrome();
    saveSoon(app.game);
    // 两种情况都交给 requestAiMove 自己的前置判断：
    //   刚打开 —— 可能正轮到「AI」那一方，这时不该再派发搜索；
    //   刚关掉 —— 可能正轮到 AI，要把它拉回来接着走。
    requestAiMove();
  });

  dom.btnUndo.addEventListener('click', () => {
    if (app.busy) return;
    // 用 undoToPlayer：只退一步的话，玩家会看到 AI 立刻又走一步，等于「悔棋没生效」
    const before = app.game.cursor;
    if (!G.undoToPlayer(app.game)) return;
    const animate = stepAnimation(before, app.game.cursor);
    clearSelection();
    app.hint = 0;
    refresh(animate);
    saveSoon(app.game);
  });

  // 重做就是「往前走一步」，和着法面板上的「下一步」是同一个动作 ——
  // 区别只在入口：重做是工具栏里的「撤销 / 重做」那一对，另两个是回看用的。
  dom.btnRedo.addEventListener('click', () => gotoPlyAnimated(app.game.cursor + 1));

  // 回看的单步走。**和「悔棋」不是一回事**：悔棋是「退到玩家走」（人机模式一次两步），
  // 想一格一格翻棋谱用这两个。到头的那个由 updateButtons 置灰。
  dom.btnStepBack.addEventListener('click', () => gotoPlyAnimated(app.game.cursor - 1));
  dom.btnStepFwd.addEventListener('click', () => gotoPlyAnimated(app.game.cursor + 1));

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
  dom.btnCopyFen.addEventListener('click', copyCurrentFen);
  dom.btnCopyUrl.addEventListener('click', copyShareUrl);
  dom.btnCopyMoves.addEventListener('click', copyMoves);
}

function bindHelp() {
  // 说明的显隐只认 `hidden` 这一个来源，图标的点亮态只认它自己的 aria-expanded，
  // 不另存一个布尔量 —— 两份状态迟早会不一致。
  const toggle = () => {
    const open = dom.helpBody.hidden;   // hidden 为 true = 现在收着 = 这一次要展开
    dom.helpBody.hidden = !open;
    dom.btnHelp.setAttribute('aria-expanded', String(open));
    dom.btnHelp.title = open ? '收起玩法说明（?）' : '玩法说明（?）';
  };
  dom.btnHelp.addEventListener('click', toggle);
}

/** 任意一个模态弹窗开着 —— 全局快捷键要让路 */
function anyDialogOpen() {
  return dom.picker.open || dom.ioDialog.open || dom.renameDialog.open || dom.promoDialog.open;
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    // 弹窗打开时不响应全局快捷键 —— 否则在里面打字会顺手翻转棋盘、打开说明。
    // Esc 也交给 <dialog> 自己处理（它原生就关弹窗 / 取消升变）。
    if (anyDialogOpen()) return;

    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (e.key === 'Escape') {
      clearSelection();
      refresh();
    } else if (e.key === 'h' || e.key === 'H') {
      requestHint();
    } else if (e.key === 'f' || e.key === 'F') {
      app.renderer.setFlipped(!app.renderer.isFlipped());
    } else if (e.key === '?') {
      dom.btnHelp.click();
    } else if (e.key === 'ArrowLeft') {
      // 单步回看。着法列表上方就有这两个按钮，键盘也走同一条路
      e.preventDefault();
      dom.btnStepBack.click();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      dom.btnStepFwd.click();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      dom.btnUndo.click();
    }
  });
}

/**
 * 链接里带了 `?fen=` 就切到那个局面（别人分享来的）。
 * 返回要报给用户的原因；没有出错就返回空串。
 *
 * **参数无论好坏都要立刻抹掉**：留着的话，之后每一次刷新都会把用户
 * 从「他自己后来选的局面」拽回分享的局面 —— 那看起来很像 bug。
 * 局面本身马上进存档，刷新照样恢复得回来。
 */
function applyShareLink() {
  const r = readShareFen(location.href);
  if (!r.found) return '';

  history.replaceState(null, '', location.pathname);

  if (!r.ok) return r.reason;
  G.startPosition(app.game, r.fen);
  // 立刻存：地址栏里的参数刚被抹掉，存档是刷新后唯一的退路
  saveSoon(app.game);
  return '';
}

// === 装配 ===

function init() {
  app.renderer = createRenderer(dom.board, dom.boardWrap);

  app.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  app.worker.onmessage = onWorkerMessage;

  attachInteraction(dom.board, app);
  bindToolbar();
  bindHelp();
  bindKeyboard();

  // 升变浮层的取消路径：Esc（cancel 事件）与右上角的 ✕ 都等于「没走这一步」
  dom.promoDialog.addEventListener('cancel', (e) => { e.preventDefault(); closePromotion(); });
  dom.btnClosePromo.addEventListener('click', closePromotion);

  // 尝试恢复上次的对局；失败就全新开局（persist.js 内部已经做了容错）
  restoreInto(app.game, defaultStorage());

  // 分享链接**优先于存档**：用户是主动点开这个链接的，不该被上次的对局盖掉。
  // 放在 restoreInto 之后，是为了让挡位、执子方这些偏好仍然沿用本地存档。
  const shareError = applyShareLink();

  dom.sideSelect.value = String(app.game.playerSide);
  dom.levelSelect.value = app.game.level;
  dom.twoPlayerToggle.checked = !!app.game.twoPlayer;
  app.renderer.setFlipped(app.game.playerSide === BLACK); // 执黑默认翻转

  refresh();
  requestAiMove();
  // 必须放在最后：状态栏在 refresh / requestAiMove 里都会被重写，
  // 提前设的话这句话立刻就被盖掉了。
  if (shareError) setStatus(shareError);
}

init();
