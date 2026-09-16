/**
 * 把「对局状态 + 玩家视角」画成 DOM（design.md §10.2）。
 *
 * 这一层**自己不持有任何牌类规则**：它只读 `app` 上的 view / 选中集合 / 状态文案，
 * 把它们变成元素。和象棋的分工一样 —— 规则在对局层，界面只负责画。
 *
 * 用 DOM 而不是 Canvas 的直接收益（§3.3）：颜色全走 CSS 变量，
 * **不需要监听 themechange**，深色模式自动生效。
 */

import {
  rankOf, suitOf, cardLabel, rankLabel, isJoker,
  RANK_MIN, RANK_JOKER_BIG,
} from './cards.js';
import { comboName } from './combo.js';
import { unseenOf } from './view.js';

export function collectRefs() {
  const id = (x) => document.getElementById(x);
  return {
    levelSelect: id('level-select'),
    btnNew: id('btn-new'),
    foeLeft: id('foe-left'),
    foeRight: id('foe-right'),
    badgeLeft: id('badge-left'),
    badgeRight: id('badge-right'),
    countLeft: id('count-left'),
    countRight: id('count-right'),
    playLeft: id('play-left'),
    playRight: id('play-right'),
    playMine: id('play-mine'),
    trump: id('trump'),
    trumpLabel: id('trump-label'),
    status: id('status-text'),
    note: id('note-text'),
    meter: id('meter'),
    multiplier: id('multiplier'),
    bombCount: id('bomb-count'),
    handWrap: id('hand-wrap'),
    hand: id('hand'),
    actions: id('actions'),
    btnPlay: id('btn-play'),
    btnPass: id('btn-pass'),
    btnHint: id('btn-hint'),
    btnTrustBid: id('btn-trust-bid'),
    btnBidPass: id('btn-bid-pass'),
    btnBid: [id('btn-bid-1'), id('btn-bid-2'), id('btn-bid-3')],
    recorder: id('recorder-body'),
    logPanel: id('log-panel'),
    logBody: id('log-body'),
    resultDialog: id('result-dialog'),
    resultTitle: id('result-title'),
    resultBody: id('result-body'),
    resultStats: id('result-stats'),
    btnCloseResult: id('btn-close-result'),
    btnAgain: id('btn-again'),
  };
}

