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
    // 记下这个元素装的是哪个子。draw() 靠它判断「这个格子上的子换没换」，
    // 没换就把元素留着 —— 见 draw() 的注释。
    el.dataset.piece = String(piece);
    const span = document.createElement('span');
    span.textContent = (red ? RED_NAMES : BLACK_NAMES)[Math.abs(piece)];
    el.appendChild(span);
    return el;
  }

  /**
   * 摘掉上一轮的标记（格子上的 + 棋子上的）。
   *
   * 棋子那半圈**必须清**：元素现在是留着复用的（见 draw()），
   * 不清就会累积出「早就不是他的回合了、外圈还亮着」这种幽灵高亮 ——
   * 从前靠「每次重建所有棋子」顺带清掉了，现在得自己来。
   */
  // === 补间的「还在跑吗 / 跑完叫我」 ===
  // 给 main.js 用：AI 的应手要排在动画后面（不然棋子还在滑，AI 那步就落下来了）。
  // 用**定时器**而不是 transitionend：元素可能在这一轮里被删掉（吃子、跳转），
  // 事件就永远不来，AI 会一直卡着不动。
  let animTimer = 0;
  let animCallbacks = [];

  /**
   * 补间时长（毫秒）。**从棋子的 computed style 上量**，不在 JS 里再写一份：
   * CSS 是时长的唯一出处，写两份迟早对不上（也挡住「想调慢一点」的人改 CSS）。
   */
  function moveMs() {
    const el = pieceEls.values().next().value;
    if (!el) return 0;
    let ms = 0;
    for (const t of getComputedStyle(el).transitionDuration.split(',')) {
      const v = parseFloat(t) || 0;
      ms = Math.max(ms, t.trim().endsWith('ms') ? v : v * 1000);
    }
    return ms;
  }

  function scheduleAnimDone() {
    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      animTimer = 0;
      const fns = animCallbacks;
      animCallbacks = [];
      for (const fn of fns) fn();
    }, moveMs() + 20); // +20：过渡要等下一帧才真正开始，卡太紧会差一帧
  }

  /** 还有棋子在滑吗 */
  function isAnimating() {
    return animTimer !== 0;
  }

  /** 棋子滑到位之后执行 fn；没有补间时立刻执行 */
  function afterAnimation(fn) {
    if (!animTimer) {
      fn();
      return;
    }
    animCallbacks.push(fn);
  }

  function clearHighlights() {
    for (const cell of cells) {
      cell.classList.remove('xq-cell--last', 'xq-cell--target', 'xq-cell--hint', 'xq-cell--selected');
    }
    for (const el of pieceEls.values()) {
      el.classList.remove(
        'xq-piece--last', 'xq-piece--checked', 'xq-piece--turn',
        'xq-piece--capture', 'xq-piece--hint',
      );
    }
  }

  /** movedTo：正在滑过去的那一步的落点（-1 = 没有），用它替代 highlight.last 的终点 */
  function applyHighlights(pos, highlight, movedTo) {
    if (highlight.last) {
      // 起点现在是空的，高亮格子；终点被棋子盖住，所以圈画在棋子上
      cells[moveFrom(highlight.last)].classList.add('xq-cell--last');
      const target = movedTo >= 0 ? movedTo : moveTo(highlight.last);
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
   * **按格子 diff，不重建**：某个格子上还是同一个子，就把原来那个元素留着
   * （连着它身上正在跑的过渡一起留着）；只有新出现的子才建元素、消失的子才删掉。
   *
   * 为什么必须这样：元素的 left / top 是在插入 DOM **之前**设好的，所以新建的元素
   * 不会触发过渡 —— 靠这条，「棋子直接出现在该在的位置、不会满屏乱飞」是免费的。
   * 但全量重建的代价是**同一个任务里的第二次 draw 会把第一次正在做过渡的元素删掉重建**，
   * 过渡作废、棋子瞬间落位。谱载解法正好是这种情况：玩家走完一步，
   * requestAiMove() 里那句 applyMove(fromBook) 是同步执行的，两次 draw 挤在一个任务里。
   * （`tools/` 里没有 DOM 测试，这一条只能手动验：走一步后棋子的轨迹应该经过中间格。）
   *
   * animate 是**该滑过去的棋子**：`{ from, to }` 或数组（悔棋一次退两步时有两个）。
   * 传了就在 diff 之前把这些元素的键从 from 挪到 to —— 于是它们既不会被当成
   * 「消失的子」删掉、也不会被当成「新出现的子」重建，只改 left / top，过渡自然发生。
   * 不传就纯 diff：新棋子的位置在插入前定好，所以跳转时直接出现在该在的位置。
   *
   * 参数里没有对应的元素（比如被吃掉的子正好也是另一个 mover 的起点）时**跳过**，
   * 不报错：那种情况下这个子只能直接落位，不值得为它绕路。
   */
  function draw(pos, highlight = {}, animate = null) {
    // 先在**最前面**清标记，再挪元素、再 diff：这样复用的元素是干净的，
    // 下面 applyHighlights 只管往上加，不用操心上一轮还剩什么。
    clearHighlights();

    const movers = animate ? (Array.isArray(animate) ? animate : [animate]) : [];

    for (const mv of movers) {
      const el = pieceEls.get(mv.from);
      if (!el || mv.from === mv.to) continue;

      // 终点上那个（被吃的子）让位
      const captured = pieceEls.get(mv.to);
      if (captured) captured.remove();

      pieceEls.delete(mv.from);
      place(el, mv.to);
      pieceEls.set(mv.to, el);
    }

    for (let i = 0; i < CELLS; i++) {
      const v = pos.cells[i];
      const el = pieceEls.get(i);

      if (v === EMPTY) {
        if (el) {
          el.remove();
          pieceEls.delete(i);
        }
        continue;
      }
      // 还是同一个子：元素原样留着 —— **连 left / top 都不用重设**，
      // 重设同一个值虽然不会触发过渡，但省掉这一句，「没变就不碰」这条更干净
      if (el && Number(el.dataset.piece) === v) continue;
      if (el) el.remove();

      const fresh = pieceEl(v);
      place(fresh, i); // 插入前定好位置 → 不触发过渡
      boardEl.appendChild(fresh);
      pieceEls.set(i, fresh);
    }

    applyHighlights(pos, highlight, movers.length ? movers[movers.length - 1].to : -1);

    // 记下这段补间什么时候跑完（afterAnimation 用它排队，AI 的应手就靠这个）
    if (movers.length) scheduleAnimDone();
  }

  /** 走子后的重绘：带移动动画。movers 同 draw() 的第 3 个参数 */
  function drawAnimated(pos, highlight, movers) {
    draw(pos, highlight, movers);
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

  return {
    draw, drawAnimated, cellIndexOf, setFlipped, isFlipped,
    isAnimating, afterAnimation, cells, boardEl,
  };
}
