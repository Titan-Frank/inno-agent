# 代码质量整改计划（2026-08）

> 来源：2026-08-09 全仓库质量审核。审核结论经逐项核实（server.ts 实际 5,295 行、17 个测试文件中 9 个集中于 memory/l2、CI 只 build 不跑测试、xlsx 走 CDN tarball、axios 直接依赖零 import、jiti 出现在 4 个文件、scheduler 三处时区硬编码）。
>
> 状态图例：✅ 已完成 / 🚧 进行中 / ⬜ 未开始
>
> 进度速览：**P0 已合并（PR #133），P1 主体已合并（PR #134，测试 17 文件/101 用例 → 23 文件/144 用例）**。下一站 P3（L1 语言正则 + 命名诚实性），然后 P2 拆 server.ts。

## 总体原则

先分清两类问题：

- **正确性 / 诚实性问题**——必须修（文档过时、静默失效的正则、名不副实的命名、非原子写）。
- **野心边界问题**——个人工具不必修，但要写清楚（单进程单会话架构）。

不为"像平台"而重构。单进程是设计约束，不是缺陷。

---

## P0 · 低成本立即修 ✅ 已合并（PR #133，`chore/p0-remediation`）

| 项 | 动作 | 状态 |
|---|---|---|
| 文档过时 | CLAUDE.md：「无测试文件」→ 17 个；server.ts「~4700 行」→ ~5300 行 | ✅ |
| axios | 删 `apps/inno-agent` 的 axios 直接依赖（零 import）。**保留**根 `overrides` 中 `@larksuiteoapi/node-sdk.axios` 的安全钉版——那不是死依赖 | ✅ |
| `@tailwindcss/cli` | 从根 devDependencies 删除（web 端用 `@tailwindcss/vite`，cli 是迁移残留） | ✅ |
| saveConfig 非原子 | `config.ts` 改用 `storage/file-store.ts` 的 `writeJson`（tmp + rename） | ✅ |
| CI 跑测试 | release-mac.yml / release-win.yml 在 `npm ci` 后加 `npm test`，17 个存量测试从装饰品变门禁 | ✅ |
| xlsx CDN tarball | 本 PR 不动（根 overrides 已钉死版本）；记录风险，中期换 `exceljs` 或 vendor 进仓库 | ⬜ 见 P4 |

## P1 · 测试基建（主体 ✅ 已合并 PR #134，`chore/p1-test-infra`；尾巴见下）

测试偏科的根因是"只有纯函数好测"。补三层：

1. **web 端 DOM 环境** ✅（`chore/p1-test-infra`）：`vitest.config.ts` 用 `environmentMatchGlobs` 把 `*.test.tsx` 路由到 jsdom，装了 `@testing-library/react`；`react/ui/Switch.test.tsx` 是首个组件测试示例。纯 store/util 测试留在 node 环境。
2. **后端补测，按风险排序而非按目录平均分配**：
   - **scheduler** ✅：`cron-utils`（解析/校验/due 判定/one-shot 检测）+ `job-store`（create 默认值、update 清 nextRunAt、`normalizePersistedJobs` 迁移、runs、getStatus）
   - **channels** ✅（部分）：`dedupe-store`（TTL、按渠道隔离、重启持久化）。`personal-dispatcher` 消息路由待补 ⬜
   - **L1 learner**：profile-updater 增量逻辑（与 P2 模型修正一起测）⬜
   - **L3**：依赖 Node ≥22.5，用 `describe.skipIf(...)` 做条件测试 ⬜
   - **terminal** ✅：`command-resolver` 扩展名映射与路径引用。PTY 交互不测
3. **server.ts smoke 层** ✅：`server.smoke.test.ts` 以子进程方式起真实 server（`--import tsx` + 临时 `--home` + dummy provider），断言 `/health`、`/api/settings`（含 API key 脱敏）、`/api/sessions`、`/api/jobs`、未匹配 `/api/*` 的 JSON 404。**该测试当场抓到一个真 bug**：SPA fallback 对未匹配的 `/api/*` 也返回 200 index.html——已修（fallback 跳过 `/api` 前缀）。

## P2 · server.ts 拆分（2–3 周，纯搬运零行为变更）

判断标准：它是全仓库改得最多、历史 bug 最密集的文件（队列焊死、SSE 重连都在这里），值得拆。

