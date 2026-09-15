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

  /** 负极大值形式的 alpha-beta */
  negamax(depth, alpha, beta, ply) {
    this.nodes++;

    if (depth <= 0) return evaluate(this.cells, this.side);

    let best = -INF;
    let legalCount = 0;

    for (const move of generateMoves(this.cells, this.side)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      legalCount++;

      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.unmake(move, captured);

      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }

    // 一步都走不了 = 被将死或困毙，两种情况在中国象棋里都是走子方负
    if (legalCount === 0) return -MATE + ply;
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
