/**
 * AI 引擎：评估 + 搜索。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 对外只有一个入口 `search()`，内部结构（置换表、着法排序、静态搜索、空着裁剪）
 * 都可以换，不影响调用方。这是「方便后续优化」的落点。
 *
 * ## 评估里不许出现需要生成着法的项
 *
 * 评估在叶节点被调用上百万次 —— 机动性、王安全这类「漂亮指标」都要先生成着法，
 * 加上去等于把搜索成本翻几倍（象棋那边已经踩过，结论直接照搬）。
 * 国象这边能纯查表拿到的、性价比最高的几项（design.md §7.1）：
 * 子力、位置表、相位插值、双象加成、兵结构。想要更强，下一步是给位置表加细，
 * 不是加任何需要生成着法的项。
 *
 * ## 超时必须用异常中断，所以棋盘要能回滚
 *
 * 超时是从 make / unmake 中间穿出去的异常，棋盘会停在「走了一半」的状态上。
 * 做法照搬象棋：`make/unmake` 严格成对，`guarded()` 负责在异常之后把一切还原。
 * 不还原的后果很隐蔽 —— 上层会从错乱的棋盘上挑着法，表现成「AI 不动了」。
 */

import {
  CELLS, FILES, EMPTY, P, N, B, R, Q, K, WHITE,
  PIECE_VALUE, PST, PHASE_WEIGHT, PHASE_MAX, BISHOP_PAIR_BONUS,
  DOUBLED_PAWN_PENALTY, ISOLATED_PAWN_PENALTY, PASSED_BONUS, LEVELS,
} from './config.js';
import {
  fileOf, rankOf, parseFen, zobristKey, hashPiece, hashSide, hashCastle, hashEp,
} from './position.js';
import {
  generateMoves, generateLegalMoves, isAttacked, findKing,
  moveFrom, moveTo, movePromo, moveFlag, FLAG_EP, FLAG_CASTLE,
  nextCastling, nextEp,
} from './rules.js';

const INF = 1e9;
/** 将死分值。带上「离根多远」，让引擎偏好更快的杀棋、更晚的被杀 */
const MATE = 100000;

// 置换表条目类型：精确值 / 只证明了下界 / 只证明了上界
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

/** 静态搜索的层数上限。兑子序列可能很长，必须封顶，否则单节点开销失控 */
const MAX_QUIESCE_DEPTH = 6;

/**
 * 超时中断用的哨兵。
 *
 * 用抛异常而不是逐层检查标志位：标志位要求每一层递归都判断一次，
 * 而那个判断在叶节点上的开销会被放大成千上万倍。
 */
const TIMEOUT = { timeout: true };

const absOf = (piece) => (piece > 0 ? piece : -piece);
/** 历史启发表的索引：起点 * 64 + 终点（着法本身带了升变 / 标记位，不能直接当索引） */
const histIdx = (move) => moveFrom(move) * CELLS + moveTo(move);

/**
 * 静态评估。返回**轮走方视角**的分值（负极大值搜索要求「对自己有利为正」）。
 *
 * 相位插值：中局表与残局表按剩余子力线性插值（王在残局该上前、中局该躲角落，
 * 靠这个自然得到，不用写「王安全」这种需要生成着法的项）。
 */
export function evaluate(cells, side) {
  let mid = 0;
  let end = 0;
  let phase = 0;

  const wFile = [0, 0, 0, 0, 0, 0, 0, 0];
  const bFile = [0, 0, 0, 0, 0, 0, 0, 0];
  const wPawns = [];
  const bPawns = [];
  let wBishops = 0;
  let bBishops = 0;

  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const white = v > 0;
    const abs = white ? v : -v;
    const sign = white ? 1 : -1;
    const file = fileOf(i);
    const rank = rankOf(i);
    // 位置表按「第 8 行在最上面」写，所以白黑各用一套镜像的索引
    const pstIdx = white ? (7 - rank) * FILES + file : rank * FILES + file;
    const table = PST[abs];
    const value = PIECE_VALUE[abs];

    mid += sign * (value + table.mid[pstIdx]);
    end += sign * (value + table.end[pstIdx]);
    phase += PHASE_WEIGHT[abs];

    if (abs === P) {
      if (white) { wFile[file]++; wPawns.push(i); } else { bFile[file]++; bPawns.push(i); }
    } else if (abs === B) {
      if (white) wBishops++; else bBishops++;
    }
  }

  // 双象加成（很小的常量，别喧宾夺主）
  if (wBishops >= 2) { mid += BISHOP_PAIR_BONUS; end += BISHOP_PAIR_BONUS; }
  if (bBishops >= 2) { mid -= BISHOP_PAIR_BONUS; end -= BISHOP_PAIR_BONUS; }

  // 兵结构：叠兵 / 孤兵 / 通路兵，都是 O(兵数) 的查表，不生成着法
  const pawns = pawnScore(wPawns, bPawns, wFile, bFile);
  mid += pawns;
  end += pawns;

  const ph = Math.min(phase, PHASE_MAX);
  const score = (mid * ph + end * (PHASE_MAX - ph)) / PHASE_MAX;
  return side === WHITE ? score : -score;
}

