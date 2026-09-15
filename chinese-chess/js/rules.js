/**
 * 规则引擎：着法生成、攻击判定、合法性、终局判定。纯逻辑。
 *
 * 两层接口，用途不同：
 *   generateMoves(cells, side)   伪合法着法（不检查走完后己方是否被将军）—— 搜索用
 *   generateLegalMoves(pos)      合法着法 —— 界面走子校验、终局判定用
 */

import { CELLS, EMPTY, K, A, B, N, R, C, P, RED } from './config.js';
import { indexOf, xOf, yOf, inBoard } from './position.js';

// 四个正交方向
const ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];

// 马：[目标位移 dx, dy, 马腿位移 lx, ly]
// 马腿是「先直走的那一格」，也就是位移绝对值等于 2 的那个方向上的相邻格
const HORSE = [
  [1, -2, 0, -1], [-1, -2, 0, -1],
  [1, 2, 0, 1], [-1, 2, 0, 1],
  [2, -1, 1, 0], [2, 1, 1, 0],
  [-2, -1, -1, 0], [-2, 1, -1, 0],
];

// 象 / 相：田字，象眼是两格位移的中点
const ELEPHANT = [[2, 2], [2, -2], [-2, 2], [-2, -2]];

// 士 / 仕：斜走一格
const ADVISOR = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function encodeMove(from, to) { return from * CELLS + to; }
export function moveFrom(move) { return Math.floor(move / CELLS); }
export function moveTo(move) { return move % CELLS; }

/** 目标格为空或敌子即可落子 */
function canLand(cells, idx, side) {
  const t = cells[idx];
  return t === EMPTY || Math.sign(t) !== side;
}

/** 是否在自己的九宫内 */
function inPalace(x, y, side) {
  if (x < 3 || x > 5) return false;
  return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
}

/** 是否在自己的半场内（相 / 象不能过河） */
function ownHalf(y, side) { return side === RED ? y >= 5 : y <= 4; }

/**
 * 生成伪合法着法。不检查走完之后己方是否被将军 —— 那一步在 generateLegalMoves() 里统一做。
 */
export function generateMoves(cells, side) {
  const out = [];
  for (let from = 0; from < CELLS; from++) {
    const v = cells[from];
    if (v === EMPTY || Math.sign(v) !== side) continue;
    const x = xOf(from), y = yOf(from);
    switch (Math.abs(v)) {
      case R: genRook(out, cells, from, x, y, side); break;
      case C: genCannon(out, cells, from, x, y, side); break;
      case N: genHorse(out, cells, from, x, y, side); break;
      case B: genElephant(out, cells, from, x, y, side); break;
      case A: genAdvisor(out, cells, from, x, y, side); break;
      case K: genKing(out, cells, from, x, y, side); break;
      case P: genPawn(out, cells, from, x, y, side); break;
    }
  }
  return out;
}

