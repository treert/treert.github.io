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
 *
 * 传统棋盘上那些「不是线」的东西 —— 外框、楚河汉界、上下纵线号、炮位与兵卒位上的
 * 「十」字标记 —— 归本文件建：它们都在棋盘内部，位置由 COLS / ROWS 推出来，
 * 和格子的坐标是同一套算法，分开放只会两边各写一遍。
 */

import { COLS, ROWS, CELLS, EMPTY } from './config.js';
import { xOf, yOf } from './position.js';
import { moveFrom, moveTo } from './rules.js';
import { RED_NAMES, BLACK_NAMES } from './notation.js';

// 河界上下沿所在的行：这两行里（除最外两条纵线）的竖线要断开
const RIVER_TOP_ROW = 4;
const RIVER_BOTTOM_ROW = 5;

// 传统棋盘在炮位与兵 / 卒位上画「十」字标记；最外两列上的只画朝盘内的那一半
const STAR_POINTS = (() => {
  const set = new Set();
  const add = (x, y) => set.add(y * COLS + x);
  for (const y of [2, 7]) { add(1, y); add(7, y); }                    // 炮位
  for (const y of [3, 6]) for (const x of [0, 2, 4, 6, 8]) add(x, y);  // 兵 / 卒位
  return set;
})();

// 下沿的纵线号。红方在下方，从红方右手边数起是「一」，所以盘左是「九」。
const RED_FILES = ['九', '八', '七', '六', '五', '四', '三', '二', '一'];

function decoText(text) {
  const el = document.createElement('span');
  el.className = 'xq-deco-text';
  el.textContent = text;
  return el;
}

/** 一排纵线号：9 等分网格，每格一个 —— 和棋子的 left 百分比是同一套算法 */
function coordsRow(extraClass, textOf) {
  const row = document.createElement('div');
  row.className = `xq-coords ${extraClass}`;
  for (let x = 0; x < COLS; x++) row.appendChild(decoText(textOf(x)));
  return row;
}

/**
 * 棋盘装饰层：外框 + 楚河汉界 + 上下纵线号。
 *
 * 它们都不参与交互，也不该跟着 90 个格子重复建，所以聚成一层。
 * 插在格子后面是图省事（格子是循环里 append 的），上下关系由 z-index 定，不看 DOM 顺序 ——
 * 装饰层是 0，格子是 1，棋子是 2。
 *
 * 翻转时这一层跟着棋盘转 180°，里面的文字各自反向转回来（见 style.css 的 .xq-deco-text）——
 * 转容器会把文字送到别的列上，必须在文字自己身上转。
 */
function buildDeco() {
  const deco = document.createElement('div');
  deco.className = 'xq-deco';
  deco.setAttribute('aria-hidden', 'true'); // 纯装饰，读屏不必念

  const frame = document.createElement('div');
  frame.className = 'xq-frame';

  // 河界：左边楚河、右边汉界，和参考棋盘一样分开摆
  const river = document.createElement('div');
  river.className = 'xq-river';
  river.append(decoText('楚河'), decoText('汉界'));

  // 上面「1..9」（黑方的纵线号，从左到右）、下面「九..一」（红方的，同样从左到右）。
  // 两排都是「跟着列走」的：翻转后它们各自转到棋盘另一头，仍然对着原来那一列。
  deco.append(
    frame,
    river,
    coordsRow('xq-coords--top', (x) => String(x + 1)),
    coordsRow('xq-coords--bottom', (x) => RED_FILES[x]),
  );
  return deco;
}

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
  let flipTimer = 0;          // 翻转动画结束后把装饰文字放出来的定时器

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
      // 星位标记：一个空元素，四条短臂由它的两个伪元素画（格子的伪元素已经是十字线了）
      if (STAR_POINTS.has(i)) {
        const star = document.createElement('i');
        star.className = 'xq-star';
        if (x === 0) star.classList.add('xq-star--left');
        else if (x === COLS - 1) star.classList.add('xq-star--right');
        cell.appendChild(star);
      }
      boardEl.appendChild(cell);
      cells[i] = cell;
    }
  }

  boardEl.appendChild(buildDeco());

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
    for (const t of highlight.targets || []) {
      // 空格 → 格子上的小圆点；有敌子 → 棋子外面一圈红环。
      // **必须分开处理**：小圆点画在格子上，而棋子不透明地盖住格子中心，
      // 所以有子的格子那个点根本看不见。
      const el = pieceEls.get(t);
      if (el) el.classList.add('xq-piece--capture');
      else cells[t].classList.add('xq-cell--target');
    }
    if (highlight.hint) {
      const from = moveFrom(highlight.hint);
      const to = moveTo(highlight.hint);
      // **起点一定也有子**，所以两头都要标在棋子上，不能标在格子上 ——
      // 格子上的圆点半径只有约 15px，而棋子半径 28.5px，有子的格子那个点完全被盖住。
      // 终点是空格时才用格子圆点（那种情况下它看得见）。
      const fromEl = pieceEls.get(from);
      if (fromEl) fromEl.classList.add('xq-piece--hint');
      const toEl = pieceEls.get(to);
      if (toEl) toEl.classList.add('xq-piece--hint');
      else cells[to].classList.add('xq-cell--hint');
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
    // 否则会带着上一轮的「上一步 / 被将军 / 轮到我方 / 可吃 / 提示」显示出来。
    if (movedEl) {
      movedEl.classList.remove(
        'xq-piece--last', 'xq-piece--checked', 'xq-piece--turn',
        'xq-piece--capture', 'xq-piece--hint',
      );
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

  /**
   * 翻转棋盘。纯 CSS：整块棋盘转 180°，棋子和装饰文字各自转回来。
   *
   * 装饰文字（河界、纵线号）的反向转是**瞬间**的 —— 棋盘在 0.3 秒里慢慢转，
   * 文字却在第一帧就拧回了正着的角度，看起来像文字自己在打转。
   * 所以动画期间给外层挂上 is-flipping，把那几个字先藏起来，转完再淡回来
   * （CSS 里的 .xq-deco-text）。棋子的反向转同理，只是棋子是图形，
   * 转起来不像文字那么刺眼，就不折腾了。
   */
  function setFlipped(flipped) {
    const next = !!flipped;
    if (next !== isFlipped()) {
      wrapEl.classList.add('is-flipping');
      clearTimeout(flipTimer);
      flipTimer = setTimeout(() => wrapEl.classList.remove('is-flipping'), 320);
    }
    wrapEl.classList.toggle('is-flipped', next);
  }

  function isFlipped() {
    return wrapEl.classList.contains('is-flipped');
  }

  return { draw, drawAnimated, cellIndexOf, setFlipped, isFlipped, cells, boardEl };
}
