# Conway 生命游戏（网页版）

Conway's Game of Life 的浏览器演示。纯静态 HTML + CSS + JS，无构建工具、无框架、无第三方依赖。

## 本地运行

用了 ES Module，**不能直接双击 `index.html`**（`file://` 下会被 CORS 拦掉）。起个静态服务即可：

```bash
cd treert.github.io
python -m http.server 8000
# 打开 http://127.0.0.1:8000/conway-life-game/
```

部署在 GitHub Pages 上是 HTTP 服务，不受影响。

## 目录结构

```
conway-life-game/
├── index.html                页面骨架，只放 DOM，逻辑全在 js/
├── style.css                 页面样式，复用 ../global.css 的 CSS 变量
├── README.md                 本文件
├── js/
│   ├── main.js               入口：状态中枢 + 模块装配 + 工具栏与快捷键绑定
│   ├── config.js             所有可调参数（预设尺寸、速度档位、配色、撤销深度…）
│   ├── board.js              网格 + 演化规则。纯逻辑，不碰 DOM
│   ├── renderer.js           Canvas 绘制：年龄着色 / 网格线 / 幽灵预览
│   ├── patterns.js           经典结构库数据（唯一需要手工维护的数据文件）
│   ├── life-format.js        Life 1.06 格式的解析与生成。纯逻辑
│   ├── palette.js            结构面板 UI（缩略图、分类、选中、拖拽源）
│   ├── interaction.js        棋盘上的指针交互（放置 / 拖拽 / 手绘 / 旋转翻转）
│   └── simulator.js          播放循环（rAF + 时间累加器）
└── tools/                    开发工具，不参与网页运行，见「工具与测试」
```

## 架构

**状态集中在 `main.js`。** 它持有唯一的 `state` 对象和 `app` 上下文，其他模块之间不互相 import，
统一通过 `app` 上的回调协作，避免依赖成网：

```js
app = {
  board,               // Board 实例
  renderer,            // Renderer 实例
  ghost,               // 当前幽灵预览数据
  getPlacement(),      // 当前选中的结构（含旋转翻转后的结果，带缓存）
  setGhost(g),         // 更新幽灵预览
  pushUndo(),          // 记录撤销点
  afterEdit(),         // 编辑后刷新（重绘 + 更新统计）
}
```

**重绘是 rAF 合并的。** 所有绘制都走 `requestDraw()`，一帧只真正画一次，所以调用方可以随便调、
不用自己节流。统计数字在播放时额外做了 120ms 的节流，避免每帧写 DOM。

**播放速度与刷新率解耦。** `simulator.js` 用时间累加器把「每秒多少代」换算成每帧该跑几代，
所以在 60Hz 和 144Hz 屏上速度一致；单帧代数有上限（`config.maxStepsPerFrame`），大棋盘不会卡死页面。

**数据流**：用户操作 → `interaction.js` / 工具栏 → 改 `app.board` → `afterEdit()` → `requestDraw()`
→ `renderer.draw(board, ghost)`。模拟循环同理，只是由 `simulator.js` 驱动 `board.step()`。

## 关键设计决策

1. **稠密数组，不用稀疏结构。**
   `tmp/conway_life_game.cpp` 里那版用有序稀疏 cell 列表，是因为坐标域是 `INT64_MIN..INT64_MAX`。
   网页版棋盘有限，用 `Uint8Array` 双缓冲全量重算简单得多，也不用维护「必须有序去重」这类不变量。
   240×160 的最大棋盘约 6200 代/秒，远超需要。

2. **邻居下标表，而不是逐格判断边界。**
   `board.js` 的 `step()` 会先建两张表：`left/right` 按列下标、`up/down` 按行首下标。
   硬边界填 `-1`（表示「这一侧没有邻居」），环绕填取模值，两条路径共用同一份内层循环。
   表只在棋盘尺寸或边界模式变化时惰性重建。

3. **坐标约定：`x` 向右为列，`y` 向下为行。** 与屏幕一致，也与 Life 1.06 一致。
   注意 C++ 版也是这个约定，两边能直接对接。

4. **渲染：1 像素 1 格 + 放大。**
   先把整个棋盘画进一张 `cols × rows` 的离屏 canvas，再 `drawImage` 放大到主画布（关平滑），
   最后叠网格线和幽灵预览。每帧绘制量只跟格子数有关，跟格子显示多大无关。

5. **撤销用快照，不用反向操作。** `board.snapshot()` 拷贝 `cells` 和 `age`。
   棋盘小，几十 KB 一份、留 40 份成本可以忽略，比实现每种操作的反向逻辑可靠得多。

6. **触屏不做拖拽。** 结构面板上的拖拽只在鼠标下启用（`pointerType === 'mouse'`），
   触屏走「点选 → 点棋盘」两步，否则会和面板滚动打架。统一用 Pointer Events，
   不用 HTML5 drag-and-drop（后者在触屏上根本不工作）。

7. **结构数据是唯一的「手工维护点」。** `patterns.js` 里全部是相对坐标数组，
   模块加载时统一归一化到包围盒左上角并补上 `width/height`，加结构时不用自己算。

## 常见改动

### 加一个经典结构

