import { CONFIG } from './config.js';
import { CATEGORIES, patternsOfCategory } from './patterns.js';

const THUMB_MAX = 32;
const THUMB_PAD = 2;

/** 把一个结构画成小缩略图 */
function makeThumb(pattern) {
  const size = Math.max(2, Math.min(8, Math.floor(THUMB_MAX / Math.max(pattern.width, pattern.height))));
  const canvas = document.createElement('canvas');
  canvas.className = 'pat-thumb';
  canvas.width = pattern.width * size + THUMB_PAD * 2;
  canvas.height = pattern.height * size + THUMB_PAD * 2;
  canvas.draggable = false;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = CONFIG.ageColors[3];
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
   * @param {{onPick: (p:object)=>void, onDragStart: (p:object)=>void}} handlers
   */
  constructor(root, { onPick, onDragStart }) {
    this.root = root;
    this.onPick = onPick;
    this.onDragStart = onDragStart;
    this.items = new Map();
    this.selectedId = null;
  }

  render() {
    this.root.textContent = '';
    this.items.clear();

    for (const cat of CATEGORIES) {
      const list = patternsOfCategory(cat.id);
      if (!list.length) continue;

      const group = document.createElement('section');
      group.className = 'palette-group';

      const title = document.createElement('h3');
      title.className = 'palette-group-title';
      title.textContent = cat.name;

      const grid = document.createElement('div');
      grid.className = 'palette-grid';
      for (const p of list) grid.appendChild(this._makeItem(p));

      group.append(title, grid);
      this.root.appendChild(group);
    }
  }

  _makeItem(pattern) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pat';
    btn.dataset.id = pattern.id;
    btn.title = pattern.note ? `${pattern.name} · ${pattern.note}` : pattern.name;
    btn.appendChild(makeThumb(pattern));

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

    this.items.set(pattern.id, btn);
    return btn;
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
