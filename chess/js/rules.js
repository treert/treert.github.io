/**
 * 规则引擎：着法生成、攻击判定、合法性、终局判定。纯逻辑，不碰 DOM。
 *
 * 两层接口，用途不同：
 *   generateMoves(pos)        伪合法着法（不检查走完之后己方王是否被攻击）—— 搜索用
 *   generateLegalMoves(pos)   合法着法 —— 界面走子校验、终局判定、perft 用
 *
 * **合法性用「走一步 → 查自己的王是否被攻击 → 退回来」**，不自己推导「被将军时
 * 哪些能走」。被将军时这条自然只剩解将的着法，少一整类可能写错的规则。
 *
 * 「吃掉对方的王」在伪合法层可能出现，但合法层之后不会留下；
 * 终局判定靠「无合法着法 + 是否被将军」（见 gameStatus），不靠「王被吃」。
 */

import {
  FILES, CELLS, EMPTY, P, N, B, R, Q, K, WHITE, BLACK,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ, PROMO_PIECES,
} from './config.js';
import { index, fileOf, rankOf, onBoard } from './position.js';

// === 着法编码 ===
// 一个着法是一个整数，不建对象：搜索里每层要生成几十个着法，对象会带来 GC 压力。
//
//   bit  0-5   from（0..63）
//   bit  6-11  to（0..63）
//   bit 12-14  升变种类（0 = 不升变，否则 2..5 = N/B/R/Q）
//   bit 15-16  标记（见下面四个 FLAG_*）
export function encodeMove(from, to, promo = 0, flag = 0) {
  return (from & 63) | ((to & 63) << 6) | ((promo & 7) << 12) | ((flag & 3) << 15);
}
export function moveFrom(move) { return move & 63; }
export function moveTo(move) { return (move >> 6) & 63; }
export function movePromo(move) { return (move >> 12) & 7; }
export function moveFlag(move) { return (move >> 15) & 3; }

export const FLAG_NONE = 0;
export const FLAG_EP = 1;
export const FLAG_CASTLE = 2;
export const FLAG_DOUBLE = 3;

/** 着法 → UCI 文本（`e2e4` / `e7e8q`）。离线工具（Stockfish / 表库）那边用这个格式 */
export function moveToUci(move) {
  const promo = movePromo(move);
  const letter = promo ? ' nbrq'[promo] : '';
  return `${sq(moveFrom(move))}${sq(moveTo(move))}${letter}`;
}

/** UCI 文本 → 着法编码。不认识的写法返回 -1（调用方自己决定怎么报错） */
export function moveOfUci(text) {
  const t = String(text || '').trim();
  if (t.length < 4 || t.length > 5) return -1;
  const from = sqIndex(t.slice(0, 2));
  const to = sqIndex(t.slice(2, 4));
  if (from < 0 || to < 0) return -1;
  let promo = 0;
  if (t.length === 5) {
    promo = { n: N, b: B, r: R, q: Q }[t[4].toLowerCase()] || 0;
    if (!promo) return -1;
  }
  return encodeMove(from, to, promo);
}

const FILES_TEXT = 'abcdefgh';
const sq = (idx) => `${FILES_TEXT[fileOf(idx)]}${rankOf(idx) + 1}`;
const sqIndex = (text) => {
  const f = FILES_TEXT.indexOf(text[0]);
  const r = text.charCodeAt(1) - 49;
  return onBoard(f, r) ? index(f, r) : -1;
};

// === 方向表 ===
const ORTHO = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KING_STEPS = [...ORTHO, ...DIAG];
const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

const other = (side) => (side === WHITE ? BLACK : WHITE);

/** 目标格为空或敌子即可落子 */
function canLand(cells, idx, side) {
  const t = cells[idx];
  return t === EMPTY || Math.sign(t) !== side;
}

function pushPromotions(out, from, to, flag) {
  for (const promo of PROMO_PIECES) out.push(encodeMove(from, to, promo, flag));
}

