/**
 * 棋子图形 —— **这个文件是生成的，别手改**。
 *
 * 生成：`node chess/tools/gen-pieces.mjs <素材目录>`
 *
 * 素材是 **Cburnett 棋子**（作者 Colin M. L. Burnett，维基共享上最常见的那套），
 * 12 个 45×45 的 SVG 从 `https://www.chessdb.cn/file/chess/< wk | wn | … | bp >.svg` 抓下来。
 * 同一批文件维基共享上的口径是 CC BY-SA 3.0（lichess 的 COPYING.md 里记作 GPLv2+）。
 * 模块定位是「零第三方运行时依赖」，所以路径**抓一次内联进来**，网页不联网、也没有图片文件。
 *
 * 变换只有两件事（细节见 tools/gen-pieces.mjs）：
 *   1. 去掉 XML 头与 <svg> 外壳，只留内部标记；
 *   2. 两个色值换成 CSS 变量 —— 棋子主体色 → `--chess-p-fill`，
 *      另一个色（描边，以及眼睛 / 鬃毛这类细节）→ `--chess-p-stroke`。
 *      白棋主体色是 #ffffff、黑棋是 #000000，所以两个色换到哪一边按棋子颜色定。
 * 路径数据（d / transform / fill-rule / stroke-width）**一律原样**，没有重画。
 *
 * **黑/白是两套路径**（细节不同，比如马的鬃毛、象的帽缝），所以键是**带符号**的编码：
 * 1..6 白，-1..-6 黑。查表用 `PIECE_ART[piece]`，直接拿带符号的编码去取。
 */

