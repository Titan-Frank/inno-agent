# 代码质量整改计划（2026-08）

> 来源：2026-08-09 全仓库质量审核。审核结论经逐项核实（server.ts 实际 5,295 行、17 个测试文件中 9 个集中于 memory/l2、CI 只 build 不跑测试、xlsx 走 CDN tarball、axios 直接依赖零 import、jiti 出现在 4 个文件、scheduler 三处时区硬编码）。
>
> 状态图例：✅ 已完成 / 🚧 进行中 / ⬜ 未开始
>
> 进度速览：**P0 已合并（PR #133），P1 主体已合并（PR #134），P3 已合并（PR #135），P2 ✅ 完成（11 个域全部拆出：#136–#146，server.ts 5295→1608 行，-70%）**。

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

## P2 · server.ts 拆分 ✅ 完成（11 个域，PR #136–#146）

判断标准：它是全仓库改得最多、历史 bug 最密集的文件（队列焊死、SSE 重连都在这里），值得拆。

打法是沿路由域机械抽取，每一步保持 build + P1.3 smoke 测试绿：

```
src/server/
  http-helpers.ts     # ✅ readBody / json / matchRoute（原样搬家）
  file-helpers.ts     # ✅ 纯文件/路径 helper（safeJoin、contentDispositionAttachment、WORKSPACE_IGNORES 等）
  routes/jobs.ts      # ✅ /api/jobs* 全部 8 个路由块（handleJobsRoutes → boolean）
  routes/channels.ts  # ✅ /api/channels* + /api/bridge/*（PR #137,QR 登录的可变状态走 getter/setter ctx）
  routes/settings.ts  # ✅ /api/settings* + /api/mcp*（PR #138,含 buildSafeSettings 等 6 个域私有 helper）
  routes/skills.ts    # ✅ /api/skills/* + /api/skill-library/*（PR #139）
  routes/workspaces.ts # ✅ /api/workspace/* + /api/workspaces + 会话↔工作区绑定（PR #140,含 PPTX→SVG 转换器家族）
  routes/chat.ts      # ✅ /api/chat/* 含 SSE + 事件回放（PR #146,最后一块）
  routes/sessions.ts  # ✅ /api/sessions/*（PR #141,含 showcase-export;共享类型落 server/session-model.ts）
  routes/learner.ts   # ✅ /api/learner/*（PR #142）
  routes/wiki.ts      # （上方已列）/api/wiki/* + /api/l2/raw/upload（PR #143）
  routes/presets.ts   # ✅ /api/presets + /api/preset-library（PR #144）
  routes/practice.ts  # ✅ /api/terminal/sessions* + /api/runs*（PR #145;PTY WebSocket 留在 server.ts）
  session-model.ts    # ✅ 会话摘要/元数据共享类型（PR #141 建立）
  ~~context.ts~~      # 未建——各域 ctx 接口各自声明即够用
```

进度：server.ts 5295 → 1608 行（-3687,‑70%）。11 个域全部落位：jobs（#136）、channels（#137）、settings/mcp（#138）、skills（#139）、workspaces（#140）、sessions（#141）、learner（#142）、wiki（#143）、presets（#144）、practice（#145）、chat（#146）。server.ts 剩余：bootstrap、渠道接线/热重载、队列 helper、技能安装器、静态/SPA 服务、终端 WebSocket upgrade、11 行委托。测试 24 文件 / 175 用例全绿。模式已定型：每域一个 `handle<Domain>Routes(req, res, method, url, ctx): Promise<boolean>`，可变模块状态（config、wechatChannel）经 getter/setter 注入，server.ts 在原位置留一行委托。

约束：
- **禁止顺手重构**。每个 PR 只移动一个路由域，diff 应为纯 cut-paste + import 调整。
- 共享状态经 ctx 显式传参，不引入 DI 框架。
- 拆完后各路由域独立可测，测试再逐步下沉。

## P3 · 模型与命名的诚实性 ✅ 已合并（PR #135）

共同点："演示能跑、泛化不行"。修法不是换更强算法，而是让系统声称的和做的一致。

