#!/usr/bin/env node
/**
 * 棋子图形生成器 —— 把外部棋子集的 SVG 转成本模块要的 `js/pieces.js`。
 *
 * 用法（从仓库根跑）：
 *
 *   node chess/tools/gen-pieces.mjs [素材目录]
 *
 * 素材目录里要有 12 个 45×45 的 SVG（缺少就报错）：
 *
 *   wp wn wb wr wq wk   bp bn bb br bq bp
 *
 * 现在用的这套是 **Cburnett 棋子**（作者 Colin M. L. Burnett），
 * 也就是维基共享上最常见的那套。文件从 `https://www.chessdb.cn/file/chess/<名字>.svg` 抓的
 * （同一批文件在维基共享上按 CC BY-SA 3.0 发布）。下载与署名都在 `js/pieces.js` 的文件头里写着。
 *
 * ## 只做两件变换
 *
 *   1. 去掉 XML 声明与 `<svg>` 外壳，**只留里面的标记** —— 于是它就是一个普通的字符串常量，
 *      没有图片文件、运行时也不联网（和原来手写那版一样）。
 *   2. 把两个色值换成 CSS 变量：**棋子主体那个色** → `--chess-p-fill`，
 *      另一个色（描边，以及眼睛、鬃毛这类细节）→ `--chess-p-stroke`。
 *      白棋的主体色是 `#ffffff`、黑棋是 `#000000`，所以两个色各自换到哪一边是**按棋子颜色决定**的。
 *
 * 除了这两个色值，**不动任何路径数据** —— `d`、`transform`、`fill-rule`、`stroke-width` 全部原样。
 *
 * ## 为什么不做成运行时从网上取
 *
 * 这个模块的定位是「纯静态、无构建、无依赖、不联网」，抓一次、变成常量放进仓库，
 * 与 `endgames.js` 里那些 FEN 是同一套做法。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'js/pieces.js');

/** 素材目录：默认取环境变量 TEMP 下的 chess-ref（抓下来放在那儿就行） */
const SRC = process.argv[2] || join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'chess-ref');

/**
 * 素材文件名 → 棋子编码。
 *
 * 编码与 config.js 一致（1 兵 2 马 3 象 4 车 5 后 6 王），**带符号**：
 * 正数是白棋、负数是黑棋 —— 因为这套棋子的黑白是**两套不同路径**（细节不同），
 * 不能像原来手写那版一样黑白共用一份。
 */
const FILES = [
  ['wp', 1], ['wn', 2], ['wb', 3], ['wr', 4], ['wq', 5], ['wk', 6],
  ['bp', -1], ['bn', -2], ['bb', -3], ['br', -4], ['bq', -5], ['bk', -6],
];

const PIECE_NAMES = { 1: '兵', 2: '马', 3: '象', 4: '车', 5: '后', 6: '王' };

/** 主体色：白棋的主色是白、黑棋的主色是黑。另一个色就是描边与细节。 */
const BODY = { w: '#ffffff', b: '#000000' };
const INK = { w: '#000000', b: '#ffffff' };
const FILL_VAR = 'var(--chess-p-fill)';
const STROKE_VAR = 'var(--chess-p-stroke)';

/** 取出 <svg> 里的标记，并把换行 / 缩进压成单个空格（SVG 的路径数据里空格就是分隔符，压掉多余的安全） */
function extract(src) {
  const start = src.indexOf('>', src.indexOf('<svg'));
  const end = src.lastIndexOf('</svg>');
  if (start < 0 || end < 0) throw new Error('找不到 <svg> 外壳');
  return src.slice(start + 1, end).replace(/\s+/g, ' ').trim();
}

/**
 * 把一段标记写成若干行拼接的字符串字面量。
 * 只是为了让生成物读得下去（一行 1.5KB 没法 review），拼出来的字符串必须与原文**一字不差**。
 *
 * 切点选在空格处时，**这个空格要留在上一段末尾** —— 两头都不留的话，
 * `M10 39` 会被切成 `…10` + `39…`，拼起来变成 `1039`，路径数据当场就坏了
 *（SVG 的路径数据里空格就是分隔符）。这个坑是浏览器控制台报
 * `<path> attribute d: Expected number` 抓出来的，单测看不出来。
 */
function toLiteral(text, width = 96) {
  const parts = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width * 0.6) cut = width;         // 附近没有空格就硬切（拼接结果不受影响）
    else cut += 1;                              // 切在空格上：把空格留给上一段
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts.map((p, i) => (i === 0 ? `'${p}'` : `    + '${p}'`)).join('\n');
}

// ============================================================
// 生成
// ============================================================

if (!existsSync(SRC)) {
  console.error(`素材目录不存在：${SRC}`);
  console.error('用法：node chess/tools/gen-pieces.mjs <素材目录>');
  process.exit(1);
}

