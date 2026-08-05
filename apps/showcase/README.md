# Inno Agent Showcase

静态案例回放站：把真实使用 Inno Agent 的会话录制导出为 JSON，在纯前端页面里逐条回放，帮助新用户快速理解这个个人学习 agent 的工作方式。

## 工作原理

- **数据**:`scripts/export-showcase-cases.ts`(仓库根目录）从 `runtime/data/sessions/*.jsonl` 读取 PI 会话记录，复用后端 `parseSessionFile` 的聚合逻辑（user / assistant 回合合并 / toolResult 配对），脱敏本地路径与用户名、截断超长工具输出后，写入 `public/cases/<id>.json` + `index.json`。
- **渲染**:1:1 复刻产品聊天界面——侧栏(案例列表取代会话列表)、`conversation-stage` 聊天区、底部 composer(禁用的视觉复刻),消息气泡直接 import 主应用(`inno-agent-web`)源码里的 `react/chat/MessageBubble` 等**纯 props 驱动组件**(经 Vite alias `@inno-web` 指向 `apps/inno-agent/web/src`),样式表也整个复用。主应用前端更新后,重新 build 本站即同步。
- **回放**:按消息真实时间间隔(钳制在 350ms–2.5s)逐条 reveal,播放/暂停、1×/2×/4× 倍速、进度条拖拽、跳转结尾,控制条嵌在 composer 上方。

## 常用命令（仓库根目录执行）

```bash
npm run showcase:export   # 重新导出案例(session → public/cases/*.json)
npm run showcase:dev      # 本地开发,Vite 在 :5174
npm run showcase:build    # 类型检查 + 构建静态产物到 apps/showcase/dist
```

## 新增一个案例

1. 在 `scripts/export-showcase-cases.ts` 的 `CASES` 数组里加一条记录（session 文件名 + 标题/描述/标签，可选 `maxUserTurns` 截断长会话）。
2. 跑 `npm run showcase:export`。
3. **务必人工 review 生成的 JSON**（脱敏脚本处理路径/用户名/常见密钥形态，但消息正文是原文）。

## 部署

`vite build` 产物是纯静态文件（base 为相对路径），直接丢到 GitHub Pages / Vercel / 任意静态托管即可。路由用 hash(`#/case/<id>`)，不需要服务端 rewrite。

## 维护约束

- 主应用 `web/src/react/chat/` 下的组件必须保持纯 props 驱动,**不得 import store 或 api 层**——这是 showcase 能复用的前提。
- 若 `ChatMessage` / `ChatToolRecord` 类型(`web/src/types/chat.ts`)发生 breaking change,需同步调整导出脚本。
- **dev 模式的 optimizeDeps 陷阱**:pi-web-ui 只经 alias 在运行时触达,Vite dep 扫描发现不了它,必须 `optimizeDeps.include` 显式列出;又因为 mini-lit 被 exclude(打 marked 补丁用),它深引用的 `highlight.js/lib/core` 等 9 个子路径也必须逐个 include,否则 dev 下 CJS 裸导入直接白屏崩溃(生产 build 不受影响)。详见 `vite.config.ts` 注释。
