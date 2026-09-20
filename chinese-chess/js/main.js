/**
 * 入口：状态中枢 + 模块装配 + Worker 通信 + 工具栏绑定。
 *
 * 装配方式照 conway-life-game：状态集中在一个 app 对象上，
 * 模块之间不互相 import，统一通过 app 上的回调协作 —— 避免依赖成网。
 *
 * 这里不含任何棋类规则：走子合法性、终局判定、记谱全在 game.js / rules.js 里。
 */

import { LEVELS, RED, START_FEN } from './config.js';
import { findKing, isAttacked, moveFrom, moveTo, encodeMove } from './rules.js';
import * as G from './game.js';
import { createRenderer } from './renderer.js';
import { attachInteraction } from './interaction.js';
import { saveSoon, restoreInto, defaultStorage } from './persist.js';
import { RESULTS, endgameTabs, endgamesByCategory, setCustomEndgames } from './endgames.js';
import { loadCustom, addCustom, renameCustom, removeCustom, validateFreeFen, CUSTOM_CATEGORY } from './custom-endgames.js';
import { shareUrl, readShareFen } from './share.js';
import { buildBook, bookMove, lineOf, lineLabel } from './solution-book.js';

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
  // 着法面板右上角的单步回看（回看专用，和工具栏的「悔棋 / 重做」分开）
  btnStepBack: document.getElementById('btn-step-back'),
  btnStepFwd: document.getElementById('btn-step-fwd'),
  // 玩法说明：标题行的问号图标 + 它控制的那块说明（本体在标题行下面）
  btnHelp: document.getElementById('btn-help'),
  helpBody: document.getElementById('help-body'),
  endgameGoal: document.getElementById('endgame-goal'),
  // 局面库弹窗
  // 局面库弹窗（只管挑）
  picker: document.getElementById('picker'),
  btnOpenPicker: document.getElementById('btn-open-picker'),
  btnClosePicker: document.getElementById('btn-close-picker'),
  pickerFoot: document.getElementById('picker-foot'),
  tabs: document.getElementById('endgame-tabs'),
  endgameSearch: document.getElementById('endgame-search'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  endgameList: document.getElementById('endgame-list'),
  btnExitEndgame: document.getElementById('btn-exit-endgame'),
  // 保存 / 导入弹窗（只管往库里加）
  ioDialog: document.getElementById('io-dialog'),
  btnOpenIo: document.getElementById('btn-open-io'),
  btnCloseIo: document.getElementById('btn-close-io'),
  ioMsg: document.getElementById('io-msg'),
  customName: document.getElementById('custom-name'),
  fenInput: document.getElementById('fen-input'),
  btnLoadFen: document.getElementById('btn-load-fen'),
  btnImportFen: document.getElementById('btn-import-fen'),
  // 重命名弹窗（从局面库「自定义」页签里每一行的 ✎ 打开）
  renameDialog: document.getElementById('rename-dialog'),
  btnCloseRename: document.getElementById('btn-close-rename'),
  renameHint: document.getElementById('rename-hint'),
  renameInput: document.getElementById('rename-input'),
  btnDoRename: document.getElementById('btn-do-rename'),
  renameMsg: document.getElementById('rename-msg'),
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
  // 这条提示是**针对哪个局面**算出来的（currentFen 的快照）。
  // 局面一变就对不上，提示自动失效 —— 见 activeHint()。
  hintFen: '',
  // 这一步提示是不是来自谱载解法 —— 只影响状态行文案（要跟「引擎算出来的」分开讲）
  hintFromBook: false,
  pos: null,
  status: { type: 'playing', winner: null },

  get playerSide() { return this.game.playerSide; },

  canAct() {
    if (this.busy) return false;
    if (this.status.type !== 'playing') return false;
    // 双人对弈：两边都由人点，不按 playerSide 拦
    if (this.game.twoPlayer) return true;
    return G.sideToMove(this.game) === this.game.playerSide;
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

/**
 * 当前**有效**的提示着法（编码后的 move，0 = 没有提示）。
 *
 * 提示绑定的是「它被算出来时的那个局面」（hintFen 快照）：局面一变就对不上，
 * 提示自动失效。走子、悔棋、回看跳转、换残局、载入 FEN 全都只改局面，
 * 于是「清提示」不必在每个入口手写一遍 —— 漏掉一个也不会画出过期的建议。
 *
 * 关键：**选中棋子不改变局面**，所以选来选去不会把提示弄没。
 */
function activeHint() {
  return app.hintFen === G.currentFen(app.game) ? app.hint : 0;
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
    hint: activeHint(),
    checked: checkedKingIdx(app.pos),
    // 终局了就没有「轮到谁」可言，0 表示不画外圈
    turn: app.status.type === 'playing' ? G.sideToMove(app.game) : 0,
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
 * 参数是「片段」，三种形式：
 *   '文字'           原样输出
 *   { side }         输出**带颜色的**「红方 / 黑方」
 *   { text, cls }    输出一段指定样式的字（`xq-status--${cls}`）——
 *                    目前只有「将军」用它：它得比后面那句更抢眼，
 *                    而这不是「方名」也不是整行的终局色，只能单给它一个类
 *
 * 为什么不拼字符串 + innerHTML：
 *   1. 拼成字符串之后就没法只给某个片段着色了（那是这几处效果的全部意义）
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
    if (p.side) {
      span.className = p.side === RED ? 'xq-status--red' : 'xq-status--black';
      span.textContent = sideName(p.side);
    } else {
      span.className = `xq-status--${p.cls}`;
      span.textContent = p.text;
    }
    dom.status.appendChild(span);
  }
}

/**
 * 现在是不是处在一个**临时局面**（代码里叫「自由局面」）上 ——
 * 起始局面既不是标准开局、也不在残局库里。
 *
 * 来源有两个，都**不进库**：点开别人分享的链接（`applyShareLink`），
 * 或者在「保存 / 导入」里粘一段 FEN 直接载入（`loadFen`）。
 * 之所以不另存一个标志位，是为了让**从存档恢复出来的也认得出来** ——
 * 刷新前后表现一致，因为状态只有一个来源：`game.initialFen`。
 */
function isFreePosition() {
  return !G.endgameOf(app.game) && app.game.initialFen !== START_FEN;
}

/** 只刷新面板文字与按钮状态，不重绘棋盘 */
function updateChrome() {
  const st = app.status;
  let parts;
  let over = false;

  if (st.type === 'checkmate') { parts = ['将死 · ', { side: st.winner }, '胜']; over = true; }
  else if (st.type === 'stalemate') { parts = ['困毙 · ', { side: st.winner }, '胜']; over = true; }
  // 长将判负：说的是**输的那一方**（连续将军的一方），所以取 winner 的对面
  else if (st.type === 'perpetual-check') {
    parts = ['长将判负 · ', { side: -st.winner }, '负'];
    over = true;
  }
  else if (st.type === 'repetition') { parts = ['三次重复 · 判和']; over = true; }
  else {
    const side = G.sideToMove(app.game);
    // 双人对弈时不说「你 / AI」—— 两边都是人，标出来反而误导
    const tail = app.game.twoPlayer
      ? ''
      : `（${side === app.game.playerSide ? '你' : 'AI'}）`;
    // 被将军的**就是轮到走的那一方**（规则上不允许把自己的将 / 帅留在被吃的位置），
    // 所以「将军」不是另一条信息，而是「轮到谁」这句话的前缀 —— 放在最前面。
    // 棋盘上那个子已经套了一道危险色外圈（renderer 的 xq-piece--checked），这里管文字。
    parts = [];
    if (checkedKingIdx(app.pos) >= 0) parts.push({ text: '将军', cls: 'check' }, ' · ');
    parts.push('轮到', { side }, tail);
    if (app.busy && app.pending === 'ai') parts.push(' · AI 思考中');
    // 提示来自"线"而不是引擎时标出来 —— 两者可信度不同，用户要能分清。
    // 而且「已证明的解法」和「引擎参考线」也要分开：后者前段只是引擎的偏好。
    if (activeHint() && app.hintFromBook) {
      const line = lineOf(app.game.endgameId);
      parts.push(line && line.src === 'walk' ? ' · 引擎参考线（非证明）' : ' · 谱载解法');
    }
    // cursor 为 0 时说「第 0 步」很别扭 —— 那是开局
    if (G.isReviewing(app.game)) {
      const where = app.game.cursor === 0 ? '开局' : `第 ${app.game.cursor} 步`;
      parts = [`正在回看${where} · `, ...parts];
    }
  }
  // 残局模式：给出目标，终局时判定是否达成。
  // 自定义局面没有结论（程序无从知道那个局面的胜负），所以跳过判定 ——
  // 编一个「达成目标」出来比不判定更糟。
  const eg = G.endgameOf(app.game);
  const free = isFreePosition();
  if (eg && eg.result && over) {
    // 「胜」局看先手方有没有赢，「负」局看黑方有没有赢，「和」局看有没有走到判和
    const met = eg.result === 'win' ? st.winner === 1
      : eg.result === 'loss' ? st.winner === -1
        : st.type === 'repetition';
    parts.push(met ? ' · 达成目标' : ' · 未达成目标');
  }

  setStatus(...parts);
  dom.status.classList.toggle('xq-status--over', over);

  // 临时局面（分享链接来的、或者粘 FEN 直接摆上来的）没有元信息，但同样要有一行
  // 说明「这是什么、走了几步」，也**同样要能退出去** ——
  // 否则用户会卡在一个不知道从哪来的局面上。
  const showStart = !!(eg || free);
  dom.endgameGoal.hidden = !showStart;
  if (eg) {
    // 自定义局面没有结论，不要编一个出来
    const label = eg.result ? `谱载${RESULTS[eg.result]}` : '自定义局面';
    // 有线的局把「几步杀 / 几回合」也说清楚 —— 这是这一局最有用的一条信息，
    // 也解释了为什么「提示」会一点就出（它不需要等引擎）
    const line = lineOf(eg.id);
    const tail = line ? ` · ${lineLabel(line)}` : '';
    dom.endgameGoal.textContent = `「${eg.name}」· ${label} · 已走 ${app.game.cursor} 步${tail}`;
  } else if (free) {
    dom.endgameGoal.textContent = `临时局面 · 已走 ${app.game.cursor} 步`;
  }
  // 不在残局里时整条底栏一起隐藏 —— 否则会留一条空的横线
  dom.btnExitEndgame.hidden = !showStart;
  dom.pickerFoot.hidden = !showStart;

  // 弹窗开着的时候局面也可能变（玩家执黑、AI 那一步正好这时候落下来）——
  // 「载入到棋盘」灰不灰要跟着一起刷。弹窗关着就什么都不做，不为它白解析一遍 FEN。
  if (dom.ioDialog.open) syncLoadFenBtn();

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
 * 着法列表点击、重做、着法面板上的「上一步 / 下一步」全走这里 ——
 * 它们是同一件事的四个入口（挪光标），区别只在怎么算出 toPly。
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

function moveSpan(i) {
  const el = document.createElement('span');
  el.className = 'xq-move';
  el.dataset.ply = String(i + 1);   // renderMoveList 靠它找当前着法
  el.textContent = app.game.moves[i].notation;
  el.title = `跳到第 ${i + 1} 步`;
  el.addEventListener('click', () => {
    if (app.game.cursor === i + 1) return; // 已经在这一步
    gotoPlyAnimated(i + 1);
  });
  return el;
}

function updateButtons() {
  const playing = app.status.type === 'playing';
  const two = app.game.twoPlayer;

  dom.btnUndo.disabled = app.busy || !G.canUndo(app.game);
  dom.btnRedo.disabled = app.busy || !G.isReviewing(app.game);
  dom.btnReset.disabled = app.busy;
  dom.btnFlip.disabled = false;
  // 双人对弈时两边都能要提示 —— 它是给「当前走棋的人」用的，不专属某一方。
  // 挡位也照旧可用，因为提示用的就是它。
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
  // 这里**不清提示**：选中只是改 UI 状态、没有动局面，已经给出的建议仍然有效。
  // 提示的失效统一交给 activeHint() 的局面快照判定（走子、悔棋、换局面时才过期）。
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
  // 点自己这一方的另一个子 → 改选。
  // **判据是「轮到谁走」，不是 playerSide** —— 双人对弈时两边都得能选子。
  // 人机模式下 canAct() 已经保证了轮到玩家，两者等价。
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
  const from = moveFrom(move), to = moveTo(move);
  if (!G.playMove(app.game, move).ok) return false;

  clearSelection();
  app.hint = 0;
  refresh(animate ? { from, to } : null);
  saveSoon(app.game);
  requestAiMove();
  return true;
}

// === 可跟着走的线（js/solutions.js + js/prefixes.js + solution-book.js）===
//
// 界面拿一条线做两件事：「提示」优先给线上的着法；**轮到 AI 时也按线应着**
// —— 后者不是可选项：玩家刚走一步、对手就走到线外去了，那条线根本走不完。
//
// **两个来源、两种可信度，措辞必须分开**（这是本节最要紧的一条）：
//   `solutions.js`  `src='mate'`  引擎在**根上**证明了强制杀（`go mate`，对手怎么走都杀）
//                                 → 可以放心跟着走，说「有解法」
//   `prefixes.js`   `src='walk'`  引擎沿自己选的路走到底**能**杀，但**前段没有证明**
//                                 → 说「引擎参考线」。前段只是引擎的偏好：实测第 004 局
//                                   把谱上妙手换成次优着法，Pikafish 只差 0.3~0.8 个兵，
//                                   它分不出「杀网还在」和「只是还大优」，所以**不能叫正解**
// 两个来源都不分「推不推荐」——**都是"可以跟着走"**，区别只在有没有证明这一句。
//
// 走岔了（或这一局没有线）就回退到引擎搜索，行为与从前一致。
// 匹配规则见 solution-book.js：**必须带上「已经走到第几手」，不能只用局面**，
// 因为杀线里重复局面是常态（同一局面要走向不同的着法）。
let bookKey = '';
let book = null;

/** 当前这一局的谱表。按「局 id + 起始局面」缓存，换局才重建（展开一次几十步，本来也不贵） */
function currentBook() {
  const g = app.game;
  const key = `${g.endgameId || ''}@${g.initialFen}`;
  if (key !== bookKey) {
    bookKey = key;
    const line = g.endgameId ? lineOf(g.endgameId) : null;
    book = line ? buildBook(g.initialFen, line.pv) : null;
  }
  return book;
}

/** 眼下这个局面谱上写的是哪一步；0 = 不在谱上（走岔了，或这局没有解法） */
function bookMoveNow() {
  return bookMove(currentBook(), G.currentFen(app.game), app.game.cursor);
}

// === Worker ===

/**
 * 喂给引擎的**对局历史**：当前这条线上的每个局面，含起始局面，最后一个是现状。
 *
 * 引擎自己只能看见搜索树，而「长将」这种循环有一半在搜索树之外 ——
 * AI 上一步将军、这一步再将军，前半个循环是**已经走过的历史**。
 * 不喂历史的话，引擎会以为它随时能收手（在树里确实能），于是一路将军下去，
 * 到第 3 次重复时按长将判负。传 FEN 而不是哈希：主线程不必知道引擎怎么算哈希，
 * 两边只约定「局面」这一件事。
 *
 * 回看（cursor 在后面）时给的是到 cursor 为止的那条线 —— 与界面上正在下的这盘一致。
 */
function historyFens() {
  const out = [app.game.initialFen];
  for (let i = 0; i < app.game.cursor; i++) out.push(app.game.moves[i].fenAfter);
  return out;
}

/**
 * 派发一次 AI 搜索。不是 AI 的回合、或者已经有请求在飞，就直接返回。
 */
function requestAiMove() {
  if (app.busy) return;
  if (app.status.type !== 'playing') return;
  // 双人对弈：不派发。这里是唯一的派发点，所以挡这一处就够 ——
  // 而关掉开关时又需要能立刻把 AI 拉回来接着走，那由下面的判断自然处理。
  if (app.game.twoPlayer) return;
  if (G.sideToMove(app.game) === app.game.playerSide) return;

  // 棋子还在滑就等它滑完再动。不等的话，AI 那一步（谱载解法是**同步**落的，
  // 引擎也常常两百毫秒就回来）会在玩家的棋子还在半路上时落下来，
  // 看着像「没轮到它就动了」。等待期间**照样占住 busy** —— 不然这 200ms 里
  // 用户能点着法列表跳转，回来 AI 却落在回看状态上，那一步会把后面的分支截掉。
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

  // 谱上优先：这一步按谱走。同步落子、没有搜索等待，所以不进 busy 状态
  //（状态行也就不会闪一下「AI 思考中」）。
  const fromBook = bookMoveNow();
  if (fromBook) {
    applyMove(fromBook, true);
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
    history: historyFens(),
  });
}

function requestHint() {
  if (!app.canAct()) return;

  // 谱上优先：直接给谱载着法，不必派发搜索 —— 也省掉最长 1.5 秒的等待。
  // 状态行会标明「谱载解法」，用户要能分清这是棋谱上的正解、还是引擎的建议。
  const fromBook = bookMoveNow();
  if (fromBook) {
    app.hint = fromBook;
    app.hintFen = G.currentFen(app.game);
    app.hintFromBook = true;
    refresh();
    return;
  }

  app.hintFromBook = false;
  app.busy = true;
  app.pending = 'hint';
  dom.thinking.hidden = false;
  updateChrome();

  app.worker.postMessage({
    type: 'search',
    id: ++app.searchId,
    fen: G.currentFen(app.game),
    level: app.game.level,
    history: historyFens(),
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
    app.hintFen = G.currentFen(app.game);
    refresh();
    return;
  }

  if (!msg.move) { refresh(); return; } // 无着法 = 已经终局
  applyMove(encodeMove(msg.move.from, msg.move.to), true);
}

// === 局面库（残局 + 自定义局面） ===

// 当前页签。没有「全部」这一页 —— 页签名与列表内容都来自 endgames.js 的页签表，
// 所以这里只存一个 id，默认停在第一页。
let endgameFilter = endgameTabs()[0].id;

// 列表的过滤词。raw 原样留着（回显与空态文案要原话），words 是切好、转小写的关键词。
//
// **过滤只在当前页签内生效**，不跨页签搜 —— 页签是「分类」，跨页签搜会让
// 页签和列表各说各话。跨页签的线索改由**页签徽标**提供：有过滤词时徽标显示各页的命中数，
// 所以「搜的词其实在隔壁那一页」一眼就能看出来（见 countByCategory）。
//
// 过滤词不跨「打开弹窗」这个动作活着：closePicker 会把它清掉。
let endgameQuery = { raw: '', words: [] };

// 自定义局面在内存里的副本。它是 endgames.js 注册表的来源 ——
// 每次增删后重新读一遍 localStorage 并重新注册，其它地方（game.js / persist.js）
// 就完全不需要知道「自定义」这回事。
let customList = [];

// 上次渲染列表用的签名（当前选中哪一局 + 自定义有几条 + 哪个页签 + 过滤词）。
// 避免每次 refresh 都重建几百个按钮、把用户滚动的位置冲掉。
let renderedListKey = '\u0000';

function refreshCustom() {
  customList = loadCustom(storage);
  setCustomEndgames(customList);
}

// === 分类页签 ===
//
// 原来是下拉框。下拉框把「内置残局」和「自定义局面」混在同一个列表里，
// 看不出边界；换成页签之后两者是并列的、随时能切。
//
// **页签表在 endgames.js 里（endgameTabs()）**，加一页只改那边 ——
// 这里只把表渲染成 DOM，不写死任何分类名，也就没有「界面和数据两边漏改」这回事。

/** 当前页签的定义（取它的空态提示之类） */
function tabOf(id) {
  return endgameTabs().find((t) => t.id === id);
}

// === 列表过滤 ===
//
// 内置库从 15 局收成《适情雅趣》全谱 551 局之后，滚动列表就不好使了，所以加一道过滤。
// （551 局现在拆在「杀局」「和局」两个页签下，这条过滤的用途没变。）
//
// **只匹配名字。** 名字是列表上唯一显示的文本，也是唯一同时带着局号与局名的地方
// （「第473局 中外义安」），所以「473」「中外」「473 中外」都能命中。
// 不去匹配 FEN 这类看不见的字段 —— 命中了用户也不知道为什么（「这行为什么会在这儿？」）。
//
// 空白分隔的多个词是「与」：全都要出现在名字里。所以「473 中外」能进一步收窄。

/** 一局的名字是否命中当前过滤词 */
function matchesQuery(name) {
  const n = name.toLowerCase();
  return endgameQuery.words.every((w) => n.includes(w));
}

/** 某一页命中过滤词的条数 —— 页签徽标与空态文案都用它 */
function matchCount(tab) {
  return tab.entries.filter((e) => matchesQuery(e.name)).length;
}

/**
 * 每个页签有几条 —— 徽标用。
 *
 * **有过滤词时显示的是「这一页命中几条」**，不是总条数。这不是装饰：
 * 过滤只在当前页签内生效，光看列表的话「搜「473」却一条都没有」看起来就是坏了；
 * 徽标跟着变，等于在说「你要找的东西在那一页」。
 * 自定义那一页会随增删变，所以每次都现数。
 */
function countByCategory() {
  const counts = {};
  for (const tab of endgameTabs()) counts[tab.id] = matchCount(tab);
  return counts;
}

/**
 * 清掉过滤词。
 *
 * `rebuild = false` 是给 closePicker 用的：那条路径上清完就要关弹窗，
 * 再重建一次几百行的列表纯属白费（还会让关弹窗掉一帧）。列表反正下次打开会强制重建。
 */
function clearQuery(rebuild = true) {
  endgameQuery = { raw: '', words: [] };
  dom.endgameSearch.value = '';
  dom.btnClearSearch.hidden = true;
  if (!rebuild) return;
  syncTabs();
  syncEndgameList();
}

/** 输入框内容变了 —— 重建列表，并让页签徽标跟着变成各页的命中数 */
function setQuery(raw) {
  if (raw === endgameQuery.raw) return;
  endgameQuery = { raw, words: raw.trim().toLowerCase().split(/\s+/).filter(Boolean) };
  dom.btnClearSearch.hidden = endgameQuery.words.length === 0;
  syncTabs();
  syncEndgameList();
}

/** 建页签。只在初始化时调一次，之后靠 syncTabs 更新选中态和条数 */
function renderTabs() {
  dom.tabs.textContent = '';

  for (const { id, label } of endgameTabs()) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'xq-tab';
    tab.dataset.filter = id;
    tab.setAttribute('role', 'tab');
    tab.textContent = label;

    const count = document.createElement('span');
    count.className = 'xq-tab-count';
    tab.appendChild(count);

    tab.addEventListener('click', () => setFilter(id));
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

/**
 * 「这一局有可跟着走的线」——列表行里那枚小徽标；没有线时返回 null。
 *
 * 徽标分两种（`src`）：
 *   `mate` → 「有解法」：引擎在根上证明了强制杀
 *   `walk` → 「参考线」：引擎走到底能杀 / 或只是一段引擎首选前缀，**前段未经证明**
 *
 * 为什么非要标在**列表**上：库里 396 局有已证明的解法、还有一批只有参考线、剩下的两样都没有，
 * 这三类在「提示」上的表现完全不同 —— 有线的局一点就出着法（不派发搜索），
 * 没线的局要等引擎现算、还有可能算不出合适的着法。光看局名分不出来，
 * 得点进去、再点一次提示才知道，那就太晚了。
 *
 * 徽标只写两个字，**具体步数放进 title**：列表宽度得留给局名（最长的那些局名本来就在
 * 省略号上了），而步数是点进去之后更该看的细节 —— 棋盘上方那行给的才是完整版。
 */
function solutionBadge(eg) {
  const line = lineOf(eg.id);
  if (!line) return null;

  const span = document.createElement('span');
  span.className = 'xq-endgame-sol';
  // 两种来源在列表上也得看得出区别：**「有解法」是已证明的，「参考线」不是**。
  // 措辞不同比配色不同重要 —— 用户可以忽略颜色，但会读字。
  span.textContent = line.src === 'walk' ? '参考线' : '有解法';
  span.title = line.src === 'walk'
    ? `${lineLabel(line)}（「提示」会给线上的着法，AI 也按线应着；走岔了回退引擎搜索）`
    : `谱载解法：红方 ${line.mate} 步杀（「提示」直接给正解，AI 也按谱应着）`;
  if (line.src === 'walk') span.classList.add('xq-endgame-sol--ref');
  return span;
}

function endgameTooltip(eg) {
  if (eg.custom) {
    return `${eg.name}（自定义局面）\n没有结论 —— 程序无从知道你存这个局面时的胜负`;
  }
  const line = lineOf(eg.id);
  return `${eg.name}（谱载${RESULTS[eg.result]}）\n出处：${eg.source}`
    + (line && line.src === 'mate' ? `\n有已证明的解法：红方 ${line.mate} 步杀` : '')
    + (line && line.src === 'walk'
      ? `\n引擎参考线：${lineLabel(line)}\n（前段只是引擎的偏好，不是证明；走岔了回退引擎搜索）`
      : '')
    + (eg.note ? `\n${eg.note}` : '');
}

/**
 * 列表空着时说什么。
 *
 * 两种情况必须分开讲，否则「搜了半天一条都没有」会被当成坏了：
 *   这一页本来就是空的（比如还没存过自定义局面）→ 用页签自己的 empty 文案
 *   这一页有东西、只是没命中过滤词 → 说清是过滤词没命中，并指出去哪一页找
 */
function emptyListText(tab, total) {
  if (total === 0) return (tab && tab.empty) || '这个分类下还没有局面。';

  const others = endgameTabs()
    .filter((t) => t.id !== endgameFilter)
    .map((t) => ({ label: t.label, n: matchCount(t) }))
    .filter((t) => t.n > 0);

  const tail = others.length
    ? `（${others.map((t) => `${t.label} ${t.n} 条`).join('、')}，点上面的页签切过去）`
    : '换个词试试，或者点右边「✕」清空。';
  return `这一页没有匹配「${endgameQuery.raw}」的局面。${tail}`;
}

function renderEndgameList() {
  dom.endgameList.textContent = '';

  // 先按页签取数据（它顺带补上 category），再按过滤词筛
  const all = endgamesByCategory(endgameFilter);
  const list = endgameQuery.words.length
    ? all.filter((eg) => matchesQuery(eg.name))
    : all;

  if (list.length === 0) {
    const p = document.createElement('p');
    p.className = 'xq-empty';
    p.textContent = emptyListText(tabOf(endgameFilter), all.length);
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

    btn.append(name);
    // 「有解法」徽标夹在局名和难度之间 —— 行右端那一串是「这一局的元信息」，
    // 它属于那一串（没有解法时整块不出现，不给没有解法的局也占一个空位）
    const badge = solutionBadge(eg);
    if (badge) btn.appendChild(badge);
    btn.appendChild(meta);
    btn.title = endgameTooltip(eg);
    // 记下 id：改完名字列表要整块重建，靠它才能在重建之后把焦点找回来（见 doRename）
    btn.dataset.egId = eg.id;
    btn.addEventListener('click', () => loadEndgame(eg.id));
    row.appendChild(btn);

    // 只有自定义局面能改名 / 删 —— 静态残局库是代码里的数据，改了删了下次刷新又回来。
    // 顺序是先 ✎ 后 ✕：破坏性的那个永远放最右边
    if (eg.custom) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'xq-endgame-edit';
      edit.textContent = '✎';
      edit.title = `给「${eg.name}」改个名字`;
      edit.setAttribute('aria-label', `重命名 ${eg.name}`);
      edit.addEventListener('click', () => openRename(eg));
      row.appendChild(edit);

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

/** 列表内容取决于四件事：选中的是哪一局、自定义有几条、当前在哪个页签、过滤词是什么 */
function listKey() {
  return `${app.game.endgameId || ''}:${customList.length}:${endgameFilter}:${endgameQuery.raw}`;
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

// === 给自定义局面改名 ===

/** 正在改名的那一条的 id。弹窗关掉就清空 */
let renameTarget = null;

/**
 * 打开重命名弹窗。
 *
 * `eg` 是**列表里那一份**（`endgamesByCategory` 造出来的副本），只拿来预填和显示旧名字。
 * 真正落盘时靠 id 重新在库里找 —— 这份副本在弹窗开着的时候可能已经过期
 * （另一个标签页把它删了），所以 `renameCustom` 找不到 id 时是返回失败而不是抛错。
 */
function openRename(eg) {
  renameTarget = eg.id;
  setMsg(dom.renameMsg, '');
  dom.renameHint.textContent = `只改名字，局面本身不动。原名：「${eg.name}」。`;
  dom.renameInput.value = eg.name;
  if (!dom.renameDialog.open) dom.renameDialog.showModal();
  dom.renameInput.focus();
  dom.renameInput.select(); // 选中整个旧名字：想全换掉就直接打，不用先 Ctrl+A
}

function closeRename() {
  if (dom.renameDialog.open) dom.renameDialog.close();
  renameTarget = null;
}

function doRename() {
  if (!renameTarget) return;
  const id = renameTarget; // closeRename 会把它清掉，先留住

  const r = renameCustom(storage, id, dom.renameInput.value);
  if (!r.ok) {
    setMsg(dom.renameMsg, r.reason, true);
    return;
  }

  refreshCustom();

  // **必须强制重建。** `listKey()` 只看「选中哪一局 / 自定义几条 / 哪个页签 / 过滤词」，
  // 改名这四个一个都没动 —— 不强制的话 `syncEndgameList` 直接 return，
  // 列表上还挂着旧名字（看起来像「点了保存没反应」）。
  renderedListKey = '\u0000';
  // 有过滤词时，改名会改变各页的命中数（搜「旧名字」改成别的就没了）
  syncTabs();
  // 用 updateChrome 而不是 renderPickerButton：**名字显示在三个地方** ——
  // 列表、标题行、还有棋盘上方那行目标（「「旧名字」· 自定义局面 · 已走 0 步」）。
  // 只更新标题行的话，目标行会一直挂着旧名字。
  // 它内部会把列表和标题行一起更新；棋盘不用重绘（局面根本没变）。
  updateChrome();
  closeRename();

  // **重建把刚才那个 ✎ 连 DOM 一起换掉了。** 原生 dialog 关闭时想把焦点还给它，
  // 找不到人就只能落到 `<body>`（实测如此）—— 键盘用户会被丢回弹窗开头。
  // 所以自己接上：焦点放到改名后的那一行，接着就能继续操作列表。
  // 若此刻正被过滤词挡着，这一行根本不在列表里，`btn` 为 null，什么都不做。
  const row = dom.endgameList.querySelector(`[data-eg-id="${id}"]`);
  if (row) row.focus();
}

function bindRename() {
  dom.btnCloseRename.addEventListener('click', closeRename);
  dom.btnDoRename.addEventListener('click', doRename);

  // 点遮罩关闭，同另外两个弹窗
  dom.renameDialog.addEventListener('click', (e) => {
    if (e.target === dom.renameDialog) closeRename();
  });

  // 在名字框里按回车直接保存
  dom.renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doRename();
    }
  });
}

// === 玩法说明（标题行的问号图标） ===

/**
 * 展开 / 收起玩法说明。
 *
 * 说明的显隐只认 `hidden` 这一个来源，图标的点亮态只认它自己的 `aria-expanded`，
 * 不另存一个布尔量 —— 两份状态迟早会不一致。
 *
 * 为什么不继续用 `<details>`：入口要从标题下面那行文字挪进标题行，而
 * `<summary>` 只能待在 `<details>` 内部，挪出去它就不再是那个开关了
 * （键盘的 `?` 也会跟着失效）。「按钮 + aria-expanded」是等价的折叠写法，
 * 位置自由，键盘和读屏的语义也没丢。
 */
function toggleHelp() {
  const open = dom.helpBody.hidden;   // hidden 为 true = 现在收着 = 这一次要展开
  dom.helpBody.hidden = !open;
  dom.btnHelp.setAttribute('aria-expanded', String(open));
  dom.btnHelp.title = open ? '收起玩法说明（?）' : '玩法说明（?）';
}

function bindHelp() {
  dom.btnHelp.addEventListener('click', toggleHelp);
}

// === 弹窗 ===
//
// 两个弹窗，职责分开：
//   局面库（picker）   只管「挑」—— 页签 + 列表 + 退出残局
//   保存 / 导入（io）  只管「FEN 框里那个局面放哪儿」—— 收进局面库 / 直接载入棋盘
//
// 分家的理由：这几件事的方向不一样。「挑」是读；弹窗里那几个是「进」——
// 存进库里（要留下来反复练）或者摆到棋盘上（只是看看、接着下）；
// 而「复制 FEN / 复制链接」是「出」，而且是个即时动作（和悔棋 / 翻转同类），
// 连弹窗都不要，直接做成棋盘下方工具栏上的按钮（见 copyCurrentFen）。

/** 任意一个模态弹窗开着 —— 全局快捷键要让路 */
function anyDialogOpen() {
  return dom.picker.open || dom.ioDialog.open || dom.renameDialog.open;
}

/** 弹窗底部的提示行。两个弹窗共用一套样式，各用各的元素 */
function setMsg(el, text, isError = false) {
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('xq-dialog-msg--error', !!isError);
}

function setIoMsg(text, isError = false) {
  setMsg(dom.ioMsg, text, isError);
}

function openPicker() {
  // 正在某一局里 → 页签先切到它所在的那一页。没有「全部」页签之后，
  // 不切的话「高亮的那一行」会藏在别的页签里，一眼看不出自己在哪。
  const eg = G.endgameOf(app.game);
  if (eg && tabOf(eg.category)) endgameFilter = eg.category;

  // 强制重建：自定义局面可能刚在「保存 / 导入」那边加过或删过
  renderedListKey = '\u0000';
  syncTabs();
  syncEndgameList();
  if (!dom.picker.open) dom.picker.showModal();
}

function closePicker() {
  if (!dom.picker.open) return;

  // 过滤词不跨「打开弹窗」这个动作活着：下次打开局面库应该看到完整的一页，
  // 而不是上次搜剩下的三行 —— 那看起来就像库里少了东西。
  // 只清状态、**不重建列表**：openPicker 反正会强制重建，这里再建几百行是白费。
  clearQuery(false);
  renderedListKey = '\u0000';
  dom.picker.close();
}

/**
 * FEN 框里那个局面是不是**就是当前局面** —— 是的话「载入到棋盘」等于什么都没做，置灰。
 *
 * 比较用**规范化之后**的 FEN（`validateFreeFen` 顺带做了）：从别处复制来的 FEN
 * 尾部那几个字段可能写成 `w - - 12 34`，直接比字符串会判成「不一样」，
 * 其实载入进去是同一个局面。
 *
 * **解析不了的 FEN 不禁用** —— 那时候点一下会给出「哪里不合法」，
 * 禁掉的话按钮就是个不会说话的坏按钮，用户不知道哪儿错了。
 */
function syncLoadFenBtn() {
  const v = validateFreeFen(dom.fenInput.value);
  const same = v.ok && v.fen === G.currentFen(app.game);
  dom.btnLoadFen.disabled = same;
  dom.btnLoadFen.title = same ? '框里就是当前局面，不用载入' : '';
}

function openIo() {
  setIoMsg('');
  dom.customName.value = '';
  // **打开时 FEN 框里就是当前局面。** 于是「存当前这盘棋」和「存别处的局面」变成同一件事：
  // 不动它就是当前局面，改掉它就是别处的。界面上也就只剩一个「存为自定义局面」。
  dom.fenInput.value = G.currentFen(app.game);
  syncLoadFenBtn(); // 刚填进去的，所以「载入到棋盘」这时候是灰的
  if (!dom.ioDialog.open) dom.ioDialog.showModal();
  // 聚焦 + **全选**：下一步多半是粘一段自己的 FEN 覆盖掉，
  // 全选之后 Ctrl+V 一步就完成，不用先 Ctrl+A。
  dom.fenInput.focus();
  dom.fenInput.select();
}

function closeIo() {
  if (dom.ioDialog.open) dom.ioDialog.close();
}

/**
 * 存 / 导入成功后的统一收尾。
 *
 * 和拆分前不同：现在**看不到列表变化了**（列表在另一个弹窗里，此刻没开），
 * 所以把页签预先切到「自定义」—— 用户下一步多半就是打开局面库去点它。
 * 提示文案也把「去哪找」说清楚。
 */
function afterCustomChanged(entry, prefix) {
  refreshCustom();
  dom.customName.value = '';
  endgameFilter = CUSTOM_CATEGORY;
  renderedListKey = '\u0000';
  syncTabs();
  syncEndgameList();
  renderPickerButton();
  setIoMsg(`${prefix}「${entry.name}」，在局面库的「自定义」页签里`);
}

/**
 * 「存为自定义局面」—— 收进局面库。
 *
 * 局面来自 FEN 框，而那个框打开时就是当前局面（见 openIo），
 * 所以「存当前这盘棋」和「存粘进来的局面」走的是同一条路，不再各有一个按钮。
 */
function importFen() {
  const text = dom.fenInput.value.trim();
  if (!text) {
    setIoMsg('FEN 是空的 —— 先粘一段进来', true);
    return;
  }
  const r = addCustom(storage, {
    name: dom.customName.value.trim() || '我的局面',
    fen: text,
  });
  if (!r.ok) {
    setIoMsg(r.reason, true);
    return;
  }
  dom.fenInput.value = '';
  afterCustomChanged(r.entry, '已存为');
}

/**
 * 把粘进来的 FEN **直接摆到棋盘上** —— 一个「临时局面」，不写进自定义库。
 *
 * 和 `importFen` 共用同一个输入框，校验过了再选去处。它俩的准入标准**故意不同**：
 *
 *   载入到棋盘   `validateFreeFen` —— 只看局面成不成立
 *   存为自定义   `validateEndgameFen` —— 还要有练习价值（已经终局的别存）
 *
 * 所以一个已经将死的局面：摆上去看看完全合理，存下来则没意义。
 * 分享链接那一侧用的也是「只看成不成立」这个标准（见 share.js）。
 */
function loadFen() {
  if (app.busy) return; // AI 在想的时候换局面会打架

  const text = dom.fenInput.value.trim();
  if (!text) {
    setIoMsg('先把 FEN 粘到下面的框里', true);
    return;
  }

  const r = validateFreeFen(text);
  if (!r.ok) {
    setIoMsg(r.reason, true);
    return;
  }

  app.searchId++; // 作废在飞的响应
  G.startPosition(app.game, r.fen);
  clearSelection();
  app.hint = 0;
  dom.fenInput.value = '';
  refresh();
  saveSoon(app.game);
  closeIo();
  requestAiMove(); // 摆上去的局面可能轮到 AI 走（比如黑先而玩家执红）
}

// 复制成功的提示做在按钮自己身上（文字短暂变成「已复制」）——
// 它们没有弹窗可以显示提示，而工具栏就在棋盘下方、视线落点上。
// 每个按钮各记一个定时器：连点两个按钮时，不会互相把对方的提示提前收掉。
const copyFlashTimers = new WeakMap();

function flashCopied(btn, original) {
  btn.textContent = '已复制';
  clearTimeout(copyFlashTimers.get(btn));
  copyFlashTimers.set(btn, setTimeout(() => { btn.textContent = original; }, 1600));
}

/**
 * 剪贴板不可用时的退路：把要复制的东西塞进「保存 / 导入」弹窗的文本框，
 * 让人手动复制。
 *
 * 剪贴板 API 要安全上下文（https / localhost）。那个框本来是用来粘贴导入的，
 * 这里借它当缓冲区 —— 少见路径，不值得为它单独做界面。
 */
function clipboardFallback(text, label) {
  // **顺序不能反**：openIo 会把 FEN 框预填成当前局面，先填值再开就被它盖掉了。
  openIo();
  dom.fenInput.value = text;
  dom.fenInput.select(); // 顺手全选：Ctrl+C 一步就能拿走
  setIoMsg(`剪贴板不可用，${label}已填在下面的框里，手动复制即可`);
}

/**
 * 把当前局面的 FEN 复制到剪贴板。入口在棋盘下方的工具栏。
 *
 * 它是「对当前局面的即时动作」，和悔棋 / 翻转同类，所以**不需要弹窗** ——
 * 一点就复制，反馈直接给在按钮上。
 */
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
 * 把着法列表拼成一段文本 —— 一行一个回合，「1. 红着 黑着」。
 *
 * 抄的是**列表里显示的全部着法**（`game.moves`，不是 `moveList()` 那个到游标为止的切片）：
 * 界面上列出来多少就复制多少。回看状态下若只复制到游标，用户会发现自己
 * 「照着屏幕数出来的步数」和复制出来的对不上。
 *
 * 不做列对齐：汉字和阿拉伯数字混排时按字符数补空格对不齐（等宽字体里汉字占两格），
 * 单空格分隔在各种编辑器里都不会错位。
 */
function movesText() {
  const moves = app.game.moves;
  const lines = [];
  for (let i = 0; i < moves.length; i += 2) {
    const head = `${i / 2 + 1}. ${moves[i].notation}`;
    // 奇数步数时最后一回合没有黑方着法，别留个尾空格
    lines.push(moves[i + 1] ? `${head} ${moves[i + 1].notation}` : head);
  }
  return lines.join('\n');
}

/**
 * 复制着法列表。入口在「着法」面板标题右边。
 *
 * 和「复制 FEN / 复制链接」是同一族的「把东西拿出去」，只是拿出去的是**棋谱文本**：
 * 贴进棋谱软件、论坛帖子里都比 FEN 好读 —— FEN 给的是局面，它给的是过程。
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

/**
 * 标题右边那个按钮：**既是局面库的唯一入口，也是「我在哪一局」的指示**。
 *
 * 原先入口有两个（这个按钮 + 标题下面一行可点的「当前局面」文本），视觉上重复。
 * 合并成一个之后，「当前局面」这个信息并没有丢 —— 它变成了按钮的正文。
 */
function renderPickerButton() {
  const eg = G.endgameOf(app.game);
  const free = isFreePosition();

  dom.btnOpenPicker.textContent = '';

  const label = document.createElement('span');
  label.className = 'xq-picker-label';
  label.textContent = '局面库';

  const sep = document.createElement('span');
  sep.className = 'xq-picker-sep';
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

function bindPicker() {
  dom.btnOpenPicker.addEventListener('click', openPicker);
  dom.btnClosePicker.addEventListener('click', closePicker);

  // 点遮罩关闭。<dialog> 自身铺满整个遮罩区域，所以「target 就是 dialog」
  // 说明点在了内容之外 —— 这是原生 dialog 的惯用做法。
  dom.picker.addEventListener('click', (e) => {
    if (e.target === dom.picker) closePicker();
  });

  // 过滤框：边打边筛。551 局重建一次是几十毫秒级的事（一次几百个 DOM 节点），
  // 不值得为它上防抖 —— 防抖反而会让「打完字列表还没跟上」这种小事变得可感知。
  dom.endgameSearch.addEventListener('input', () => setQuery(dom.endgameSearch.value));

  dom.btnClearSearch.addEventListener('click', () => {
    clearQuery();
    dom.endgameSearch.focus();
  });

  // Esc 的两级含义：先清过滤词，清完再按才关弹窗。
  //
  // **必须在 dialog 的 cancel 事件上拦，不是在输入框的 keydown 上** ——
  // 「按 Esc 关弹窗」是 <dialog> 自己处理原生行为，不是 keydown 冒泡上去的，
  // 在输入框里 stopPropagation() 拦不住它。cancel 才是官方的可拦截点。
  dom.picker.addEventListener('cancel', (e) => {
    if (!endgameQuery.words.length) return; // 框里本来就是空的 → 放行，正常关闭
    e.preventDefault();
    clearQuery();
  });
}

function bindIo() {
  dom.btnOpenIo.addEventListener('click', openIo);
  dom.btnCloseIo.addEventListener('click', closeIo);
  dom.btnLoadFen.addEventListener('click', loadFen);
  dom.btnImportFen.addEventListener('click', importFen);

  // 框里改一个字就重新判一次「和当前局面是不是同一个」（决定「载入到棋盘」灰不灰）
  dom.fenInput.addEventListener('input', syncLoadFenBtn);

  dom.ioDialog.addEventListener('click', (e) => {
    if (e.target === dom.ioDialog) closeIo();
  });

  // 在名字框里按回车直接存（和点「存为自定义局面」等价）
  dom.customName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      importFen();
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
  bindEndgames();
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    // 弹窗打开时不响应全局快捷键 —— 否则在里面打字会顺手翻转棋盘、打开说明。
    // Esc 也交给 <dialog> 自己处理（它原生就关弹窗）。
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
      toggleHelp();
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
  bindIo();
  bindRename();
  bindHelp();
  bindKeyboard();

  // 尝试恢复上次的对局；失败就全新开局（persist.js 内部已经做了容错）
  restoreInto(app.game);

  // 分享链接**优先于存档**：用户是主动点开这个链接的，不该被上次的对局盖掉。
  // 放在 restoreInto 之后，是为了让挡位、执子方这些偏好仍然沿用本地存档。
  const shareError = applyShareLink();

  dom.sideSelect.value = String(app.game.playerSide);
  dom.levelSelect.value = app.game.level;
  dom.twoPlayerToggle.checked = !!app.game.twoPlayer;
  app.renderer.setFlipped(app.game.playerSide === -1); // 执黑默认翻转

  refresh();
  requestAiMove();
  // 必须放在最后：状态栏在 refresh / requestAiMove 里都会被重写，
  // 提前设的话这句话立刻就被盖掉了。
  if (shareError) setStatus(shareError);
}

init();
