---
title: AI SDK v6 + Bun Types — 遗留类型债清单
status: planning
owner: Claude (起草) + human (终审) + 未来 Codex PR
created: 2026-04-21
last_updated: 2026-04-22 (Task A done — Cluster 2/3/4 closed; residual re-clustered into successor doc)
threat_surface_delta:
  new_ingress: []
  new_egress: []
  new_persistence: []
---

# AI SDK v6 + Bun Types 遗留类型债

## 背景

Gate C.2（2026-04-21）把 `tsconfig.base.json` 的 `"types": ["bun-types"]` 改为 `packages/agent-core` 本地 `"types": ["bun"]` + 安装 `@types/bun` 之后，初始实测仍失败 **89 个错误**。这些错误**不是本次引入的**，而是原本被 `bun-types` 错误配置（包未安装）**遮蔽**的既有技术债。

本次 Gate C.2 提交（commit `0464377`）不试图闭合这 89 条错误；本文档作为 residual tracking，列出初始全量错误、分类根因与建议修复窗口。随后 `f40c5d3` 已关闭旧 Cluster 2/3/4，把 residual 从 **89 → 61**；其后继拆分与执行顺序见 `docs/planning/2026-04-22-01-tsc-hard-gate.md`。

## 总规模

`pnpm --filter @quilin/agent-core exec tsc --noEmit` 输出 **89 errors** across **15 files**（2026-04-21 初始基线）。

**2026-04-21 Task A 收束后**：Cluster 2/3/4 全部关闭，剩 **61 errors**，全部属于旧 Cluster 1（AI SDK v6 漂移），见 commit `f40c5d3`。该旧 Cluster 1 已在 2026-04-22 被重新拆成 3 个 work clusters（A/B/C），后继 tracking 见 `docs/planning/2026-04-22-01-tsc-hard-gate.md`。

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

### Cluster 2 — Bun strict fetch / Request 类型（~9 errors）✅ 2026-04-21 Task A 关闭

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

**实际修复（2026-04-21 Task A）**：
- `web-fetch.ts:467`：`satisfies FetchRequestInit` → `as FetchRequestInit as RequestInit`（保留 dispatcher 字段给 undici，不改运行时语义）
- `Fetcher` 类型从 `typeof fetch` 窄化为 `(input, init?) => Promise<Response>`，去掉对 `preconnect` 的依赖（生产路径只调用函数，不访问 preconnect）
- `web-fetch.test.ts:184` 签名参数补 `string | URL | Request`
- `integration.test.ts:103` 随 Fetcher 类型收敛自动解决
- bonus `integration.test.ts:223` recallExecute 改为 `(args: unknown)` + 内部 narrow

---

### Cluster 3 — Type cast / 联合类型窄化不足（~10 errors）✅ 2026-04-21 Task A 关闭

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

**实际修复（2026-04-21 Task A）**：
- `checkpoint.ts:76/100`：`as AgentState` → `as unknown as AgentState`（advisor 建议：不改 runtime 语义，仅满足 TS 双重 cast 要求，避免误引入 zod 解码破坏 prod checkpoint resume）
- `schema-converter.ts`：`array` / `object` 两个 case 局部 cast 到具体 schema 类型（`JsonSchemaArray` / `JsonSchemaObject`），并把 `Set` 显式标注为 `Set<string>` 解决 `ReadonlySet<string>` 类型匹配
- `mcp-client.ts:387`：`withTimeout<CallToolResult>(...)` 显式泛型 + SDK 返回值 `as Promise<CallToolResult>` cast，收敛到 CallToolResult shape（SDK 返回 `CallToolResult | CompatibilityCallToolResult` union）

---

### Cluster 4 — 测试小修（~7 errors）✅ 2026-04-21 Task A 关闭

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

