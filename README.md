# treert.github.io

个人 GitHub Pages 静态站点，存放一些自用小工具和折腾记录。

## 目录

| 项目 | 说明 |
|------|------|
| [UE5 Console Help](./ue-consolehelp/ue5.html) | Unreal Engine 5 控制台变量与命令速查 |
| [UE4 Console Help](./ue-consolehelp/ue4.html) | Unreal Engine 4 控制台变量与命令速查 |
| [字符编码工具](./char_code_tool/index.html) | 字符串转 UTF-8 转义序列 |
| [字体显示测试](./test_font/index.html) | 常见中英文字体渲染效果对比 |
| [404](./404.html) | 自定义 404 页面 |

## 技术栈

纯静态 HTML + CSS + JS，无构建工具，无框架依赖。

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