1. 在 `js/patterns.js` 的 `RAW` 数组里加一项。`cells` 是相对坐标数组，注释里照着画上 ASCII 图形：

   ```js
   {
     id: 'my-pattern',
     name: '我的结构',
     category: 'oscillator',   // still-life | oscillator | spaceship | gun | methuselah
     period: 2,                // 可选，会被校验
     classic: true,            // 可选，加上后会出现在「初始内容」下拉里
     // .OO
     // OO.
     cells: [[1, 0], [2, 0], [0, 1], [1, 1]],
   }
   ```

2. 跑 `node conway-life-game/tools/verify-patterns.mjs` 校验。它会检查尺寸声明、周期，
   还会核对 `category` 和实测行为是否一致——坐标抄错时通常能立刻发现。

3. 拿不准形状时，先用 `--grid` 模式把 ASCII 图喂进去试：

   ```powershell
   $g = ".O..O`nO....`nO...O`nOOOO." ; $g | node conway-life-game/tools/verify-patterns.mjs --grid
   ```

   （PowerShell 管道会给输入插 BOM，工具里已经处理了。这个坑在 C++ 版的注释里也记过。）

### 调整默认表现

改 `js/config.js`：预设棋盘尺寸、格子尺寸上下限、速度档位、随机密度、按年龄的配色、撤销深度等。

### 加一个工具栏按钮

`index.html` 加元素 → `js/main.js` 顶部的 `dom` 加引用 → `bindEvents()` 里绑定 → `style.css` 加样式。

## 工具与测试

全部用 Node 直接跑，不需要浏览器、不需要装依赖，从任何工作目录都能执行：

| 命令 | 作用 |
|------|------|
| `node conway-life-game/tools/verify-patterns.mjs` | 校验结构库（20 个结构），有问题时以非 0 退出码结束 |
| `node conway-life-game/tools/test-board.mjs` | 棋盘边界模式单测：内部演化一致性、环绕落子、跨接缝邻居、邻居表重建 |
| `node conway-life-game/tools/test-life-format.mjs` | Life 1.06 读写单测：往返一致、BOM/CRLF 容错、各类坏输入 |
| `node conway-life-game/tools/bench-board.mjs` | 演化性能基准（30% 随机填充，最坏情况） |

改动 `board.js`、`life-format.js` 或 `patterns.js` 后，建议把对应的脚本跑一遍。

## 功能说明

### 棋盘与边界

- **棋盘尺寸**：小 / 中 / 大 / 宽屏 / 自适应窗口。格子像素尺寸由棋盘大小和可用空间自动推导，
  不单独提供缩放（硬边界下棋盘默认整块可见，够用）。
- **边界模式**：`环绕边界` 开关，快捷键 `W`。
  - 关闭（默认）：硬边界，飞出棋盘的细胞直接消失。
  - 开启：torus，从对面出来。**落子也环绕**，贴边放结构不会被悄悄裁掉；
    幽灵预览跨接缝时显示成「两边各一半」，且不画外框（否则框的位置会误导）。

### 结构库

分五类：静物 7、振荡器 5、飞船 4、枪 1、长寿者 3，共 20 个。

- **放置**：点选结构 → 点击棋盘落子；或直接把结构从面板拖到棋盘上松手。
- **变换**：`R` 旋转 90°、`H` 水平翻转、`V` 垂直翻转、`Esc` 取消选择。
- **手绘**：不选结构时，在棋盘上按住拖动即可画 / 擦细胞（按下的那一格决定这一笔是画还是擦）。

### Life 1.06 导入导出

`js/life-format.js` 只处理纯格式，**刻意不往文件里塞任何额外信息**——格式本身没有棋盘尺寸字段，
加注释行会破坏最朴素的解析器（比如 C++ 版那个 `while (is >> x >> y)`）。

- **导入**三条路径：`导入` 按钮选文件、把 `.life` 拖到棋盘上、`Ctrl+V` 粘贴文本。
- **导出**两种方式：`导出` 下载文件、`复制` 复制文本到剪贴板。
- **定位规则**：坐标全部落在当前棋盘内 → 原样保留位置（所以「导出 → 重新导入」能精确还原）；
  超出棋盘 → 整体平移居中，并在状态栏说明。

`tmp/conway_life_game.cpp` 是原始 C++ 实现，两者用同一套格式，做过端到端互通验证。

### 快捷键

| 按键 | 作用 |
|------|------|
| `空格` | 播放 / 暂停 |
| `S` | 单步 |
| `R` | 选中结构顺时针旋转 90° |
| `H` | 选中结构水平翻转 |
| `V` | 选中结构垂直翻转 |
| `W` | 切换环绕边界 |
| `Esc` | 取消当前选中的结构 |
| `Ctrl + Z` | 撤销 |

焦点在输入框 / 下拉框里时不会触发这些快捷键。

## 已知限制

- 没有缩放 / 平移，也没有框选、复制粘贴区域。
- 结构库是相对坐标数组，没有 RLE 解析（需要时再加，`life-format.js` 已经是个可参考的纯解析模块）。
- 移动端结构面板不响应拖拽（见「关键设计决策」第 6 条）。
- `board.step()` 是全量扫描，没有做活跃包围盒裁剪；当前性能足够，需要时再优化
  （`tools/bench-board.mjs` 可以用来留基线）。
