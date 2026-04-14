# Codex CLI 深度调研报告

> 调研日期：2026-04-14
> 仓库：本地 /Users/raysonmeng/repo/codex
> 调研深度：deep
> 关注领域：全部 11 领域

## 1. 仓库概览

Codex CLI 是 OpenAI 开发的命令行 AI 编码助手，采用 Rust 单体仓库（monorepo）架构。

| 指标 | 数值 |
|------|------|
| 总代码量 | ~831K 行 |
| Rust 代码 | ~640K 行 |
| TypeScript 代码 | ~40K 行 |
| Rust crate 数量 | 92 |
| 核心文件 codex.rs | 8,137 行 |
| 核心文件 protocol.rs | ~2,000+ 行 |

关键 crate 依赖关系：

```
codex-cli (入口)
  └── codex-tui (终端 UI)
  └── codex-exec (非交互执行)
  └── codex-core (核心逻辑)
        ├── codex-protocol (SQ/EQ 协议定义)
        ├── codex-mcp (MCP 连接管理)
        ├── codex-hooks (钩子系统)
        ├── codex-sandboxing (沙箱管理)
        ├── codex-exec-server (执行环境)
        ├── codex-state (SQLite 持久化)
        ├── codex-network-proxy (网络代理)
        ├── codex-models-manager (模型管理)
        └── codex-analytics (遥测分析)
```

## 2. 架构映射

### 入口与核心抽象

**CLI 入口** (`codex-rs/cli/src/main.rs`, 2,173 行)

采用 clap 解析命令行，顶层 `MultitoolCli` 结构体通过 `#[clap(subcommand)]` 支持以下子命令：

- `Exec` — 非交互执行（`codex exec`）
- `Review` — 代码评审
- `Login/Logout` — 认证管理
- `Mcp` — MCP 服务器管理
- `McpServer` — 以 MCP 服务器模式启动（stdio）
- `Sandbox` — 在沙箱中运行命令（seatbelt/landlock/windows）
- `Resume/Fork` — 恢复/分叉历史会话
- `Cloud` — 云任务浏览

**核心抽象 `Codex`** (`codex-rs/core/src/codex.rs`, 行 400-411)

```rust
pub struct Codex {
    pub(crate) tx_sub: Sender<Submission>,      // 提交队列（发送端）
    pub(crate) rx_event: Receiver<Event>,        // 事件队列（接收端）
    pub(crate) agent_status: watch::Receiver<AgentStatus>,
    pub(crate) session: Arc<Session>,
    pub(crate) session_loop_termination: SessionLoopTermination,
}
```

这是整个系统的最高层接口。它作为一个队列对（queue pair）运行：你发送 Submission，接收 Event。

**关键设计：SQ 有界 / EQ 无界**（行 497）

```rust
let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);  // 512
let (tx_event, rx_event) = async_channel::unbounded();
```

- 提交队列（SQ）使用 `bounded(512)`，施加背压（back-pressure），防止客户端过快提交
- 事件队列（EQ）使用 `unbounded()`，确保 agent 永远不会因为事件发送而阻塞

这个不对称设计是刻意的：agent 侧不应该被客户端消费速度拖慢。

### 设计决策

| 决策 | 选择 | 理由 | 我们的评价 |
|------|------|------|-----------|
| 语言 | Rust（核心）+ TS（TUI/扩展绑定） | 性能、内存安全、跨平台编译 | Quilin 选择 TS+Python+Rust 三语言更灵活，Rust 部分可参考 |
| 异步运行时 | Tokio | 生态成熟，async-channel 消息传递 | 标准选择，无争议 |
| LLM 交互 | OpenAI Responses API（无状态） | 每次调用完全重建 prompt，无 previous_response_id | 与 Quilin 无状态设计一致，但缺乏多模型支持 |
| 消息协议 | SQ/EQ 模式（Submission Queue / Event Queue） | 解耦用户输入与 agent 处理，支持异步审批流 | 非常优雅，Quilin 应吸收 |
| 沙箱 | 每平台原生实现（Seatbelt/Landlock+Bubblewrap/Windows Restricted Token） | 深度集成操作系统安全机制 | 重量级但安全性极高，Quilin 可用 WASM 沙箱替代 |
| 状态持久化 | SQLite（log_db）+ JSONL（rollout） | 轻量、嵌入式、无需外部依赖 | 适合 CLI 场景，Quilin 需要更强的记忆层 |
| 配置管理 | 分层 TOML（global/project/team/enterprise） | 支持多层覆盖、组织级约束 | Quilin 应参考分层配置设计 |
| MCP 集成 | rmcp-client（Rust MCP 客户端） | 原生 Rust 实现，支持 stdio 和 WebSocket 传输 | Quilin 用 TS MCP SDK，但连接管理模式可参考 |
| 审批策略 | execpolicy（DSL 规则文件 .rules） | 声明式安全策略，支持热更新 | 创新且实用，Quilin 应吸收 |
| 上下文压缩 | 双路径（本地 inline / OpenAI remote compact） | OpenAI 用远程端点，其他用本地 LLM 压缩 | 远程 compact 是 OpenAI 专属优势，但双路径设计值得借鉴 |
| Agent 模式 | 双循环（外层 submission_loop + 内层 run_turn 循环） | 外层分发所有 Op，内层驱动多步工具执行 | 清晰分层，Quilin 应参考 |

