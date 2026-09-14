import { CONFIG } from './config.js';
import { Board } from './board.js';
import { Renderer } from './renderer.js';
import { getPattern, transformCells, classicPatterns } from './patterns.js';
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
  btnRotate: $('btn-rotate'),
  btnFlipH: $('btn-flip-h'),
  btnFlipV: $('btn-flip-v'),
  btnDeselect: $('btn-deselect'),
};

const state = {
  presetId: CONFIG.defaultPreset,
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
  else app.board = new Board(cols, rows);

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
  dom.densityValue.textContent = `${dom.density.value}%`;
  setHint(DEFAULT_HINT);
  updateDensityVisibility();

  createBoard(CONFIG.defaultPreset, false);
  applyInitialContent();
  bindEvents();
  updatePlayButton();
}

init();