打法是沿路由域机械抽取，每一步保持 build + P1.3 smoke 测试绿：

```
src/server/
  index.ts            # createServer + 路由表装配（<300 行）
  routes/chat.ts      # /api/chat/* 含 SSE + 事件回放
  routes/wiki.ts      # /api/wiki/*
  routes/jobs.ts      # /api/jobs/*
  routes/skills.ts    # /api/skills/*
  routes/settings.ts  # /api/settings/* + config 热写
  routes/workspaces.ts
  routes/terminal.ts  # WebSocket upgrade
  context.ts          # 各路由共享依赖（paths、store、registry）显式注入
```

约束：
- **禁止顺手重构**。每个 PR 只移动一个路由域，diff 应为纯 cut-paste + import 调整。
- 共享状态经 `context.ts` 显式传参，不引入 DI 框架。
- 拆完后各路由域独立可测，测试再逐步下沉。

## P3 · 模型与命名的诚实性（需拍板）

共同点："演示能跑、泛化不行"。修法不是换更强算法，而是让系统声称的和做的一致。

**L1 掌握度模型**
- 最小修（推荐先做这个）：`confidence`/`stability` 改名或标注 `heuristic: true`；固定增量 +0.03/+0.02 收敛为配置项。
- 彻底修：换简化 BKT/Elo（每知识点一个难度参数，练习对错驱动更新），3–5 天，可复用 `rebuildProfileFromEvents` 的事件重放。
- **四语言正则必须修（这是 bug 不是风格）**：硬编码 Rust/C++/Python/TypeScript 让其他主题目标归档静默失效。改成从 L2 wiki 主题/用户目标文本动态匹配，正则只作兜底。

**"语义检索"**
- 诚实路线（推荐，1 天）：`semantic-chunker` 改名 `structural-chunker`，L2 检索统一表述为「词法检索 + 图扩展」。
- 能力路线（暂缓）：PI SDK 无 embedding API，需自接 provider embedding 端点 + sqlite 向量表（schema 已预留 embeddings 表），1 周以上。个人知识库规模下 BM25+图扩展大概率够用，等真有检索质量投诉再做。
- BM25 分值丢弃 / 图扩展分数拍脑袋：有 eval 阈值兜底，不算 bug。加注释标明"分数未标定，仅排序有效"。

## P4 · 小坑批量修（各随所属模块的 PR 带走）

- **时区**：`config.json` 加 `scheduler.timezone`，默认 `Asia/Shanghai`，`cron-utils.ts` 三处改读配置。默认中国时区合理，问题是不可配。
- **runCount 竞态**：`JobStore` 读-改-写加 per-job promise chain 串行化。
- **jsonl 只增不减**：`events.jsonl`/`runs.jsonl` 加 size 阈值（如 10MB）滚动归档，启动时 tail 读最近 N KB 而非全量解析。
- **jiti 加载他包内部 .ts（定时炸弹）**：短期钉死 `pi-mcp-adapter` 版本（去 `^`）+ jiti 调用处 try-catch 报明确错误；中期给上游提 PR 加 `exports` 入口或 vendoring。
- **xlsx**：评估 `exceljs`（npm 官方源）或把 tarball vendor 进 `vendor/`，消除离线安装即挂。

## P5 · 明确不修，但要写下来

- **单进程单 AgentSession**：README「设计哲学」加 "Non-goals" 一节：不追求多用户并发、不水平扩展、会话切换靠文件换载。同时确认 #124 的 409 `session_busy` 机制覆盖所有跨会话切换路径。

---

## 执行顺序

```
✅ P0 全部（PR #133）
✅ P1.1 web DOM 环境 + P1.3 server.ts smoke 测试 + P1.2 首批（PR #134）
下一站: P3 语言正则修复 + 命名诚实性（用户可感知，优先级高于拆文件）
之后:   P2 server.ts 按域拆（每周 1–2 个域，穿插正常 feature 开发）
随手:   P1 尾巴（personal-dispatcher / L3 条件测试）+ P4 各项跟随所属模块的 PR
```

依赖关系：P2 拆分的安全网（smoke 测试）已就位 ✅；P3 语言正则是唯一正在静默失效的用户可见 bug，提前于拆分。
