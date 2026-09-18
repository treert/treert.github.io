#!/usr/bin/env node
/**
 * 装配层（main.js + interaction.js + worker.js）的端到端冒烟测试。
 * 直接跑 Node，**不需要浏览器** —— 用一个最小 DOM 替身 + 一个进程内的 Worker 桥把整页跑起来。
 *
 * 用法：node chess/tools/test-main.mjs
 *
 * ## 为什么值得写这一层
 *
 * main.js 是全模块最「接线」的一块：一堆 getElementById、事件绑定、busy 状态、
 * Worker 往返。写错一个 id 或者少绑一个事件，逻辑层的单测一个都看不出来，
 * 而浏览器里表现成「某个按钮没反应」。这里用替身 DOM 把
 * 「点格子 → 走子 → 派发搜索 → Worker 回复 → 落子」整条链路真的跑一遍。
 *
 * 特别钉住 plan.md 里点名要验的那条：**翻转棋盘之后点击仍然正确** ——
 * 翻转是纯 CSS（整块棋盘 rotate 180°），点击映射不该做任何翻转换算。
 * 写反了的表现是「翻转后点 e2，动的却是对方那一排」。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// ============================================================
// 最小 DOM 替身（只实现本模块用到的成员，不做通用 DOM）
// ============================================================
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
    this._on = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.title = '';
    this.id = '';
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
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }

  set innerHTML(v) { this._html = String(v ?? ''); }
  get innerHTML() { return this._html; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
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

  closest(sel) {
    const name = sel.replace(/^\./, '');
    for (let p = this; p; p = p.parentNode) if (p.classList.contains(name)) return p;
    return null;
  }

  /** 只支持 `.cls` 与 `.cls[attr="val"]` 两种选择器（组件里只用这两种） */
  querySelector(sel) {
    const m = /^\.([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
    if (!m) return null;
    const [, cls, attr, val] = m;
    const walk = (node) => {
      for (const c of node.children) {
        if (c.classList.contains(cls) && (attr === undefined || c.dataset[attr] === val)) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); }

  fire(type, event = {}) {
    const e = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this._on[type] || []) fn(e);
  }

  click() { this.fire('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { globalThis.document.activeElement = this; }
  select() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
}

const byId = new Map();
const winHandlers = {};

globalThis.document = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (text) => {
    const e = new El('#text');
    e.textContent = text;
    return e;
  },
  getElementById: (id) => {
    if (!byId.has(id)) {
      const e = new El('div');
      e.id = id;
      byId.set(id, e);
    }
    return byId.get(id);
  },
  activeElement: null,
};

globalThis.window = {
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
  fire(type, event = {}) {
    for (const fn of winHandlers[type] || []) fn({ type, preventDefault() {}, ...event });
  },
  matchMedia: () => ({ matches: false }),
};

// transitionDuration 是 renderer 唯一读的样式
globalThis.getComputedStyle = () => ({ transitionDuration: '0.18s' });

// 剪贴板与地址栏：复制那几个按钮要读它们（Node 里的 navigator 是只读的 getter，得定义属性）
let clipboard = '';
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (text) => { clipboard = text; } } },
  configurable: true,
  writable: true,
});
// 地址栏里**故意带一段用不了的 FEN**：share 那条路要能优雅降级
//（Task 11 会把这里换成一段可用的局面，那时才有点击「退出残局」回标准开局的入口）。
Object.defineProperty(globalThis, 'location', {
  value: { href: `https://example.com/chess/?fen=${encodeURIComponent('你好世界')}`, pathname: '/chess/' },
  configurable: true,
  writable: true,
});
let replacedWith = null;
Object.defineProperty(globalThis, 'history', {
  value: { replaceState(_state, _title, url) { replacedWith = url; } },
  configurable: true,
  writable: true,
});

// === 进程内的 Worker 桥 ===
// 主线程 → Worker 走 setTimeout（真实 Worker 也是异步的）；Worker → 主线程直接回调。
// 这样连 worker.js 一起测到了，不用在测试里另抄一份「选着法」的逻辑。
let workerInstance = null;
globalThis.self = {
  onmessage: null,
  postMessage(msg) {
    if (workerInstance && workerInstance.onmessage) workerInstance.onmessage({ data: msg });
  },
};
globalThis.Worker = class {
  constructor() { workerInstance = this; this.onmessage = null; }
  postMessage(data) {
    setTimeout(() => {
      if (globalThis.self.onmessage) globalThis.self.onmessage({ data });
    }, 0);
  }
};

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