/** 兵结构分（白方视角）。叠兵与孤兵是惩罚，通路兵按推进程度加分 */
function pawnScore(wPawns, bPawns, wFile, bFile) {
  let score = 0;

  for (let f = 0; f < 8; f++) {
    if (wFile[f] > 1) score += DOUBLED_PAWN_PENALTY * (wFile[f] - 1);
    if (bFile[f] > 1) score -= DOUBLED_PAWN_PENALTY * (bFile[f] - 1);
    const wNeighbours = (f > 0 ? wFile[f - 1] : 0) + (f < 7 ? wFile[f + 1] : 0);
    const bNeighbours = (f > 0 ? bFile[f - 1] : 0) + (f < 7 ? bFile[f + 1] : 0);
    if (wFile[f] && !wNeighbours) score += ISOLATED_PAWN_PENALTY * wFile[f];
    if (bFile[f] && !bNeighbours) score -= ISOLATED_PAWN_PENALTY * bFile[f];
  }

  for (const p of wPawns) {
    if (isPassed(p, true, bPawns)) score += PASSED_BONUS[rankOf(p)];
  }
  for (const p of bPawns) {
    // 黑方视角的推进程度：用镜像之后的 rank
    if (isPassed(p, false, wPawns)) score -= PASSED_BONUS[7 - rankOf(p)];
  }
  return score;
}

/** 这个兵前方（同纵线或相邻纵线）还有没有对方的兵 */
function isPassed(pawn, white, enemyPawns) {
  const f = fileOf(pawn);
  const r = rankOf(pawn);
  for (const e of enemyPawns) {
    if (Math.abs(fileOf(e) - f) > 1) continue;
    const er = rankOf(e);
    if (white ? er > r : er < r) return false;
  }
  return true;
}

/**
 * 一次搜索的全部可变状态。
 *
 * 整个搜索复用同一个实例：节点上不分配对象（走子与回退的中间信息写在
 * `undos[ply]` 上按层复用），这是引擎里唯一「可变」的地方 ——
 * 对外暴露的 search() 每次都会新建一个。
 */
export class Searcher {
  constructor(pos, level, rng = Math.random) {
    this.cells = pos.cells.slice(); // 自己的副本：调用方的局面一个字节都不会被改
    this.side = pos.side;
    this.castling = pos.castling;
    this.ep = pos.ep;
    this.halfmove = pos.halfmove;
    this.key = zobristKey(this.view());
    this.rootKey = this.key;

    this.level = level;
    this.rng = rng;
    this.nodes = 0;

    // useTT = false 用来做对照实验：验证置换表只省节点、不改结果
    this.useTT = level.useTT !== false;
    this.tt = new Map();       // key -> { depth, score, flag, move }
    this.killers = [];         // killers[ply] = [move1, move2]
    this.history = new Int32Array(CELLS * CELLS);

    // 两个王的位置，增量维护：kings[0] = 白王、kings[1] = 黑王，-1 表示已不在盘上。
    // 搜索里「这一步走完之后己方王还安全吗」每试一个着法都要问一次，
    // 而 findKing 是全盘扫 64 格 —— 这是整个引擎最热的一处，值得单独维护。
    this.kings = [findKing(this.cells, WHITE), findKing(this.cells, -WHITE)];
    // 重子（车 / 后）数量：空着裁剪只在「不是残局」时用，这个计数就是它的闸门。
    // 增量维护，不为了一个判断去扫全盘。
    this.major = 0;
    for (let i = 0; i < CELLS; i++) {
      const a = absOf(this.cells[i]);
      if (a === R || a === Q) this.major++;
    }

    // 将军延伸的预算：一条线最多多搜几层。0 = 不延伸（弱挡位用）
    this.checkExtension = level.checkExtension || 0;

    // 时间控制：Date.now() 本身不便宜，所以每 1024 个节点才查一次
    this.deadline = Infinity;
    this.checkEvery = 1024;

    // 这条线上出现过的局面（重复判定用）。只放 key 不存棋盘 ——
    // 三次重复判和要的是「这个局面之前出现过吗」，不是「长什么样」。
    this.keyCount = new Map([[this.key, 1]]);

    // 按层复用的回退槽位（避免每个节点分配对象）
    this.undos = [];
    this._view = null;
  }

