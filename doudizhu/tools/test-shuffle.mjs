/**
 * 洗牌的随机性检验。
 *
 * 跑法：node doudizhu/tools/test-shuffle.mjs [局数，默认 200000]
 *
 * 为什么单独有这个文件：`test-cards.mjs` 只断言了「同一个种子发同一副牌、
 * 不同种子发不同牌」—— 那只证明**可复现**，不证明**均匀**。
 * 一个把 54 张牌按固定顺序排好、只在最后交换两张的"洗牌"也能通过那两个断言。
 *
 * 这里做四件事：
 *
 *   1. **单卡落桶的边际分布**（χ² 检验）：每张牌进 手0 / 手1 / 手2 / 底牌 的概率
 *   2. **两两联合分布**：两张特定的牌同时落在同一家手里的概率，比边际更严
 *   3. **PRNG 本身**：输出均匀性、序列相关、种子雪崩
 *   4. **种子覆盖**：不同种子覆盖多少不同的牌局
 *
 * **阈值故意放宽**（χ²/df 落在 0.85~1.15 就算过），因为这是统计检验：
 * 卡在临界值上的测试会以百分之几的概率随机变红，那比没有测试更糟
 * （象棋那边"不钉随机器波动的量"是同一条教训）。
 * 所有实际数值都会打出来 —— **要看的是那些数字，不是那个 ✓**。
 */

import { mulberry32, deal, shuffle, fullDeck, DECK_SIZE, rankOf } from '../js/cards.js';

const GAMES = Number(process.argv[2]) || 200000;

let passed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function eq(got, want, msg) {
  if (Object.is(got, want)) passed++;
  else failures.push(`${msg}\n    期望 ${JSON.stringify(want)}\n    实际 ${JSON.stringify(got)}`);
}

/**
 * χ² 的合理区间：`df ± k·sqrt(2·df)`。
 *
 * χ² 统计量本身是个随机变量（均值 df、标准差 `sqrt(2·df)`），
 * 所以**阈值必须随 df 缩放**。写死成"比值落在 0.9~1.1"这种规矩，
 * 在 df 小的时候（比如 15）会以百分之几的概率随机变红 ——
 * 那是比没有测试更糟的东西（象棋那条"不钉随机器波动的量"的教训）。
 *
 * `k = 4`（约 4 个标准差）→ 假红概率约万分之一。
 */
function chi2InRange(chi2, df, k = 4) {
  const sd = Math.sqrt(2 * df);
  return Math.abs(chi2 - df) <= k * sd;
}

/** 与 `main.js` 里造种子的方式完全一致 —— 检验的必须是线上真正走的那条路 */
function seedLike() {
  return ((Math.random() * 0x7fffffff) | 0) || 1;
}

// ─────────────────────────────────────────────
// 1. 单卡落桶的边际分布（χ²）
// ─────────────────────────────────────────────

