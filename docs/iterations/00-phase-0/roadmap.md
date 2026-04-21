# Phase 0 开发路线图

> **状态**: Active
> **日期**: 2026-04-15
> **参与方**: Claude Code (规划/Review) + Codex (实现/验证)
> **前置**: [ADR-002](adr/adr-002-project-skeleton.md) §15 Step 1-2 已完成（v0.0.1）

---

## 1. 当前状态

| Step | 模块 | 状态 |
|------|------|------|
| 1 | 项目骨架（目录/配置/CI/justfile） | ✅ 完成 |
| 2 | CLI REPL + Agent Loop（repl.ts / loop.ts / client.ts） | ✅ 完成（10/10 测试通过） |
| 3-9 | 下面七步 | 🔲 占位代码 |

---

## 2. 开发顺序（Claude + Codex 共识）

### 核心策略：Vertical Slice 优先

不按模块水平分层推进，而是先打通 **"LLM → tool_call → 工具执行 → 结果回灌"** 这条最小垂直切片，再补状态层和上下文。

原因：最大的风险不是单模块实现难度，而是"每块都能跑，但端到端不通"。垂直切片能最早暴露集成问题。

### Wave 1 — Tool Contract 冻结

**目标**：锁定工具调用契约，为 TS/Python 并行开发扫清障碍。

| 产出 | 内容 |
|------|------|
| 工具名称 | `memory_recall` / `memory_store`（全局唯一，TS 和 Python 两侧必须完全一致） |
| 参数 schema | `memory_recall`: `{ query: string }`；`memory_store`: `{ content: string, tier?: string }` |
| ToolResult.content 格式 | JSON 字符串（见下方详细定义） |
| tool message 回灌 | `{ role: "tool", toolCallId, content, name }` 追加到 `Message[]`；**`name` 必须等于对应的 tool name**（如 `"memory_recall"`） |

#### MemoryRecord Wire Schema

```json
{
  "id": "string (uuid)",
  "content": "string",
  "tier": "string"
}
```

- `tier` 允许值：Phase 0 仅当普通字符串处理，默认 `"short"`。Phase 1 再约束为枚举 `"short" | "mid" | "long" | "ultra"`。

#### ToolResult.content 格式

**成功时**：
- `memory_recall` → `{ "records": [{ "id": "...", "content": "...", "tier": "..." }, ...] }`
- `memory_store` → `{ "id": "..." }`

**失败时**（`ToolResult.isError === true`）：
- `{ "error": "human-readable error message" }`

**预估时间**：0.5h（Claude 出契约 → Codex review → 冻结）

### Wave 2 — ToolRouter + OmniMem（并行）

**目标**：TS 侧实现工具循环，Python 侧实现 MCP Server，两条线独立可测。

| 任务 | 语言 | 涉及文件 | 核心工作 |
|------|------|---------|---------|
| LLM tool-calls 映射 | TS | `llm/client.ts` | Vercel AI SDK `toolCalls` → `LLMResponse.toolCalls` 映射 |
| Agent Loop 工具循环 | TS | `loop.ts` | while-loop：检测 `finishReason === "tool_calls"` → ToolRouter.execute → 结果追加 messages → 再次调用 LLM |
| ToolRouter 实现 | TS | `tools/router.ts` | 注册工具 → 按 name 查找 → 执行 → 返回 ToolResult |
| OmniMem MCP Server | Python | `providers/memory/` | `server.py` 接入 `mcp` Python SDK，暴露 `memory_recall` / `memory_store` 两个 MCP tool；Phase 0 用内存 list 存储 |

**TS 和 Python 可并行的前提**：Wave 1 的 tool contract 已锁定。

**验收标准**：
- TS：本地 echo 测试工具 → LLM 返回 tool_call → ToolRouter 执行 → 结果正确回灌 → LLM 基于结果生成最终回复
- Python：`mcp` CLI 直接调用 OmniMem server → recall/store 正常工作

### Wave 3 — MCP Client Bridge + 薄 E2E Smoke Test

**目标**：TS 通过 MCP stdio 拉起 Python OmniMem 子进程，自动发现并注册工具到 ToolRouter。

| 任务 | 涉及文件 | 核心工作 |
|------|---------|---------|
| MCP Client 实现 | `tools/mcp-client.ts` | `@modelcontextprotocol/sdk` stdio transport → spawn Python 进程 → 发现 tools → 注册到 ToolRouter |
| 薄 E2E Smoke Test | 新测试文件 | ask → tool_call (recall/store) → response 完整流程验证 |

**验收标准**：REPL 中 "记住我叫小明" → Agent 调用 `memory_store` → "我叫什么" → Agent 调用 `memory_recall` → 正确返回。

### Wave 4 — ContextManager

**目标**：按优先级组装 system prompt + memory 上下文 + 环境信息，替代 REPL 中硬编码的 `DEFAULT_SYSTEM_PROMPT`。

| 任务 | 涉及文件 | 核心工作 |
|------|---------|---------|
| ContextManager 实现 | `context/manager.ts` | 按 priority 排序 ContextSource → token 预算裁剪 → 组装最终 system prompt |