  /**
   * 传给 rules.js 的「局面视图」。
   *
   * **复用一个对象**而不是每次新建：generateMoves 在每个节点都会被调到，
   * 每次分配一个 { cells, side, castling, ep } 会让 GC 变成热点。
   */
  view() {
    const v = this._view || (this._view = { cells: null, side: 0, castling: 0, ep: -1, halfmove: 0 });
    v.cells = this.cells;
    v.side = this.side;
    v.castling = this.castling;
    v.ep = this.ep;
    v.halfmove = this.halfmove;
    return v;
  }

  kingOf(side) { return this.kings[side > 0 ? 0 : 1]; }

  /** 某一方是否正被将军。王已经不在盘上也算（上层会把「一步都走不了」判成被杀） */
  inCheck(side) {
    const king = this.kingOf(side);
    return king < 0 || isAttacked(this.cells, king, -side);
  }

  /** 刚走完的那一方，其王是否安全（也就是这一步是否合法） */
  leavesKingSafe() {
    const king = this.kingOf(-this.side);
    return king >= 0 && !isAttacked(this.cells, king, this.side);
  }

  /** 这条线上同一个局面出现过两次 → 搜索里当和棋（否则引擎会主动走进三次重复） */
  isRepetition() { return (this.keyCount.get(this.key) || 0) >= 2; }

  /** 搜索里遇到的判和条件：重复局面 / 50 步 */
  isDraw() { return this.isRepetition() || this.halfmove >= 100; }

  /**
   * 走一步。返回被吃的子（可能是 EMPTY，回退时不用它也行 —— 槽位里存着）。
   *
   * 哈希的五个异或项是无条件写的：hashPiece(EMPTY, idx) 恒为 0，
   * 所以「没吃子」这一支不需要特殊处理，make / unmake 两边也就天然对称。
   */
  make(move, ply) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flag = moveFlag(move);
    const promo = movePromo(move);
    const piece = this.cells[from];
    const side = this.side;
    const capturedIdx = flag === FLAG_EP ? to - side * 8 : to;
    const captured = this.cells[capturedIdx];

    let u = this.undos[ply];
    if (!u) u = this.undos[ply] = {};
    u.piece = piece;
    u.captured = captured;
    u.capturedIdx = capturedIdx;
    u.castling = this.castling;
    u.ep = this.ep;
    u.halfmove = this.halfmove;
    u.key = this.key;
    u.rookFrom = -1;
    u.rookTo = -1;

    // === 哈希（增量）===
    let key = this.key ^ hashPiece(piece, from) ^ hashPiece(captured, capturedIdx);
    const newPiece = promo ? side * promo : piece;
    key ^= hashPiece(newPiece, to);

    const newCastling = nextCastling(this.castling, move, this.cells);
    const newEp = nextEp(move);
    key ^= hashCastle(this.castling) ^ hashCastle(newCastling);
    key ^= hashEp(this.ep) ^ hashEp(newEp);

    // === 棋盘 ===
    if (capturedIdx !== to) this.cells[capturedIdx] = EMPTY;
    this.cells[to] = newPiece;
    this.cells[from] = EMPTY;
    if (flag === FLAG_CASTLE) {
      const rank = rankOf(from);
      const kingSide = fileOf(to) === 6;
      const rookFrom = (kingSide ? 7 : 0) + rank * 8;
      const rookTo = (kingSide ? 5 : 3) + rank * 8;
      const rook = this.cells[rookFrom];
      key ^= hashPiece(rook, rookFrom) ^ hashPiece(rook, rookTo);
      this.cells[rookTo] = rook;
      this.cells[rookFrom] = EMPTY;
      u.rookFrom = rookFrom;
      u.rookTo = rookTo;
    }

