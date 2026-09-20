# Pikafish 使用说明（离线工具链）

> 这篇是**给开发与人工核对用的操作手册**，不是运行时的一部分。
> 网页跑起来不碰引擎、也不联网 —— 解法已经固化成 `js/solutions.js`；
> 引擎只在「生成解法 / 复核结论」时用，装在 `tmp/pikafish/`（被 git 忽略，不进仓库）。

## 它是什么

Pikafish（皮卡鱼）是基于 **NNUE 神经网络** 的 UCI 中国象棋引擎，派生自 Stockfish，
棋力远超本模块自带的引擎。两者分工：

| | 本模块引擎（`engine.js`） | Pikafish |
|---|---|---|
| 用在哪 | **运行时**：对弈、提示、挡位弱化 | **只离线**：生成 `js/solutions.js`、复核残局结论 |
| 评估 | 子力 + 兵过河（手写，约 90 行） | NNUE 神经网络（48 MB 权重） |
| 视野 | 1.5 秒约 6 个半层 | 十几回合的连杀在毫秒~秒级解出 |
| 依赖 | 无（浏览器里跑） | 外部二进制 + `pikafish.nnue` |

## 装在哪

1. 下载：<https://github.com/official-pikafish/Pikafish/releases> 的通用二进制包（`.7z`）
   —— 2026-09-06 起是**通用二进制**，不需要再按 CPU 指令集挑。
2. 解压到 `tmp/pikafish/`，**exe 与 `pikafish.nnue` 必须在同一目录**。

```powershell
cd tmp
mkdir pikafish
tar -xf Pikafish.2026-09-06.7z -C pikafish    # Windows 自带的 tar 就能读 7z
```

3. `tools/gen-solutions.mjs` 找引擎的顺序：环境变量 `PIKAFISH` → `tmp/pikafish/Pikafish-Windows-x86-64-universal.exe`。

包里另外三个平台（Linux / macOS / Android）的二进制、以及 `.7z` 安装包本身，在这个项目里用不上，可以删。

## 手动跑起来

**交互式**（推荐，能一条条试）：

```powershell
cd tmp/pikafish
.\Pikafish-Windows-x86-64-universal.exe

uci                                  # 握手：列出一堆 option，最后回 uciok
setoption name Threads value 16      # 本机 32 线程，用 16 就够
setoption name Hash value 2048
isready                              # 回 readyok 才算就绪
position fen C3kab2/4a4/n3c1n2/3Np1p2/1R4P2/1R7/4P4/4B4/1pCp1p3/1crAK1N2 w - - 0 1
go mate 22 movetime 30000
quit
```

> **Windows 上别用 PowerShell 的管道喂命令。**
> `@('uci','quit') | .\Pikafish-...exe` 送进去的是一段带 BOM 的字符串，
> 引擎会回 `Unknown command: '﻿uci'`（这个坑实测踩过）。
> 要么交互式手敲，要么在 `cmd` 里 `(echo uci& echo quit) | Pikafish-...exe`，
> 要么写个 Node 驱动脚本 —— `tools/gen-solutions.mjs` 就是后者。

## 命令速查

| 命令 | 作用 |
|---|---|
| `uci` / `isready` | 握手 / 同步，各自回 `uciok` / `readyok` |
| `setoption name Threads value N` | 搜索线程数 |
| `setoption name Hash value N` | 哈希表大小（MB） |
| `ucinewgame` | 换一局（清哈希）—— 连续跑多局时每局之间要发一次 |
| `position fen <FEN>` | 摆局面 |
| `position fen <FEN> moves e4a4 b9c7` | 摆局面再走几手 |
| `go mate N` | 搜「**红方 N 步**以内的杀」 |
| `go movetime MS` | 固定想 MS 毫秒（**PV 比 `go mate` 完整**，见「坑」一节） |
| `go depth N` / `go nodes N` / `go infinite` + `stop` | 按层数 / 节点数 / 无限搜 |
| `d` | **把当前局面画成 ASCII 棋盘并打印 FEN** —— 核对坐标最快的一招 |
| `eval` | 打印 NNUE 评估明细（每个子的估值 + 网络各层贡献） |
| `bench` | 跑基准并给 NPS，用来确认二进制没问题 |
| `quit` | 退出 |

搜索中的 `info` 行是关键：

```
info depth 10 seldepth 47 multipv 1 score mate 20 nodes 629922 nps 27387913 ... pv b5b9 e8d9 ...
info depth 0 score mate 0
bestmove (none)
```

- `score mate N`：当前轮走方 **N 步**将死（**负数表示自己被杀**）；`score cp X`：只是评估分（X/100 约等于「几个兵」）
- `pv`：主变（后续着法序列）
- `bestmove <着法> ponder <着法>`：最终答案；**`bestmove (none)` 表示这个局面已经终局**（对方一步都走不出）

