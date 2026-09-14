import { CONFIG } from './config.js';

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
    this.ageLut = CONFIG.ageColors.map(hexToRgb);
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
   */
  draw(board, ghost) {
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
  }

  /** 把 board 的活细胞按年龄写进离屏 canvas 的像素数据 */
  _fillOffscreen(board) {
    const data = this.imageData.data;
    const cells = board.cells;
    const age = board.age;
    const lut = this.ageLut;
    const last = lut.length - 1;

    for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
      if (cells[i]) {
        const a = age[i];
        const c = lut[a < last ? a : last];
        data[p] = c[0];
        data[p + 1] = c[1];
        data[p + 2] = c[2];
        data[p + 3] = 255;
      } else {
        data[p + 3] = 0;
      }
    }
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
}