{
  const BUCKETS = 4; // 0/1/2 = 三家手牌，3 = 底牌
  const hits = Array.from({ length: DECK_SIZE }, () => new Array(BUCKETS).fill(0));
  const share = [17 / 54, 17 / 54, 17 / 54, 3 / 54];

  for (let i = 0; i < GAMES; i++) {
    const { hands, trump } = deal(mulberry32(seedLike()));
    for (let s = 0; s < 3; s++) for (const c of hands[s]) hits[c][s]++;
    for (const c of trump) hits[c][3]++;
  }

  let chi2 = 0;
  for (let c = 0; c < DECK_SIZE; c++) {
    for (let b = 0; b < BUCKETS; b++) {
      const e = share[b] * GAMES;
      const d = hits[c][b] - e;
      chi2 += (d * d) / e;
    }
  }
  const df = DECK_SIZE * (BUCKETS - 1);
  const ratio = chi2 / df;

  // 每张牌落进每个桶的次数都该在期望附近；报出最离谱的那一格
  let worstCell = null;
  for (let c = 0; c < DECK_SIZE; c++) {
    for (let b = 0; b < BUCKETS; b++) {
      const e = share[b] * GAMES;
      const z = (hits[c][b] - e) / Math.sqrt(e * (1 - share[b]));
      if (!worstCell || Math.abs(z) > Math.abs(worstCell.z)) worstCell = { c, b, z };
    }
  }

  console.log(`单卡落桶：χ² = ${chi2.toFixed(1)}（df=${df}，理想值 ${df}），χ²/df = ${ratio.toFixed(4)}`);
  console.log(`  最偏离的一格：牌 ${worstCell.c}（rank=${rankOf(worstCell.c)}）进桶 ${worstCell.b}，`
    + `偏离 ${worstCell.z.toFixed(2)} 个标准差（216 格里最大的一格，正常也在 3 上下）`);
  ok(chi2InRange(chi2, df), `单卡落桶分布不均匀：χ² = ${chi2.toFixed(1)}，df = ${df}`);
  ok(Math.abs(worstCell.z) < 6, `有单格偏离超过 6 个标准差（z=${worstCell.z.toFixed(2)}）`);

  // 副检验：三家手牌的**点数之和**应当没有系统性差异。这是"牌力是否均等"的直接读数，
  // 比 χ² 更接近玩家的真实感受（发牌偏了最先被感知到的就是"总有人牌特别好"）
  const sum = [0, 0, 0];
  const sample = Math.min(GAMES, 20000);
  for (let i = 0; i < sample; i++) {
    const { hands } = deal(mulberry32(seedLike()));
    for (let s = 0; s < 3; s++) for (const c of hands[s]) sum[s] += rankOf(c);
  }
  const avg = sum.map((x) => x / sample);
  const spread = Math.max(...avg) - Math.min(...avg);
  // 每家平均点数之和的标准差约 0.11（单家点数和 sd≈15，除以 sqrt(20000)），
  // 三家极差的标准差约 0.15 —— 所以阈值放到 0.8（约 5σ）
  console.log(`  三家平均点数之和：${avg.map((x) => x.toFixed(3)).join(' / ')}`
    + `（极差 ${spread.toFixed(3)}，噪声量级约 0.15）`);
  ok(spread < 0.8, `三家平均牌力有明显差异（极差 ${spread.toFixed(3)}）`);
}

// ─────────────────────────────────────────────
// 2. 两两联合分布：两张特定的牌同时落在同一家
// ─────────────────────────────────────────────

{
  const N = Math.min(GAMES, 100000);
  // 双王同时落在**某一家**手里的概率。
  // 均匀随机划分下 P(两张都在座位 s 手里) = (17/54)·(16/53)，三个座位相加要再乘 3。
  // （第一版这里漏了乘 3，于是"实测比理论高 206 个标准差"——
  //   看着像洗牌坏了，其实是期望值算错了。见 future-work 的 E 节。）
  const perSeat = (17 / 54) * (16 / 53);
  const expect = 3 * perSeat;
  const expectTrump = (3 / 54) * (2 / 53);

  let both = 0;
  let bothTrump = 0;
  for (let i = 0; i < N; i++) {
    const { hands, trump } = deal(mulberry32(seedLike()));
    for (let s = 0; s < 3; s++) {
      if (hands[s].includes(52) && hands[s].includes(53)) both++;
    }
    if (trump.includes(52) && trump.includes(53)) bothTrump++;
  }
  const p1 = both / N;
  const p2 = bothTrump / N;
  const z1 = (p1 - expect) / Math.sqrt(expect * (1 - expect) / N);
  const z2 = (p2 - expectTrump) / Math.sqrt(expectTrump * (1 - expectTrump) / N);

  console.log(`双王同手：实测 ${p1.toFixed(5)}，理论 ${expect.toFixed(5)}（${z1.toFixed(2)} σ）`);
  console.log(`  双王同底牌：实测 ${p2.toFixed(6)}，理论 ${expectTrump.toFixed(6)}（${z2.toFixed(2)} σ）`);
  ok(Math.abs(z1) < 4, `双王同手的概率偏离理论值（${z1.toFixed(2)} σ）`);
  ok(Math.abs(z2) < 4, `双王同底牌的概率偏离理论值（${z2.toFixed(2)} σ）`);
}

// ─────────────────────────────────────────────
// 3. PRNG 本身：均匀性、序列相关、种子雪崩
// ─────────────────────────────────────────────

