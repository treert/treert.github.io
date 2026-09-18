#!/usr/bin/env node
/**
 * 棋盘渲染的几何与 diff 冒烟测试。直接跑 Node，**不需要浏览器** ——
 * 用一个几十行的最小 DOM 替身把 renderer.js 跑起来。
 *
 * 用法：node chess/tools/test-renderer.mjs
 *
 * ## 为什么值得为它写一个 DOM 替身
 *
 * 「棋子摆在哪一格」这件事在浏览器里只能靠眼睛看，而它恰好最容易错：
 * **第 1 行必须落在最下面**（rank 0 → top 93.75%），上下写反的话整盘棋都是倒的，
 * 但界面看起来仍然「像个棋盘」，肉眼很容易放过。所以这里把几条几何钉死：
 *
 *   - 64 个格子的 DOM 顺序（第一行是第 8 行）、a1 是深格、a8 是浅格；
 *   - 每一排棋子的 left / top 百分比；
 *   - 补间走子时元素是**被搬过去**的（同一个对象，不是删了重建）——
 *     这一条坏了的表现是「棋子不滑了」，只有验证元素身份才看得出来；
 *   - 高亮类挂在格子还是挂在棋子上（可吃子必须挂在棋子上，否则会被棋子盖住）；
 *   - afterAnimation 的排队（AI 的应手就靠它）。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// === 最小 DOM 替身 ===
// 只实现 renderer.js 真正用到的那几个成员，不做通用 DOM。
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this._classes = new Set();
    this._text = '';
    this._html = '';
  }

  get classList() {
    const self = this;
    return {
      add(...names) { for (const n of names) self._classes.add(n); },
      remove(...names) { for (const n of names) self._classes.delete(n); },
      contains(name) { return self._classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !self._classes.has(name) : !!force;
        if (on) self._classes.add(name); else self._classes.delete(name);
        return on;
      },
    };
  }

  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }

  set textContent(v) { this.children = []; this._text = String(v ?? ''); }
  get textContent() { return this._text; }

  set innerHTML(v) { this._html = String(v ?? ''); }
  get innerHTML() { return this._html; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }

  contains(node) {
    for (let p = node; p; p = p.parentNode) if (p === this) return true;
    return false;
  }

  /** 只支持 `.class` 这一类选择器（renderer.js 只用这一种） */
  closest(sel) {
    const name = sel.replace(/^\./, '');
    for (let p = this; p; p = p.parentNode) if (p.classList.contains(name)) return p;
    return null;
  }
}