/** 车：四方向直线滑动，遇子停止，遇敌子可吃 */
function genRook(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] === EMPTY) {
        out.push(encodeMove(from, idx));
      } else {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/**
 * 炮：四方向直线。
 * 第一段没有炮架，只能走空格；遇到第一个子（炮架）之后，
 * 再找它后面的第一个子，是敌子才能吃。
 */
function genCannon(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;

    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) {
      out.push(encodeMove(from, indexOf(cx, cy)));
      cx += dx; cy += dy;
    }
    if (!inBoard(cx, cy)) continue;

    // (cx,cy) 是炮架，从它后面继续找第一个子
    cx += dx; cy += dy;
    while (inBoard(cx, cy)) {
      const idx = indexOf(cx, cy);
      if (cells[idx] !== EMPTY) {
        if (Math.sign(cells[idx]) !== side) out.push(encodeMove(from, idx));
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/** 兵 / 卒：未过河只能向前一格，过河后可向前或左右一格，永不后退 */
function genPawn(out, cells, from, x, y, side) {
  const forward = -side; // 红方前进 y 减小，黑方前进 y 增大
  const fy = y + forward;
  if (inBoard(x, fy)) {
    const idx = indexOf(x, fy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }

  // 过河后才能横走：红兵到 y <= 4，黑卒到 y >= 5
  const crossed = side === RED ? y <= 4 : y >= 5;
  if (!crossed) return;

  for (const dx of [-1, 1]) {
    const cx = x + dx;
    if (!inBoard(cx, y)) continue;
    const idx = indexOf(cx, y);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 将 / 帅：四方向一格，不得出九宫 */
function genKing(out, cells, from, x, y, side) {
  for (const [dx, dy] of ORTHO) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 马：八个日字目标；马腿（先直走的那一格）有子则该方向全部禁止 */
function genHorse(out, cells, from, x, y, side) {
  for (const [dx, dy, lx, ly] of HORSE) {
    const legX = x + lx, legY = y + ly;
    // 马腿在棋盘外时，对应的目标也必然在棋盘外，直接跳过
    if (!inBoard(legX, legY) || cells[indexOf(legX, legY)] !== EMPTY) continue;

    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 象 / 相：四个田字目标；象眼（田字中心）有子则禁；不得过河 */
function genElephant(out, cells, from, x, y, side) {
  for (const [dx, dy] of ELEPHANT) {
    const cx = x + dx, cy = y + dy;
    if (!inBoard(cx, cy)) continue;
    if (!ownHalf(cy, side)) continue;
    if (cells[indexOf(x + dx / 2, y + dy / 2)] !== EMPTY) continue; // 塞象眼
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
  }
}

/** 士 / 仕：四个斜向一格；不得出九宫 */
function genAdvisor(out, cells, from, x, y, side) {
  for (const [dx, dy] of ADVISOR) {
    const cx = x + dx, cy = y + dy;
    if (!inPalace(cx, cy, side)) continue;
    const idx = indexOf(cx, cy);
    if (canLand(cells, idx, side)) out.push(encodeMove(from, idx));
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
 * 用「反向探测」而不是「遍历所有棋子试吃」：每个方向最多扫到第二个子就停，
 * 成本与棋盘上有多少棋子无关。这个函数在搜索里每试走一步都要调一次，值得写细。
 *
 * 注意：车 / 炮 / 将这类滑行攻击是「扫描到第一个子」才命中的，
 * 所以传进来的 idx 上必须真的有子（实际调用时都是将 / 帅所在格，恒成立）。
 *
 * 将帅照面也在这里处理：两将同处一条纵线且中间无子时互相攻击，
 * 于是「走完之后两将照面」会被合法性检查直接拒掉，不需要额外的规则代码。
 */
export function isAttacked(cells, idx, bySide) {
  const x = xOf(idx), y = yOf(idx);
  const target = cells[idx];

  // 车 / 炮 / 将：沿四个正交方向
  for (const [dx, dy] of ORTHO) {
    let cx = x + dx, cy = y + dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (!inBoard(cx, cy)) continue;

    const first = cells[indexOf(cx, cy)];
    if (Math.sign(first) === bySide) {
      const abs = Math.abs(first);
      if (abs === R) return true;                                   // 车
      if (abs === K) {
        if (Math.abs(cx - x) + Math.abs(cy - y) === 1) return true; // 将贴身
        if (Math.abs(target) === K) return true;                    // 将帅照面（中间无子）
      }
    }

    // 炮：隔一个子才能吃
    cx += dx; cy += dy;
    while (inBoard(cx, cy) && cells[indexOf(cx, cy)] === EMPTY) { cx += dx; cy += dy; }
    if (inBoard(cx, cy)) {
      const second = cells[indexOf(cx, cy)];
      if (Math.sign(second) === bySide && Math.abs(second) === C) return true;
    }
  }

  // 马：反过来找八个能跳到 idx 的位置
  for (const [dx, dy, lx, ly] of HORSE) {
    const kx = x - dx, ky = y - dy;
    if (!inBoard(kx, ky)) continue;
    const v = cells[indexOf(kx, ky)];
    if (Math.sign(v) !== bySide || Math.abs(v) !== N) continue;
    if (cells[indexOf(kx + lx, ky + ly)] !== EMPTY) continue;       // 蹩马腿
    return true;
  }

  // 兵 / 卒：正前方一格 + 过河后的左右一格
  const py = y + bySide; // 兵所在的行：红方(bySide=1)在下一行，黑方(bySide=-1)在上一行
  if (inBoard(x, py)) {
    const v = cells[indexOf(x, py)];
    if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
  }
  const crossed = bySide === RED ? y <= 4 : y >= 5;
  if (crossed) {
    for (const dx of [-1, 1]) {
      const px = x + dx;
      if (!inBoard(px, y)) continue;
      const v = cells[indexOf(px, y)];
      if (Math.sign(v) === bySide && Math.abs(v) === P) return true;
    }
  }

  return false;
}

export function inCheck(cells, side) {
  const king = findKing(cells, side);
  return king >= 0 && isAttacked(cells, king, -side);
}

/**
 * 合法着法 = 伪合法着法去掉「走完之后己方被将军」的那些。
 *
 * 用试走 + 回退而不是在生成时就过滤：只有一处判断逻辑，不容易漏。
 * 将 / 帅的起点只在循环外找一次；如果这一步走的正好是将 / 帅，则改查它的落点。
 */
export function generateLegalMoves(pos) {
  const { cells, side } = pos;
  const kingFrom = findKing(cells, side);
  if (kingFrom < 0) return [];

  const out = [];
  for (const move of generateMoves(cells, side)) {
    const from = moveFrom(move), to = moveTo(move);
    const captured = cells[to];
    cells[to] = cells[from];
    cells[from] = EMPTY;

    const kingAt = from === kingFrom ? to : kingFrom;
    if (!isAttacked(cells, kingAt, -side)) out.push(move);

    cells[from] = cells[to];
    cells[to] = captured;
  }
  return out;
}

/**
 * 终局判定。
 *
 * 中国象棋与国际象棋不同：困毙（无着法可走但没被将军）也是判负，不是和棋。
 * 所以两种情况都是走子方负，只有 type 不同 —— 界面要分开显示「将死」和「困毙」。
 */
export function gameStatus(pos) {
  const moves = generateLegalMoves(pos);
  if (moves.length > 0) return { type: 'playing', winner: null, moves };

  const checked = inCheck(pos.cells, pos.side);
  return {
    type: checked ? 'checkmate' : 'stalemate',
    winner: -pos.side,
    moves,
  };
}

/**
 * 三次重复判和。
 *
 * signatures 是按时间顺序排列的「局面签名」（positionSignature 的输出）。
 * 必须是签名而不是完整 FEN —— 回合数字段每次都变，用完整 FEN 永远比不出重复。
 *
 * 设计文档 §5.3 明确不做中国象棋的循环规则（长将 / 长捉判负），
 * 这一条是唯一的循环兜底，保证对局不会无限进行下去。
 */
export function isThreefoldRepetition(signatures) {
  const count = new Map();
  for (const s of signatures) {
    const n = (count.get(s) || 0) + 1;
    if (n >= 3) return true;
    count.set(s, n);
  }
  return false;
}

// 士 / 仕 的五个斜点（黑方视角）
const ADVISOR_SPOTS_BLACK = [[3, 0], [5, 0], [4, 1], [3, 2], [5, 2]];
// 象 / 相 的七个象位（黑方视角）
const ELEPHANT_SPOTS_BLACK = [[2, 0], [6, 0], [0, 2], [4, 2], [8, 2], [2, 4], [6, 4]];

/** 红方的点位是黑方沿 y 轴镜像过来的：y' = 9 - y */
const mirror = (spots) => spots.map(([x, y]) => [x, 9 - y]);
const ADVISOR_SPOTS = { [RED]: mirror(ADVISOR_SPOTS_BLACK), [-RED]: ADVISOR_SPOTS_BLACK };
const ELEPHANT_SPOTS = { [RED]: mirror(ELEPHANT_SPOTS_BLACK), [-RED]: ELEPHANT_SPOTS_BLACK };

const onAnySpot = (spots, x, y) => spots.some(([sx, sy]) => sx === x && sy === y);

/** 各类棋子的理论上限，用来挡住「摆出三个车」这种明显错误的录入 */
const MAX_COUNT = [[R, 2], [N, 2], [C, 2], [B, 2], [A, 2], [P, 5]];

/**
 * 局面合法性校验。残局库录入时逐局跑这个。
 *
 * 返回 { ok, reason } 而不是布尔值 —— 校验残局库时要能说出
 * 「第 003 局哪里不合法」，只返回 false 等于让作者自己去猜。
 *
 * **不校验胜负结论**：「红先胜」这类标注需要可靠的求解器或权威棋谱，
 * 本模块的引擎做不到。见 design.md §14。
 */
export function isLegalPosition(pos) {
  const { cells, side } = pos;

  // 1. 双方各恰好一个将 / 帅
  let redKings = 0, blackKings = 0;
  for (let i = 0; i < CELLS; i++) {
    if (cells[i] === K) redKings++;
    else if (cells[i] === -K) blackKings++;
  }
  if (redKings !== 1) return { ok: false, reason: `红方帅的数量是 ${redKings}，应为 1` };
  if (blackKings !== 1) return { ok: false, reason: `黑方将的数量是 ${blackKings}，应为 1` };

  // 2. 将帅不照面
  const redKing = findKing(cells, RED);
  const blackKing = findKing(cells, -RED);
  if (xOf(redKing) === xOf(blackKing)) {
    let blocked = false;
    const lo = Math.min(yOf(redKing), yOf(blackKing)) + 1;
    const hi = Math.max(yOf(redKing), yOf(blackKing));
    for (let y = lo; y < hi; y++) {
      if (cells[indexOf(xOf(redKing), y)] !== EMPTY) { blocked = true; break; }
    }
    if (!blocked) return { ok: false, reason: '将帅照面（同一条纵线且中间无子）' };
  }

  // 3 & 4. 每个棋子都要在自己的合法区域内；顺便统计子力数量
  const counts = new Map();
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const s = Math.sign(v);
    const abs = Math.abs(v);
    const x = xOf(i), y = yOf(i);
    const who = s === RED ? '红' : '黑';

    counts.set(v, (counts.get(v) || 0) + 1);

    if (abs === K && !inPalace(x, y, s)) {
      return { ok: false, reason: `${who}方将/帅在 (${x},${y})，不在九宫内` };
    }
    if (abs === A && !onAnySpot(ADVISOR_SPOTS[s], x, y)) {
      return { ok: false, reason: `${who}方士/仕在 (${x},${y})，不在九宫斜点上` };
    }
    if (abs === B && !onAnySpot(ELEPHANT_SPOTS[s], x, y)) {
      return { ok: false, reason: `${who}方象/相在 (${x},${y})，不在象位上（过河或位置错误）` };
    }
    if (abs === P) {
      // 兵 / 卒不能出现在自己的底线
      if (s === RED && y === 9) return { ok: false, reason: `红兵在 (${x},${y})，位于己方底线` };
      if (s === -RED && y === 0) return { ok: false, reason: `黑卒在 (${x},${y})，位于己方底线` };
    }
  }

  // 5. 子力数量不超过理论上限
  for (const [code, max] of MAX_COUNT) {
    const n = counts.get(code) || 0;
    const m = counts.get(-code) || 0;
    if (n > max) return { ok: false, reason: `红方有 ${n} 个同种棋子，超过上限 ${max}` };
    if (m > max) return { ok: false, reason: `黑方有 ${m} 个同种棋子，超过上限 ${max}` };
  }

  // 6. 非轮走方不该被将军（那意味着上一步走错了）
  if (inCheck(cells, -side)) {
    return { ok: false, reason: '非轮走方正被将军，说明上一步不合法' };
  }

  return { ok: true };
}
