# 棋子图形（chess-icons）

12 个 45×45 的 SVG，网页运行时读进来当棋子用（读取与着色见 `js/piece-art.js`）。

## 来路

**Cburnett 棋子集**，作者 Colin M. L. Burnett —— 维基共享上最常见的那套
（lichess 的默认棋子也是它）。

这 12 个文件是从 `https://www.chessdb.cn/file/chess/<名字>.svg` 抓的：

| 文件 | 棋子 | 文件 | 棋子 |
|------|------|------|------|
| `wk.svg` | 白王 | `bk.svg` | 黑王 |
| `wq.svg` | 白后 | `bq.svg` | 黑后 |
| `wr.svg` | 白车 | `br.svg` | 黑车 |
| `wb.svg` | 白象 | `bb.svg` | 黑象 |
| `wn.svg` | 白马 | `bn.svg` | 黑马 |
| `wp.svg` | 白兵 | `bp.svg` | 黑兵 |

重新抓一遍（或换成自己的一套 —— 文件名保持一致就不用改代码）：

```bash
for n in wk wq wr wb wn wp bk bq br bb bn bp; do
  curl -fsS -o chess/chess-icons/$n.svg https://www.chessdb.cn/file/chess/$n.svg
done
```

## 许可

同一批文件在维基共享上的口径是 **CC BY-SA 3.0**（lichess 的 `COPYING.md` 里记作 GPLv2+）。
页面上要用的署名信息在 `js/piece-art.js` 的 `PIECE_ART_SOURCE` 里，**别在别处再抄一份**。

## 文件保持原样，颜色在运行时换

文件里写的是原始的 `#ffffff` / `#000000`。颜色是**运行时**才换成 CSS 变量的
（`js/piece-art.js` 的 `colorize`）：主体色 → `--chess-p-fill`，另一个色 → `--chess-p-stroke`。
这样这些文件能跟下载下来的原素材**逐字 diff**，换素材时改动也最小。

所以：

- **别手改这里的颜色。** 改成变量名之后运行时就没得换了（没有 `#ffffff` 可换），
  深色主题会跟着坏。
- 想调棋子配色，改 `style.css` 顶部的 `--chess-white-*` / `--chess-black-*`；
  想换整套图形，换这个目录里的文件。
