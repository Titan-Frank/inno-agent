# Inno Agent Showcase

静态案例回放站：把真实使用 Inno Agent 的会话录制导出为 JSON，然后**直接用产品真实前端**逐条回放——聊天、右侧文件预览、知识库（L2 wiki)、学习者画像（L1）的联动全部复现，帮助新用户快速理解这个个人学习 agent 的工作方式。

## 工作原理（v2：真实 UI + mock 后端）

- **数据**：`scripts/export-showcase-cases.ts`（仓库根目录）从 `runtime/data/sessions/*.jsonl` 读取 PI 会话记录，复用后端 `parseSessionFile` 的聚合逻辑（user / assistant 回合合并 / toolResult 配对），脱敏本地路径、用户名与常见密钥形态，截断超长工具输出后，写入 `public/cases/<id>.json` + `index.json`。除消息外还导出**面板关键帧**：workspace 文件（从 `write`/`edit` 工具调用重建）、wiki 页面（`l2_archive`)、画像事件（`record_learning_event`)+ 脱敏的 profile 快照；会话开始前已存在的 workspace 文件作为 initial 状态内联/拷贝为静态资源。
- **渲染**：不复制任何 UI——`App.tsx` 直接组合主应用（`inno-agent-web`）源码里的 `SessionSidebar` / `ChatCenter` / `WorkspacePanel` 真实组件（经 Vite alias `@inno-web` 指向 `apps/inno-agent/web/src`)，样式表整个复用。主应用前端更新后，重新 build 本站即同步。
- **mock 后端**:`src/mock/runtime.ts` 在 `main.tsx` 最前面 shim 掉 `globalThis.fetch`，把所有 `/api/*` 请求路由到 step 感知的 fixture handler(sessions / workspaces / workspace tree+file / wiki / learner profile / settings)，其余请求（cases JSON、静态资源）原样透传。产品 store 全部经 `apiFetch` 走 fetch，所以真实组件无感运行。
- **回放驱动**:`src/replay/driver.ts` 按消息真实时间间隔（钳制在 350ms–2.5s，可 1×/2×/4×）逐步调用 `chatStore.loadHistory(messages.slice(0, i))` 推进聊天；每步把 mock 后端的 step 前移，跨越面板关键帧时触发 `workspaceStore.loadTree()` / `notebookStore.loadAll()` / `learnerStore.load()` 重新拉取，并自动打开右侧面板、切到对应 tab（每种面板只在首次揭示时自动切一次，之后尊重用户选择）。侧栏点击案例 = 真实 `sessionsStore.openSession`,driver 监听 store 变化自动 attach。

## 常用命令（仓库根目录执行）

```bash
npm run showcase:export   # 重新导出案例(session → public/cases/*.json)
npm run showcase:dev      # 本地开发,Vite 在 :5174
npm run showcase:build    # 类型检查 + 构建静态产物到 apps/showcase/dist
```

## 新增一个案例

1. 在 `scripts/export-showcase-cases.ts` 的 `CASES` 数组里加一条记录（session 文件名 + 标题/描述/标签，可选 `maxUserTurns` 截断长会话、`excludePaths` 排除不想公开的文件）。
2. 跑 `npm run showcase:export`。
3. **务必人工 review 生成的 JSON**（脱敏脚本处理路径/用户名/常见密钥形态，但消息正文是原文）。

## 部署

`vite build` 产物是纯静态文件（base 为相对路径），直接丢到 GitHub Pages / Vercel / 任意静态托管即可。路由用 hash(`#/case/<id>`)，不需要服务端 rewrite。

## 维护约束

- 主应用 `web/src/react/chat/` 下的组件必须保持纯 props 驱动，**不得 import store 或 api 层**——这是 showcase 能复用的前提。
- showcase 复用的是真实 store + 组件，因此主应用 store 的**公开方法签名**(`loadHistory` / `loadTree` / `loadAll` / `load` / `openSession` 等）和 `/api/*` 的**响应结构**若发生 breaking change，需同步调整 driver 与 mock 后端。
- 若 `ChatMessage` / `ChatToolRecord` 类型（`web/src/types/chat.ts`）发生 breaking change，需同步调整导出脚本。
- **dev 模式的 optimizeDeps 陷阱**：pi-web-ui 只经 alias 在运行时触达，Vite dep 扫描发现不了它，必须 `optimizeDeps.include` 显式列出；又因为 mini-lit 被 exclude（打 marked 补丁用），它深引用的 `highlight.js/lib/core` 等 9 个子路径也必须逐个 include，否则 dev 下 CJS 裸导入直接白屏崩溃（生产 build 不受影响）。详见 `vite.config.ts` 注释。
- **headless 验证注意**：默认 800×600 视口会触发真实 App 的窄屏媒体查询把右侧面板强制收起，验证面板联动必须 `--window-size=1440,900`;`--virtual-time-budget` 会冻结 WAAPI/motion 动画（气泡停在 opacity:0)，截图里消息"消失"是伪影，要看 DOM。
