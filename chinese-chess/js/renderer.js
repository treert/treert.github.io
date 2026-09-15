/**
 * 棋盘渲染。DOM + CSS，不是 Canvas。
 *
 * 选 DOM 而不是 Canvas 的直接收益（design.md §3.2）：
 *   - 颜色全部走 CSS 变量，深色模式自动生效，**不需要监听 themechange**
 *   - 命中测试用事件委托，免费
 *   - 90 格 + 32 子，DOM 完全够；格子是 <button>，键盘可遍历
 *
 * 棋盘的 9×10 个格子是「交叉点」网格（每个格子的中心就是一个落子点），
 * 十字线由格子自己的伪元素画，河界和九宫由棋盘容器的伪元素画。
 */

import { COLS, ROWS, CELLS, EMPTY } from './config.js';
import { xOf, yOf } from './position.js';
import { moveFrom, moveTo } from './rules.js';
import { RED_NAMES, BLACK_NAMES } from './notation.js';

// 河界上下沿所在的行：这两行里（除最外两条纵线）的竖线要断开
const RIVER_TOP_ROW = 4;
const RIVER_BOTTOM_ROW = 5;

/**
 * 建好 90 个格子，返回一个渲染器。
 *
 * wrapEl 只用来挂 is-flipped 类 —— 翻转是纯 CSS 的（整块棋盘转 180°，
 * 棋子文字再转回来），所以点击事件跟着 DOM 走，
 * 不需要在任何地方做坐标翻转计算。
 */
export function createRenderer(boardEl, wrapEl) {
  const cells = new Array(CELLS);
  const pieceEls = new Map(); // 格子下标 -> 棋子元素

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'xq-cell';
      cell.dataset.index = String(i);
      cell.dataset.coord = `${x},${y}`;
      // 河界：中间七条纵线在两岸断开（最外两条是棋盘边界，要通到底）
      if (x > 0 && x < COLS - 1) {
        if (y === RIVER_TOP_ROW) cell.classList.add('xq-cell--river-up');
        if (y === RIVER_BOTTOM_ROW) cell.classList.add('xq-cell--river-down');
      }
      boardEl.appendChild(cell);
      cells[i] = cell;
    }
  }

  /** 格心坐标 -> CSS 百分比 */
  function place(el, idx) {
    el.style.left = `${((xOf(idx) + 0.5) / COLS) * 100}%`;
    el.style.top = `${((yOf(idx) + 0.5) / ROWS) * 100}%`;
  }

  function pieceEl(piece) {
    const red = piece > 0;
    const el = document.createElement('div');
    el.className = `xq-piece ${red ? 'xq-piece--red' : 'xq-piece--black'}`;
    const span = document.createElement('span');
    span.textContent = (red ? RED_NAMES : BLACK_NAMES)[Math.abs(piece)];
    el.appendChild(span);
    return el;
  }

  function clearHighlights() {
    for (const cell of cells) {
      cell.classList.remove('xq-cell--last', 'xq-cell--target', 'xq-cell--hint', 'xq-cell--selected');
    }
  }

  function applyHighlights(pos, highlight, animate) {
    if (highlight.last) {
      // 起点现在是空的，高亮格子；终点被棋子盖住，所以圈画在棋子上
      cells[moveFrom(highlight.last)].classList.add('xq-cell--last');
      const target = animate ? animate.to : moveTo(highlight.last);
      const el = pieceEls.get(target);
      if (el) el.classList.add('xq-piece--last');
    }
    for (const t of highlight.targets || []) cells[t].classList.add('xq-cell--target');
    if (highlight.hint) {
      cells[moveFrom(highlight.hint)].classList.add('xq-cell--hint');
      cells[moveTo(highlight.hint)].classList.add('xq-cell--hint');
    }
    if (highlight.selected >= 0) cells[highlight.selected].classList.add('xq-cell--selected');
    if (highlight.checked >= 0) {
      const el = pieceEls.get(highlight.checked);
      if (el) el.classList.add('xq-piece--checked');
    }
    // 轮到谁走：那一方的**全部**棋子加一道外圈。
    // 走「全部」而不是只标将帅 —— 满盘棋里找那个小圈太费眼。
    if (highlight.turn) {
      for (const [i, el] of pieceEls) {
        if (Math.sign(pos.cells[i]) === highlight.turn) el.classList.add('xq-piece--turn');
      }
    }
  }

  /**
   * 重绘。
   *
   * animate 传 `{ from, to }` 时会**复用起点上的那个棋子元素**，
   * 只改它的 left / top，让 CSS 过渡接管 —— 于是走子有动画。
   * 不传就是全量重建：因为元素的 left / top 是在插入 DOM **之前**设好的，
   * 不会触发过渡，所以复盘跳转和悔棋时棋子直接出现在该在的位置，不会满屏乱飞。
   */
  function draw(pos, highlight = {}, animate = null) {
    const movedEl = animate ? pieceEls.get(animate.from) || null : null;
    const capturedEl = animate ? pieceEls.get(animate.to) || null : null;

    // 复用元素时要把上次的标记清掉 —— 它不会像其它棋子那样被重建，
    // 否则会带着上一轮的「上一步 / 被将军 / 轮到我方」显示出来。
    if (movedEl) {
      movedEl.classList.remove('xq-piece--last', 'xq-piece--checked', 'xq-piece--turn');
    }

    // 清掉所有棋子，但要留住正在移动的那一个
    for (const el of pieceEls.values()) {
      if (el !== movedEl) el.remove();
    }
    pieceEls.clear();
    if (capturedEl) capturedEl.remove();

    for (let i = 0; i < CELLS; i++) {
      const v = pos.cells[i];
      if (v === EMPTY) continue;

      if (movedEl && animate.to === i) {
        // 复用：元素已在 DOM 里，只改位置，过渡动画自然发生
        place(movedEl, i);
        pieceEls.set(i, movedEl);
        continue;
      }
      const el = pieceEl(v);
      place(el, i);
      boardEl.appendChild(el);
      pieceEls.set(i, el);
    }

    clearHighlights();
    applyHighlights(pos, highlight, animate);
  }

  /** 走子后的重绘：带移动动画 */
  function drawAnimated(pos, highlight, from, to) {
    draw(pos, highlight, { from, to });
  }

  /** 从事件目标找到格子下标；不是格子则返回 -1 */
  function cellIndexOf(node) {
    const cell = node && node.closest ? node.closest('.xq-cell') : null;
    if (!cell || !boardEl.contains(cell)) return -1;
    return Number(cell.dataset.index);
  }

  function setFlipped(flipped) {
    wrapEl.classList.toggle('is-flipped', !!flipped);
  }

  function isFlipped() {
    return wrapEl.classList.contains('is-flipped');
  }

  return { draw, drawAnimated, cellIndexOf, setFlipped, isFlipped, cells, boardEl };
}
