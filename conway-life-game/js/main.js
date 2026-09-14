import { CONFIG } from './config.js';
import { Board } from './board.js';
import { Renderer } from './renderer.js';
import { getPattern, transformCells, classicPatterns } from './patterns.js';
import { formatLife, parseLife } from './life-format.js';
import { Palette } from './palette.js';
import { Interaction } from './interaction.js';
import { Simulator } from './simulator.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_HINT = '点选结构后点击棋盘放置，也可以直接拖过去；不选结构时可在棋盘上按住拖动涂画';

const dom = {
  canvas: $('board'),
  boardWrap: $('board-wrap'),
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
  speed: $('speed'),
  statGen: $('stat-gen'),
  statPop: $('stat-pop'),
  paletteList: $('palette-list'),
  paletteHint: $('palette-hint'),
  btnImport: $('btn-import'),
  btnExport: $('btn-export'),
  btnCopyLife: $('btn-copy-life'),
  lifeMsg: $('life-msg'),
  fileInput: $('file-input'),
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
  drawPending: false,
};

const app = {
  board: null,
  renderer: null,
  ghost: null,
  getPlacement,
  setGhost(g) {
    app.ghost = g;
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
    renderer.draw(app.board, app.ghost);
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
}

function pushUndo() {
  if (!app.board) return;
  state.undo.push(app.board.snapshot());
  if (state.undo.length > CONFIG.undoLimit) state.undo.shift();
  dom.btnUndo.disabled = false;
}

function undo() {
  const snap = state.undo.pop();
  if (!snap) return;
  app.board.restore(snap);
  dom.btnUndo.disabled = state.undo.length === 0;
  layout(); // 撤销可能把棋盘尺寸也还原了
  afterEdit();
}

// ---------------------------------------------------------------- 待放置结构

function getPlacement() {
  if (!state.selectedId) return null;
  const key = `${state.selectedId}|${state.rot}|${state.flipH}|${state.flipV}`;
  if (key !== placementKey) {
    placementKey = key;
    const p = getPattern(state.selectedId);
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

// ---------------------------------------------------------------- 棋盘

function availSpace() {
  const wrap = dom.boardWrap;
  const w = Math.max(CONFIG.viewport.minWidth, wrap.clientWidth || window.innerWidth - 48);
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

function exportLifeFile() {
  const blob = new Blob([currentLifeText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `life-${app.board.cols}x${app.board.rows}.life`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setLifeMsg(`已导出 ${app.board.population} 个细胞到 .life 文件`);
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

  dom.btnPlay.addEventListener('click', () => {
    simulator.toggle();
    updatePlayButton();
  });

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

  dom.speed.addEventListener('change', () => {
    simulator.setSpeed(Number(dom.speed.value));
  });

  dom.btnWrap.addEventListener('click', toggleWrap);
  dom.btnRotate.addEventListener('click', rotate);
  dom.btnFlipH.addEventListener('click', flipHorizontal);
  dom.btnFlipV.addEventListener('click', flipVertical);
  dom.btnDeselect.addEventListener('click', clearSelection);

  window.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;

    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      undo();
      return;
    }
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        simulator.toggle();
        updatePlayButton();
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
      case 'Escape':
        clearSelection();
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });

  bindLifeIo();
}

// ---------------------------------------------------------------- 启动

function init() {
  renderer = new Renderer(dom.canvas);
  app.renderer = renderer;

  buildToolbar();

  palette = new Palette(dom.paletteList, {
    onPick: (pattern) => {
      state.selectedId = pattern.id;
      palette.setSelected(pattern.id);
      setHint(`已选「${pattern.name}」：点击棋盘放置（R 旋转 / H 翻转 / Esc 取消）`);
      interaction.refreshGhost();
    },
    onDragStart: () => interaction.beginPaletteDrag(),
  });
  palette.render();

  interaction = new Interaction(dom.canvas, app);

  simulator = new Simulator({
    step: () => app.board.step(),
    onAdvance: () => {
      requestDraw();
      updateStatsThrottled();
    },
    maxStepsPerFrame: CONFIG.maxStepsPerFrame,
  });
  simulator.setSpeed(Number(dom.speed.value));

  dom.btnUndo.disabled = true;
  syncWrapButton();
  dom.densityValue.textContent = `${dom.density.value}%`;
  setHint(DEFAULT_HINT);
  setLifeMsg(LIFE_HINT);
  updateDensityVisibility();

  createBoard(CONFIG.defaultPreset, false);
  applyInitialContent();
  bindEvents();
  updatePlayButton();
}

init();