**验收标准**：system prompt 由 ContextManager 动态组装，memory 上下文自动注入。

### Wave 5 — Checkpoint

**目标**：SQLite 持久化 AgentState，支持会话恢复。

| 任务 | 涉及文件 | 核心工作 |
|------|---------|---------|
| Checkpoint 实现 | `state/checkpoint.ts` | better-sqlite3 存取 AgentState；save/load/list；session 生命周期管理 |

**为什么在 ContextManager 之后**：当前 `AgentState` 缺少稳定的 session model（无 `sessionId` 生成策略），需要先在前面几波中稳定接口，再做持久化，避免返工。

**验收标准**：会话中途退出 → 重启 → 加载上次会话 → 继续对话。

### Wave 6 — 全量 E2E 验证

**目标**：完整端到端集成测试，覆盖全链路 + 失败路径 + 恢复路径。

| 验证项 | 内容 |
|--------|------|
| 正常流程 | 用户提问 → ContextManager 组装 → LLM 回复/tool_calls → ToolRouter 分发 → OmniMem recall/store → 响应 |
| 失败路径 | LLM 超时、工具执行失败、MCP 连接断开 |
| 恢复路径 | Checkpoint 加载 → 恢复对话 → 继续执行 |

### Wave 7 — SWE-bench 适配

**目标**：Benchmark harness 接入，读取 SWE-bench 题目 → 注入 Agent → 收集产出 → 提交评测。

**为什么最后做**：前面接口还在变，适配器白写。等全链路稳定后一次性对接。

---

## 3. 分工与协作方式

### 角色分工

| 角色 | 负责人 | 职责 |
|------|--------|------|
| **规划 / 架构 / Review** | Claude Code | 顺序决策、契约设计、验收标准定义、代码审查、收敛判断 |
| **实现 / 验证 / 修复** | Codex | 代码编写、本地测试验证、bug 修复、回归测试 |

### 协作规则

1. **默认由 Codex 执行代码实现** — 代码编写、修改、重构默认由 Codex 负责；若需并行加速，Claude 仅在双方明确分配且写集独立时委派 subagent 实现代码
2. **协作请求必须回复** — 收到对方消息后必须通过 AgentBridge 回复，不能单方面沉默
3. **协作语言使用中文** — Agent 之间所有对话使用中文，方便用户同步查看
4. **双方可用 subagent 加速开发** — Claude Code 和 Codex 都可以使用各自的 subagent 能力并行处理独立任务，前提是 **写集不重叠**（不同 subagent 不能同时修改同一文件）；Claude 的 subagent 可用于并行审查不同模块、研究文档、独立测试验证等

### Subagent 使用原则

- **可并行的写集示例**：
  - Worker A: `providers/memory/src/omnimem/*`（Python OmniMem）
  - Worker B: `packages/agent-core/src/tools/mcp-client.ts` 及其测试
  - 主线程: `loop.ts` / `client.ts` / `router.ts`（耦合紧密，不拆）
- **不建议拆分**：`loop.ts` / `client.ts` / `router.ts` 三个文件耦合紧密，应由同一线程/worker 处理
- **每个 subagent 任务需明确**：输入文件、输出文件、验收标准

### 每波协作流程

```
Claude Code: 出该波设计 + 验收标准
    ↓
Codex: Review 设计 → 提出修改建议
    ↓
Claude Code: 确认/调整 → 冻结设计
    ↓
Codex: 实现代码 + 测试（可用 subagent 并行）
    ↓
Claude Code: Review 代码（可用 subagent 并行审查不同模块）
    ↓
Codex: 修复 review 问题 → 验收通过
    ↓
双方确认 → 进入下一波
```

---

## 4. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Vercel AI SDK tool-calls 映射复杂 | Wave 2 先用 echo 测试工具验证，不依赖 Python |
| MCP stdio 通信不稳定 | Wave 3 加超时/重连/健康检查 |
| better-sqlite3 与 Bun 兼容性 | Wave 5 开始前先做兼容性验证，不行换 drizzle-orm + libsql |
| 工具契约频繁变更 | Wave 1 锁定后，变更需双方同意 + 更新本文档 |

---

## 5. 里程碑

| 里程碑 | 对应 Wave | 标志 |
|--------|----------|------|
| **v0.1.0** — Tool-capable Agent | Wave 2-3 完成 | REPL 中 LLM 能调用工具并基于结果回复 |
| **v0.2.0** — Memory-connected Agent | Wave 3 完成 | 跨语言 MCP 打通，记忆存取可用 |
| **v0.3.0** — Context-aware Agent | Wave 4 完成 | 动态 prompt 组装，记忆自动注入上下文 |
| **v0.4.0** — Persistent Agent | Wave 5 完成 | 会话持久化，重启可恢复 |
| **v0.5.0** — Verified Agent | Wave 6-7 完成 | 全量 E2E 通过 + SWE-bench harness 就绪 |
