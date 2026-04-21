---
title: AI SDK v6 + Bun Types — 遗留类型债清单
status: planning
owner: Claude (起草) + human (终审) + 未来 Codex PR
created: 2026-04-21
last_updated: 2026-04-21
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# AI SDK v6 + Bun Types 遗留类型债

## 背景

Gate C.2（2026-04-21）把 `tsconfig.base.json` 的 `"types": ["bun-types"]` 改为 `packages/agent-core` 本地 `"types": ["bun"]` + 安装 `@types/bun` 之后，`tsc --noEmit` 仍然失败 **89 个错误**。这些错误**不是本次引入的**，而是原本被 `bun-types` 错误配置（包未安装）**遮蔽**的既有技术债。

本次 Gate C.2 提交（commit `TBD`）不试图闭合这 89 条错误；本文档作为 residual tracking，列出**所有剩余错误**、分类根因、建议修复窗口，转由未来专项 PR 处理。

## 总规模

`pnpm --filter @quilin/agent-core exec tsc --noEmit` 输出 **89 errors** across **15 files**。

## 4 类根因

### Cluster 1 — AI SDK v6 LanguageModel / Provider 类型漂移（~63 errors）

**症状**：
- `Property 'provider' does not exist on type 'LanguageModel'. Property 'provider' does not exist on type 'string & {}'.`
- `Type 'MockInstance<Procedure>' is missing the following properties from type 'OpenAICompatibleProvider<string, string, string, string>': languageModel, chatModel, completionModel, embeddingModel, and 3 more.`

**根因假设**：AI SDK v6 对 `LanguageModel` / `OpenAICompatibleProvider` 的类型签名做了演进，`provider` 从直接属性访问变成了联合类型（或需要 narrowing），`Provider` 接口新增了 `languageModel` / `chatModel` / 等 7 个方法。当前代码按旧 API 写，当前 mock 也按旧形状。

**影响文件**：
| 文件 | 错误数 |
|---|---|
| `src/llm/client.ts` | 12 |
| `src/llm/client.test.ts` | 22 |
| `src/llm/cache-adapter.ts` | 7 |
| `src/repl.test.ts` | 14 |
| `src/index.test.ts` | 7 |
| `src/index.ts` | 1 |

**建议修法**：
1. 查 AI SDK v6 changelog / migration guide，确认 `LanguageModel.provider` 新访问路径
2. 在 `client.ts` / `cache-adapter.ts` 生产代码先修
3. 所有测试 mock 重写为 full `OpenAICompatibleProvider` shape（或用 `satisfies` + `Partial`）
4. 增加一个 `__tests__/fixtures/mock-provider.ts` helper，避免 N 个测试各自 mock

**修复窗口建议**：**Iter D 开始前**专项 PR（估工 1-2 天）。如果 AI SDK 演进太大，考虑 pin 到 v6 的某个 minor 版本或 ADR-004 评估是否切 provider 抽象。

---

### Cluster 2 — Bun strict fetch / Request 类型（~9 errors）

**症状**：
- `Property 'preconnect' is missing in type 'MockInstance<...>' but required in type 'typeof fetch'.`
- `Object literal may only specify known properties, and 'dispatcher' does not exist in type 'RequestInit' / 'BunFetchRequestInit'.`

**根因**：`@types/bun` 的 `fetch` 接口比 `@types/node` 更严格，要求 `preconnect` 方法；生产代码里用的 `dispatcher`（undici-specific）在 Bun 的 `RequestInit` 里不存在。

**影响文件**：
| 文件 | 错误数 |
|---|---|
| `src/tools/builtin/web-fetch.ts` | 1（生产代码 `dispatcher`） |
| `src/tools/builtin/web-fetch.test.ts` | 7（Mock 缺 `preconnect`） |
| `src/tools/integration.test.ts` | 2 |

**建议修法**：
1. 生产代码：`dispatcher` 改用条件编译或 runtime detection（Bun vs Node 分路），或者用 `as RequestInit & { dispatcher?: unknown }` 逃逸
2. 测试 mock：helper `createFetchMock()` 返回完整 `typeof fetch` shape，含 stub 版 `preconnect`

**修复窗口**：Gate A 稳定后 1-2 天内可做。小改动、边界清楚。

---

### Cluster 3 — Type cast / 联合类型窄化不足（~10 errors）

