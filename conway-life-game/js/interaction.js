/**
 * 棋盘上的指针交互。三种模式：
 *   1. 放置：结构面板选中了某个结构 -> 鼠标移动显示幽灵预览，点击落子；
 *      也可以直接从面板拖到棋盘上松手落子。
 *   2. 手绘：没有选中结构 -> 按住拖动直接画 / 擦细胞，
 *      这一笔是画还是擦由 app.getPaintMode() 决定（自动 / 画笔 / 橡皮）。
 *   3. 框选：Shift + 拖拽 -> 拉出一个矩形，松手后由 main.js 弹出操作条。
 *      不做成"模式开关"是因为多个模式就意味着要记得切回来；Shift 是唯一还没用上的修饰键。
 *
 * 拖拽用的是 Pointer Events（鼠标/触屏/手写笔统一），不用 HTML5 drag-and-drop，
 * 后者在触屏上根本不工作。
 */

/** 结构以光标所在格为中心摆放时的左上角 */
function placementAnchor(cell, placement) {
  return {
    ox: cell.x - Math.floor((placement.width - 1) / 2),
    oy: cell.y - Math.floor((placement.height - 1) / 2),
  };
}

export class Interaction {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} app 由 main.js 提供的应用上下文
   *   app.board / app.renderer / app.getPlacement() / app.setGhost() / app.pushUndo() / app.afterEdit()
   *   app.marquee / app.setMarquee()
   */
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;

    this.painting = null; // 1 画 / 0 擦 / null 不在绘制
    this.lastCell = null;
    this.dragFromPalette = false;
    this.marqueeDrag = false;
    this.pointer = null;

    this._onCanvasDown = this._onCanvasDown.bind(this);
    this._onCanvasMove = this._onCanvasMove.bind(this);
    this._onCanvasUp = this._onCanvasUp.bind(this);
    this._onWindowMove = this._onWindowMove.bind(this);
    this._onWindowUp = this._onWindowUp.bind(this);

    canvas.addEventListener('pointerdown', this._onCanvasDown);
    canvas.addEventListener('pointermove', this._onCanvasMove);
    canvas.addEventListener('pointerup', this._onCanvasUp);
    canvas.addEventListener('pointercancel', this._onCanvasUp);
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('pointermove', this._onWindowMove);
    window.addEventListener('pointerup', this._onWindowUp);
    window.addEventListener('pointercancel', this._onWindowUp);
  }

  /** 结构面板按下鼠标时调用，标记这次指针是从面板拖出来的 */
  beginPaletteDrag() {
    this.dragFromPalette = true;
  }

  /** 选中项或旋转状态变化后，刷新幽灵预览 */
  refreshGhost() {
    this._updateGhost();
  }

  _onCanvasDown(ev) {
    // 指针在画布上按下，说明这是画布上的新手势，之前那次"从面板拖出来"的标记已经没意义了
    this.dragFromPalette = false;
    if (ev.button !== 0) return;
    const cell = this.app.renderer.cellFromPoint(ev.clientX, ev.clientY);
    if (!cell) return;

    // Shift + 拖拽 = 框选，优先级最高
    if (ev.shiftKey) {
      this.marqueeDrag = true;
      this.app.setMarquee({ x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y });
      this._capture(ev);
      return;
    }

    // 已经框了一块时，点一下先把框收掉、不落笔。操作条就浮在棋盘上，
    // 用户点棋盘多半就是想把它关掉；顺带避免误画。
    if (this.app.marquee) {
      this.app.setMarquee(null);
      return;
    }

    const placement = this.app.getPlacement();
    if (placement) {
      this._place(cell, placement);
      return;
    }

    // 手绘：这一笔是画还是擦在按下时就定死，避免拖到中途来回抖动。
    // auto 模式看按下那一格的死活（老行为）；画笔 / 橡皮则由用户显式指定。
    const mode = this.app.getPaintMode();
    this.painting = mode === 'draw' ? 1 : mode === 'erase' ? 0 : this.app.board.get(cell.x, cell.y) ? 0 : 1;
    this.app.pushUndo();
    this.lastCell = cell;
    this._paintCell(cell);
    this._capture(ev);
  }

  _onCanvasMove(ev) {
    if (this.marqueeDrag) {
      // 拖出棋盘外时夹到边界，别把整个拖拽丢掉
      const cell = this.app.renderer.cellFromPointClamped(ev.clientX, ev.clientY);
      this.app.setMarquee({ ...this.app.marquee, x1: cell.x, y1: cell.y });
      return;
    }
    if (this.painting === null) return;
    const cell = this.app.renderer.cellFromPoint(ev.clientX, ev.clientY);
    if (!cell) return;
    this._paintLine(this.lastCell, cell);
    this.lastCell = cell;
  }

  _onCanvasUp(ev) {
    if (this.marqueeDrag) {
      this._finishMarquee();
      return;
    }
    if (this.painting !== null) {
      this.painting = null;
      this.lastCell = null;
      return;
    }
    // 从面板拖过来、在棋盘上松手 -> 落子
    if (this.dragFromPalette) {
      this.dragFromPalette = false;
      const placement = this.app.getPlacement();
      const cell = this.app.renderer.cellFromPoint(ev.clientX, ev.clientY);
      if (placement && cell) this._place(cell, placement);
    }
  }

  _onWindowMove(ev) {
    this.pointer = { x: ev.clientX, y: ev.clientY };
    this._updateGhost();
  }

  _onWindowUp() {
    this.dragFromPalette = false;
    // 指针在画布外松开（捕获失败时走这条路），框选也要收尾
    if (this.marqueeDrag) this._finishMarquee();
  }

  /** 框选收尾：把反向拖出来的矩形归一化成 x0 <= x1 / y0 <= y1 */
  _finishMarquee() {
    this.marqueeDrag = false;
    const m = this.app.marquee;
    if (!m) return;
    this.app.setMarquee({
      x0: Math.min(m.x0, m.x1),
      y0: Math.min(m.y0, m.y1),
      x1: Math.max(m.x0, m.x1),
      y1: Math.max(m.y0, m.y1),
    });
  }

  /** 捕获指针，拖到画布外面也能继续；合成事件下可能抛错，忽略即可 */
  _capture(ev) {
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* 忽略 */
    }
  }

  _place(cell, placement) {
    const { ox, oy } = placementAnchor(cell, placement);
    this.app.pushUndo();
    this.app.board.stamp(placement.cells, ox, oy);
    this.app.afterEdit();
  }

  _paintLine(from, to) {
    let x0 = from.x;
    let y0 = from.y;
    const x1 = to.x;
    const y1 = to.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    // Bresenham：鼠标移动快的时候会跳格，逐格补上，线才连续
    for (;;) {
      this._paintCell({ x: x0, y: y0 });
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  _paintCell(cell) {
    if (this.app.board.set(cell.x, cell.y, this.painting)) this.app.afterEdit();
  }

  _updateGhost() {
    const placement = this.app.getPlacement();
    if (!placement || !this.pointer) {
      if (this.app.ghost) this.app.setGhost(null);
      return;
    }
    const cell = this.app.renderer.cellFromPoint(this.pointer.x, this.pointer.y);
    if (!cell) {
      if (this.app.ghost) this.app.setGhost(null);
      return;
    }

    const { ox, oy } = placementAnchor(cell, placement);
    const board = this.app.board;
    let fits = true;
    for (let i = 0; i < placement.cells.length; i++) {
      if (!board.inBounds(ox + placement.cells[i][0], oy + placement.cells[i][1])) {
        fits = false;
        break;
      }
    }
    this.app.setGhost({
      cells: placement.cells,
      ox,
      oy,
      width: placement.width,
      height: placement.height,
      wrap: board.wrap,
      valid: board.wrap || fits, // 环绕时不存在"放不下"
      showOutline: fits,
    });
  }
}
