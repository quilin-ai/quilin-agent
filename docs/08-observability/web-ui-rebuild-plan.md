# Web UI 重建规划 / Web UI Rebuild Plan

> **Linear**: [QUI-154](https://linear.app/quilin-agent/issue/QUI-154) · supersedes [QUI-105](https://linear.app/quilin-agent/issue/QUI-105)
> **Status**: Phase 1 planning · awaiting user signoff before scaffold
> **Last updated**: 2026-05-12

English: This document is the implementation plan for QUI-154 — replacing the legacy QUI-105 Web UI (vanilla JS + Web Components, 7-panel observability dashboard) with a production-grade Next.js 15 + React 19 + AI Elements + shadcn/ui frontend at `apps/web/`, wired to a typed v2 control-plane API.

中文：本文档是 QUI-154 的实现规划——用一套生产级的 Next.js 15 + React 19 + AI Elements + shadcn/ui 前端（`apps/web/`）替换旧版 QUI-105 Web UI（vanilla JS + Web Components 的 7-panel observability dashboard），接到类型化的 v2 control-plane API 上。

English: The visual design has been locked in a static preview at `.claude/worktrees/webui-rewrite/apps/web-demo/index.html`. This plan covers backend contracts, frontend scaffold structure, phased delivery, migration strategy, test discipline, and the cross-review loop.

中文：视觉设计已经在静态预览 `.claude/worktrees/webui-rewrite/apps/web-demo/index.html` 中锁定。本规划覆盖后端契约、前端脚手架结构、分阶段交付、迁移策略、测试纪律、以及 cross-review 循环。

---

## 一、范围 / Scope

English: Phase 1 delivers only the foundation — a Next.js scaffold, the v2 control-plane API, and a single end-to-end vertical (sessions page). Phases 2-7 surface the remaining 9-tier inventory: self-evolution governance, planning intelligence, multi-agent lifecycle, safety surfaces, memory depth, observability traces, multimodal tools.

中文：Phase 1 只交付地基——Next.js 脚手架、v2 control-plane API、一个端到端切片（会话页）。Phase 2-7 逐步上 9 类盘点剩余面：自演化治理、规划智能、多代理生命周期、安全面、记忆深度、可观测 trace、多模态工具。

English: The legacy dashboard code (`packages/agent-core/src/observability/dashboard-ui/`, `dashboard-page.ts`, `control-plane/handler.ts` `/api/dashboard/*` routes) stays in tree as historical evidence until the new app reaches feature parity. Phase 1 does **not** delete it.

中文：旧版 dashboard 代码（`packages/agent-core/src/observability/dashboard-ui/`、`dashboard-page.ts`、`control-plane/handler.ts` 的 `/api/dashboard/*` 路由）保留为历史证据，直到新版达到功能对等。Phase 1 **不**删除它。

---

## 二、技术栈 / Tech Stack

| 层 / Layer | 选型 / Choice | 理由 / Reason |
|---|---|---|
| 框架 / Framework | **Next.js 15** App Router | AI SDK v6 一等公民集成 · Server Components 流式 SSR · 与现有 pnpm workspace 天然适配 |
| 运行时 / Runtime | **React 19** + **Bun** dev / **Node ≥22** prod | 已在 `package.json` 锁定 |
| AI 流式 / AI streaming | **`@ai-sdk/react` `useChat`** + **streamdown** | 与 backend `ai@^6.0.160` 同源 |
| AI 组件 / AI components | **Vercel AI Elements** (基于 shadcn/ui) | `Conversation` / `Message` / `Reasoning` / `Tool` / `Sources` / `Actions` 内置 primitive |
| UI 基座 / UI primitives | **shadcn/ui** + **Tailwind v4** | 按需 copy 组件 · 与 AI Elements 同栈 |
| 类型 / Types | **TypeScript strict** + **zod** schemas | 与现有 agent-core 同栈,API 契约 zod 单源 |
| Lint / Format | **Biome 2.x** | 与 agent-core 一致 |
| 测试 / Tests | **Vitest** + **Playwright** (e2e) | 与 agent-core 一致;e2e 用 Playwright (已在依赖中:`patchright`) |
| 状态管理 / State | RSC + `useChat` + `nuqs` (URL 状态) | 不引入额外 store |
| 字体 / Fonts | Cormorant Garamond + Noto Serif SC + Noto Sans SC + JetBrains Mono | 从静态 demo 移植 |

English: Strict bans: **no** Inter / Roboto / Space Grotesk · **no** purple-violet gradients · **no** glassmorphism on gradient backgrounds · **no** emoji as structural icons (per the design brief locked in the demo).

中文：明确禁用：**禁** Inter / Roboto / Space Grotesk · **禁**蓝紫渐变 · **禁**玻璃拟态叠渐变 · **禁**用 emoji 作结构性图标（参照 demo 已锁定的设计 brief）。

---

## 三、文件结构 / File Structure

```
quilin-agent/
├── apps/
│   ├── web/                              # ← 新 / new
│   │   ├── app/                          # Next.js App Router
│   │   │   ├── layout.tsx                # 根 layout · wordmark · 主题 provider
│   │   │   ├── page.tsx                  # /  主对话 (Phase 1b)
│   │   │   ├── globals.css               # design tokens
│   │   │   ├── sessions/
│   │   │   │   ├── page.tsx              # 会话列表 (Phase 1 第一切片)
│   │   │   │   └── [id]/page.tsx         # 单会话详情 (Phase 1b)
│   │   │   ├── memory/page.tsx           # (Phase 1b)
│   │   │   ├── skills/page.tsx           # (Phase 1b)
│   │   │   ├── mcp/page.tsx              # (Phase 1b)
│   │   │   ├── tools/page.tsx            # (Phase 1b)
│   │   │   ├── config/page.tsx           # (Phase 1b)
│   │   │   └── api/
│   │   │       └── proxy/[...path]/route.ts  # 代理到 agent-core /api/v2/*
│   │   ├── components/
│   │   │   ├── shell/                    # AppHeader · RailStrip · Composer
│   │   │   ├── conversation/             # Turn · Process · Reasoning · ToolCall · ReflectionBlock
│   │   │   ├── rails/                    # AgentSwitcher popover · SessionsList · MemoryPanel
│   │   │   └── ui/                       # shadcn/ui copies
│   │   ├── lib/
│   │   │   ├── api.ts                    # v2 API client (typed)
│   │   │   ├── schemas.ts                # zod schemas (从 agent-core 镜像)
│   │   │   ├── theme.ts                  # design tokens
│   │   │   └── format.ts                 # 时间 / 大小 / 数字格式化
│   │   ├── tests/
│   │   │   ├── unit/                     # vitest
│   │   │   └── e2e/                      # playwright
│   │   ├── public/
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts            # v4 - CSS-first config
│   │   ├── tsconfig.json
│   │   ├── biome.json
│   │   └── vitest.config.ts
│   └── web-demo/                         # 保留 / kept · 视觉参考
│       └── index.html
├── packages/
│   ├── agent-core/                       # 既有 / existing
│   │   └── src/
│   │       ├── control-plane/
│   │       │   ├── handler.ts            # 既有 · 保留 /api/dashboard/*
│   │       │   ├── handler-v2.ts         # 新 / new · /api/v2/*
│   │       │   ├── snapshot.ts           # 既有 · 复用
│   │       │   └── v2/
│   │       │       ├── schemas.ts        # zod 单源
│   │       │       ├── routes/           # 每个 endpoint 一文件
│   │       │       │   ├── sessions.ts
│   │       │       │   ├── memory.ts
│   │       │       │   ├── skills.ts
│   │       │       │   ├── tools.ts
│   │       │       │   ├── mcp.ts
│   │       │       │   ├── config.ts
│   │       │       │   ├── agents.ts
│   │       │       │   ├── snapshot.ts
│   │       │       │   ├── events-sse.ts # SSE
│   │       │       │   └── authorize.ts
│   │       │       └── *.test.ts
│   │       └── observability/
│   │           ├── dashboard-ui/         # 既有 · 保留为历史
│   │           ├── dashboard-page.ts     # 既有 · 保留
│   │           └── ...
└── docs/
    └── 08-observability/
        ├── web-ui-rebuild-plan.md        # 本文件 / this doc
        ├── observability-backend-dashboard-plan.md  # 既有 (QUI-20)
        └── ...
```

---

## 四、后端 API 契约 / Backend API Contract

English: All v2 endpoints live under `/api/v2/*`. Authentication is **localhost-only** for Phase 1 — the server already binds to `127.0.0.1` only (per `control-plane/handler.ts:33`). Cross-origin requests are denied. SSE endpoints emit heartbeat every 15s. All response envelopes use the same shape: `{ ok: boolean, data?: T, error?: ErrorPayload }`.

中文：所有 v2 endpoint 在 `/api/v2/*` 下。Phase 1 鉴权 **仅 localhost**——server 已经只绑 `127.0.0.1`（见 `control-plane/handler.ts:33`）。跨域请求直接拒绝。SSE endpoint 每 15s 发心跳。所有响应包络统一：`{ ok: boolean, data?: T, error?: ErrorPayload }`。

### 4.1 通用类型 / Common Types

```ts
// packages/agent-core/src/control-plane/v2/schemas.ts
import { z } from "zod";

export const ApiErrorSchema = z.object({
  code: z.string(),               // e.g. "session_not_found"
  message: z.string(),
  detail: z.unknown().optional(),
});

export const ApiEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean(),
    data: data.optional(),
    error: ApiErrorSchema.optional(),
  });

export const IsoDateTime = z.string().datetime({ offset: true });
export const AgentId = z.string().min(1).max(64);
export const SessionId = z.string().min(1).max(64);
```

### 4.2 GET /api/v2/snapshot

English: Returns the full runtime snapshot for first-load. Heavy but cacheable for ~1s. Frontend uses this on initial page load; subsequent updates come from SSE.

中文：返回首次加载用的完整运行时快照。响应体较大,但 ~1s 内可缓存。前端首屏用一次,之后靠 SSE 增量。

```ts
export const RuntimeSnapshotSchema = z.object({
  version: z.string(),                 // e.g. "0.1.0-iter-f"
  startedAt: IsoDateTime,
  currentSessionId: SessionId.nullable(),
  currentAgentId: AgentId.nullable(),
  agents: z.array(AgentSummarySchema),
  memory: MemoryTiersSchema,
  skills: SkillsCatalogSchema,
  tools: ToolsCatalogSchema,
  mcp: MCPRegistrySchema,
  config: ConfigSchema,
  trustMode: z.enum(["ask", "auto", "yolo", "read_only"]),
});
```

### 4.3 GET /api/v2/sessions

```ts
export const SessionSummarySchema = z.object({
  id: SessionId,
  title: z.string(),                   // 首条 user 消息截断
  agentId: AgentId,                    // "main" 或 subagent id
  turnsCount: z.number().int(),
  tokensTotal: z.number().int(),
  startedAt: IsoDateTime,
  lastTurnAt: IsoDateTime,
  status: z.enum(["active", "closed", "archived", "blocked"]),
  costUsd: z.number().nullable(),
});

// GET /api/v2/sessions?limit=50&cursor=...
export const SessionsListResponse = z.object({
  items: z.array(SessionSummarySchema),
  nextCursor: z.string().nullable(),
});
```

### 4.4 GET /api/v2/sessions/:id

```ts
export const TurnSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  agentId: AgentId,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  events: z.array(LoopStepEventSchema),  // 复用 QUI-66 契约
  content: z.string(),
  reflection: z.string().nullable(),
  tokens: z.object({
    thinking: z.number().int(),
    tools: z.number().int(),
    response: z.number().int(),
  }),
});

// Response envelope: { session: SessionSummary, turns: Turn[] }
// 响应包络:把元数据(SessionSummary)和正文(turns)拆开,避免在 detail 里重复 list 端点的字段
export const SessionDetailSchema = z.object({
  session: SessionSummarySchema,
  turns: z.array(TurnSchema),
});
```

### 4.5 GET /api/v2/memory/tiers + /api/v2/memory/recent

```ts
export const MemoryTierSchema = z.object({
  tier: z.enum(["working", "episodic", "semantic", "skill"]),
  count: z.number().int(),
  bytes: z.number().int(),
  latestAt: IsoDateTime.nullable(),
  latestPreview: z.string().nullable(),
});

export const MemoryTiersSchema = z.array(MemoryTierSchema);

export const MemoryEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(["working", "episodic", "semantic", "skill"]),
  content: z.string(),
  createdAt: IsoDateTime,
  source: z.enum(["user", "auto-reflect", "explicit", "consolidation"]),
  agentId: AgentId,
});

// /memory/recent response envelope: { items: MemoryEntry[] }
// /memory/recent 响应包络: 用 items 包裹,与 SessionsList 的 items 模式对齐,留作未来加 nextCursor
export const MemoryRecentResponseSchema = z.object({
  items: z.array(MemoryEntrySchema),
});
```

### 4.6 GET /api/v2/skills

```ts
export const SkillSchema = z.object({
  name: z.string(),
  source: z.enum(["local", "project", "remote"]),
  maturity: z.enum(["M0", "M1", "M2"]),
  usedCount: z.number().int(),
  description: z.string(),
  triggers: z.array(z.string()),
});

export const SkillsCatalogSchema = z.array(SkillSchema);
```

### 4.7 GET /api/v2/tools

```ts
export const ToolSchema = z.object({
  name: z.string(),
  category: z.enum(["core", "orchestration", "network", "discovery", "multimodal"]),
  source: z.enum(["builtin", "mcp", "cli-anything"]),
  usedCount: z.number().int(),
  successRate: z.number().min(0).max(1).nullable(),
  avgLatencyMs: z.number().nullable(),
});

export const ToolsCatalogSchema = z.array(ToolSchema);
```

### 4.8 GET /api/v2/mcp

```ts
export const MCPServerSchema = z.object({
  name: z.string(),                    // "quilin-mem"
  transport: z.enum(["stdio", "http"]),
  status: z.enum(["healthy", "degraded", "offline"]),
  toolsCount: z.number().int(),
  callsToday: z.number().int(),
  avgLatencyMs: z.number(),
});

export const MCPRegistrySchema = z.array(MCPServerSchema);
```

### 4.9 GET /api/v2/config + POST /api/v2/config

```ts
export const ConfigSchema = z.object({
  trustMode: z.enum(["ask", "auto", "yolo", "read_only"]),
  idleEvolution: z.boolean(),
  autoReflect: z.boolean(),
  tokenBudgetDaily: z.number().int(),
  tokenBudgetWarnAt: z.number().min(0).max(1),
  modelDefault: z.string(),
  modelCheap: z.string(),
  redactionPolicy: z.enum(["minimal", "standard", "strict"]),
});

// POST 接受 Partial<Config>;写入前经 WriteAuthority gate;CRITICAL 字段(trustMode / modelDefault)需 auth-request
export const ConfigPatchSchema = ConfigSchema.partial();
```

### 4.10 GET /api/v2/agents

```ts
export const AgentSummarySchema = z.object({
  id: AgentId,                         // "main" / "review-loop-r1" / ...
  kind: z.enum(["main", "subagent"]),
  parentId: AgentId.nullable(),
  task: z.string().nullable(),         // 派遣描述
  status: z.enum(["pending", "running", "blocked", "completed", "failed", "cancelled"]),
  startedAt: IsoDateTime,
  elapsedMs: z.number().int(),
  lastHeartbeatAt: IsoDateTime.nullable(),
  pendingAuthRequest: AuthRequestSchema.nullable(),
});

// Response envelope: { items: AgentSummary[] }
// 响应包络: 用 items 包裹,与 SessionsList / MemoryRecent 对齐
export const AgentsListResponseSchema = z.object({
  items: z.array(AgentSummarySchema),
});
```

### 4.11 GET /api/v2/events (SSE)

English: Long-lived SSE connection. Query params: `session=<sid>` (required), `agent=<aid>` (optional, filter to single subagent). Server emits LoopStepEvent + observability events as `data: <json>\n\n`. Each line is one event. Heartbeat every 15s emits `event: heartbeat\ndata: {}\n\n`. Reconnect uses Last-Event-ID header.

中文：长连 SSE。query 参数：`session=<sid>`（必需）、`agent=<aid>`（可选,只关心某子代理）。Server 用 `data: <json>\n\n` 发送 LoopStepEvent + 可观测事件。每行一条。心跳每 15s 发 `event: heartbeat\ndata: {}\n\n`。重连用 Last-Event-ID header。

```ts
export const SseEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loop-step"),       payload: LoopStepEventSchema }),
  z.object({ kind: z.literal("memory-recall"),   payload: MemoryRecallEventSchema }),
  z.object({ kind: z.literal("memory-write"),    payload: MemoryWriteEventSchema }),
  z.object({ kind: z.literal("skill-match"),     payload: SkillMatchEventSchema }),
  z.object({ kind: z.literal("skill-load"),      payload: SkillLoadEventSchema }),
  z.object({ kind: z.literal("planning"),        payload: PlanningEventSchema }),
  z.object({ kind: z.literal("tool-call"),       payload: ToolCallEventSchema }),
  z.object({ kind: z.literal("mcp-call"),        payload: MCPCallEventSchema }),
  z.object({ kind: z.literal("reasoning"),       payload: ReasoningChunkEventSchema }),
  z.object({ kind: z.literal("response-chunk"),  payload: ResponseChunkEventSchema }),
  z.object({ kind: z.literal("reflection"),      payload: ReflectionEventSchema }),
  z.object({ kind: z.literal("risk-classify"),   payload: RiskClassifyEventSchema }),
  z.object({ kind: z.literal("auth-request"),    payload: AuthRequestSchema }),
  z.object({ kind: z.literal("auth-resolved"),   payload: AuthResolvedSchema }),
  z.object({ kind: z.literal("subagent-spawn"),  payload: SubagentSpawnEventSchema }),
  z.object({ kind: z.literal("subagent-status"), payload: SubagentStatusEventSchema }),
  z.object({ kind: z.literal("subagent-join"),   payload: SubagentJoinEventSchema }),
  z.object({ kind: z.literal("trajectory-log"),  payload: TrajectoryLogEventSchema }),
  z.object({ kind: z.literal("metric-emit"),     payload: MetricEmitEventSchema }),
  z.object({ kind: z.literal("redaction"),       payload: RedactionEventSchema }),
  z.object({ kind: z.literal("proposal-generate"), payload: ProposalGenerateEventSchema }),
  z.object({ kind: z.literal("temporal-awareness"), payload: TemporalAwarenessEventSchema }),
  z.object({ kind: z.literal("user-profile-load"), payload: UserProfileLoadEventSchema }),
]);
```

### 4.12 POST /api/v2/authorize

```ts
export const AuthRequestSchema = z.object({
  id: z.string(),                      // 唯一 token
  agentId: AgentId,
  tool: z.string(),                    // "shell_exec"
  args: z.record(z.unknown()),
  reason: z.string(),
  classification: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  impactEstimate: z.string().nullable(),
});

// POST /api/v2/authorize
export const AuthorizePostSchema = z.object({
  requestId: z.string(),
  decision: z.enum(["approve", "deny"]),
  comment: z.string().optional(),
});

// Response: { requestId, resolved }
// 响应:回显 requestId 方便客户端追踪 + resolved 表示是否成功被裁决
export const AuthorizeResponseSchema = z.object({
  requestId: z.string(),
  resolved: z.boolean(),
});
```

### 4.13 错误码 / Error Codes

| code | HTTP | 含义 / Meaning |
|---|---|---|
| `session_not_found` | 404 | 会话不存在 |
| `agent_not_found` | 404 | 代理不存在 |
| `auth_request_expired` | 410 | 授权请求已过期 |
| `auth_request_already_resolved` | 409 | 授权请求已被处理 |
| `validation_error` | 400 | 请求体不匹配 zod schema |
| `forbidden_critical_write` | 403 | 试图写 CRITICAL 字段但 trust_mode 不允许 |
| `internal` | 500 | 未捕获异常 |

---

## 五、前端 API 客户端 / Frontend API Client

```ts
// apps/web/lib/api.ts
import { z } from "zod";
import {
  RuntimeSnapshotSchema,
  SessionsListResponse,
  // ... 镜像 import 自 @quilin/agent-core control-plane v2 schemas
} from "./schemas";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:0";

async function get<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const json = await res.json();
  return schema.parse(json.data);   // 信封外剥
}

export const api = {
  snapshot: () => get("/api/v2/snapshot", RuntimeSnapshotSchema),
  sessions: () => get("/api/v2/sessions", SessionsListResponse),
  // ...
  events: (sessionId: string) => new EventSource(`${BASE}/api/v2/events?session=${sessionId}`),
};
```

English: The schemas are **defined once** in `packages/agent-core/src/control-plane/v2/schemas.ts` and **imported** by both backend route handlers (validation) and frontend client (typed parsing). Phase 1 publishes them via a workspace `import "@quilin/agent-core/v2"` path; alternative is to vendor a `apps/web/lib/schemas.ts` copy generated by a script.

中文：schema **单一定义** 在 `packages/agent-core/src/control-plane/v2/schemas.ts`,后端路由处理器和前端客户端都 import 它（前者用于验证、后者用于类型化解析）。Phase 1 通过 workspace 路径 `import "@quilin/agent-core/v2"` 发布;备选是脚本生成 `apps/web/lib/schemas.ts` 镜像。

---

## 六、分阶段交付 / Phased Delivery

### Phase 1a · 地基 / Foundation（本期 / this iteration）

- [ ] **P1a-1** · 规划文档（本文）落地
- [ ] **P1a-2** · `apps/web/` Next.js 15 脚手架可启动
- [ ] **P1a-3** · 设计 token 移植 · Tailwind v4 config + globals.css
- [ ] **P1a-4** · 基础 layout（header / rail strip / centered column / floating composer）
- [ ] **P1a-5** · `packages/agent-core/src/control-plane/v2/schemas.ts` 全量 zod 定义
- [ ] **P1a-6** · v2 endpoints：`/snapshot` `/sessions` `/sessions/:id` `/memory` `/skills` `/tools` `/mcp` `/config` `/agents`
- [ ] **P1a-7** · 测试 ≥95% coverage
- [ ] **P1a-8** · 第一切片：sessions 列表页 RSC 拉真实数据渲染
- [ ] **P1a-9** · Cross-review 循环到 0 真实 issue

### Phase 1b · 直播事件 / Live events（紧接其后 / immediate follow-up）

- [ ] SSE `/api/v2/events` endpoint
- [ ] 前端 `useEventStream` hook
- [ ] 对话页接 SSE,流式渲染 process container
- [ ] AI SDK `useChat` 接入 `/api/v2/chat`（与 SSE 并存或合并）
- [ ] Authority gate 真实授权 POST + 实时反馈

### Phase 1c · 写入回路 / Write paths（最后 / final）

- [ ] Config 编辑器实际 POST
- [ ] 子代理切换实际生效（switch active context）
- [ ] 创建/恢复 session

### Phase 2+

英文 / English: Out of scope for QUI-154. Separate Linear issues will track Phase 2 (self-evolution governance), Phase 3 (planning intelligence), Phase 4 (multi-agent lifecycle), Phase 5 (safety surfaces), Phase 6 (memory depth), Phase 7 (multimodal tools).

中文：不在 QUI-154 范围。独立 Linear issue 跟踪 Phase 2（自演化治理）、Phase 3（规划智能）、Phase 4（多代理生命周期）、Phase 5（安全面）、Phase 6（记忆深度）、Phase 7（多模态工具）。

---

## 七、迁移策略 / Migration Strategy

| 阶段 / Stage | 旧版 dashboard | 新版 web | 决策 / Decision |
|---|---|---|---|
| Phase 1a 进行中 | 仍可用 · `:PORT/dashboard` | 仅 `apps/web/` dev server | 并存 / coexist |
| Phase 1 结束 | 仍可用 | 第一切片可用 | 并存 / coexist |
| Phase 2 完成 | 仍可用 | 5/9 类已上 | 并存 / coexist |
| 全部 Phase 完成 | **删除** | 全功能对等 | 单走新版 |

English: The legacy code (`observability/dashboard-ui/`, `dashboard-page.ts`, all `/api/dashboard/*` routes in `handler.ts`) is **not deleted** until the new app reaches functional parity with the legacy 7-panel UI **and** the user explicitly approves removal. Until then, both URLs serve concurrent traffic — `quilin` start logs both URLs.

中文：旧代码（`observability/dashboard-ui/`、`dashboard-page.ts`、`handler.ts` 里 `/api/dashboard/*` 路由）**不删除**,直到新版与旧 7-panel UI 功能对等 **且** 用户明确批准移除。在那之前两个 URL 并行 serve——`quilin` 启动时同时打印两个 URL。

---

## 八、测试策略 / Test Strategy

English: Hard rule (per CLAUDE.md): Quilin Agent test coverage threshold is **95% lines/branches/funcs/stmts** (higher than the common 80%). Every commit must verify locally before push.

中文：硬规则（按 CLAUDE.md）：Quilin Agent 测试覆盖率门槛 **95% lines/branches/funcs/stmts**（高于 common 的 80%）。每次 commit 前必须本地实证。

### 后端 / Backend (`packages/agent-core/src/control-plane/v2/`)

- **单元** / Unit · Vitest · 每个路由处理器单测 · zod schema 边界、错误码、success path · 用 `LocalMemoryBackend` + 内存 fixture 模拟运行时
- **集成** / Integration · Vitest · 起 `startControlPlaneServer` 后用 `fetch` 调真实端口 · 覆盖 happy / 404 / 400 / 403 / SSE 心跳
- **覆盖率** / Coverage · `vitest run --coverage` · 提交前 ≥95%

### 前端 / Frontend (`apps/web/`)

- **单元** / Unit · Vitest + Testing Library · 组件渲染、状态变化、API client 类型契约
- **e2e** / E2E · Playwright · 启动真实 dev server 与 mock agent-core, 跑用户路径：进入 sessions → 点条目 → 看到 conversation 占位 (Phase 1)
- **视觉回归** / Visual regression · Playwright snapshot · 对比 Phase 1 落地与 demo HTML 的关键页

### CI gates

```yaml
- pnpm --filter @quilin/web build
- pnpm --filter @quilin/web exec tsc --noEmit
- pnpm --filter @quilin/web exec biome check
- pnpm --filter @quilin/web exec vitest run --coverage  # ≥95%
- pnpm --filter @quilin/agent-core test  # 既有 1711+
```

---

## 九、Cross-Review 计划 / Cross-Review Plan

English: Per CLAUDE.md hard rule, all new code lands through 2-reviewer cross-review cycles until both report 0 real issues.

中文：按 CLAUDE.md 硬规则,所有新写代码经 2-reviewer cross-review 循环,直到两人都报 0 真实 issue。

### 循环 / Cycle

1. **写代码** / Code lands in worktree (`feat/webui-rewrite`)
2. **第一轮 review** / Dispatch 2 fresh subagents in parallel:
   - **Reviewer A**: TS/zod 类型、API schema 完整性、错误处理、算法正确性、测试覆盖
   - **Reviewer B**: 集成漂移（v2 与既有 v1 共存）、安全（CORS、auth、redaction）、API 兼容、回归风险（旧 dashboard 不被打破）
3. **真实 issue** → 写代码 agent 修复
4. **第二轮 review** / 2 fresh subagents（不复用前次）
5. 循环到 **2 个新 reviewer 都报 0** 才允许 commit + push + 更新 Linear

### 不适用 / Does NOT apply

- 本规划文档自身（pure docs）
- `apps/web-demo/` 静态 demo 修改（视觉迭代）
- 单 typo / lint

---

## 十、本期决策点 / Open Decisions

English: Before Phase 1a scaffold work begins, the user should confirm:

中文：Phase 1a 脚手架工作开始前,用户需确认：

1. **Next.js 15 vs alternative** — 已敲定 Next.js 15 App Router。是否仍坚持?或考虑 Vite + React 19 + Tanstack Router 这种更轻的栈?
2. **API 风格 / API style** — REST + SSE（本文规划）vs tRPC vs RSC + Server Actions only。选 REST + SSE 因为兼容外部消费者(MCP client / CLI 可能未来接入)
3. **Auth** — Phase 1 localhost only,无认证。Phase 1+ 是否要加 token / OIDC?
4. **schemas 单源 / single source of truth** — workspace 内 `import @quilin/agent-core/v2` vs 脚本 codegen 镜像。前者紧耦合但简单,后者解耦
5. **Phase 1 切片选择 / Phase 1 vertical choice** — 默认是 sessions 列表。是否换为 "conversation" 页（更核心但更复杂）?

---

## 附录:9 类盘点摘要 / Appendix: 9-Tier Surfacing Inventory

| 优先级 / Priority | 类别 / Tier | 主要特性 / Headline features | Phase |
|---|---|---|---|
| 🥇 | 自演化治理 | 提案审核队列 · DSPy 优化器 · 轨迹回放 · 失败聚类 | 2 |
| 🥈 | 规划智能 | 意图分发 · 策略 rationale · goal-drift · replan 状态机 | 3 |
| 🥉 | 记忆深度 | L3a observer · 上下文相关性 · KG 实体激活 · 画像更新 | 6 |
| 4 | 多代理生命周期 | 心跳时间线 · 状态机 · 恢复上下文 · 拓扑 | 4 |
| 5 | 可观测深度 | Trace 浏览器 · 指标 drill-down · 运行时数据 wiring | 1b/2 |
| 6 | 安全深度 | meta-invariant audit · sandbox gate · redaction stats · WriteAuthority log | 5 |
| 7 | 工具深度 | multimodal · web_browse 可视 · DockerSandbox 状态 | 7 |
| 8 | 配置 & runtime | 热更新事件 · 首次运行 ceremony | 1c |
| 9 | 设计中未实现 | Conversation Engineering · Agent Mesh · IM 桥接 · Computer Use | parked |