**症状**：
- `Conversion of type 'Record<string, unknown>' to type 'AgentState' may be a mistake because neither type sufficiently overlaps with the other.`
- `Property 'items' does not exist on type 'JsonSchemaBase | JsonSchemaArray'. Property 'items' does not exist on type 'JsonSchemaBase'.`
- `Property 'content' is missing in type '{ ...; toolResult: unknown; ...}' but required in type '{ ...; content: ... }'.`

**根因**：代码里的类型强转不够谨慎；schema-converter 里对 JSON Schema 的 union 类型没有按 discriminator 窄化；MCP client 的 response 类型和 SDK 定义的 shape 不完全匹配。

**影响文件**：
| 文件 | 错误数 |
|---|---|
| `src/state/checkpoint.ts` | 2 |
| `src/tools/schema-converter.ts` | 5 |
| `src/tools/mcp-client.ts` | 3 |

**建议修法**：
- `checkpoint.ts`：用 type guard（或 `zod` schema）替代 `as AgentState`
- `schema-converter.ts`：在 switch 上用 `type: 'array' | 'object'` discriminator 做窄化
- `mcp-client.ts`：和 MCP SDK 对齐 `ToolResult` 的实际 return shape（可能是 SDK 版本漂移）

**修复窗口**：随手做，每个文件 10-30 分钟。

---

### Cluster 4 — 测试小修（~7 errors）

**症状**：
- `Unused '@ts-expect-error' directive.`
- `Parameter 'name' implicitly has an 'any' type.`
- `Argument of type '"generated-session-id"' is not assignable to parameter of type '\`${string}-${string}-${string}-${string}-${string}\`'.`（UUID template literal）
- `Property 'mode' does not exist on type 'WriteAuthorityOptions | undefined'.`

**影响文件**：
| 文件 | 错误数 |
|---|---|
| `src/loop.test.ts` | 6 |
| `src/safety/write-authority.test.ts` | 1 |
| `src/repl.test.ts` | 1（UUID） |

**建议修法**：
- 删过期的 `@ts-expect-error`
- 给 callback 参数加类型注解
- 用合法的 UUID literal 或 `as` 强转
- `WriteAuthorityOptions` 的 `mode` 访问前加 narrowing

**修复窗口**：1 小时内。可以作为独立小 PR 清理。

## 修复优先级 & 路径建议

| 优先级 | Cluster | 修复窗口 | 估工 | 说明 |
|---|---|---|---|---|
| P0 | 2 + 3 + 4 | **Iter B 收束前或 Iter C 启动时** | 0.5-1 天 | 低风险、边界小，清掉能让 tsc 从 89 → 63 |
| P1 | 1（AI SDK） | **Iter D 开始前** | 1-2 天（或更多） | 需要查 v6 migration，可能触发 ADR 讨论；是最大块 |

## Open Questions

- [ ] AI SDK v6 是否已稳定？是否需要 pin minor 版本锁定类型 API？
- [ ] `packages/agent-core/src/tools/builtin/web-fetch.ts:467` 的 `dispatcher` 到底是为什么用？删了会不会破坏 proxy 逻辑？
- [ ] `tsc --noEmit` 是否要进 CI 作为 blocking gate？如果是，Cluster 1 必须在 CI 上线前修完

## Next Action

1. 本文档 commit 后，**在 commit 2 message 里明确引用**：`See docs/planning/2026-04-21-06-ai-sdk-type-debt.md for residual 89 tsc errors, split into 4 clusters.`
2. Iter B 收束 PR 或下次 Codex 会话起草 Cluster 2/3/4 的修复 PR（目标：tsc errors 89 → ~63）
3. Cluster 1 列为 Iter D kickoff 的 pre-work，和 Memory Sprint 0 并列

## Decisions

### 2026-04-21 — 不在 Gate C.2 commit 里修 89 errors

- **Before**：原计划 Gate C.2 = `"restore tsc baseline"`（让 tsc --noEmit 转绿）
- **After**：拆 `bun-types` 伪装后暴露 89 错既有债，规模过大不适合混入 Gate A + Gate C.2 commit
- **证据**：`pnpm --filter @quilin/agent-core exec tsc --noEmit` 返回 89 errors；分类后 63 属于 AI SDK 深层漂移（需要独立 migration 讨论）
- **后果**：commit 2 subject 撤回 "restore tsc baseline"，改为如实描述；本文档作为 residual tracking
