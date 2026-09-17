/**
 * 中文记谱（炮二平五 / 车九进一）。纯逻辑。
 *
 * 只做「生成」，不做解析 —— 复盘靠着法列表的索引跳转，不需要从记谱串反推着法。
 *
 * 规则（design.md §6）：
 *   棋子名 + 起始纵线 + 动作 + 目标
 *   纵线号**按方各自编号**（两方镜像）：红方 9 - x 用汉字，黑方 x + 1 用阿拉伯数字
 *   车 / 炮 / 兵 / 将 的进退还记步数，马 / 象 / 士 记目标纵线
 *   同一纵线上有重子时，用「前 / 后」（三个用「前 / 中 / 后」，更多用数字）替代起始纵线
 */

import { CELLS, K, A, B, N, R, C, P, RED } from './config.js';
import { indexOf, xOf, yOf } from './position.js';

// 棋子名，索引 = 棋子编码（1..7）。
// 导出给 renderer.js 用 —— 棋盘上的字和记谱里的字必须来自同一处，
// 否则改了一个忘了另一个，就会出现「棋盘写着相、记谱写着象」这种不一致。
export const RED_NAMES = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
export const BLACK_NAMES = ['', '将', '士', '象', '马', '车', '炮', '卒'];

const RED_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BLACK_DIGITS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * 纵线号。**红黑各自从自己的右手边数起**，两人面对面坐着，所以两方是镜像的：
 *   红方（在 y = 9 一侧，右手边是 x = 8）→ `9 - x`：x = 8 是「一」、x = 0 是「九」
 *   黑方（在 y = 0 一侧，右手边是 x = 0）→ `x + 1`：x = 0 是「1」、x = 8 是「9」
 * 同一纵线上红「一」与黑「9」同列（x = 8），红「九」与黑「1」同列（x = 0）。
 *
 * **早先两方共用 `9 - x`（当时注释写的是"两方数值相同"），那是错的。**
 * 它内部自洽，所以单测和界面都发现不了 —— 只有把着法拿出去跟棋谱对才暴露：
 * 初始局面黑炮在 x = 1 / x = 7，通行谱写「炮2平5 / 炮8平5」，共用公式会写成
 * 反过来的「炮8平5 / 炮2平5」。
 *
 * 是《适情雅趣》第 002 局的谱载解法把它对出来的：黑士 (4,1)→(3,0) 谱作「士5退4」、
 * 黑马 (0,2)→(1,0) 谱作「马1退2」——共用公式会写成「士5退6」「马9退8」。
 * 这两条谱例（外加两条红方的）已进 test-notation.mjs 当回归锚点：
 * **规则本身错了的时候，自洽的测试是发现不了的，得有外部基准钉住。**
 */
function fileNumberOf(side, x) { return side === RED ? 9 - x : x + 1; }

function digit(side, n) { return side === RED ? RED_DIGITS[n] : BLACK_DIGITS[n]; }

/**
 * 决定「谁在走」这一段。
 *   同纵线只有这一个同类子 → 用起始纵线，如「炮八」
 *   两个 → 「前 / 后」
 *   三个 → 「前 / 中 / 后」
 *   四个以上（只可能是兵）→ 「一 / 二 / 三 …」，从前往后数
 *
 * 「前」是更靠近对方的那一个：红方 y 更小，黑方 y 更大。
 */
function subjectOf(cells, from, side, abs, name) {
  const x = xOf(from);
  const sameFile = [];
  for (let y = 0; y < 10; y++) {
    const i = indexOf(x, y);
    if (cells[i] === side * abs) sameFile.push(i);
  }

  if (sameFile.length === 1) return `${name}${digit(side, fileNumberOf(side, x))}`;

  // 从前往后排序：红方 y 递增即从前往后，黑方相反
  const ordered = side === RED ? sameFile : sameFile.slice().reverse();
  const rank = ordered.indexOf(from);

  if (sameFile.length === 2) return `${rank === 0 ? '前' : '后'}${name}`;
  if (sameFile.length === 3) return `${['前', '中', '后'][rank]}${name}`;
  return `${digit(side, rank + 1)}${name}`;
}

/**
 * 生成一步棋的中文记谱。pos 必须是**走子之前**的局面 ——
 * 判断有没有重子、决定用纵线还是前后，都要看走之前的棋盘。
 */
export function toNotation(pos, move) {
  const { cells, side } = pos;
  const from = Math.floor(move / CELLS);
  const to = move % CELLS;

  const piece = cells[from];
  if (piece === 0) throw new Error('记谱失败：起点没有棋子');

  const abs = Math.abs(piece);
  const s = Math.sign(piece);
  const name = s === RED ? RED_NAMES[abs] : BLACK_NAMES[abs];
  const subject = subjectOf(cells, from, s, abs, name);

  const fy = yOf(from);
  const tx = xOf(to), ty = yOf(to);

  if (ty === fy) return `${subject}平${digit(s, fileNumberOf(s, tx))}`;

  // 红方 y 减小为「进」，黑方 y 增大为「进」—— 乘上阵营符号后统一判负
  const verb = (ty - fy) * s < 0 ? '进' : '退';

  // 车 / 炮 / 兵 / 将 记步数，马 / 象 / 士 记目标纵线
  const bySteps = abs === R || abs === C || abs === P || abs === K;
  const target = bySteps ? digit(s, Math.abs(ty - fy)) : digit(s, fileNumberOf(s, tx));
  return `${subject}${verb}${target}`;
}
