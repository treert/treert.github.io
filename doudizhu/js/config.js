/**
 * 常量与可调参数。**纯数据，不 import 任何东西** —— Worker 会直接加载这个文件，
 * 所以这里绝对不能出现任何 DOM 相关的东西。
 *
 * 凡是有"手感"含义的数字都集中在这里，不要散到逻辑代码的 if 里
 * （与象棋的 `js/config.js` 同一套规矩）。
 */

// === 对局 ===
export const SEATS = 3;
export const HUMAN_SEAT = 0; // 真人固定坐下方的 0 号位（界面层用，状态机不关心）

// === 叫分 ===
export const BID_NONE = 0; // 不叫
export const BID_MIN = 1;
export const BID_MAX = 3;
export const BASE_SCORE = 1; // 底分，固定 1（§5.6）

/**
 * 叫分阈值：`handScore(hand)`（§6.1）折算成 0~3 分。
 *
 * **这组数字是初值，必须用 selfplay 校准**（§5.5、§12 第 4 步）：
 *
 *   - 阈值定太高 → 三家都不叫、频繁流局，这是最差的体验（验收线：流局率 < 5%）
 *   - 阈值定太低 → AI 总当地主，玩家拿不到地主
 *
 * 校准方法：`node doudizhu/tools/selfplay.mjs` 跑几百局，看它打出来的
 * 「流局率」与「三个座位当地主的次数」。当前值对应的典型 17 张手牌的
 * `handScore` 在 8 左右（王 1.3 张、2 1.3 张、A 1.3 张、三张组约 1 组、单张约 5 张）。
 */
export const BID_THRESHOLDS = [
  { score: 1, min: 5.5 },
  { score: 2, min: 9.0 },
  { score: 3, min: 13.0 },
];

/**
 * 叫分噪声相对 `LEVELS[].noise` 的缩放。
 *
 * `noise` 的量纲是评估分（象棋的评估函数也是这个量纲），而 `handScore` 是一个
 * 8 上下的小数，直接加会变成纯随机。除以 20 之后：入门 ±7.5（约等于乱叫）、
 * 初级 ±4、中级 ±1、高级 0。
 *
 * 噪声是**双向**的（对称均匀），不能偏到"倾向不叫"那边 —— 否则弱挡位会把流局率拉爆。
 */
export const BID_NOISE_SCALE = 20;

// === AI 挡位（§7.5）===
//
// 四个挡位的**定性差异只有三条**：配不配合队友（cooperate）、猜不猜对手的牌（samples）、
// 要不要搜索（searchDepth）。其余三个是手感参数。
//
// 弱挡位的 `noise` / `blunderRate` 与象棋同义：评分扰动 / 按概率故意走次优着。
// **只剩一个合法着法时不触发**（否则会走出非法着法）。
//
// thinkMs 是硬上限，与象棋一致（1.5 秒封顶，思考期间主线程禁用操作、不做取消）。
// maxCandidates 是着法候选裁剪 —— **属于策略，不属于规则**（§5.3），
// 规则层永远给完整集合。
//
// samples / searchDepth / innerWidth 是 PIMC 的三个参数（§7.2、§7.3）：
//   samples     —— 采样几个"可能的世界"。1 = 完全不猜牌，等价于按平均分布估
//   searchDepth —— 根着法走完之后再搜几层。0 = 直接对走完的局面估值
//   innerWidth  —— 搜索里**每个节点只展开几个着法**。首出时一手可能有 350+ 个候选，
//                  全展开在深度 2 上要几万次着法生成，实测跑不动（见 future-work 的 D 节）
//
// 这套数字是拿 `tools/selfplay.mjs` 的耗时与胜率一起调的，不是拍的。
export const LEVELS = [
  { id: 'novice', name: '入门', cooperate: false, samples: 1, searchDepth: 0, innerWidth: 0, maxCandidates: 12, thinkMs: 200, noise: 150, blunderRate: 0.35 },
  { id: 'easy', name: '初级', cooperate: false, samples: 1, searchDepth: 0, innerWidth: 0, maxCandidates: 24, thinkMs: 400, noise: 80, blunderRate: 0.15 },
  { id: 'medium', name: '中级', cooperate: true, samples: 20, searchDepth: 1, innerWidth: 3, maxCandidates: 48, thinkMs: 1000, noise: 8, blunderRate: 0.01 },
  { id: 'hard', name: '高级', cooperate: true, samples: 32, searchDepth: 1, innerWidth: 4, maxCandidates: 96, thinkMs: 1500, noise: 0, blunderRate: 0 },
];

export const DEFAULT_LEVEL = 'medium';

export function findLevel(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[2];
}

// === 存档 ===
export const STORAGE_KEY = 'doudizhu:state';
export const STATS_KEY = 'doudizhu:stats';
export const STORAGE_VERSION = 1;