const blocks = [];
const report = [];
/** 这次算出来的「编码 → 图形」，写完文件后再读回来跟它比对（见后面的自校验） */
const expected = {};

for (const [file, code] of FILES) {
  const path = join(SRC, `${file}.svg`);
  if (!existsSync(path)) {
    console.error(`缺少素材：${path}`);
    process.exit(1);
  }

  const side = file[0];                        // 'w' | 'b'
  const abs = Math.abs(code);
  let art = extract(readFileSync(path, 'utf8'));

  // 主体色 → 填充变量；另一个色 → 描边变量。**先换主体色**：
  // 两个色在同一个文件里不会互相包含（#ffffff 与 #000000），顺序其实无所谓，但这样更好读。
  art = art.split(BODY[side]).join(FILL_VAR);
  art = art.split(INK[side]).join(STROKE_VAR);

  const leftover = art.match(/#[0-9a-fA-F]{3,6}/g);
  if (leftover) {
    // 出现第三种颜色说明这套素材换过了，映射规则要跟着改 —— 别静悄悄地放过
    console.error(`${file}.svg 里还有没映射的颜色：${[...new Set(leftover)].join(', ')}`);
    process.exit(1);
  }

  // 键**必须加引号**：`-3:` 不是合法的对象键（负数不是数字字面量），写了直接语法错误。
  // 加引号之后查表照旧用数字：`PIECE_ART[-3]` 会被转成字符串键，取得到。
  expected[String(code)] = art;
  blocks.push(`  '${code}': // ${PIECE_NAMES[abs]}（${side === 'w' ? '白' : '黑'}）\n    ${toLiteral(art)},`);
  report.push(`${file} → ${code}  ${art.length} 字符`);
}

const out = `/**
 * 棋子图形 —— **这个文件是生成的，别手改**。
 *
 * 生成：\`node chess/tools/gen-pieces.mjs <素材目录>\`
 *
 * 素材是 **Cburnett 棋子**（作者 Colin M. L. Burnett，维基共享上最常见的那套），
 * 12 个 45×45 的 SVG 从 \`https://www.chessdb.cn/file/chess/< wk | wn | … | bp >.svg\` 抓下来。
 * 同一批文件维基共享上的口径是 CC BY-SA 3.0（lichess 的 COPYING.md 里记作 GPLv2+）。
 * 模块定位是「零第三方运行时依赖」，所以路径**抓一次内联进来**，网页不联网、也没有图片文件。
 *
 * 变换只有两件事（细节见 tools/gen-pieces.mjs）：
 *   1. 去掉 XML 头与 <svg> 外壳，只留内部标记；
 *   2. 两个色值换成 CSS 变量 —— 棋子主体色 → \`--chess-p-fill\`，
 *      另一个色（描边，以及眼睛 / 鬃毛这类细节）→ \`--chess-p-stroke\`。
 *      白棋主体色是 #ffffff、黑棋是 #000000，所以两个色换到哪一边按棋子颜色定。
 * 路径数据（d / transform / fill-rule / stroke-width）**一律原样**，没有重画。
 *
 * **黑/白是两套路径**（细节不同，比如马的鬃毛、象的帽缝），所以键是**带符号**的编码：
 * 1..6 白，-1..-6 黑。查表用 \`PIECE_ART[piece]\`，直接拿带符号的编码去取。
 */

export const PIECE_ART = {
${blocks.join('\n')}
};

/** 素材来源（页面上的署名与说明都读这里，别在别处再抄一份） */
export const PIECE_ART_SOURCE = {
  name: 'Cburnett',
  author: 'Colin M. L. Burnett',
  license: 'CC BY-SA 3.0',
  from: 'https://www.chessdb.cn/file/chess/',
};
`;

writeFileSync(OUT, out);

// ============================================================
// 自校验：把刚写出去的文件读回来，跟这次算出来的逐字比对
// ============================================================
//
// **这一步不是走过场。** 拼接字符串那个环节很容易悄悄改坏路径数据
//（分段处丢一个空格就把 `M10 39` 变成 `1039`），而单测只看得见长度和变量名。
// 与其等浏览器控制台报 `<path> attribute d`，不如在这里就拦下来。
{
  const mod = await import(pathToFileURL(OUT).href);
  const got = mod.PIECE_ART || {};
  const bad = [];
  for (const key of Object.keys(expected)) {
    if (got[key] !== expected[key]) bad.push(key);
  }
  if (bad.length || Object.keys(got).length !== Object.keys(expected).length) {
    console.error(`\n自校验失败：${bad.join(', ') || '键的数量对不上'}`);
    console.error('生成的图形与素材不一致 —— 别提交，先看 toLiteral / extract。');
    process.exit(1);
  }
}

console.log(`写出 ${OUT}（自校验通过：读回来的 12 张图形与本次算出的逐字一致）\n`);
for (const line of report) console.log(`  ${line}`);