## 坐标（最容易搞错的地方）

**引擎用 ICCS 坐标**：列 `a`-`i` 从左到右，行 `0`-`9` **从红方底线往上**。
本模块的棋盘是 `x` 向右 `0..8`、`y` **从上往下** `0..9`（`y = 0` 是黑方底线）。换算：

```
x = file - 'a'          file = 'a' + x
y = 9 - rank            rank = 9 - y
```

| 例子 | 引擎 | 我们的 `(x, y)` | 中文记谱 |
|---|---|---|---|
| 第 002 局首着 | `b5b9` | `(1,4) → (1,0)` | 前车进四 |
| 第 002 局第 1 手应着 | `e8d9` | `(4,1) → (3,0)` | 士5退4 |
| 第 001 局首着 | `e4a4` | `(4,5) → (0,5)` | 炮五平九 |

**中文记谱的纵线号与 ICCS 不是一回事**，而且**红黑是镜像的**（两人面对面，各自从自己的右手边数）：
红方 `9 - x`（汉字一~九），黑方 `x + 1`（阿拉伯数字 1~9）。
黑方这一条历史上写错过一版，见 `design.md` §6.1 与 `future-work.md` E10。

## 三个现成配方

### 1. 验一局的解法（最快）

```powershell
node chinese-chess/tools/verify-solutions.mjs shiqingyaqu-551-002
```

它会把该局整条杀线走一遍：每一步都过**本模块自己的规则层**（非法就报错）、顺带生成中文记谱、
最后确认末局对方一步都走不出。不用引擎，几毫秒出结果。输出形如：

```
ok    《适情雅趣》第002局 马蹀阏氏  (shiqingyaqu-551-002)  20 步杀 / 39 半层
        初始局面：C3kab2/4a4/n3c1n2/3Np1p2/1R4P2/1R7/4P4/4B4/1pCp1p3/1crAK1N2 w - - 0 1
         1. 前车进四  士5退4
         2. 前车退一  士4进5
         ...
```

不带参数就是校验全部 395 条。

### 2. 拿引擎现算一个局面

把 `position fen` 换成任意 FEN（下面用的是第 002 局的题面）：

```
position fen C3kab2/4a4/n3c1n2/3Np1p2/1R4P2/1R7/4P4/4B4/1pCp1p3/1crAK1N2 w - - 0 1
go mate 30 movetime 30000
```

有 30 步内的杀就回 `score mate N` + 完整 `pv`；没有则只回 `score cp <分>`（一个评估，不是答案）。
「谱载胜但引擎找不到杀」的那 106 局，表现就是后者。

### 3. 确认一条 PV 真的杀完了

把 `js/solutions.js` 里某局的 `pv` 接在该局 FEN 后面走完，再让引擎出一手：

```
position fen <该局 FEN> moves b5b9 e8d9 b9b8 d9e8 ... g5f5
go movetime 500
```

已经终局的局面会立刻回（实测）：

```
info depth 0 score mate 0
bestmove (none)
```

## 与本模块工具链的关系

| 文件 | 作用 |
|---|---|
| `tools/gen-solutions.mjs` | **生成**：`fast`（短预算）→ `slow`（对没解出的长预算）→ `emit`（写 `js/solutions.js`）→ `issues`（疑点清单）。另有 `--normal`（用 `go movetime` 补跑 PV 被截断的局）、`--ids`（定点重跑）、`--from/--count`（分批）、`--mate/--movetime`（预算）。中间结果在 `tmp/solutions-work.json`，**可中断、可续跑** |
| `tools/prefix-scan.mjs` | **「引擎首选前缀 / 参考线」**：给「没解出杀线」的局面走一条引擎自己最想走的线（`gen`，加 `--playout` 则走成完整线）、用规则层复核成候选（`promote`）、或把一条已知线（谱载 / `--line` 手给）与引擎首选逐点对照（`compare`），`emit` 写 `js/prefixes.js`。中间结果在 `tmp/prefix-work.json`。**它产出的是「引擎也同意」，不是「正解 / 必须」** —— 理由见下节 |
| `tools/solve.mjs` | **中控**：把上面那条链路按顺序跑完 —— 校验局面 → 找杀（快/慢轮）→ 走到底 → 复核候选 → 写两个数据文件 → 校验 → 更新清单。**加 / 改局面跑这一条就够**：`--ids <id>`（会带 `--force`）/ `--status`（只看现状）/ `--dry-run`（只打印命令）。失败即停并给出单独重跑的命令 |
| `tools/verify-solutions.mjs` | **校验**：不需要引擎。`node ... verify-solutions.mjs [id]` 传 id 就只看一局 |
| `js/solutions.js` | 生成物（**别手改**）：395 条 `{ pv, mate, ms }` + `SOLUTIONS_SOURCE` |
| `tmp/solutions-work.json` | 生成器的账本（每局一条记录）—— 删了要从零重跑 |
| `tmp/solutions-issues.md` | 疑点清单：反杀 / 未解出 / 和局核对，**人工核查用**（留在 tmp，随跑批更新） |
| `docs/pikafish-unfinished.md` | **没解出来的局面清单**（生成物，进仓库）：按「该不该人工核查」分成反杀 / 评估≈0 / 大优无杀三组，另附全部和局备查 |