{
  const rng = mulberry32(12345);
  const BINS = 64;
  const bins = new Array(BINS).fill(0);
  const N = 1_000_000;
  let prev = rng();
  let sum = prev;
  let sumPairs = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const x = rng();
    bins[Math.min(BINS - 1, Math.floor(x * BINS))]++;
    sum += x;
    sumSq += x * x;
    sumPairs += prev * x;
    prev = x;
  }
  const mean = sum / (N + 1);
  const variance = sumSq / N - mean * mean;
  const corr = (sumPairs / N - mean * mean) / variance;

  let chi2 = 0;
  const e = N / BINS;
  for (const b of bins) chi2 += ((b - e) * (b - e)) / e;
  const ratio = chi2 / (BINS - 1);

  console.log(`mulberry32：均值 ${mean.toFixed(5)}（理想 0.5）、`
    + `方差 ${variance.toFixed(5)}（理想 0.0833）`);
  console.log(`  ${BINS} 桶：χ² = ${chi2.toFixed(1)}（df=${BINS - 1}），χ²/df = ${ratio.toFixed(4)}；`
    + `相邻输出相关系数 = ${corr.toFixed(5)}（理想 0）`);
  ok(Math.abs(mean - 0.5) < 0.002, `mulberry32 均值偏了：${mean}`);
  ok(Math.abs(variance - 1 / 12) < 0.002, `mulberry32 方差偏了：${variance}`);
  ok(chi2InRange(chi2, BINS - 1), `mulberry32 分桶不均匀：χ² = ${chi2.toFixed(1)}，df = ${BINS - 1}`);
  ok(Math.abs(corr) < 0.005, `mulberry32 相邻输出有相关：${corr}`);

  // 种子雪崩：相邻种子给出的**排列**应当几乎完全不同。
  //
  // 必须比 `shuffle()` 的原始输出，不能比 `deal()` 的结果 —— `deal` 会把
  // 三家的手牌各自排序，"第 i 个位置的牌"就不再是均匀的了
  // （最小的那张牌经常就是牌 0，两个独立排列在第 0 位相同的概率高达 10%）。
  // 第一版就是比了 `deal()` 的输出，于是量出一个看起来偏低、其实完全正常的 49.9。
  const rand = () => mulberry32(seedLike());
  let diff = 0;
  let worst = DECK_SIZE;
  const TRIALS = 500;
  for (let s = 0; s < TRIALS; s++) {
    const a = shuffle(fullDeck(), rand());
    const b = shuffle(fullDeck(), rand());
    let d = 0;
    for (let i = 0; i < DECK_SIZE; i++) if (a[i] !== b[i]) d++;
    diff += d;
    if (d < worst) worst = d;
  }
  const avgDiff = diff / TRIALS;
  console.log(`  两个随机种子的排列：平均 ${avgDiff.toFixed(2)} / 54 个位置不同`
    + `（独立排列理论值 53.0，最少的那个种子对差了 ${worst} 位）`);
  ok(avgDiff > 50, `不同种子给出的排列太接近（平均只差 ${avgDiff.toFixed(2)} 位）`);
}

// ─────────────────────────────────────────────
// 4. 种子覆盖：不能"一堆种子发出有限的几副牌"
// ─────────────────────────────────────────────

{
  const N = 50000;
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const { hands, trump } = deal(mulberry32(seedLike()));
    seen.add([...hands[0], ...hands[1], ...hands[2], ...trump].join(','));
  }
  console.log(`种子覆盖：${N} 局里出现了 ${seen.size} 种不同的牌局`
    + `（占比 ${((seen.size / N) * 100).toFixed(2)}%）`);
  ok(seen.size / N > 0.999, `同一牌局被重复发出来太多次：只有 ${seen.size} 种`);

  // 同一个种子必须给同一副（"可复现"这一半，前面 test-cards 也钉了，这里留一份便宜的）
  eq(JSON.stringify(deal(mulberry32(777))), JSON.stringify(deal(mulberry32(777))),
    '同一个种子必须发同一局牌');
  // 种子 0 是个常见的边界（main.js 用 `|| 1` 兜住它，这里确认一下兜得对）
  const zero = deal(mulberry32(0));
  const one = deal(mulberry32(1));
  ok(JSON.stringify(zero) !== JSON.stringify(one), '种子 0 和 1 必须发出不同的牌');
}

// === 收尾 ===
console.log(`test-shuffle: ${passed} 条通过，${failures.length} 条失败`);
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