/**
 * 生成伪合法着法。
 *
 * **易位在这里就把「王经过的格不被攻击」查掉**，不留到合法性检查去：
 * 合法性那一步只看「走完之后自己的王安不安全」，而短易位时王跨了两格，
 * 中间那一格是否被攻击在终局上查不出来。放在这里只多两次 isAttacked，
 * 而易位本身很少出现，代价可以忽略。
 */
export function generateMoves(pos) {
  const { cells, side, ep } = pos;
  const out = [];

  for (let from = 0; from < CELLS; from++) {
    const v = cells[from];
    if (v === EMPTY || (v > 0 ? 1 : -1) !== side) continue;
    const abs = v > 0 ? v : -v;
    const file = fileOf(from);
    const rank = rankOf(from);

    switch (abs) {
      case P: genPawn(out, cells, from, file, rank, side, ep); break;
      case N: genStep(out, cells, from, file, rank, side, KNIGHT_STEPS); break;
      case K: genStep(out, cells, from, file, rank, side, KING_STEPS); break;
      case B: genRay(out, cells, from, file, rank, side, DIAG); break;
      case R: genRay(out, cells, from, file, rank, side, ORTHO); break;
      case Q: genRay(out, cells, from, file, rank, side, [...ORTHO, ...DIAG]); break;
      default: break;
    }
    if (abs === K) genCastles(out, cells, from, file, rank, side, pos.castling);
  }
  return out;
}

/** 兵：前进一格（末排升变）、起始排可前进两格、斜前方吃子 / 吃过路兵 */
function genPawn(out, cells, from, file, rank, side, ep) {
  const dir = side === WHITE ? 1 : -1;
  const lastRank = side === WHITE ? 7 : 0;
  const startRank = side === WHITE ? 1 : 6;

  const oneRank = rank + dir;
  if (onBoard(file, oneRank)) {
    const one = index(file, oneRank);
    if (cells[one] === EMPTY) {
      if (oneRank === lastRank) pushPromotions(out, from, one, FLAG_NONE);
      else {
        out.push(encodeMove(from, one));
        const twoRank = rank + 2 * dir;
        if (rank === startRank && cells[index(file, twoRank)] === EMPTY) {
          out.push(encodeMove(from, index(file, twoRank), 0, FLAG_DOUBLE));
        }
      }
    }
  }

  for (const df of [-1, 1]) {
    const tf = file + df;
    const tr = rank + dir;
    if (!onBoard(tf, tr)) continue;
    const to = index(tf, tr);
    const target = cells[to];
    if (target !== EMPTY) {
      if (Math.sign(target) === side) continue;
      if (tr === lastRank) pushPromotions(out, from, to, FLAG_NONE);
      else out.push(encodeMove(from, to));
    } else if (to === ep) {
      out.push(encodeMove(from, to, 0, FLAG_EP));
    }
  }
}

/** 马 / 王：固定偏移的「跳一步」 */
function genStep(out, cells, from, file, rank, side, steps) {
  for (const [df, dr] of steps) {
    const f = file + df;
    const r = rank + dr;
    if (!onBoard(f, r)) continue;
    const to = index(f, r);
    if (canLand(cells, to, side)) out.push(encodeMove(from, to));
  }
}

/** 象 / 车 / 后：沿方向滑动，遇子停止，遇敌子可吃 */
function genRay(out, cells, from, file, rank, side, dirs) {
  for (const [df, dr] of dirs) {
    let f = file + df;
    let r = rank + dr;
    while (onBoard(f, r)) {
      const to = index(f, r);
      if (cells[to] === EMPTY) out.push(encodeMove(from, to));
      else {
        if (Math.sign(cells[to]) !== side) out.push(encodeMove(from, to));
        break;
      }
      f += df;
      r += dr;
    }
  }
}

