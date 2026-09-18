/**
 * 棋盘渲染。DOM + CSS，不是 Canvas。
 *
 * 选 DOM 而不是 Canvas 的直接收益（design.md §3.2）：
 *   - 颜色全部走 CSS 变量，深色模式自动生效，**不需要监听 themechange**
 *   - 命中测试用事件委托，免费
 *   - 64 格 + 32 子，DOM 完全够；格子是 <button>，键盘可遍历
 *
 * 国象比象棋简单的地方：**64 个格子本身就是答案** —— 不用像象棋那样在交叉点上拼十字线。
 *
 * 照搬象棋那三条（design.md §3.8，都是那边踩坑换来的结论）：
 *   1. 重绘按格子 diff，不重建（否则同一个任务里连着两次 draw 会把正在做过渡的元素删掉）；
 *   2. 补间跑完要有回调（AI 的应手排在动画后面）；
 *   3. 只有相邻一两步才做补间（跨多步跳转直接落位）。
 */

import { FILES, RANKS, CELLS, EMPTY } from './config.js';
import { fileOf, rankOf } from './position.js';
import { moveFrom, moveTo } from './rules.js';
// 棋子图形从 chess-icons/*.svg 读进来（Cburnett 棋子集）：读取与着色在 piece-art.js，
// 来路与署名见 chess-icons/README.md。不用 Unicode ♔♕♖♗♘♙ 的理由见 design.md §3.3
//（字形在有些平台会被渲染成 emoji，而且只能整体改 color、描不了边）。
import { pieceArt } from './piece-art.js';

/**
 * 图形没读出来时的占位：一个圆圈。
 *
 * **宁可画个明显的圆圈，也不要画「什么都没有」** —— 空着的话看起来像棋子丢了，
 * 而圆圈看起来像「这一格有东西，只是图形没加载」（状态行还会给出原因）。
 */
const FALLBACK_ART = '<circle cx="22.5" cy="22.5" r="15"'
  + ' style="fill:var(--chess-p-fill); stroke:var(--chess-p-stroke); stroke-width:1.5;"/>';

/**
 * 造一枚棋子的 SVG 元素。升变选择那个浮层也用这个（同一份图形，不抄第二遍）。
 *
 * `piece` 是**带符号**的棋子编码，直接拿它取图形 —— 这套棋子的黑白是两套路径
 *（细节不同，比如马的鬃毛），所以键也带符号。
 * 颜色不在这里管：图形自己的 `style` 里引的是 `--chess-p-fill` / `--chess-p-stroke`
 * 这两个变量，由外层的白 / 黑类定义。
 */
export function createPieceSvg(piece) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 45 45');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = pieceArt(piece) || FALLBACK_ART;
  return svg;
}

function decoText(text) {
  const el = document.createElement('span');
  el.className = 'chess-deco-text';
  el.textContent = text;
  return el;
}

/**
 * 棋盘装饰层：坐标。
 *
 * **坐标必须在棋盘盒子外面**（棋盘让出一圈 margin，这一层用负偏移站进去）——
 * 棋子占了一格约 80% 的宽度，把字母 / 数字放进格子里必然被压住
 * （象棋在同一个地方踩过坑，结论直接照搬）。
 *
 * 翻转时这一层跟着棋盘转 180°，里面的字各自反向转回来（见 style.css）。
 */
function buildDeco() {
  const deco = document.createElement('div');
  deco.className = 'chess-deco';
  deco.setAttribute('aria-hidden', 'true'); // 纯装饰，读屏不必念

  // 下沿 a..h（从左到右）
  const files = document.createElement('div');
  files.className = 'chess-coords chess-files';
  for (let f = 0; f < FILES; f++) files.appendChild(decoText('abcdefgh'[f]));

  // 左沿 8..1（从上到下：第 8 行在最上面，第 1 行在最下面）
  const ranks = document.createElement('div');
  ranks.className = 'chess-coords chess-ranks';
  for (let r = RANKS - 1; r >= 0; r--) ranks.appendChild(decoText(String(r + 1)));

  deco.append(files, ranks);
  return deco;
}

