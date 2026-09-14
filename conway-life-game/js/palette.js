import { CATEGORIES, patternsOfCategory } from './patterns.js';

const THUMB_MAX = 32;
const THUMB_PAD = 2;

/** 把一个结构画成小缩略图 */
function makeThumb(pattern, colors) {
  const size = Math.max(2, Math.min(8, Math.floor(THUMB_MAX / Math.max(pattern.width, pattern.height))));
  const canvas = document.createElement('canvas');
  canvas.className = 'pat-thumb';
  canvas.width = pattern.width * size + THUMB_PAD * 2;
  canvas.height = pattern.height * size + THUMB_PAD * 2;
  canvas.draggable = false;

  const ctx = canvas.getContext('2d');
  // 取年龄色中间那一档：缩略图不表达年龄，只求在深浅两种底色上都看得清
  ctx.fillStyle = colors.age[3];
  for (const [x, y] of pattern.cells) {
    ctx.fillRect(THUMB_PAD + x * size, THUMB_PAD + y * size, size, size);
  }
  return canvas;
}

/**
 * 结构面板。只负责"展示"和"用户碰了哪个结构"，
 * 具体怎么放到棋盘上由 interaction.js 处理。
 */
export class Palette {
  /**
   * @param {HTMLElement} root
   * @param {{onPick:(p:object)=>void, onDragStart:(p:object)=>void, onDeleteCustom:(id:string)=>void, colors:object}} handlers
   *   colors 是当前主题的画布配色，缩略图要按它画
   */
  constructor(root, { onPick, onDragStart, onDeleteCustom, colors }) {
    this.root = root;
    this.onPick = onPick;
    this.onDragStart = onDragStart;
    this.onDeleteCustom = onDeleteCustom;
    this.colors = colors;
    this.items = new Map();
    this.selectedId = null;
  }

  /** 换主题时调用；缩略图是按颜色画进 canvas 的，得跟着重建（main.js 会再调一次 render） */
  setColors(colors) {
    this.colors = colors;
  }

  /**
   * @param {object[]} customList 自定义结构，排在所有内置分类前面
   */
  render(customList = []) {
    this.root.textContent = '';
    this.items.clear();
    const keep = this.selectedId;
    this.selectedId = null; // 重建之后旧的 DOM 引用已经失效，重新应用一次

    // 自己刚存的结构放最上面，不然得往下翻半天才找得到
    if (customList.length) this._appendGroup('我的结构', customList, true);
    for (const cat of CATEGORIES) {
      const list = patternsOfCategory(cat.id);
      if (list.length) this._appendGroup(cat.name, list, false);
    }

    if (keep) this.setSelected(keep);
  }

  _appendGroup(title, list, deletable) {
    const group = document.createElement('section');
    group.className = 'palette-group';

    const h = document.createElement('h3');
    h.className = 'palette-group-title';
    h.textContent = title;

    const grid = document.createElement('div');
    grid.className = 'palette-grid';
    for (const p of list) grid.appendChild(this._makeItem(p, deletable));

    group.append(h, grid);
    this.root.appendChild(group);
  }

  _makeItem(pattern, deletable) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pat';
    btn.dataset.id = pattern.id;
    btn.title = pattern.note ? `${pattern.name} · ${pattern.note}` : pattern.name;
    btn.appendChild(makeThumb(pattern, this.colors));

    const name = document.createElement('span');
    name.className = 'pat-name';
    name.textContent = pattern.name;
    btn.appendChild(name);

    btn.addEventListener('pointerdown', (ev) => this._onItemDown(ev, pattern));
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.onPick(pattern);
      }
    });

    if (deletable) btn.appendChild(this._makeDelete(pattern));

    this.items.set(pattern.id, btn);
    return btn;
  }

  /**
   * 删除按钮。用 span 而不是 button——父节点本身就是 <button>，嵌 button 是非法 HTML。
   * pointerdown 要拦下来，否则会连带触发父节点的"选中 + 开始拖拽"。
   */
  _makeDelete(pattern) {
    const del = document.createElement('span');
    del.className = 'pat-del';
    del.textContent = '×';
    del.title = `删除「${pattern.name}」`;
    del.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onDeleteCustom(pattern.id);
    });
    return del;
  }

  _onItemDown(ev, pattern) {
    if (ev.button !== 0) return;
    this.onPick(pattern);
    // 触屏不做拖拽，走"点选 -> 点棋盘"两步，免得跟面板滚动打架
    if (ev.pointerType === 'mouse') this.onDragStart(pattern);
  }

  setSelected(id) {
    if (this.selectedId === id) return;
    const prev = this.selectedId ? this.items.get(this.selectedId) : null;
    if (prev) prev.classList.remove('is-selected');
    this.selectedId = id;
    const next = id ? this.items.get(id) : null;
    if (next) next.classList.add('is-selected');
  }
}
