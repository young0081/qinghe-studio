# 青禾 Studio

由 **Qn** 开发的本地 AI 编程工作台，提供 Electron 桌面端、Web 界面、CLI 和 TUI。支持多家模型供应商、文件与网页工具、上下文压缩、模型决策与路由、Skills 和 MCP。

## 下载

[下载最新 Windows 版本](https://github.com/young0081/qinghe-studio/releases/latest)。

- `Qinghe-Studio-Setup-1.15.2-win-x64.exe`：安装版。
- `Qinghe-Studio-1.15.2-win-x64.zip`：完整解压版，解压全部文件后运行 `Harness Studio.exe`。
- `Qinghe-Studio-1.15.2-SHA256SUMS.txt`：文件校验值。

安装包适用于 Windows 10/11 x64，已包含运行时。网页自动化需要安装 Edge 或 Chrome。

## 从源码运行

需要 Node.js **22.12.0 或更新版本**和 npm。

```sh
npm ci
npm run gui
```

启动后选择工作区，在「供应商与模型」中配置服务地址、API 密钥和模型。模型服务费用由使用者自行承担。

Web 开发模式需要在两个终端分别运行：

```sh
npm run web
```

```sh
npm run dev
```

访问 `http://127.0.0.1:5173`，后端默认监听 `127.0.0.1:3210`。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 会话、模型协议、上下文、工具与配置存储 |
| `src/automation/` | 浏览器及 Windows 桌面自动化 |
| `src/integrations/` | MCP 集成 |
| `web/` | React 界面与样式 |
| `desktop/` | Electron 主进程、预加载桥接、图标及安装器源码 |
| `scripts/` | 构建、启动及验证脚本 |
| `test/` | 单元、接口、浏览器及桌面测试 |

## 构建与测试

| 命令 | 作用 |
| --- | --- |
| `npm start -- --help` | CLI 使用说明 |
| `npm run tui` | 终端界面 |
| `npm run check` | JavaScript 语法检查 |
| `npm test` | Node.js 自动化测试 |
| `npm run build` | 构建 Web 界面至 `dist/` |
| `npm run test:e2e` | Playwright 浏览器测试 |
| `npm run test:gui` | Electron 界面测试 |
| `npm run build:gui` | 构建 Windows 解包应用至 `release/` |
| `npm run build:installer` | 构建 Windows 安装程序 |

运行浏览器及桌面测试前先执行 `npm run build`；浏览器测试需要 `npx playwright install chromium`，桌面测试需要图形环境。Windows 安装程序使用系统 .NET Framework 4.x 编译器，须在 Windows 上构建。

## 使用声明

请在合法、获授权的范围内使用。模型输出和自动操作可能出错，执行关键操作前应核验结果并备份重要数据。密钥、工作区配置和会话数据应保存在本机，不要提交到仓库。完整说明见[使用声明与免责声明](docs/usage-disclaimer.md)。

## 支持项目

欢迎通过 [Qn 的爱发电主页](https://afdian.com/a/qnqinghe)自愿支持开发与维护。是否赞助不影响现有功能，赞助不包含模型 API 额度。