## 3. 核心文件分析

### codex-rs/protocol/src/protocol.rs (~2000+ 行)

**职责**：定义 Codex 会话的完整通信协议——SQ/EQ 模式的所有消息类型。

**核心结构**：

1. **`Submission`**（行 107-116）— 用户→Agent 的请求
```rust
pub struct Submission {
    pub id: String,           // 唯一 ID，用于关联 Event
    pub op: Op,               // 操作载荷
    pub trace: Option<W3cTraceContext>,  // W3C 分布式追踪
}
```

2. **`Op` 枚举**（行 379-688）— 30+ 种操作类型
   - `UserInput` / `UserTurn` — 用户消息（UserTurn 携带完整 turn 上下文：cwd、审批策略、沙箱策略、模型等）
   - `ExecApproval` / `PatchApproval` — 命令/补丁审批
   - `OverrideTurnContext` — 运行时更新会话上下文
   - `InterAgentCommunication` — Agent 间通信
   - `Compact` — 手动触发上下文压缩
   - `Undo` / `ThreadRollback` — 撤销操作
   - `RealtimeConversationStart/Audio/Text/Close` — 实时对话
   - `Shutdown` — 关闭会话

3. **`EventMsg` 枚举**（行 1396-1600）— 60+ 种事件类型
   - `TurnStarted/TurnComplete` — Turn 生命周期
   - `AgentMessage/AgentMessageDelta` — 模型输出（完整/流式增量）
   - `AgentReasoning/AgentReasoningDelta` — 推理过程
   - `ExecCommandBegin/OutputDelta/End` — 命令执行生命周期
   - `McpToolCallBegin/End` — MCP 工具调用
   - `ExecApprovalRequest` — 审批请求
   - `GuardianAssessment` — Guardian 安全评估
   - `ContextCompacted` — 上下文压缩完成
   - `CollabAgent*` — 协作 Agent 事件（Spawn/Interaction/Waiting/Close/Resume）

4. **`AskForApproval` 枚举**（行 816-847）— 审批策略
   - `UnlessTrusted` — 仅信任安全命令
   - `OnFailure` — 沙箱内自动执行，失败时升级
   - `OnRequest` — 模型决定何时请求审批（默认）
   - `Granular(GranularApprovalConfig)` — 细粒度控制（sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations）
   - `Never` — 永不审批（非交互模式）

**创新点**：
- `UserTurn` vs `UserInput` 的区分：`UserTurn` 携带完整 turn 上下文（cwd、沙箱策略、模型等），支持每 turn 独立配置。这是一个优雅的设计，允许客户端在每次交互时动态调整安全策略和模型选择。
- W3C Trace Context 集成：每个 Submission 可携带 W3C traceparent/tracestate，实现端到端分布式追踪。

**注意事项**：
- `Op` 标记为 `#[non_exhaustive]`，允许未来扩展而不破坏 API 兼容性
- EventMsg 显式注释"确保没有 optional 类型，否则会影响 extension code-gen"

### codex-rs/core/src/codex.rs (8,137 行)

**职责**：核心 Session 管理 + 双循环 Agent 引擎。

**核心结构 — Session**（行 838-860）

```rust
pub(crate) struct Session {
    pub(crate) conversation_id: ThreadId,
    tx_event: Sender<Event>,                    // 事件发送端
    agent_status: watch::Sender<AgentStatus>,   // Agent 状态广播
    state: Mutex<SessionState>,                 // 可变会话状态
    features: ManagedFeatures,                  // 不可变特性标志
    active_turn: Mutex<Option<ActiveTurn>>,     // 当前活跃 Turn
    mailbox: Mailbox,                           // Agent 间邮箱
    guardian_review_session: GuardianReviewSessionManager,  // Guardian 安全审查
    services: SessionServices,                  // 共享服务（模型客户端、MCP 等）
    js_repl: Arc<JsReplHandle>,                 // JS REPL 句柄
    // ...
}
```

**核心结构 — TurnContext**（行 879-924）

每个 Turn 的完整上下文快照，包含：
- 模型信息（model_info, reasoning_effort, reasoning_summary）
- 安全策略（approval_policy, sandbox_policy, file_system/network_sandbox_policy）
- 工具配置（tools_config, dynamic_tools）
- 环境信息（cwd, current_date, timezone, environment）
- 技能上下文（turn_skills）
- 追踪（session_telemetry, trace_id）

**双循环架构**：

