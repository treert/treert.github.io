/**
 * localStorage 存档（design.md §10）。
 *
 * **纯逻辑** —— storage 通过参数注入，测试时传一个假对象即可，不需要真浏览器。
 * 与象棋的 `persist.js` 是同一套做法。
 *
 * key 必须带模块前缀 `doudizhu:`（AGENTS.md 的模块隔离要求：模块之间不共享 key）。
 *
 * 三条规矩：
 *
 *   1. **读取失败 / 版本不匹配 / 校验不过 → 一律丢弃，降级为全新一局，不阻塞启动。**
 *      存档坏掉导致白屏是最糟糕的体验，宁可丢掉一局牌。
 *   2. **整份丢弃，不做部分采纳** —— 半个对局比没有对局更难查
 *      （与象棋 `persist.js` 同策略；注意这和"自定义局面列表"的逐条校验**正好相反**，
 *      因为那边是"一个列表"，这边是"一个对局"）。
 *   3. **恢复时要校验 54 张守恒。** 这是唯一一条能挡住"存档被手改过 / 半途写坏"
 *      的检查，而且它顺带挡住了一整类状态机 bug。
 *
 * 已知限制（不是 bug）：存的是明文，用户打开 devtools 能看到 AI 的手牌。
 * **不做任何防护** —— 混淆防不住同机器上的用户，只是给未来的人增加阅读成本。
 * 本模块没有排行榜也没有积分，作弊没有收益。
 */

import {
  DECK_SIZE, RANK_MIN, RANK_MAX, fullDeck,
} from './cards.js';
import { STORAGE_KEY, STATS_KEY, STORAGE_VERSION } from './config.js';

export { STORAGE_KEY, STATS_KEY };

/** 取 localStorage；拿不到就返回 null（隐私模式下访问会抛） */
export function defaultStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// === 对局存档 ===

/** 把一局牌序列化成 `{ v, game, levelId }`。JSON 化失败（有循环引用）时返回 false */
export function save(storage, game, levelId) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION,
      levelId: typeof levelId === 'string' ? levelId : null,
      game,
    }));
    return true;
  } catch {
    return false; // 配额满了也会抛 —— 丢存档总比崩页面好
  }
}

function isCardArray(x, len) {
  if (!Array.isArray(x)) return false;
  if (len !== undefined && x.length !== len) return false;
  for (const c of x) {
    if (!Number.isInteger(c) || c < 0 || c >= DECK_SIZE) return false;
  }
  return true;
}

function isCombo(x) {
  if (!x || typeof x !== 'object') return false;
  if (typeof x.type !== 'string') return false;
  if (!Number.isInteger(x.mainRank) || x.mainRank < RANK_MIN || x.mainRank > RANK_MAX) return false;
  if (!Number.isInteger(x.length) || x.length <= 0) return false;
  if (!isCardArray(x.cards) || x.cards.length !== x.length) return false;
  return true;
}

function isSeat(x) {
  return Number.isInteger(x) && x >= 0 && x < 3;
}

/**
 * 逐条校验一份存档。**任何一条不过就整份丢。**
 *
 * 最后一条（54 张守恒 + 无重复）是重点：它把"手牌张数写对了但内容对不上"这类
 * 半坏不坏的状态挡在门外 —— 那种状态进了游戏不会立刻报错，
 * 只会在几十手之后以一种完全无关的症状炸出来。
 */
