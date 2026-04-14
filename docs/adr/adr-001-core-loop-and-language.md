# ADR-001: 核心 Agent Loop 与语言架构决策

> **状态**: Accepted
> **日期**: 2026-04-14
> **决策者**: Quilin Agent 团队

---

## 1. 背景与问题

Quilin Agent 当前的核心 Harness（`quilin/core/Harness.py`）使用 Python dict 模拟 LangGraph 状态图。这引发两个关键问题：

1. **是否应该真正集成 LangGraph 作为核心运行时？**
2. **核心代码应该使用什么语言？Python、TypeScript、Rust，还是混合？**

---

## 2. 行业调研：四大标杆 Agent 的核心架构

我们深度调研了 2026 年最成功的四个 AI Agent 项目：

| 项目 | 核心语言 | Agent Loop 实现 | 使用 LangGraph? | 核心设计哲学 |
|------|----------|-----------------|-----------------|-------------|
| **Claude Code** | TS → Rust 重写 | 单线程 while-loop，~88 行核心代码 | **否** | "the only state is a message array" |
| **Codex CLI** | Rust | 异步 submission/event queue (Tokio) | **否** | 无状态请求 + prompt cache 优化 |
| **OpenClaw** | TypeScript | Pi agent RPC runtime + Gateway | **否** | 本地优先 + 可插拔 ContextEngine |
| **Hermes Agent** | Python | AIAgent 迭代对话循环 | **否** | 学习循环是一等架构关注点 |

### 关键发现

**四个项目全部使用自研 Agent Loop，无一使用 LangGraph 或任何外部 Agent 框架。**

共同模式：
- **极简主循环** — while-loop 直到模型不再请求工具调用
- **消息数组为核心状态** — 不引入额外状态管理框架
- **自研工具分发** — 直接调度，不经过框架抽象层
- **流式原生** — streaming 作为一等能力内建
- **可调试性优先** — 简单 > 强大，可预测 > 灵活

### 为什么它们不用 LangGraph

| 原因 | 详细说明 |
|------|---------|
| **抽象税** | 框架引入额外概念（StateGraph、Annotation、Pregel），增加认知负担和调试难度 |
| **控制力不足** | 生产级 Agent 需要精细控制：prompt cache、ZDR 合规、自定义压缩策略 — 框架的通用抽象反而碍事 |
| **性能开销** | 框架的序列化/反序列化、事件分发、状态校验 = 每轮额外延迟 |
| **锁死风险** | 核心循环是最关键的代码路径，绑定外部框架意味着受其发布节奏和 breaking changes 约束 |
| **简单即可靠** | Claude Code: "sophisticated behavior emerges from well-designed constraints, not complex coordination mechanisms" |

---

## 3. 决策

### 决策 A：不使用 LangGraph 作为核心运行时，自研极简 Agent Loop

**理由**：

1. 四大标杆项目的一致选择验证了这个方向
2. Quilin 的状态复杂性在于子系统（OmniMem、PluginRegistry、MCPBus），而非 Loop 本身
3. Agent Loop 保持极简（< 200 行），子系统各自管理各自的状态
4. 完全掌控 streaming、checkpoint、中断恢复等关键能力的实现细节

**但必须自研实现 LangGraph 的四个核心能力**：

| LangGraph 能力 | 自研实现方案 |
|----------------|-------------|
| **Checkpoint / Resume** | 每个节点完成后持久化 AgentState 到 SQLite；崩溃后从最近 checkpoint 恢复 |
| **Human-in-the-Loop** | `decide` 节点支持 `interrupt` 状态，通过 SSE 推送审批请求，等待用户确认后继续 |
| **Conditional Edges** | Planning 层输出包含 `next_node` 路由决策，Loop 根据运行时条件动态选择下一节点 |
| **Streaming** | 每个节点的输出通过 AsyncIterator/ReadableStream 实时推送，不等整个 Loop 完成 |

### 决策 B：三语言架构 — TS (核心) + Python (ML) + Rust (基础设施)

**总体架构**：

```
┌─────────────────────────────────────────────────────────┐
│                    TypeScript Layer                       │
│   Agent Loop (E-T-C-S-L-V) · Context · State · Stream   │
│   UI / CLI · MCP Client Manager · LLM Router (litellm)  │
├─────────────────────────────────────────────────────────┤
│         MCP stdio          │    gRPC    │   HTTP SSE    │
├────────────────────────────┼────────────┼───────────────┤
│     Python ML Providers    │   Rust     │   Frontend    │
│  Vector Search · KG · DSPy │   Infra    │   (React)     │
│  OCR · Model Inference     │            │               │
│  (each = 1 MCP Server)     │            │               │
└────────────────────────────┴────────────┴───────────────┘
```

