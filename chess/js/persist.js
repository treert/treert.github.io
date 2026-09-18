/**
 * localStorage 存档。纯逻辑 —— storage 通过参数注入，
 * 所以测试时可以传一个假对象，不需要真的 localStorage。
 *
 * key 必须带模块前缀（AGENTS.md 的模块隔离要求：模块之间不共享 localStorage key）。
 *
 * 读取失败 / 数据损坏一律返回 null、降级成全新开局，**不阻塞页面启动** ——
 * 存档坏掉导致白屏是最糟糕的体验，宁可丢掉一局棋。
 */

export const STORAGE_KEY = 'chess:state';

/** 存档格式版本。将来改了字段结构就 +1，旧存档会被当成损坏丢掉 */
const VERSION = 1;

/** 着法编码的上界：from | to<<6 | promo<<12 | flag<<15，最大 63 + 4032 + 28672 + 98304 */
const MOVE_MAX = 131071;

/**
 * 取 localStorage；拿不到就返回 null。
 *
 * 导出给 custom-endgames.js 复用 —— 两个模块都是「本地存储层」，
 * 兜底逻辑（隐私模式 / Node 里没有 window）没必要写两遍。
 */
export function defaultStorage() {
  try {
    return window.localStorage;
  } catch {
    return null; // 隐私模式下访问 localStorage 会抛
  }
}

export function save(storage, game) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      v: VERSION,
      initialFen: game.initialFen,
      moves: game.moves,
      cursor: game.cursor,
      mode: game.mode,
      playerSide: game.playerSide,
      level: game.level,
      endgameId: game.endgameId,
      twoPlayer: !!game.twoPlayer,
    }));
    return true;
  } catch {
    return false; // 配额满了也会抛，丢存档总比崩页面好
  }
}

/**
 * 逐条校验，坏数据整份丢弃而不是部分采纳 —— 半个对局比没有对局更难查。
 *
 * **局面本身一律走 FEN 快照**（`fenAfter` 就在每步里），不另存易位权 / 过路兵 ——
 * 那些字段已经在 FEN 里了，再存一份迟早会不一致。
 */
function isValid(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.v !== VERSION) return false;
  if (typeof data.initialFen !== 'string') return false;
  if (!Array.isArray(data.moves)) return false;
  if (!Number.isInteger(data.cursor)) return false;
  if (data.cursor < 0 || data.cursor > data.moves.length) return false;
  if (data.playerSide !== 1 && data.playerSide !== -1) return false;
  if (typeof data.level !== 'string') return false;
  if (data.endgameId !== null && data.endgameId !== undefined && typeof data.endgameId !== 'string') return false;

  for (const m of data.moves) {
    if (!m || typeof m !== 'object') return false;
    if (!Number.isInteger(m.move) || m.move < 0 || m.move > MOVE_MAX) return false;
    if (typeof m.san !== 'string') return false;
    if (!Number.isInteger(m.captured)) return false;
    if (typeof m.fenAfter !== 'string') return false;
    // sig 是三次重复判定用的局面签名。老存档没这一项就当损坏（VERSION 会一起挡住）
    if (typeof m.sig !== 'string') return false;
  }
  return true;
}

export function load(storage) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    return isValid(data) ? data : null;
  } catch {
    return null;
  }
}

export function clear(storage) {
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把存档写回一个已存在的 game 对象（就地修改，不换引用）。
 * 返回是否恢复成功。
 */
export function restoreInto(game, storage = defaultStorage()) {
  const data = load(storage);
  if (!data) return false;

  game.initialFen = data.initialFen;
  game.moves = data.moves;
  game.cursor = data.cursor;
  game.mode = data.mode || 'play';
  game.playerSide = data.playerSide;
  game.level = data.level || 'medium';
  game.endgameId = data.endgameId || null;
  game.twoPlayer = !!data.twoPlayer; // 老存档没有这个字段 → false，正好是默认值
  return true;
}

let timer = null;

/**
 * 防抖存盘。走子 / 悔棋 / 切挡位后调用，300ms 内多次调用只写一次。
 *
 * 刻意不做「AI 思考期间不存」这类判断：本模块的状态最多十几 KB，
 * 写一次的开销可以忽略；而漏存的代价是刷新后丢掉一局棋。
 */
export function saveSoon(game, delayMs = 300) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    save(defaultStorage(), game);
  }, delayMs);
}

export function clearSaved() {
  return clear(defaultStorage());
}