export function isValidSave(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.v !== STORAGE_VERSION) return false;

  const g = data.game;
  if (!g || typeof g !== 'object') return false;
  if (g.phase !== 'bidding' && g.phase !== 'playing' && g.phase !== 'finished') return false;

  // 手牌与底牌
  if (!Array.isArray(g.hands) || g.hands.length !== 3) return false;
  for (const h of g.hands) if (!isCardArray(h)) return false;
  if (!isCardArray(g.trump)) return false;

  // 角色与轮次
  if (g.landlord !== null && !isSeat(g.landlord)) return false;
  if (g.turn !== null && !isSeat(g.turn)) return false;

  // 叫分
  const b = g.bidding;
  if (!b || typeof b !== 'object') return false;
  if (!Array.isArray(b.order) || b.order.length !== 3) return false;
  if (!b.order.every(isSeat)) return false;
  if (new Set(b.order).size !== 3) return false;
  if (!Number.isInteger(b.index) || b.index < 0 || b.index > 3) return false;
  if (!Array.isArray(b.calls) || b.calls.length !== 3) return false;
  for (const c of b.calls) {
    if (c !== null && (!Number.isInteger(c) || c < 0 || c > 3)) return false;
  }

  // 这一墩
  const t = g.trick;
  if (!t || typeof t !== 'object') return false;
  if (!isSeat(t.leader)) return false;
  if (!Number.isInteger(t.passes) || t.passes < 0 || t.passes > 2) return false;
  if (t.lastPlay !== null) {
    if (!t.lastPlay || typeof t.lastPlay !== 'object') return false;
    if (!isSeat(t.lastPlay.seat)) return false;
    if (!isCombo(t.lastPlay.combo)) return false;
  }

  // 出牌记录
  if (!Array.isArray(g.history)) return false;
  for (const h of g.history) {
    if (!h || typeof h !== 'object') return false;
    if (!isSeat(h.seat)) return false;
    if (h.combo !== null && !isCombo(h.combo)) return false;
  }

  if (!Array.isArray(g.playedCounts) || g.playedCounts.length !== 3) return false;
  if (!g.playedCounts.every((n) => Number.isInteger(n) && n >= 0)) return false;
  if (!Number.isInteger(g.bombs) || g.bombs < 0) return false;

  // === 54 张守恒 + 无重复 ===
  //
  // 地主还没定时，底牌不在任何人手里（所以那 3 张要单独算）；
  // 定了地主之后底牌已经并进他的手牌，不能再加一遍。
  const seen = new Set();
  const push = (c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  };
  for (const h of g.hands) for (const c of h) if (!push(c)) return false;
  for (const h of g.history) {
    if (!h.combo) continue;
    for (const c of h.combo.cards) if (!push(c)) return false;
  }
  if (g.landlord === null) {
    for (const c of g.trump) if (!push(c)) return false;
  }
  if (seen.size !== DECK_SIZE) return false;

  return true;
}

/** 读存档。任何异常都返回 null（降级为全新一局） */
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
    return isValidSave(data) ? data : null;
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

let timer = null;

/**
 * 防抖存盘。走子 / 叫分 / 切挡位之后调用，300ms 内多次调用只写一次。
 *
 * 刻意**不做"AI 思考期间不存"**这类判断：状态在任何两次 tick 之间都是自洽的
 * （§8.1 的每个变更函数要么整体成功要么整体拒绝），而漏存的代价是刷新后丢掉一局。
 */
export function saveSoon(game, levelId, delayMs = 300, storage = defaultStorage()) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    save(storage, game, levelId);
  }, delayMs);
}

/** 立刻写一次（关页面前用） */
export function flush(game, levelId, storage = defaultStorage()) {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  return save(storage, game, levelId);
}

// === 战绩 ===

const EMPTY_STATS = {
  v: STORAGE_VERSION,
  games: 0,
  wins: 0,
  landlordGames: 0,
  landlordWins: 0,
  bestMultiplier: 1,
};

export function loadStats(storage = defaultStorage()) {
  if (!storage) return { ...EMPTY_STATS };
  try {
    const raw = storage.getItem(STATS_KEY);
    if (!raw) return { ...EMPTY_STATS };
    const s = JSON.parse(raw);
    if (!s || s.v !== STORAGE_VERSION) return { ...EMPTY_STATS };
    // 逐字段兜底：坏字段当成 0，不让它污染显示
    return {
      v: STORAGE_VERSION,
      games: Number.isInteger(s.games) && s.games >= 0 ? s.games : 0,
      wins: Number.isInteger(s.wins) && s.wins >= 0 ? s.wins : 0,
      landlordGames: Number.isInteger(s.landlordGames) && s.landlordGames >= 0 ? s.landlordGames : 0,
      landlordWins: Number.isInteger(s.landlordWins) && s.landlordWins >= 0 ? s.landlordWins : 0,
      bestMultiplier: Number.isFinite(s.bestMultiplier) && s.bestMultiplier >= 1 ? s.bestMultiplier : 1,
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

/**
 * 记一局的结果。`myRole` / `myTeamWon` 由调用方从玩家的视角算好传进来 ——
 * 这样这里不需要知道任何牌类规则。
 */
export function recordResult(storage, { myRole, myTeamWon, multiplier }) {
  const s = loadStats(storage);
  s.games++;
  if (myTeamWon) s.wins++;
  if (myRole === 'landlord') {
    s.landlordGames++;
    if (myTeamWon) s.landlordWins++;
  }
  if (Number.isFinite(multiplier) && multiplier > s.bestMultiplier) s.bestMultiplier = multiplier;
  try {
    storage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    // 写不进去就算了，战绩不是关键路径
  }
  return s;
}

export function clearStats(storage = defaultStorage()) {
  try {
    storage.removeItem(STATS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 只在测试里用得上：看看这副牌是不是 54 张齐全（存档校验的思路同源） */
export function deckSizeOf(cards) {
  return new Set(cards.filter((c) => fullDeck().includes(c))).size;
}
