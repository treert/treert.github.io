import { CONFIG } from './config.js';
import { Board } from './board.js';
import { Renderer } from './renderer.js';
import { getPattern, transformCells, classicPatterns, normalizeCells, extractCells } from './patterns.js';
import * as customPatterns from './custom-patterns.js';
import { formatLife, parseLife } from './life-format.js';
import { Palette } from './palette.js';
import { Interaction } from './interaction.js';
import { Simulator } from './simulator.js';
import { saveState, loadState } from './persist.js';
import { encodeBoard, decodeBoard } from './share.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_HINT = '点选结构后点击棋盘放置，也可以直接拖过去；不选结构时可在棋盘上按住拖动涂画；Shift + 拖拽可框选';

/** 框选复制出来的结构用这个 id 挂在 sessionPatterns 里 */
const CLIPBOARD_ID = 'clipboard';

const dom = {
  canvas: $('board'),
  boardWrap: $('board-wrap'),
  boardHolder: $('board-holder'),
  selBar: $('sel-bar'),
  selActions: $('sel-actions'),
  selNaming: $('sel-naming'),
  selInfo: $('sel-info'),
  selName: $('sel-name'),
  btnSelCopy: $('btn-sel-copy'),
  btnSelSave: $('btn-sel-save'),
  btnSelDelete: $('btn-sel-delete'),
  btnSelCancel: $('btn-sel-cancel'),
  btnSelConfirm: $('btn-sel-confirm'),
  btnSelCancelName: $('btn-sel-cancel-name'),
  palette: document.querySelector('.palette'),
  boardPresets: $('board-presets'),
  btnWrap: $('btn-wrap'),
  initialContent: $('initial-content'),
  densityLabel: $('density-label'),
  density: $('density'),
  densityValue: $('density-value'),
  btnReset: $('btn-reset'),
  btnPlay: $('btn-play'),
  btnStep: $('btn-step'),
  btnClear: $('btn-clear'),
  btnUndo: $('btn-undo'),
  btnRedo: $('btn-redo'),
  speed: $('speed'),
  statGen: $('stat-gen'),
  statPop: $('stat-pop'),
  statCoord: $('stat-coord'),
  paletteList: $('palette-list'),
  paletteHint: $('palette-hint'),
  btnImport: $('btn-import'),
  btnExport: $('btn-export'),
  btnCopyLife: $('btn-copy-life'),
  btnExportPng: $('btn-export-png'),
  btnShare: $('btn-share'),
  lifeMsg: $('life-msg'),
  fileInput: $('file-input'),
  help: $('page-help'),
  btnRotate: $('btn-rotate'),
  btnFlipH: $('btn-flip-h'),
  btnFlipV: $('btn-flip-v'),
  btnDeselect: $('btn-deselect'),
};

const state = {
  presetId: CONFIG.defaultPreset,
  wrap: CONFIG.defaultWrap,
  selectedId: null,
  rot: 0,
  flipH: false,
  flipV: false,
  undo: [],
  redo: [],
  drawPending: false,
  popAtPlayStart: 0,
  // 框选区域内的活细胞。矩形本身放在 app.marquee，这里只缓存抠出来的结果，
  // 免得每次重绘都扫一遍区域
  marqueeCells: null,
};

/**
 * 框选复制出来的结构：只活在当前会话，不进结构库也不进存档。
 * 下一次复制会 clear() 掉，所以不会无限增长。
 */
const sessionPatterns = new Map();

const app = {
  board: null,
  renderer: null,
  ghost: null,
  marquee: null,
  getPlacement,
  setGhost(g) {
    app.ghost = g;
    requestDraw();
  },
  /** rect 为 null 表示取消框选 */
  setMarquee(rect) {
    app.marquee = rect;
    state.marqueeCells = rect ? extractCells(app.board, rect) : null;
    syncSelectionBar();
    requestDraw();
  },
  pushUndo,
  afterEdit,
};

let renderer = null;
let palette = null;
let interaction = null;
let simulator = null;

let placementCache = null;
let placementKey = '';
let lastStatsAt = 0;
let resizeTimer = 0;

// ---------------------------------------------------------------- 小工具

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function currentDensity() {
  return Number(dom.density.value) / 100;
}

