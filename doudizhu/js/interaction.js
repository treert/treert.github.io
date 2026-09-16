/**
 * 手牌的指针与键盘交互（design.md §9.2、§9.5）。
 *
 * 这里**不持有任何牌类规则**：点一张牌就是问 `app` 该不该切换选中，
 * 「出牌」按钮按下去就是把选中的牌交给 `app`。合法性与原因都在对局层。
 *
 * 手牌是全页面唯一需要精细点击的地方，所以用**事件委托**挂在容器上 —— 手牌每次
 * 重绘都会换掉整批元素，逐个挂监听会漏（象棋那边是同一个做法）。
 */

export function attachInteraction(refs, app) {
  refs.hand.addEventListener('click', (e) => {
    const el = e.target.closest('.ddz-card');
    if (!el || !refs.hand.contains(el)) return;
    const card = Number(el.dataset.card);
    if (!Number.isInteger(card)) return;
    app.onCardClick(card);
  });

  // 按钮
  refs.btnPlay.addEventListener('click', () => app.onPlay());
  refs.btnPass.addEventListener('click', () => app.onPass());
  refs.btnHint.addEventListener('click', () => app.onHint());
  refs.btnTrustBid.addEventListener('click', () => app.onTrustBid());
  refs.btnNew.addEventListener('click', () => app.onNewGame());
  refs.btnAgain.addEventListener('click', () => { refs.resultDialog.close(); app.onNewGame(); });
  refs.btnCloseResult.addEventListener('click', () => refs.resultDialog.close());
  refs.btnBidPass.addEventListener('click', () => app.onBid(0));
  refs.btnBid.forEach((btn, i) => btn.addEventListener('click', () => app.onBid(i + 1)));

  refs.levelSelect.addEventListener('change', () => app.onLevelChange(refs.levelSelect.value));

  // 手牌宽度随容器变，重排要跟上
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => app.onResize(), 120);
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const cards = Array.from(refs.hand.children);
    const idx = cards.indexOf(document.activeElement);

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (cards.length) cards[Math.max(0, idx < 0 ? 0 : idx - 1)].focus();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (cards.length) cards[Math.min(cards.length - 1, idx < 0 ? 0 : idx + 1)].focus();
        break;
      case ' ':
        if (idx >= 0) {
          e.preventDefault();
          app.onCardClick(Number(cards[idx].dataset.card));
        }
        break;
      case 'Enter':
        e.preventDefault();
        app.onPlay();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        app.onPass();
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        app.onHint();
        break;
      case 'Escape':
        if (idx >= 0 || app.selected.size) app.clearSelection();
        break;
      default:
        break;
    }
  });
}
