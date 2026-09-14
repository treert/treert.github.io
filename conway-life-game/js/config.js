/**
 * 全局可调参数。想调整默认表现，改这里就行，不用动逻辑代码。
 */
export const CONFIG = {
  // 单个格子的像素尺寸范围。实际尺寸由棋盘大小和可用空间自动推导，再夹到这个区间里。
  cell: {
    min: 2,
    max: 20,
    // 「自适应窗口」预设下，先假定一个格子尺寸，再反推列数/行数
    auto: { desktop: 12, mobile: 8 },
  },

  // 棋盘尺寸预设。id 为 'auto' 时按可用空间反推列数/行数。
  boardPresets: [
    { id: 'small', name: '小', cols: 40, rows: 30 },
    { id: 'medium', name: '中', cols: 80, rows: 60 },
    { id: 'large', name: '大', cols: 160, rows: 120 },
    { id: 'wide', name: '宽屏', cols: 200, rows: 100 },
    { id: 'auto', name: '自适应窗口' },
  ],
  defaultPreset: 'auto',

  // 默认边界模式：false = 硬边界（飞出棋盘的细胞直接消失），true = 环绕（从对面出来）
  defaultWrap: false,

  // 「自适应窗口」时列数/行数的上下限
  boardLimit: { minCols: 20, maxCols: 240, minRows: 15, maxRows: 160 },

  // 画布可用空间：高度取视口高度的比例，并设一个上限
  viewport: { heightRatio: 0.68, maxHeight: 700, minWidth: 240, minHeight: 180 },

  // 随机填充密度
  randomDensity: 0.3,
  densityRange: { min: 5, max: 90 }, // 百分比，给滑杆用

  // 速度档位：每秒演化多少代
  speeds: [1, 2, 5, 10, 20, 60, 200],
  defaultSpeedIndex: 3,
  maxStepsPerFrame: 40, // 单帧最多演化多少代，防止卡顿

  undoLimit: 40,

  /**
   * 画布配色，浅色 / 深色各一套。用哪套由 <html data-theme> 决定（global.js 写在上面）。
   *
   * 这里只管 canvas 自己画的颜色；页面本身的配色在 global.css 和 style.css 里，
   * 那边是 CSS 变量。两处都要改，否则切主题时会出现"页面黑了、棋盘还白着"。
   */
  themes: {
    light: {
      bg: '#ffffff',
      grid: '#e9ecef',
      gridStrong: '#dee2e6',
      // 按细胞年龄着色：索引 0 是刚诞生，越往后越"老"，最后一个颜色用于更老的细胞。
      // 浅色下由浅到深——老细胞最深，对比度最高，稳定结构一眼就能看清。
      age: ['#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#1c7ed6', '#1864ab', '#2d3436'],
      ghost: 'rgba(9, 132, 227, 0.35)',
      ghostBorder: 'rgba(9, 132, 227, 0.85)',
      ghostInvalid: 'rgba(214, 48, 49, 0.3)',
      ghostInvalidBorder: 'rgba(214, 48, 49, 0.85)',
      // 框选区域。刻意用中性色而不是主题蓝：幽灵预览的外框也是蓝的，
      // 两者同时出现（选了结构又框选）时，同色会让人分不清哪个是哪个。
      // 填充要够淡，否则盖住底下的细胞就看不清选了什么。
      marqueeFill: 'rgba(45, 52, 54, 0.09)',
      marqueeBorder: 'rgba(45, 52, 54, 0.8)',
    },
    dark: {
      bg: '#12151b',
      grid: '#212630',
      gridStrong: '#2a303c',
      // 深色下方向反过来：老细胞最亮 = 对比度最高，和浅色下的"最深"是同一个意思。
      // 第一档比浅色下稍微亮一点——暗色屏幕上低对比度的细节更难分辨。
      age: ['#1d5578', '#2a7099', '#3b8bbd', '#54a5d8', '#78bdec', '#a6d8f8', '#d6ecff'],
      ghost: 'rgba(77, 171, 247, 0.4)',
      ghostBorder: 'rgba(77, 171, 247, 0.95)',
      ghostInvalid: 'rgba(255, 107, 107, 0.35)',
      ghostInvalidBorder: 'rgba(255, 107, 107, 0.95)',
      marqueeFill: 'rgba(230, 233, 238, 0.1)',
      marqueeBorder: 'rgba(230, 233, 238, 0.7)',
    },
  },
};
