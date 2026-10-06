/**
 * 规则引擎：着法生成、攻击判定、合法性、终局判定。纯逻辑。
 *
 * 两层接口，用途不同：
 *   generateMoves(cells, side)   伪合法着法（不检查走完后己方是否被将军）—— 搜索用
 *   generateLegalMoves(pos)      合法着法 —— 界面走子校验、终局判定用
 */

import { COLS, ROWS, CELLS, EMPTY, K, A, B, N, R, C, P, RED } from './config.js';
import { indexOf, xOf, yOf, inBoard } from './position.js';

// 四个正交方向（导出：评估算机动性也要用同一张表 —— 方向表写两份迟早会错开）
export const ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];

// 马：[目标位移 dx, dy, 马腿位移 lx, ly]
// 马腿是「先直走的那一格」，也就是位移绝对值等于 2 的那个方向上的相邻格
// （导出：评估算马的机动性要用同一张表）
export const HORSE = [
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
    if (v === EMPTY || v * side < 0) continue;
    const x = from % COLS, y = (from - x) / COLS;
    const abs = v < 0 ? -v : v;
    switch (abs) {
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

/**
 * 下面这些生成器刻意写得“摊开”：方向表**按索引循环**（不用 `for (const [dx, dy] of …)`），
 * 行列、越界、棋子编码都直接算，不调 `indexOf` / `inBoard` / `encodeMove` / `Math.sign`。
 *
 * 理由与 `isAttacked` 那一处相同：着法生成占搜索自耗时约 20%，而每个节点都要全量生成一次，
 * 迭代器 + 解构 + 每格一次的函数调用在这个密度下是主要开销。
 *
 * **推入顺序必须与改前逐个相同** —— 并列分值的着法靠生成顺序决定先后，顺序一变节点数就变，
 * “节点数一个不差”这条断言也就白设了。所以每个方向表的条目次序都原样保留。
 */

/** 车：四方向直线滑动，遇子停止，遇敌子可吃 */
function genRook(out, cells, from, x, y, side) {
  const base = from * CELLS;
  for (let d = 0; d < 4; d++) {
    const dx = ORTHO[d][0], dy = ORTHO[d][1];
    let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS) {
      const idx = cy * COLS + cx;
      const t = cells[idx];
      if (t === EMPTY) {
        out.push(base + idx);
      } else {
        if (t * side < 0) out.push(base + idx);
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
  const base = from * CELLS;
  for (let d = 0; d < 4; d++) {
    const dx = ORTHO[d][0], dy = ORTHO[d][1];
    let cx = x + dx, cy = y + dy;

    while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && cells[cy * COLS + cx] === EMPTY) {
      out.push(base + cy * COLS + cx);
      cx += dx; cy += dy;
    }
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;

    // (cx,cy) 是炮架，从它后面继续找第一个子
    cx += dx; cy += dy;
    while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS) {
      const idx = cy * COLS + cx;
      const t = cells[idx];
      if (t !== EMPTY) {
        if (t * side < 0) out.push(base + idx);
        break;
      }
      cx += dx; cy += dy;
    }
  }
}

/** 兵 / 卒：未过河只能向前一格，过河后可向前或左右一格，永不后退 */
function genPawn(out, cells, from, x, y, side) {
  const base = from * CELLS;
  const fy = y - side; // 红方前进 y 减小，黑方前进 y 增大
  if (fy >= 0 && fy < ROWS) {
    const idx = fy * COLS + x;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }

  // 过河后才能横走：红兵到 y <= 4，黑卒到 y >= 5
  const crossed = side === RED ? y <= 4 : y >= 5;
  if (!crossed) return;

  if (x > 0) {
    const idx = y * COLS + x - 1;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }
  if (x < COLS - 1) {
    const idx = y * COLS + x + 1;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }
}

/** 将 / 帅：四方向一格，不得出九宫 */
function genKing(out, cells, from, x, y, side) {
  const base = from * CELLS;
  for (let d = 0; d < 4; d++) {
    const cx = x + ORTHO[d][0], cy = y + ORTHO[d][1];
    if (!inPalace(cx, cy, side)) continue;
    const idx = cy * COLS + cx;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }
}

/** 马：八个日字目标；马腿（先直走的那一格）有子则该方向全部禁止 */
function genHorse(out, cells, from, x, y, side) {
  const base = from * CELLS;
  for (let d = 0; d < 8; d++) {
    const h = HORSE[d];
    const legX = x + h[2], legY = y + h[3];
    // 马腿在棋盘外时，对应的目标也必然在棋盘外，直接跳过
    if (legX < 0 || legX >= COLS || legY < 0 || legY >= ROWS) continue;
    if (cells[legY * COLS + legX] !== EMPTY) continue;

    const cx = x + h[0], cy = y + h[1];
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;
    const idx = cy * COLS + cx;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }
}

/** 象 / 相：四个田字目标；象眼（田字中心）有子则禁；不得过河 */
function genElephant(out, cells, from, x, y, side) {
  const base = from * CELLS;
  for (let d = 0; d < 4; d++) {
    const dx = ELEPHANT[d][0], dy = ELEPHANT[d][1];
    const cx = x + dx, cy = y + dy;
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;
    if (!ownHalf(cy, side)) continue;
    if (cells[(y + dy / 2) * COLS + (x + dx / 2)] !== EMPTY) continue; // 塞象眼
    const idx = cy * COLS + cx;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
  }
}

/** 士 / 仕：四个斜向一格；不得出九宫 */
function genAdvisor(out, cells, from, x, y, side) {
  const base = from * CELLS;
  for (let d = 0; d < 4; d++) {
    const cx = x + ADVISOR[d][0], cy = y + ADVISOR[d][1];
    if (!inPalace(cx, cy, side)) continue;
    const idx = cy * COLS + cx;
    const t = cells[idx];
    if (t === EMPTY || t * side < 0) out.push(base + idx);
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
  // 采样里这是整个搜索**最热的单个函数**（自耗时约 27%），所以这里的写法偏执：
  //   - 方向表按索引循环，不用 `for (const [dx, dy] of …)`（迭代器 + 解构每次调用都要走一遍）；
  //   - 行列直接算，不调 xOf / yOf / indexOf / inBoard；
  //   - 判色判型不调 Math.sign / Math.abs，改成「与敌方棋子编码直接比」（一次乘法预算好）。
  // 语义与改前逐字对应 —— 改完**节点数必须一个不差**（tools/test-engine.mjs 里钉着）。
  const x = idx % COLS, y = (idx - x) / COLS;
  const target = cells[idx];
  const eR = bySide * R, eC = bySide * C, eK = bySide * K, eN = bySide * N, eP = bySide * P;

  // 车 / 炮 / 将：沿四个正交方向
  for (let d = 0; d < 4; d++) {
    const dx = ORTHO[d][0], dy = ORTHO[d][1];
    let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && cells[cy * COLS + cx] === EMPTY) {
      cx += dx; cy += dy;
    }
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) continue;

    const first = cells[cy * COLS + cx];
    if (first === eR) return true;                                   // 车
    if (first === eK) {
      if (cx - x === dx && cy - y === dy) return true;               // 将贴身
      if (target === -eK) return true;                               // 将帅照面（中间无子）
    }

    // 炮：隔一个子才能吃
    cx += dx; cy += dy;
    while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && cells[cy * COLS + cx] === EMPTY) {
      cx += dx; cy += dy;
    }
    if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && cells[cy * COLS + cx] === eC) return true;
  }

  // 马：反过来找八个能跳到 idx 的位置
  for (let d = 0; d < 8; d++) {
    const dx = HORSE[d][0], dy = HORSE[d][1], lx = HORSE[d][2], ly = HORSE[d][3];
    const kx = x - dx, ky = y - dy;
    if (kx < 0 || kx >= COLS || ky < 0 || ky >= ROWS) continue;
    if (cells[ky * COLS + kx] !== eN) continue;
    const bx = kx + lx, by = ky + ly;
    if (bx < 0 || bx >= COLS || by < 0 || by >= ROWS) continue;
    if (cells[by * COLS + bx] !== EMPTY) continue;                   // 蹩马腿
    return true;
  }

  // 兵 / 卒：正前方一格 + 过河后的左右一格
  const py = y + bySide; // 兵所在的行：红方(bySide=1)在下一行，黑方(bySide=-1)在上一行
  if (py >= 0 && py < ROWS && cells[py * COLS + x] === eP) return true;
  const crossed = bySide === RED ? y <= 4 : y >= 5;
  if (crossed) {
    if (x > 0 && cells[y * COLS + x - 1] === eP) return true;
    if (x < COLS - 1 && cells[y * COLS + x + 1] === eP) return true;
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
 * 它是循环的**兜底**：三次重复本身不分胜负，只有循环里没人长将时才是和棋
 * （长将判负见 classifyRepetition）。
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

/**
 * 「长将」判定 —— 一段循环里，有没有哪一方**每一步都在将军**。
 *
 * sides / checks 是同一段循环里的着法，按时间顺序一一对应：
 *   sides[i]  第 i 步的走子方（±1）
 *   checks[i] 第 i 步是否将军
 *
 * 返回长将方的阵营（±1）；**双方都在长将、或者都没长将时返回 0** ——
 * 那两种情况都按判和处理：互将棋规判和，没人长将也只是普通重复。
 *
 * ## 为什么只做「长将」，不做长捉 / 长兑 / 一将一杀
 *
 * 循环规则里其余几条都要逐子比较「捉了谁、捉得比上次重不重」，实现和测试成本
 * 完全不是一个量级（见 design.md §5.3 的裁剪记录）。而长将是唯一一条在普通对局里
 * 真会反复出现、并且直接决定胜负的：拿长将当耍赖手段。只做这一条，覆盖面最大。
 */
export function perpetualChecker(sides, checks) {
  let redAll = true;
  let blackAll = true;
  for (let i = 0; i < sides.length; i++) {
    if (checks[i]) continue;
    if (sides[i] === RED) redAll = false;
    else blackAll = false;
  }
  // 两边都为真（互将）或都为假（都没长将）→ 0，判和
  if (redAll === blackAll) return 0;
  return redAll ? RED : -RED;
}

/**
 * 三次重复的**定性**：普通判和，还是一方长将判负。
 *
 * @param {string[]} signatures 局面签名，signatures[0] 是起点（长度 = 步数 + 1）
 * @param {number[]} sides      每一步的走子方（±1），与 checks 等长
 * @param {boolean[]} checks    每一步是否将军
 * @returns {null | { type: 'repetition' } | { type: 'perpetual-check', loser: number }}
 *          null = 还没有三次重复，对局继续进行
 */
export function classifyRepetition(signatures, sides, checks) {
  if (!isThreefoldRepetition(signatures)) return null;

  const last = signatures.length - 1;
  // 判重的那一个是**当前局面**（走成三次重复之后 playMove 就拦住了，不会再多走）。
  // 上面那条不成立时（调用方给了别的序列）宁可判和，也不要拿一个只出现过两次的
  // 循环去指控谁长将。
  let seen = 0;
  for (const s of signatures) if (s === signatures[last]) seen++;
  if (seen < 3) return { type: 'repetition' };

  // 只看最近这一个循环：当前局面上一次出现 → 现在。更早的那些循环不用管，
  // 因为它们已经完整地过去了一遍（再走一遍就是当前这个）。
  const prev = signatures.lastIndexOf(signatures[last], last - 1);
  if (prev < 0) return { type: 'repetition' };

  const checker = perpetualChecker(sides.slice(prev, last), checks.slice(prev, last));
  return checker === 0 ? { type: 'repetition' } : { type: 'perpetual-check', loser: checker };
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