/**
 * 易位。四个条件缺一不可：
 *   1. 易位权在（王和那一侧的车都没动过）；
 *   2. 王在起始格、对应车也在（FEN 里权还在但车被摆走了的话，这里兜住）；
 *   3. 王与车之间的格子全空（长易位时 b1/b8 也要空，尽管王不经过它）；
 *   4. 王的**起始格与经过格**都不被攻击（终点由合法性检查覆盖）。
 */
function genCastles(out, cells, from, file, rank, side, castling) {
  if (file !== 4 || rank !== (side === WHITE ? 0 : 7)) return;
  if (isAttacked(cells, from, other(side))) return; // 条件 4 的前半

  const shortBit = side === WHITE ? CASTLE_WK : CASTLE_BK;
  const longBit = side === WHITE ? CASTLE_WQ : CASTLE_BQ;

  if (castling & shortBit) {
    if (cells[index(5, rank)] === EMPTY && cells[index(6, rank)] === EMPTY
      && cells[index(7, rank)] === side * R
      && !isAttacked(cells, index(5, rank), other(side))) {
      out.push(encodeMove(from, index(6, rank), 0, FLAG_CASTLE));
    }
  }
  if (castling & longBit) {
    if (cells[index(1, rank)] === EMPTY && cells[index(2, rank)] === EMPTY
      && cells[index(3, rank)] === EMPTY
      && cells[index(0, rank)] === side * R
      && !isAttacked(cells, index(3, rank), other(side))) {
      out.push(encodeMove(from, index(2, rank), 0, FLAG_CASTLE));
    }
  }
}

export function findKing(cells, side) {
  const target = side * K;
  for (let i = 0; i < CELLS; i++) if (cells[i] === target) return i;
  return -1;
}

/**
 * 判断 idx 这一格是否被 bySide 攻击。
 *
 * 用「反向探测」而不是「遍历所有棋子试吃」：每个方向最多扫到第一个子就停，
 * 成本与棋盘上有多少棋子无关。这个函数在搜索里每试走一步都要调一次，值得写细。
 *
 * 传进来的 idx 上通常有子（调用时基本都是王所在格），但**断言只依赖格子位置**，
 * 所以给一个空格也能正确回答「这一格受不受攻击」—— 易位要问的正是空格。
 */
export function isAttacked(cells, idx, bySide) {
  const file = fileOf(idx);
  const rank = rankOf(idx);

  // 兵：bySide 的兵从斜前方一格攻击它
  const pawnRank = rank + (bySide === WHITE ? -1 : 1);
  if (onBoard(file, pawnRank)) {
    for (const df of [-1, 1]) {
      if (!onBoard(file + df, pawnRank)) continue;
      if (cells[index(file + df, pawnRank)] === bySide * P) return true;
    }
  }

  // 马：反过来找八个能跳到 idx 的位置
  for (const [df, dr] of KNIGHT_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (!onBoard(f, r)) continue;
    if (cells[index(f, r)] === bySide * N) return true;
  }

  // 王：八个邻格
  for (const [df, dr] of KING_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (!onBoard(f, r)) continue;
    if (cells[index(f, r)] === bySide * K) return true;
  }

  // 车 / 后（正交）与象 / 后（斜线）：沿方向扫，第一个子决定
  for (const [df, dr, ortho] of RAY_DIRS) {
    let f = file + df;
    let r = rank + dr;
    while (onBoard(f, r)) {
      const v = cells[index(f, r)];
      if (v !== EMPTY) {
        if (Math.sign(v) === bySide) {
          const abs = v > 0 ? v : -v;
          if (abs === Q || (ortho ? abs === R : abs === B)) return true;
        }
        break;
      }
      f += df;
      r += dr;
    }
  }

  return false;
}

/** 方向 + 「这一条是正交还是斜线」，用来决定命中车 / 后还是象 / 后 */
const RAY_DIRS = [
  [0, 1, true], [0, -1, true], [1, 0, true], [-1, 0, true],
  [1, 1, false], [1, -1, false], [-1, 1, false], [-1, -1, false],
];

