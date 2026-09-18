/**
 * 棋盘上的指针交互：点选 → 点目标走子，鼠标还可以直接拖。
 *
 * 触屏不做拖拽（与象棋、conway-life-game 的处理一致）：触屏上拖拽会和页面滚动打架，
 * 所以走「点选 → 点棋盘」两步。用 Pointer Events 而不是 HTML5 drag-and-drop
 *（后者在触屏上根本不工作）。
 *
 * 这里不持有任何棋类规则：选中状态、合法目标、走子全都问 app。
 * 也不做拖拽残影 —— 棋子本身会跟着手指走的那套在 8×8 小棋盘上收益很小，复杂度不低。
 */

export function attachInteraction(boardEl, app) {
  let dragFrom = -1;

  boardEl.addEventListener('click', (e) => {
    const idx = app.cellIndexOf(e.target);
    if (idx >= 0) app.onCellClick(idx);
  });

  boardEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return; // 触屏走两步点选
    const idx = app.cellIndexOf(e.target);
    if (idx < 0) return;
    if (!app.canAct()) return;
    // 只有「按在自己的棋子上」才算拖拽起手；按在目标格上是普通点击
    if (app.ownerOf(idx) !== app.sideToMove || app.isTarget(idx)) return;

    dragFrom = idx;
    app.onCellClick(idx); // 顺便选中，拖动过程中就能看到合法目标
    e.preventDefault();
  });

  // 拖拽的落点必须在 window 上监听：从格子里拖到外面松手时，
  // boardEl 收不到 pointerup，拖拽状态会卡住
  window.addEventListener('pointerup', (e) => {
    if (dragFrom < 0) return;
    const from = dragFrom;
    dragFrom = -1;
    if (e.pointerType !== 'mouse') return;

    // pointerdown 和 pointerup 在不同元素上时，click 事件会在它们的共同祖先
    //（也就是棋盘）上触发、拿不到具体格子，所以这里自己找落点
    const node = document.elementFromPoint(e.clientX, e.clientY);
    const idx = app.cellIndexOf(node);
    if (idx >= 0 && idx !== from) app.onCellClick(idx);
  });

  // 拖到一半按下 Esc 也要能取消
  window.addEventListener('pointercancel', () => { dragFrom = -1; });
}