// === 测试用的小工具 ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 补间是 180ms（renderer 从 computed style 上量），AI 的应手排在补间之后 ——
// 所以「等 AI 走完」必须比补间长，否则只能看到「思考中」。
const waitTurn = () => sleep(260);
const board = () => globalThis.document.getElementById('board');
const btn = (id) => globalThis.document.getElementById(id);
const statusText = () => btn('status-text').textContent;
const moveListText = () => btn('move-list').textContent;
const cellOf = (coord) => board().children.find((c) => c.dataset.coord === coord);
const clickCell = (coord) => board().fire('click', { target: cellOf(coord) });
const piecesOnBoard = () => board().children.filter((c) => c.classList.contains('chess-piece'));
const arrowKeys = (key, extra = {}) => globalThis.window.fire('keydown', {
  key, target: new El('body'), ctrlKey: false, ...extra,
});

/** 收集着法列表里的 SAN */
function moveSans() {
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (c.classList.contains('chess-move')) out.push(c.textContent);
      walk(c);
    }
  };
  walk(btn('move-list'));
  return out;
}

/** 某一格上有没有棋子（按 left/top 百分比找，和渲染器用同一套坐标） */
function pieceOn(coord) {
  const file = 'abcdefgh'.indexOf(coord[0]);
  const rank = Number(coord[1]) - 1;
  const left = `${((file + 0.5) / 8) * 100}%`;
  const top = `${((7 - rank + 0.5) / 8) * 100}%`;
  return piecesOnBoard().find((c) => c.style.left === left && c.style.top === top) || null;
}

console.log('装配层端到端测试\n');

// worker.js 先加载（把 onmessage 挂到 self 上），再加载 main.js
await load('worker.js');
await load('main.js');

// --- 分享链接（坏参数）---
console.log('=== 分享链接（坏参数也要能用）===');
{
  check('坏链接：状态行第一句就是原因', statusText().includes('解析失败'), true);
  check('坏链接：地址栏里的参数立刻被抹掉（否则刷新会一直被拽回去）', replacedWith, '/chess/');
  check('坏链接：仍然从标准开局开始（32 枚棋子）', piecesOnBoard().length, 32);
  check('坏链接：不影响标题行的局面名', btn('btn-open-picker').textContent, '局面库·标准开局');

  // 那只是一句提示，下一次刷新就会被覆盖 —— 这是有意的（提示不该赖在状态行上）
  clickCell('a2');
  arrowKeys('Escape');
  check('下一次刷新之后状态行恢复正常', statusText(), '轮到白方（你）');
}

// --- 初始装配 ---
console.log('\n=== 初始装配 ===');
{
  check('棋盘摆了 32 枚棋子', piecesOnBoard().length, 32);
  check('状态行显示轮到白方（你）', statusText(), '轮到白方（你）');
  check('挡位下拉有 4 个选项',
    btn('level-select').children.map((o) => o.textContent), ['入门', '初级', '中级', '高级']);
  check('着法列表是空状态', moveListText(), '还没有走棋');
  check('标题行的局面库按钮写的是标准开局', btn('btn-open-picker').textContent, '局面库·标准开局');
  check('默认没有翻转（执白）', btn('board-wrap').classList.contains('is-flipped'), false);
  check('悔棋按钮一开始是灰的', btn('btn-undo').disabled, true);
  check('A1 上是白车、E1 上是白王',
    [pieceOn('a1').dataset.piece, pieceOn('e1').dataset.piece], ['4', '6']);
}

// --- 点选与走子（人机模式）---
console.log('\n=== 点选 → 走子 → AI 应手 ===');
{
  clickCell('e2');
  check('选中 e2 的兵', cellOf('e2').classList.contains('chess-cell--selected'), true);
  check('e3 / e4 被标成可走（格心圆点）',
    [cellOf('e3').classList.contains('chess-cell--target'),
      cellOf('e4').classList.contains('chess-cell--target')], [true, true]);
  check('e5 不该被标成可走（兵不能走两步以上）',
    cellOf('e5').classList.contains('chess-cell--target'), false);
  check('对方的棋子不算可吃（开局没有可吃的）',
    cellOf('e7').classList.contains('chess-cell--target'), false);

  clickCell('e4');
  check('走子之后着法列表出现 e4', moveSans(), ['e4']);
  check('棋子总数不变（32 枚）', piecesOnBoard().length, 32);
  check('e2 空了、e4 上有子', [pieceOn('e2'), !!pieceOn('e4')], [null, true]);
  check('AI 开始思考', statusText(), '轮到黑方 · AI 思考中');
  check('思考提示可见', btn('thinking').hidden, false);
  check('AI 思考期间工具栏置灰', btn('btn-undo').disabled, true);

  // AI 那一步要等棋子滑完才落下（renderer 的 afterAnimation），所以这里要等过补间
  await waitTurn();
  check('AI 走了一步（着法列表两个半回合）', moveSans().length, 2);
  check('AI 在己方半场落子（黑白各 16 枚都在）',
    [piecesOnBoard().filter((c) => c.classList.contains('chess-piece--white')).length,
      piecesOnBoard().filter((c) => c.classList.contains('chess-piece--black')).length],
    [16, 16]);
  check('思考提示收起来了', btn('thinking').hidden, true);
  check('又轮到白方（你）', statusText(), '轮到白方（你）');
  check('上一步的起点终点被高亮',
    board().children.filter((c) => c.classList.contains('chess-cell--last')).length, 2);
}

