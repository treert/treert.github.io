# Stockfish 与残局表库（离线手册）

这份文档管的是**离线**这一半：用原生 Stockfish（必要时加 Syzygy 表库）算残局结论、
生成谱载解法线。网页里**不跑** Stockfish，理由见 §5 —— 先把这条记住，能省掉一个下午。

> 对照阅读：`chinese-chess/docs/pikafish.md` 是同一件事在象棋那边的做法
> （那边用 Pikafish 生成《适情雅趣》全谱的解法）。分工完全一样：
> **引擎只负责离线产出，网页只负责读产出。**

---

## 1. 下载与安装

- 官方页面：<https://stockfishchess.org/download/>，或直接拿 GitHub Release
  （`official-stockfish/Stockfish` 的 releases 里有各平台压缩包，按 CPU 选：
  `x86-64-avx2` / `x86-64-bmi2` / `apple-silicon` 等）。
- 官方二进制**内嵌 NNUE 权重**，解压就能用；要换网络再用 `EvalFile` 指定 `.nnue`。
- 验证装好了（命令行里）：

```
uci
isready
position startpos
go depth 12
```

会打印 `bestmove ...` 就算通。`bench` 可以顺带量一下本机 nps（后面调超时用得上）。

## 2. 常用 UCI 命令（够用的一小撮）

| 命令 | 用途 |
|------|------|
| `setoption name Hash value 512` | 置换表大小（MB），生成解法时给大一点 |
| `setoption name Threads value 8` | 线程数，取物理核心数 |
| `setoption name SyzygyPath value D:\syzygy` | 挂表库目录（多个路径用 `;` / `:` 分隔） |
| `position fen <FEN>` | 摆局面；`position startpos moves e2e4 ...` 也能按着法走 |
| `go depth 30` / `go movetime 5000` / `go infinite` + `stop` | 搜索方式三选一 |
| `d` | 打印当前棋盘（调试 FEN 拼错时的第一件事） |
| `eval` | 打印静态评估明细（判断「是不是位置表在乱说话」） |

**判读输出**：`info depth ... score cp 34 ... pv e2e4 e7e5 ...`（分数单位是**厘兵**，
100 = 一个兵的优势）；`score mate 3` 表示三步杀。`bestmove` 才是要抓的那一行。

## 3. Syzygy 表库

### 3.1 为什么值得下

表库给的是**可证明**的结论：某个残局是白胜 / 和棋，以及在那个局面下**哪些着法保住结论**。
没有它，残局的 `result` 字段只能靠「引擎搜了很久，看起来是赢」——含糊，而且难度分级
（几手杀、唯一着法）也没法算。有了它：

- `result` 由 DTZ 结论直接给出（不是搜索猜的）；
- `difficulty` 可以由 DTZ/DTM 步数推（步数越少越简单）；
- 「唯一着法」也能标（表库会告诉你只有一步不丢结论）。

**DTZ 与 DTM 的区别要记住**：DTZ = 距离下一次「归零」（吃子或兵走动）的步数 ——
它是**50 步规则下**判断胜负的正确口径；DTM = 到将杀的步数，只在「确实有杀」时才有意义。
残局结论文档里写 DTZ 口径，别混用。

### 3.2 规模与下载

| 子数 | 体积（约） | 能不能本地放 |
|------|-----------|--------------|
| 3~4 子 | 几十 MB | 随便下 |
| 5 子 | 约 1GB | 推荐下（大部分实用残局都在这） |
| 6 子 | 约 150GB | 不下 |
| 7 子 | 约 18TB | 不下（要查就用在线 API） |

- 3-4-5 子打包可以从 Lichess 的镜像拿：<https://tablebase.lichess.ovh/tables/standard/3-4-5/>
  （或其它镜像，见官方 wiki 的表库一节）。下完解压到一个目录，用 `SyzygyPath` 指过去。
- 挂上表库后，**引擎在表库覆盖的局面里会直接读表**，`info` 里出现 `tb` 字段
  （例如 `tbhits 1`），这就是「命中表库」的标志 —— 生成解法时要确认它真的命中了。

### 3.3 网页侧的一个对应物

7 子以内的局面还可以**在线**查（Lichess 的公开 tablebase API，返回 JSON、允许跨域）。
本模块**不依赖**它（离线优先），但做残局素材时可以拿它交叉验证自己算出来的结论。

---

## 4. 生成残局解法的工作流

### 4.1 素材从哪来

| 来源 | 说明 |
|------|------|
| 公开棋谱 / study 的 PGN | 从里面挑出残局片段，落成 FEN |
| 教材里的经典局面 | 卢塞纳、菲力多尔、马象杀这类，一手资料普遍可查 |
| **chessdb 的 DTZ 统计页** | 它按子力分类给了每类的「最长局面」FEN + 胜和负率 —— 天然的一批硬骨头练习局，取用时把出处写进 `source` |
| 自己摆 | 直接用棋盘摆一个局面存进自定义局面，再导出 FEN |

