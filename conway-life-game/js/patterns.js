/**
 * 经典结构库。这是唯一需要手工维护的数据文件。
 *
 * cells 用相对坐标数组表示：[[x, y], ...]，x 向右、y 向下。
 * 不用自己保证从 (0,0) 开始，模块加载时会统一归一化到包围盒左上角，
 * 并补上 width / height 两个字段（面板缩略图和居中摆放都靠它）。
 *
 * 加新结构时，把注释里的图形一行行抄成坐标即可；抄完跑一下
 * `node conway-life-game/tools/verify-patterns.mjs` 校验是不是真的静物/振荡器/飞船。
 * 拿不准形状时，也可以先用 `--grid` 模式把 ASCII 图形喂进去试。
 *
 * classic: true 的结构会出现在页面顶部「初始内容」下拉里。
 */

export const CATEGORIES = [
  { id: 'still-life', name: '静物' },
  { id: 'oscillator', name: '振荡器' },
  { id: 'spaceship', name: '飞船' },
  { id: 'gun', name: '枪' },
  { id: 'methuselah', name: '长寿者' },
];

const RAW = [
  // ==================== 静物 ====================
  {
    id: 'block',
    name: '方块',
    category: 'still-life',
    // OO
    // OO
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
  },
  {
    id: 'beehive',
    name: '蜂巢',
    category: 'still-life',
    // .OO.
    // O..O
    // .OO.
    cells: [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [2, 2]],
  },
  {
    id: 'loaf',
    name: '面包',
    category: 'still-life',
    // .OO.
    // O..O
    // .O.O
    // ..O.
    cells: [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [3, 2], [2, 3]],
  },
  {
    id: 'boat',
    name: '小船',
    category: 'still-life',
    // OO.
    // O.O
    // .O.
    cells: [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2]],
  },
  {
    id: 'tub',
    name: '浴缸',
    category: 'still-life',
    // .O.
    // O.O
    // .O.
    cells: [[1, 0], [0, 1], [2, 1], [1, 2]],
  },
  {
    id: 'ship',
    name: '船',
    category: 'still-life',
    // OO.
    // O.O
    // .OO
    cells: [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2], [2, 2]],
  },
  {
    id: 'pond',
    name: '池塘',
    category: 'still-life',
    // .OO.
    // O..O
    // O..O
    // .OO.
    cells: [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [1, 3], [2, 3]],
  },

  // ==================== 振荡器 ====================
  {
    id: 'blinker',
    name: '闪烁灯',
    category: 'oscillator',
    period: 2,
    // OOO
    cells: [[0, 0], [1, 0], [2, 0]],
  },
  {
    id: 'toad',
    name: '蟾蜍',
    category: 'oscillator',
    period: 2,
    // .OOO
    // OOO.
    cells: [[1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1]],
  },
  {
    id: 'beacon',
    name: '信标',
    category: 'oscillator',
    period: 2,
    // OO..
    // OO..
    // ..OO
    // ..OO
    cells: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2], [3, 2], [2, 3], [3, 3]],
  },
  {
    id: 'pulsar',
    name: '脉冲星',
    category: 'oscillator',
    period: 3,
    classic: true,
    note: '周期 3，最著名的对称振荡器',
    // ..OOO...OOO..
    // .............
    // O....O.O....O
    // O....O.O....O
    // O....O.O....O
    // ..OOO...OOO..
    // .............
    // ..OOO...OOO..
    // O....O.O....O
    // O....O.O....O
    // O....O.O....O
    // .............
    // ..OOO...OOO..
    cells: [
      [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0],
      [0, 2], [5, 2], [7, 2], [12, 2],
      [0, 3], [5, 3], [7, 3], [12, 3],
      [0, 4], [5, 4], [7, 4], [12, 4],
      [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5],
      [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
      [0, 8], [5, 8], [7, 8], [12, 8],
      [0, 9], [5, 9], [7, 9], [12, 9],
      [0, 10], [5, 10], [7, 10], [12, 10],
      [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
    ],
  },
  {
    id: 'pentadecathlon',
    name: '十五周期',
    category: 'oscillator',
    period: 15,
    classic: true,
    note: '十五周期振荡器，周期 15',
    // ..O....O..
    // OO.OOOO.OO
    // ..O....O..
    cells: [
      [2, 0], [7, 0],
      [0, 1], [1, 1], [3, 1], [4, 1], [5, 1], [6, 1], [8, 1], [9, 1],
      [2, 2], [7, 2],
    ],
  },

  // ==================== 飞船 ====================
  {
    id: 'glider',
    name: '滑翔机',
    category: 'spaceship',
    period: 4,
    note: '周期 4，每周期沿对角线移动 1 格',
    // .O.
    // ..O
    // OOO
    cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]],
  },
  {
    id: 'lwss',
    name: '轻型飞船',
    category: 'spaceship',
    period: 4,
    note: '周期 4，每周期横向移动 2 格',
    // .O..O
    // O....
    // O...O
    // OOOO.
    cells: [[1, 0], [4, 0], [0, 1], [0, 2], [4, 2], [0, 3], [1, 3], [2, 3], [3, 3]],
  },
  {
    id: 'mwss',
    name: '中型飞船',
    category: 'spaceship',
    period: 4,
    note: '周期 4，每周期横向移动 2 格',
    // ...O..
    // .O...O
    // O.....
    // O....O
    // OOOOO.
    cells: [
      [3, 0],
      [1, 1], [5, 1],
      [0, 2],
      [0, 3], [5, 3],
      [0, 4], [1, 4], [2, 4], [3, 4], [4, 4],
    ],
  },
  {
    id: 'hwss',
    name: '重型飞船',
    category: 'spaceship',
    period: 4,
    note: '周期 4，每周期横向移动 2 格',
    // ...OO..
    // .O....O
    // O......
    // O.....O
    // OOOOOO.
    cells: [
      [3, 0], [4, 0],
      [1, 1], [6, 1],
      [0, 2],
      [0, 3], [6, 3],
      [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
    ],
  },

  // ==================== 枪 ====================
  {
    id: 'gosper-gun',
    name: 'Gosper 枪',
    category: 'gun',
    period: 30,
    classic: true,
    note: 'Gosper 滑翔机枪，周期 30，每周期射出一架滑翔机（无限增长）',
    // ........................O...........
    // ......................O.O...........
    // ............OO......OO............OO
    // ...........O...O....OO............OO
    // OO........O.....O...OO..............
    // OO........O...O.OO....O.O...........
    // ..........O.....O.......O...........
    // ...........O...O....................
    // ............OO......................
    cells: [
      [24, 0],
      [22, 1], [24, 1],
      [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
      [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
      [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
      [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
      [10, 6], [16, 6], [24, 6],
      [11, 7], [15, 7],
      [12, 8], [13, 8],
    ],
  },

  // ==================== 长寿者 ====================
  {
    id: 'r-pentomino',
    name: 'R-五连块',
    category: 'methuselah',
    period: 1103,
    classic: true,
    note: '1103 代后才稳定，会留下 116 个细胞',
    // .OO
    // OO.
    // .O.
    cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  },
  {
    id: 'acorn',
    name: '橡果',
    category: 'methuselah',
    period: 5206,
    classic: true,
    note: '5206 代后才稳定，会留下 633 个细胞',
    // .O.....
    // ...O...
    // OO..OOO
    cells: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]],
  },
  {
    id: 'diehard',
    name: '顽固分子',
    category: 'methuselah',
    classic: true,
    note: '恰好 130 代后完全消亡',
    // ......O.
    // OO......
    // .O...OOO
    cells: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]],
  },
];