export function inCheck(cells, side) {
  const king = findKing(cells, side);
  return king >= 0 && isAttacked(cells, king, other(side));
}

/**
 * 在 cells 上真正走一步（就地改）。返回回退所需的全部信息。
 *
 * 三个特殊之处都在这里处理：
 *   - 吃过路兵：被吃的兵不在目标格上，而在「目标格的同排、我方兵的原纵线」上；
 *   - 升变：落子时换成升变后的棋子；
 *   - 易位：车要跟着越过王。
 *
 * 合法性与 perft 都是「走一步 → 查 → 退回来」，所以要有一对严格对称的函数。
 */
export function applyMoveCells(cells, move) {
  const from = moveFrom(move);
  const to = moveTo(move);
  const flag = moveFlag(move);
  const promo = movePromo(move);
  const piece = cells[from];
  const side = piece > 0 ? WHITE : BLACK;

  const capturedIdx = flag === FLAG_EP ? to - side * FILES : to;
  const saved = {
    piece,
    captured: cells[capturedIdx],
    capturedIdx,
    rookFrom: -1,
    rookTo: -1,
  };

  if (capturedIdx !== to) cells[capturedIdx] = EMPTY;
  cells[to] = promo ? side * promo : piece;
  cells[from] = EMPTY;

  if (flag === FLAG_CASTLE) {
    const rank = rankOf(from);
    const kingSide = fileOf(to) === 6;
    const rookFrom = index(kingSide ? 7 : 0, rank);
    const rookTo = index(kingSide ? 5 : 3, rank);
    cells[rookTo] = cells[rookFrom];
    cells[rookFrom] = EMPTY;
    saved.rookFrom = rookFrom;
    saved.rookTo = rookTo;
  }
  return saved;
}

/** applyMoveCells 的逆操作（saved 就是它返回的那一份） */
export function revertMoveCells(cells, move, saved) {
  const from = moveFrom(move);
  const to = moveTo(move);
  cells[from] = saved.piece;
  cells[to] = saved.capturedIdx === to ? saved.captured : EMPTY;
  if (saved.capturedIdx !== to) cells[saved.capturedIdx] = saved.captured;
  if (saved.rookFrom >= 0) {
    cells[saved.rookFrom] = cells[saved.rookTo];
    cells[saved.rookTo] = EMPTY;
  }
}

/**
 * 合法着法 = 伪合法着法去掉「走完之后己方王被攻击」的那些。
 *
 * **就地试走再退回来**（改的是传进来的 pos.cells，函数返回时恢复原样）：
 * 只有一处判断逻辑，不容易漏。代价是不能并发调用同一个局面 —— 本模块是单线程，
 * 没有这个问题。
 */
export function generateLegalMoves(pos) {
  const { cells, side } = pos;
  const out = [];
  for (const move of generateMoves(pos)) {
    const saved = applyMoveCells(cells, move);
    const kingAt = saved.piece === side * K ? moveTo(move) : findKing(cells, side);
    if (kingAt >= 0 && !isAttacked(cells, kingAt, other(side))) out.push(move);
    revertMoveCells(cells, move, saved);
  }
  return out;
}

/** 这一步走完之后对方是否被将军（试走 + 回退，棋盘不留痕） */
export function givesCheck(pos, move) {
  const { cells } = pos;
  const side = pos.side;
  const saved = applyMoveCells(cells, move);
  const check = inCheck(cells, other(side));
  revertMoveCells(cells, move, saved);
  return check;
}

/**
 * 在局面上真正走一步，返回**新局面**（不改传进来的那个）。
 *
 * 引擎有自己的增量 make/unmake（那边不建对象）；这一层给「对局状态机、残局库校验、
 * 解法数据复核」这类不在热路径上的调用方用 —— 它们要的是 FEN 快照，不是速度。
 */
