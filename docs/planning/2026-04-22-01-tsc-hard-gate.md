---
title: TSC Hard Gate — Residual Type Debt Clustering
status: planning
owner: Codex
created: 2026-04-22
last_updated: 2026-04-22
predecessors:
  - docs/planning/2026-04-21-06-ai-sdk-type-debt.md
  - docs/planning/2026-04-21-04-pre-phase-3-checklist.md
  - docs/review/2026-04-21-opus-4-7-round-3.md
  - commit f40c5d3
threat_surface_delta:
  new_ingress:
    - source: local `bunx tsc --noEmit` diagnostics from packages/agent-core
      trust: trusted
      mitigations: [local-readonly-analysis, no-runtime-impact, compare-against-2026-04-21-baseline]
  new_egress: []
  new_persistence:
    - location: .logs/2026-04-22-tsc-hard-gate.txt
      sensitive: [typescript compiler diagnostics, repo file paths]
      migration: none
    - location: docs/planning/2026-04-22-01-tsc-hard-gate.md
      sensitive: [cluster plan, residual debt inventory]
      migration: none
---

# TSC Hard Gate — Residual Type Debt Clustering

## 目标

把 `packages/agent-core` 当前 `bunx tsc --noEmit` 的剩余错误重新做一次**完整实证 + 模块聚类**，为后续 `chore/tsc-hard-gate` cluster 提供可执行的清债顺序。本文档**只做规划**：归档原始输出、划分 cluster、定义落地路径，不改 CI 配置、不清理任何类型债。

## Probe

- 运行命令：`cd packages/agent-core && bunx tsc --noEmit --pretty false`
- 运行日期：2026-04-22
- 退出码：`2`
- 原始输出归档：`.logs/2026-04-22-tsc-hard-gate.txt`
- 输出规模：`61 errors / 6 files / 148 log lines`

### 按文件分布

| 文件 | 错误数 | 主错误码 |
|---|---:|---|
| `src/llm/client.test.ts` | 22 | `TS2352` ×20, `TS2578` ×2 |
| `src/llm/client.ts` | 12 | `TS2339` ×10, `TS2345` ×2 |
| `src/repl.test.ts` | 12 | `TS2740` ×12 |
| `src/index.test.ts` | 7 | `TS2345` ×4, `TS2352` ×3 |
| `src/llm/cache-adapter.ts` | 7 | `TS2322` ×4, `TS1360` ×3 |
| `src/index.ts` | 1 | `TS2353` ×1 |

### 按错误码分布

| 错误码 | 数量 | 含义摘要 |
|---|---:|---|
| `TS2352` | 23 | 测试 fixture / cast 与 AI SDK v6 结果类型不兼容 |
| `TS2740` | 12 | mock provider 缺少 `OpenAICompatibleProvider` 必需字段 |
| `TS2339` | 10 | `LanguageModel` 上直接访问 `provider` / `modelId` 已漂移 |
| `TS2345` | 6 | provider / invocation 参数与新签名不兼容 |
| `TS2322` | 4 | `ModelMessage` / `ToolResultOutput` shape 不兼容 |
| `TS1360` | 3 | `satisfies ModelMessage` 失败，联合类型窄化不足 |
| `TS2578` | 2 | 过期 `@ts-expect-error` |
| `TS2353` | 1 | `maxTokens` 不在当前 AI SDK 调用设置类型里 |

## Clusters

### Cluster A — LLM 生产路径类型漂移（20 errors）

**范围**：
- `src/llm/client.ts` (12)
- `src/llm/cache-adapter.ts` (7)
- `src/index.ts` (1)

**代表性错误**：
- `LanguageModel.provider` / `LanguageModel.modelId` 不再可直接访问
- `InvocationProviderOptions` 与 `SharedV3ProviderOptions` 不兼容
- `ModelMessage` / `ToolResultOutput` 联合类型不满足当前 AI SDK v6 约束
- `maxTokens` 字段名与当前 `CallSettings` 类型不匹配

**判断**：
- 这是**唯一会触及生产代码语义**的 cluster
- 不先修它，测试 cluster 只能继续靠猜测 mock shape

**建议顺序**：第一个处理

### Cluster B — AI SDK v6 结果类型 fixture 漂移（22 errors）