function requestDraw() {
  if (state.drawPending) return;
  state.drawPending = true;
  requestAnimationFrame(() => {
    state.drawPending = false;
    renderer.draw(app.board, app.ghost, app.marquee);
  });
}

function updateStats() {
  dom.statGen.textContent = String(app.board.generation);
  dom.statPop.textContent = String(app.board.population);
}

function updateStatsThrottled() {
  const now = performance.now();
  if (now - lastStatsAt < 120) return;
  lastStatsAt = now;
  updateStats();
}

function afterEdit() {
  requestDraw();
  updateStats();
  scheduleSave();
}

function syncHistoryButtons() {
  dom.btnUndo.disabled = state.undo.length === 0;
  dom.btnRedo.disabled = state.redo.length === 0;
}

function pushUndo() {
  if (!app.board) return;
  state.undo.push(app.board.snapshot());
  if (state.undo.length > CONFIG.undoLimit) state.undo.shift();
  state.redo.length = 0; // 有了新的改动，原来的重做链就作废了
  syncHistoryButtons();
}

/** 应用一份快照。快照里可能带着不同的棋盘尺寸，所以要走一遍 layout() */
function applySnapshot(snap) {
  app.board.restore(snap);
  app.setMarquee(null); // 快照可能换了尺寸，框选留着就可能越界
  syncHistoryButtons();
  layout();
  afterEdit();
}

function undo() {
  const snap = state.undo.pop();
  if (!snap) return;
  state.redo.push(app.board.snapshot());
  applySnapshot(snap);
}

function redo() {
  const snap = state.redo.pop();
  if (!snap) return;
  state.undo.push(app.board.snapshot());
  applySnapshot(snap);
}

// ---------------------------------------------------------------- 待放置结构

/** 结构 id -> 结构。剪贴板（本次会话）> 自定义结构库 > 内置结构库 */
function findPattern(id) {
  return sessionPatterns.get(id) || customPatterns.get(id) || getPattern(id);
}

/** 结构内容变了（比如刚复制了新东西），让下次 getPlacement() 重算缓存 */
function invalidatePlacement() {
  placementKey = '';
}

function getPlacement() {
  if (!state.selectedId) return null;
  const key = `${state.selectedId}|${state.rot}|${state.flipH}|${state.flipV}`;
  if (key !== placementKey) {
    placementKey = key;
    const p = findPattern(state.selectedId);
    if (!p) {
      placementCache = null;
    } else {
      const t = transformCells(p.cells, state.rot, state.flipH, state.flipV);
      placementCache = { id: p.id, name: p.name, cells: t.cells, width: t.width, height: t.height };
    }
  }
  return placementCache;
}

function setHint(text) {
  dom.paletteHint.textContent = text;
}

function clearSelection() {
  state.selectedId = null;
  state.rot = 0;
  state.flipH = false;
  state.flipV = false;
  palette.setSelected(null);
  app.setGhost(null);
  setHint(DEFAULT_HINT);
}

function rotate() {
  if (!state.selectedId) return;
  state.rot = (state.rot + 1) % 4;
  interaction.refreshGhost();
}

function flipHorizontal() {
  if (!state.selectedId) return;
  state.flipH = !state.flipH;
  interaction.refreshGhost();
}

function flipVertical() {
  if (!state.selectedId) return;
  state.flipV = !state.flipV;
  interaction.refreshGhost();
}

function toggleWrap() {
  state.wrap = !state.wrap;
  app.board.wrap = state.wrap;
  syncWrapButton();
  interaction.refreshGhost(); // 放置是否"放得下"的判定跟着变
  requestDraw();
}

function syncWrapButton() {
  dom.btnWrap.classList.toggle('is-on', state.wrap);
  dom.btnWrap.setAttribute('aria-pressed', String(state.wrap));
}

// ---------------------------------------------------------------- 主题

/** 当前主题。global.js 把它写在 <html data-theme> 上 */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function currentPalette() {
  return CONFIG.themes[currentTheme()] || CONFIG.themes.light;
}

/**
 * 主题切换后重新取色。
 *
 * 棋盘和缩略图都是画进 canvas 的，CSS 变量管不到它们——光换样式表会出现
 * 「页面黑了、棋盘还白着」。所以切主题时要主动把颜色推给渲染层再重画一遍。
 */
function applyTheme() {
  const p = currentPalette();
  renderer.setPalette(p);
  palette.setColors(p);
  palette.render(customPatterns.all()); // 缩略图是位图，只能重建
  requestDraw();
}