/**
 * 建好 64 个格子，返回一个渲染器。
 *
 * `wrapEl` 只用来挂 is-flipped 类 —— 翻转是纯 CSS 的（整块棋盘转 180°，
 * 棋子与坐标文字再转回来），点击事件跟着 DOM 走，
 * 所以 cellIndexOf 里**没有任何翻转换算**（这一条最容易写错，照搬象棋的结论）。
 */
export function createRenderer(boardEl, wrapEl) {
  // 骨架里的 64 个占位格（没有 JS 时也能看见棋盘）到此为止，由这里接管重建
  boardEl.textContent = '';

  const cells = new Array(CELLS);
  const pieceEls = new Map(); // 格子下标 -> 棋子元素
  let flipTimer = 0;

  // DOM 顺序 = 从上到下、从左到右，所以第一行是第 8 行（rank 7）
  for (let rank = RANKS - 1; rank >= 0; rank--) {
    for (let file = 0; file < FILES; file++) {
      const i = rank * FILES + file;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `chess-cell ${(file + rank) % 2 === 0 ? 'chess-cell--dark' : 'chess-cell--light'}`;
      cell.dataset.index = String(i);
      cell.dataset.coord = `${'abcdefgh'[file]}${rank + 1}`;
      cell.setAttribute('aria-label', cell.dataset.coord);
      boardEl.appendChild(cell);
      cells[i] = cell;
    }
  }
  boardEl.appendChild(buildDeco());

  /**
   * 格心 -> CSS 百分比。
   *
   * **第 1 行在最下面**（白方在下、黑方在上是通用摆法），所以纵坐标要翻过来：
   * rank 0（第 1 行）→ 93.75%，rank 7（第 8 行）→ 6.25%。
   */
  function place(el, idx) {
    el.style.left = `${((fileOf(idx) + 0.5) / FILES) * 100}%`;
    el.style.top = `${((RANKS - 1 - rankOf(idx) + 0.5) / RANKS) * 100}%`;
  }

  function pieceEl(piece) {
    const el = document.createElement('div');
    el.className = `chess-piece ${piece > 0 ? 'chess-piece--white' : 'chess-piece--black'}`;
    // 记下这个元素装的是哪个子。draw() 靠它判断「这个格子上的子换没换」（见 draw）
    el.dataset.piece = String(piece);
    el.appendChild(createPieceSvg(piece));
    return el;
  }

  // === 补间的「还在跑吗 / 跑完叫我」 ===
  // 给 main.js 用：AI 的应手要排在动画后面（不然棋子还在滑，AI 那步就落下来了）。
  // 用**定时器**而不是 transitionend：元素可能在这一轮里被删掉（吃子、跳转），
  // 事件就永远不来，AI 会一直卡着不动。
  let animTimer = 0;
  let animCallbacks = [];

  /**
   * 补间时长（毫秒）。**从棋子的 computed style 上量**，不在 JS 里再写一份：
   * CSS 是时长的唯一出处，写两份迟早对不上。
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

  function isAnimating() { return animTimer !== 0; }

  function afterAnimation(fn) {
    if (!animTimer) { fn(); return; }
    animCallbacks.push(fn);
  }

  /**
   * 摘掉上一轮的标记。
   *
   * 棋子那半圈**必须清**：元素现在是留着复用的（见 draw），
   * 不清就会累积出「早就不是那一步了、圈还亮着」这类幽灵高亮。
   */
  function clearHighlights() {
    for (const cell of cells) {
      cell.classList.remove('chess-cell--last', 'chess-cell--selected', 'chess-cell--target', 'chess-cell--check');
    }
    for (const el of pieceEls.values()) {
      el.classList.remove('chess-piece--capture', 'chess-piece--check', 'chess-piece--hint');
    }
  }

  function applyHighlights(pos, highlight = {}) {
    // 上一步：起点与终点都走格子底色。棋子只占格子中间约 80%，
    // 所以底色会露出一圈边框 —— 正好读成「这一格」。
    //
    // **终点恒取 `moveTo(last)`，不跟着补间走。** 象棋那边是「终点画在棋子上」，
    // 所以补间期间要改成棋子正在滑向的那一格；国象这边两格都画在**格子**上，
    // 而悔棋时正在滑的棋子是往反方向走的 —— 跟着它会高亮到一个跟「上一步」无关的格子上。
    if (highlight.last) {
      cells[moveFrom(highlight.last)].classList.add('chess-cell--last');
      cells[moveTo(highlight.last)].classList.add('chess-cell--last');
    }
    if (highlight.selected >= 0) cells[highlight.selected].classList.add('chess-cell--selected');

    for (const t of highlight.targets || []) {
      // 空格 → 格心小圆点；有子可吃 → 棋子外面一圈**圆形**描边。
      // **必须分开处理**：圆点画在格子上，而棋子不透明地盖住格心，那个点根本看不见。
      // 也不能用 outline 画「可吃」—— 那是矩形，套在 SVG 上会画成一个方框。
      const el = pieceEls.get(t);
      if (el) el.classList.add('chess-piece--capture');
      else cells[t].classList.add('chess-cell--target');
    }

    if (highlight.hint) {
      // 起点与终点都要标：起点一定有子（画圆环）、终点是空格时画格心圆点
      const from = moveFrom(highlight.hint);
      const to = moveTo(highlight.hint);
      const fromEl = pieceEls.get(from);
      if (fromEl) fromEl.classList.add('chess-piece--hint');
      const toEl = pieceEls.get(to);
      if (toEl) toEl.classList.add('chess-piece--hint');
      else cells[to].classList.add('chess-cell--target');
    }

    if (highlight.checked >= 0) {
      cells[highlight.checked].classList.add('chess-cell--check');
      const el = pieceEls.get(highlight.checked);
      if (el) el.classList.add('chess-piece--check');
    }
    // highlight.turn 刻意不处理：国象这边「轮到谁走」只体现在棋盘上方的状态行，
    // 不标满盘棋子（design.md §8.2 —— 象棋那圈紫环直接照搬会很难看）。
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
   * 过渡作废、棋子瞬间落位。
   *
   * `movers` 是**该滑过去的棋子**：`{ from, to }` 或数组（悔棋一次退两步时有两个）。
   * 传了就在 diff 之前把这些元素的键从 from 挪到 to —— 于是它们既不会被当成
   * 「消失的子」删掉、也不会被当成「新出现的子」重建，只改 left / top，过渡自然发生。
   * 不传就纯 diff：新棋子的位置在插入前定好，所以跳转时直接出现在该在的位置。
   */
  function draw(pos, highlight = {}, movers = null) {
    clearHighlights();

    const list = movers ? (Array.isArray(movers) ? movers : [movers]) : [];

    for (const mv of list) {
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
        if (el) { el.remove(); pieceEls.delete(i); }
        continue;
      }
      // 还是同一个子：元素原样留着 —— 连 left / top 都不用重设
      if (el && Number(el.dataset.piece) === v) continue;
      if (el) el.remove();

      const fresh = pieceEl(v);
      place(fresh, i); // 插入前定好位置 → 不触发过渡
      boardEl.appendChild(fresh);
      pieceEls.set(i, fresh);
    }

    applyHighlights(pos, highlight);

    // 记下这段补间什么时候跑完（afterAnimation 用它排队，AI 的应手就靠这个）
    if (list.length) scheduleAnimDone();
  }

  /** 走子后的重绘：带移动补间。movers 同 draw() 的第 3 个参数 */
  function drawAnimated(pos, highlight, movers) {
    draw(pos, highlight, movers);
  }

  /** 从事件目标找到格子下标；不是格子则返回 -1 */
  function cellIndexOf(node) {
    const cell = node && node.closest ? node.closest('.chess-cell') : null;
    if (!cell || !boardEl.contains(cell)) return -1;
    return Number(cell.dataset.index);
  }

  /**
   * 翻转棋盘。纯 CSS：整块棋盘转 180°，棋子和坐标文字各自转回来。
   *
   * 坐标文字的反向转是**瞬间**的 —— 棋盘在 0.3 秒里慢慢转，文字却在第一帧就拧回
   * 正着的角度，看起来像文字自己在打转。所以动画期间给外层挂上 is-flipping，
   * 把那几行字先藏起来，转完再淡回来（CSS 里的 .chess-deco-text）。
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

  function isFlipped() { return wrapEl.classList.contains('is-flipped'); }

  return {
    draw, drawAnimated, cellIndexOf, setFlipped, isFlipped,
    isAnimating, afterAnimation, cells, boardEl,
  };
}