| 层 | 语言 | 职责 | 选择理由 |
|----|------|------|---------|
| **Agent Core** | TypeScript | E-T-C-S-L-V 主循环、状态管理、流式输出、MCP 客户端 | Vercel AI SDK 的 streaming 生态、AsyncIterator 原生支持、与前端同构 |
| **ML Providers** | Python | 向量检索(Qdrant)、知识图谱(Graphiti)、DSPy 优化器、OCR(PaddleOCR)、模型推理 | ML/AI 库生态无可替代，每个 Provider 封装为独立 MCP Server |
| **Infrastructure** | Rust | Agent Mesh 网络层、WASM 插件沙箱、向量索引引擎、CLI 工具 | 零 GC、内存安全、WASM 一等支持、极致性能 |

### 决策 C：通信协议分层

| 场景 | 协议 | 延迟 | 适用范围 |
|------|------|------|---------|
| TS ↔ Python Provider | **MCP stdio** | ~5ms | 90% 的跨语言调用（工具调用、记忆查询、KG 检索） |
| Agent ↔ Agent (Mesh) | **gRPC** | ~1ms | 高频、低延迟的 Agent 间协作（如多 Agent 任务分发） |
| Agent ↔ Frontend | **HTTP SSE** | 实时 | 流式输出到浏览器（token-by-token + 结构化 Data Parts） |
| Agent ↔ 外部工具 | **MCP stdio/SSE** | ~10ms | 连接第三方 MCP Server（文件系统、数据库、API） |

---

## 4. 核心 Agent Loop 设计

### 4.1 极简主循环（目标 < 200 行 TS）

```
while (!state.isTerminal) {
    // 1. 组装 prompt (system + memories + context + messages)
    // 2. 调用 LLM，流式接收响应
    // 3. 如果响应包含 tool_calls → 并行执行 → 结果追加到 messages
    // 4. 如果响应是 assistant message → 检查是否需要继续
    // 5. checkpoint 当前状态
}
```

对比当前 Harness.py 的 8 节点状态图：

| 当前 (Python 8 节点) | 新设计 (TS 极简 Loop) |
|----------------------|----------------------|
| verify_input → build_context → plan → execute_tools → verify_output → reflect → decide | LLM 自己决定何时调用工具、何时结束 |
| 每个节点是 Python 方法 | 工具调用是 LLM 的自然输出 |
| 手动状态转换 | 消息数组即状态 |
| 无 streaming | 原生 ReadableStream |
| 无 checkpoint | 每轮 SQLite 持久化 |

关键洞察：**当前的 8 节点设计把 LLM 应该自主决策的事情硬编码成了固定流程**。真正的 Agent Loop 应该让 LLM 自己选择：是直接回答、先查记忆、调用工具、还是请求澄清。E-T-C-S-L-V 六组件仍然存在，但作为 **可调用的工具/能力** 暴露给 LLM，而非固定的节点顺序。

### 4.2 E-T-C-S-L-V 重新定位

从"状态图的固定节点"变为"LLM 可调用的能力层"：

| 组件 | 旧角色 (状态图节点) | 新角色 (LLM 可调用工具) |
|------|-------------------|----------------------|
| **E** (Execution) | run() 的 wrapper | AgentState + checkpoint 持久层 |
| **T** (Tools) | execute_tools 节点 | MCP Tool Registry，LLM 直接调用 |
| **C** (Context) | build_context 节点 | system prompt 自动组装，记忆自动注入 |
| **S** (State) | AgentState dataclass | SQLite-backed state + 断点续行 |
| **L** (Lifecycle) | start/complete/fail | 进程管理 + 优雅关闭 + 心跳 |
| **V** (Verification) | verify_input/output 节点 | Guardrails middleware（前置 + 后置 hook） |

### 4.3 与 Quilin 特殊需求的对接

Quilin 不是简单的 Coding Agent，而是拥有 11 个能力域的通用框架。但 Loop 仍然可以保持极简，因为：

| 复杂性所在 | 承载方 | 说明 |
|-----------|--------|------|
| 4 层分级记忆 | OmniMem 子系统 | 通过 MCP 工具暴露 `memory.store` / `memory.recall` / `memory.reflect` |
| 插件热加载 | PluginRegistry 子系统 | 运行时注册/注销 Provider，Loop 不感知插件生命周期 |
| 多 Agent 编排 | MCPBus + Agent Mesh | 子 Agent 通过 MCP 通信，主 Agent 通过 `spawn_agent` 工具创建 |
| 安全护栏 | Verification middleware | 请求前/后自动执行，对 Loop 透明 |
| 自进化 | SelfEvolution 子系统 | 异步后台分析轨迹，不阻塞主 Loop |
| 可观测性 | OpenTelemetry hooks | trace/metrics/logs 通过装饰器注入，Loop 无侵入 |

**Loop 简单，子系统复杂** — 这是四大标杆项目的共同智慧。

---

## 5. 迁移路径

### Phase 0: 概念验证 (PoC)

```
目标：TS Agent Loop + 1 个 Python MCP Provider，跑通端到端
时间：2 周

具体步骤：
1. 创建 TS 项目骨架 (pnpm + tsconfig)
2. 实现极简 Agent Loop (< 200 行)
   - while-loop + LLM 调用 + tool dispatch
   - 支持 streaming (ReadableStream)
   - 支持 checkpoint (SQLite)
3. 将 OmniMem 的 recall/store 封装为 Python MCP Server
4. TS Loop 通过 MCP stdio 调用 Python OmniMem
5. 验证：一个完整的 ask → recall memory → LLM → respond 流程
```