**规矩**：`source` 字段一定写清出处（哪个谱、哪本书、哪个站点）。来源不明或授权不清的
整段棋谱，不要成批入库。

### 4.2 `tools/gen-solutions.mjs` 的做法

不要手动一局一局敲引擎命令 —— 写成脚本，一次性把整库跑完（照搬象棋 `gen-solutions.mjs`
的形态：一个脚本，读写 `.mjs` 数据文件，`node` 直接跑）。

伪代码：

```
for (const eg of endgames) {
  let cur = eg.fen;
  const line = [];
  for (let ply = 0; ply < MAX_PLY; ply++) {
    送 UCI: position fen cur → go depth 30（或 go movetime 3000）
    读回 info 行（记录 score / tbhits / depth）与 bestmove
    如果 bestmove 为空 → 结束（应该只发生在和棋/终局局面）
    bestmove 是 UCI 坐标（e2e4 / e7e8q，升变带第 5 个字母）
    用本模块 rules.js 在 cur 上走这一步（**必须走通**，这是第一道校验）
    用本模块 notation.js 算 SAN（不要用引擎给的记法）
    line.push({ san, move, fenAfter })
    cur = fenAfter
    如果这一步之后是 将死 / 逼和 / 50 步 / 三次重复 / 子力不足 → 结束
  }
  写回 solutions.js
}
```

生成时记下三样东西，写进文件头注释：**引擎版本**、是否挂了表库、每局的搜索条件。
半年后回头看到「这局的结论怎么和现在不一样」时，这三个字段是唯一能解释原因的东西。

### 4.3 为什么要用本模块的规则层复核

`verify-endgames.mjs`（照搬象棋那个脚本的角色）在入库前检查：

1. FEN 能解析、局面合法（王的数量、不能有兵在末 rank、不能两王相邻、不能有「吃王」的轮走方）；
2. 轮走方有合法着法（已经终局的局面没有练习价值）；
3. **解法线每一步都能通过本模块的 `generateLegalMoves` 走通**；
4. 解法线结束时确实达成 `result`（将死 / 和棋类）。

这一步不能省：UCI 是文本协议，升变（`e7e8q`）与易位（`e1g1` 表示短易位）
最容易解析错，而错法很难在第一遍看数据时看出来。

### 4.4 手动验一局的配方

怀疑某一局的结论时，按三步走：

```
# 1. 局面摆对了吗
position fen <FEN>
d

# 2. 分数方向与 result 一致吗
go depth 25
#   看 score 的符号：result 是白胜就该是正的大分；和棋就该在 0 附近

# 3. 表库怎么说（挂了 SyzygyPath 之后）
setoption name SyzygyPath value <目录>
position fen <FEN>
go depth 5
#   看 info 里有没有 tbhits；有就以上面给的 DTZ 结论为准，别再拿搜索分数推理
```

---

## 5. 为什么网页里不用 Stockfish wasm（决策记录）

结论：**不用**。将来若要改，先看这一节再动手。

| 代价 | 具体 | 能不能绕 |
|------|------|----------|
| 官方不发 wasm | Stockfish 官方 release 只有各平台原生二进制 | 用社区构建（`nmrugg/stockfish.js` 维护最勤），或自己 emscripten 编 |
| 体积 | wasm 本体 1~3MB，但 SF16/17 是 NNUE：**权重网小网 5~6MB、大网约 40MB** | 用小网；或干脆用不带 NNUE 的老版本（棋力降一档） |
| 只能单线程 | 多线程要 `SharedArrayBuffer` → 要跨源隔离（`COOP: same-origin` + `COEP: require-corp`）→ **GitHub Pages 不能自定义响应头** | 换托管：Netlify / Cloudflare Pages 支持用 `_headers` 文件发这两个头 |
| 许可 | Stockfish 是 GPLv3，网页分发要带许可与源码指向 | 附上许可与源码链接（本就开源，成本不大） |
| 首屏 | 几十 MB 下载，手机上很重 | 懒加载 + 进度提示；只在用户主动点「分析」时才下 |

**现在的替代方案（都已够用）**：

1. 网页里的强提示 → 走「谱载解法」这条路（离线算好塞进 `solutions.js`）；
2. 在线强评估 → 可选接 Lichess 的公开云评估 API（零下载、零许可负担，缺点是有命中率限制）；
3. 陪练 → 本模块自研引擎（`design.md` §7）。

**将来真要做 wasm 版**，改动范围其实很小：引擎层已经是 `worker.js` + 消息协议，
换掉 worker 的实现即可；但**同时**要处理托管平台（为了那两个响应头）与仓库体积
（那种情况下更该独立成仓库）。