1. **外层 `submission_loop`**（行 4658-4877）— Op 分发器

```rust
async fn submission_loop(sess: Arc<Session>, config: Arc<Config>, rx_sub: Receiver<Submission>) {
    while let Ok(sub) = rx_sub.recv().await {
        let should_exit = async {
            match sub.op.clone() {
                Op::Interrupt => { handlers::interrupt(&sess).await; false }
                Op::UserInput { .. } | Op::UserTurn { .. } => {
                    handlers::user_input_or_turn(&sess, sub.id.clone(), sub.op).await;
                    false
                }
                Op::ExecApproval { id, turn_id, decision } => { ... }
                Op::Compact => { handlers::compact(&sess, sub.id.clone()).await; false }
                Op::Shutdown => handlers::shutdown(&sess, sub.id.clone()).await,
                _ => false,  // #[non_exhaustive] 未知 Op 忽略
            }
        }.instrument(dispatch_span).await;
        if should_exit { break; }
    }
    sess.guardian_review_session.shutdown().await;
}
```

这是一个纯粹的消息分发器，接收 Submission 并路由到对应 handler。每个 Op 的处理返回 `bool` 表示是否退出循环。

2. **内层 `run_turn`**（行 6126-6425+）— Agent 执行引擎

```rust
pub(crate) async fn run_turn(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
    prewarmed_client_session: Option<ModelClientSession>,
    cancellation_token: CancellationToken,
) -> Option<String> {
    // 1. Pre-sampling compact（自动压缩检查）
    let pre_sampling_compacted = run_pre_sampling_compact(&sess, &turn_context).await?;
    
    // 2. 记录上下文更新
    sess.record_context_updates_and_set_reference_context_item(turn_context.as_ref()).await;
    
    // 3. 解析技能和插件注入
    let mcp_tools = sess.services.mcp_connection_manager.read().await.list_all_tools()...;
    let skill_items = build_skill_injections(&mentioned_skills, ...).await;
    
    // 4. Hook 执行（session_start, user_prompt_submit）
    if run_pending_session_start_hooks(&sess, &turn_context).await { return None; }
    
    // 5. 内层循环 — 多步工具执行
    loop {
        // 5a. 处理 pending input（用户中途输入）
        let pending_input = if can_drain_pending_input {
            sess.get_pending_input().await
        } else { Vec::new() };
        
        // 5b. 构建完整 prompt（从历史重建）
        let sampling_request_input: Vec<ResponseItem> = {
            sess.clone_history().await.for_prompt(&turn_context.model_info.input_modalities)
        };
        
        // 5c. 调用模型 API（流式）
        // 5d. 处理模型输出（工具调用 → 执行 → 反馈）
        // 5e. 自动 compact（mid-turn）
        // 5f. 如果模型不再产生工具调用，break
    }
}
```

**关键洞察**：内层循环是真正的 "Agent Loop"。每次迭代都：
1. 从 `ContextManager` 重建完整 prompt（无状态 API 调用）
2. 发送到模型 API 获取流式响应
3. 处理输出：如果是工具调用，执行工具并将结果加入历史
4. 如果模型不再产生工具调用，结束 Turn

**Spawn 流程**（行 451-700）：

`Codex::spawn()` 创建新 Session 的完整流程：
1. 创建 SQ/EQ 通道
2. 加载技能（skills_manager）和插件（plugins_manager）
3. 加载 exec policy
4. 解析模型和 base instructions（优先级：config > 历史 > 模型默认）
5. 恢复动态工具（dynamic_tools）
6. 构建 SessionConfiguration
7. 创建 Session
8. 启动 submission_loop 作为 tokio task

**Pre-sampling Compact**（行 6689-6794）：

```rust
async fn run_pre_sampling_compact(sess, turn_context) -> CodexResult<bool> {
    // 1. 模型降档压缩（切换到更小上下文窗口时）
    let pre_sampling_compacted = maybe_run_previous_model_inline_compact(
        sess, turn_context, total_usage_tokens
    ).await?;
    
    // 2. 常规上限压缩（超过 auto_compact_limit）
    if total_usage_tokens >= auto_compact_limit {
        run_auto_compact(sess, turn_context, DoNotInject, ContextLimit, PreTurn).await?;
    }
    Ok(pre_sampling_compacted)
}
```

创新点：模型降档检测（行 6726-6764）——当切换到更小上下文窗口的模型时，用旧模型的上下文窗口执行压缩，防止 token 溢出。

**双路径 Compact**（行 6767-6794）：
- OpenAI 提供者 → `run_inline_remote_auto_compact_task`（使用 `/responses/compact` 端点）
- 其他提供者 → `run_inline_auto_compact_task`（本地模型压缩）

### codex-rs/core/src/mcp_tool_call.rs (1,641 行)

**职责**：MCP 工具调用的完整生命周期管理。

**核心函数 `handle_mcp_tool_call()`**（行 74-351）：