export const PIECE_ART = {
  '1': // 兵（白）
    '<path d="M22.5 7.25C20.29 7.25 18.5 9.04 18.5 11.25 18.5 12.14 18.79 12.96 19.28 13.63 17.33 '
    + '14.75 16 16.84 16 19.25 16 21.28 16.94 23.09 18.41 24.28 15.41 25.34 11 29.83 11 37.75L34 '
    + '37.75C34 29.83 29.59 25.34 26.59 24.28 28.06 23.09 29 21.28 29 19.25 29 16.84 27.67 14.75 25.72 '
    + '13.63 26.21 12.96 26.5 12.14 26.5 11.25 26.5 9.04 24.71 7.25 22.5 7.25z" style="opacity:1; '
    + 'fill:var(--chess-p-fill); fill-opacity:1; fill-rule:nonzero; stroke:var(--chess-p-stroke); '
    + 'stroke-width:1.5; stroke-linecap:round; stroke-linejoin:miter; stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;" />',
  '2': // 马（白）
    '<g style="opacity:1; fill:none; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-stroke); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C '
    + '15,30 25,32.5 23,18" style="fill:var(--chess-p-fill); stroke:var(--chess-p-stroke);" /> <path '
    + 'd="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 '
    + '11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 '
    + '14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 '
    + '19.28,8.008 21,7 C 22,7 22,10 22,10" style="fill:var(--chess-p-fill); '
    + 'stroke:var(--chess-p-stroke);" /> <path d="M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 '
    + '9.5 25.5 z" style="fill:var(--chess-p-stroke); stroke:var(--chess-p-stroke);" /> <path d="M 15 '
    + '15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z" transform="matrix(0.866,0.5,-0.5,0.866,9'
    + '.693,-5.173)" style="fill:var(--chess-p-stroke); stroke:var(--chess-p-stroke);" /> </g>',
  '3': // 象（白）
    '<g style="opacity:1; fill:none; fill-rule:evenodd; fill-opacity:1; stroke:var(--chess-p-stroke); '
    + 'stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <g style="fill:var(--chess-p-fill); '
    + 'stroke:var(--chess-p-stroke); stroke-linecap:butt;"> <path d="M 9,36 C 12.39,35.03 19.11,36.43 '
    + '22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 '
    + '36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 '
    + '6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" /> <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C '
    + '30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 '
    + '12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" /> <path d="M 25 8 A 2.5 2.5 '
    + '0 1 1 20,8 A 2.5 2.5 0 1 1 25 8 z" /> </g> <path d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M '
    + '22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" style="fill:none; stroke:var(--chess-p-stroke); '
    + 'stroke-linejoin:miter;" /> </g>',
  '4': // 车（白）
    '<g style="opacity:1; fill:var(--chess-p-fill); fill-opacity:1; fill-rule:evenodd; '
    + 'stroke:var(--chess-p-stroke); stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;strok'
    + 'e-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;"> <path d="M10 39 37 39 37 36 10 36 10 '
    + '39z" style="stroke-linecap:butt;" /> <path d="M13 36 13 32 34 32 34 36 13 36z" '
    + 'style="stroke-linecap:butt;" /> <path d="M12 14 12 9 16 9 16 11 21 11 21 9 26 9 26 11 31 11 31 9 '
    + '35 9 35 14" style="stroke-linecap:butt;" /> <path d="M35 14 32 17 15 17 12 14" /> <path d="M32 '
    + '17 32 29.5 15 29.5 15 17" style="stroke-linecap:butt; stroke-linejoin:miter;" /> <path d="M32 '
    + '29.5 33.5 32 13.5 32 15 29.5" /> <path d="M12 14 35 14" style="fill:none; '
    + 'stroke:var(--chess-p-stroke); stroke-linejoin:miter;" /> </g>',
  '5': // 后（白）
    '<g style="opacity:1; fill:var(--chess-p-fill); fill-opacity:1; fill-rule:evenodd; '
    + 'stroke:var(--chess-p-stroke); stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;strok'
    + 'e-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;"> <path d="M 9 13 A 2 2 0 1 1 5,13 A 2 '
    + '2 0 1 1 9 13 z" transform="translate(-1,-1)" /> <path d="M 9 13 A 2 2 0 1 1 5,13 A 2 2 0 1 1 9 '
    + '13 z" transform="translate(15.5,-5.5)" /> <path d="M 9 13 A 2 2 0 1 1 5,13 A 2 2 0 1 1 9 13 z" '
    + 'transform="translate(32,-1)" /> <path d="M 9 13 A 2 2 0 1 1 5,13 A 2 2 0 1 1 9 13 z" '
    + 'transform="translate(7,-4.5)" /> <path d="M 9 13 A 2 2 0 1 1 5,13 A 2 2 0 1 1 9 13 z" '
    + 'transform="translate(24,-4)" /> <path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38,14 L 31,25 L '
    + '31,11 L 25.5,24.5 L 22.5,9.5 L 19.5,24.5 L 14,10.5 L 14,25 L 7,14 L 9,26 z " '
    + 'style="stroke-linecap:butt;" /> <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 '
    + '12,33.5 C 10.5,34.5 10.5,36 10.5,36 C 9,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C '
    + '34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 '
    + '36,26 C 27.5,24.5 17.5,24.5 9,26 z " style="stroke-linecap:butt;" /> <path d="M 11.5,30 C 15,29 '
    + '30,29 33.5,30" style="fill:none;" /> <path d="M 12,33.5 C 18,32.5 27,32.5 33,33.5" '
    + 'style="fill:none;" /> </g>',
  '6': // 王（白）
    '<g style="fill:none; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-stroke); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <path d="M 22.5,11.63 L 22.5,6" style="fill:none; '
    + 'stroke:var(--chess-p-stroke); stroke-linejoin:miter;" /> <path d="M 20,8 L 25,8" '
    + 'style="fill:none; stroke:var(--chess-p-stroke); stroke-linejoin:miter;" /> <path d="M 22.5,25 C '
    + '22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 '
    + '22.5,25 22.5,25" style="fill:var(--chess-p-fill); stroke:var(--chess-p-stroke); '
    + 'stroke-linecap:butt; stroke-linejoin:miter;" /> <path d="M 11.5,37 C 17,40.5 27,40.5 32.5,37 L '
    + '32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 19,16 '
    + '9.5,13 6.5,19.5 C 3.5,25.5 11.5,29.5 11.5,29.5 L 11.5,37 z " style="fill:var(--chess-p-fill); '
    + 'stroke:var(--chess-p-stroke);" /> <path d="M 11.5,30 C 17,27 27,27 32.5,30" style="fill:none; '
    + 'stroke:var(--chess-p-stroke);" /> <path d="M 11.5,33.5 C 17,30.5 27,30.5 32.5,33.5" '
    + 'style="fill:none; stroke:var(--chess-p-stroke);" /> <path d="M 11.5,37 C 17,34 27,34 32.5,37" '
    + 'style="fill:none; stroke:var(--chess-p-stroke);" /> </g>',
  '-1': // 兵（黑）
    '<path d="M22.5 7.25C20.29 7.25 18.5 9.04 18.5 11.25 18.5 12.14 18.79 12.96 19.28 13.63 17.33 '
    + '14.75 16 16.84 16 19.25 16 21.28 16.94 23.09 18.41 24.28 15.41 25.34 11 29.83 11 37.75L34 '
    + '37.75C34 29.83 29.59 25.34 26.59 24.28 28.06 23.09 29 21.28 29 19.25 29 16.84 27.67 14.75 25.72 '
    + '13.63 26.21 12.96 26.5 12.14 26.5 11.25 26.5 9.04 24.71 7.25 22.5 7.25z" style="opacity:1; '
    + 'fill:var(--chess-p-fill); fill-opacity:1; fill-rule:nonzero; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round; stroke-linejoin:miter; stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;" />',
  '-2': // 马（黑）
    '<g style="opacity:1; fill:none; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C '
    + '15,30 25,32.5 23,18" style="fill:var(--chess-p-fill); stroke:var(--chess-p-fill);" /> <path d="M '
    + '24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 '
    + 'C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C '
    + '13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C '
    + '22,7 22,10 22,10" style="fill:var(--chess-p-fill); stroke:var(--chess-p-fill);" /> <path d="M '
    + '9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z" style="fill:var(--chess-p-stroke); '
    + 'stroke:var(--chess-p-stroke);" /> <path d="M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 '
    + '15.5 z" transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)" style="fill:var(--chess-p-stroke); '
    + 'stroke:var(--chess-p-stroke);" /> <path d="M 24.55,10.4 L 24.1,11.85 L 24.6,12 C 27.75,13 '
    + '30.25,14.49 32.5,18.75 C 34.75,23.01 35.75,29.06 35.25,39 L 35.2,39.5 L 37.45,39.5 L 37.5,39 C '
    + '38,28.94 36.62,22.15 34.25,17.66 C 31.88,13.17 28.46,11.02 25.06,10.5 L 24.55,10.4 z " '
    + 'style="fill:var(--chess-p-stroke); stroke:none;" /> </g>',
  '-3': // 象（黑）
    '<g style="opacity:1; fill:none; fill-rule:evenodd; fill-opacity:1; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <g style="fill:var(--chess-p-fill); '
    + 'stroke:var(--chess-p-fill); stroke-linecap:butt;"> <path d="M 9,36 C 12.39,35.03 19.11,36.43 '
    + '22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 '
    + '36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 '
    + '6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" /> <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C '
    + '30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 '
    + '12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" /> <path d="M 25 8 A 2.5 2.5 '
    + '0 1 1 20,8 A 2.5 2.5 0 1 1 25 8 z" /> </g> <path d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M '
    + '22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" style="fill:none; stroke:var(--chess-p-stroke); '
    + 'stroke-linejoin:miter;" /> </g>',
  '-4': // 车（黑）
    '<g style="opacity:1; fill:000000; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <path d="M10 39 37 39 37 36 10 36 10 39z" '
    + 'style="stroke-linecap:butt;" /> <path d="M13.5 32 15 29.5 32 29.5 33.5 32 13.5 32z" '
    + 'style="stroke-linecap:butt;" /> <path d="M13 36 13 32 34 32 34 36 13 36z" '
    + 'style="stroke-linecap:butt;" /> <path d="M15 29.5 15 16.5 32 16.5 32 29.5 15 29.5z" '
    + 'style="stroke-linecap:butt;stroke-linejoin:miter;" /> <path d="M15 16.5 12 14 35 14 32 16.5 15 '
    + '16.5z" style="stroke-linecap:butt;" /> <path d="M12 14 12 9 16 9 16 11 21 11 21 9 26 9 26 11 31 '
    + '11 31 9 35 9 35 14 12 14z" style="stroke-linecap:butt;" /> <path d="M13 35.5 34 35.5 34 35.5" '
    + 'style="fill:none; stroke:var(--chess-p-stroke); stroke-width:1; stroke-linejoin:miter;" /> <path '
    + 'd="M14 31.5 33 31.5" style="fill:none; stroke:var(--chess-p-stroke); stroke-width:1; '
    + 'stroke-linejoin:miter;" /> <path d="M15 29.5 32 29.5" style="fill:none; '
    + 'stroke:var(--chess-p-stroke); stroke-width:1; stroke-linejoin:miter;" /> <path d="M15 16.5 32 '
    + '16.5" style="fill:none; stroke:var(--chess-p-stroke); stroke-width:1; stroke-linejoin:miter;" /> '
    + '<path d="M12 14 35 14" style="fill:none; stroke:var(--chess-p-stroke); stroke-width:1; '
    + 'stroke-linejoin:miter;" /> </g>',
  '-5': // 后（黑）
    '<g style="opacity:1; fill:000000; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <g style="fill:var(--chess-p-fill); stroke:none;"> '
    + '<circle cx="6" cy="12" r="2.75" /> <circle cx="14" cy="9" r="2.75" /> <circle cx="22.5" cy="8" '
    + 'r="2.75" /> <circle cx="31" cy="9" r="2.75" /> <circle cx="39" cy="12" r="2.75" /> </g> <path '
    + 'd="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L '
    + '19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z" style="stroke-linecap:butt; '
    + 'stroke:var(--chess-p-fill);" /> <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 '
    + '12,33.5 C 10.5,34.5 10.5,36 10.5,36 C 9,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C '
    + '34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 '
    + '36,26 C 27.5,24.5 17.5,24.5 9,26 z" style="stroke-linecap:butt;" /> <path d="M 11,38.5 A 35,35 1 '
    + '0 0 34,38.5" style="fill:none; stroke:var(--chess-p-fill); stroke-linecap:butt;" /> <path d="M '
    + '11,29 A 35,35 1 0 1 34,29" style="fill:none; stroke:var(--chess-p-stroke);" /> <path d="M '
    + '12.5,31.5 L 32.5,31.5" style="fill:none; stroke:var(--chess-p-stroke);" /> <path d="M 11.5,34.5 '
    + 'A 35,35 1 0 0 33.5,34.5" style="fill:none; stroke:var(--chess-p-stroke);" /> <path d="M '
    + '10.5,37.5 A 35,35 1 0 0 34.5,37.5" style="fill:none; stroke:var(--chess-p-stroke);" /> </g>',
  '-6': // 王（黑）
    '<g style="fill:none; fill-opacity:1; fill-rule:evenodd; stroke:var(--chess-p-fill); '
    + 'stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; '
    + 'stroke-dasharray:none; stroke-opacity:1;"> <path d="M 22.5,11.63 L 22.5,6" style="fill:none; '
    + 'stroke:var(--chess-p-fill); stroke-linejoin:miter;" id="path6570" /> <path d="M 22.5,25 C '
    + '22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 '
    + '22.5,25 22.5,25" style="fill:var(--chess-p-fill);fill-opacity:1; stroke-linecap:butt; '
    + 'stroke-linejoin:miter;" /> <path d="M 11.5,37 C 17,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 '
    + '41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 19,16 9.5,13 6.5,19.5 C '
    + '3.5,25.5 11.5,29.5 11.5,29.5 L 11.5,37 z " style="fill:var(--chess-p-fill); '
    + 'stroke:var(--chess-p-fill);" /> <path d="M 20,8 L 25,8" style="fill:none; '
    + 'stroke:var(--chess-p-fill); stroke-linejoin:miter;" /> <path d="M 32,29.5 C 32,29.5 40.5,25.5 '
    + '38.03,19.85 C 34.15,14 25,18 22.5,24.5 L 22.51,26.6 L 22.5,24.5 C 20,18 9.906,14 6.997,19.85 C '
    + '4.5,25.5 11.85,28.85 11.85,28.85" style="fill:none; stroke:var(--chess-p-stroke);" /> <path d="M '
    + '11.5,30 C 17,27 27,27 32.5,30 M 11.5,33.5 C 17,30.5 27,30.5 32.5,33.5 M 11.5,37 C 17,34 27,34 '
    + '32.5,37" style="fill:none; stroke:var(--chess-p-stroke);" /> </g>',
};

/** 素材来源（页面上的署名与说明都读这里，别在别处再抄一份） */
export const PIECE_ART_SOURCE = {
  name: 'Cburnett',
  author: 'Colin M. L. Burnett',
  license: 'CC BY-SA 3.0',
  from: 'https://www.chessdb.cn/file/chess/',
};
