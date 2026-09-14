/**
 * 自定义结构库：用户在棋盘上框选一块存下来的结构，存在 localStorage 里。
 *
 * 和 persist.js 分开是因为生命周期不同——棋盘存档会被「重置 / 换尺寸」冲掉，
 * 结构库得一直留着。任何一步出错（隐私模式禁用 localStorage、配额满、存档损坏）
 * 都降级成「结构库是空的」，不能让页面起不来。
 *
 * 存进去的坐标会被重新归一化一遍：万一存档被手改坏了，至少还能画出来。
 */
import { normalizeCells } from './patterns.js';

const KEY = 'conway-life-game/custom/v1';
/** 上限。每个结构撑死几百字节，60 个远不到 localStorage 的配额，但挡住无限增长 */
export const MAX = 60;

let cache = null;

/** @returns {object[]} 结构数组；没有或读不出来时返回空数组 */
export function all() {
  if (cache) return cache;
  cache = read();
  return cache;
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) return [];
    return data.items.map(toPattern).filter(Boolean).slice(0, MAX);
  } catch {
    return [];
  }
}

/** 把一条存档记录还原成结构对象；坏数据返回 null */
function toPattern(item) {
  if (!item || typeof item.id !== 'string' || !Array.isArray(item.cells)) return null;
  const cells = item.cells.filter(
    (c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1]) && c[0] >= 0 && c[1] >= 0
  );
  if (!cells.length) return null;
  const n = normalizeCells(cells);
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name ? item.name : '未命名',
    category: 'custom',
    custom: true,
    createdAt: Number(item.createdAt) || 0,
    cells: n.cells,
    width: n.width,
    height: n.height,
  };
}

function write(list) {
  cache = list;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        items: list.map((p) => ({ id: p.id, name: p.name, cells: p.cells, createdAt: p.createdAt })),
      })
    );
    return true;
  } catch {
    return false; // 隐私模式 / 配额满，内存里留着，只是这次刷新后会丢
  }
}

export function get(id) {
  return all().find((p) => p.id === id) || null;
}

/** id 用时间戳，同一毫秒内连存两次时再加后缀 */
function uniqueId(list) {
  const base = `custom-${Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; list.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * 存一个新结构。
 * @param {string} name
 * @param {number[][]} cells 棋盘坐标或相对坐标都行，这里会归一化
 * @returns {object|null} 存好的结构；细胞为空或超出上限时返回 null
 */
export function add(name, cells) {
  if (!cells || !cells.length) return null;
  const list = all();
  if (list.length >= MAX) return null;

  const n = normalizeCells(cells);
  const pattern = {
    id: uniqueId(list),
    name: String(name || '').trim().slice(0, 20) || '未命名',
    category: 'custom',
    custom: true,
    createdAt: Date.now(),
    cells: n.cells,
    width: n.width,
    height: n.height,
  };
  write([...list, pattern]);
  return pattern;
}

export function remove(id) {
  const list = all();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  write(next);
  return true;
}

export function count() {
  return all().length;
}

export function isFull() {
  return all().length >= MAX;
}

/** 只在测试里用：丢掉内存缓存，强制下次从 localStorage 重读 */
export function resetCache() {
  cache = null;
}