```rust
pub(crate) async fn handle_mcp_tool_call(
    sess: Arc<Session>,
    turn_context: &Arc<TurnContext>,
    call_id: String,
    server: String,
    tool_name: String,
    arguments: String,
) -> CallToolResult {
    // 1. 解析 JSON 参数
    let arguments_value = serde_json::from_str::<Value>(&arguments)?;
    
    // 2. 查询工具元数据
    let metadata = lookup_mcp_tool_metadata(sess, turn_context, &server, &tool_name).await;
    
    // 3. 确定审批模式（Apps 用 app_tool_policy，自定义 MCP 用 custom_mcp_tool_approval_mode）
    let approval_mode = ...;
    
    // 4. 发送 McpToolCallBegin 事件
    notify_mcp_tool_call_event(sess, turn_context, tool_call_begin_event).await;
    
    // 5. 审批流程（如需要）
    if let Some(decision) = maybe_request_mcp_tool_approval(...).await {
        match decision {
            Accept | AcceptForSession | AcceptAndRemember => {
                // 标记 memory mode 为 polluted（web search 等敏感操作）
                maybe_mark_thread_memory_mode_polluted(sess, turn_context).await;
                // 执行调用
                let result = execute_mcp_tool_call(sess, turn_context, &server, &tool_name, ...).await;
                // 发送 McpToolCallEnd 事件
                notify_mcp_tool_call_event(sess, turn_context, tool_call_end_event).await;
            }
            Decline { message } => { ... }
            Cancel | BlockedBySafetyMonitor(_) => { ... }
        }
    }
    
    // 6. 无需审批时直接执行
    let result = execute_mcp_tool_call(sess, turn_context, ...).await;
    
    // 7. 记录指标（codex.mcp.call / codex.mcp.call.duration_ms）
    emit_mcp_call_metrics(turn_context, status, &tool_name, ...);
}
```

**创新点**：
- 多级审批决策：`Accept`（本次）、`AcceptForSession`（本会话）、`AcceptAndRemember`（永久）、`Decline`、`Cancel`、`BlockedBySafetyMonitor`
- Memory Mode Pollution：MCP 工具调用和 Web Search 会标记线程的 memory mode 为 "polluted"，防止敏感数据被记忆化
- 结构化指标：每次 MCP 调用都记录 count 和 duration，按 status/tool/connector 维度打标签

### codex-rs/sandboxing/src/manager.rs (~250 行)

**职责**：跨平台沙箱管理。

**核心类型**：

```rust
pub enum SandboxType {
    None,              // 无沙箱
    MacosSeatbelt,     // macOS Seatbelt（sandbox-exec）
    LinuxSeccomp,      // Linux Landlock + Bubblewrap
    WindowsRestrictedToken,  // Windows Restricted Token
}
```

**`SandboxManager::select_initial()`**（行 146-173）：

根据 `SandboxablePreference`（Auto/Require/Forbid）和平台自动选择沙箱类型。Auto 模式下，只有当文件系统或网络策略需要时才启用。

**`SandboxManager::transform()`**（行 175+）：

将普通命令转换为沙箱化命令。处理：
- `EffectiveSandboxPermissions` — 合并基础策略和额外权限
- 平台特定参数生成（Seatbelt profile / Landlock rules / Windows restricted token）
- 网络代理集成（`allow_network_for_proxy`）

**可吸收点**：`SandboxablePreference::Auto` 模式——不是一刀切的沙箱策略，而是根据实际需要的权限动态决定是否启用沙箱。

### codex-rs/core/src/exec_policy.rs (前 400 行)

**职责**：命令执行审批策略引擎。

**核心类型**：

```rust
pub(crate) struct ExecPolicyManager {
    policy: ArcSwap<Policy>,           // 热可换策略（无锁读、原子替换）
    update_lock: tokio::sync::Mutex<()>,  // 写入互斥
}
```

**`ArcSwap<Policy>`**（行 192）是关键设计：
- 使用 `arc-swap` crate 实现无锁读取当前策略
- 策略更新时创建新 Policy 对象并原子替换
- 支持运行时热更新：`append_amendment_and_update()` 可在不重启 session 的情况下追加新规则

**审批决策流程** `create_exec_approval_requirement_for_command()`（行 226-310）：

```
命令 → 解析为多条子命令 → exec_policy.check_multiple() → Decision
  ├─ Allow（policy rule 匹配）  → Skip（可选 bypass_sandbox）
  ├─ Prompt（需要用户审批）     → NeedsApproval + 建议的 amendment
  ├─ Forbidden（禁止执行）      → Forbidden
  └─ 未匹配                     → 退回到 sandbox/heuristic 判断
```

**BANNED_PREFIX_SUGGESTIONS**（行 50-97）：禁止自动生成 allow 规则的命令前缀列表（python, bash, sh, node, ruby 等解释器）。这防止了"allow python"类的宽泛规则，因为这实际上等于绕过所有安全检查。