    this.key = (key ^ hashSide()) >>> 0;
    this.side = -side;
    this.castling = newCastling;
    this.ep = newEp;
    this.halfmove = (absOf(piece) === P || captured !== EMPTY) ? 0 : u.halfmove + 1;

    if (absOf(piece) === K) this.kings[piece > 0 ? 0 : 1] = to;
    if (captured !== EMPTY && absOf(captured) === K) this.kings[captured > 0 ? 0 : 1] = -1;

    // 重子计数：升变可能凭空多出一个后 / 车，被吃则少一个
    if (absOf(piece) === R || absOf(piece) === Q) this.major++;
    if (promo === Q || promo === R) this.major++;
    if (captured !== EMPTY && (absOf(captured) === R || absOf(captured) === Q)) this.major--;

    this.keyCount.set(this.key, (this.keyCount.get(this.key) || 0) + 1);
  }

  unmake(move, ply) {
    const u = this.undos[ply];
    const from = moveFrom(move);
    const to = moveTo(move);

    const n = this.keyCount.get(this.key) - 1;
    if (n <= 0) this.keyCount.delete(this.key);
    else this.keyCount.set(this.key, n);

    if (u.rookFrom >= 0) {
      this.cells[u.rookFrom] = this.cells[u.rookTo];
      this.cells[u.rookTo] = EMPTY;
    }
    this.cells[from] = u.piece;
    this.cells[to] = u.capturedIdx === to ? u.captured : EMPTY;
    if (u.capturedIdx !== to) this.cells[u.capturedIdx] = u.captured;

    this.key = u.key;
    this.side = -this.side;
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;

    if (absOf(u.piece) === K) this.kings[u.piece > 0 ? 0 : 1] = from;
    if (u.captured !== EMPTY && absOf(u.captured) === K) {
      this.kings[u.captured > 0 ? 0 : 1] = u.capturedIdx;
    }

    const promo = movePromo(move);
    if (absOf(u.piece) === R || absOf(u.piece) === Q) this.major--;
    if (promo === Q || promo === R) this.major--;
    if (u.captured !== EMPTY && (absOf(u.captured) === R || absOf(u.captured) === Q)) this.major++;
  }

  /**
   * 空着（不走棋，只把走子权交给对方）。
   *
   * **刻意不进 keyCount**：空着不对应任何真实局面，记进去会让重复判定误判。
   */
  makeNull(ply) {
    let u = this.undos[ply];
    if (!u) u = this.undos[ply] = {};
    u.piece = EMPTY;
    u.captured = EMPTY;
    u.capturedIdx = -1;
    u.castling = this.castling;
    u.ep = this.ep;
    u.halfmove = this.halfmove;
    u.key = this.key;
    u.rookFrom = -1;
    u.rookTo = -1;

    this.key = (this.key ^ hashEp(this.ep) ^ hashSide()) >>> 0;
    this.ep = -1;
    this.halfmove += 1;
    this.side = -this.side;
  }

  unmakeNull(ply) {
    const u = this.undos[ply];
    this.key = u.key;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.side = -this.side;
  }

  /**
   * 着法排序。顺序直接决定 alpha-beta 的剪枝效率，是引擎里性价比最高的一处优化。
   * 优先级：置换表着法 > 吃子（MVV-LVA）> 升变 > 杀手着法 > 历史启发。
   */
  orderMoves(moves, ply, ttMove) {
    const score = (move) => {
      if (move === ttMove) return 1e7;
      const victim = this.cells[moveTo(move)];
      if (victim !== EMPTY) {
        // MVV-LVA：优先「用小子吃大子」
        return 1e6 + PIECE_VALUE[absOf(victim)] * 10
          - PIECE_VALUE[absOf(this.cells[moveFrom(move)])];
      }
      const promo = movePromo(move);
      if (promo) return 9e5 + PIECE_VALUE[promo];
      const k = this.killers[ply];
      if (k) {
        if (k[0] === move) return 8e5;
        if (k[1] === move) return 7e5;
      }
      return this.history[histIdx(move)];
    };
    return moves.slice().sort((a, b) => score(b) - score(a));
  }

  /** 把一个着法记为杀手着法（在同一层造成剪枝的非吃子着法） */
  recordKiller(move, ply) {
    const k = this.killers[ply] || (this.killers[ply] = [0, 0]);
    if (k[0] === move) return;
    k[1] = k[0];
    k[0] = move;
  }

  /** 这一步是不是「响着」（吃子 / 升变 / 吃过路兵）—— 静态搜索只搜响着 */
  isLoud(move) {
    return this.cells[moveTo(move)] !== EMPTY
      || movePromo(move) !== 0
      || moveFlag(move) === FLAG_EP;
  }

  /**
   * 静态搜索：只搜响着，把「兑子序列没走完就评估」这个水平线效应消掉。
   *
   * 被将军时改为搜**全部**着法 —— 只看吃子的话会漏掉「唯一的应将手段」，
   * 得出「被将死也没关系」的荒谬结论。顺带这也是「开了静态搜索的挡位在深度 1
   * 也能发现一步杀」的原因：被将军的节点会生成全部着法，从而发现对方一步都走不了。
   */
  quiesce(alpha, beta, ply, qdepth) {
    this.nodes++;

    const checked = this.inCheck(this.side);
    if (!checked) {
      const stand = evaluate(this.cells, this.side);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }

    // 层数用尽时给一个静态分兜底。
    // **绝不能返回 alpha** —— 它可能是 -INF，取负之后会变成 +INF，
    // 而迭代加深判断「找到杀棋」的条件是 |score| > MATE - 1000，
    // 于是会把 -INF 当成杀棋、提前停止加深（表现成挡位突然只搜 1 层）。
    // 这个坑是象棋那边自对弈冒烟测试发现的。
    if (qdepth <= 0) return evaluate(this.cells, this.side);

    const all = generateMoves(this.view());
    const moves = [];
    for (const m of all) {
      if (moveFlag(m) === FLAG_CASTLE) continue;      // 易位是安静着法
      if (checked || this.isLoud(m)) moves.push(m);
    }

    let best = alpha;
    let legalCount = 0;
    for (const move of this.orderMoves(moves, ply, 0)) {
      this.make(move, ply);
      if (!this.leavesKingSafe()) { this.unmake(move, ply); continue; }
      legalCount++;
      const score = -this.quiesce(-beta, -best, ply + 1, qdepth - 1);
      this.unmake(move, ply);
      if (score > best) best = score;
      if (best >= beta) return best;
    }

    // 被将军且一步都走不了 = 将死（不处理的话 best 会停在 alpha，会被上层误判成杀棋）
    if (checked && legalCount === 0) return -MATE + ply;
    return best;
  }

  /**
   * 负极大值形式的 alpha-beta，带 PVS、置换表、着法排序、将军延伸、空着裁剪。
   *
   * ext 是「这条线还能延伸几层」的预算（挡位参数 checkExtension）。被将军的节点
   * 不消耗深度 —— 被将军时合法着法往往只有一两个，多搜一层很便宜。
   */
  negamax(depth, alpha, beta, ply, ext = 0, canNull = true) {
    this.nodes++;

    if (--this.checkEvery <= 0) {
      this.checkEvery = 1024;
      if (Date.now() >= this.deadline) throw TIMEOUT;
    }

    // 搜索里遇到重复局面 / 50 步，直接当和棋（返回 0）——
    // 不处理的话引擎会主动走进「重复三次」的坑里
    if (this.isDraw()) return 0;

    if (ext > 0 && this.inCheck(this.side)) {
      depth++;
      ext--;
    }

    const alphaOrig = alpha;
    let ttMove = 0;
    if (this.useTT) {
      const e = this.tt.get(this.key);
      if (e) {
        ttMove = e.move;
        if (e.depth >= depth) {
          if (e.flag === TT_EXACT) return e.score;
          if (e.flag === TT_LOWER && e.score > alpha) alpha = e.score;
          else if (e.flag === TT_UPPER && e.score < beta) beta = e.score;
          if (alpha >= beta) return e.score;
        }
      }
    }

    if (depth <= 0) {
      return this.level.quiescence
        ? this.quiesce(alpha, beta, ply, MAX_QUIESCE_DEPTH)
        : evaluate(this.cells, this.side);
    }

    const checked = this.inCheck(this.side);

    // === 空着裁剪 ===
    // 只在「不是残局」时用：残局里 zugzwang（无好棋可走但不能不动）会让
    // 「我把走子权让给你，你反而更差」这个前提失效，给出错误结论。
    // major 是车 / 后的总数，它是「这是不是残局」的廉价代理。
    if (canNull && !checked && depth >= 3 && this.major >= 2) {
      const reduction = depth >= 6 ? 3 : 2;
      this.makeNull(ply);
      const score = -this.negamax(depth - 1 - reduction, -beta, -beta + 1, ply + 1, ext, false);
      this.unmakeNull(ply);
      if (score >= beta) return beta;
    }

    let best = -INF;
    let bestMove = 0;
    let legalCount = 0;

    const moves = this.orderMoves(generateMoves(this.view()), ply, ttMove);
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const isCapture = this.cells[moveTo(move)] !== EMPTY;

      this.make(move, ply);
      if (!this.leavesKingSafe()) {
        this.unmake(move, ply);
        continue;
      }
      legalCount++;

      // PVS：第一个着法全窗口，其余先零窗口试探，只在「比 alpha 好但没到 beta」时重搜
      let score;
      if (i === 0) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, ext);
      } else {
        score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, ext);
        if (score > alpha && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, ext);
        }
      }
      this.unmake(move, ply);

      if (score > best) { best = score; bestMove = move; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        // 只有非吃子才记杀手 / 历史启发：吃子本来就会被优先搜到，再记一遍没意义
        if (!isCapture) {
          this.recordKiller(move, ply);
          this.history[histIdx(move)] += depth * depth;
        }
        break;
      }
    }

    // 一步都走不了 = 将死或逼和。逼和也是和棋（0 分），但用 -MATE 会让引擎
    // 「宁可把自己憋死也不认输」，所以这里要分开：被将军才是被杀。
    if (legalCount === 0) return checked ? -MATE + ply : 0;

    // 杀棋分值带「离根多远」的信息，换一层深度就不对了，所以不存进置换表
    if (this.useTT && Math.abs(best) < MATE - 1000) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      const old = this.tt.get(this.key);
      if (!old || old.depth <= depth) this.tt.set(this.key, { depth, score: best, flag, move: bestMove });
    }
    return best;
  }

  /**
   * 搜索根节点。
   *
   * exact = false：用「只带 alpha 的窗口」，剪枝强，但**非最优着法拿到的只是上界**。
   * exact = true：每个根着法都开全窗口，拿到精确分值。
   *
   * 需要精确分值的地方只有一个 —— 挡位的评分噪声要比较所有根着法，
   * 拿上界去比会把「看起来很接近、其实差很远」的着法选出来。
   */
  searchRootAt(depth, ordered, exact = false) {
    let bestMove = ordered[0];
    let bestScore = -INF;
    const scores = new Map();

    let childDepth = depth - 1;
    let ext = this.checkExtension;
    if (ext > 0 && this.inCheck(this.side)) {
      childDepth = depth;
      ext--;
    }

    for (const move of ordered) {
      this.make(move, 0);
      const score = exact
        ? -this.negamax(childDepth, -INF, INF, 1, ext)
        : -this.negamax(childDepth, -INF, -bestScore, 1, ext);
      this.unmake(move, 0);

      scores.set(move, score);
      if (score > bestScore) { bestScore = score; bestMove = move; }
    }
    return { move: bestMove, score: bestScore, scores };
  }

  /**
   * 跑一段可能抛 TIMEOUT 的搜索，无论结果如何都把棋盘恢复成原样。
   *
   * 超时是从 make() / unmake() 中间穿出去的异常，棋盘会停在一个「走了一半」的状态上。
   * 调用方之后还要用 searcher.cells 生成根着法（挡位弱化那一段），
   * 从错乱的棋盘上挑着法会挑出非法着法 —— 上层 playMove 拒掉它，表现成「AI 不动了」。
   * 把回滚收到这一个地方，比在每条超时路径上各写一遍可靠。
   */
  guarded(fn) {
    const snapshot = {
      cells: this.cells.slice(),
      side: this.side,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      key: this.key,
      kings: this.kings.slice(),
      major: this.major,
    };
    try {
      return fn();
    } finally {
      this.cells.set(snapshot.cells);
      this.side = snapshot.side;
      this.castling = snapshot.castling;
      this.ep = snapshot.ep;
      this.halfmove = snapshot.halfmove;
      this.key = snapshot.key;
      this.kings = snapshot.kings;
      this.major = snapshot.major;
      // 重复局面表也要还原：超时之后残留的计数会让下一轮搜索误判成和棋
      this.keyCount = new Map([[this.rootKey, 1]]);
    }
  }

  /**
   * 迭代加深：从 1 层逐层加深，每层用上一层的最优着法排在最前面。
   *
   * 好处有两个：时间控制天然生效（超时就丢掉没跑完的那一层），
   * 以及浅层结果能给深层做很好的着法排序 —— 这是最省事的着法排序来源。
   *
   * 超时后**必须保留上一层已经完成的结果**，所以 catch 里是 break 而不是往外抛。
   */
  iterativeDeepen() {
    const moves = generateLegalMoves(this.view());
    if (moves.length === 0) return null;
    // 只有一个合法着法：不必搜（也避免极短的时间预算下把唯一着法也丢掉）
    if (moves.length === 1) {
      return { move: moves[0], score: 0, scores: new Map([[moves[0], 0]]), depth: 1 };
    }

    let best = null;
    let ordered = moves;

    for (let depth = 1; depth <= this.level.depth; depth++) {
      let result;
      try {
        // 包一层 guarded：超时是从 make() / unmake() 中间穿出来的异常
        result = this.guarded(() => this.searchRootAt(depth, ordered, this.level.noise > 0));
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break; // 这一层没跑完，丢掉它，保留上一层的结果
      }
      best = { ...result, depth };
      // 下一层从这一层的最优着法开始搜（剪枝效率更高）
      const rest = [...result.scores.keys()].filter((m) => m !== result.move);
      ordered = [result.move, ...rest];
      if (Math.abs(result.score) > MATE - 1000) break; // 已经找到杀棋，不必再深
    }
    return best;
  }
}

