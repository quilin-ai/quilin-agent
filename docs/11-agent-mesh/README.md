# 智能体网格工程 / Agent Mesh Engineering

## 当前状态 / Current Status

As of 2026-05-02, Agent Mesh is an Iter D stub and contract area. The Rust `crates/mesh-sdk` crate keeps local validation types such as `AgentCard`, `MeshRequest`, capability discovery, and `AuditFields`; it does not expose a runtime `MeshClient`, local transport, dispatch loop, network listener, or `meshd` connection behavior.

截至 2026-05-02，Agent Mesh 仍是第 D 轮（Iter D）的占位契约区域。Rust `crates/mesh-sdk` crate 只保留 `AgentCard`（Agent 能力卡片）、`MeshRequest`（Mesh 请求信封）、能力发现预检查和 `AuditFields`（身份/审计字段）等本地校验类型；它不暴露运行时 `MeshClient`、本机传输、派发循环、网络监听器或 `meshd` 连接行为。

The runtime integration path remains deferred to Linear [QUI-10](https://linear.app/quilin-agent/issue/QUI-10/iter-f-land-agent-mesh-runtime-path). Until that work is explicitly reopened, Quilin core must not add cross-process or cross-network mesh behavior.

运行时接入路径仍延期到 Linear [QUI-10](https://linear.app/quilin-agent/issue/QUI-10/iter-f-land-agent-mesh-runtime-path)。在该任务被明确重启前，Quilin core 不得新增跨进程或跨网络的 Mesh 行为。

## 问题定义 / Problem Definition

Agent ecosystems are fragmented: Claude Code, Codex, Gemini CLI, Hermes, OpenClaw, and other agents can run side by side without a shared discovery or messaging layer.

Agent 生态是碎片化的：Claude Code、Codex、Gemini CLI、Hermes、OpenClaw 等 Agent 可以并行运行，但没有共享的发现和消息层。

The long-term target is for Quilin to communicate with other independent agents through a mesh network while keeping orchestration strategy under user control.

长期目标是让 Quilin 能通过 Mesh 网络与其他独立 Agent 通信，同时把编排策略保留给用户决定。

## 与 06 多 Agent 的边界 / Boundary With 06 Multi-Agent

| 维度 / Dimension | 06 多 Agent / 06 Multi-Agent | 11 Agent Mesh / 11 Agent Mesh |
| --- | --- | --- |
| Agent 来源 / Agent source | 同一框架内 spawn / Spawned inside the same framework | 独立进程或机器 / Independent processes or machines |
| Agent 类型 / Agent type | 同构为主 / Mostly homogeneous | 异构为主 / Mostly heterogeneous |
| 状态模型 / State model | 可共享 runtime state / Can share runtime state | 消息传递且状态隔离 / Message passing with state isolation |
| 生命周期 / Lifecycle | 随父 Agent 管理 / Managed by parent agent | 独立生命周期 / Independent lifecycle |
| 当前实现 / Current implementation | TS supervisor contracts exist / TS supervisor contracts exist | Rust stub contracts only / Rust stub contracts only |

## 与 AgentMesh 的关系 / Relationship With AgentMesh

AgentMesh is treated as a separate communication project. Its future `meshd` daemon is responsible for discovery, routing, delivery, push adapters, envelope validation, and network topology.

AgentMesh 被视为独立通信项目。未来的 `meshd` daemon 负责发现、路由、投递、推送适配器、信封校验和网络拓扑。

Quilin should eventually join the mesh as an ordinary agent, not become the mesh control plane.

Quilin 未来应作为普通 Agent 接入 Mesh，而不是成为 Mesh 控制面。

| 职责 / Responsibility | 归属 / Owner |
| --- | --- |
| 消息路由与投递 / Message routing and delivery | AgentMesh `meshd` |
| Agent 发现 / Agent discovery | AgentMesh `meshd` |
| 入站推送 / Inbound push | AgentMesh adapters |
| 出站 Mesh MCP tools / Outbound Mesh MCP tools | AgentMesh `meshd` |
| 连接 `meshd` / Connect to `meshd` | Deferred Quilin runtime work |
| 处理收到的消息 / Handle received messages | Deferred Quilin runtime work |
| 编排和分工策略 / Orchestration strategy | User policy |

## 当前 Rust 契约 / Current Rust Contract

The Rust crate may validate local contract shapes and preflight capability support. It must stay side-effect free: no network access, no background task, no runtime dispatch, and no direct WriteAuthority bypass.

Rust crate 可以校验本地契约形状并预检查能力支持。它必须保持无副作用：不访问网络、不启动后台任务、不执行运行时派发，也不绕过 WriteAuthority（写权限闸门）。

The current accepted surface is:

当前允许的表面包括：

- `AgentCard`（Agent 能力卡片 / agent capability card）
- `MeshRequest`（Mesh 请求信封 / mesh request envelope）
- `MeshDispatchPreflightReport`（派发前检查报告 / dispatch preflight report）
- `AuditFields`（身份与审计字段 / identity and audit fields）
- Local capability discovery and validation helpers（本地能力发现与校验 helper）

The current forbidden surface is:

当前禁止的表面包括：

- Runtime `MeshClient`（运行时 Mesh 客户端）
- `LocalTransport` or dispatch transport（本机传输或派发传输）
- Network listeners or `meshd` connections（网络监听器或 `meshd` 连接）
- Cross-process routing from Quilin core（Quilin core 内的跨进程路由）

## 未来启动流程 / Future Startup Flow

The following flow is target behavior for a later runtime slice, not evidence that the current repository already supports mesh networking.

以下流程是后续 runtime 切片的目标行为，不代表当前仓库已经支持 Mesh 网络。

```text
Quilin starts
  -> detects local meshd
  -> connects through an approved SDK adapter
  -> registers an Agent Card
  -> opens an inbound push channel
  -> exposes mesh tools through the normal tool registry
```

```text
Quilin 启动
  -> 检测本机 meshd
  -> 通过已批准的 SDK adapter 连接
  -> 注册 Agent Card
  -> 建立入站推送通道
  -> 通过正常工具注册表暴露 mesh 工具
```

## 降级原则 / Degradation Principles

Mesh must remain optional. If `meshd` is unavailable in a future runtime implementation, Quilin should start normally and only mesh-specific actions should return explicit unavailable errors.

Mesh 必须保持可选。未来 runtime 实现中，如果 `meshd` 不可用，Quilin 应正常启动，只有 Mesh 专属操作返回明确的不可用错误。

No mesh failure should block memory, planning, context assembly, local tools, or the main agent loop.

任何 Mesh 故障都不应阻塞记忆、规划、上下文组装、本地工具或主 Agent Loop。

## 验收标准 / Acceptance Criteria

Runtime mesh work is not accepted until it proves permission, audit, trace, and fallback behavior with local tests.

运行时 Mesh 工作必须用本地测试证明权限、审计、trace 和降级行为后才能验收。

| 场景 / Scenario | 验收点 / Acceptance point |
| --- | --- |
| `meshd` running | Connects and registers without blocking startup |
| `meshd` unavailable | Degrades clearly and keeps non-mesh features working |
| Outbound request | Emits trace and audit events before dispatch |
| Inbound message | Preserves sender, timestamp, and envelope metadata |
| Write-capable request | Consults WriteAuthority before any write effect |
| Capability change | Updates Agent Card without restarting Quilin |

## 相关文档 / Related Documents

- [AgentMesh 项目总设计 / AgentMesh project design](./AgentMesh-项目总设计.md)
- [本机 MeshClient 实现计划 / Local MeshClient implementation plan](./local-meshclient-implementation-plan.md)
- [多 Agent 工程 / Multi-Agent engineering](../06-multi-agent/README.md)
- [安全护栏 / Safety guardrails](../07-safety-guardrails/README.md)
