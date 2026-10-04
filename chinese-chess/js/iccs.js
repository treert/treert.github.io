/**
 * ICCS 坐标 ⇄ 本模块着法编码。纯逻辑，只有两个函数。
 *
 * ## 为什么要单独一个文件
 *
 * 解法（`solutions.js` / `prefixes.js`）和开局库（`openings.js`）都存着
 * **ICCS 坐标**写的着法序列 —— 那是象棋圈通用的记法，可以拿去和别处核对，
 * 也可以直接喂给引擎。两边都要把 ICCS 换算成内部编码，**换算只该有一份**：
 * 这正是最容易「看起来对、其实整条线歪了」的一类代码（见 `future-work.md` E10）。
 *
 * 不能把 `solution-book.js` 里的那份拿来用 —— 它 import 了 `solutions.js`，
 * 那是几百 KB 的生成物，而引擎（Worker）也要用这个换算，不能被拖进来。
 *
 * ## 坐标
 *
 * ICCS：列 `a`-`i` 从左到右（x = 0..8）；行 `0`-`9` **从红方底线往上**。
 * 本模块：`y = 0` 是黑方底线、`y = 9` 是红方底线，正好上下互为镜像，所以 `y = 9 - rank`。
 *
 * **格子索引是 `y * COLS + x`（一格 9），不是 `y * CELLS + x`** ——
 * `CELLS = 90` 是格子**总数**，只在着法编码 `from * CELLS + to` 里用。
 * 这两个常量写混了不会报错，只会把着法整体算歪（`y * 90 + x` 会跑出棋盘外），
 * 所以 `test-solution-book.mjs` 与 `test-openings.mjs` 里各有一条定点
 * （`b5b9 → (1,4)→(1,0)`）钉住它。
 */
import { COLS } from './config.js';
import { encodeMove } from './rules.js';

/**
 * ICCS 坐标 → 内部着法编码（`from * 90 + to`）。
 *
 * `b5b9` → `(1,4) → (1,0)`。
 */
export function moveOfIccs(tok) {
  const from = (9 - Number(tok[1])) * COLS + (tok.charCodeAt(0) - 97);
  const to = (9 - Number(tok[3])) * COLS + (tok.charCodeAt(2) - 97);
  return encodeMove(from, to);
}

/**
 * 内部着法编码 → ICCS 坐标。`moveOfIccs` 的逆运算。
 *
 * 目前只有测试与离线工具会用到它（把内部编码还原成能和外部对照的记法），
 * 但放在这里一对一摆着，比散在别处更能保证两者不会各自漂移。
 */
export function iccsOfMove(move) {
  const from = Math.floor(move / 90);
  const to = move % 90;
  const col = (idx) => String.fromCharCode(97 + (idx % COLS));
  const rank = (idx) => String(9 - Math.floor(idx / COLS));
  return `${col(from)}${rank(from)}${col(to)}${rank(to)}`;
}
