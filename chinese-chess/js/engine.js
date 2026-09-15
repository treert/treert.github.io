/**
 * AI 引擎：评估 + 搜索。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 对外只有一个入口 search()，内部结构（置换表、着法排序、静态搜索）都可以换，
 * 不影响调用方。这是「方便后续优化」的落点。
 */

import { CELLS, EMPTY, P, RED, PIECE_VALUE, PASSED_PAWN_BONUS, LEVELS } from './config.js';
import { yOf, parseFen, zobristKey, hashPiece, hashSide } from './position.js';
import { generateMoves, generateLegalMoves, isAttacked, findKing, moveFrom, moveTo } from './rules.js';

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
 * 静态评估：只算子力和兵是否过河。
 *
 * 返回**轮走方视角**的分值 —— 负极大值搜索要求「分数总是对当前走子方有利为正」。
 *
 * 刻意不加机动性、位置表这类项：
 *   - 机动性需要生成全部着法，而评估在叶节点被调用上百万次，等于把搜索成本翻倍
 *   - 位置表要维护 7 × 90 格的数据，是独立的一块手工维护点，留到棋力不够时再加
 * 想提升棋力，正确的下一步是加 90 格位置表（O(1) 查表），不是加任何需要生成着法的项。
 */
export function evaluate(cells, side) {
  let score = 0; // 先按红方视角累加
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const abs = Math.abs(v);
    let value = PIECE_VALUE[abs];
    if (abs === P) {
      const y = yOf(i);
      const crossed = v > 0 ? y <= 4 : y >= 5;
      if (crossed) value += PASSED_PAWN_BONUS;
    }
    score += v > 0 ? value : -value;
  }
  return side === RED ? score : -score;
}

/**
 * 一次搜索的全部可变状态。
 *
 * 整个搜索复用同一个实例：节点上不分配对象，走子与回退成对出现。
 * 这是引擎里唯一「可变」的地方 —— 对外暴露的 search() 每次都会新建一个。
 */
export class Searcher {
  constructor(cells, side, level, rng = Math.random) {
    this.cells = cells;
    this.side = side;
    this.key = zobristKey(cells, side);
    this.level = level;
    this.rng = rng;
    this.nodes = 0;

    // useTT = false 用来做对照实验：验证置换表只省节点、不改结果
    this.useTT = level.useTT !== false;
    this.tt = new Map();      // key -> { depth, score, flag, move }
    this.killers = [];        // killers[ply] = [move1, move2]
    this.history = new Int32Array(CELLS * CELLS);
  }

  /**
   * 走一步。返回被吃的子（可能是 EMPTY），回退时要原样传回 unmake()。
   *
   * 哈希的三个异或项是无条件写的 —— 因为 hashPiece(EMPTY, idx) 恒为 0，
   * 所以「没吃子」这一支不需要特殊处理，make / unmake 两边也就天然对称。
   */
  make(move) {
    const from = moveFrom(move), to = moveTo(move);
    const piece = this.cells[from];
    const captured = this.cells[to];
    this.key = (this.key ^ hashPiece(piece, from) ^ hashPiece(piece, to) ^ hashPiece(captured, to)) >>> 0;
    this.cells[to] = piece;
    this.cells[from] = EMPTY;
    this.side = -this.side;
    this.key = (this.key ^ hashSide()) >>> 0;
    return captured;
  }

  unmake(move, captured) {
    const from = moveFrom(move), to = moveTo(move);
    const piece = this.cells[to];
    this.key = (this.key ^ hashPiece(piece, to) ^ hashPiece(piece, from) ^ hashPiece(captured, to)) >>> 0;
    this.cells[from] = piece;
    this.cells[to] = captured;
    this.side = -this.side;
    this.key = (this.key ^ hashSide()) >>> 0;
  }