### Phase 1: 核心能力迁移

```
目标：TS 核心完整替代 Python Harness
时间：4 周

具体步骤：
1. ToolRouter → MCP Client Manager (管理多个 MCP Server 连接)
2. ContextManager → 自动 system prompt 组装 + token 预算管理
3. Verifier → Guardrails middleware (pre/post hooks)
4. LifecycleManager → 进程管理 + 心跳 + 优雅关闭
5. PluginRegistry → 动态 MCP Server 发现与注册
6. 所有 Python ML Provider 封装为独立 MCP Server
```

### Phase 2: 高级能力

```
目标：Streaming UI + Agent Mesh + 自进化
时间：6 周

具体步骤：
1. HTTP SSE streaming → React 前端实时展示
2. Agent Mesh gRPC 层 (Rust)
3. WASM 插件沙箱 (Rust)
4. 轨迹分析 + Scaffold 自修改 (SelfEvolution)
5. Dream Cycles (gbrain) 集成到 OmniMem ULTRA 层
```

---

## 6. 被否决的方案

### 6.1 LangGraph 作为核心运行时

**否决理由**：
- 四大标杆项目一致否定了 Agent 框架在核心循环中的价值
- 抽象税：额外的 StateGraph、Annotation、Pregel 概念
- 控制力不足：无法精细控制 prompt cache、streaming 策略
- 锁死风险：核心路径绑定外部依赖
- 调试困难：框架内部状态不透明

**保留价值**：LangGraph 的 Python SDK 仍可用于特定子系统（如复杂的多 Agent 编排 DAG），但不作为核心 Loop 的运行时。

### 6.2 纯 Python 架构

**否决理由**：
- Python 的 asyncio streaming 体验不如 TS 的 ReadableStream/AsyncIterator
- 无法与前端同构（需额外的 API 层）
- GIL 限制真正的并行工具执行
- 四大标杆中的三个选择了 TS 或 Rust，仅 Hermes 用 Python

### 6.3 纯 Rust 架构

**否决理由**：
- ML/AI 库生态不如 Python
- 开发迭代速度比 TS 慢
- MCP SDK 的 TS 生态最成熟

### 6.4 Go 替代 Rust

**否决理由**：
- GC 暂停不适合低延迟 Agent Mesh 网络层
- WASM 支持不如 Rust 原生
- 类型系统表达力弱于 Rust（无泛型 trait、无 sum type）
- AI 写代码时，Rust 的编译器约束反而是优势 — 编译通过 ≈ 正确

---

## 7. 影响

### 需要变更

| 影响项 | 变更内容 |
|--------|---------|
| `quilin/core/Harness.py` | 逐步被 TS Agent Loop 替代，最终归档 |
| `quilin/core/messages.py` | 迁移到 TS 类型定义 |
| `quilin/core/llm.py` | TS 版 LLM Router (基于 litellm 或 Vercel AI SDK Provider) |
| `quilin/layers/` | 每个 Layer Provider 封装为独立 Python MCP Server |
| `quilin/plugins/` | 迁移到 MCP Server 模式 |
| `CLAUDE.md` | 更新项目结构和命令说明 |
| `docs/architecture/overview.md` | 更新架构图反映新设计 |

### 不变

| 保留项 | 说明 |
|--------|------|
| E-T-C-S-L-V 六组件概念 | 概念保留，实现方式变化 |
| OmniMem 4 层记忆 | 保留，封装为 MCP Server |
| 11 大工程领域 | 保留，不变 |
| 上游监控 + 自动缝合 | 保留，不变 |
| `upstreams/` 子模块 | 保留，不变 |

---

## 8. 参考

### 调研项目

- [Claude Code](https://code.claude.com) — TS→Rust, 单线程 while-loop, ~88 行核心 ([架构分析](https://dev.to/brooks_wilson_36fbefbbae4/claude-code-architecture-explained-agent-loop-tool-system-and-permission-model-rust-rewrite-41b2))
- [Codex CLI](https://github.com/openai/codex) — Rust, Tokio 异步 submission/event queue ([OpenAI 官方解析](https://openai.com/index/unrolling-the-codex-agent-loop/))
- [OpenClaw](https://github.com/openclaw/openclaw) — TypeScript, Pi agent RPC runtime ([ContextEngine 架构](https://www.epsilla.com/blogs/2026-03-09-openclaw-2026-3-7-contextengine-agentic-architecture))
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Python, AIAgent 迭代循环 ([DeepWiki 分析](https://deepwiki.com/NousResearch/hermes-agent))

### 设计原则引用

> "The only state is a message array." — Claude Code 架构
>
> "Sophisticated behavior emerges from well-designed constraints, not complex coordination mechanisms." — Claude Code 架构分析
>
> "Rewriting forces simplification. What remains is what actually matters." — claw-code (Claude Code Rust 重写)
>
> "The learning cycle is a first-class architectural concern." — Hermes Agent 架构
