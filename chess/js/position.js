/**
 * 局面表示与 FEN 读写。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 局面对象：
 *   {
 *     cells: Int8Array(64),  // idx = rank * 8 + file（rank 0 = 白方底线）
 *     side: 1 | -1,          // 轮走方（1 = 白）
 *     castling: number,      // 位掩码，见 config.js 的 CASTLE_*
 *     ep: number,            // 过路兵目标格下标，-1 表示没有
 *     halfmove: number,      // 50 步规则计数（半步）
 *     fullmove: number,      // 回合数（黑方走完 +1）
 *   }
 *
 * **易位权与过路兵必须进局面对象**：它们不是「能用棋盘推导出来」的状态 ——
 * 车还在原位但权可能已经丢了（王动过一次）；上一手是两格兵走才能吃过路兵。
 * FEN 里这两项一丢，三次重复判定和存档恢复都会错。
 *
 * cells 是**值**而不是共享状态：clonePosition() 就是一次 64 字节拷贝，
 * 所以试走、置换表、存档可以随便复制，不用担心共享引用。
 */

import {
  FILES, RANKS, CELLS, EMPTY, FEN_OF_PIECE, PIECE_OF_FEN, START_FEN,
  WHITE, BLACK,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
} from './config.js';

export const FILE_LETTERS = 'abcdefgh';
/** 易位权按 FEN 的 `KQkq` 顺序输出 */
const CASTLE_CHARS = [
  [CASTLE_WK, 'K'], [CASTLE_WQ, 'Q'], [CASTLE_BK, 'k'], [CASTLE_BQ, 'q'],
];

export function index(file, rank) { return rank * FILES + file; }
export function fileOf(idx) { return idx % FILES; }
export function rankOf(idx) { return (idx - (idx % FILES)) / FILES; }
export function onBoard(file, rank) { return file >= 0 && file < FILES && rank >= 0 && rank < RANKS; }

/** 下标 → 代数坐标（`e4`）。记谱、分享、解法数据都用它 */
export function squareName(idx) { return `${FILE_LETTERS[fileOf(idx)]}${rankOf(idx) + 1}`; }

/** 代数坐标 → 下标；格式不对返回 -1（调用方自己决定怎么报错） */
export function squareOf(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const file = FILE_LETTERS.indexOf(name[0]);
  const rank = name.charCodeAt(1) - 49; // '1' -> 0
  return onBoard(file, rank) ? index(file, rank) : -1;
}

/** 易位权掩码 → FEN 里那一段（没有权就写 `-`） */
export function castlingToFen(mask) {
  const s = CASTLE_CHARS.filter(([bit]) => mask & bit).map(([, ch]) => ch).join('');
  return s || '-';
}

function parseCastling(text) {
  if (text === '-' || text === '') return 0;
  let mask = 0;
  for (const ch of text) {
    const found = CASTLE_CHARS.find(([, c]) => c === ch);
    if (!found) throw new Error(`FEN 易位权里出现无法识别的字符「${ch}」`);
    mask |= found[0];
  }
  return mask;
}

/** 棋盘那一段（8 行，从第 8 行往下）。toFen 与局面签名共用 */
export function boardFen(cells) {
  const lines = [];
  for (let rank = RANKS - 1; rank >= 0; rank--) {
    let line = '';
    let empty = 0;
    for (let file = 0; file < FILES; file++) {
      const v = cells[index(file, rank)];
      if (v === EMPTY) { empty++; continue; }
      if (empty) { line += empty; empty = 0; }
      line += FEN_OF_PIECE[v + 6];
    }
    if (empty) line += empty;
    lines.push(line);
  }
  return lines.join('/');
}

/**
 * 解析 FEN。
 *
 * **少写后两段（甚至后四段）时要能容错**：手写的 FEN 常常只有「棋盘 轮走方」两段，
 * 缺的按 `- - 0 1` 补上。所以这里不要求 6 段，只要求前两段在。
 *
 * 解析失败抛 Error 而不是返回 null —— 调用方（残局库校验、粘贴导入、分享链接）
 * 要能告诉用户到底哪里不对，抛异常才带得上原因。
 */
export function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`FEN 至少需要「棋盘 轮走方」两个字段：${fen}`);

  const rows = parts[0].split('/');
  if (rows.length !== RANKS) throw new Error(`FEN 棋盘应为 ${RANKS} 行，实际 ${rows.length} 行`);

  const cells = new Int8Array(CELLS);
  for (let r = 0; r < RANKS; r++) {
    const rank = RANKS - 1 - r; // FEN 第一行是第 8 行
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { file += Number(ch); continue; }
      const piece = PIECE_OF_FEN[ch];
      if (piece === undefined) throw new Error(`FEN 第 ${r + 1} 行出现无法识别的字符「${ch}」`);
      if (file >= FILES) throw new Error(`FEN 第 ${r + 1} 行超出 ${FILES} 列`);
      cells[index(file, rank)] = piece;
      file++;
    }
    if (file !== FILES) throw new Error(`FEN 第 ${r + 1} 行共 ${file} 列，应为 ${FILES} 列`);
  }

  const side = parts[1] === 'w' ? WHITE : parts[1] === 'b' ? BLACK : null;
  if (side === null) throw new Error(`FEN 轮走方应为 w 或 b，实际「${parts[1]}」`);

  const castling = parseCastling(parts[2] ?? '-');

  let ep = -1;
  const epText = parts[3] ?? '-';
  if (epText !== '-' && epText !== '') {
    ep = squareOf(epText);
    if (ep < 0) throw new Error(`FEN 过路兵目标格「${epText}」不是合法格子`);
  }

  // 后两段写坏了就当没写（它们只影响 50 步计数与显示，不影响局面本身）
  const halfmove = toCount(parts[4], 0);
  const fullmove = Math.max(1, toCount(parts[5], 1));

  return { cells, side, castling, ep, halfmove, fullmove };
}

