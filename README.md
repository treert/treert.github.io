# treert.github.io

个人 GitHub Pages 静态站点，存放一些自用小工具和折腾记录。

## 目录

| 分类 | 项目 | 说明 |
|------|------|------|
| AI / LLM | [LLM Tokenizer](https://treert.github.io/llm-tokenizer/) | 浏览器中计算和可视化文本 Token，支持 DeepSeek 等模型 |
| AI / LLM | [LLM-LENS](https://treert.github.io/llm-lens/) | 通过解剖开源 LLM 权重，理解大语言模型的工作原理 |
| 小工具 | [字符编码工具](./char_code_tool/index.html) | 字符串与 UTF-8 转义互转，查看码点与字节 |
| 小工具 | [字体显示测试](./test_font/index.html) | 常见中英文字体渲染对比，支持自定义文字与字体 |
| 折腾 / 好玩 | [Conway 生命游戏](./conway-life-game/index.html) | 元胞自动机演示，内置 20 个经典结构，支持 Life 1.06 导入导出 |
| 折腾 / 好玩 | [水波效果](https://treert.github.io/jquery.ripples/html) | 学习 WebGL，一个鼠标交互的水波纹特效 |
| — | [404](./404.html) | 自定义 404 页面 |

## 技术栈

纯静态 HTML + CSS + JS，无构建工具，无框架依赖。

## 全站共用

| 文件 | 作用 |
|------|------|
| `global.css` | CSS 变量（配色、圆角、字体）+ 通用组件样式。**深色主题就是在这里的 `:root[data-theme="dark"]` 换一套变量** |
| `global.js` | 深色模式：在首次绘制前定好 `<html data-theme>`，并在右上角挂一个切换按钮 |

`global.js` **必须用普通 `<script>` 同步加载在 `<head>` 里**，不能加 `defer` / `async`，
也不能改成 `module`——它要在首次绘制之前把主题定下来，否则深色模式的用户会先看到一帧白屏。

主题优先级是「`localStorage` 里的选择 > 系统偏好」，所以没手动切过的访客会自动跟随系统。

新增页面时，除了引 `global.css`，记得也引上 `global.js`，切换按钮会自动挂上去。
深色下如果发现某处颜色不对，八成是那个颜色写死了没走变量——用 `--danger`、`--on-accent`
这类已有的变量，或者按需加一个。

## GitHub Pages 设置

新仓库需要手动启用 GitHub Pages：

1. **用户/组织站点**（`<username>.github.io`）：
   - 仓库名必须为 `<你的用户名>.github.io`
   - 推送到 `master`（或 `main`）分支，Pages 会自动生效
   - 访问地址：`https://<用户名>.github.io/`

2. **项目站点**（如 `llm-tokenizer`）：
   - 进入仓库 → **Settings** → **Pages**
   - **Source** 选择 `Deploy from a branch`
   - **Branch** 选择 `master`（或 `main`），根目录 `/ (root)`
   - 点击 **Save**，稍等片刻即可通过 `https://<用户名>.github.io/<仓库名>/` 访问

3. 如果使用自定义域名，在 Pages 设置中填入域名并配置 DNS 即可。


