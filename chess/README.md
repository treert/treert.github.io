# 国际象棋（chess）

> **当前状态：文档就绪，代码待实现。**
> 本目录现在只有文档。实施步骤在 [`docs/plan.md`](./docs/plan.md)（Task 0~12，逐步可验证），
> 设计依据在 [`docs/design.md`](./docs/design.md)。**代码写完之后**再回来把这份 README 里
> 「玩法」「目录结构」两节改成完成态，并按 `docs/plan.md` Task 12 把它注册到首页。

单机下国际象棋的纯静态页面，是 [`../chinese-chess/`](../chinese-chess/) 的姊妹模块：
同一套分层与工程约束（纯静态、无构建、无依赖），规则层与引擎层重写，状态机与工程骨架照搬。

## 功能（目标）

- 完整规则：易位（含路径不被攻击）、吃过路兵、升变、50 步、三次重复、子力不足、
  将死与**逼和**
- 四挡 AI（入门 / 初级 / 中级 / 高级），自研 JS 引擎，Worker 里跑，不卡界面
- 中文界面 + **SAN** 记谱（`Nf3` / `exd5` / `O-O` / `e8=Q+`），着法列表可点击回看
- 悔棋 / 重做 / 重开 / 翻转 / **单步回看（上一步 / 下一步）** / 提示
- 内置残局库（四类页签）+ **谱载解法**：一部分残局带一条已证明的正解线，AI 按谱应着
- 局面进出：复制 FEN、分享链接、自定义局面（存 / 改名 / 删）
- 深色模式跟随全站（用站点公共的 `../global.css`，不需要额外适配代码）

## 本地预览（实现后）

```bash
python -m http.server 8000     # 打开 http://127.0.0.1:8000/chess/
```

不要用 `file://` 直接打开：ES Module 与 Worker 会被 CORS 拦掉。

## 目录结构（规划）

```
chess/
├── index.html
├── style.css
├── README.md                  ← 本文件
├── docs/
│   ├── design.md              设计文档（决策 + 理由 + 踩过的坑）
│   ├── plan.md                实施计划（Task 0~12，含验证与提交）
│   └── stockfish.md           离线手册：Stockfish + Syzygy 表库，生成残局解法
├── js/
│   ├── config.js              常量、棋子编码、挡位表
│   ├── position.js            局面、FEN、Zobrist、重复签名
│   ├── rules.js               着法生成、合法性、终局判定
│   ├── notation.js            SAN 记谱
│   ├── game.js                对局状态机（moves / cursor / FEN 快照）
│   ├── renderer.js            棋盘 DOM 渲染（按格子 diff + 补间）
│   ├── interaction.js         点击 / 拖拽 / 升变选择
│   ├── engine.js              评估与搜索（纯逻辑，可在 Node 里跑）
│   ├── worker.js              Worker 壳
│   ├── persist.js             localStorage 存档
│   ├── share.js               分享链接编解码
│   ├── endgames.js            内置残局库
│   ├── solutions.js           谱载解法（离线生成物，不要手改）
│   ├── solution-book.js       解法索引与匹配（键带 ply）
│   └── main.js                入口：状态中枢 + 模块装配
└── tools/
    ├── test-rules.mjs         perft（权威基准）+ 逐条规则断言
    ├── test-notation.mjs      SAN
    ├── test-game.mjs          状态机
    ├── test-engine.mjs        引擎（稳定性质 + 对照开关）
    ├── test-share.mjs         分享链接
    ├── verify-endgames.mjs    残局库入库闸门（用本模块规则层逐步复核）
    ├── gen-solutions.mjs      离线用 Stockfish 生成解法线
    └── selfplay.mjs           自对弈冒烟
```

## 几个关键取舍（详细理由见 `docs/design.md`）

| 取舍 | 一句话 |
|------|--------|
| 局面用 `Int8Array(64)` + 每步 FEN 快照 | 64 字节可廉价拷贝；悔棋 / 回看跳转 O(1) |
| 棋子用**内联 SVG**，不用 Unicode ♔♕ | U+265F 会被渲染成 emoji；白棋在浅格上会糊成一片 |
| 规则层自己写，但**用公认 perft 钉死** | 国象有权威基准（20/400/8902/197281/…），规则层能自动验 |
| 引擎自己写，**不引 Stockfish wasm** | 体积、GitHub Pages 上只能单线程、GPL 分发；理由与将来路线见 `docs/stockfish.md` §5 |
| 残局结论**离线用表库证明**，网页只读数据 | Syzygy 3~5 子约 1GB；结论是 DTZ 口径的「可证明」而不是搜索猜的 |
| 重绘按格子 diff、AI 等补间、只有 ±1 步补间 | 三条都是从象棋那边踩坑换来的，照搬结论 |

## 回填给仓库的改动（实现完成后）

按 `AGENTS.md` 的「新增模块」三步收尾：

1. 根 `index.html` 的 `<details class="group">` 里加一张卡片（`./chess/index.html`）；
2. 根 `README.md` 的目录表加一行；
3. 根 `AGENTS.md` 的模块表加一行。

## 已知限制

1. 引擎是自研 JS，棋力有上限（能下过业余爱好者，不承诺对强引擎）。
2. 没有开局库；没有在线表库（残局只覆盖内置库）。
3. 不做 PGN 导入导出、不做棋钟、不做变例树。
4. 锦标赛细则不做：三次重复 / 50 步由本模块自动判和。
5. 移动端不做拖拽（触屏走「点选 → 点目标」），与象棋一致。