**创新点**：
- 声明式 `.rules` 文件格式，类似防火墙规则
- 热更新策略（ArcSwap 无锁读 + 原子替换）
- 智能 amendment 建议：当用户审批一条命令时，系统自动推导最小化的 allow 规则并建议持久化

### codex-rs/cli/src/main.rs (2,173 行)

**职责**：CLI 入口和命令路由。

采用 `MultitoolCli` 作为顶层结构，通过 `arg0_dispatch_or_else()` 支持基于可执行文件名的分发（例如 `codex-x86_64-unknown-linux-musl` 自动映射到 `codex`）。

关键子命令：
- 无子命令 → 交互式 TUI（`codex-tui::run()`）
- `exec` → 非交互执行
- `mcp` → MCP 服务器管理
- `mcp-server` → 作为 MCP 服务器运行
- `sandbox macos/linux/windows` → 沙箱命令
- `resume/fork` → 会话恢复/分叉
- `cloud` → 云任务（实验性）

**注意事项**：`app-server` 模式支持 HTTP API 接口，使 Codex 可以被 Web 前端调用。

### codex-rs/core/src/stream_events_utils.rs (前 200 行)

**职责**：模型流式输出的处理工具。

**核心类型 `HandleOutputCtx`**（行 197-200）：

```rust
pub(crate) struct HandleOutputCtx {
    pub sess: Arc<Session>,
    pub turn_context: Arc<TurnContext>,
    pub tool_runtime: ToolCallRuntime,
}
```

**关键函数**：
- `record_completed_response_item()` — 完成项立即持久化到历史和 rollout（即使 turn 后来被取消也保留）
- `handle_output_item_done()` — 处理完成的输出项，触发工具执行 future
- `raw_assistant_output_text_from_item()` — 提取 assistant 原始文本
- `strip_hidden_assistant_markup()` — 剥离 citations、plan blocks 等内部标记

**创新点**：
- Memory Citation 处理：从 assistant 输出中解析 citation → thread_id 映射，记录 stage1 output usage
- Memory Mode Pollution 检测：web_search 调用自动将线程标记为 "polluted"，防止敏感数据进入记忆系统

### codex-rs/core/src/thread_manager.rs (前 400 行)

**职责**：多线程（对话）生命周期管理。

**核心结构**：

```rust
pub struct ThreadManager {
    state: Arc<ThreadManagerState>,
}

struct ThreadManagerState {
    threads: Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>,
    thread_created_tx: broadcast::Sender<ThreadId>,
    auth_manager: Arc<AuthManager>,
    models_manager: Arc<ModelsManager>,
    environment_manager: Arc<EnvironmentManager>,
    skills_manager: Arc<SkillsManager>,
    plugins_manager: Arc<PluginsManager>,
    mcp_manager: Arc<McpManager>,
    // ...
}
```

**ForkSnapshot**（行 151-171）— Fork 模式：

```rust
pub enum ForkSnapshot {
    TruncateBeforeNthUserMessage(usize),  // 在第 N 条用户消息前截断
    Interrupted,  // 模拟中断状态的 fork
}
```

**关键能力**：
- `fork_thread()` — 分叉线程（带历史截断选项）
- `spawn_thread()` — 创建子 Agent 线程
- 线程间通信通过 `InterAgentCommunication` Op
- `ThreadShutdownReport` — 报告完成/失败/超时的线程

**创新点**：
- SkillsWatcher 集成：监听文件系统变化自动清除技能缓存
- 共享服务实例（auth, models, mcp, skills）——所有子线程共享同一套服务实例，减少资源消耗

### codex-rs/codex-mcp/src/mcp_connection_manager.rs (1,824 行)

**职责**：MCP 服务器连接的完整生命周期管理。

**核心类型**：

```rust
// 每个 MCP 服务器的工具信息
pub struct ToolInfo {
    pub server_name: String,        // MCP 服务器名称
    pub callable_name: String,      // 模型可见的工具名（完全限定）
    pub callable_namespace: String, // 工具命名空间
    pub server_instructions: Option<String>,  // 服务器级指令
    pub tool: Tool,                 // 原始 MCP Tool 定义
    pub connector_id: Option<String>,
    pub connector_name: Option<String>,
    pub plugin_display_names: Vec<String>,
}
```

**工具名限定**：使用双下划线 `__` 作为分隔符（`MCP_TOOL_NAME_DELIMITER`），生成模型可见的完全限定名。

**关键设计**：
- 默认启动超时 30 秒（`DEFAULT_STARTUP_TIMEOUT`）
- 默认工具调用超时 120 秒（`DEFAULT_TOOL_TIMEOUT`）
- Codex Apps 工具缓存：使用 SHA1 哈希生成缓存 key，支持离线使用
- `tool_with_model_visible_input_schema()` — 处理 OpenAI file params 的 schema 掩码，对模型隐藏文件路径参数的实现细节