// ---------------------------------------------------------------- 棋盘

function availSpace() {
  const wrap = dom.boardWrap;
  // clientWidth 是「内容 + padding」，但画布只能占内容盒。不减掉左右 padding 的话，
  // 自适应窗口算出来的棋盘会正好宽出 20px，board-wrap 就永远挂着一条横向滚动条。
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const raw = wrap.clientWidth || window.innerWidth - 48;
  const w = Math.max(CONFIG.viewport.minWidth, raw - padX);
  const h = Math.max(
    CONFIG.viewport.minHeight,
    Math.min(window.innerHeight * CONFIG.viewport.heightRatio, CONFIG.viewport.maxHeight)
  );
  return { w, h };
}

function computeBoardSize(preset) {
  if (preset.id !== 'auto') return { cols: preset.cols, rows: preset.rows };
  const { w, h } = availSpace();
  const cellSize = window.innerWidth < 700 ? CONFIG.cell.auto.mobile : CONFIG.cell.auto.desktop;
  const lim = CONFIG.boardLimit;
  return {
    cols: clamp(Math.floor(w / cellSize), lim.minCols, lim.maxCols),
    rows: clamp(Math.floor(h / cellSize), lim.minRows, lim.maxRows),
  };
}

function layout() {
  const { w, h } = availSpace();
  renderer.layout(app.board.cols, app.board.rows, w, h);
  // 宽屏下让结构面板和棋盘一样高，免得一边高一边矮
  if (window.innerWidth > 900) {
    dom.palette.style.maxHeight = `${app.board.rows * renderer.cellSize + 22}px`;
  } else {
    dom.palette.style.maxHeight = '';
  }
  positionSelectionBar(); // 格子尺寸变了，操作条要跟着挪
  requestDraw();
}

function syncPresetButtons() {
  for (const btn of dom.boardPresets.children) {
    btn.classList.toggle('is-active', btn.dataset.id === state.presetId);
  }
}

function createBoard(presetId, keepContent) {
  const preset = CONFIG.boardPresets.find((p) => p.id === presetId) || CONFIG.boardPresets[0];
  state.presetId = preset.id;
  const { cols, rows } = computeBoardSize(preset);

  if (keepContent && app.board) app.board.resize(cols, rows);
  else app.board = new Board(cols, rows, state.wrap);
  app.board.wrap = state.wrap;

  app.setMarquee(null); // 尺寸变了，旧的框选坐标可能已经越界
  syncPresetButtons();
  layout();
}

function applyInitialContent() {
  const b = app.board;
  const value = dom.initialContent.value;
  b.clear();

  if (value === '__random') {
    b.fillRandom(currentDensity());
  } else if (value !== '__empty') {
    const p = getPattern(value);
    if (p) {
      b.stamp(p.cells, Math.max(0, Math.floor((b.cols - p.width) / 2)), Math.max(0, Math.floor((b.rows - p.height) / 2)));
    }
  }
  afterEdit();
}

// ---------------------------------------------------------------- 框选与自定义结构

/** 把框选区域抠成一个结构（自动裁到活细胞的包围盒） */
function marqueeToPattern() {
  const cells = state.marqueeCells;
  if (!cells || !cells.length) return null;
  const n = normalizeCells(cells);
  return { cells: n.cells, width: n.width, height: n.height };
}

function syncSelectionBar() {
  const m = app.marquee;
  if (!m) {
    dom.selBar.hidden = true;
    return;
  }
  const cells = state.marqueeCells || [];
  const w = m.x1 - m.x0 + 1;
  const h = m.y1 - m.y0 + 1;
  const has = cells.length > 0;

  dom.selInfo.textContent = has ? `${w}×${h} · ${cells.length} 细胞` : `${w}×${h} · 空`;
  dom.btnSelCopy.disabled = !has;
  dom.btnSelSave.disabled = !has || customPatterns.isFull();
  dom.btnSelSave.title = customPatterns.isFull() ? `结构库已满（上限 ${customPatterns.MAX} 个）` : '';
  // 每次同步都退回按钮那一屏，命名屏只在点「存为结构」之后出现
  dom.selActions.hidden = false;
  dom.selNaming.hidden = true;
  dom.selBar.hidden = false;
  positionSelectionBar();
}

