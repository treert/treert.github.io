/**
 * SAN 记谱（`Nf3` / `exd5` / `O-O` / `e8=Q+`）。纯逻辑，不碰 DOM。
 *
 * 只做「生成」，不做解析 —— 复盘靠着法列表的索引跳转，不需要从记谱串反推着法
 * （自定义局面走 FEN，不做 PGN 导入）。
 *
 * **必须在走这一步之前调用**：消歧义要看走之前的棋盘上还有哪些同类棋子。
 */

import { P, N, B, R, Q, K, SAN_LETTER } from './config.js';
import { squareName, fileOf, rankOf } from './position.js';
import {
  moveFrom, moveTo, movePromo, moveFlag, FLAG_EP, FLAG_CASTLE,
  generateLegalMoves, makeMove, inCheck,
} from './rules.js';

/**
 * 棋子中文名。界面文案（棋盘本身不用文字、升变选择要用）都读这里 ——
 * 记谱和界面必须来自同一处，否则会出现「记谱写 N、界面写马」这种不一致。
 */
export const PIECE_NAMES = { [P]: '兵', [N]: '马', [B]: '象', [R]: '车', [Q]: '后', [K]: '王' };

const FILE_TEXT = 'abcdefgh';

/**
 * 生成一步棋的 SAN。`pos` 必须是**走子之前**的局面。
 *
 * 顺序（design.md §6.1）：易位 → 棋子字母 → 吃子 `x` → 消歧义 → 升变 → 将军 / 将死后缀。
 *
 * 消歧义是**三段式，顺序不能变**：
 *   1. 同类棋子有多个能到这个目标格 → 加起始纵线（`Nbd2`）；
 *   2. 起始纵线也一样（同 file 有两只）→ 改加起始横行（`R1e2`）；
 *   3. 还分不清（三只同 file 不同 rank）→ 纵线 + 横行都写（`Qh4e1`）。
 *
 * **判据是「其它同类棋子能否合法走到同一个目标格」，不是「有没有同类棋子」** ——
 * 被牵制的子不算（它走不过来，写出来反而是多余的）。这一点错了实战里很难发现，
 * 测试里专门钉了一条反例。
 */
export function toSan(pos, move) {
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = pos.cells[from];
  if (!piece) throw new Error('记谱失败：起点没有棋子');

  const abs = piece > 0 ? piece : -piece;
  const suffix = moveSuffix(pos, move);

  if (moveFlag(move) === FLAG_CASTLE) {
    return `${fileOf(to) === 6 ? 'O-O' : 'O-O-O'}${suffix}`;
  }

  const capture = pos.cells[to] !== 0 || moveFlag(move) === FLAG_EP;

  if (abs === P) {
    // 兵：吃子写起始纵线（`exd5`），不吃子只写目标格（`e4`）；
    // 吃过路兵与普通吃子**写法完全一样**（`exd6`），这是 SAN 的规定
    const head = capture ? `${FILE_TEXT[fileOf(from)]}x` : '';
    const promo = movePromo(move);
    return `${head}${squareName(to)}${promo ? `=${SAN_LETTER[promo]}` : ''}${suffix}`;
  }

  const dis = disambiguation(pos, from, to, abs);
  return `${SAN_LETTER[abs]}${dis}${capture ? 'x' : ''}${squareName(to)}${suffix}`;
}

/**
 * 消歧义那段。返回 `''` / `'b'` / `'1'` / `'h4'` 这样的片段。
 *
 * 用**合法**着法而不是伪合法着法来判断「其它同类棋子能不能到这个格」，
 * 于是被牵制的子自然被排除掉，不用单独判断谁被牵制。
 */
function disambiguation(pos, from, to, abs) {
  const others = [];
  for (const m of generateLegalMoves(pos)) {
    const mFrom = moveFrom(m);
    if (mFrom === from || moveTo(m) !== to) continue;
    const v = pos.cells[mFrom];
    if ((v > 0 ? v : -v) === abs) others.push(mFrom);
  }
  if (others.length === 0) return '';

  const file = fileOf(from);
  const rank = rankOf(from);
  const sameFile = others.some((idx) => fileOf(idx) === file);
  const sameRank = others.some((idx) => rankOf(idx) === rank);

  if (!sameFile) return FILE_TEXT[file];
  if (!sameRank) return String(rank + 1);
  return `${FILE_TEXT[file]}${rank + 1}`;
}

/**
 * 后缀：走完发现对方被将军 → `+`，被将死 → `#`。
 *
 * 这里用 makeMove 试走一步（会生成对方全部合法着法）。记谱在界面里**每走一步只调一次**，
 * 不是搜索里的热路径，所以选「正确、好读」而不是「快」。
 */
function moveSuffix(pos, move) {
  const next = makeMove(pos, move).pos;
  if (!inCheck(next.cells, next.side)) return '';
  return generateLegalMoves(next).length === 0 ? '#' : '+';
}