export function makeMove(pos, move) {
  const next = {
    cells: pos.cells.slice(),
    side: other(pos.side),
    castling: nextCastling(pos.castling, move, pos.cells),
    ep: nextEp(move),
    halfmove: nextHalfmove(pos, move),
    fullmove: pos.fullmove + (pos.side === BLACK ? 1 : 0),
  };
  const captured = applyMoveCells(next.cells, move).captured;
  return { pos: next, captured, prev: pos };
}

/** 回退：makeMove 返回的 prev 就是走之前的局面（不可变风格的“回退”只是换回引用） */
export function unmakeMove(made) { return made.prev; }

/** 走完一步之后还剩哪些易位权：王一动全丢，车一动丢那一边 */
export function nextCastling(castling, move, cells) {
  const from = moveFrom(move);
  const to = moveTo(move);
  let mask = castling;
  const piece = cells[from];
  if (Math.abs(piece) === K) {
    mask &= piece > 0 ? ~(CASTLE_WK | CASTLE_WQ) : ~(CASTLE_BK | CASTLE_BQ);
  } else if (Math.abs(piece) === R) {
    if (from === index(0, 0)) mask &= ~CASTLE_WQ;
    else if (from === index(7, 0)) mask &= ~CASTLE_WK;
    else if (from === index(0, 7)) mask &= ~CASTLE_BQ;
    else if (from === index(7, 7)) mask &= ~CASTLE_BK;
  }
  // 车在角落被吃掉，对应那一侧的权也要丢
  if (to === index(0, 0)) mask &= ~CASTLE_WQ;
  else if (to === index(7, 0)) mask &= ~CASTLE_WK;
  else if (to === index(0, 7)) mask &= ~CASTLE_BQ;
  else if (to === index(7, 7)) mask &= ~CASTLE_BK;
  return mask;
}

/** 双步前进之后才留下过路兵目标格（其余一律清空） */
export function nextEp(move) {
  if (moveFlag(move) !== FLAG_DOUBLE) return -1;
  return (moveFrom(move) + moveTo(move)) >> 1;
}

/** 半步计数：吃子或走兵就归零，否则 +1（50 步规则） */
export function nextHalfmove(pos, move) {
  const piece = pos.cells[moveFrom(move)];
  const captured = moveFlag(move) === FLAG_EP || pos.cells[moveTo(move)] !== EMPTY;
  return (piece === P || piece === -P || captured) ? 0 : pos.halfmove + 1;
}

/**
 * 子力不足（无法将死任何一方）—— FIDE 口径下的三种：
 *   K vs K、K+单马 / K+单象 vs K、K+象 vs K+象 且两象同色格。
 *
 * K+N+N vs K 严格说也无法强制将死，但**理论上存在被将死的合法序列**，
 * 所以按规则不算「子力不足」（它是可以走成和棋，不是自动判和）。
 */
export function insufficientMaterial(cells) {
  const minors = [];
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;
    const abs = v > 0 ? v : -v;
    if (abs === K) continue;
    if (abs === P || abs === R || abs === Q) return false; // 有 兵/车/后 就一定能将死
    // parity 只是个「格子颜色」的标签，两象同色 = 两者的 parity 相等
    minors.push({ side: v > 0 ? WHITE : BLACK, abs, parity: (fileOf(i) + rankOf(i)) % 2 });
  }
  if (minors.length === 0) return true;
  if (minors.length === 1) return true;
  if (minors.length === 2
    && minors[0].abs === B && minors[1].abs === B
    && minors[0].side !== minors[1].side
    && minors[0].parity === minors[1].parity) return true;
  return false;
}

/**
 * 终局判定。顺序很重要（先判「无着法」，再判计数类）：
 *
 *   1. 无合法着法 → 被将军 = 将死，否则 = 逼和（stalemate，**象棋没有这一条**）；
 *   2. halfmove >= 100 → 50 步和棋；
 *   3. 子力不足；
 *   4. 三次重复 —— 需要整条着法线，所以判定放在 game.js 而不是这里。
 *
 * `moves` 一并返回：它在判定过程中已经算出来了，调用方（界面）多半也要用。
 */
