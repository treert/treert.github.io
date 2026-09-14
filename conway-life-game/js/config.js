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

  // 按细胞年龄着色：索引 0 是刚诞生，越往后越"老"。最后一个颜色用于老细胞。
  ageColors: ['#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#1c7ed6', '#1864ab', '#2d3436'],

  colors: {
    bg: '#ffffff',
    grid: '#e9ecef',
    gridStrong: '#dee2e6',
    ghost: 'rgba(9, 132, 227, 0.35)',
    ghostBorder: 'rgba(9, 132, 227, 0.85)',
    ghostInvalid: 'rgba(214, 48, 49, 0.3)',
    ghostInvalidBorder: 'rgba(214, 48, 49, 0.85)',
  },
};
