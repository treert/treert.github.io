/**
 * 有限矩形网格上的生命游戏。
 *
 * 设计取舍：
 * - 硬边界，越界一律当成死细胞（不环绕），这样规则和邻居统计都很直接。
 * - 用两份 Uint8Array 双缓冲，每代全量重算。相比稀疏结构，代码简单得多，
 *   且没有"必须有序去重"这类隐藏约束；几万格在 JS 里跑几千代/秒毫无压力。
 * - age 记录细胞连续存活的代数，只用于渲染着色。
 *
 * 坐标约定：x 向右为列，y 向下为行，与屏幕一致。
 */
export class Board {
  constructor(cols, rows, wrap = false) {
    this.cols = cols;
    this.rows = rows;
    this.wrap = wrap;
    this.cells = new Uint8Array(cols * rows);
    this.next = new Uint8Array(cols * rows);
    this.age = new Uint8Array(cols * rows);
    this.nextAge = new Uint8Array(cols * rows);
    this.population = 0;
    this.generation = 0;
    this._tables = null;
  }

  index(x, y) {
    return y * this.cols + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  get(x, y) {
    return this.inBounds(x, y) ? this.cells[this.index(x, y)] : 0;
  }

  /** @returns {boolean} 状态是否真的发生了变化 */
  set(x, y, alive) {
    if (!this.inBounds(x, y)) {
      // 环绕模式下落子也环绕：贴着边放结构时，超出部分会从对面接回来，而不是被悄悄裁掉
      if (!this.wrap) return false;
      x = ((x % this.cols) + this.cols) % this.cols;
      y = ((y % this.rows) + this.rows) % this.rows;
    }
    const i = this.index(x, y);
    const v = alive ? 1 : 0;
    if (this.cells[i] === v) return false;
    this.cells[i] = v;
    this.age[i] = v ? 1 : 0;
    this.population += v ? 1 : -1;
    return true;
  }

  toggle(x, y) {
    if (!this.inBounds(x, y)) return false;
    return this.set(x, y, this.cells[this.index(x, y)] ? 0 : 1);
  }

  clear() {
    this.cells.fill(0);
    this.age.fill(0);
    this.population = 0;
    this.generation = 0;
  }

  /**
   * 以 (ox, oy) 为锚点落下一组相对坐标 [[x, y], ...]，只置 1 不清 0。
   * @returns {number} 新增的活细胞数
   */
  stamp(cells, ox, oy) {
    let added = 0;
    for (let i = 0; i < cells.length; i++) {
      if (this.set(ox + cells[i][0], oy + cells[i][1], 1)) added++;
    }
    return added;
  }

  /** @param {number} density 0~1 */
  fillRandom(density, rng = Math.random) {
    this.clear();
    const { cells, age } = this;
    let pop = 0;
    for (let i = 0; i < cells.length; i++) {
      if (rng() < density) {
        cells[i] = 1;
        age[i] = 1;
        pop++;
      }
    }
    this.population = pop;
  }

  /**
   * 邻居下标表。左右邻居按列下标算，上下相邻行按行首下标算。
   * -1 表示"这一侧没有邻居"（硬边界）；环绕模式下全部取模，永远不会出现 -1。
   * 表只在尺寸或边界模式变化时重建，之后每代演化就是纯数组取值。
   */
  _rebuildTables() {
    const { cols, rows, wrap } = this;
    const left = new Int32Array(cols);
    const right = new Int32Array(cols);
    const up = new Int32Array(rows);
    const down = new Int32Array(rows);

    for (let x = 0; x < cols; x++) {
      left[x] = wrap ? (x - 1 + cols) % cols : x > 0 ? x - 1 : -1;
      right[x] = wrap ? (x + 1) % cols : x < cols - 1 ? x + 1 : -1;
    }
    for (let y = 0; y < rows; y++) {
      up[y] = wrap ? ((y - 1 + rows) % rows) * cols : y > 0 ? (y - 1) * cols : -1;
      down[y] = wrap ? ((y + 1) % rows) * cols : y < rows - 1 ? (y + 1) * cols : -1;
    }

    this._tables = { cols, rows, wrap, left, right, up, down };
  }

  _tablesFor() {
    const t = this._tables;
    if (!t || t.cols !== this.cols || t.rows !== this.rows || t.wrap !== this.wrap) {
      this._rebuildTables();
    }
    return this._tables;
  }

  /** 演化一代 */
  step() {
    if (this.population === 0) {
      this.generation++;
      return;
    }

    const { cols, rows, cells, next, age, nextAge } = this;
    const { left, right, up, down } = this._tablesFor();
    let pop = 0;

    for (let y = 0; y < rows; y++) {
      const rowBase = y * cols;
      const upBase = up[y];
      const downBase = down[y];
      const hasUp = upBase >= 0;
      const hasDown = downBase >= 0;

      for (let x = 0; x < cols; x++) {
        const l = left[x];
        const r = right[x];
        let n = 0;

        if (hasUp) {
          if (l >= 0) n += cells[upBase + l];
          n += cells[upBase + x];
          if (r >= 0) n += cells[upBase + r];
        }
        if (l >= 0) n += cells[rowBase + l];
        if (r >= 0) n += cells[rowBase + r];
        if (hasDown) {
          if (l >= 0) n += cells[downBase + l];
          n += cells[downBase + x];
          if (r >= 0) n += cells[downBase + r];
        }

        const i = rowBase + x;
        const alive = cells[i] ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
        next[i] = alive;
        if (alive) {
          pop++;
          const a = age[i] + 1;
          nextAge[i] = a < 255 ? a : 255;
        } else {
          nextAge[i] = 0;
        }
      }
    }

    this.cells = next;
    this.next = cells;
    this.age = nextAge;
    this.nextAge = age;
    this.population = pop;
    this.generation++;
  }

  /** @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}|null} */
  liveBounds() {
    if (this.population === 0) return null;
    const { cols, rows, cells } = this;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        if (cells[base + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /** 深拷贝当前状态，供撤销栈使用 */
  snapshot() {
    return {
      cols: this.cols,
      rows: this.rows,
      cells: this.cells.slice(),
      age: this.age.slice(),
      population: this.population,
      generation: this.generation,
    };
  }

  restore(snap) {
    if (snap.cols !== this.cols || snap.rows !== this.rows) {
      this.cols = snap.cols;
      this.rows = snap.rows;
      this.cells = new Uint8Array(snap.cells.length);
      this.next = new Uint8Array(snap.cells.length);
      this.age = new Uint8Array(snap.cells.length);
      this.nextAge = new Uint8Array(snap.cells.length);
    } else {
      this.next.fill(0);
      this.nextAge.fill(0);
    }
    this.cells.set(snap.cells);
    this.age.set(snap.age);
    this.population = snap.population;
    this.generation = snap.generation;
  }

  /**
   * 换尺寸，原有内容按中心对齐保留，超出部分裁掉。
   * 这是"点了另一个尺寸预设"时的行为：不弹确认框，靠撤销兜底。
   */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const oldCols = this.cols;
    const oldRows = this.rows;
    const oldCells = this.cells;
    const oldAge = this.age;

    const dx = Math.floor((cols - oldCols) / 2);
    const dy = Math.floor((rows - oldRows) / 2);

    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this.next = new Uint8Array(cols * rows);
    this.age = new Uint8Array(cols * rows);
    this.nextAge = new Uint8Array(cols * rows);

    let pop = 0;
    for (let y = 0; y < oldRows; y++) {
      const ny = y + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let x = 0; x < oldCols; x++) {
        const nx = x + dx;
        if (nx < 0 || nx >= cols) continue;
        const src = y * oldCols + x;
        if (!oldCells[src]) continue;
        const dst = ny * cols + nx;
        this.cells[dst] = 1;
        this.age[dst] = oldAge[src];
        pop++;
      }
    }
    this.population = pop;
  }
}
