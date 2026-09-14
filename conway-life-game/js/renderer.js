import { CONFIG } from './config.js';

/** 把 #rrggbb 打包成一个 32 位像素值。借 Uint8/Uint32 视图转换，不假设本机字节序。 */
function packColor(hex, alpha) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  const bytes = new Uint8Array(4);
  bytes[0] = (n >> 16) & 255;
  bytes[1] = (n >> 8) & 255;
  bytes[2] = n & 255;
  bytes[3] = alpha;
  return new Uint32Array(bytes.buffer)[0];
}

/**
 * 按 age 直接索引的调色板：索引 0 是透明（死细胞），索引 a>=1 是年龄 a 的活细胞。
 * 有了它，画一格就只是「读 age、查表、写 32 位」——不用读 cells，也不用分支。
 */
function buildAgeLut() {
  const colors = CONFIG.ageColors;
  const last = colors.length - 1;
  const lut = new Uint32Array(256);
  for (let age = 1; age < 256; age++) {
    lut[age] = packColor(colors[Math.min(age - 1, last)], 255);
  }
  return lut;
}

/**
 * 画布渲染。核心技巧：先把整块棋盘按 1 像素 1 格画进一张离屏 canvas，
 * 再用 drawImage 放大到主画布（关闭平滑），最后在上面叠网格线和幽灵预览。
 * 这样每帧的绘制量只跟格子数有关，跟格子显示多大无关。
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.cellSize = 10;
    this.cols = 0;
    this.rows = 0;
    this.dpr = 1;
    this.imageData = null;
    this.pixels = null; // imageData 的 32 位视图，逐格绘制直接写这里
    this.ageLut = buildAgeLut();
  }

  /**
   * 根据可用空间推导格子尺寸，并把 canvas 调整到 cols*cellSize x rows*cellSize（CSS 像素）。
   * @returns {number} 实际使用的格子尺寸
   */
  layout(cols, rows, availW, availH) {
    this.cols = cols;
    this.rows = rows;

    const { min, max } = CONFIG.cell;
    let size = Math.floor(Math.min(availW / cols, availH / rows));
    if (!Number.isFinite(size) || size < min) size = min;
    if (size > max) size = max;
    this.cellSize = size;

    if (this.off.width !== cols || this.off.height !== rows) {
      this.off.width = cols;
      this.off.height = rows;
      this.imageData = this.offCtx.createImageData(cols, rows);
      this.pixels = new Uint32Array(this.imageData.data.buffer);
    }

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cols * size;
    const cssH = rows * size;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    return size;
  }

  /**
   * @param {import('./board.js').Board} board
   * @param {{cells:number[][],ox:number,oy:number,width:number,height:number,valid:boolean}|null} ghost
   * @param {{x0:number,y0:number,x1:number,y1:number}|null} marquee 框选区域（含端点）
   */
  draw(board, ghost, marquee) {
    const { ctx, cols, rows, cellSize } = this;
    const cssW = cols * cellSize;
    const cssH = rows * cellSize;

    this._fillOffscreen(board);
    this.offCtx.putImageData(this.imageData, 0, 0);

    ctx.fillStyle = CONFIG.colors.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.drawImage(this.off, 0, 0, cols, rows, 0, 0, cssW, cssH);

    // 格子太小的时候网格线会糊成一片，不如不画
    if (cellSize >= 5) this._drawGrid(cssW, cssH);
    if (ghost) this._drawGhost(ghost);
    if (marquee) this._drawMarquee(marquee);
  }

  /** 框选：淡填充 + 虚线边框 */
  _drawMarquee(rect) {
    const { ctx, cellSize } = this;
    const x = rect.x0 * cellSize;
    const y = rect.y0 * cellSize;
    const w = (rect.x1 - rect.x0 + 1) * cellSize;
    const h = (rect.y1 - rect.y0 + 1) * cellSize;
    ctx.save();
    ctx.fillStyle = CONFIG.colors.marqueeFill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = CONFIG.colors.marqueeBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  /**
   * 把每个格子按年龄写进离屏 canvas 的像素数据。
   *
   * 这里刻意不读 board.cells、也不做任何判断：board 保证 age === 0 严格等价于
   * 「死细胞」，而调色板的 0 号位正好是透明，于是「读 age → 查表 → 写 32 位」就够了。
   * 实测比原来的「逐格判断 + 活细胞写 4 字节 / 死细胞写 1 字节」快约 2 倍。
   */
  _fillOffscreen(board) {
    const pixels = this.pixels;
    const age = board.age;
    const lut = this.ageLut;
    for (let i = 0; i < age.length; i++) pixels[i] = lut[age[i]];
  }

  _drawGrid(cssW, cssH) {
    const { ctx, cols, rows, cellSize } = this;
    ctx.save();
    ctx.strokeStyle = CONFIG.colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = x * cellSize + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
    }
    for (let y = 0; y <= rows; y++) {
      const py = y * cellSize + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(cssW, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawGhost(ghost) {
    const { ctx, cellSize, cols, rows } = this;
    const c = CONFIG.colors;
    ctx.save();
    ctx.fillStyle = ghost.valid ? c.ghost : c.ghostInvalid;

    const cells = ghost.cells;
    for (let i = 0; i < cells.length; i++) {
      let gx = ghost.ox + cells[i][0];
      let gy = ghost.oy + cells[i][1];
      // 环绕模式下预览也跟着绕，跨接缝的结构会显示成"两边各一半"，一眼就能看出来
      if (ghost.wrap) {
        gx = ((gx % cols) + cols) % cols;
        gy = ((gy % rows) + rows) % rows;
      }
      ctx.fillRect(gx * cellSize, gy * cellSize, cellSize, cellSize);
    }

    // 跨了接缝就不画外框，否则框的位置会让人误解
    if (ghost.showOutline) {
      ctx.strokeStyle = ghost.valid ? c.ghostBorder : c.ghostInvalidBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        ghost.ox * cellSize + 0.5,
        ghost.oy * cellSize + 0.5,
        ghost.width * cellSize - 1,
        ghost.height * cellSize - 1
      );
    }
    ctx.restore();
  }

  /** 客户端坐标 -> 格子坐标，超出棋盘返回 null */
  cellFromPoint(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / this.cellSize);
    const y = Math.floor((clientY - r.top) / this.cellSize);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return { x, y };
  }

  /** 同上，但超出棋盘时夹到边界。框选拖到棋盘外面时用，免得整个拖拽被丢掉 */
  cellFromPointClamped(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / this.cellSize);
    const y = Math.floor((clientY - r.top) / this.cellSize);
    return {
      x: Math.min(Math.max(x, 0), this.cols - 1),
      y: Math.min(Math.max(y, 0), this.rows - 1),
    };
  }
}
