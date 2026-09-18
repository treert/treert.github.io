/**
 * 残局解法 —— **这个文件是生成的，别手改**。
 *
 * 生成：`node chess/tools/gen-solutions.mjs local`（内置精确杀棋搜索，不需要引擎）
 *       或 `node chess/tools/gen-solutions.mjs stockfish`（原生 Stockfish，可挂表库）
 * 复核：`node chess/tools/verify-endgames.mjs`（每一步合法 + 末局确实是将死）
 *
 * ## 里面是什么
 *
 * 每条是本局**从初始局面开始**的一条主线着法序列（`pv`），用 UCI 坐标
 * （`e2e4` / `e7e8q`），与 Stockfish、与任何棋谱软件同格式，拿出去核对方便。
 * `mate` 是**先手方步数**，由实际走出来的长度推得（`pv` 长度恒为 `2 * mate - 1`）。
 *
 * 只收「已经证明是强制杀」的局：
 *   - local 那条路是**精确**的 ∃/∀ 搜索（找不到不等于没有，但找到的一定对）；
 *   - Stockfish 那条路要求引擎给出完整走到杀的 PV，并且**每一步都用本模块的
 *     规则层走通过**（UCI 的升变与易位最容易解析错）。
 *
 * 没找到的局不编 —— 界面上显示「暂无谱载解法」，点「提示」时回退本地引擎现算。
 */

/** 生成这批数据用的是什么 */
export const SOLUTIONS_SOURCE = '内置精确杀棋搜索（上限 5 个半层）';

/** id → 解法。**只有证明过强制杀的局才在这里**（7 条） */
export const SOLUTIONS = {
  'krr-vs-k': { pv: 'a1a7 e8f8 h1h8', mate: 2 },
  'rook-and-pawn': { pv: 'e6e7 h8h7 e7e8q h7h6 e8h8', mate: 3 },
  'tac-back-rank-rook': { pv: 'a1a8', mate: 1 },
  'tac-back-rank-queen': { pv: 'e1e8', mate: 1 },
  'tac-queen-smother': { pv: 'e7g7', mate: 1 },
  'tac-knight-smother': { pv: 'e5f7', mate: 1 },
  'tac-parallel-rooks': { pv: 'b1b8', mate: 1 },
};

/** 取某一局的解法；没有则返回 null */
export function solutionOf(id) {
  return Object.prototype.hasOwnProperty.call(SOLUTIONS, id) ? SOLUTIONS[id] : null;
}
