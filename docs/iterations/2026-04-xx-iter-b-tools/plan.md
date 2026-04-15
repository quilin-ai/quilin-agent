# Iteration B: Useful Tools — 工具系统 + 安全基础

> **状态**：规划中
>
> **主轴**：05-Tool　**搭配**：07-Safety-lite
>
> **全局路线图**：[implementation-plan.md](../../implementation-plan.md)

---

## 为什么第二

没有更丰富的工具和基本安全分层，agent 的任务上限很低——只能聊天 + 记忆，不能"做事"。工具和安全必须绑定推进：更强的工具没有安全分层 = 风险放大器。

## 前置条件

- **Iter A 已完成**（v0.1.0-iter-a）：PromptBuilder、ContextAssembler、InjectionScanner
- **运行时接线说明**：Iter A 的 ContextAssembler 已通过 `repl.ts` 接入 system prompt 生成流。`loop.ts` 仍使用 `BasicContextManager.buildContext()` 做消息级上下文组装——这两层不冲突（system prompt assembly vs message-level context）。Iter B 新增工具时，tool descriptions 通过 PromptBuilder 的 `tool-guidance` section 动态注入。

## 范围拆分

> Codex + Claude 共识（2026-04-15）：原 Iter B 范围过宽，拆为 B1（工具底座）和 B2（安全策略）两个阶段。B1 先落地，B2 紧随其后。

### B1: Tool Substrate（工具底座）

解决"Agent 能做什么事"：

1. **Multi-MCP Server Registry**
   - 当前 `MCPClientManager` 只管理单个 MCP Server 连接
   - 扩展为 `MCPRegistry`：支持多 server 并行连接、启动时注册
   - 工具名冲突解决：`<server-namespace>/<tool-name>` 前缀方案
   - 配置驱动：server 列表从配置文件加载
   - **运行时动态增删 server + 断线重连延后到 B1.1**（当前只保证启动时加载）

2. **内置工具抽象**
   - 在 MCP 工具之外，提供本地内置工具（不走 MCP 协议，直接 TS 实现）
   - 最小内置集（3 类）：
     - `file_read` / `file_write` / `file_list` — 文件操作
     - `shell_exec` — 命令执行（带 timeout + output capture + size limit）
     - `web_fetch` — HTTP 请求（GET/POST，带响应截断 + content-type 处理）
   - 统一 `Tool` 接口：内置工具和 MCP 工具对 Agent Loop 来说没有区别

3. **Tool Capability Metadata**
   - 给每个工具打标签：`category` (programmatic / interactive / control / gui)
   - 风险级别标注：`riskLevel` (read / write / exec / high-risk)
   - 这些 metadata 是 B2 安全策略的基础，但 B1 只定义数据结构，不做执行拦截

4. **Tool ↔ Context 集成（启动时）**
   - 工具描述 → PromptBuilder `tool-guidance` section（已存在占位 section）
   - `BuildContext` 增量扩展：新增 `availableToolDescriptors?: readonly ToolPromptDescriptor[]`，不修改原 `availableTools: readonly string[]`
   - ~~工具执行结果 → 作为 `ContextSource` 参与 token budget 管理~~ **延后到 Iter C**（需 loop.ts 改动，超出 B1 范围）
   - ~~运行时增删 server 后自动刷新 prompt~~ **延后到 B1.1**（当前 repl.ts 只在启动时 build 一次 prompt）
   - 工具数量多时（>20），按任务相关性动态过滤暴露给 LLM 的工具列表

### B2: Safety Policy（安全策略）

解决"Agent 做事时怎么保障安全"：

1. **权限分级**：AUTO / CONFIRM / DENY 三级
   - 默认 AUTO 模式（与 Claude Code auto mode 对齐）
   - `read` 工具 → AUTO
   - `write` 工具 → AUTO + 日志
   - `exec` 工具 → CONFIRM
   - `high-risk` 工具 → 强制 CONFIRM

2. **执行门控（Execution Gate）**
   - pre-hook：工具执行前检查 riskLevel → 决定是否需要用户确认
   - post-hook：记录执行结果、耗时、是否异常
   - 确认 UI：REPL 模式下的交互式确认 prompt

3. **超时保护**
   - 每个工具配置 `timeoutMs`（默认 30s）
   - 超时自动中断，返回超时错误给 LLM
   - Agent Loop 不因单个工具超时而崩溃

4. **审计日志**
   - 所有工具调用记录到结构化 JSON 日志
   - 包含：toolName, args, result, duration, riskLevel, wasConfirmed
   - 为后续 Observability（Iter D）做基础数据准备

## 依赖关系

- 依赖 Iter A（context 中注入工具描述 ← PromptBuilder `tool-guidance` section）
- B1 → B2 有顺序依赖（safety policy 基于 tool metadata）
- 是 Iter C（Planning）的前置——没有工具，规划空转

## 验收标准

### B1 验收
- [ ] 同时连接 ≥2 个 MCP Server（OmniMem + 至少一个新 server）
- [ ] 工具名冲突时自动加 namespace 前缀
- [ ] 内置工具 file_read / shell_exec / web_fetch 可用
- [ ] 内置工具和 MCP 工具共享同一个 `Tool` 接口
- [ ] 每个工具有 `category` 和 `riskLevel` metadata
- [ ] 工具描述动态注入 PromptBuilder 的 system prompt
- [ ] 所有工具有对应的单元测试
- [ ] 现有测试不回归

### B2 验收
- [ ] AUTO 模式下 read 工具直接执行
- [ ] CONFIRM 模式下 exec/high-risk 工具要求用户确认
- [ ] 工具超时后 agent loop 正常恢复
- [ ] 所有工具执行有结构化审计日志
- [ ] 所有安全策略有对应的单元测试

## 参考 Spec

- [05-tool/README.md](../../engineering/05-tool/README.md)
- [07-safety-guardrails/README.md](../../engineering/07-safety-guardrails/README.md)