**范围**：
- `src/llm/client.test.ts` (22)

**代表性错误**：
- `GenerateTextResult` / `StreamTextResult` fixture shape 缺 `content` / `reasoningText` / `files` / `sources`
- 两条过期 `@ts-expect-error`

**判断**：
- 本质是**测试 fixture 跟不上 AI SDK v6 返回结构**
- 依赖 Cluster A 的真实调用契约先稳定，再集中改 fixture helper 最省

**建议顺序**：第二个处理

### Cluster C — Provider mock contract 漂移（19 errors）

**范围**：
- `src/repl.test.ts` (12)
- `src/index.test.ts` (7)

**代表性错误**：
- `Mock<Procedure>` / `MockInstance<...>` 不再满足 `OpenAICompatibleProvider`
- 缺 `languageModel` / `chatModel` / `completionModel` / `embeddingModel` 等 provider contract 字段

**判断**：
- 这是**测试入口层 mock 形状**的系统性问题
- 最优解大概率是抽一个共享 `mock-provider` fixture，而不是每个测试各自补 cast

**建议顺序**：第三个处理，可与 Cluster B 局部并行，但最好在 Cluster A 之后

## 与旧 cluster 的关系

### 2026-04-21 基线

旧 tracking doc [2026-04-21-06-ai-sdk-type-debt.md](/Users/raysonmeng/repo/quilin-agent/docs/planning/2026-04-21-06-ai-sdk-type-debt.md) 记录：

- 初始基线：`89 errors / 15 files`
- `f40c5d3` 已关闭旧 **Cluster 2 / 3 / 4**
- 剩余 `61 errors` 被整体归为旧 **Cluster 1（AI SDK v6 漂移）**

### 2026-04-22 重分组

本次没有发现新的债务类别；只是把旧 **Cluster 1** 拆成更可执行的 3 个 work clusters：

| 旧 cluster | 当前状态 | 新 work cluster |
|---|---|---|
| Cluster 1 — AI SDK v6 漂移 | 仍然打开 | A 生产路径 / B 结果 fixture / C provider mock |
| Cluster 2 — Bun fetch / Request 类型 | 已由 `f40c5d3` 关闭 | 不再进入本计划 |
| Cluster 3 — cast / 窄化不足 | 已由 `f40c5d3` 关闭 | 不再进入本计划 |
| Cluster 4 — 测试小修 | 已由 `f40c5d3` 关闭 | 不再进入本计划 |

## Phases

| # | 名称 | 状态 | Owner | Commit | 备注 |
|---|---|---|---|---|---|
| 0 | Probe + raw output archive + clustering | completed | Codex | — | 2026-04-22，`61 errors / 6 files / 3 work clusters` |
| 1 | CI config-only report | pending | Codex | — | 加 `tsc --noEmit` 非阻塞报告，不设 required |
| 2 | Clear Cluster A | pending | Codex | — | 先修生产路径契约 |
| 3 | Clear Cluster B | pending | Codex | — | 统一测试 fixture 到 AI SDK v6 结果 shape |
| 4 | Clear Cluster C | pending | Codex | — | 抽共享 provider mock helper |
| 5 | Enable hard gate required | pending | Codex | — | 仅在 clusters A/B/C 清零后开启 |

### Phase 0 — Probe + raw output archive + clustering

- **做什么**：
  - 运行完整 `bunx tsc --noEmit`
  - 归档原始输出到 `.logs/2026-04-22-tsc-hard-gate.txt`
  - 统计错误总量、按文件分布、按错误码分布
  - 基于旧 `2026-04-21-06-ai-sdk-type-debt.md` 把 residual debt 拆成新的 work clusters
- **不做什么**：
  - 不改 CI 配置
  - 不修任何类型错误
  - 不改 AI SDK 版本 / Bun 版本 / tsconfig
- **威胁面 delta**：
  - 新增 ingress：本地 TypeScript 诊断输出
  - 新增 egress：无
  - 新增 persistence：`.logs/2026-04-22-tsc-hard-gate.txt`、本 tracking doc
  - 缓解措施：只读分析、无运行时改动、与 2026-04-21 基线对比
- **依赖**：无
- **验证**：
  - 原始输出可复查
  - 61 条错误全部被 cluster 覆盖
  - 能说明与旧 Cluster 2/3/4 的关系
