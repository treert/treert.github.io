# 中国象棋模块 · 工具与测试

全部用 Node 直接跑，不需要浏览器、不需要装依赖：

| 命令 | 作用 |
|------|------|
| `node chinese-chess/tools/test-rules.mjs` | 规则引擎：着法生成、攻击判定、合法性、终局 |
| `node chinese-chess/tools/test-notation.mjs` | 中文记谱 |
| `node chinese-chess/tools/test-engine.mjs` | AI 层：哈希、评估与相位插值、搜索、将军延伸、连将杀探测、挡位弱化、循环规则（长将）、开局库接线、开局回归 |
| `node chinese-chess/tools/test-openings.mjs` | 开局库数据：每条线从标准开局逐步重放、逐手合法、走子方正确、索引不多不少 |
| `node chinese-chess/tools/test-game.mjs` | 对局状态机：悔棋、复盘跳转、截断、存档容错 |
| `node chinese-chess/tools/test-custom-endgames.mjs` | 自定义局面：FEN 入库校验、增删、损坏数据容错 |
| `node chinese-chess/tools/test-share.mjs` | 分享链接：编解码、往返、坏参数 |
| `node chinese-chess/tools/test-solution-book.mjs` | 谱载解法查表：每条解法逐步命中、走岔后查不到、重复局面不串 |
| `node chinese-chess/tools/selfplay.mjs [红挡位] [黑挡位] [上限]` | 端到端自对弈冒烟 |
| `node chinese-chess/tools/verify-endgames.mjs` | 残局库校验：局面合法性、字段规范、子力一致性 |
| `node chinese-chess/tools/verify-solutions.mjs` | 残局解法校验：逐步合法、末局将死、长度与 mate 对得上（**不需要引擎**） |
| `node chinese-chess/tools/gen-solutions.mjs` | 残局解法生成：`fast` / `slow` / `emit` / `issues`（**需要本地有 Pikafish**，用法见文件头） |
| `node chinese-chess/tools/gen-openings.mjs` | 开局谱生成：`grow`（可分批，`--budget-ms`）/ `emit` / `report`，产出 `js/openings-generated.js`（**需要本地有 Pikafish**，用法与参数见文件头） |
| `node chinese-chess/tools/gen-pst.mjs` | 位置表 / 评估蒸馏：`snapshot` / `sample` / `fit` / **`nn`**（训一个小网络，`--hidden 32 --lr 0.0003 --l2 0.1`）/ `agree`（ρ 体检；**会自动把 `tmp/nn-*.json` 一起体检**）。`agree` 比较 ρ 时**必须 `--threads 1` 且同一次运行内比** —— 基线随 Pikafish 线程数漂 ±0.05。**试过两轮，结论都是没换成**（详见文件头、`future-work.md` C1 与 `decisions.md` 第 36 条） |
| `node chinese-chess/tools/strength.mjs` | **棋力尺子**：拿 Pikafish 当裁判量「平均损失 / 中位数 / 漏着率」，**按局面集分组报**，回归集另外逐条列出「改主意了吗」。`--set opening,middlegame,endgame,regression`（或 `all`，默认 `opening,regression`）、`--tactical` 只看有吃子的开局局面、`--no-null` / `--no-mobility` 做对照。判评估 / 搜索改动好不好用它，别看感觉（**需要本地有 Pikafish**） |
| `node chinese-chess/tools/move-diff.mjs` | **着法对照**：固定深度（noise 0、无连杀探测 ⇒ **完全可复现**）跑两遍，比「**换了哪几步棋**」；`--judge` 再**只在不同的那几个局面上**让 Pikafish 定向判分。尺子自己的抖动就有几个 cp，小幅改动它分辨不出来 —— 先用它筛（`dump` / `compare`）。判据怎么用见 `decisions.md` 第 21 条（**`--judge` 需要本地有 Pikafish**） |
| `node chinese-chess/tools/eval-compare.mjs` | **配置对照**：把若干组**评估参数**各走一遍（固定深度 ⇒ 完全确定），逐局面算损失并做**配对对照**（胜/平/负）。裁判评分按 `(局面, 着法)` 缓存（默认落 `tmp/eval-cache.json`），所以扫一组配置很便宜。`--configs "mobility=3/2/3,mobility=0/0/0"` / `"piece=200/200/400/900/450/100"`。**读法与两条陷阱（固定深度必须在 ≥2 个深度上复核）写在文件头**（**需要本地有 Pikafish**） |
| `node chinese-chess/tools/convert-test.mjs` | **定式转换测试**：拿 `js/endgames.js` 里**结果已知**的残局（`--category practical` / `composed-endgame`），让模块**自己走到终局**，看它赢了没有 / 和住了没有 —— **不用裁判、结果是二值**，专抓「赢棋走和 / 和棋走输」这类被 cp 均值平均掉的毛病。`--defender pf:12`（默认）或 `self`；`--depth` 固定深度即**可复现**（默认用挡位的时间预算，每次会不一样）（**防守方用 Pikafish 时需要本地有它**） |
| `node chinese-chess/tools/strength-positions.mjs` | **局面集：数据 + 取法**（中局 100 + 残局 40 + 回归 5 个冻结局面；`opening` 那组由生成谱现扫，最多 124 个。`--set all --n 300` 共 269 个）。它同时导出三把仪器**共用**的取局面入口 `strengthPositions()` —— 取法只留这一份，否则两边跑的局面不一样、结果没法比。怎么采的、为什么不能手改，写在文件头 |
| `node chinese-chess/tools/prefix-scan.mjs` | 参考线生成 / 对照：`gen`（`--playout` 走成完整线）/ `promote`（规则层复核）/ `compare`（与已知线逐点对照）/ `emit` |
| `node chinese-chess/tools/solve.mjs` | **中控**：把上面两条链路按顺序跑完（校验 → 找杀 → 走到底 → 复核 → 写数据 → 校验 → 清单）。加/改局面跑这一条就够：`--ids <id>` / `--status` / `--dry-run` |