换引擎版本重跑后，记得更新 `js/solutions.js` 顶部的 `SOLUTIONS_SOURCE`
（它是 `gen-solutions.mjs` 里的常量，改那边再 `emit`）。

## 加一局 / 改一局：一条命令（`tools/solve.mjs`）

```powershell
node chinese-chess/tools/solve.mjs --ids <id>      # 新加的 / 改过 FEN 的局
node chinese-chess/tools/solve.mjs                 # 补跑「还没解法、账本里也没记录」的局
node chinese-chess/tools/solve.mjs --status        # 只看现状（不开引擎）
node chinese-chess/tools/solve.mjs --ids <id> --dry-run   # 只打印要跑的命令
```

顺序：`verify-endgames` → `gen-solutions fast` → `slow` → `prefix-scan gen --playout` →
`promote` → `prefix-scan emit` → `gen-solutions emit` → `verify-solutions` → `test-solution-book` →
`gen-solutions issues`。**失败即停**，并告诉你哪一步失败、怎么单独重跑。

**它不自己算棋**：只是把既有工具当子进程按顺序调一遍，所以每一步都能单独跑
（`--dry-run` 会把命令打出来，直接复制）。

三条约定（都是踩过才写的）：

| | |
|---|---|
| `--ids` 会带 `--force` | 账本按 id 存：改了 FEN 之后不带 force，「走到底」那一步会**跳过**它 —— 跑的其实还是旧局面 |
| 不带 `--ids` 时**不**带 force | 只补「还没有记录」的局，不会把已有结果重算一遍 |
| 一次失败的重跑**不会**让已出线的局倒退 | `promote` 保留上一次的候选（只要它仍和当前 FEN 对得上）；`emit` 把与当前 FEN 对不上的记录**跳过并警告** —— 改了 FEN 忘了重跑时，看到的是一行警告，而不是一条永远匹配不上的「参考线」 |

## 「引擎首选前缀」扫描（`tools/prefix-scan.mjs`）

`gen-solutions.mjs` 只收**已证明的杀线**，所以「谱载胜、但赢法不是连击式连杀」那批局面（`pikafish-unfinished.md` C 组）
一条解法都没有。这个工具走另一条路：**不给完整杀线，给「引擎自己也想走的前 N 手」**。

```powershell
node chinese-chess/tools/prefix-scan.mjs gen --ids shiqingyaqu-551-004 --rules 12 --movetime 2000
node chinese-chess/tools/prefix-scan.mjs compare --id shiqingyaqu-551-004 --line "马六进七 将4进1 …" --all
```

**它不是「正解」，也不是「必须」—— 这一条必须连同数据一起讲清楚。** 实测第 004 局：
把谱上的妙手 `炮五平一` 换成 `马二进三`，Pikafish 只差 0.76 个兵（+9.52 vs +8.76）；
把第 4 步的 `马七退五` 换成 `兵六平五`，只差 0.33 个兵。
也就是说**引擎分不出「杀网还在」和「只是还大优」**，它给得出偏好，给不了必要性证明。
（要看「必须」，得等引擎能证明 mate —— 那只有尾段。）

`compare` 的判定分三态，**不能只看第 1 名**：`same`（首选就是谱着）/ `close`（谱着在前 `--multipv` 条里且与首选分差 ≤ `--tol`，算并列）/ `diff`（真分歧）。
第 004 局那条谱载线跑出来是：**前 10 回合全部一致**，第 11 回合出现唯一一处真分歧（引擎偏 `兵六平五`），
第 12 回合起引擎已经证明杀（mate 13 → … → mate 1）且与谱一致。

`gen` 的停止理由都会写进记录：`cap`（到上限）/ `mate`（引擎给出了杀，而**没开 `--playout`**）/
`mate-pv`（开了 `--playout`，杀线尾巴取自引擎那一次搜索的 PV）/ `notWinning`（红方优势掉到 +1.5 兵以下）/
`repeat`（局面重复；排局里它往往就意味着"没有强制杀"）/ `terminal`（走到底）。

### 走成完整线：`--playout` + `promote`

`--playout` 让引擎**沿它自己选的着法一路走到底**，碰到 mate 分不停。产出直接进解决方案的流水线：