// --- 悔棋（人机模式退两步）---
console.log('\n=== 悔棋 ===');
{
  btn('btn-undo').fire('click');
  check('人机模式一次退两步（棋盘回到开局）', [!!pieceOn('e2'), !!pieceOn('e4')], [true, false]);
  check('着法**没有**被删掉（还能重做）', btn('btn-redo').disabled, false);
  // 悔棋只挪游标，后面还有着法 → 状态行会带上「正在回看」的前缀（这是对的）
  check('状态回到轮到白方（你）', statusText().endsWith('轮到白方（你）'), true);
  check('并且标出了正在回看', statusText().startsWith('正在回看开局'), true);
  check('着法列表还留着那两步（悔棋只挪游标）', moveSans().length, 2);

  btn('btn-redo').fire('click');
  check('重做回到最新局面', [!!pieceOn('e2'), !!pieceOn('e4')], [false, true]);

  btn('btn-reset').fire('click');
  await waitTurn();
  check('重开之后着法列表空了', moveListText(), '还没有走棋');
  check('重开之后 32 枚棋子各就各位', piecesOnBoard().length, 32);
}

// --- 双人对弈 ---
console.log('\n=== 双人对弈 ===');
{
  btn('two-player-toggle').checked = true;
  btn('two-player-toggle').fire('change');
  check('双人模式下「执子」被禁用', btn('side-select').disabled, true);

  clickCell('e2');
  clickCell('e4');
  check('轮到黑方（不再标「你 / AI」）', statusText(), '轮到黑方');
  check('黑方走子时不派发搜索（没有「思考中」）', btn('thinking').hidden, true);

  clickCell('e7');
  clickCell('e5');
  check('两个半回合', moveSans(), ['e4', 'e5']);
  check('轮到白方', statusText(), '轮到白方');
  check('上一步高亮在 e5 上', cellOf('e5').classList.contains('chess-cell--last'), true);

  btn('btn-undo').fire('click');
  check('双人模式只退一步（着法还在，游标回到 1）', moveSans().length, 2);
  check('退完之后轮到黑方', statusText().endsWith('轮到黑方'), true);
  check('标志是「回看第 1 步」', statusText().startsWith('正在回看第 1 步'), true);
  btn('btn-redo').fire('click');
  check('重做回到轮到白方', statusText(), '轮到白方');
}

// --- 翻转之后点击仍然正确 ---
console.log('\n=== 翻转 ===');
{
  btn('btn-flip').fire('click');
  check('棋盘被翻转了', btn('board-wrap').classList.contains('is-flipped'), true);

  // 翻转是纯 CSS。点击映射**不该**做任何翻转换算 ——
  // 点 d2 仍然必须选中 d2 的白兵，可走的是 d3 / d4（而不是 d6 / d5）
  clickCell('d2');
  check('翻转后点 d2 仍然选中 d2', cellOf('d2').classList.contains('chess-cell--selected'), true);
  check('可走的是 d3 / d4（不是对方的 d6 / d5）',
    [cellOf('d3').classList.contains('chess-cell--target'),
      cellOf('d4').classList.contains('chess-cell--target'),
      cellOf('d6').classList.contains('chess-cell--target')],
    [true, true, false]);

  clickCell('d4');
  check('翻转后走子照样成功', moveSans(), ['e4', 'e5', 'd4']);

  btn('btn-flip').fire('click');
  check('翻回来了', btn('board-wrap').classList.contains('is-flipped'), false);
}

// --- 键盘 ---
console.log('\n=== 键盘 ===');
{
  arrowKeys('z', { ctrlKey: true });
  check('Ctrl+Z 悔棋生效', statusText().endsWith('轮到白方'), true);
  check('上一步高亮回到 e5（不是正在滑回起点的 d4）',
    [cellOf('e5').classList.contains('chess-cell--last'),
      cellOf('d4').classList.contains('chess-cell--last')], [true, false]);
  check('着法列表没被删（还在等着重做）', moveSans().length, 3);

  arrowKeys('f');
  check('F 翻转棋盘', btn('board-wrap').classList.contains('is-flipped'), true);
  arrowKeys('f');
  check('再按一次翻回来', btn('board-wrap').classList.contains('is-flipped'), false);

  clickCell('c2');
  check('选中 c2', cellOf('c2').classList.contains('chess-cell--selected'), true);
  arrowKeys('Escape');
  check('Esc 取消选中', cellOf('c2').classList.contains('chess-cell--selected'), false);
}

