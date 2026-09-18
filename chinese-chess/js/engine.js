/**
 * AI 引擎：评估 + 搜索。纯逻辑，不碰 DOM、不碰 Worker。
 *
 * 对外只有一个入口 search()，内部结构（置换表、着法排序、静态搜索）都可以换，
 * 不影响调用方。这是「方便后续优化」的落点。
 */

import {
  CELLS, EMPTY, K, P, RED,
  PIECE_VALUE, PIECE_SQUARE, PASSED_PAWN_BONUS, MIRROR_INDEX, LEVELS,
} from './config.js';
import { yOf, parseFen, zobristKey, hashPiece, hashSide } from './position.js';
import {
  generateMoves, generateLegalMoves, isAttacked, inCheck, findKing,
  perpetualChecker, moveFrom, moveTo,
} from './rules.js';

const INF = 1e9;
/** 将死分值。带上「离根多远」，让引擎偏好更快的杀棋、更晚的被杀 */
const MATE = 100000;

/**
 * 「长将」的分值。
 *
 * 长将在棋规里是**判负**（见 rules.js 的 perpetualChecker），所以这个分值必须
 * 高于任何子力优势（满盘子力也就五千出头）—— 这样 AI 才会去把对手逼成长将，
 * 也才会在自己要走进长将时改走别的。
 *
 * 但它必须**明显低于 MATE**：iterativeDeepen 用「|score| > MATE - 1000」判断
 * 「已经找到杀棋、不必再加深」，长将不是杀棋，混进那个量级会让搜索提前收手。
 */
const REPETITION_WIN = 20000;

// 置换表条目类型：精确值 / 只证明了下界 / 只证明了上界
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

/** 静态搜索的层数上限。兑子序列可能很长，必须封顶，否则单节点开销失控 */
const MAX_QUIESCE_DEPTH = 6;

/** 连将杀探测最多能用掉的时间预算：总预算的这么一份，且不超过绝对上限（毫秒） */
const MATE_PROBE_SHARE = 0.7;
const MATE_PROBE_MAX_MS = 1400;

/**
 * 超时中断用的哨兵。
 *
 * 用抛异常而不是逐层检查标志位：标志位要求每一层递归都判断一次，
 * 而那个判断在叶节点上的开销会被放大成千上万倍。
 */
const TIMEOUT = { timeout: true };

/**
 * 静态评估：子力 + 位置表 + 兵过河。
 *
 * 返回**轮走方视角**的分值 —— 负极大值搜索要求「分数总是对当前走子方有利为正」。
 *
 * 位置项（`config.js` 的 PIECE_SQUARE）是必需的，不是锦上添花：没有它的时候开局的
 * 所有着法分值一模一样，AI 选哪个纯凭搜索先试到谁，于是会走「弃炮换马」这类
 * 只有浅层才看着划算的着法。
 *
 * 刻意**不加任何需要生成着法的项**（机动性、威胁数…）：评估在叶节点被调用上百万次，
 * 生成着法等于把搜索成本翻倍。位置表是 O(1) 查表，这才是对的方向。
 */
