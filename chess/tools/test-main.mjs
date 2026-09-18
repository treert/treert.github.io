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
 *
 * 另一类「只有界面层才看得出来」的是**三种特殊着法**（易位 / 吃过路兵 / 升变）：
 * 规则层有 perft 盯着，但升变浮层、易位的落点、过路兵吃掉的那个子都是界面层的事。
 * 文件最后有一节把它们逐个走一遍，判据是「打开保存 / 导入把当前局面读回来」。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';

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

  // 忠实还原真实 DOM 的语义：`textContent = 'x'` 是「子节点换成一个**文本节点**」，
  // `= ''` 才是「清空子节点」。早先的实现只记在 _text 里、顺手把 children 清空，
  // 于是「先写文字、再 appendChild 一个徽标」会把文字丢掉 ——
  // 而页签名 + 徽标在浏览器里就是并列的两个子节点（renderTabs 正是这么建的）。
  set textContent(v) {
    const s = String(v ?? '');
    this._text = s;
    this.children = s ? [textNode(s)] : [];
  }
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

/** 造一个文本节点（`textContent` 的 setter 与 document.createTextNode 共用） */
function textNode(text) {
  const e = new El('#text');
  e._text = String(text ?? '');
  return e;
}

const byId = new Map();
const winHandlers = {};

globalThis.document = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTextNode: (text) => textNode(text),
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
  localStorage: fakeStorage(),
  confirm: () => true,   // 删除自定义局面的确认框：测试里一律点「确定」
};

// transitionDuration 是 renderer 唯一读的样式
globalThis.getComputedStyle = () => ({ transitionDuration: '0.18s' });

/** 假 localStorage：存档与自定义局面都走它（测试不需要真的浏览器存储） */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

// 剪贴板与地址栏：复制那几个按钮要读它们（Node 里的 navigator 是只读的 getter，得定义属性）
let clipboard = '';
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (text) => { clipboard = text; } } },
  configurable: true,
  writable: true,
});
// 地址栏里带一段**分享局面**：启动时应当直接摆出它（分享优先于存档）
const SHARED_FEN = '4k3/8/8/8/8/8/8/3QK3 w - - 0 1';
Object.defineProperty(globalThis, 'location', {
  value: { href: `https://example.com/chess/?fen=${encodeURIComponent(SHARED_FEN)}`, pathname: '/chess/' },
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
// 页签上的条数徽标：页签名是一个文本节点、徽标是它的**兄弟**，
// 所以只能按 class 找，不能拿 children[0]（那读到的是名字）
const badgeOf = (tab) => tab.querySelector('.chess-tab-count').textContent;
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

// 棋子图形是独立文件（chess-icons/*.svg），main.js 在装配前会顶层 await 把它们读进来。
// Node 这边没有能读文件的 fetch，所以给个桩：按文件名从磁盘读**真素材**。
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const text = readFileSync(join(resolve(HERE, '../chess-icons'), name), 'utf8');
    return { ok: true, status: 200, text: async () => text };
  } catch {
    return { ok: false, status: 404, text: async () => '' };
  }
};

// worker.js 先加载（把 onmessage 挂到 self 上），再加载 main.js
await load('worker.js');
await load('main.js');

