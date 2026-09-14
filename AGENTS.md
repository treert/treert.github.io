# AGENTS.md

## 这是什么

`treert.github.io` 是 **GitHub 个人首页**（用户站点），推送 `master` 后由 GitHub Pages 发布到
`https://treert.github.io/`。首页只是 `index.html` 里的卡片列表，真正的内容是一个个独立的小模块。
纯静态 HTML + CSS + JS，无构建工具、无框架、无依赖。

## 模块放在哪

| 形式 | 位置 | 首页链接 | 现有模块 |
|------|------|----------|----------|
| 本地子目录 | 本仓库一级子目录 | 相对路径，如 `./char_code_tool/index.html` | `char_code_tool/`、`test_font/`、`conway-life-game/` |
| 独立仓库 | **另一个 git 仓库**，单独部署 | 绝对地址，如 `https://treert.github.io/llm-tokenizer/` | `llm-tokenizer`、`llm-lens`、`jquery.ripples` |

**独立仓库的模块不在本仓库里**，看不到源码是正常的。不要去找、不要在本地新建同名目录来「补上」，
要改就切到对应仓库。

## 模块之间完全隔离

这是本仓库最重要的规则：

- 模块 A 不得引用模块 B 的任何文件（import / `<script src>` / `<link>`）。
- 不得共享全局变量、`localStorage` key、CSS 类名。命名带自己的前缀（如 `conway-life-*`）。
- 模块不依赖首页 DOM，首页也不依赖模块内部结构。
- 删掉任一模块，不得影响其他模块和首页。

## 只有本仓库的模块能用 global.css / global.js

`global.css`（CSS 变量 + 通用组件）和 `global.js`（深色模式）是**本仓库内部**的共用文件，
通过相对路径 `../global.css` 引用：

```html
<link rel="stylesheet" href="../global.css">
<script src="../global.js"></script>
```

**独立仓库的模块用不了**——它们部署在别的路径下，`../` 指不到这里，所以那边得自带一套样式和主题逻辑。
本文件里的这几条只适用于本地子目录模块：

1. `global.js` 必须用普通 `<script>` 同步加载在 `<head>`，不能加 `defer` / `async`，也不能改成 `module`，
   否则深色模式用户会先看到一帧白屏。
2. 颜色走 CSS 变量，不要写死，否则深色下必然出问题。
3. canvas 颜色由 JS 画，切主题时要监听 `themechange` 事件（`detail.theme` 为 `'dark' | 'light'`）重绘。

改动 `global.css` / `global.js` 会影响所有本地模块，改完要逐个过一遍。

## 新增模块

1. 建一级子目录，`<head>` 里引 `../global.css` 和 `../global.js`（照抄 `char_code_tool/index.html`）。
2. 样式和逻辑自包含在该目录内，命名加模块前缀。
3. 在根 `index.html` 的 `<details class="group">` 里加一张 `.card`，并更新根 `README.md` 的目录表。
4. 若该模块要独立成仓库，源码移出去，首页链接改成绝对地址。

## 本地预览

```bash
python -m http.server 8000   # http://127.0.0.1:8000/
```

`conway-life-game` 用了 ES Module，`file://` 直接打开会被 CORS 拦掉，必须走 http。