  /**
   * 着法排序。顺序直接决定 alpha-beta 的剪枝效率，是引擎里性价比最高的一处优化。
   * 优先级：置换表着法 > 吃子（MVV-LVA）> 杀手着法 > 历史启发。
   */
  orderMoves(moves, ply, ttMove) {
    const score = (move) => {
      if (move === ttMove) return 1e7;
      const victim = this.cells[moveTo(move)];
      if (victim !== EMPTY) {
        // MVV-LVA：优先「用小子吃大子」
        return 1e6 + PIECE_VALUE[Math.abs(victim)] * 10
                    - PIECE_VALUE[Math.abs(this.cells[moveFrom(move)])];
      }
      const k = this.killers[ply];
      if (k) {
        if (k[0] === move) return 9e5;
        if (k[1] === move) return 8e5;
      }
      return this.history[move];
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

  /**
   * 刚走完的那一方，其将 / 帅是否安全（也就是这一步是否合法）。
   *
   * 注意 make() 已经把 this.side 翻成了**对方**，
   * 所以要查的是 -this.side 的将、被 this.side 攻击。
   */
  leavesKingSafe() {
    const mover = -this.side;
    const king = findKing(this.cells, mover);
    return king >= 0 && !isAttacked(this.cells, king, this.side);
  }

  /**
   * 静态搜索：只搜吃子，把「兑子序列没走完就评估」这个水平线效应消掉。
   *
   * 被将军时改为搜全部着法 —— 只看吃子的话会漏掉「唯一的应将手段」，
   * 得出「被将死也没关系」的荒谬结论。顺带这也是「开了静态搜索的挡位在深度 1
   * 也能发现一步杀」的原因：被将军的节点会生成全部着法，从而发现对方一步都走不了。
   *
   * stand-pat（静止分）：如果连一步吃子都不走就已经很好了，就不必再算下去。
   *
   * orderMoves 的第三个参数传 0 表示「没有置换表着法」—— 0 这个编码
   * （from = to = 0）永远不可能是合法着法，当哨兵用是安全的。
   */
  quiesce(alpha, beta, ply, qdepth) {
    this.nodes++;

    const king = findKing(this.cells, this.side);
    const checked = king >= 0 && isAttacked(this.cells, king, -this.side);
    if (!checked) {
      const stand = evaluate(this.cells, this.side);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }
    if (qdepth <= 0) return alpha;

    let best = alpha;
    const moves = generateMoves(this.cells, this.side)
      .filter((m) => checked || this.cells[moveTo(m)] !== EMPTY);

    for (const move of this.orderMoves(moves, ply, 0)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      const score = -this.quiesce(-beta, -best, ply + 1, qdepth - 1);
      this.unmake(move, captured);

      if (score > best) best = score;
      if (best >= beta) return best;
    }
    return best;
  }

  /** 负极大值形式的 alpha-beta，带置换表与着法排序 */
  negamax(depth, alpha, beta, ply) {
    this.nodes++;

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

    let best = -INF;
    let bestMove = 0;
    let legalCount = 0;

    for (const move of this.orderMoves(generateMoves(this.cells, this.side), ply, ttMove)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      legalCount++;

      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(move, captured);

      if (score > best) { best = score; bestMove = move; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        // 只有非吃子才记杀手 / 历史启发：吃子本来就会被优先搜到，再记一遍没意义
        if (captured === EMPTY) {
          this.recordKiller(move, ply);
          this.history[move] += depth * depth;
        }
        break;
      }
    }

    // 一步都走不了 = 被将死或困毙，两种情况在中国象棋里都是走子方负
    if (legalCount === 0) return -MATE + ply;

    // 杀棋分值带「离根多远」的信息，换一层深度就不对了，所以不存进置换表
    if (this.useTT && Math.abs(best) < MATE - 1000) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      this.tt.set(this.key, { depth, score: best, flag, move: bestMove });
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

    for (const move of ordered) {
      const captured = this.make(move);
      const score = exact
        ? -this.negamax(depth - 1, -INF, INF, 1)
        : -this.negamax(depth - 1, -INF, -bestScore, 1);
      this.unmake(move, captured);

      scores.set(move, score);
      if (score > bestScore) { bestScore = score; bestMove = move; }
    }
    return { move: bestMove, score: bestScore, scores };
  }

  searchRoot(depth) {
    const moves = generateLegalMoves({ cells: this.cells, side: this.side });
    if (moves.length === 0) return null;
    return this.searchRootAt(depth, moves, this.level.noise > 0);
  }
}

/**
 * 搜索入口。
 *
 * level 可以是挡位 id，也可以直接是一个挡位对象 ——
 * 测试需要构造「深度 1、无随机性」这类自定义挡位，走对象形式最省事。
 * options.rng 用来注入随机源，默认 Math.random；测试传固定种子以得到确定结果。
 */
export function search(fen, level, options = {}) {
  const lv = typeof level === 'string' ? LEVELS.find((l) => l.id === level) : level;
  if (!lv) throw new Error(`未知挡位：${level}`);

  const pos = parseFen(fen);
  const searcher = new Searcher(pos.cells, pos.side, lv, options.rng || Math.random);

  const started = Date.now();
  const result = searcher.searchRoot(lv.depth);
  if (!result) return null;

  return {
    move: result.move,
    from: moveFrom(result.move),
    to: moveTo(result.move),
    score: result.score,
    depth: lv.depth,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
  };
}