// --- 点着法列表回看 ---
console.log('\n=== 点着法列表回看 ===');
{
  const spans = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (c.classList.contains('chess-move')) spans.push(c);
      walk(c);
    }
  };
  walk(btn('move-list'));
  check('列表里有三个着法', spans.map((s) => s.textContent), ['e4', 'e5', 'd4']);

  spans[0].fire('click');
  check('点第 1 步 → 跳到第 1 步', statusText().startsWith('正在回看第 1 步'), true);
  check('回看时状态行仍然写着轮到谁', statusText().includes('轮到黑方'), true);

  spans[2].fire('click');
  check('点最后一步 → 不在回看状态', statusText().startsWith('正在回看'), false);

  // 回看状态下走新着法会截断后面的分支
  spans[0].fire('click');
  clickCell('d7');
  clickCell('d5');
  check('回看时走新着法 → 分支被截断', moveSans(), ['e4', 'd5']);
  check('回到正常状态（不在回看）', statusText().startsWith('正在回看'), false);
}

// --- 关掉双人模式 ---
console.log('\n=== 切回人机模式 ===');
{
  btn('two-player-toggle').checked = false;
  btn('two-player-toggle').fire('change');
  check('「执子」重新可用', btn('side-select').disabled, false);
  check('状态行重新标出「你 / AI」', statusText(), '轮到白方（你）');
  check('「执子」下拉里是白方', btn('side-select').value, '1');
}

// --- 提示 ---
console.log('\n=== 提示 ===');
{
  // 提示本身也是一次搜索。用入门挡位，几毫秒就回来（中级要等上百毫秒）
  btn('level-select').value = 'novice';
  btn('level-select').fire('change');

  const before = moveSans();
  btn('btn-hint').fire('click');
  check('提示期间按钮置灰', btn('btn-hint').disabled, true);
  check('提示期间显示「思考中」', btn('thinking').hidden, false);

  await waitTurn();
  check('提示**不会**替用户落子（着法列表没变）', moveSans(), before);
  check('棋盘上画出了提示高亮',
    piecesOnBoard().some((c) => c.classList.contains('chess-piece--hint')), true);
  check('提示结束之后按钮恢复', btn('btn-hint').disabled, false);

  // 点一下棋盘就把提示收掉（提示是「当前这一步」的建议，走一步就过期了）
  clickCell('a2');
  check('点格子之后提示高亮被清掉',
    piecesOnBoard().some((c) => c.classList.contains('chess-piece--hint')), false);
  arrowKeys('Escape');
}

// --- 单步回看 ---
console.log('\n=== 单步回看（上一步 / 下一步）===');
{
  check('已经在最后一步时「下一步」是灰的', btn('btn-step-fwd').disabled, true);

  btn('btn-step-back').fire('click');
  check('退一步：状态行标出正在回看', statusText().startsWith('正在回看第 1 步'), true);
  check('「下一步」变得可用', btn('btn-step-fwd').disabled, false);

  btn('btn-step-back').fire('click');
  check('再退一步到开局', statusText().startsWith('正在回看开局'), true);
  check('到开局时「上一步」是灰的', btn('btn-step-back').disabled, true);

  arrowKeys('ArrowRight');
  check('按 → 前进一步', statusText().startsWith('正在回看第 1 步'), true);
  arrowKeys('ArrowRight');
  check('再按 → 回到最后一步', statusText().startsWith('正在回看'), false);
  check('回到最后「下一步」又灰了', btn('btn-step-fwd').disabled, true);

  // 回看单步和「悔棋」不是一回事：着法一个都没丢
  check('着法列表始终是完整的', moveSans(), ['e4', 'd5']);
}

// --- 复制 ---
console.log('\n=== 复制 ===');
{
  clipboard = '';
  btn('btn-copy-fen').fire('click');
  await sleep(10);
  check('复制 FEN：是规范化的六段 FEN', clipboard.split(' ').length, 6);
  check('复制 FEN：就是当前局面', clipboard.startsWith('rnbqkbnr/'), true);
  check('复制 FEN：按钮上给了反馈', btn('btn-copy-fen').textContent, '已复制');

  clipboard = '';
  btn('btn-copy-moves').fire('click');
  await sleep(10);
  check('复制着法：一行一个回合', clipboard, '1. e4 d5');
  check('复制着法：按钮上给了反馈', btn('btn-copy-moves').textContent, '已复制');

  clipboard = '';
  btn('btn-copy-url').fire('click');
  await sleep(10);
  check('复制链接：是绝对地址', clipboard.startsWith('https://example.com/chess/'), true);
  check('复制链接：带上了 fen 参数', clipboard.includes('?fen='), true);
  check('复制链接：链接里没有裸空格', clipboard.includes(' '), false);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
