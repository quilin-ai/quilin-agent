# Iteration B2: Safety Policy — Spec

> **状态**：草案，待 Codex R1 review
>
> **前置**：B1 Tool Substrate（v0.2.0-iter-b1）已完成
>
> **参见**：[plan.md](./plan.md)（含完整验收标准）

---

## 实施约束

1. **不改冻结接口**：`Tool`、`ToolCall`、`ToolResult`（`tools/types.ts`）保持不变
2. **不改 Agent Loop 签名**：`runAgentLoop(config, messages)` 和 `AgentLoopConfig` 保持不变
3. **不改 B1 已有接口**：`ToolWithMetadata`、`MCPRegistry`、`ToolRouter.execute()` 签名保持不变
4. **门控在 Router 外层**：权限检查和超时保护通过包装层实现，不修改 `ToolRouter` 内部逻辑
5. **审计日志输出 JSON 到 stdout**：与项目约定一致（ADR-002 §7）
6. **REPL 确认 UI 仅限 REPL 模式**：service 模式下不弹确认（将来由 WebUI 处理）

## 架构设计

### 新增文件（预估）

```
packages/agent-core/src/safety/
├── types.ts                    # PermissionLevel, PermissionPolicy, ToolAuditRecord
├── types.test.ts               #
├── timeout.ts                  # withTimeout() — 工具执行超时包装
├── timeout.test.ts             #
├── audit-logger.ts             # AuditLogger — 结构化审计日志
├── audit-logger.test.ts        #
├── permission-policy.ts        # DefaultPermissionPolicy — 基于 riskLevel 的策略
├── permission-policy.test.ts   #
├── execution-gate.ts           # ExecutionGate — pre/post hook 组合层
├── execution-gate.test.ts      #
├── confirm.ts                  # ConfirmationProvider — REPL 交互式确认
├── confirm.test.ts             #
└── index.ts                    # 公共 re-exports
```

### Step 0: 约束对齐检查

开始实施前先验证：
- B1 的 `ToolWithMetadata` 接口含 `riskLevel` 和 `timeoutMs` 字段
- `ToolRouter.execute()` 签名未被修改
- 现有测试全部通过：129/129

### Step 1: Safety 类型定义

新建 `safety/types.ts`：

```typescript
import type { RiskLevel } from "../tools/tool-metadata.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

/** 权限级别 */
export type PermissionLevel = "auto" | "confirm" | "deny";

/** 权限决策结果 */
export interface PermissionDecision {
  readonly level: PermissionLevel;
  readonly reason: string;
}

/** 权限策略接口 — 根据工具 metadata 决定权限级别 */
export interface PermissionPolicy {
  decide(toolName: string, riskLevel: RiskLevel): PermissionDecision;
}

/** 用户确认提供者接口 */
export interface ConfirmationProvider {
  confirm(call: ToolCall, decision: PermissionDecision): Promise<boolean>;
}

/** 审计记录 */
export interface ToolAuditRecord {
  readonly timestamp: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly riskLevel: RiskLevel;
  readonly permissionLevel: PermissionLevel;
  readonly wasConfirmed: boolean;
  readonly durationMs: number;
  readonly result: "success" | "error" | "timeout" | "denied";
  readonly error?: string;
}
```

### Step 2: 超时保护

新建 `safety/timeout.ts`：

```typescript
export interface TimeoutOptions {
  readonly timeoutMs: number;
}

export function withTimeout<T>(
  fn: () => Promise<T>,
  options: TimeoutOptions,
): Promise<T>;
```

- 使用 `AbortController` + `setTimeout` 实现
- 超时时抛出 `ToolTimeoutError`（自定义 Error 子类，含 `timeoutMs` 字段）
- 确保超时后 fn 的 Promise 不再影响调用者（即使它后来 resolve/reject）

### Step 3: 审计日志

新建 `safety/audit-logger.ts`：

```typescript
export interface AuditLogSink {
  write(record: ToolAuditRecord): void;
}

/** 默认 sink：JSON 写到 stdout */
export function createStdoutAuditSink(): AuditLogSink;

export class AuditLogger {
  constructor(private readonly sink: AuditLogSink);

  log(record: ToolAuditRecord): void;
}
```

- `AuditLogSink` 可注入（测试用 mock，生产用 stdout）
- 每条 audit record 是一行 JSON（`{"type":"tool_audit",...}`）
- AuditLogger 只负责序列化和写入，不做过滤

### Step 4: 默认权限策略

新建 `safety/permission-policy.ts`：