/** 造一张牌。`small` 用于对手 / 出牌区，正常尺寸用于我的手牌 */
export function cardEl(card, opts = {}) {
  const el = document.createElement(opts.tag || 'div');
  el.className = 'ddz-card';
  if (opts.small) el.classList.add('ddz-card--small');
  if (opts.back) {
    el.classList.add('ddz-card--back');
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  const r = rankOf(card);
  if (isJoker(card)) {
    el.classList.add('ddz-card--joker');
    if (r === RANK_JOKER_BIG) el.classList.add('ddz-card--red');
    const span = document.createElement('span');
    span.className = 'ddz-rank';
    span.textContent = r === RANK_JOKER_BIG ? '大王' : '小王';
    el.appendChild(span);
  } else {
    const suit = suitOf(card);
    if (suit === 1 || suit === 2) el.classList.add('ddz-card--red'); // 红桃 / 方块
    const rank = document.createElement('span');
    rank.className = 'ddz-rank';
    rank.textContent = rankLabel(r);
    const s = document.createElement('span');
    s.className = 'ddz-suit';
    s.textContent = ['♠', '♥', '♦', '♣'][suit];
    el.appendChild(rank);
    el.appendChild(s);
  }

  if (opts.selected) el.classList.add('ddz-card--sel');
  if (opts.card !== undefined) el.dataset.card = String(card);
  el.setAttribute('aria-label', cardLabel(card));
  if (opts.tag === 'button') {
    el.type = 'button';
    el.setAttribute('aria-pressed', opts.selected ? 'true' : 'false');
  }
  return el;
}

function fill(container, nodes) {
  container.textContent = '';
  for (const n of nodes) container.appendChild(n);
}

function passMark() {
  const s = document.createElement('span');
  s.className = 'ddz-pass-mark';
  s.textContent = '不要';
  return s;
}

/**
 * 本墩里每家出的最后一手。
 *
 * 从 history 尾部往前扫，直到遇见本墩首出方的那一手为止 ——
 * 更早的墩与当前这一墩无关，不该继续显示。
 */
export function trickPlays(view) {
  const plays = [null, null, null];
  const passed = [false, false, false];
  if (!view.trick.lastPlay) return { plays, passed };

  for (let i = view.history.length - 1; i >= 0; i--) {
    const h = view.history[i];
    if (h.combo) {
      if (!plays[h.seat]) plays[h.seat] = h.combo;
    } else {
      passed[h.seat] = true;
    }
    // 走到本墩的首出（含）就停
    if (h.combo && h.seat === view.trick.leader) break;
  }
  return { plays, passed };
}

function renderPlayArea(el, combo, didPass, small = true) {
  if (combo) {
    fill(el, combo.cards.map((c) => cardEl(c, { small })));
  } else if (didPass) {
    fill(el, [passMark()]);
  } else {
    fill(el, []);
  }
}

/** 我的手牌。选中集合是「牌号 → true」，与具体哪张牌绑定 */
export function renderHand(refs, app) {
  const view = app.view;
  const nodes = view.myHand.map((card) => cardEl(card, {
    tag: 'button',
    card,
    selected: app.selected.has(card),
  }));
  fill(refs.hand, nodes);
  layoutHand(refs);
}

/**
 * 手牌的自适应重叠。
 *
 * **一屏要能看全 17 张牌** —— 这不是可以妥协的细节：看不到自己的牌就没法玩。
 * 按容器宽度算每一步的间距，最多不超过「牌宽 + 4」，最少不低于 14px
 * （再窄也会露出左上角的点数与花色）。已选中的牌抬高，所以重叠不会遮住选中态。
 */
export function layoutHand(refs) {
  const hand = refs.hand;
  const n = hand.children.length;
  if (n < 2) return;
  const cardW = hand.children[0].offsetWidth || 56;
  const avail = hand.parentElement.clientWidth - 24;
  const step = Math.min(cardW + 4, Math.max(14, (avail - cardW) / (n - 1)));
  hand.style.setProperty('--ddz-step', `${Math.round(step)}px`);
}

function renderFoe(head, badge, count, playEl, player, isTurn, combo, didPass) {
  head.classList.toggle('ddz-foe--turn', isTurn);
  badge.hidden = player.role !== 'landlord';
  count.textContent = player.handCount === 0 ? '出完了' : `${player.handCount} 张`;
  renderPlayArea(playEl, combo, didPass, true);
}

export function renderAll(refs, app) {
  const view = app.view;
  const acting = view.phase === 'bidding' ? app.biddingSeat : view.turn;
  const { plays, passed } = trickPlays(view);

  // 座位 0 是我；1 是下家（右）；2 是上家（左）。
  // 界面上用「上家 / 下家」是因为只有两个对手，不会歧义；
  // **代码里一律用座位号**（相对称呼在 3 个座位上有三种解释，是 bug 的温床，§4.4）。
  const right = view.players[1];
  const left = view.players[2];
  renderFoe(refs.foeRight, refs.badgeRight, refs.countRight, refs.playRight,
    right, acting === 1, plays[1], passed[1]);
  renderFoe(refs.foeLeft, refs.badgeLeft, refs.countLeft, refs.playLeft,
    left, acting === 2, plays[2], passed[2]);

  renderPlayArea(refs.playMine, plays[0], passed[0], true);
  refs.playMine.classList.toggle('ddz-mine-play--turn', acting === 0);

  // 底牌：叫分阶段是 3 张背面（view.trump 为空），定地主后翻开
  if (view.trump.length) {
    refs.trumpLabel.textContent = '底牌';
    fill(refs.trump, view.trump.map((c) => cardEl(c, { small: true })));
  } else {
    refs.trumpLabel.textContent = '底牌（未翻开）';
    fill(refs.trump, [cardEl(0, { small: true, back: true }),
      cardEl(0, { small: true, back: true }), cardEl(0, { small: true, back: true })]);
  }

  refs.status.textContent = app.status;
  refs.note.textContent = app.note || '';
  refs.note.hidden = !app.note;

  if (view.phase === 'playing' || view.phase === 'finished') {
    refs.meter.hidden = false;
    refs.multiplier.textContent = String(app.multiplier);
    refs.bombCount.textContent = String(view.bombs);
  } else {
    refs.meter.hidden = true;
  }

  renderHand(refs, app);
  renderRecorder(refs, view);
  renderLog(refs, app);
}

/**
 * 记牌器（§9.5）。
 *
 * 数据源就是 `unseenOf(view)` —— **和 AI 采样用的是同一个函数**。
 * 显示的是「还没出现过的牌」，也就是任何只看到牌面的观众都能算出来的信息；
 * 它**不显示**对手手里有什么。这个区分是这一块最要紧的事，界面上也写了。
 */
export function renderRecorder(refs, view) {
  const unseen = unseenOf(view);
  const left = new Map();
  for (const c of unseen) {
    const r = rankOf(c);
    left.set(r, (left.get(r) || 0) + 1);
  }

  const rows = [];
  for (let r = RANK_MIN; r <= RANK_JOKER_BIG; r++) {
    const total = r === RANK_JOKER_BIG || r === 16 ? 1 : 4;
    const have = left.get(r) || 0;
    if (have === 0) continue; // 已经全出现了，不用占位置

    const row = document.createElement('div');
    row.className = 'ddz-rank-row';

    const label = document.createElement('span');
    label.textContent = rankLabel(r);
    row.appendChild(label);

    const pips = document.createElement('span');
    pips.className = 'ddz-pips';
    for (let i = 0; i < total; i++) {
      const pip = document.createElement('span');
      pip.className = 'ddz-pip' + (i < have ? ' ddz-pip--on' : '');
      pips.appendChild(pip);
    }
    row.appendChild(pips);
    rows.push(row);
  }

  if (rows.length === 0) {
    const p = document.createElement('div');
    p.className = 'ddz-pass-mark';
    p.textContent = '所有牌都出现过了';
    rows.push(p);
  }
  fill(refs.recorder, rows);
}

function seatName(view, seat) {
  if (seat === view.seat) return '你';
  if (seat === 1) return '下家';
  if (seat === 2) return '上家';
  return `${seat} 号位`;
}

/** 出牌记录：一行一次动作，出牌带上牌型名与张数 */
export function renderLog(refs, app) {
  const view = app.view;
  if (!refs.logBody) return;
  const lines = [];
  for (const h of view.history) {
    const who = seatName(view, h.seat);
    if (h.combo) {
      lines.push(`<b>${who}</b> 出 ${h.combo.length} 张（${comboName(h.combo)}）`);
    } else {
      lines.push(`<b>${who}</b> 不要`);
    }
  }
  refs.logBody.innerHTML = lines.length ? lines.join('<br>') : '还没有出过牌';
}
