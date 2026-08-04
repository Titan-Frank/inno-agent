# inno-agent Electron 说明

## 云端打包（发版）

见 **[`docs/mac-app-packaging.md`](docs/mac-app-packaging.md)**（GitHub Actions **macOS Release** 工作流）。

## electron/ 目录

| 文件 | 用途 |
|------|------|
| `main.js` | Electron 主进程：启动后端、托盘、窗口 |
| `updater.js` | 自动更新（electron-updater 封装 + IPC） |
| `preload.cjs` | contextBridge 注入 `window.innoDesktop`（web UI 感知桌面端） |
| `loading.html` | 服务启动期间的 loading 页 |

首次启动会在 `~/.inno-agent/config/config.json` 写入默认配置（API Key 为空）；用户在应用内设置页填写即可。

## electron/main.js 要点

- `use-mock-keychain`：未签名 app 避免 macOS 钥匙串弹窗
- `ELECTRON_RUN_AS_NODE=1` + `spawn(process.execPath, [server.js])`：用 Electron 内置 Node 跑后端，正确解析 asar 内 `node_modules`
- 轮询 `http://localhost:3000/health`，就绪后关闭 loading 窗口并打开主界面

## 自动更新

- **更新源**:`hhyqhh/inno-agent` 的 GitHub Releases（根 `package.json` 的 `build.publish`)。tag 触发发版工作流时 `electron-builder --publish always` 自动创建/复用 Release 并上传安装包与 `latest.yml` / `latest-mac.yml` 清单（客户端检查更新拉取的就是这些 yml)。
- **客户端**:`electron/updater.js` 在打包环境中启动 10s 后首次检查、之后每 4 小时轮询；状态经 IPC 推送给 web UI，「设置 → 关于 → 版本与更新」展示版本、检查按钮与下载进度。浏览器访问 web UI 时 `window.innoDesktop` 为 undefined，更新区块自动隐藏。
- **Windows(NSIS)**：完整自动更新 —— 后台自动下载，下载完成后用户点「重启安装」。
- **macOS**：当前构建未签名，electron-updater 拒绝安装未签名更新，因此 mac 只做**新版本提示 + 跳转 Release 页手动下载**(`autoDownload=false`)。配置签名 secrets(`CSC_LINK` 等，见 release-mac.yml 注释块）后，把 `updater.js` 中 `canAutoInstall` 放开到 darwin 即可启用 mac 自动安装；mac target 中的 `zip` 产物即为此预留（electron-updater 的 mac 更新使用 zip，不用 dmg)。