```typescript
export class DefaultPermissionPolicy implements PermissionPolicy {
  decide(toolName: string, riskLevel: RiskLevel): PermissionDecision;
}
```

默认策略（对齐 Claude Code auto mode）：
- `read` → `auto`（直接执行）
- `write` → `auto`（直接执行 + 日志）
- `exec` → `confirm`（需要用户确认）
- `high-risk` → `confirm`（强制确认）

支持覆盖：构造函数接受 `overrides?: Partial<Record<RiskLevel, PermissionLevel>>`

### Step 5: 确认提供者

新建 `safety/confirm.ts`：

```typescript
/** REPL 模式下的交互式确认 */
export class ReplConfirmationProvider implements ConfirmationProvider {
  constructor(private readonly io: { question: (prompt: string) => Promise<string> });

  async confirm(call: ToolCall, decision: PermissionDecision): Promise<boolean>;
}

/** 自动通过（service 模式 / 测试用） */
export class AutoConfirmationProvider implements ConfirmationProvider {
  async confirm(): Promise<boolean> { return true; }
}
```

- REPL 模式：显示工具名、参数摘要、风险级别，等待 y/n 输入
- Service 模式：自动通过（后续由 WebUI 接管）

### Step 6: 执行门控（核心）

新建 `safety/execution-gate.ts`：

```typescript
export interface ExecutionGateOptions {
  readonly policy: PermissionPolicy;
  readonly confirmation: ConfirmationProvider;
  readonly auditLogger: AuditLogger;
  readonly defaultTimeoutMs?: number;
}

export class ExecutionGate {
  constructor(private readonly options: ExecutionGateOptions);

  /** 包装 ToolRouter，在执行前后插入安全检查 */
  async execute(
    call: ToolCall,
    tool: ToolWithMetadata,
    router: ToolRouter,
  ): Promise<ToolResult>;
}
```

执行流程：
1. **Pre-hook**：`policy.decide(tool.name, tool.riskLevel)`
2. 如果 `deny` → 返回 denied error ToolResult
3. 如果 `confirm` → `confirmation.confirm(call, decision)`
4. 如果用户拒绝 → 返回 denied error ToolResult
5. **执行**：`withTimeout(() => router.execute(call), { timeoutMs: tool.timeoutMs ?? defaultTimeoutMs })`
6. **Post-hook**：`auditLogger.log(record)`（记录结果、耗时、权限决策）
7. 返回结果

### Step 7: REPL 接线

修改 `repl.ts`：
- 创建 `ExecutionGate` 实例（DefaultPermissionPolicy + ReplConfirmationProvider + AuditLogger）
- Agent Loop 执行工具时通过 gate 而非直接 router.execute()
- 注意：`loop.ts` 不修改。gate 包装在 repl 层，通过修改传给 loop 的 tools 的 execute 方法实现

实现方式：对 `registry.getAllTools()` 返回的工具做一层包装，让每个工具的 `execute` 方法经过 gate：
```typescript
const gatedTools = allTools.map(tool => ({
  ...tool,
  execute: (args) => gate.execute({ id: "...", name: tool.name, arguments: args }, tool, router),
}));
```

### Step 8: 集成测试

新建 `safety/integration.test.ts`：
- AUTO 工具直接执行，不弹确认
- CONFIRM 工具走确认流程（mock confirmation provider）
- 用户拒绝时返回 denied result
- 超时时返回 timeout error，agent loop 正常恢复
- 审计日志记录全部执行
- DefaultPermissionPolicy 覆盖功能

---

## 明确延后的项

| 项目 | 延后到 | 原因 |
|------|--------|------|
| 输入验证（Prompt Injection 检测） | Iter D 或独立安全迭代 | 需要 ML 分类器，超出 B2 范围 |
| 输出验证（PII 脱敏、有害内容扫描） | Iter D | 需要额外模型 |
| 步骤验证（三问自评估） | Iter D | 需要 planning 能力配合 |
| 元验证（Meta-Verification） | Iter D | 依赖 Layer 1-3 |
| WebUI 确认 UI | 后续 WebUI 迭代 | B2 只做 REPL 确认 |
| 动态权限策略（per-session override） | B2.1 | B2 只做全局策略 |

## 建议实施顺序

```
Step 0 (约束检查)
  ↓
Step 1 (Safety 类型定义)
  ↓
Step 2 (超时保护)  ←→  Step 3 (审计日志) [可并行]
  ↓
Step 4 (默认权限策略)
  ↓
Step 5 (确认提供者)
  ↓
Step 6 (执行门控 — 核心组合层)
  ↓
Step 7 (REPL 接线)
  ↓
Step 8 (集成测试)
```
