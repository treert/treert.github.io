/**
 * 把设置和棋盘状态存进 localStorage，刷新页面后能接着看。
 *
 * 只负责序列化，不碰 DOM，也不知道 UI 长什么样——main.js 把要存的东西打包好传进来，
 * 读的时候拿到同样形状的对象。任何一步出错（隐私模式禁用了 localStorage、配额满、
 * 存档格式过期）都静默降级成"没有存档"，不能让页面起不来。
 */
import { toBase64, fromBase64 } from './bytes.js';

const KEY = 'conway-life-game/v1';

/** 解不开或长度对不上就返回 null，让调用方把整份存档判为不可用 */
function decodeFixed(str, length) {
  const bytes = fromBase64(str);
  if (!bytes || bytes.length !== length) return null;
  return bytes;
}

/**
 * @param {object} data 要存的东西；其中 board 里的 cells / age 是 Uint8Array
 * @returns {boolean} 是否成功
 */
export function saveState(data) {
  try {
    const payload = { ...data };
    if (data.board) {
      payload.board = {
        cols: data.board.cols,
        rows: data.board.rows,
        generation: data.board.generation,
        cells: toBase64(data.board.cells),
        age: toBase64(data.board.age),
      };
    }
    localStorage.setItem(KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false; // 隐私模式 / 配额满，静默放弃
  }
}

/** @returns {object|null} 没有存档或存档损坏时返回 null */
export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.board && typeof data.board.cols === 'number' && typeof data.board.rows === 'number') {
      const size = data.board.cols * data.board.rows;
      const cells = decodeFixed(data.board.cells, size);
      const age = decodeFixed(data.board.age, size);
      if (!cells || !age) return null; // 棋盘数据坏了，整份存档作废
      data.board.cells = cells;
      data.board.age = age;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearState() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}