**L1 掌握度模型** ✅（最小修路线）
- ✅ 固定增量收敛为命名常量 `MASTERY_DELTAS`（auto-profile.ts），附 HONESTY NOTE 注释：无遗忘曲线、无题目难度，分数仅用于排序。
- ✅ `KnowledgeState.mastery/confidence/stability` 三个字段加 JSDoc 标注启发式、非概率。
- ✅ **四语言正则 bug 已修**：`targetMatchesGoal`/`targetMatchesKnowledge` 的 rust/c++/python/typescript 硬编码正则替换为通用主题匹配（提取拉丁 token ≥2 字符 + CJK bigram，意图词先剥离；2 字符 token 要求词边界防 "go" 误配 "good"）。新增 `auto-profile.test.ts` 9 个用例覆盖：非编程主题归档（"不再学习吉他"→"吉他入门"）、部分匹配、"go"/"good" 边界、知识点联动归档、幂等性。
- ⬜ 彻底修（简化 BKT/Elo）暂缓——等最小修实际用起来再评估。

**"语义检索"** ✅（诚实路线）
- ✅ `semantic-chunker` → `structural-chunker`（文件、符号、测试全改），其 doc 注释本就如实描述"按标题/段落/句读切分"。
- ✅ l2-search.ts 图扩展权重处加注释：分数未标定、仅排序有效、跨查询不可比，质量回归靠 eval 阈值兜底。
- ⬜ 能力路线（真 embedding 检索）暂缓：PI SDK 无 embedding API，需自接 provider 端点 + sqlite 向量表（schema 已预留），等真有检索质量投诉再做。

## P4 · 小坑批量修（各随所属模块的 PR 带走）

- ✅ **时区**：`config.json` 加 `scheduler.timezone`（`normalizeSchedulerConfig`，默认 `Asia/Shanghai` 收敛为 `cron-utils.ts` 的 `DEFAULT_SCHEDULER_TIMEZONE` 常量）；`JobStore` 构造参数 `defaultTimezone`（public readonly），server.ts / inno-extension.ts / scheduler-tools.ts 三处全部改读配置。
- ✅ **runCount 竞态**：`JobStore.mutate(id, mutator)` —— per-job promise chain 串行化，mutator 拿链内重读的最新状态；语义（updatedAt、nextRunAt 重算）与 `update()` 完全一致。job-runner.ts 三处计数器更新全部改用 mutate。
- ✅ **jsonl 只增不减**：`appendJsonl(path, record, { maxBytes })` 超阈值先滚动为时间戳 `.archive` 再追加（best-effort，失败不掉记录）；新增 `readJsonlTail(path, maxBytes)`（窗口首行残缺即丢）。runs.jsonl / events.jsonl / channel run-log 10MB 滚动；listRuns / run-log list 改 1MB tail 读。dedupe.jsonl（TTL 活状态，滚动会丢去重）与 manifest 不动。
- ✅ **jiti 加载他包内部 .ts（定时炸弹）**：`pi-mcp-adapter` 与 `pi-sandbox` 都是 TS-source-only 包（exports → `./index.ts`），全部钉死精确版本（去 `^`）；三处 jiti 调用点本就有 try-catch 降级，警告文案补上"版本被改动是首要嫌疑"的提示。中期给上游提 PR 加编译产物入口仍是根治方向。
- ✅ **xlsx**：CDN tarball 下载后 vendor 进 `vendor/xlsx-0.20.3.tgz`（sha512 与 lockfile 原记录逐字节一致），root devDependencies + overrides `$xlsx`、web `file:../../../vendor/...` 指向本地，离线安装不再即挂。exceljs 迁移（API 不同、preview 代码要改）不做。

## P5 · 明确不修，但要写下来

- **单进程单 AgentSession**：README「设计哲学」加 "Non-goals" 一节：不追求多用户并发、不水平扩展、会话切换靠文件换载。同时确认 #124 的 409 `session_busy` 机制覆盖所有跨会话切换路径。

---

## 执行顺序

```
✅ P0 全部（PR #133）
✅ P1.1 web DOM 环境 + P1.3 server.ts smoke 测试 + P1.2 首批（PR #134）
✅ P3 语言正则修复 + 命名诚实性（PR #135）
✅ P2 server.ts 按域拆完（PR #136–#146,一次性连续完成）
✅ P4 时区可配 + runCount 竞态 + jsonl 滚动（PR #147）
✅ P4 依赖卫生：pi-mcp-adapter/pi-sandbox 钉版本 + xlsx vendoring（chore/p4-dependency-hygiene）
下一站: P1 尾巴（personal-dispatcher / L3 条件测试）+ P5 README Non-goals
```

依赖关系：P2 拆分的安全网（smoke 测试）已就位 ✅；P3 语言正则（唯一正在静默失效的用户可见 bug）已修 ✅。