/** 操作条默认贴在选区下边；下面放不下就翻到上边，左右夹在棋盘内 */
function positionSelectionBar() {
  const m = app.marquee;
  if (!m || dom.selBar.hidden) return;

  const bar = dom.selBar;
  const cs = renderer.cellSize;
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  const holderW = dom.boardHolder.clientWidth;
  const holderH = dom.boardHolder.clientHeight;

  let left = ((m.x0 + m.x1 + 1) / 2) * cs - bw / 2;
  const maxLeft = holderW - bw - 4;
  left = maxLeft < 4 ? 4 : clamp(left, 4, maxLeft);

  let top = (m.y1 + 1) * cs + 8;
  if (top + bh > holderH - 4) top = m.y0 * cs - bh - 8;
  top = clamp(top, 4, Math.max(4, holderH - bh - 4));

  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

/** 动作做完就收掉框：操作条浮在棋盘上，留着会挡掉下一次点击 */
function closeMarquee() {
  app.setMarquee(null);
  setHint(DEFAULT_HINT);
}

/** 复制：把区域变成"待放置结构"，复用现有的幽灵预览 + 点击落子 */
function copySelection() {
  const p = marqueeToPattern();
  if (!p) return;

  sessionPatterns.clear();
  sessionPatterns.set(CLIPBOARD_ID, { id: CLIPBOARD_ID, name: '剪贴板', ...p });

  state.selectedId = CLIPBOARD_ID;
  state.rot = 0;
  state.flipH = false;
  state.flipV = false;
  invalidatePlacement();
  palette.setSelected(null); // 剪贴板结构不在面板里，别留一个对不上的高亮
  closeMarquee();
  interaction.refreshGhost();
  setHint(`已复制 ${p.cells.length} 个细胞：点击棋盘放置（R 旋转 / Esc 取消）`);
}

function beginSaveSelection() {
  if (!marqueeToPattern()) return;
  dom.selName.value = `自定义 ${customPatterns.count() + 1}`;
  dom.selActions.hidden = true;
  dom.selNaming.hidden = false;
  positionSelectionBar(); // 换了一屏，宽度变了要重新定位
  dom.selName.focus();
  dom.selName.select();
}

function confirmSaveSelection() {
  const p = marqueeToPattern();
  if (!p) return;
  const saved = customPatterns.add(dom.selName.value, p.cells);
  if (!saved) {
    setHint(`结构库已满（上限 ${customPatterns.MAX} 个），先删掉几个`, true);
    return;
  }
  closeMarquee();
  palette.render(customPatterns.all());
  dom.paletteList.scrollTop = 0; // 新结构在"我的结构"里，滚到顶才看得见
  flashPattern(saved.id);
  setHint(`已把「${saved.name}」存进结构库，共 ${customPatterns.count()} 个`);
}

function deleteSelection() {
  const m = app.marquee;
  if (!m) return;
  pushUndo();
  let n = 0;
  for (let y = m.y0; y <= m.y1; y++) {
    for (let x = m.x0; x <= m.x1; x++) {
      if (app.board.set(x, y, 0)) n++;
    }
  }
  closeMarquee();
  afterEdit();
  setHint(`已删掉区域内的 ${n} 个细胞`);
}

function deleteCustomPattern(id) {
  const p = customPatterns.get(id);
  if (!p) return;
  // 删了找不回来，而且结构库没有撤销，所以问一句
  if (!confirm(`删除自定义结构「${p.name}」？删掉就找不回来了。`)) return;

  customPatterns.remove(id);
  if (state.selectedId === id) clearSelection();
  palette.render(customPatterns.all());
  setHint(`已删除「${p.name}」，还剩 ${customPatterns.count()} 个自定义结构`);
}

/** 新存的结构闪一下，免得在一堆缩略图里找不着 */
function flashPattern(id) {
  const btn = palette.items.get(id);
  if (!btn) return;
  btn.classList.add('is-flash');
  setTimeout(() => btn.classList.remove('is-flash'), 900);
}

// ---------------------------------------------------------------- Life 1.06 导入导出

const LIFE_HINT = 'Life 1.06 格式：也可把 .life 文件拖到棋盘上，或直接 Ctrl+V 粘贴';
let lifeMsgTimer = 0;

function setLifeMsg(text, isError) {
  dom.lifeMsg.textContent = text;
  dom.lifeMsg.classList.toggle('is-error', Boolean(isError));
  clearTimeout(lifeMsgTimer);
  if (text !== LIFE_HINT) {
    lifeMsgTimer = setTimeout(() => {
      dom.lifeMsg.textContent = LIFE_HINT;
      dom.lifeMsg.classList.remove('is-error');
    }, 5000);
  }
}

function currentLifeText() {
  return formatLife(app.board.liveCells());
}

/**
 * 把解析出来的细胞放进棋盘。
 * 坐标全落在棋盘内时原样保留位置（这样"导出 → 导入"能精确还原）；
 * 否则整体平移居中——Life 1.06 文件本身不带棋盘尺寸，不能指望它一定放得下。
 */
function importLifeCells(result, label) {
  const b = app.board;
  const box = result.bounds;
  const fits = box.minX >= 0 && box.minY >= 0 && box.maxX < b.cols && box.maxY < b.rows;
  const dx = fits ? 0 : Math.floor((b.cols - box.width) / 2) - box.minX;
  const dy = fits ? 0 : Math.floor((b.rows - box.height) / 2) - box.minY;

  pushUndo();
  b.clear();
  let clipped = 0;
  for (const [x, y] of result.cells) {
    if (!b.set(x + dx, y + dy, 1)) clipped++;
  }
  afterEdit();

  const parts = [`已从${label}导入 ${result.cells.length} 个细胞`];
  if (!fits) parts.push('原坐标超出棋盘，已居中放置');
  if (result.duplicates) parts.push(`忽略 ${result.duplicates} 个重复坐标`);
  if (clipped) parts.push(`${clipped} 个超出棋盘被裁掉`);
  setLifeMsg(parts.join('；'), clipped > 0);
}

function importLifeText(text, label) {
  const result = parseLife(text);
  if (!result.ok) {
    setLifeMsg(`导入失败：${result.error}`, true);
    return;
  }
  importLifeCells(result, label);
}

async function readLifeFile(file) {
  try {
    importLifeText(await file.text(), `「${file.name}」`);
  } catch {
    setLifeMsg(`读取「${file.name}」失败`, true);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportLifeFile() {
  const blob = new Blob([currentLifeText()], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `life-${app.board.cols}x${app.board.rows}.life`);
  setLifeMsg(`已导出 ${app.board.population} 个细胞到 .life 文件`);
}

/** 直接存画布，所见即所得（含网格线） */
function exportPng() {
  app.renderer.canvas.toBlob((blob) => {
    if (!blob) {
      setLifeMsg('导出图片失败', true);
      return;
    }
    downloadBlob(blob, `life-${app.board.cols}x${app.board.rows}.png`);
    setLifeMsg('已导出 PNG 图片');
  }, 'image/png');
}

async function copyLifeText() {
  try {
    await navigator.clipboard.writeText(currentLifeText());
    setLifeMsg(`已复制 ${app.board.population} 个细胞到剪贴板`);
  } catch {
    setLifeMsg('复制失败，浏览器拒绝了剪贴板访问', true);
  }
}

function isFileDrag(ev) {
  return Boolean(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files'));
}

function bindLifeIo() {
  dom.btnImport.addEventListener('click', () => dom.fileInput.click());
  dom.btnExport.addEventListener('click', exportLifeFile);
  dom.btnCopyLife.addEventListener('click', copyLifeText);
  dom.btnExportPng.addEventListener('click', exportPng);
  dom.btnShare.addEventListener('click', shareBoard);

  dom.fileInput.addEventListener('change', async () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (file) await readLifeFile(file);
    dom.fileInput.value = ''; // 清空，方便连续选同一个文件
  });

  // 把 .life 文件拖到棋盘上
  const zone = dom.boardWrap;
  let dragDepth = 0;
  zone.addEventListener('dragenter', (ev) => {
    if (!isFileDrag(ev)) return;
    dragDepth++;
    zone.classList.add('is-dropping');
  });
  zone.addEventListener('dragover', (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      zone.classList.remove('is-dropping');
    }
  });
  zone.addEventListener('drop', async (ev) => {
    dragDepth = 0;
    zone.classList.remove('is-dropping');
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    const file = ev.dataTransfer.files[0];
    if (file) await readLifeFile(file);
  });

  // Ctrl+V 粘贴文本。只在内容确实像 Life 1.06 时才接管，不干扰正常粘贴
  window.addEventListener('paste', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    const text = ev.clipboardData && ev.clipboardData.getData('text');
    if (!text || !text.includes('#Life 1.06')) return;
    ev.preventDefault();
    importLifeText(text, '剪贴板');
  });
}

// ---------------------------------------------------------------- 分享链接

/** 把当前棋盘写进地址栏并复制链接 */
async function shareBoard() {
  const hash = encodeBoard(app.board);
  const url = `${location.origin}${location.pathname}${location.search}#${hash}`;
  history.replaceState(null, '', `#${hash}`);
  try {
    await navigator.clipboard.writeText(url);
    // 混沌棋盘编码后会很长，先提醒一句，免得发出去被聊天工具截断还不知道
    const tooLong = url.length > 8000;
    setLifeMsg(`链接已复制（${url.length} 字符）${tooLong ? '；偏长，部分聊天工具可能会截断' : ''}`, tooLong);
  } catch {
    setLifeMsg('棋盘已写进地址栏，但复制失败，请手动复制', true);
  }
}

/**
 * 链接里带着棋盘就直接用它，优先级高于本地存档。
 *
 * 载入后立刻把 hash 清掉：否则之后每次刷新都会退回这个局面，
 * 把用户后来的改动盖掉。想再拿一次链接按「分享链接」就行。
 */
function loadSharedBoard() {
  const shared = decodeBoard(location.hash);
  if (!shared) return false;

  state.wrap = shared.wrap;
  const preset = CONFIG.boardPresets.find((p) => p.cols === shared.cols && p.rows === shared.rows);
  state.presetId = preset ? preset.id : null; // 尺寸对不上任何预设时，就不高亮任何按钮

  // age 必须跟着 cells 一起给：渲染层依赖「age === 0 严格等价于死细胞」这条不变量
  const age = new Uint8Array(shared.cells.length);
  let pop = 0;
  for (let i = 0; i < shared.cells.length; i++) {
    if (shared.cells[i]) {
      age[i] = 1;
      pop++;
    }
  }

  app.board = new Board(shared.cols, shared.rows, shared.wrap);
  app.board.restore({
    cols: shared.cols,
    rows: shared.rows,
    cells: shared.cells,
    age,
    population: pop,
    generation: 0,
  });

  syncPresetButtons();
  syncWrapButton();
  layout();
  afterEdit();
  setLifeMsg(`已从链接载入棋盘（${shared.cols}×${shared.rows}，${pop} 个细胞）`);

  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// ---------------------------------------------------------------- 刷新不丢状态

const SAVE_DELAY = 600;
let saveTimer = 0;

function collectState() {
  return {
    presetId: state.presetId,
    wrap: state.wrap,
    speed: Number(dom.speed.value),
    initialContent: dom.initialContent.value,
    density: Number(dom.density.value),
    board: app.board
      ? {
          cols: app.board.cols,
          rows: app.board.rows,
          generation: app.board.generation,
          cells: app.board.cells,
          age: app.board.age,
        }
      : null,
  };
}

/**
 * 播放时刻意不存：每帧都序列化 76KB 会掉帧。
 * 只在编辑之后、暂停时、以及关页面时存。
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(collectState()), SAVE_DELAY);
}

/**
 * 把存档应用回去。成功返回 true。
 * 存档只恢复「内容」和设置；棋盘尺寸仍按当前预设算，这样「自适应窗口」才真的跟着窗口走。
 */
function restoreSavedState() {
  const saved = loadState();
  if (!saved) return false;

  if (typeof saved.wrap === 'boolean') state.wrap = saved.wrap;
  if (CONFIG.boardPresets.some((p) => p.id === saved.presetId)) state.presetId = saved.presetId;
  if (CONFIG.speeds.includes(saved.speed)) dom.speed.value = String(saved.speed);
  if (saved.initialContent) {
    dom.initialContent.value = saved.initialContent;
    // 存档里的结构可能已经不存在了，这时 value 会变成空串
    if (!dom.initialContent.value) dom.initialContent.value = '__empty';
  }
  if (Number.isFinite(saved.density)) dom.density.value = String(saved.density);

  dom.densityValue.textContent = `${dom.density.value}%`;
  syncWrapButton();
  updateDensityVisibility();

  const b = saved.board;
  const usable =
    b && b.cells instanceof Uint8Array && b.cells.length === b.cols * b.rows && b.cols > 0 && b.rows > 0;
  if (usable) {
    const preset = CONFIG.boardPresets.find((p) => p.id === state.presetId) || CONFIG.boardPresets[0];
    const { cols, rows } = computeBoardSize(preset);

    app.board = new Board(b.cols, b.rows, state.wrap);
    let pop = 0;
    for (let i = 0; i < b.cells.length; i++) if (b.cells[i]) pop++;
    app.board.restore({
      cols: b.cols,
      rows: b.rows,
      cells: b.cells,
      age: b.age,
      population: pop,
      generation: b.generation || 0,
    });
    // 尺寸没变时 resize() 直接返回；变了就居中保留，和手动切尺寸的行为一致
    app.board.resize(cols, rows);

    syncPresetButtons();
    layout();
    afterEdit();
  } else {
    createBoard(state.presetId, false);
    applyInitialContent();
  }
  return true;
}

function bindPersistence() {
  // 播放中直接关掉标签页时，靠这两个事件补一次同步保存
  window.addEventListener('pagehide', () => saveState(collectState()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveState(collectState());
  });
}

// ---------------------------------------------------------------- 工具栏

function buildToolbar() {
  // 棋盘尺寸预设
  dom.boardPresets.textContent = '';
  for (const preset of CONFIG.boardPresets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.id = preset.id;
    btn.textContent = preset.name;
    btn.addEventListener('click', () => {
      if (preset.id === state.presetId) return;
      pushUndo();
      createBoard(preset.id, false);
      applyInitialContent();
    });
    dom.boardPresets.appendChild(btn);
  }

  // 初始内容
  const addOption = (value, label, parent) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    (parent || dom.initialContent).appendChild(o);
  };
  addOption('__empty', '空棋盘');
  addOption('__random', '随机填充');
  const group = document.createElement('optgroup');
  group.label = '经典结构';
  dom.initialContent.appendChild(group);
  for (const p of classicPatterns()) addOption(p.id, p.name, group);

  // 速度档位
  CONFIG.speeds.forEach((s) => {
    const o = document.createElement('option');
    o.value = String(s);
    o.textContent = `${s} 代/秒`;
    dom.speed.appendChild(o);
  });
  dom.speed.value = String(CONFIG.speeds[CONFIG.defaultSpeedIndex]);

  dom.density.min = String(CONFIG.densityRange.min);
  dom.density.max = String(CONFIG.densityRange.max);
  dom.density.value = String(Math.round(CONFIG.randomDensity * 100));
}

function updateDensityVisibility() {
  const show = dom.initialContent.value === '__random';
  dom.densityLabel.hidden = !show;
  dom.density.hidden = !show;
  dom.densityValue.hidden = !show;
}

function updatePlayButton() {
  dom.btnPlay.textContent = simulator.playing ? '⏸ 暂停' : '▶ 播放';
  dom.btnPlay.classList.toggle('is-playing', simulator.playing);
  scheduleSave(); // 播放状态也一并存下来
}

function togglePlay() {
  simulator.toggle();
  // 记下开播时的种群数：本来就是空棋盘的话，就别自动暂停来打扰
  if (simulator.playing) state.popAtPlayStart = app.board.population;
  updatePlayButton();
}

/** 棋盘被跑空了就停下来，别让它空转 */
function maybeAutoPause() {
  if (!simulator.playing) return;
  if (state.popAtPlayStart === 0) return;
  if (app.board.population > 0) return;
  simulator.pause();
  updatePlayButton();
  setLifeMsg('棋盘已空，已自动暂停');
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  dom.initialContent.addEventListener('change', () => {
    updateDensityVisibility();
  });

  dom.density.addEventListener('input', () => {
    dom.densityValue.textContent = `${dom.density.value}%`;
  });
  dom.density.addEventListener('change', () => {
    if (dom.initialContent.value === '__random') {
      pushUndo();
      applyInitialContent();
    }
  });

  dom.btnReset.addEventListener('click', () => {
    pushUndo();
    applyInitialContent();
  });

  dom.btnPlay.addEventListener('click', togglePlay);

  dom.btnStep.addEventListener('click', () => {
    simulator.pause();
    updatePlayButton();
    simulator.stepOnce();
  });

  dom.btnClear.addEventListener('click', () => {
    pushUndo();
    app.board.clear();
    afterEdit();
  });

  dom.btnUndo.addEventListener('click', undo);
  dom.btnRedo.addEventListener('click', redo);

  dom.speed.addEventListener('change', () => {
    simulator.setSpeed(Number(dom.speed.value));
  });

  dom.btnSelCopy.addEventListener('click', copySelection);
  dom.btnSelSave.addEventListener('click', beginSaveSelection);
  dom.btnSelDelete.addEventListener('click', deleteSelection);
  dom.btnSelConfirm.addEventListener('click', confirmSaveSelection);
  dom.btnSelCancelName.addEventListener('click', syncSelectionBar); // 退回按钮那一屏
  dom.btnSelCancel.addEventListener('click', closeMarquee);
  dom.selName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      confirmSaveSelection();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      syncSelectionBar();
    }
  });

  dom.btnWrap.addEventListener('click', toggleWrap);
  dom.btnRotate.addEventListener('click', rotate);
  dom.btnFlipH.addEventListener('click', flipHorizontal);
  dom.btnFlipV.addEventListener('click', flipVertical);
  dom.btnDeselect.addEventListener('click', clearSelection);

  // 鼠标在棋盘上的格子坐标
  dom.canvas.addEventListener('pointermove', (ev) => {
    const cell = renderer.cellFromPoint(ev.clientX, ev.clientY);
    dom.statCoord.textContent = cell ? `${cell.x}, ${cell.y}` : '—';
  });
  dom.canvas.addEventListener('pointerleave', () => {
    dom.statCoord.textContent = '—';
  });

  window.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;

    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault();
      redo();
      return;
    }
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        togglePlay();
        break;
      case 'r':
      case 'R':
        rotate();
        break;
      case 'w':
      case 'W':
        toggleWrap();
        break;
      case 'h':
      case 'H':
        flipHorizontal();
        break;
      case 'v':
      case 'V':
        flipVertical();
        break;
      case 's':
      case 'S':
        simulator.pause();
        updatePlayButton();
        simulator.stepOnce();
        break;
      case '?':
        ev.preventDefault();
        dom.help.open = !dom.help.open;
        break;
      case 'Escape':
        clearSelection();
        app.setMarquee(null);
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });

  // global.js 切主题后会发这个事件
  window.addEventListener('themechange', applyTheme);

  bindLifeIo();
  bindPersistence();
}