/**
 * 搜索入口。
 *
 * level 可以是挡位 id，也可以直接是一个挡位对象 ——
 * 测试需要构造「深度 2、关掉静态搜索」这类自定义挡位，走对象形式最省事。
 * options.rng 用来注入随机源，默认 Math.random；测试传固定种子以得到确定结果。
 */
export function search(fen, level, options = {}) {
  const lv = typeof level === 'string' ? LEVELS.find((l) => l.id === level) : level;
  if (!lv) throw new Error(`未知挡位：${level}`);

  const searcher = new Searcher(parseFen(fen), lv, options.rng || Math.random);
  const started = Date.now();
  searcher.deadline = started + lv.timeLimitMs;

  const result = searcher.iterativeDeepen();
  const allMoves = generateLegalMoves(searcher.view());
  if (allMoves.length === 0) return null; // 局面已经终局

  let move = result ? result.move : allMoves[0];
  let blundered = false;

  // === 挡位弱化：只在根节点施加，不碰搜索内部 ===
  //
  // 失误：放弃搜索结果，从「除最优着法之外」的合法着法里随机挑一个。
  // 只剩一个合法着法时绝不能触发 —— 那会走出非法着法，上层直接崩。
  if (result && lv.blunderRate > 0 && allMoves.length > 1 && searcher.rng() < lv.blunderRate) {
    const others = allMoves.filter((m) => m !== move);
    move = others[Math.floor(searcher.rng() * others.length)];
    blundered = true;
  } else if (result && lv.noise > 0 && result.scores.size > 1) {
    // 噪声：给每个根着法的评分加一个均匀扰动，重新选最优。
    // 这让弱挡位倾向选次优着，而不是永远走同一个最优着。
    let bestVal = -INF;
    for (const [m, s] of result.scores) {
      const noisy = s + (searcher.rng() * 2 - 1) * lv.noise;
      if (noisy > bestVal) { bestVal = noisy; move = m; }
    }
  }

  return {
    move,
    from: moveFrom(move),
    to: moveTo(move),
    promo: movePromo(move),
    score: result ? result.score : 0,
    depth: result ? result.depth : 0,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
    blundered,
  };
}