- **产出**：
  - `.logs/2026-04-22-tsc-hard-gate.txt`
  - `docs/planning/2026-04-22-01-tsc-hard-gate.md`

### Phase 1 — CI config-only report

- **做什么**：
  - 在 CI 中新增 `tsc --noEmit` 报告步骤，但先不设为 blocking gate
  - 产出 artifact 或 stdout 摘要，保证每次 PR 都能看到错误数变化
- **不做什么**：
  - 不设 required
  - 不在本 phase 清理任何 cluster
- **依赖**：Phase 0
- **验证**：CI 能稳定输出 tsc report，且不阻塞合并
- **产出**：CI config 变更 + report 产出约定

### Phase 2 — Clear Cluster A

- **做什么**：
  - 对齐 `client.ts` / `cache-adapter.ts` / `index.ts` 的 AI SDK v6 生产路径类型
  - 固化 provider / model metadata 的访问方式
- **不做什么**：
  - 不在本 phase 顺手重写所有测试 fixture
- **依赖**：Phase 0；最好在 Phase 1 之后
- **验证**：Cluster A 归零，且不引入运行时行为漂移
- **产出**：独立 PR

### Phase 3 — Clear Cluster B

- **做什么**：
  - 重写 `src/llm/client.test.ts` fixture，使其符合 AI SDK v6 `GenerateTextResult` / `StreamTextResult`
  - 清理失效 `@ts-expect-error`
- **不做什么**：
  - 不在本 phase 处理 `repl.test.ts` / `index.test.ts` provider mock
- **依赖**：Phase 2
- **验证**：Cluster B 归零
- **产出**：独立 PR

### Phase 4 — Clear Cluster C

- **做什么**：
  - 为 `repl.test.ts` / `index.test.ts` 抽共享 provider mock helper
  - 把 provider contract 从 ad-hoc mock 收敛为统一 fixture
- **不做什么**：
  - 不再回头改生产代码
- **依赖**：Phase 2；建议在 Phase 3 之后做
- **验证**：Cluster C 归零
- **产出**：独立 PR

### Phase 5 — Enable hard gate required

- **做什么**：
  - 把 CI 中的 `tsc --noEmit` 从 report-only 切为 required hard gate
- **不做什么**：
  - 不把“还有 residual debt”时的红灯硬塞给无关 PR
- **依赖**：Phase 1-4 完成
- **验证**：主分支 `tsc --noEmit` 稳定为 0 errors
- **产出**：CI gate 开启

## Decisions

### 2026-04-22 — 不把 CC-03 混入 B3b Phase 0

- **Before**：B3b Phase 0 一度尝试并行把 `@types/bun` pin + CI `tsc --noEmit` gate 一起落下
- **After**：CC-03 从 B3b Phase 0 剥离，单开 `tsc-hard-gate` tracking doc
- **证据**：`bc93f42` 只提交 `skills/*` 五个文件；`bunx tsc --noEmit` 当前仍有 61 条既有错误，若直接落 hard gate 会污染 skills phase 边界

### 2026-04-22 — 旧 Cluster 1 继续拆成 3 个 work clusters

- **Before**：旧文档把剩余 61 errors 统称为 “Cluster 1 — AI SDK v6 漂移”
- **After**：保留“它们都属于旧 Cluster 1”的事实，但在执行上拆成 A/B/C 三个 work clusters
- **证据**：2026-04-22 实测只剩 6 个文件，天然分成生产路径、结果 fixture、provider mock 三组

## Open Questions

- [ ] Phase 1 的 config-only report 用 CI artifact 还是 stdout 摘要更合适？
- [ ] Cluster B 和 Cluster C 是否值得并行，还是统一等 Cluster A 契约稳定后顺序推进？
- [ ] `src/index.ts` 的 `maxTokens` 命名漂移是否应该单独拉成一个极小 PR，还是跟 Cluster A 一起收？

## Blockers

- 无硬 blocker。当前只缺用户/Claude 对 cluster 划分和 Phase 1 report 方案的确认。

## Next Action

Claude / 用户 review 本文档的 cluster 划分；确认后再开 `chore/tsc-hard-gate` 的 Phase 1（CI report-only），不提前动 hard gate。