**创新点**：
- Elicitation 支持：MCP 服务器可以通过 elicitation 机制向用户请求额外输入
- 认证状态聚合：`compute_auth_statuses()` 跨所有 MCP 服务器聚合认证状态

### codex-rs/state/src/log_db.rs (~200 行)

**职责**：结构化日志写入 SQLite 数据库。

**核心类型**：

```rust
pub struct LogDbLayer {
    sender: mpsc::Sender<LogDbCommand>,
    process_uuid: String,
}
```

实现为 `tracing_subscriber::Layer`，捕获 tracing 事件并异步写入 SQLite。

**关键设计**：
- 异步批量写入：通过 `mpsc::channel(512)` + 批量 INSERT（`LOG_BATCH_SIZE = 128`）
- 定时刷新：`LOG_FLUSH_INTERVAL = 2 秒`
- 进程 UUID：每个进程生成唯一 UUID，用于区分日志来源
- 线程 ID 关联：通过 span 上下文提取 `thread_id` 字段

**注意事项**：使用 `try_send` 而不是 `send`，在队列满时丢弃日志而不阻塞应用程序。这是正确的选择——日志不应该影响核心功能。

### codex-rs/core/src/context_manager/history.rs (~180 行)

**职责**：对话历史的内存管理和 prompt 构建。

**核心结构**：

```rust
pub(crate) struct ContextManager {
    items: Vec<ResponseItem>,           // 有序历史（oldest → newest）
    history_version: u64,               // 历史版本号（compact/rollback 时递增）
    token_info: Option<TokenUsageInfo>, // Token 使用统计
    reference_context_item: Option<TurnContextItem>,  // 上下文差分基线
}
```

**`for_prompt()`**（行 120-125）：

```rust
pub(crate) fn for_prompt(mut self, input_modalities: &[InputModality]) -> Vec<ResponseItem> {
    self.normalize_history(input_modalities);
    self.items.retain(|item| !matches!(item, ResponseItem::GhostSnapshot { .. }));
    self.items
}
```

每次模型调用前，从内存历史重建完整 prompt。关键步骤：
1. `normalize_history()` — 规范化历史（修复不匹配的 call/output 对、剥离不支持的 modality 等）
2. 移除 GhostSnapshot（内部用，模型不可见）
3. 返回干净的 ResponseItem 列表

**`reference_context_item`** — 上下文差分基线：

用于计算 turn 间的上下文变化（cwd 切换、模型切换等），只发送差分而非全量重注入。当 compact 或 rollback 清除基线时，下次 turn 会执行全量上下文重注入。

**创新点**：
- Token 估算使用字节启发式（`approx_token_count`），避免调用 tokenizer 的开销
- 历史版本号（`history_version`）用于检测 compact/rollback 导致的历史变更

## 4. 创新点清单

| # | 创新点 | 描述 | 对 Quilin 的价值 | 关联领域 |
|---|--------|------|------------------|----------|
| 1 | SQ/EQ 队列对架构 | SQ bounded(512) + EQ unbounded，分离用户输入与 Agent 处理，提供背压控制 | **高** — Quilin 的 E-T-C-S-L-V 工具调用可以参考此模式解耦消息流 | 09-部署运行时 |
| 2 | 双循环 Agent 引擎 | 外层 submission_loop 分发 Op，内层 run_turn 驱动多步工具执行 | **高** — 清晰分层设计，Quilin 的 core loop 应参考 | 01-LLM 接入 |
| 3 | ArcSwap 热更新 ExecPolicy | 无锁读 + 原子替换策略，运行时追加规则无需重启 | **高** — 直接用于 Quilin 的自进化机制（运行时更新安全规则） | 07-安全, 10-自进化 |
| 4 | 模型降档压缩 | 切换到更小上下文窗口时，用旧模型的上下文执行 compact | **中** — Quilin 多模型切换时的上下文管理策略 | 02-上下文 |
| 5 | 双路径 Compact | OpenAI 用远程 `/responses/compact`，其他用本地 LLM 压缩 | **中** — Quilin 可实现类似的提供者特化压缩 | 02-上下文, 03-记忆 |
| 6 | Memory Mode Pollution | MCP/WebSearch 调用标记线程为 polluted，阻止记忆化 | **高** — Quilin 的 OmniMem 必须处理数据污染问题 | 03-记忆, 07-安全 |
| 7 | GranularApprovalConfig | 5 维细粒度审批控制（sandbox, rules, skill, permissions, mcp_elicitations） | **高** — 比 Quilin 当前的权限层级更精细 | 07-安全 |
| 8 | 声明式 .rules 文件 | 类防火墙规则的命令审批 DSL，支持 prefix match / heuristics | **中** — Quilin 可参考但需适配 TS 生态 | 07-安全 |
| 9 | BANNED_PREFIX_SUGGESTIONS | 禁止对解释器命令（python, bash, node 等）生成宽泛 allow 规则 | **中** — 安全基线设计参考 | 07-安全 |
| 10 | W3C Trace Context 集成 | 每个 Submission 携带 traceparent/tracestate，支持端到端追踪 | **高** — Quilin 的 OTel 集成应原生支持 | 08-可观测性 |
| 11 | ForkSnapshot 模式 | TruncateBeforeNthUserMessage / Interrupted 两种 fork 策略 | **中** — Quilin 的子 Agent 创建可参考 | 06-多 Agent |
| 12 | ThreadManager 共享服务 | 所有子线程共享 auth, models, mcp, skills 实例 | **高** — Quilin 的 Homogeneous Spawn 架构的资源管理参考 | 06-多 Agent |
| 13 | 上下文差分注入 | reference_context_item 作为基线，只注入变化的上下文 | **高** — 直接减少 token 消耗 | 02-上下文 |
| 14 | Pre-warming ModelClientSession | 跨 retry 复用 WebSocket session 和 sticky routing | **中** — 减少模型调用延迟 | 01-LLM 接入 |
| 15 | Pending Input 中途注入 | 模型运行时用户可提交 pending input，下次循环迭代时注入 | **中** — 用户 steer 能力，增强交互性 | 04-规划 |
| 16 | Guardian Safety Monitor | 独立的 Guardian 子 Agent 审查危险操作 | **高** — AI 审查 AI 的安全模式，Quilin 应深入研究 | 07-安全 |
| 17 | NetworkProxy 域名级控制 | HTTP/SOCKS 代理 + 域名 allow/deny 列表 + 审计日志 | **中** — Quilin 的网络安全层参考 | 07-安全, 09-部署运行时 |
| 18 | 日志异步批量写入 | tracing Layer → mpsc → 批量 SQLite INSERT，try_send 不阻塞 | **中** — 可观测性数据的高效写入模式 | 08-可观测性 |