// --- 分享链接 ---
console.log('=== 分享链接（打开就是那个局面）===');
{
  check('地址栏里的参数立刻被抹掉（否则刷新会一直被拽回去）', replacedWith, '/chess/');
  check('摆出来的就是链接里的局面', piecesOnBoard().length, 3);
  check('d1 上是白后', pieceOn('d1').dataset.piece, '5');
  check('状态行说轮到白方（你）', statusText(), '轮到白方（你）');
  check('标题行标出这是临时局面', btn('btn-open-picker').textContent, '局面库·临时局面');
  check('棋盘上方给出说明', btn('endgame-goal').textContent, '临时局面 · 已走 0 步');
  check('「退出残局」按钮这时候是可见的', btn('btn-exit-endgame').hidden, false);

  // 从分享来的局面能退回标准开局（否则用户会卡在一个不知道从哪来的局面上）
  btn('btn-exit-endgame').fire('click');
  check('退回标准开局：32 枚棋子', piecesOnBoard().length, 32);
  check('标题行变回标准开局', btn('btn-open-picker').textContent, '局面库·标准开局');
  check('那一行说明收起来了', btn('endgame-goal').hidden, true);
  check('「退出残局」按钮也收起来', btn('btn-exit-endgame').hidden, true);
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

// --- 局面库 ---
console.log('\n=== 局面库（页签 / 列表 / 载入）===');
{
  btn('btn-open-picker').fire('click');
  check('弹窗打开了', btn('picker').open, true);

  const tabs = btn('endgame-tabs').children;
  check('页签名称', tabs.map((t) => t.textContent.replace(/\d+$/, '')),
    ['基础杀法', '兵类残局', '车兵类', '战术题', '自定义']);
  check('页签徽标是各页条数', tabs.map(badgeOf), ['9', '6', '5', '5', '0']);
  check('默认停在第一页', tabs[0].getAttribute('aria-selected'), 'true');

  const rowOf = (name) => btn('endgame-list').children.find((r) => r.textContent.includes(name));
  // 数行**必须认 class**：列表空着时 endgame-list 里放的是一条 <p> 空态提示，
  // 拿 children.length 当行数会把那条也算进去（踩过：0 命中读成「1 行」）
  const rows = () => btn('endgame-list').children.filter((r) => r.classList.contains('chess-endgame-row'));
  const badges = () => btn('endgame-tabs').children.map(badgeOf);
  const search = (word) => {
    btn('endgame-search').value = word;
    btn('endgame-search').fire('input');
  };

  check('第一页列出 9 行', rows().length, 9);
  check('行里带结论与难度', rowOf('后对单王').textContent.includes('先手胜·难度1'), true);

  // 过滤只在当前页签内生效。第一页（基础杀法）一条「兵」都没有，
  // 所以这里要验的正是「没命中时怎么说」，跨页签的线索则交给徽标
  search('兵');
  check('当前页没命中 → 一行都没有', rows().length, 0);
  check('空态里说清是过滤词没命中', btn('endgame-list').textContent.includes('没有匹配「兵」'), true);
  check('空态里指出去哪一页找', btn('endgame-list').textContent.includes('兵类残局 6 条'), true);
  check('徽标跟着变成各页命中数', badges(), ['0', '6', '2', '0', '0']);

  // 带着过滤词切页签：过滤词还活着，这一页 6 条全中
  tabs[1].fire('click');
  check('切页签后过滤词仍然生效', rows().length, 6);

  // 换个词：'车' 在四页里各有命中（第 3 页最多）
  search('车');
  check('过滤之后只剩匹配的行', rows().length, 1);
  check('别的页签的命中数也看得见', badges(), ['2', '1', '5', '2', '0']);

  // 清空 → 回到「当前页签的完整列表」
  btn('btn-clear-search').fire('click');
  check('清空过滤词之后恢复 6 行', rows().length, 6);
  check('清空之后徽标回到各页条数', badges(), ['9', '6', '5', '5', '0']);

  // 后面几步依赖「第一页」与「战术题」，先切回去
  tabs[0].fire('click');
  check('切回第一页又是 9 行', rows().length, 9);

  // 切页签
  tabs[3].fire('click');
  check('切到战术题', tabs[3].getAttribute('aria-selected'), 'true');
  check('战术题列出 5 行', btn('endgame-list').children.length, 5);

  // 载入一局
  rowOf('底线一步杀（车）').children[0].fire('click');
  check('载入之后弹窗自动关上', btn('picker').open, false);
  check('局面换成了那一局（6 枚棋子）', piecesOnBoard().length, 6);
  check('标题行显示局名', btn('btn-open-picker').textContent, '局面库·底线一步杀（车）');
  check('棋盘上方标出「有解法」', btn('endgame-goal').textContent.includes('有解法（1 步杀）'), true);
  check('轮到白方（你）', statusText(), '轮到白方（你）');

  // 谱载解法：提示一点就出，不用等引擎
  btn('btn-hint').fire('click');
  check('谱载提示不需要派发搜索（没有「思考中」）', btn('thinking').hidden, true);
  check('状态行标明这是谱载解法', statusText().includes('谱载解法'), true);
  check('提示画在棋盘上', piecesOnBoard().some((c) => c.classList.contains('chess-piece--hint')), true);

  // 按谱走完（a1a8 是一步杀）
  clickCell('a1');
  clickCell('a8');
  check('一步杀之后对局结束', statusText().startsWith('将死'), true);
  check('胜方是白方', statusText().includes('白方胜'), true);
}

// --- 退出残局 ---
console.log('\n=== 退出残局 / 临时局面 ===');
{
  btn('btn-exit-endgame').fire('click');
  check('回到标准开局', piecesOnBoard().length, 32);
  check('标题行变回标准开局', btn('btn-open-picker').textContent, '局面库·标准开局');
}

// --- 保存 / 导入 ---
console.log('\n=== 保存 / 导入局面 ===');
{
  btn('btn-open-io').fire('click');
  check('弹窗打开', btn('io-dialog').open, true);
  check('FEN 框里已经是当前局面（六段）', btn('fen-input').value.split(' ').length, 6);
  check('「载入到棋盘」这时候是灰的（框里就是当前局面）', btn('btn-load-fen').disabled, true);

  // 存一段坏 FEN：必须给出原因，而且不关弹窗
  btn('fen-input').value = '垃圾数据';
  btn('btn-import-fen').fire('click');
  check('坏 FEN 被拒并说明原因', btn('io-msg').textContent.includes('解析失败'), true);
  check('弹窗没有关掉', btn('io-dialog').open, true);

  // 重开一次弹窗再存。**importFen 只在成功时才清空 FEN 框**，
  // 上面那段坏数据还留在框里 —— 不重开就等于拿它去存。
  // 顺带验「打开时框里就是当前局面」这条在重开之后依然成立
  btn('btn-close-io').fire('click');
  btn('btn-open-io').fire('click');
  check('重开之后框里又是当前局面', btn('fen-input').value.split(' ').length, 6);
  check('重开之后旧的报错不再挂着', btn('io-msg').textContent, '');
  check('重开之后「载入到棋盘」又是灰的', btn('btn-load-fen').disabled, true);

  // 存当前局面为自定义（框里就是当前局面，不动它）
  btn('custom-name').value = '我的测试局面';
  btn('btn-import-fen').fire('click');
  check('存成功之后给出「去哪找」', btn('io-msg').textContent.includes('自定义'), true);
  check('存成功之后把 FEN 框清空', btn('fen-input').value, '');

  // 再存一次同一个局面 → 去重，并且把「原来叫什么」告诉用户
  btn('fen-input').value = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  btn('custom-name').value = '重复的';
  btn('btn-import-fen').fire('click');
  check('同一个局面存两遍会被去重', btn('io-msg').textContent.includes('已经存过'), true);
  check('去重时说出它原来叫什么', btn('io-msg').textContent.includes('我的测试局面'), true);

  // 载入一段别处的 FEN（只要能成立就摆上去，不进库）
  btn('fen-input').value = '8/8/8/4k3/4P3/8/8/7K w - - 0 1';
  btn('btn-load-fen').fire('click');
  check('载入到棋盘之后弹窗关上', btn('io-dialog').open, false);
  check('摆上的是那段 FEN（3 枚棋子）', piecesOnBoard().length, 3);
  check('标题行说这是临时局面', btn('btn-open-picker').textContent, '局面库·临时局面');
}

// --- 自定义局面：改名与删除 ---
console.log('\n=== 自定义局面（改名 / 删除）===');
{
  btn('btn-open-picker').fire('click');
  const tabs = btn('endgame-tabs').children;
  check('打开时自动切到「自定义」页签（刚才存过东西）', tabs[4].getAttribute('aria-selected'), 'true');
  check('自定义页签徽标为 1', badgeOf(tabs[4]), '1');

  const row = btn('endgame-list').children.find((r) => r.textContent.includes('我的测试局面'));
  check('列表里有那一条', !!row, true);
  check('自定义局面显示「自定义」而不是结论', row.textContent.includes('自定义'), true);
  check('行尾有两个按钮（改名的 ✎ 与删除的 ✕）', row.children.length, 3);

  row.children[1].fire('click');
  check('改名弹窗打开', btn('rename-dialog').open, true);
  check('预填了旧名字', btn('rename-input').value, '我的测试局面');
  btn('rename-input').value = '改过名字的局面';
  btn('btn-do-rename').fire('click');
  check('改名弹窗关上', btn('rename-dialog').open, false);
  check('列表上已经是新名字',
    btn('endgame-list').children.some((r) => r.textContent.includes('改过名字的局面')), true);

  const renamed = btn('endgame-list').children.find((r) => r.textContent.includes('改过名字的局面'));
  renamed.children[2].fire('click');
  check('删除之后列表空了（只剩空态提示）', btn('endgame-list').textContent.includes('还没有存过局面'), true);
  check('徽标回到 0', badgeOf(btn('endgame-tabs').children[4]), '0');
  btn('btn-close-picker').fire('click');
}

// --- 特殊着法：易位 / 吃过路兵 / 升变 ---
//
// 这三种交互以前一条断言都没有。规则层有 perft 与逐条断言盯着，但**界面层**那三条路径
// 各自有自己容易错的地方：易位走的是「王从 e1 到 g1」、吃过路兵吃的**不是目标格上的子**、
// 升变要先弹浮层问一句。所以这里用摆好的局面逐个走一遍，
// 并且**打开「保存 / 导入」把 FEN 框里的当前局面读回来当证据**（用户在界面上能看到的同一个东西）。
console.log('\n=== 特殊着法（易位 / 吃过路兵 / 升变）===');
{
  // 双人模式：走法完全确定，不会有 AI 应手把局面搅乱
  btn('two-player-toggle').checked = true;
  btn('two-player-toggle').fire('change');

  const loadFen = (fen) => {
    btn('btn-open-io').fire('click');
    btn('fen-input').value = fen;
    btn('btn-load-fen').fire('click');
  };
  const fenOf = () => {
    btn('btn-open-io').fire('click');
    const v = btn('fen-input').value;
    btn('btn-close-io').fire('click');
    return v;
  };

  // --- 短易位 ---
  loadFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  check('易位：先摆回标准开局', piecesOnBoard().length, 32);
  for (const [a, b] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']]) {
    clickCell(a);
    clickCell(b);
  }
  check('易位：走完三个回合，白方两个易位权都还在', fenOf().split(' ')[2], 'KQkq');

  clickCell('e1');
  // 着法编码里易位就是「王从 e1 走到 g1」，所以 g1 必须被标成可走点
  check('易位：选中王之后 g1 是可走点', cellOf('g1').classList.contains('chess-cell--target'), true);
  clickCell('g1');
  const castled = fenOf();
  check('易位：记作 O-O', moveSans(), ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
  check('易位：王到 g1、车从 h1 挪到 f1', castled.split(' ')[0].split('/')[7], 'RNBQ1RK1');
  check('易位：e1 与 h1 都空了', [pieceOn('e1'), pieceOn('h1')], [null, null]);
  check('易位：白方两个易位权都没了', castled.split(' ')[2], 'kq');

  // --- 吃过路兵 ---
  loadFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  // 和下面那条成对：同一个查找函数，走之前找得到、走之后找不到 ——
  // 否则「找不到」也可能只是查找本身失效，那样断言就是空的
  check('吃过路兵：走之前 d5 上是黑兵', pieceOn('d5').dataset.piece, '-1');
  clickCell('e5');
  check('吃过路兵：d6 是可走点（黑兵刚推两格留下的那个靶子）',
    cellOf('d6').classList.contains('chess-cell--target'), true);
  clickCell('d6');
  const ep = fenOf();
  check('吃过路兵：记作 exd6', moveSans(), ['exd6']);
  check('吃过路兵：白兵落在 d6', ep.split(' ')[0], '4k3/8/3P4/8/8/8/8/4K3');
  check('吃过路兵：被吃的黑兵在 d5 上消失（吃的不是目标格上的子）', pieceOn('d5'), null);
  check('吃过路兵：过路兵靶子这一步之后就作废', ep.split(' ')[3], '-');

  // --- 升变 ---
  // 先验取消路径：浮层关掉等于「没走这一步」，不是「先落子再补一个子」
  loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  clickCell('a7');
  clickCell('a8');
  check('升变：兵到末排先弹浮层、还没落子',
    [btn('promo-dialog').open, moveListText()], [true, '还没有走棋']);
  check('升变：四个选项是 后 / 车 / 象 / 马',
    btn('promo-choices').children.map((c) => c.textContent), ['后', '车', '象', '马']);
  check('升变：浮层开着的时候 a7 的兵还在原处', pieceOn('a7').dataset.piece, '1');
  btn('promo-dialog').fire('cancel'); // Esc 走的就是这条
  check('升变：Esc 取消 → 浮层关上、着法列表还是空的',
    [btn('promo-dialog').open, moveListText()], [false, '还没有走棋']);
  check('升变：取消之后棋盘没变（兵还在 a7、a8 上没子）',
    [pieceOn('a7').dataset.piece, pieceOn('a8')], ['1', null]);

  // 四种升变各走一次。按钮顺序 = config.js 的 PROMO_PIECES = 后 / 车 / 象 / 马，
  // 断言里的棋子编码也是 config.js 的那一套（2 马 / 3 象 / 4 车 / 5 后）
  const promos = [
    { i: 0, pick: '后', san: 'a8=Q+', placement: 'Q3k3/8/8/8/8/8/8/4K3', code: '5' },
    { i: 1, pick: '车', san: 'a8=R+', placement: 'R3k3/8/8/8/8/8/8/4K3', code: '4' },
    { i: 2, pick: '象', san: 'a8=B', placement: 'B3k3/8/8/8/8/8/8/4K3', code: '3' },
    { i: 3, pick: '马', san: 'a8=N', placement: 'N3k3/8/8/8/8/8/8/4K3', code: '2' },
  ];
  for (const p of promos) {
    loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    clickCell('a7');
    clickCell('a8');
    btn('promo-choices').children[p.i].fire('click');
    check(`升变：选「${p.pick}」→ ${p.san}（将军后缀只在该有的时候才有）`, moveSans(), [p.san]);
    check(`升变：选「${p.pick}」之后局面首段对得上`, fenOf().split(' ')[0], p.placement);
    check(`升变：a8 上那颗子的编码是 ${p.code}`, pieceOn('a8').dataset.piece, p.code);
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
