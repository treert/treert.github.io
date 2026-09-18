/**
 * 棋子图形：**从 `chess-icons/*.svg` 读进来的**，不是内联在 JS 里的字符串。
 *
 * ## 为什么放成文件
 *
 * 图形是外部素材（Cburnett 棋子集，来路与许可见 `chess-icons/README.md`）。
 * 放成 .svg 文件有三个好处：能直接用浏览器打开看、能跟原素材逐字 diff、
 * 想换一套只改下面的映射表。
 * 代价是**页面必须走 http** —— `file://` 下 fetch 会被 CORS 拦掉（已知限制里记着）。
 *
 * ## 运行时只做两件事
 *
 *   1. 取出 `<svg>` 里面的标记（XML 头和外壳不要 —— 我们要的是一段能塞进 DOM 的内容）；
 *   2. 把两个色值换成 CSS 变量：**主体色 → `--chess-p-fill`，另一个色 → `--chess-p-stroke`**。
 *      白棋的主体色是 `#ffffff`、黑棋是 `#000000`，所以两个色换到哪一边**按棋子颜色定**。
 *
 * 路径数据（`d` / `transform` / `fill-rule` / `stroke-width`）一律不动。
 * 于是文件保持原样、能跟素材 diff，而颜色仍然只由那两个变量说了算（深浅主题只换变量）。
 *
 * ## 加载时机
 *
 * `main.js` 在**页面装配之前** `await loadPieceArt()`（顶层 await，见该文件末尾）：
 * 这样第一次 draw 就有图形，不会先画一盘子空格子再「啪」地跳出来。
 * 失败不抛错 —— 12 个文件里坏一个不该让整块棋盘变空：
 * 读不到的返回空串，`renderer.js` 会画一个占位圆圈，`main.js` 会在状态行提示。
 */

/** 棋子编码（带符号，与 config.js 一致）→ 文件名。改这一张表就能换素材的命名。 */
const FILES = [
  [1, 'wp'], [2, 'wn'], [3, 'wb'], [4, 'wr'], [5, 'wq'], [6, 'wk'],
  [-1, 'bp'], [-2, 'bn'], [-3, 'bb'], [-4, 'br'], [-5, 'bq'], [-6, 'bk'],
];

/** 主体色：白棋主色是白、黑棋主色是黑。另一个色就是描边与细节（眼睛、鬃毛…）。 */
const BODY = { w: '#ffffff', b: '#000000' };
const INK = { w: '#000000', b: '#ffffff' };
const FILL_VAR = 'var(--chess-p-fill)';
const STROKE_VAR = 'var(--chess-p-stroke)';

/** 编码（字符串键）→ 内联标记。加载完成后才有值 */
const art = new Map();

/** 上一次加载的结果：`{ loaded, failed }`。main.js 用它决定要不要在状态行提示 */
let lastReport = { loaded: 0, failed: [] };

/** 素材来路（署名与说明读这里，别在别处再抄一份） */
export const PIECE_ART_SOURCE = {
  name: 'Cburnett',
  author: 'Colin M. L. Burnett',
  license: 'CC BY-SA 3.0',
  from: 'https://www.chessdb.cn/file/chess/',
};

/** 取出 `<svg>` 里的标记，并把换行 / 缩进压成单个空格（SVG 路径数据里空格就是分隔符，压掉多余的安全） */
export function extractMarkup(svgText) {
  const start = svgText.indexOf('>', svgText.indexOf('<svg'));
  const end = svgText.lastIndexOf('</svg>');
  if (start < 0 || end < 0) throw new Error('找不到 <svg> 外壳');
  return svgText.slice(start + 1, end).replace(/\s+/g, ' ').trim();
}

/**
 * 把素材里的两个色值换成 CSS 变量。
 *
 * 顺带兜一道：换完还剩别的颜色就说明**换了一套素材**，而那套的配色规则和这里假设的不同 ——
 * 不静悄悄地放过（那种图形在深色主题下多半会瞎），留个 warn 让人知道要改哪里。
 */
export function colorize(markup, code) {
  const side = code > 0 ? 'w' : 'b';
  let out = markup.split(BODY[side]).join(FILL_VAR);
  out = out.split(INK[side]).join(STROKE_VAR);

  const leftover = out.match(/#[0-9a-fA-F]{3,6}\b/g);
  if (leftover) {
    console.warn(`[chess] 棋子图形 ${code} 里还有没映射的颜色：${[...new Set(leftover)].join(', ')}`
      + ' —— 换素材了就要改 piece-art.js 的 BODY / INK 映射');
  }
  return out;
}

/**
 * 读进全部棋子图形。返回 `{ loaded, failed }`，**不抛错**。
 *
 * `base` 默认相对本模块（`../chess-icons/`），而不是相对页面 ——
 * 这样无论页面从哪个路径打开都对（Node 里跑测试时它是个 file:// URL，测试给的 fetch 桩照样能接）。
 */
export async function loadPieceArt(base = new URL('../chess-icons/', import.meta.url)) {
  const failed = [];

  await Promise.all(FILES.map(async ([code, name]) => {
    try {
      const res = await fetch(new URL(`${name}.svg`, base));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      art.set(String(code), colorize(extractMarkup(await res.text()), code));
    } catch (e) {
      failed.push(`${name}.svg（${e.message}）`);
      art.set(String(code), '');
    }
  }));

  lastReport = { loaded: FILES.length - failed.length, failed };
  if (failed.length) {
    console.warn('[chess] 棋子图形没读全，缺的会画成占位圆圈：', failed.join('、'));
  }
  return lastReport;
}

/** 取一枚棋子的内联标记。没加载到（或那个文件读失败）时返回空串 */
export function pieceArt(code) {
  return art.get(String(code)) || '';
}

/** 上一次加载的结果（`main.js` 用它决定要不要提示「图形没加载出来」） */
export function pieceArtReport() {
  return lastReport;
}