## 5. Quilin 关联评分

| 领域 | 评分 (0-5) | 具体关联 |
|------|-----------|----------|
| 01-LLM 接入 | 4 | 双循环架构、无状态 API 调用、ModelClientSession 复用、模型降档检测。但仅支持 OpenAI Responses API，无 litellm 级别的多模型抽象。 |
| 02-上下文 | 5 | ContextManager 全量重建 prompt 模式、上下文差分注入（reference_context_item）、双路径 Compact（本地/远程）、pre-sampling 压缩、SUMMARIZATION_PROMPT 模板、token 估算。这是 Codex 做得最深的领域。 |
| 03-记忆 | 2 | Memory Mode Pollution 标记、Memory Citation 追踪、stage1 output usage 记录。但核心记忆系统（memories 模块）未深入调研，评分保守。Codex 的记忆能力远弱于 Quilin OmniMem 4 层设计。 |
| 04-规划 | 3 | Pending Input 注入（用户中途 steer）、Plan Mode（strip_proposed_plan_blocks）、PlanDelta 事件流。但无显式的任务分解和策略切换机制。 |
| 05-工具 | 5 | MCP 完整生命周期管理（连接/工具列表/调用/审批/超时）、exec_policy 声明式规则、沙箱隔离、工具名限定（namespace__tool）、Dynamic Tools、Skills 系统。工具工程是 Codex 的另一个深度领域。 |
| 06-多 Agent | 4 | ThreadManager fork/spawn、InterAgentCommunication、共享服务架构、Collab Agent 事件（Spawn/Interaction/Waiting）、agent_max_depth 递归限制。但缺乏异构 Agent Mesh 能力。 |
| 07-安全护栏 | 5 | 4 层安全：exec_policy DSL + AskForApproval 5 级策略 + 平台原生沙箱 + Guardian AI 审查 + NetworkProxy 域名控制 + GranularApprovalConfig 5 维细粒度 + BANNED_PREFIX_SUGGESTIONS。安全是 Codex 做得最极致的领域。 |
| 08-可观测性 | 4 | W3C Trace Context 端到端集成、结构化 tracing（OpenTelemetry span）、SessionTelemetry 指标计数器、LogDbLayer SQLite 持久化、codex-analytics 事件追踪。缺少的是外部可观测性平台集成。 |
| 09-部署运行时 | 4 | SQ/EQ 架构、CLI/Exec/MCP-Server/App-Server 多模式部署、Resume/Fork 会话管理、CancellationToken 优雅关闭、config 分层覆盖（global/project/team/enterprise）。 |
| 10-自进化 | 2 | Skills 系统（SkillsManager + SkillsWatcher 文件监听）、ArcSwap 热更新 exec_policy。但没有 Quilin 级别的 trajectory 分析、scaffold 自修改。评分保守。 |
| 11-Agent Mesh | 1 | 仅有 InterAgentCommunication 和 ThreadManager fork/spawn。没有跨进程/跨网络的 Agent 发现和通信能力。Quilin 的 AgentMesh SDK 远超 Codex 此领域。 |