export function gameStatus(pos) {
  const moves = generateLegalMoves(pos);
  if (moves.length === 0) {
    const checked = inCheck(pos.cells, pos.side);
    return { type: checked ? 'checkmate' : 'stalemate', winner: checked ? other(pos.side) : null, moves };
  }
  if (pos.halfmove >= 100) return { type: 'fifty', winner: null, moves };
  if (insufficientMaterial(pos.cells)) return { type: 'insufficient', winner: null, moves };
  return { type: 'playing', winner: null, moves };
}

/**
 * 局面合法性校验。残局库录入、粘贴导入、分享链接都先过这一关。
 *
 * 返回 `{ ok, reason }` 而不是布尔值 —— 校验残局库时要能说出「第 003 局哪里不合法」，
 * 只返回 false 等于让作者自己去猜。
 *
 * **不校验胜负结论**：那需要可靠的求解器或表库，本模块的引擎做不到
 * （见 docs/stockfish.md）。
 */
export function isLegalPosition(pos) {
  const { cells, side, castling } = pos;

  // 1. 双方各恰好一个王
  const kings = [findKing(cells, WHITE), findKing(cells, BLACK)];
  if (kings[0] < 0 || kings[1] < 0) return { ok: false, reason: '双方必须各有一个王' };
  if (kings[0] === kings[1]) return { ok: false, reason: '双方必须各有一个王' };

  // 2. 两个王不能相邻
  const kd = [Math.abs(fileOf(kings[0]) - fileOf(kings[1])), Math.abs(rankOf(kings[0]) - rankOf(kings[1]))];
  if (kd[0] <= 1 && kd[1] <= 1) return { ok: false, reason: '两个王相邻' };

  // 3. 兵不能停在第一 / 第八排（它们早该升变了）
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v !== P && v !== -P) continue;
    const rank = rankOf(i);
    if (rank === 0 || rank === 7) {
      return { ok: false, reason: `第 ${rank + 1} 排有兵（早该升变，FEN 不合法）` };
    }
  }

  // 4. 非轮走方不该被将军（那意味着上一步走错了）
  if (inCheck(cells, other(side))) {
    return { ok: false, reason: '非轮走方正被将军，说明上一步不合法' };
  }

  // 5. 易位权必须与「王和车还在原位」对得上 —— 权是 FEN 里最容易抄错的一段
  const rights = [
    [CASTLE_WK, WHITE, index(4, 0), index(7, 0), '白方短易位'],
    [CASTLE_WQ, WHITE, index(4, 0), index(0, 0), '白方长易位'],
    [CASTLE_BK, BLACK, index(4, 7), index(7, 7), '黑方短易位'],
    [CASTLE_BQ, BLACK, index(4, 7), index(0, 7), '黑方长易位'],
  ];
  for (const [bit, s, kingSq, rookSq, label] of rights) {
    if (!(castling & bit)) continue;
    if (cells[kingSq] !== s * K || cells[rookSq] !== s * R) {
      return { ok: false, reason: `FEN 声明了${label}，但王或车不在起始格` };
    }
  }

  // 6. 子力数量不超过理论上限（挡「双方各三个后」这类明显抄错的 FEN）
  const counts = new Map();
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v !== EMPTY) counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const [piece, max] of [[P, 8], [N, 10], [B, 10], [R, 10], [Q, 9]]) {
    const w = counts.get(piece) || 0;
    const b = counts.get(-piece) || 0;
    if (w > max) return { ok: false, reason: `白方有 ${w} 个同类棋子，超过上限 ${max}` };
    if (b > max) return { ok: false, reason: `黑方有 ${b} 个同类棋子，超过上限 ${max}` };
  }

  return { ok: true };
}