function toCount(text, dflt) {
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}

/** 生成 FEN。与 parseFen 互逆（parseFen(toFen(pos)) 还原出同一个局面） */
export function toFen(pos) {
  const ep = pos.ep >= 0 ? squareName(pos.ep) : '-';
  return `${boardFen(pos.cells)} ${pos.side === WHITE ? 'w' : 'b'} `
    + `${castlingToFen(pos.castling)} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/**
 * 规范化：去掉多余空白、补齐缺失字段、统一大小写与写法。
 *
 * 「框里就是当前局面」这类判等必须用规范化之后的字符串比 ——
 * 从别处粘来的 FEN 尾部可能写 `w - - 12 34`，直接比字符串会判成「不一样」，
 * 其实载入进去是同一个局面。
 */
export function normalizeFen(fen) { return toFen(parseFen(fen)); }

export function startPosition() { return parseFen(START_FEN); }

/** 深拷贝。64 字节的拷贝比任何「写时复制」方案都便宜，也不需要小心共享 */
export function clonePosition(pos) {
  return {
    cells: pos.cells.slice(),
    side: pos.side,
    castling: pos.castling,
    ep: pos.ep,
    halfmove: pos.halfmove,
    fullmove: pos.fullmove,
  };
}

/**
 * 局面签名：棋盘 + 轮走方 + 易位权 + 过路兵目标。
 *
 * 用于「三次重复判和」。**不含半步计数与回合数** —— 它们每步都变，
 * 带上的话同一个局面永远比不出重复（这一条象棋那边踩过）。
 *
 * 过路兵带上：刚走完两格兵和「同样子力但没有过路兵机会」是两个不同局面
 * （FIDE 的重复判定就是这么定义的）。
 */
export function positionSignature(pos) {
  const ep = pos.ep >= 0 ? squareName(pos.ep) : '-';
  return `${boardFen(pos.cells)} ${pos.side === WHITE ? 'w' : 'b'} ${castlingToFen(pos.castling)} ${ep}`;
}

// === Zobrist 哈希 ===
//
// 用 32 位整数（不是 64 位）：搜索节点数在 10^6 量级，
// 10^6 / 2^32 ≈ 0.02% 的碰撞概率，而置换表命中时还会校验着法合法性，
// 所以碰撞最多导致缓存失效，不会产生错误着法。
//
// 随机数用**固定种子的 xorshift32** 生成 —— 必须是确定性的，否则同一个局面的哈希
// 每次刷新都不一样，测试没法断言、置换表也跨不了会话（design.md §4.4）。

const HASH_SEED = 0x9e3779b9;
let PIECE_HASH = null;
let SIDE_HASH = 0;
let CASTLE_HASH = null;
let EP_HASH = null;

function initHash() {
  if (PIECE_HASH) return;
  let s = HASH_SEED >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };

  // 13 行对应棋子编码 -6..6（行号 = 编码 + 6）；行号 6 是空位，整行留 0
  PIECE_HASH = [];
  for (let piece = -6; piece <= 6; piece++) {
    const row = new Uint32Array(CELLS);
    if (piece !== EMPTY) for (let i = 0; i < CELLS; i++) row[i] = next();
    PIECE_HASH.push(row);
  }
  SIDE_HASH = next();
  CASTLE_HASH = new Uint32Array(16);
  for (let m = 0; m < 16; m++) CASTLE_HASH[m] = next();
  EP_HASH = new Uint32Array(FILES);
  for (let f = 0; f < FILES; f++) EP_HASH[f] = next();
}

/**
 * 某个棋子站在某一格上的哈希值。
 *
 * EMPTY 恒返回 0 —— 这样走子 / 回退时可以把「被吃子」无条件异或进去，
 * 两边写法完全对称，不用写 `if (captured !== EMPTY)`，少一处可能写错的地方。
 */
export function hashPiece(piece, idx) {
  if (piece === EMPTY) return 0;
  initHash();
  return PIECE_HASH[piece + 6][idx];
}

/** 轮到黑方走时额外异或的值 */
export function hashSide() {
  initHash();
  return SIDE_HASH;
}

/** 易位权掩码对应的哈希（掩码 0 也要参与，所以不要跳过） */
export function hashCastle(mask) {
  initHash();
  return CASTLE_HASH[mask & 15];
}

/** 过路兵目标格所在纵线对应的哈希（ep < 0 时为 0） */
export function hashEp(ep) {
  if (ep < 0) return 0;
  initHash();
  return EP_HASH[fileOf(ep)];
}

/** 全量计算一个局面的哈希（引擎的增量哈希要能对上它，测试会逐节点比） */
export function zobristKey(pos) {
  initHash();
  let key = 0;
  for (let i = 0; i < CELLS; i++) key = (key ^ PIECE_HASH[pos.cells[i] + 6][i]) >>> 0;
  if (pos.side === BLACK) key = (key ^ SIDE_HASH) >>> 0;
  key = (key ^ CASTLE_HASH[pos.castling & 15]) >>> 0;
  if (pos.ep >= 0) key = (key ^ EP_HASH[fileOf(pos.ep)]) >>> 0;
  return key;
}