```powershell
node chinese-chess/tools/prefix-scan.mjs gen --playout --movetime 1500 --rules 30
node chinese-chess/tools/prefix-scan.mjs promote          # 规则层复核 → tmp/prefix-candidates.json
node chinese-chess/tools/gen-solutions.mjs emit           # 候选线当**兜底**写进 js/solutions.js
node chinese-chess/tools/verify-solutions.mjs             # 全量再钉一遍
```

实测（2026-09-20，79 个「谱载胜但没解出」的局，1.5 秒/手）：**35 条走成完整线，34 条过复核**
→ 当时 `js/solutions.js` 从 396 → **430 条**。走不成的：`repeat` 22、`notWinning` 19、`cap` 3。

**预算加大能再捞回来。** 把第 357 局（当时 `repeat`）改到 **5 秒/手**重跑，它走成了一条
**`mate 23` 的完整线**（而且 mate 证明出现在**根节点**上 → 按 `src='mate'` 存，不是参考线）。
两个反直觉的实测结果值得记住：

| 现象 | 数据 |
|---|---|
| **同一预算重跑不一定复现** | 357 的根节点，5 秒一次给 `mate 23`（depth 44），全新进程同样 5 秒给 `cp 770`（同样 depth 44）—— 16 线程搜索的非确定性。**`repeat` ≠ "这局没救"** |
| **`go mate` 不比普通搜索更容易找到杀** | 357 的慢轮（`go mate 40` / 30 秒）给 cp 975；普通搜索 5 秒就给出 mate。找杀别只依赖 `go mate`；`--playout` 是互补的路子 |
新数据带 `src: 'walk'`，与已证明的 `src: 'mate'` 在界面**分开措辞**（`walk` 的前段只是引擎的偏好）。

三个坑（都是实测，改这个工具前先看）：

| 现象 | 原因 / 解法 |
|---|---|
| **已有 mate 证明之后，还一步步重搜 → 会在 mate 距离上来回跳、最后 repeat** | 换成「**在出现 mate 分的那一次搜索里直接把 PV 取回来接上**」（`mate-pv`）。第 282 局两种错法都试过，只有这条稳 |
| `go mate` 与 `go movetime` 在同一局面选出不同着法 | 见上面「踩过的坑」那条：问偏好用 `go movetime`，判有没有杀才用 `go mate` |
| 「谱着与引擎首选不一致」报得太多 | 只看第 1 名会把**同分并列**误报成分歧。改成 MultiPV + 容差三态（`same` / `close` / `diff`） |

## 踩过的坑（都是实测）

| 现象 | 原因 / 解法 |
|---|---|
| `Unknown command: '﻿uci'` | PowerShell 管道带 BOM。改交互式、`cmd` 的 `echo`，或写 Node 驱动 |
| 「走完 PV 对方还有着法」 | **`go mate` 模式下 PV 会被截断**（实测 7 局）。用 `--normal`（`go movetime`）补跑 |
| **同一局面 `go mate` 与 `go movetime` 给出不同的「最佳着法」** | mate 模式在**没有杀可证**的局面里选出来的着法与普通搜索不同，而且更容易在重复局面里打转（实测第 419 / 004 两局，mate 模式都以 repeat 收场）。问「引擎最想走什么」要用 `go movetime`；`go mate` 只用来判「有没有杀」。见 `tools/prefix-scan.mjs` 里 `MATE_MODE` 那段 |
| `mate N` 与 PV 长度对不上 | mate 模式截断 PV、普通搜索又会多延伸几步。**以「走到杀完为止」的那一段为准**（`gen-solutions.mjs` 的 `pvLengthToMate`），`mate` 按实际长度推 |
| 启动报 `CRITICAL ERROR` 后直接退出 | 新版引擎对 FEN / UCI 命令校验更严。把 FEN 单独拿来 `position fen` 试 |
| 找不到权重 | `pikafish.nnue` 必须与 exe 同目录。启动时会打印 `info string NNUE evaluation using pikafish.nnue (64MiB, ...)`，没这行就是没加载上 |
| 单局能跑、连着跑几局结果变怪 | 局与局之间要发 `ucinewgame`（清哈希） |
| 想省时间 | 引擎启动 + 加载 NNUE 约 0.2~3 秒，搜索本身常常是毫秒级 —— **批量跑时复用一个进程**（`gen-solutions.mjs` 就是这么做的） |

## 授权

- 引擎本体 **GPL-3**；`.nnue` 权重基于 **Pika Xiangqi Zero** 的数据训练，该数据是 **ODbL**。
- 本项目**只离线运行它、只取输出**（着法是搜索结果，不是版权客体），不链接它的代码、不分发它。
- **`exe` 与 `.nnue` 绝不提交进仓库** —— 放在被忽略的 `tmp/` 下；`tools/` 里只有自己写的驱动脚本。