最后十个是**离线工具**：`gen-solutions.mjs` 与 `prefix-scan.mjs` 驱动外部引擎 Pikafish
分别生成 `js/solutions.js`（解法）与 `js/prefixes.js`（参考线），
`gen-openings.mjs` 生成 `js/openings-generated.js`（开局谱），
`gen-pst.mjs` 是**评估蒸馏的尝试**（2026-10-05 试过，没换成，工具留着以后接着试），
`strength.mjs` 是**棋力尺子**（拿 Pikafish 当裁判量「平均损失 / 中位数 / 漏着率」，
**分局面集报** —— 任何评估 / 搜索改动该用它验收，别靠感觉），
`move-diff.mjs` 是它旁边的**着法对照**（固定深度、完全可复现，
回答「这个改动到底换了几步棋」—— 尺子分辨不出来的小改动先用它筛），
`eval-compare.mjs` 是**配置对照**（多组评估参数一次比完 + 逐局面配对 + 判分缓存），
`convert-test.mjs` 是**定式转换测试**（结果已知的残局让模块自己走到终局，
专抓「赢棋走和 / 和棋走输」—— cp 均值看不见的那类毛病），
`solve.mjs` 是残局那两条链路的**中控**（加/改局面只需要跑它），
`verify-solutions.mjs` 用本模块自己的规则层把那份解法数据逐条钉一遍。
另有 `strength-positions.mjs`：**不是命令，是局面集本身**（中局 / 残局 / 回归三组数据
+ 三把仪器共用的取局面入口），它得跟着仓库走，否则两次跑的局面不一样、结果没法比。
引擎与权重不进仓库；生成物是数据，**运行时不需要引擎、也不联网**。
Pikafish 的下载、常用命令、坐标换算，以及「怎么手动验一局」的三个现成配方，
见 [`pikafish.md`](./pikafish.md)。

改着法生成或搜索后，除了跑对应测试，建议再跑一次自对弈。

## 一起看

| 想知道 | 看 |
|--------|-----|
| 测试策略为什么这么定（不钉节点数、冒烟管状态组合） | [`decisions.md`](./decisions.md) 第 7、8 条 |
| 残局数据怎么生成、怎么校验、怎么加一局 | [`endgames.md`](./endgames.md) |
| 开局库的数据格式、索引、怎么加线、怎么重跑生成器 | [`openings.md`](./openings.md) |
| Pikafish 的安装与命令 | [`pikafish.md`](./pikafish.md) |