/**
 * 把一组坐标平移到包围盒左上角为 (0,0)，并算出 width / height。
 * @param {number[][]} cells
 * @returns {{cells:number[][], width:number, height:number}}
 */
export function normalizeCells(cells) {
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i][0] < minX) minX = cells[i][0];
    if (cells[i][1] < minY) minY = cells[i][1];
  }
  let maxX = 0;
  let maxY = 0;
  const out = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i][0] - minX;
    const y = cells[i][1] - minY;
    out[i] = [x, y];
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { cells: out, width: maxX + 1, height: maxY + 1 };
}

/**
 * 从棋盘的某个矩形区域里抠出活细胞（保持棋盘坐标，未归一化）。
 * 区域里没有活细胞时返回空数组，由调用方决定怎么提示。
 */
export function extractCells(board, rect) {
  const cells = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (board.get(x, y)) cells.push([x, y]);
    }
  }
  return cells;
}

export const PATTERNS = RAW.map((p) => {
  const n = normalizeCells(p.cells);
  return { ...p, cells: n.cells, width: n.width, height: n.height };
});

const BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

export function getPattern(id) {
  return BY_ID.get(id) || null;
}

export function patternsOfCategory(categoryId) {
  return PATTERNS.filter((p) => p.category === categoryId);
}

/** 出现在「初始内容」下拉里的结构 */
export function classicPatterns() {
  return PATTERNS.filter((p) => p.classic);
}

/**
 * 旋转 / 翻转一组相对坐标。
 * @param {number[][]} cells 已归一化的相对坐标
 * @param {number} rot 顺时针旋转次数（0~3）
 * @param {boolean} flipH 水平翻转
 * @param {boolean} flipV 垂直翻转
 * @returns {{cells:number[][], width:number, height:number}}
 */
export function transformCells(cells, rot = 0, flipH = false, flipV = false) {
  const b = normalizeCells(cells);
  let pts = b.cells;
  let w = b.width;
  let h = b.height;

  if (flipH) pts = pts.map(([x, y]) => [w - 1 - x, y]);
  if (flipV) pts = pts.map(([x, y]) => [x, h - 1 - y]);

  const turns = ((rot % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) {
    // 顺时针 90°：(x, y) -> (h - 1 - y, x)
    pts = pts.map(([x, y]) => [h - 1 - y, x]);
    const t = w;
    w = h;
    h = t;
  }
  return { cells: pts, width: w, height: h };
}
