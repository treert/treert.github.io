/**
 * 把棋盘编码进 URL hash，方便把当前局面发给别人。
 *
 * 编码方式：先取活细胞的下标，做差分，再用 varint 写成一串字节，最后 base64。
 * 稀疏棋盘（几个结构）通常只有几十字节；混沌棋盘会明显变长，所以调用方
 * 拿到结果后可以按长度决定要不要提醒用户。
 *
 * 用 hash 而不是 query：hash 不会发给服务器，静态托管（GitHub Pages）上更合适，
 * 而且不会影响任何服务端的缓存行为。
 */
import { toBase64, fromBase64 } from './bytes.js';

const VERSION = '1';
/** 上限，防止有人手搓一个天文数字的尺寸把页面撑爆 */
const MAX_CELLS = 1_000_000;

/** @returns {string} 不含前导 # 的 hash 内容 */
export function encodeBoard(board) {
  const bytes = [];
  let prev = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (!board.cells[i]) continue;
    let delta = i - prev;
    prev = i;
    while (delta >= 0x80) {
      bytes.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    bytes.push(delta);
  }

  const p = new URLSearchParams();
  p.set('v', VERSION);
  p.set('c', String(board.cols));
  p.set('r', String(board.rows));
  if (board.wrap) p.set('w', '1');
  if (bytes.length) p.set('d', toBase64(Uint8Array.from(bytes)));
  return p.toString();
}

/** @returns {{cols:number, rows:number, wrap:boolean, cells:Uint8Array}|null} */
export function decodeBoard(hash) {
  if (!hash || hash.length < 2) return null;
  try {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    if (p.get('v') !== VERSION) return null;

    const cols = Number(p.get('c'));
    const rows = Number(p.get('r'));
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
    if (cols < 1 || rows < 1 || cols * rows > MAX_CELLS) return null;

    const cells = new Uint8Array(cols * rows);
    const d = p.get('d');
    if (d) {
      const bytes = fromBase64(d);
      if (!bytes) return null;

      let prev = 0;
      let i = 0;
      while (i < bytes.length) {
        let delta = 0;
        let shift = 0;
        for (;;) {
          // shift > 28 说明这个 varint 长过头了，多半是数据坏了
          if (i >= bytes.length || shift > 28) return null;
          const b = bytes[i++];
          delta |= (b & 0x7f) << shift;
          shift += 7;
          if (!(b & 0x80)) break;
        }
        const idx = prev + delta;
        if (idx >= cells.length) return null;
        cells[idx] = 1;
        prev = idx;
      }
    }

    return { cols, rows, wrap: p.get('w') === '1', cells };
  } catch {
    return null;
  }
}