export function evaluate(cells, side) {
  let score = 0; // 先按红方视角累加
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i];
    if (v === EMPTY) continue;

    const abs = Math.abs(v);
    const red = v > 0;
    // 黑方按 y 镜像查同一张表（左右对称，不必再镜像横轴）
    let value = PIECE_VALUE[abs] + PIECE_SQUARE[abs * CELLS + (red ? i : MIRROR_INDEX[i])];
    if (abs === P) {
      const y = yOf(i);
      const crossed = red ? y <= 4 : y >= 5;
      if (crossed) value += PASSED_PAWN_BONUS;
    }
    score += red ? value : -value;
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
  constructor(cells, side, level, rng = Math.random, history = []) {
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

    // 将 / 帅的位置，增量维护：kings[0] 是红帅、kings[1] 是黑将，-1 表示已不在盘上。
    // 搜索里「这一步走完之后己方将还安全吗」每试一个着法都要问一次，
    // 而 findKing 是 90 格全扫 —— 这是整个引擎最热的一处，值得单独维护。
    // 顺带也让「当前走子方是否被将军」（将军延伸要用）变成 O(1) 起点 + 一次 isAttacked。
    this.kings = [findKing(cells, RED), findKing(cells, -RED)];

    // 将军延伸的预算：一条线最多多搜几层。0 = 不延伸（弱挡位用）
    this.checkExtension = level.checkExtension || 0;

    // 搜索路径，只为循环规则（长将）服务，见 repetitionScore()：
    //   pathKeys[i]  第 i 个局面的哈希
    //   pathFlags[i] 「走到那个局面的那一步是否将军」
    // 前半段是**对局历史**（主线程喂进来的），后半段是搜索树上的节点，
    // 由 negamax 自己压 / 弹。
    //
    // 历史必须喂进来：只看搜索树的话，「AI 上一步将军、这一步再将军」这种循环
    // 有一半在树外 —— 引擎会以为它随时能收手（树里确实能），于是一路将军下去，
    // 到第 3 次重复时按长将判负。把历史接在路径前面，这种循环一进入就被认出来。
    this.pathKeys = [];
    this.pathFlags = [];
    for (const fen of history) {
      const p = parseFen(fen);
      this.pathKeys.push(zobristKey(p.cells, p.side));
      this.pathFlags.push(inCheck(p.cells, p.side) ? 1 : 0);
    }

    // 历史只建一次索引：搜索里每个节点都要问一次「这个局面走过吗」，
    // 扫数组的话历史一长（一局棋上百步）就是每个节点上百次比较。
    this.historyIndex = new Map();
    for (let i = 0; i < this.pathKeys.length; i++) this.historyIndex.set(this.pathKeys[i], i);
    this.seeded = this.pathKeys.length;

    // 路径里必须有当前局面本身（历史为空时只有它，历史非空时它本来就是最后一项）。
    // 不一致时补一个兜底项：宁可多算一个局面，也不能漏掉「走回当前局面」这种循环。
    if (this.pathKeys.length === 0 || this.pathKeys[this.pathKeys.length - 1] !== this.key) {
      this.pathKeys.push(this.key);
      this.pathFlags.push(0);
    }

    // repetitionRule = false 用来做对照实验：验证循环规则只改变循环局面下的结论。
    // 与 useTT 同一套路（测试用的开关，挡位表里不写它 → 默认开着）。
    this.repetitionRule = level.repetitionRule !== false;

    // 时间控制：Date.now() 本身不便宜，所以每 1024 个节点才查一次
    this.deadline = Infinity;
    this.checkEvery = 1024;
  }

  /**
   * kings 数组的下标：红 0、黑 1。
   *
   * 传阵营（1 / -1）或棋子编码都行 —— 两者都是用符号判色的，
   * 所以 make() 里可以直接把「走的棋子」「被吃的棋子」丢进来。
   */
  static slot(side) { return side === RED ? 0 : 1; }

  /** 某一方的将 / 帅在哪一格；-1 表示已经不在盘上（只可能出现在「吃将」的着法被走出来的那一步） */
  kingOf(side) { return this.kings[Searcher.slot(side)]; }

  /** 某一方是否正被将军。将已经不在盘上也算（上层会把「一步都走不了」判成被杀） */
  inCheck(side) {
    const king = this.kingOf(side);
    return king < 0 || isAttacked(this.cells, king, -side);
  }

  /**
   * 走一步。返回被吃的子（可能是 EMPTY），回退时要原样传回 unmake()。
   *
   * 哈希的三个异或项是无条件写的 —— 因为 hashPiece(EMPTY, idx) 恒为 0，
   * 所以「没吃子」这一支不需要特殊处理，make / unmake 两边也就天然对称。
   *
   * 将 / 帅的位置同理无条件写：走的是将就更新它，吃的子是将就把那一方的记为 -1。
   * 后者严格说走不出来（对方被将军时轮不到我们走），但搜索里的伪合法着法
   * 是有可能吃将的，写全了才不会留下一个指向已空格子的索引。
   */
  make(move) {
    const from = moveFrom(move), to = moveTo(move);
    const piece = this.cells[from];
    const captured = this.cells[to];
    this.key = (this.key ^ hashPiece(piece, from) ^ hashPiece(piece, to) ^ hashPiece(captured, to)) >>> 0;
    this.cells[to] = piece;
    this.cells[from] = EMPTY;
    if (Math.abs(piece) === K) this.kings[Searcher.slot(piece)] = to;
    if (captured !== EMPTY && Math.abs(captured) === K) this.kings[Searcher.slot(captured)] = -1;
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
    if (Math.abs(piece) === K) this.kings[Searcher.slot(piece)] = from;
    if (captured !== EMPTY && Math.abs(captured) === K) this.kings[Searcher.slot(captured)] = to;
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
   *
   * 将的位置直接从 kings 里读，不再 findKing 全盘扫 —— 这里每试一个着法就要问一次，
   * 是搜索里调用最密的一处。
   */
  leavesKingSafe() {
    const king = this.kingOf(-this.side);
    return king >= 0 && !isAttacked(this.cells, king, this.side);
  }

  /**
   * 当前局面在搜索路径上重复过吗？重复的话按循环规则给一个分值。
   *
   * 只判**长将**：循环里只有一方每步都在将军 → 那一方判负（棋规），
   * 双方都在将军、或都没将军 → 判和。长捉 / 长兑不做（见 rules.js 的说明）。
   *
   * **「第二次出现」就当作循环成立** —— 与棋规的「三次重复」差一次，但搜索里
   * 不必真把三次走完：能原样回来一次，就能一直回来。这样 AI 既不会自己走进长将判负，
   * 也能主动把对手逼进去（残局里这是很实际的取胜手段）。
   *
   * 返回 null 表示没有重复；否则返回**当前走子方**视角的分值。
   */
  repetitionScore() {
    const p = this.pathKeys.length - 1;
    const key = this.pathKeys[p];

    // 先在搜索树那一段里从近往远找（最近的重复才是刚形成的那个循环），
    // 找不到再查对局历史的下标索引 —— 那一段不参与搜索，只建过一次 Map，不用扫。
    let q = -1;
    for (let i = p - 1; i >= this.seeded; i--) {
      if (this.pathKeys[i] === key) { q = i; break; }
    }
    if (q < 0) {
      const i = this.historyIndex.get(key);
      if (i !== undefined) q = i;
    }
    if (q < 0) return null;

    // 局面哈希含轮走方（hashSide），所以 q 与 p 的轮走方相同、p - q 必为偶数，
    // 循环里的第一步就是**当前走子方**走的 —— 奇偶直接定出每一步的走子方。
    const sides = [];
    const checks = [];
    for (let i = q + 1; i <= p; i++) {
      sides.push((i - q) % 2 === 1 ? this.side : -this.side);
      checks.push(this.pathFlags[i] === 1);
    }

    const checker = perpetualChecker(sides, checks);
    if (checker === this.side) return -REPETITION_WIN;  // 我们在长将 → 棋规判我们负
    if (checker === -this.side) return REPETITION_WIN;  // 对手在长将 → 他们判负，我们胜
    return 0;                                           // 和棋
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

    const checked = this.inCheck(this.side);
    if (!checked) {
      const stand = evaluate(this.cells, this.side);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }

    // 层数用尽时给一个静态分兜底。
    // **绝不能返回 alpha** —— 它可能是 -INF，取负之后会变成 +INF，
    // 而 iterativeDeepen 判断「找到杀棋」的条件是 |score| > MATE - 1000，
    // 于是会把 -INF 当成杀棋、提前停止加深（表现为挡位突然只搜 1 层）。
    // 这个 bug 是自对弈冒烟测试发现的。
    if (qdepth <= 0) return evaluate(this.cells, this.side);

    let best = alpha;
    let legalCount = 0;
    const moves = generateMoves(this.cells, this.side)
      .filter((m) => checked || this.cells[moveTo(m)] !== EMPTY);

    for (const move of this.orderMoves(moves, ply, 0)) {
      const captured = this.make(move);
      if (!this.leavesKingSafe()) {
        this.unmake(move, captured);
        continue;
      }
      legalCount++;
      const score = -this.quiesce(-beta, -best, ply + 1, qdepth - 1);
      this.unmake(move, captured);

      if (score > best) best = score;
      if (best >= beta) return best;
    }

    // 被将军且一步都走不了 = 将死。
    // 不处理的话 best 会停在 alpha（可能是 -INF），同样会被上层误判成杀棋。
    if (checked && legalCount === 0) return -MATE + ply;
    return best;
  }

  /**
   * 负极大值形式的 alpha-beta，带置换表、着法排序与将军延伸。
   *
   * ext 是「这条线还能延伸几层」的预算（挡位参数 checkExtension）。被将军的节点
   * 不消耗深度 —— 因为被将军时合法着法往往只有一两个，多搜一层很便宜，
   * 而**连杀的正解恰恰整条都在将军里**：不延伸就只能在固定深度上横向看，
   * 十几步的连杀永远看不见。这是「排局提示多半是错的」那个问题的根因。
   *
   * 这一层只做三件事：数节点 / 查超时、把当前局面压进搜索路径（循环规则要用）、
   * 再把路径弹回去。**用 try/finally 而不是在每条返回路径上各弹一次** ——
   * 本体有好几条 return，超时还是从中间穿出去的异常；路径不还原的话，
   * search() 里紧接着施加挡位弱化时就会读到一个错乱的路径。
   */
  negamax(depth, alpha, beta, ply, ext = 0) {
    this.nodes++;

    if (--this.checkEvery <= 0) {
      this.checkEvery = 1024;
      if (Date.now() >= this.deadline) throw TIMEOUT;
    }

    // 本层是否被将军。将军延伸要用它；它同时就是「**上一步**是否将军」——
    // 循环规则（长将）要按步记这个标记，所以只算一次，两处共用。
    const checked = this.inCheck(this.side);
    this.pathKeys.push(this.key);
    this.pathFlags.push(checked ? 1 : 0);

    try {
      return this.negamaxNode(depth, alpha, beta, ply, ext, checked);
    } finally {
      this.pathKeys.pop();
      this.pathFlags.pop();
    }
  }

  /** negamax 的本体。拆出来只是为了让上面那个 try/finally 能包住全部返回路径 */
  negamaxNode(depth, alpha, beta, ply, ext, checked) {
    // 走成循环了就按循环规则结算，不再往下搜。这个分值取决于**路径**上有没有
    // 那个循环，不是局面本身的性质（同一个局面在别处可能完全正常），所以既不查、
    // 也不写置换表 —— 在这里直接返回，正好绕开本体末尾那次写入。
    if (this.repetitionRule) {
      const rep = this.repetitionScore();
      if (rep !== null) return rep;
    }

    if (ext > 0 && checked) {
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

      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, ext);
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

    // 杀棋分值带「离根多远」的信息，换一层深度就不对了；长将分值取决于搜索路径上
    // 有没有那个循环，同一个局面换个路径就不是这个分。两种都不能进置换表。
    // （MATE 约 1e5、长将 2e4，都高于任何子力分，一道阈值就够了。）
    if (this.useTT && Math.abs(best) < REPETITION_WIN) {
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

    // 根节点也被将军时延伸一次，跟 negamax 内部的规则保持一致。
    // 边界的将军延伸虽然少见，但不处理的话「被将军的挡位」会莫名其妙少看一层。
    let childDepth = depth - 1;
    let ext = this.checkExtension;
    if (ext > 0 && this.inCheck(this.side)) {
      childDepth = depth;
      ext--;
    }

    for (const move of ordered) {
      const captured = this.make(move);
      const score = exact
        ? -this.negamax(childDepth, -INF, INF, 1, ext)
        : -this.negamax(childDepth, -INF, -bestScore, 1, ext);
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

  /**
   * 根节点的着法排序：**将军着法先试**。
   *
   * 连杀的正解首着本身就是一步将军（排局尤其如此），而且它一旦被搜到，
   * alpha 立刻变成杀棋分值，后面几十个着法会在很浅的地方就全部剪掉 ——
   * 省下的时间正好用来把杀棋那条线搜到底。
   *
   * 只在根节点做：这里只有几十个着法，试走一次的开销可以忽略；
   * 搜索内部每个节点都这么算会把成本翻倍。
   */
  orderRootMoves(moves) {
    const checking = [];
    const quiet = [];
    for (const move of moves) {
      (this.givesCheck(move) ? checking : quiet).push(move);
    }
    return [...checking, ...quiet];
  }

  /** 这一步走完之后，对方是否被将军（试走 + 回退，棋盘不留痕） */
  givesCheck(move) {
    const captured = this.make(move);
    const check = this.inCheck(this.side);
    this.unmake(move, captured);
    return check;
  }

  /**
   * 跑一段可能抛 TIMEOUT 的搜索，无论结果如何都把棋盘恢复成原样。
   *
   * 超时是从 make() / unmake() 中间穿出去的异常，棋盘会停在一个「走了一半」的
   * 状态上。调用方之后还要用 searcher.cells 生成根着法（见 search() 的挡位弱化），
   * 从错乱的棋盘上挑着法会挑出非法着法 —— 上层 playMove 拒掉它，表现成「AI 不动了」。
   * 把回滚收到这一个地方，比在每条超时路径上各写一遍可靠。
   */
  guarded(fn) {
    const snapshot = this.cells.slice();
    const savedSide = this.side;
    const savedKey = this.key;
    const savedKings = this.kings.slice();
    const savedPath = this.pathKeys.length;
    try {
      return fn();
    } finally {
      this.cells.set(snapshot);
      this.side = savedSide;
      this.key = savedKey;
      this.kings = savedKings;
      // 搜索路径同理。negamax 的 try/finally 已经保证了平衡，这里是兜底 ——
      // 万一以后有人加了一条能穿出去的异常路径，也不至于把路径留在错乱状态。
      this.pathKeys.length = savedPath;
      this.pathFlags.length = savedPath;
    }
  }

  /**
   * 连将杀探测：**攻击方只走将军着法**，防守方走全部合法着法。
   *
   * 这是排局求解的标准做法，也是「看得见《适情雅趣》那种十几步连杀」的关键。
   * 同样一条 13 层连杀，常规搜索要 1100 万节点（还搜不到底），
   * 把攻击方限制在将军着法上只要 15 万节点 —— 因为常规搜索在攻击方的每个节点上
   * 都要摊开约 40 个着法，而连杀的正解整条都是将军。
   *
   * 它是**只证明「有杀」、不证明「没有杀」**的：攻击方的着法被限制过，
   * 找不到不等于没有（正解里可能有一步闲着）。这个方向恰好安全 ——
   * 找到的杀一定是真杀，可以直接走；找不到就退回常规搜索，什么也没损失。
   *
   * 返回 { move, ply }；ply 是杀棋的总层数（奇数 = 攻击方走最后一步），没有则返回 null。
   * ply 从 1 开始逐级加深：浅层很便宜（9 层约 1 万节点），
   * 所以「这个局面没有杀」时它也不会把时间预算吃光。
   */
  probeMate(maxPly) {
    const attacker = this.side;
    const moves = this.orderRootMoves(generateLegalMoves({ cells: this.cells, side: attacker }))
      .filter((move) => this.givesCheck(move));

    for (let ply = 1; ply <= maxPly; ply += 2) {
      for (const move of moves) {
        const captured = this.make(move);
        const ok = this.canMateIn(ply - 1, attacker);
        this.unmake(move, captured);
        if (ok) return { move, ply };
      }
    }
    return null;
  }

  /**
   * 「轮 this.side 走时，攻击方能不能在 ply 层内把对方将死」。
   *
   * 攻击方节点只要**存在**一步将军能杀（∃）；防守方节点要**所有**合法着法都挡不住（∀）。
   * 这正是「强制」的含义，也是它比常规搜索便宜两个数量级的原因：
   * ∀ 只要发现一条撑得住的应手就可以立刻返回 false。
   */
  canMateIn(ply, attacker) {
    this.nodes++;
    if (--this.checkEvery <= 0) {
      this.checkEvery = 1024;
      if (Date.now() >= this.deadline) throw TIMEOUT;
    }

    const moves = generateLegalMoves({ cells: this.cells, side: this.side });
    if (moves.length === 0) return this.side !== attacker; // 走子方无着法 = 被将死 / 困毙
    if (ply <= 0) return false;

    if (this.side === attacker) {
      for (const move of moves) {
        if (!this.givesCheck(move)) continue;
        const captured = this.make(move);
        const ok = this.canMateIn(ply - 1, attacker);
        this.unmake(move, captured);
        if (ok) return true;
      }
      return false;
    }

    for (const move of moves) {
      const captured = this.make(move);
      const ok = this.canMateIn(ply - 1, attacker);
      this.unmake(move, captured);
      if (!ok) return false; // 找到一条撑得住的应手 → 这不是强制杀
    }
    return true;
  }

  /**
   * 迭代加深：从 1 层逐层加深，每层用上一层的最优着法排在最前面。
   *
   * 好处有两个：时间控制天然生效（超时就丢掉没跑完的那一层），
   * 以及浅层结果能给深层做很好的着法排序 —— 这是最省事的着法排序来源。
   *
   * 超时后**必须保留上一层已经完成的结果**，所以 catch 里是 break 而不是往外抛。
   * 直接抛出去会让调用方拿到 null，白白浪费已经算出来的着法。
   */
  iterativeDeepen() {
    const moves = generateLegalMoves({ cells: this.cells, side: this.side });
    if (moves.length === 0) return null;
    if (moves.length === 1) {
      return { move: moves[0], score: 0, scores: new Map([[moves[0], 0]]), depth: 1 };
    }

    let best = null;
    let ordered = this.orderRootMoves(moves);

    for (let depth = 1; depth <= this.level.depth; depth++) {
      let result;
      try {
        // 包一层 guarded：超时是从 make() / unmake() 中间穿出来的异常，
        // 会把棋盘停在「走了一半」的状态上。回滚了才不会让后面的根着法生成
        // （search() 里施加挡位弱化时要用）读到一个错乱的棋盘。
        result = this.guarded(() => this.searchRootAt(depth, ordered, this.level.noise > 0));
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break; // 这一层没跑完，丢掉它，保留上一层的结果
      }
      best = { ...result, depth };
      // 下一层从这一层的最优着法开始搜（剪枝效率更高），其余着法里将军的排前面。
      // 这里必须**重新**排一次：浅层选出来的最优着法往往不是那步将军。
      const rest = [...result.scores.keys()].filter((m) => m !== result.move);
      ordered = [result.move, ...this.orderRootMoves(rest)];
      if (Math.abs(result.score) > MATE - 1000) break; // 已经找到杀棋，不必再深
    }
    return best;
  }
}

/**
 * 搜索入口。
 *
 * level 可以是挡位 id，也可以直接是一个挡位对象 ——
 * 测试需要构造「深度 1、无随机性」这类自定义挡位，走对象形式最省事。
 * options.rng 用来注入随机源，默认 Math.random；测试传固定种子以得到确定结果。
 * options.history 是**对局历史**（从起始局面到当前局面的 FEN 数组，最后一项就是
 * `fen`）—— 循环规则（长将）要用，见 Searcher 的 repetitionScore()。不传也行，
 * 只是引擎就看不见搜索树之外的循环了。
 */
export function search(fen, level, options = {}) {
  const lv = typeof level === 'string' ? LEVELS.find((l) => l.id === level) : level;
  if (!lv) throw new Error(`未知挡位：${level}`);

  const pos = parseFen(fen);
  const searcher = new Searcher(pos.cells, pos.side, lv, options.rng || Math.random,
    options.history || []);

  const started = Date.now();
  const limit = lv.timeLimitMs;

  // === 先做一次连将杀探测 ===
  // 有连杀就没必要再常规搜索了（连杀的分值是最高的，常规搜索只会用更慢的方式
  // 找到同一步或者根本找不到）。没连杀的话这一步很便宜：逐级加深到 11 层
  // 也才几万节点，代价是几毫秒到几十毫秒。
  const mate = lv.mateProbePly > 0
    ? searcher.guarded(() => {
      // 只给它一部分预算：探测没跑完时常规搜索还得有时间
      searcher.deadline = started + Math.min(limit * MATE_PROBE_SHARE, MATE_PROBE_MAX_MS);
      try {
        return searcher.probeMate(lv.mateProbePly);
      } catch (e) {
        if (e === TIMEOUT) return null; // 没跑完就当作没找到，退回常规搜索
        throw e;
      }
    })
    : null;

  // === 常规搜索：用剩下的时间 ===
  let result;
  if (mate) {
    result = {
      move: mate.move,
      score: MATE - mate.ply,
      scores: new Map([[mate.move, MATE - mate.ply]]),
      depth: mate.ply, // 杀棋的层数，不是常规搜索的层数
    };
  } else {
    searcher.deadline = started + limit;
    result = searcher.iterativeDeepen();
  }
  let blundered = false;

  if (result) {
    // === 挡位弱化：只在根节点施加，不碰搜索内部 ===
    //
    // 探测到连杀时不施加：「失误」是模仿新手看漏，而一个**已经被证明的杀棋**
    // 不存在看漏 —— 把它换成随手一步，坏掉的不是棋力，是可信度：
    // 残局库的「提示」会给出错的答案（这正是要修的问题）。
    const allMoves = generateLegalMoves({ cells: searcher.cells, side: searcher.side });

    // 失误：放弃搜索结果，从「除最优着法之外」的合法着法里随机挑一个。
    // 只剩一个合法着法时绝不能触发 —— 那会走出非法着法，上层直接崩。
    if (!mate && lv.blunderRate > 0 && allMoves.length > 1 && searcher.rng() < lv.blunderRate) {
      const others = allMoves.filter((m) => m !== result.move);
      result = { ...result, move: others[Math.floor(searcher.rng() * others.length)] };
      blundered = true;
    } else if (!mate && lv.noise > 0 && result.scores.size > 1) {
      // 噪声：给每个根着法的评分加一个均匀扰动，重新选最优。
      // 这让弱挡位倾向选次优着，而不是永远走同一个最优着。
      // 需要精确分值才能比较，所以 searchRootAt 在 noise > 0 时开的是全窗口。
      let bestMove = result.move;
      let bestVal = -INF;
      for (const [move, score] of result.scores) {
        const noisy = score + (searcher.rng() * 2 - 1) * lv.noise;
        if (noisy > bestVal) { bestVal = noisy; bestMove = move; }
      }
      result = { ...result, move: bestMove };
    }

    return {
      move: result.move,
      from: moveFrom(result.move),
      to: moveTo(result.move),
      score: result.score,
      depth: result.depth,
      nodes: searcher.nodes,
      timeMs: Date.now() - started,
      blundered,
    };
  }

  // 走到这里只有两种可能：局面本身已经终局，或者时间限制短到连第 1 层都没跑完。
  // 后者必须兜底返回一个合法着法 —— 绝不能让上层拿到 null 然后卡死不动。
  const legal = generateLegalMoves({ cells: searcher.cells, side: searcher.side });
  if (legal.length === 0) return null;
  return {
    move: legal[0],
    from: moveFrom(legal[0]),
    to: moveTo(legal[0]),
    score: 0,
    depth: 0,
    nodes: searcher.nodes,
    timeMs: Date.now() - started,
    blundered: false,
  };
}
