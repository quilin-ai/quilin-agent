# Iteration B1: Tool Substrate — Spec（骨架版）

> **状态**：骨架，待 Codex review 后补全实施细节
>
> **参见**：[plan.md](./plan.md)（含完整验收标准）

---

## 实施约束

> 沿用 Iter A 的约束风格，确保兼容性：

1. **不改冻结接口**：`Tool`、`ToolCall`、`ToolResult`（`tools/types.ts`）保持不变。新增 `ToolMetadata` 类型通过组合而非修改引入
2. **不改 Agent Loop 签名**：`runAgentLoop(config, messages)` 和 `AgentLoopConfig` 保持不变。新能力通过扩展 `tools` 数组传入
3. **不改 MCPClientManager 公共 API**：现有 `connect()` / `callTool()` / `disconnect()` 不变。`MCPRegistry` 是新类，内部使用多个 `MCPClientManager` 实例
4. **测试目录沿用惯例**：`src/**/*.test.ts`，与 Vitest 配置一致

## 现有代码分析

### 当前状态

| 文件 | 职责 | B1 影响 |
|------|------|---------|
| `tools/types.ts` | `Tool`, `ToolCall`, `ToolResult` 接口 | 不修改。新增 `tool-metadata.ts` |
| `tools/router.ts` | `ToolRouter` — name lookup + zod validate + execute | 扩展：接受 `ToolWithMetadata[]` |
| `tools/mcp-client.ts` | `MCPClientManager` — 单 MCP server stdio 连接 | 不修改。`MCPRegistry` 管理多实例 |
| `context/default-sections.ts` | `tool-guidance` section（静态占位） | 扩展：动态生成工具描述 |
| `loop.ts` | Agent Loop — `ToolRouter.execute()` 串行执行 | 不修改（B1 阶段） |

### 关键观察

1. **`Tool` 接口极简**：只有 `name`, `description`, `parameters`, `execute`。没有 category/risk/timeout。需要扩展但不能破坏现有使用方。
2. **`MCPClientManager` 单连接**：`connect()` 会先 `disconnect()` 再连新的。多 server 需要多实例。
3. **`ToolRouter` 扁平查找**：`tools.find(t => t.name === call.name)`。多 server 可能有同名工具冲突。
4. **`jsonSchemaToZodObject()` 只支持 string 类型**：MCP 工具的参数 schema 转换很有限，需要增强。

## 架构设计

### 新增文件（预估）

```
packages/agent-core/src/tools/
├── types.ts                    # 【不改】现有 Tool/ToolCall/ToolResult
├── tool-metadata.ts            # 【新增】ToolCategory, RiskLevel, ToolWithMetadata
├── registry.ts                 # 【新增】MCPRegistry — 多 MCP server 管理
├── registry.test.ts            # 【新增】
├── builtin/                    # 【新增】内置工具目录
│   ├── index.ts                # 内置工具注册入口
│   ├── file-tools.ts           # file_read / file_write / file_list
│   ├── file-tools.test.ts      #
│   ├── shell-exec.ts           # shell_exec
│   ├── shell-exec.test.ts      #
│   ├── web-fetch.ts            # web_fetch
│   └── web-fetch.test.ts       #
├── router.ts                   # 【修改】支持 ToolWithMetadata
├── router.test.ts              # 【修改】补充 metadata 测试
├── mcp-client.ts               # 【不改】
└── mcp-client.test.ts          # 【不改】

packages/agent-core/src/context/
└── default-sections.ts         # 【修改】tool-guidance section 动态化
```

### Step 0: 约束对齐检查

开始实施前先验证：
- `tools/types.ts` 的 `Tool` 接口未被修改
- `loop.ts` 的 `AgentLoopConfig` 未被修改
- `mcp-client.ts` 的公共 API 未被修改
- 91 个现有测试全部通过

### Step 1: ToolMetadata 类型定义

新建 `tools/tool-metadata.ts`：

```typescript
/** 工具分类 — 对应 4 类混合动作空间 */
export type ToolCategory = 'programmatic' | 'interactive' | 'control' | 'gui';

/** 风险级别 — B2 安全策略的基础 */
export type RiskLevel = 'read' | 'write' | 'exec' | 'high-risk';

/** 扩展 Tool 接口，通过组合引入 metadata */
export interface ToolWithMetadata extends Tool {
  readonly category: ToolCategory;
  readonly riskLevel: RiskLevel;
  readonly timeoutMs?: number;       // 执行超时（默认 30_000）
  readonly namespace?: string;       // MCP server namespace（内置工具无此字段）
}
```

