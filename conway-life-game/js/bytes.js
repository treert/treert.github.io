/**
 * Uint8Array <-> base64。persist.js（localStorage 存档）和 share.js（URL 分享）共用。
 *
 * 分块是因为 String.fromCharCode.apply 的参数个数有上限，
 * 几十 KB 一次性传进去会撑爆调用栈。
 */

const CHUNK = 0x8000;

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** @returns {Uint8Array|null} 解不开就返回 null，交给调用方决定怎么降级 */
export function fromBase64(str) {
  if (typeof str !== 'string') return null;
  let bin;
  try {
    bin = atob(str);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