## 6. 吸收计划

### 建议吸收

**优先级 P0（直接吸收）**：

1. **SQ/EQ 队列对模式** — Quilin 的 core loop 应采用 bounded submission + unbounded event 的异步通信模式。这比固定的状态图更灵活，且提供了自然的背压控制。
   - 实施路径：TS 中使用 `p-queue`（bounded）+ EventEmitter（unbounded）模拟

2. **双循环 Agent 引擎** — 外层消息分发 + 内层多步工具执行。Quilin 的 Agent Loop 应分为：
   - Dispatch Loop：处理所有入站消息（用户输入、审批响应、MCP 事件等）
   - Turn Loop：驱动 LLM→Tool→LLM 的多步执行循环

3. **上下文差分注入** — Quilin 的 Context 工程应实现 reference_context_item 基线 + 差分更新模式，避免每次 turn 都全量重注入 system prompt。

4. **GranularApprovalConfig** — Quilin 的权限层级应支持类似的多维细粒度控制，至少包含：sandbox, mcp, skill, network 四个维度。

5. **W3C Trace Context** — Quilin 的 OTel 集成应在所有跨边界消息中携带 W3C traceparent，实现端到端追踪。

**优先级 P1（改造后吸收）**：

6. **ArcSwap 热更新模式** — Quilin 的安全规则和配置系统应支持运行时热更新。TS 中可用 `Proxy` 或 getter pattern + 原子引用计数模拟。

7. **Memory Mode Pollution** — Quilin 的 OmniMem 必须实现"数据来源标记"机制。当使用 MCP/WebSearch 等外部工具时，线程记忆应被标记为 polluted，防止外部数据被持久化为长期记忆。

8. **模型降档压缩** — Quilin 支持多模型时，应在模型切换时自动检测上下文窗口大小变化，必要时触发 compact。

9. **ThreadManager 共享服务** — Quilin 的子 Agent 创建应共享父 Agent 的 LLM client、MCP connections 等重型资源。

10. **Pre-warming Session** — Quilin 可以在 turn 开始前预热 LLM 连接（WebSocket session），减少首 token 延迟。

**优先级 P2（参考设计）**：

11. **声明式安全策略** — 参考 Codex 的 `.rules` 文件设计，为 Quilin 设计类似的声明式安全策略格式。但考虑到 Quilin 目标是通用 Agent 框架，策略格式应更灵活。

12. **Guardian Safety Monitor** — 参考 Codex 的 Guardian 子 Agent 模式，Quilin 的安全护栏可引入"AI 审查 AI"的第二道防线。

13. **ForkSnapshot** — Quilin 的子 Agent 创建支持类似的历史截断选项。

### 明确不吸收

1. **Rust-only 核心** — Codex 用 Rust 实现核心逻辑是因为 OpenAI 的性能要求和跨平台编译需求。Quilin 的 TS 核心 + Rust infra 的三语言架构更适合快速迭代和 ML 生态集成。

2. **OpenAI Responses API 强绑定** — Codex 深度绑定 OpenAI Responses API（包括远程 compact 端点）。Quilin 应保持 litellm 级别的多模型抽象。

3. **平台原生沙箱** — Seatbelt/Landlock/Windows Restricted Token 是重量级实现。Quilin 应优先使用 WASM 沙箱（更轻量、更可移植），仅在需要原生执行时考虑平台沙箱。

4. **clap CLI 框架** — TS 生态有 commander/yargs 等成熟方案。

5. **SQLite 日志持久化** — Codex 用 SQLite 做日志存储是 CLI 工具的务实选择。Quilin 作为 Agent 框架应使用 OTel exporter 输出到外部可观测性平台。

### 与现有设计的冲突

| Quilin 设计 | Codex 设计 | 冲突点 | 建议处理 |
|-------------|-----------|--------|----------|
| E-T-C-S-L-V 作为 LLM 可调用工具 | 固定的 Op→handler 分发 | Quilin 的六能力是动态工具，Codex 的 Op 是固定枚举 | 保持 Quilin 的灵活性，但内部实现可参考 Codex 的 SQ/EQ 通信 |
| OmniMem 4 层记忆 | 基本的 ContextManager + Memory Citation | Codex 的记忆能力很弱 | Quilin 的设计远超 Codex，不需要调整 |
| AgentMesh 网络能力 | 进程内 ThreadManager | Codex 没有跨进程 Agent 通信 | Quilin 已有更好的设计，不受影响 |
| 无状态设计（每次重建 prompt） | 无状态设计（ContextManager.for_prompt()） | 两者一致！ | 验证了 Quilin 的无状态设计决策是正确的 |
| 自进化（trajectory 分析 + scaffold 自修改） | 仅有 Skills 热加载 | Codex 几乎没有自进化能力 | Quilin 的设计远超 Codex，不需要调整 |