// ---------------------------------------------------------------- 启动

function init() {
  renderer = new Renderer(dom.canvas);
  renderer.setPalette(currentPalette()); // 构造函数里默认是浅色，这里按实际主题覆盖
  app.renderer = renderer;

  buildToolbar();

  palette = new Palette(dom.paletteList, {
    onPick: (pattern) => {
      state.selectedId = pattern.id;
      palette.setSelected(pattern.id);
      app.setMarquee(null); // 选了结构就是要放置，先把框收掉，免得第一次点击被吃掉
      setHint(`已选「${pattern.name}」：点击棋盘放置（R 旋转 / H 翻转 / Esc 取消）`);
      interaction.refreshGhost();
    },
    onDragStart: () => interaction.beginPaletteDrag(),
    onDeleteCustom: deleteCustomPattern,
    colors: currentPalette(),
  });
  palette.render(customPatterns.all());

  interaction = new Interaction(dom.canvas, app);

  simulator = new Simulator({
    step: () => app.board.step(),
    onAdvance: () => {
      requestDraw();
      updateStatsThrottled();
      maybeAutoPause();
    },
    maxStepsPerFrame: CONFIG.maxStepsPerFrame,
  });

  syncHistoryButtons();
  syncWrapButton();
  dom.densityValue.textContent = `${dom.density.value}%`;
  setHint(DEFAULT_HINT);
  setLifeMsg(LIFE_HINT);
  updateDensityVisibility();

  // 优先顺序：链接里的棋盘 > 本地存档 > 默认开局
  if (!loadSharedBoard() && !restoreSavedState()) {
    createBoard(CONFIG.defaultPreset, false);
    applyInitialContent();
  }
  simulator.setSpeed(Number(dom.speed.value));

  bindEvents();
  updatePlayButton();
}

init();