**实际修复（2026-04-21 Task A）**：
- `loop.test.ts:258 / 318`：删除已过期的 `// @ts-expect-error Phase 2 adds an assistant-message hook for REPL state sync.`（Phase 2 LoopHooks 已正式类型化 `onAssistantMessage`，directive 变成 TS2578 噪音；已核验删除不掩盖其他错误）
- `loop.test.ts:1785 / 1866` recordSpan callback 参数补类型注解 `(name: string, attributes?: Record<string, unknown>)`（对齐 `LoopHooks.recordSpan` 签名）
- `repl.test.ts:126`：UUID literal 从 `"generated-session-id"` 改为合法 UUID `"00000000-0000-0000-0000-000000000000"`，两处断言（L196 / L205）同步替换
- `write-authority.test.ts:24`：导入 `WriteAuthorityOptions` 类型，用 `WriteAuthorityOptions["mode"]` 替代 `ConstructorParameters<typeof WriteAuthority>[0]["mode"]`（constructor 默认参数 `= {}` 使 `ConstructorParameters[0]` 推成 `WriteAuthorityOptions | undefined`，无法索引 `.mode`）

## 修复优先级 & 路径建议

| 优先级 | Cluster | 修复窗口 | 估工 | 说明 |
|---|---|---|---|---|
| ~~P0~~ ✅ done | 2 + 3 + 4 | 2026-04-21 Task A | 0.5 天（实际约 1h） | 清掉 28 errors（含 bonus），tsc 89 → 61；全部剩余属 Cluster 1 |
| P1 | 1（AI SDK） | **Iter D 开始前** | 1-2 天（或更多） | 需要查 v6 migration，可能触发 ADR 讨论；是最大块 |

## Open Questions

- [ ] AI SDK v6 是否已稳定？是否需要 pin minor 版本锁定类型 API？
- [x] ~~`packages/agent-core/src/tools/builtin/web-fetch.ts:467` 的 `dispatcher` 到底是为什么用？删了会不会破坏 proxy 逻辑？~~ → Task A 保留 dispatcher，用 `as FetchRequestInit as RequestInit` 让 undici 继续接收该字段（dispatcherFactory 本就通过 L452 构造，用于 IP-pinned 代理）
- [ ] `tsc --noEmit` 是否要进 CI 作为 blocking gate？如果是，Cluster 1 必须在 CI 上线前修完

## Next Action

1. ~~本文档 commit 后，**在 commit 2 message 里明确引用**~~（已完成）
2. ~~Iter B 收束 PR 或下次 Codex 会话起草 Cluster 2/3/4 的修复 PR（目标：tsc errors 89 → ~63）~~ → **2026-04-21 Task A 已完成，实际 89→61**
3. Cluster 1 列为 Iter D kickoff 的 pre-work，和 Memory Sprint 0 并列

## Decisions

### 2026-04-21 — 不在 Gate C.2 commit 里修 89 errors

- **Before**：原计划 Gate C.2 = `"restore tsc baseline"`（让 tsc --noEmit 转绿）
- **After**：拆 `bun-types` 伪装后暴露 89 错既有债，规模过大不适合混入 Gate A + Gate C.2 commit
- **证据**：`pnpm --filter @quilin/agent-core exec tsc --noEmit` 返回 89 errors；分类后 63 属于 AI SDK 深层漂移（需要独立 migration 讨论）
- **后果**：commit 2 subject 撤回 "restore tsc baseline"，改为如实描述；本文档作为 residual tracking

### 2026-04-21 Task A — Cluster 2/3/4 关闭

- **变更**：tsc 错误 89→61（-28，含 integration.test.ts:223 bonus）；测试 266/267 持平（红灯是 Cluster 1 既有 web-fetch 老债，本次未触碰）
- **原则**：advisor 审计下三条硬约束：(1) 不扩散到 Cluster 1；(2) 不引入运行时语义变化（dispatcher 保留、checkpoint runtime 不解码）；(3) 不写新的测试文件（D-03 属于 D 的 follow-up，不是 A 的范围）
- **证据**：commit `f40c5d3`；`pnpm --filter @quilin/agent-core exec tsc --noEmit 2>&1 | grep -cE "error TS"` = 61
