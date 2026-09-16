/**
 * 自定义残局：用户自己存的局面。
 *
 * 纯逻辑 —— storage 通过参数注入，测试时传一个假对象就行（与 persist.js 同一个路子）。
 *
 * ## 和静态残局库（endgames.js）的分工
 *
 *   endgames.js          手工维护的代码，随模块一起发布 —— 是「题库」
 *   custom-endgames.js   用户数据，存在 localStorage 里，随时增删 —— 是「我的局面」
 *
 * 两者在 endgames.js 里通过一个注册表合并成同一个查询入口，
 * 所以 game.js / persist.js **完全不需要知道有「自定义」这回事**。
 *
 * ## 为什么自定义局面一律没有 result
 *
 * 静态库每局都标「先手胜 / 和棋」，界面靠它显示「谱载先手胜」并判定「达成目标」。
 * 但用户存的是对局中途的局面，程序无从知道胜负。硬给一个「先手胜」就是在编造事实 ——
 * 而且会和静态库那批本来就「逐局未复核」的结论混在一起，让人以为它是可信的。
 *
 * 所以自定义局面 result 恒为 null，界面显示「自定义局面」、不做达成判定。
 * 详见 docs/future-work.md。
 *
 * ## 校验失败一律带原因
 *
 * 用户是手粘 FEN 的，说「不行」而不说为什么等于没说。
 * validateEndgameFen 返回 { ok, reason }，reason 直接拿去显示。
 */

import { parseFen, toFen } from './position.js';
import { isLegalPosition, generateLegalMoves } from './rules.js';
import { defaultStorage } from './persist.js';

export const CUSTOM_KEY = 'chinese-chess:endgames';
export const CUSTOM_CATEGORY = 'custom';
export const CUSTOM_SOURCE = '自定义局面';

/** 存档格式版本。改了字段结构就 +1，旧数据整份忽略（和 persist.js 一致） */
export const VERSION = 1;

/** 上限，防止 localStorage 无限增长。存满了让用户自己删 */
const MAX_ENTRIES = 100;
const MAX_NAME = 40;

/**
 * 校验一段 FEN 能不能当局面用，返回 `{ ok, reason, fen }`。
 *
 * `fen` 是**规范化后**的：尾部三个字段统一成 `- - 0 1`、空白去掉。
 * 规范化有两个好处 —— 存进去的和读出来的永远一致（往返可比），
 * 以及「同一个局面粘两次」能被去重认出来。
 */
export function validateEndgameFen(fen) {
  const text = String(fen ?? '').trim();
  if (!text) return { ok: false, reason: 'FEN 是空的' };

  let pos;
  try {
    pos = parseFen(text);
  } catch (e) {
    return { ok: false, reason: `FEN 解析失败：${e.message}` };
  }

  const legal = isLegalPosition(pos);
  if (!legal.ok) return { ok: false, reason: `局面不合法：${legal.reason}` };

  // 剩这一条是「能下」的前提，和 isLegalPosition 分开写 ——
  // isLegalPosition 只管「局面本身成不成立」，这条管的是「拿它当起点有没有练习价值」。
  //
  // 「轮走方已经被将军」不在这里：那是**合法**局面（他应将就是了），
  // 而「我正被将、该怎么解」是正当需求，这种局面应该存得下来。
  // 真正非法的「非轮走方被将军」由 isLegalPosition 挡住。
  if (generateLegalMoves(pos).length === 0) {
    return { ok: false, reason: '这个局面已经终局了（轮走方无着法可走）' };
  }

  return { ok: true, reason: '', fen: toFen(pos) };
}

function newId() {
  // 时间戳 + 随机串。只靠时间戳的话，同一次 tick 里连存多条会撞。
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 把落盘的裸对象补全成界面要用的完整条目 */
function toEntry(raw) {
  return {
    id: raw.id,
    name: raw.name,
    category: CUSTOM_CATEGORY,
    fen: raw.fen,
    result: null,        // 自定义局面不编造胜负
    difficulty: null,
    source: typeof raw.source === 'string' && raw.source ? raw.source : CUSTOM_SOURCE,
    note: typeof raw.note === 'string' ? raw.note : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    custom: true,
  };
}

/** 只落盘必要的字段 —— result / difficulty / custom 都是派生出来的 */
function serialize(entry) {
  return {
    id: entry.id,
    name: entry.name,
    fen: entry.fen,
    source: entry.source,
    note: entry.note,
    createdAt: entry.createdAt,
  };
}

/** 单条数据够不够格进列表 */
function isUsable(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.id !== 'string' || !raw.id) return false;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return false;
  if (typeof raw.fen !== 'string') return false;
  // FEN 必须**现在**仍然可用 —— 规则收紧之后，旧存档里可能留下不合法或已终局的局面
  return validateEndgameFen(raw.fen).ok;
}

/**
 * 读出全部自定义局面，新的在前。
 *
 * **逐条校验**：坏的那条丢掉、好的留下。
 * 这和 persist.js 的「整份丢弃」正好相反，因为语义不同 ——
 * 那边是「一个对局」（半份对局比没有更难查），这边是「一个列表」（丢一条好过丢全部）。
 */
export function loadCustom(storage = defaultStorage()) {
  if (!storage) return [];

  let raw;
  try {
    raw = storage.getItem(CUSTOM_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || data.v !== VERSION || !Array.isArray(data.items)) return [];

  return data.items.filter(isUsable).map(toEntry);
}

function write(storage, entries) {
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_KEY, JSON.stringify({ v: VERSION, items: entries.map(serialize) }));
    return true;
  } catch {
    return false; // 配额满 / 隐私模式
  }
}

/** 存一个新局面。返回 `{ ok, reason, entry }`，失败时 reason 可直接显示 */
export function addCustom(storage, { name, fen } = {}) {
  if (!storage) return { ok: false, reason: '浏览器不允许保存（可能是隐私模式）' };

  const label = String(name ?? '').trim();
  if (!label) return { ok: false, reason: '请给这个局面起个名字' };
  if (label.length > MAX_NAME) return { ok: false, reason: `名字最长 ${MAX_NAME} 个字` };

  const v = validateEndgameFen(fen);
  if (!v.ok) return { ok: false, reason: v.reason };

  const list = loadCustom(storage);
  if (list.length >= MAX_ENTRIES) {
    return { ok: false, reason: `最多存 ${MAX_ENTRIES} 个自定义局面，先删掉几个` };
  }

  // 同一个局面存两遍只会让列表变乱，直接说已经存过（顺便告诉用户叫什么）
  const same = list.find((e) => e.fen === v.fen);
  if (same) return { ok: false, reason: `这个局面已经存过了，叫「${same.name}」` };

  const entry = toEntry({
    id: newId(),
    name: label,
    fen: v.fen,
    source: CUSTOM_SOURCE,
    note: '',
    createdAt: Date.now(),
  });

  if (!write(storage, [entry, ...list])) {
    return { ok: false, reason: '写入失败：浏览器存储可能已满或被禁用' };
  }
  return { ok: true, reason: '', entry };
}

/** 删一个。id 不存在返回 false */
export function removeCustom(storage, id) {
  if (!storage) return false;
  const list = loadCustom(storage);
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  return write(storage, next);
}
