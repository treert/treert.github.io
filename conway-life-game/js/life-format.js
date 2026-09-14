/**
 * Life 1.06 格式的读写。
 *
 * 格式极简：第一行固定是 `#Life 1.06`，之后每行一个活细胞，两个整数 `x y`。
 * 注意它**没有棋盘尺寸字段**，也没有正式的注释语法。所以这里刻意不往文件里塞
 * 任何额外信息，保证导出的内容能被最朴素的解析器直接吃掉——包括
 * tmp/conway_life_game.cpp 里那个 `while (is >> x >> y)`。
 *
 * 坐标约定和棋盘一致：x 向右为列，y 向下为行。
 */

/** 把活细胞列表写成 Life 1.06 文本。按行优先排序，方便人眼对照棋盘。 */
export function formatLife(cells) {
  const sorted = cells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = ['#Life 1.06'];
  for (const [x, y] of sorted) lines.push(`${x} ${y}`);
  return lines.join('\n') + '\n';
}

function cellBounds(cells) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 解析 Life 1.06 文本。
 *
 * 头行用"包含"而不是"相等"来判断：文件可能带 UTF-8 BOM，或者被 CRLF 留下一截，
 * 精确比较会莫名其妙失败（C++ 那边也踩过这个坑）。
 *
 * @returns {{ok:true, cells:number[][], bounds:object, duplicates:number}
 *         | {ok:false, error:string}}
 */
export function parseLife(text) {
  const clean = String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');

  if (!(lines[0] ?? '').includes('#Life 1.06')) {
    return { ok: false, error: '第一行不是 #Life 1.06' };
  }

  // 空行和 # 开头的注释行跳过，其余按空白切分成坐标对
  const tokens = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    tokens.push(...line.split(/\s+/));
  }

  if (tokens.length === 0) return { ok: false, error: '文件里没有任何坐标' };
  if (tokens.length % 2 !== 0) {
    return { ok: false, error: `坐标数字有 ${tokens.length} 个，是奇数，最后多出一个` };
  }

  const cells = [];
  const seen = new Set();
  let duplicates = 0;

  for (let i = 0; i < tokens.length; i += 2) {
    const x = Number(tokens[i]);
    const y = Number(tokens[i + 1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { ok: false, error: `坐标不是整数：「${tokens[i]} ${tokens[i + 1]}」` };
    }
    const key = `${x},${y}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    cells.push([x, y]);
  }

  return { ok: true, cells, bounds: cellBounds(cells), duplicates };
}