### Step 2: MCPRegistry — 多 Server 管理

```typescript
export interface MCPServerEntry {
  readonly id: string;              // 唯一标识，如 "omnimem", "filesystem"
  readonly config: MCPServerConfig;
  readonly namespace: string;       // 工具名前缀
}

export class MCPRegistry {
  private readonly connections = new Map<string, MCPClientManager>();
  private readonly tools = new Map<string, ToolWithMetadata>();

  /** 注册并连接一个 MCP server */
  async register(entry: MCPServerEntry): Promise<ToolWithMetadata[]>;

  /** 注销并断开一个 MCP server */
  async unregister(serverId: string): Promise<void>;

  /** 获取所有可用工具（含内置 + 全部 MCP） */
  getAllTools(): ToolWithMetadata[];

  /** 按名称查找工具（支持 namespace/name 和 short name） */
  findTool(name: string): ToolWithMetadata | undefined;

  /** 断开所有连接 */
  async disconnectAll(): Promise<void>;
}
```

**工具名冲突解决**：
- MCP 工具注册时加 `<namespace>/<tool_name>` 前缀
- 查找时先尝试精确匹配（含 namespace），再尝试 short name
- 如果 short name 有冲突（多个 server 的工具同名），要求使用 namespace 前缀

### Step 3: 内置工具

每个内置工具实现 `ToolWithMetadata` 接口：

**file_read**:
- category: `programmatic`, riskLevel: `read`
- 参数：`path: string`, `offset?: number`, `limit?: number`
- 返回文件内容（带行号），超过 size limit 截断
- 安全：不允许读取 `.env`、私钥等敏感文件模式

**file_write**:
- category: `programmatic`, riskLevel: `write`
- 参数：`path: string`, `content: string`
- 写入文件，返回写入字节数

**file_list**:
- category: `programmatic`, riskLevel: `read`
- 参数：`path: string`, `pattern?: string`
- 列出目录内容，支持 glob pattern

**shell_exec**:
- category: `programmatic`, riskLevel: `exec`
- 参数：`command: string`, `cwd?: string`, `timeoutMs?: number`
- 执行命令，capture stdout+stderr，超时中断
- 输出截断到 maxOutputSize（默认 10KB）

**web_fetch**:
- category: `programmatic`, riskLevel: `read`
- 参数：`url: string`, `method?: 'GET' | 'POST'`, `body?: string`, `headers?: Record<string, string>`
- 返回响应 body（截断到 maxSize）
- 只允许 http/https 协议

### Step 4: ToolRouter 扩展

- `ToolRouter` 构造函数改为接受 `readonly (Tool | ToolWithMetadata)[]`
- 添加 `getToolMetadata(name): ToolMetadata | undefined` 方法
- 向后兼容：没有 metadata 的 `Tool` 默认为 `category: 'programmatic', riskLevel: 'read'`

### Step 5: Tool → Context 集成

修改 `default-sections.ts` 中的 `tool-guidance` section：
- `compute(ctx)` 读取 `ctx.availableTools`，生成工具使用指南
- 包含每个工具的 name + description + category
- 工具数量 > 20 时触发过滤（按任务相关性选择 top-K）

### Step 6: Repl + Loop 接线

- `repl.ts`：用 `MCPRegistry` 替代直接调用 `MCPClientManager`
- `repl.ts`：注册内置工具 + MCP 工具到同一个 registry
- `loop.ts`：不修改（工具通过 `tools` 数组传入，registry 在 repl 层管理）

### Step 7: 集成测试

- 多 MCP server 同时连接（OmniMem + 一个 mock server）
- 内置工具 + MCP 工具混合调用
- 工具名冲突场景
- 工具描述注入 system prompt 验证

---

## 延后到 B2 的项

- 权限分级执行（AUTO / CONFIRM / DENY）
- pre/post execution hooks
- 用户确认 UI
- 审计日志
- 超时保护的强制执行（B1 只定义 `timeoutMs` 字段）

## 待 Codex Review 补全

- [ ] 每个 Step 的具体 TDD 测试代码
- [ ] jsonSchemaToZodObject 增强方案（支持 number/boolean/array）
- [ ] MCPRegistry 断线重连策略细节
- [ ] 工具过滤的相关性算法选择