globalThis.document = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
};
// transitionDuration 是 renderer 唯一读的样式（补间时长从 CSS 上量）
globalThis.getComputedStyle = () => ({ transitionDuration: '0.18s' });

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const Pos = await load('position.js');
const Ru = await load('rules.js');
const { createRenderer, createPieceSvg } = await load('renderer.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const at = (name) => Pos.squareOf(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 棋盘上所有棋子的元素 */
const piecesOf = (board) => board.children.filter((c) => c.classList.contains('chess-piece'));
/** 某一排（top 百分比）上的棋子 */
const rowPieces = (board, top) => piecesOf(board).filter((c) => c.style.top === top);

/** 各排的 top 百分比（第 8 行在最上、第 1 行在最下） */
const TOP = {
  8: '6.25%', 7: '18.75%', 6: '31.25%', 5: '43.75%',
  4: '56.25%', 3: '68.75%', 2: '81.25%', 1: '93.75%',
};
const LEFT = { a: '6.25%', b: '18.75%', c: '31.25%', d: '43.75%', e: '56.25%', f: '68.75%', g: '81.25%', h: '93.75%' };

console.log('棋盘渲染测试\n');

const board = new El('div');
const wrap = new El('div');
// 骨架里的占位格：渲染器接管时应当把它们清掉
board.appendChild(new El('button'));
const r = createRenderer(board, wrap);

// --- 格子 ---
console.log('=== 64 个格子 ===');
{
  check('棋盘上建了 64 个格子', r.cells.length, 64);
  check('占位格被清掉了（没有多余的 button）',
    board.children.filter((c) => c.tagName === 'BUTTON').length, 64);
  check('DOM 顺序：第一个是第 8 行的 a 线', board.children[0].dataset.coord, 'a8');
  check('DOM 顺序：最后一个是第 1 行的 h 线', board.children[63].dataset.coord, 'h1');
  check('cells[0] 是 a1', r.cells[0].dataset.coord, 'a1');
  check('cells[63] 是 h8', r.cells[63].dataset.coord, 'h8');

  check('a1 是深格', r.cells[at('a1')].classList.contains('chess-cell--dark'), true);
  check('a8 是浅格', r.cells[at('a8')].classList.contains('chess-cell--light'), true);
  check('h1 是浅格', r.cells[at('h1')].classList.contains('chess-cell--light'), true);
  check('深格与浅格各 32 个',
    [r.cells.filter((c) => c.classList.contains('chess-cell--dark')).length,
      r.cells.filter((c) => c.classList.contains('chess-cell--light')).length],
    [32, 32]);

  check('cellIndexOf 认得出格子', r.cellIndexOf(r.cells[at('e4')]), at('e4'));
  check('cellIndexOf 对不相干的节点返回 -1', r.cellIndexOf(new El('div')), -1);
  check('棋子元素上找不到格子（点击由格子接管）', r.cellIndexOf(null), -1);
}

// --- 坐标 ---
console.log('\n=== 坐标 ===');
{
  const deco = board.children[64];
  const files = deco.children.find((c) => c.classList.contains('chess-files'));
  const ranks = deco.children.find((c) => c.classList.contains('chess-ranks'));
  check('下沿是 a..h', files.children.map((c) => c.textContent), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  check('左沿是 8..1（上到下）', ranks.children.map((c) => c.textContent), ['8', '7', '6', '5', '4', '3', '2', '1']);
}

// --- 摆初始局面 ---
console.log('\n=== 摆放棋子（第 1 行必须在最下面）===');
{
  r.draw(Pos.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
  check('摆了 32 枚棋子', piecesOf(board).length, 32);
  check('第 8 行 8 枚（黑方底线）', rowPieces(board, TOP[8]).length, 8);
  check('第 7 行 8 枚（黑兵）', rowPieces(board, TOP[7]).length, 8);
  check('第 2 行 8 枚（白兵）', rowPieces(board, TOP[2]).length, 8);
  check('第 1 行 8 枚（白方底线）', rowPieces(board, TOP[1]).length, 8);
  check('中间四排是空的',
    [3, 4, 5, 6].map((n) => rowPieces(board, TOP[n]).length), [0, 0, 0, 0]);

  check('第 1 行的 8 枚落在 a..h 的格心',
    rowPieces(board, TOP[1]).map((c) => c.style.left).sort(),
    Object.values(LEFT).sort());

  const rook = rowPieces(board, TOP[1]).find((c) => c.style.left === LEFT.a);
  check('a1 上是白车', rook.dataset.piece, '4');
  check('a1 的白车挂的是 white 类', rook.classList.contains('chess-piece--white'), true);
  const blackQueen = rowPieces(board, TOP[8]).find((c) => c.style.left === LEFT.d);
  check('d8 上是黑后', blackQueen.dataset.piece, '-5');
  check('黑子挂的是 black 类', blackQueen.classList.contains('chess-piece--black'), true);
  check('棋子用的是内联 SVG', rook.children[0].tagName, 'SVG');
  check('SVG 里有图形', rook.children[0].innerHTML.length > 20, true);
}

// --- 按格子 diff：同一个子要复用元素 ---
console.log('\n=== diff（复用的元素不能重建）===');
{
  const pos = Pos.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const whiteRook = rowPieces(board, TOP[1]).find((c) => c.style.left === LEFT.a);
  r.draw(pos);
  check('同一局面重绘：元素是原来那一个',
    rowPieces(board, TOP[1]).find((c) => c.style.left === LEFT.a) === whiteRook, true);
}

// --- 补间走子：元素被搬过去，而不是删了重建 ---
console.log('\n=== 走子补间 ===');
{
  const start = Pos.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const e2Pawn = rowPieces(board, TOP[2]).find((c) => c.style.left === LEFT.e);
  check('动手之前 e2 的兵在原地', e2Pawn.style.top, TOP[2]);

  const made = Ru.makeMove(start, Ru.encodeMove(at('e2'), at('e4'), 0, Ru.FLAG_DOUBLE));
  r.drawAnimated(made.pos, {}, { from: at('e2'), to: at('e4') });

  check('补间之后：还是同一个元素对象（没有重建）', e2Pawn.parentNode === board, true);
  check('补间之后：它的 top 变成第 4 行', e2Pawn.style.top, TOP[4]);
  check('补间之后：left 不变', e2Pawn.style.left, LEFT.e);
  check('补间之后：棋子总数不变', piecesOf(board).length, 32);
  check('补间进行中标记了 isAnimating', r.isAnimating(), true);

  // AI 的应手排在补间之后 —— 这条就是靠 afterAnimation 实现的
  let after = false;
  r.afterAnimation(() => { after = true; });
  check('补间没跑完时回调还没执行', after, false);
  await sleep(260);
  check('补间跑完之后回调执行了', after, true);
  check('跑完就不在动画中', r.isAnimating(), false);
}

// --- 吃子：被吃的元素要消失 ---
console.log('\n=== 吃子 ===');
{
  r.draw(Pos.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1'));
  check('摆好局面后共 4 枚子（两个王 + 两个兵）', piecesOf(board).length, 4);
  const target = rowPieces(board, TOP[5]).find((c) => c.style.left === LEFT.d);
  check('d5 上是黑兵', target.dataset.piece, '-1');

  const pos = Pos.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  const made = Ru.makeMove(pos, Ru.encodeMove(at('e4'), at('d5')));
  r.drawAnimated(made.pos, {}, { from: at('e4'), to: at('d5') });
  check('吃子之后少了一枚子', piecesOf(board).length, 3);
  check('被吃的元素已经脱离棋盘', target.parentNode, null);
  check('吃子者的新位置', rowPieces(board, TOP[5]).filter((c) => c.dataset.piece === '1').map((c) => c.style.left), [LEFT.d]);
}

// --- 高亮 ---
console.log('\n=== 高亮 ===');
{
  const pos = Pos.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  r.draw(pos, {
    last: Ru.encodeMove(at('b1'), at('c3')),
    selected: at('e4'),
    targets: [at('e5'), at('d5')],   // e5 是空格、d5 有子
    checked: at('e8'),
  });

  check('上一步的起点走格子底色', r.cells[at('b1')].classList.contains('chess-cell--last'), true);
  check('上一步的终点也走格子底色', r.cells[at('c3')].classList.contains('chess-cell--last'), true);
  check('选中的格', r.cells[at('e4')].classList.contains('chess-cell--selected'), true);
  check('可走的空格画格心圆点', r.cells[at('e5')].classList.contains('chess-cell--target'), true);
  check('可吃的子**不**在格子上画点（会被棋子盖住）',
    r.cells[at('d5')].classList.contains('chess-cell--target'), false);
  check('可吃的子画在棋子外圈',
    piecesOf(board).some((c) => c.classList.contains('chess-piece--capture') && c.style.left === LEFT.d), true);
  check('被将军的王：格子走危险色', r.cells[at('e8')].classList.contains('chess-cell--check'), true);
  check('被将军的王：棋子外圈也画', piecesOf(board).some((c) => c.classList.contains('chess-piece--check')), true);

  // 重绘要能把上一轮的标记摘干净（元素是复用的，不清就会留下幽灵高亮）
  r.draw(pos, {});
  check('重绘之后上一步的标记没了', r.cells[at('b1')].classList.contains('chess-cell--last'), false);
  check('重绘之后选中的标记没了', r.cells[at('e4')].classList.contains('chess-cell--selected'), false);
  check('重绘之后可吃的圈没了', piecesOf(board).some((c) => c.classList.contains('chess-piece--capture')), false);
  check('重绘之后将军的标记也没了',
    [r.cells[at('e8')].classList.contains('chess-cell--check'),
      piecesOf(board).some((c) => c.classList.contains('chess-piece--check'))],
    [false, false]);
}

// --- 提示高亮 ---
console.log('\n=== 提示高亮 ===');
{
  const pos = Pos.parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  r.draw(pos, { hint: Ru.encodeMove(at('e4'), at('e5')) });
  check('起点（有子）画在棋子上',
    piecesOf(board).some((c) => c.classList.contains('chess-piece--hint') && c.style.left === LEFT.e), true);
  check('终点是空格 → 画在格子上', r.cells[at('e5')].classList.contains('chess-cell--target'), true);
}

// --- 翻转 ---
console.log('\n=== 翻转 ===');
{
  check('初始没翻转', r.isFlipped(), false);
  r.setFlipped(true);
  check('翻转后 isFlipped 为 true', r.isFlipped(), true);
  check('翻转时外层挂上 is-flipped', wrap.classList.contains('is-flipped'), true);
  check('翻转动画期间挂 is-flipping（坐标先藏起来）', wrap.classList.contains('is-flipping'), true);
  await sleep(380);
  check('动画结束之后 is-flipping 摘掉', wrap.classList.contains('is-flipping'), false);
  check('is-flipped 留着', wrap.classList.contains('is-flipped'), true);
  r.setFlipped(false);
  check('翻回来', r.isFlipped(), false);
}

// --- 棋子图形 ---
console.log('\n=== 棋子图形 ===');
{
  const art = [1, 2, 3, 4, 5, 6].map((p) => createPieceSvg(p).innerHTML.length);
  check('六种棋子都有图形', art.every((n) => n > 20), true);
  check('黑白用的是同一份图形（颜色交给 CSS 变量）',
    createPieceSvg(5).innerHTML === createPieceSvg(-5).innerHTML, true);
  check('图形里带 viewBox', createPieceSvg(6).attrs.viewBox, '0 0 100 100');
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
