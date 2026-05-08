# 可观测性工程（Observability Engineering）

> **实现状态（2026-04-30 校准）**
> - ✅ **已实现**：JSON structured logger、`packages/agent-core/src/observability/` in-memory span provider、loop span instrumentation、JSON file span exporter、trace/log context、Python quilin-mem event_log traceparent ingest + retrieval event dual-emit、benchmark cost/result wire integration。
> - 🚧 **部分实现 / 延期**：OTel-compatible schema 与 exporter 基础已落地，但不是完整 OpenTelemetry SDK 接入；WebUI Dashboard 未实现。
> - Linear 后续项：[QUI-20](https://linear.app/quilin-agent/issue/QUI-20/08-observability-metrics-exporter-dashboard-and-trace-backend)。

> 本文档是 Quilin Agent 工程规格系列的第 8 篇，定义可观测性层的设计方案、参考来源与验证标准。可观测性是横切所有层的基础能力，为追踪、指标和日志提供统一基础设施。
>
> **ADR-001 对齐说明**：可观测性通过 OpenTelemetry hooks 无侵入注入 TS 核心层。旧路径 `quilin/layers/observability/` 已删除。本文档中的 Python 代码示例仅表达设计意图。`quilin/` 路径为规划参考。详见 [Core Loop](../00-core-loop/README.md)。

---

## 一、问题定义

### 1.1 Agent 可观测性 vs 传统应用可观测性

传统 Web 应用的可观测性相对简单：HTTP 请求进来，数据库查询，HTTP 响应出去。每次请求是确定的，调用链是线性的，出了问题看日志和链路追踪即可定位。

Agent 系统打破了这一假设，带来五类独特挑战：

**1. 多步推理链路追踪难**

Agent 执行一个任务可能经历数十步：LLM 推理 → 工具调用 → 结果回填 → 再推理 → 再调用……每一步都可能失败，失败原因可能是模型幻觉、工具超时、上下文截断或规划错误。传统的单次请求追踪根本无法覆盖这种跨轮、跨工具的复杂执行路径。

**2. LLM 调用不确定性**

相同的 prompt 不同时刻可能得到不同输出（temperature > 0）。这意味着：
- 同样的输入重跑不一定复现问题
- 需要记录完整的输入（含 system prompt、历史对话、工具定义）才能有效调试
- 模型版本切换可能导致行为漂移，需要对比不同模型版本的表现

**3. 工具链路分叉与并行**

Agent 可以并行调用多个工具，工具可以嵌套调用子 Agent。这形成了树状（而非线性）的执行拓扑，需要追踪系统支持有向无环图（DAG）级别的 Span 关联，而不只是简单的父子链路。

**4. 成本统计的复杂性**

Agent 任务的成本由多个维度叠加：
- LLM 调用成本（input_tokens × 单价 + output_tokens × 单价 + thinking_tokens × 单价）
- 工具调用成本（外部 API 费用、计算费用）
- 重规划成本（任务失败后重新规划产生的额外 token）
- 内存检索成本（向量搜索的计算开销）

如果没有精细的成本追踪，很难知道"这个任务到底花了多少钱，哪里最贵"。

**5. 评估维度的扩展**

传统应用的质量指标是：延迟、错误率、吞吐量。Agent 还需要额外评估：
- 任务完成率（最终有没有达到目标？）
- 步骤效率（用了多少步完成？有没有多余的迂回？）
- 工具使用正确率（工具调用参数对不对？）
- 规划质量（第一步规划是否有效？重规划次数？）
- 推理质量（thinking 内容是否有效推动了决策？）

### 1.2 核心需求

| 场景 | 问题 | 需要的能力 |
|------|------|-----------|
| **出了问题** | 哪一步失败了？原因是什么？ | 完整链路追踪 + 结构化日志 + 调试回放 |
| **太贵了** | 哪个任务最费 token？哪个工具最贵？ | Token 用量统计 + 成本分摊 + 预算告警 |
| **太慢了** | 哪个步骤是瓶颈？LLM 还是工具？ | 延迟分布 + P99 追踪 + 热路径分析 |
| **质量退化** | 新版本模型表现是否变差了？ | 对比评估 + 回归检测 + 评分趋势 |
| **容量规划** | 下个月的 token 消耗能撑多久？ | 用量预测 + 配额管理 |

### 1.3 三大支柱在 Agent 场景的适配

```
传统三支柱              Agent 场景扩展
─────────────────────────────────────────────────────────
Traces（链路追踪）  →  Session/Turn/Node/LLM/Tool 五层 Span 体系
                       支持树状 DAG 拓扑（非线性链路）
                       携带 thinking 内容、工具参数、成本信息

Metrics（指标）     →  Token 用量指标（input/output/thinking 分别计数）
                       Agent 效率指标（steps_per_task / replanning_count）
                       工具健康指标（success_rate / latency_p99）
                       成本指标（cost_per_turn / cumulative_cost）

Logs（日志）        →  结构化 JSON 日志（携带 trace_id/span_id 关联）
                       每步决策的上下文快照
                       工具调用的完整入参和出参
```

---

## 二、设计方案

### 2.1 OpenTelemetry 集成架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Quilin Agent Loop                  │
│                                                               │
│  Session Span (session_id, user_id, task_description)        │
│  │                                                            │
│  ├── Turn Span (turn_id, user_input, turn_index)             │
│  │     │                                                      │
│  │     ├── Node Span: verify_input                           │
│  │     │     └── LLM Span (model, tokens_in/out, cost)       │
│  │     │                                                      │
│  │     ├── Node Span: build_context                          │
│  │     │     └── Tool Span: memory_retrieve                  │
│  │     │           └── attrs: tool_name, duration, result_size│
│  │     │                                                      │
│  │     ├── Node Span: plan                                    │
│  │     │     └── LLM Span                                     │
│  │     │           └── attrs: model, tokens_in/out/thinking,  │
│  │     │                      cost, thinking_mode             │
│  │     │                                                      │
│  │     ├── Node Span: execute_tools                           │
│  │     │     ├── Tool Span: web_search                        │
│  │     │     │     └── attrs: tool_name, params, duration_ms, │
│  │     │     │                success, result_size            │
│  │     │     └── Tool Span: code_executor (parallel)          │
│  │     │                                                      │
│  │     ├── Node Span: verify_output                           │
│  │     │     └── LLM Span                                     │
│  │     │                                                      │
│  │     └── Node Span: reflect                                 │
│  │           └── LLM Span (thinking_mode=preserved)           │
│  │                                                            │
│  └── Turn Span (turn_index=N, ...)                           │
│                                                               │
└─────────────────────────────────────┬───────────────────────┘
                                       │
                          OTel Exporter Layer
                                       │
          ┌────────────────────────────┼───────────────────────┐
          │                            │                        │
    Langfuse                        Jaeger                  Prometheus
  (Trace/Gen/Score)            (OTel Native)              + Grafana
                                                        (Metrics Dashboard)
          │                            │                        │
          └────────────────────────────┴───────────────────────┘
                                       │
                            Local JSON Exporter
                           (零配置本地开发调试)

          ┌────────────────────────────────────────────────────────┐
          │              Quilin WebUI Dashboard                     │
          │                                                        │
          │  数据源：OTel Metrics/Traces + quilin-mem + TaskState  │
          │                                                        │
          │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
          │  │ 任务面板  │ │ 记忆面板  │ │ 工具面板  │ │ 指标面板  │ │
          │  │ 状态一览  │ │ 4 层浏览  │ │ 使用统计  │ │ Token/   │ │
          │  │ 进行/完成 │ │ 内容管理  │ │ 调用历史  │ │ 成本追踪 │ │
          │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
          │  ┌──────────┐ ┌──────────┐                           │
          │  │ 拓扑面板  │ │ 用户面板  │                           │
          │  │ Agent     │ │ 画像展示  │                           │
          │  │ Mesh 可视 │ │ 洞察历史  │                           │
          │  └──────────┘ └──────────┘                           │
          └────────────────────────────────────────────────────────┘
```

> **Dashboard vs Chat UI**：Dashboard 是独立的全局可视化应用，不是 Streaming Chat UI 的附属。Chat UI 是单线程对话交互；Dashboard 提供全局视角——任务全景、记忆内容、工具统计、Agent 拓扑、token 指标。两者并行存在，数据共享但功能互补。

### 2.1.1 WebUI Dashboard 面板定义 / WebUI Dashboard Panel Inventory

> **当前实现状态 / Current implementation status (QUI-105 round 2 complete, 2026-05-09)**
>
> 7 个面板全部接通真实数据源。tasks / memory / tools 通过 `dashboardRuntimeRefs` 晚绑定到 REPL 内的 `MCPRegistry` / `SupervisorRuntimeControlPlane` / `LocalMemoryBackend`（详见 `packages/agent-core/src/observability/dashboard-runtime-providers.ts` 与 `packages/agent-core/src/repl.ts` 的 `onRuntimeReady` 钩子）。
> All 7 panels are wired to live data sources. Tasks / memory / tools late-bind to the REPL-owned `MCPRegistry` / `SupervisorRuntimeControlPlane` / `LocalMemoryBackend` via `dashboardRuntimeRefs` (see `packages/agent-core/src/observability/dashboard-runtime-providers.ts` and the `onRuntimeReady` hook in `packages/agent-core/src/repl.ts`).

| 面板 / Panel | 数据源 / Data source | 核心指标 / Core metrics | 刷新策略 / Refresh | 状态 / Status |
|------|--------|---------|---------|---------|
| **任务面板 / Tasks** | SupervisorRuntime snapshot + Subagent registry | 任务状态分布（进行中/完成/失败）、任务耗时分布、步骤效率 / task status distribution, duration, step efficiency | 实时（WebSocket）/ realtime (WebSocket) | ✅ shipped — `createTasksProviderFromRefs` 通过 `onRuntimeReady` 接到 `SupervisorRuntime.snapshot()` 与 `getSubagentRegistrySnapshot()`；REPL 启动前面板返回 `message: "tasks provider awaiting REPL runtime"` 提示 / wired to live `SupervisorRuntime.snapshot()` and `getSubagentRegistrySnapshot()` via `onRuntimeReady`; pre-REPL window surfaces an awaiting-runtime message |
| **记忆面板 / Memory** | LocalMemoryBackend.countByTier | 各层记忆条数、存储大小、最近访问时间、检索命中率 / per-tier counts, storage size, recency, retrieval hit rate | 按需刷新 / on-demand | ✅ shipped — `createMemoryProviderFromRefs` 每次请求拿短生命周期 `LocalMemoryBackend` 句柄，调用新增的 `countByTier()` 返回 4 层条数，避免与 REPL 主线程争用单例 / each request opens a short-lived `LocalMemoryBackend` handle and calls the new `countByTier()`; avoids contending for the REPL singleton |
| **工具面板 / Tools** | MCPRegistry.getAllTools | 工具调用频率 Top 10、成功率、平均延迟、成本分摊 / top-10 tool invocations, success rate, latency, cost share | 5s 轮询 / 5s polling | ✅ shipped — `createToolsProviderFromRefs` 列出 REPL 内 `MCPRegistry` 的全部 builtin + 命名空间工具，按 namespace 聚合计数（runtime metrics 仍由 metrics 面板基于 TraceStore 提供）/ lists all builtin + namespaced tools from the REPL's live `MCPRegistry`, grouped by namespace (runtime metrics remain on the metrics panel via TraceStore) |
| **指标面板 / Metrics** | OTel Metrics + TraceStore | Token 消耗趋势（input/output/thinking）、成本累计、Prompt Cache 命中率 / token usage trend, cost accumulation, prompt cache hit rate | 5s 轮询 / 5s polling | ✅ shipped — TraceStore 自动聚合，无需 provider / auto-aggregated from TraceStore, no provider needed |
| **Sub-Agent 进度面板 / Sub-Agent topology** | ProgressAggregator (06-multi-agent) | 各 Sub-Agent 实时状态、进度百分比、当前步骤、预估剩余时间；整体任务进度总览 / per-agent status, progress %, current step, ETA | 实时（WebSocket）/ realtime (WebSocket) | ✅ shipped — 通过 topology provider 接 ProgressAggregator / wired via topology provider |
| **会话面板 / Sessions** | TraceStore session index | 会话列表、活跃数、终态计数、token 与成本汇总 / session list, active count, terminal count, token and cost rollup | 按需刷新 / on-demand | ✅ shipped — TraceStore 自动汇总 / auto-aggregated from TraceStore |
| **Skills + MCP Providers 面板 / Skills + MCP** | Skills catalog + MCP server registry | skill 列表、MCP server 状态、provider 健康度 / skill catalog, MCP server status, provider health | 按需刷新 / on-demand | ✅ shipped — provider 已接线（原"用户面板"暂搁置，被 skills+MCP 面板取代）/ wired via providers (legacy "user panel" parked; replaced by skills + MCP) |

### 2.2 Span 层级设计

五层 Span 体系覆盖从宏观到微观的全部执行粒度：

#### Session Span（会话层）
- **生命周期**：从用户发起 session 到 session 结束
- **核心属性**：
  - `session.id`：全局唯一会话标识
  - `session.user_id`：用户标识（用于成本分摊）
  - `session.task`：任务描述（自然语言）
  - `session.turn_count`：本次会话总轮数
  - `session.total_cost`：会话总成本
  - `session.total_tokens`：会话总 token 消耗

#### Turn Span（轮次层）
- **生命周期**：从用户输入到系统输出
- **核心属性**：
  - `turn.id`：轮次标识
  - `turn.index`：会话内第几轮（从 0 开始）
  - `turn.user_input`：用户输入文本
  - `turn.output`：Agent 最终输出
  - `turn.replanning_count`：本轮重规划次数
  - `turn.cost`：本轮成本小计

#### Node Span（状态机节点层）
- **生命周期**：LangGraph 状态机的单个节点执行
- **节点名称**：`verify_input` / `build_context` / `plan` / `execute_tools` / `verify_output` / `reflect` / `decide`
- **核心属性**：
  - `node.name`：节点名称
  - `node.input_state`：输入状态快照（JSON）
  - `node.output_state`：输出状态快照（JSON）
  - `node.duration_ms`：节点执行时长

#### LLM Span（LLM 调用层）
- **生命周期**：单次 LLM API 调用
- **核心属性**：
  - `llm.model`：模型标识（如 `claude-sonnet-4-6`）
  - `llm.provider`：供应商（如 `anthropic`）
  - `llm.tokens_input`：输入 token 数
  - `llm.tokens_output`：输出 token 数
  - `llm.tokens_thinking`：思考 token 数（如支持）
  - `llm.thinking_mode`：思考模式（`off` / `standard` / `preserved`）
  - `llm.cost_usd`：本次调用估算成本（USD）
  - `llm.time_to_first_token_ms`：首 token 延迟
  - `llm.total_latency_ms`：总延迟

#### Tool Span（工具调用层）
- **生命周期**：单次工具执行
- **核心属性**：
  - `tool.name`：工具名称（如 `web_search`）
  - `tool.params`：调用参数（JSON，敏感字段脱敏）
  - `tool.duration_ms`：执行时长
  - `tool.success`：是否成功
  - `tool.result_size_bytes`：返回结果大小
  - `tool.error_type`：失败时的错误类型

### 2.3 指标体系

所有指标使用 Prometheus 命名规范（`snake_case`，带单位后缀）：

#### Token 用量指标
```
omni_llm_tokens_input_total{model, provider, node}      Counter
omni_llm_tokens_output_total{model, provider, node}     Counter
omni_llm_tokens_thinking_total{model, provider, node}   Counter
omni_llm_cost_usd_total{model, provider, node}          Counter
```

#### 延迟指标
```
omni_llm_time_to_first_token_ms{model, provider}        Histogram
omni_llm_total_latency_ms{model, provider, node}        Histogram
omni_tool_latency_ms{tool_name}                         Histogram
omni_turn_total_latency_ms                              Histogram
```

#### 工具健康指标
```
omni_tool_calls_total{tool_name, success}               Counter
omni_tool_error_rate{tool_name}                         Gauge (派生)
omni_tool_concurrent_calls{tool_name}                   Gauge
```

#### Agent 效率指标
```
omni_turn_steps_count{session_id}                       Histogram
omni_turn_replanning_count{session_id}                  Counter
omni_turn_tokens_per_step                               Gauge (派生)
omni_session_success_rate                               Gauge (派生)
omni_session_task_completion_rate                       Gauge
```

#### Sub-Agent 进度指标
```
omni_subagent_active_count{supervisor_id}               Gauge
omni_subagent_progress_pct{agent_id, task_id}           Gauge
omni_subagent_duration_ms{agent_id, status}             Histogram
omni_subagent_heartbeat_lag_ms{agent_id}                Gauge
omni_im_progress_push_total{channel, trigger}           Counter
omni_im_progress_push_suppressed_total{channel}         Counter  # 被防刷屏限制的推送
```

#### 成本指标
```
omni_cost_per_turn_usd                                  Histogram
omni_cost_cumulative_usd{user_id}                       Gauge
omni_cost_by_model_usd{model}                           Counter
omni_cost_by_tool_usd{tool_name}                        Counter
```

### 2.4 结构化 JSON 日志格式

所有组件输出统一格式的结构化日志，通过 `trace_id` 和 `span_id` 与 OTel 追踪关联：

```json
{
  "timestamp": "2026-04-13T10:00:00.123Z",
  "level": "INFO",
  "component": "ToolRouter",
  "event": "tool_execution",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "session_id": "sess_abc123",
  "turn_id": "turn_001",
  "data": {
    "tool_name": "web_search",
    "params": {
      "query": "OpenTelemetry Python SDK usage",
      "max_results": 5
    },
    "duration_ms": 342,
    "success": true,
    "result_size_bytes": 4096,
    "result_summary": "Found 5 results"
  }
}
```

**日志级别规范：**
- `DEBUG`：每个 Span 的详细输入/输出（仅开发模式）
- `INFO`：正常执行事件（tool_execution、llm_call、node_complete）
- `WARN`：非致命异常（工具重试、token 用量接近阈值）
- `ERROR`：需要处理的错误（工具失败、LLM API 错误、验证失败）

### 2.5 调试回放设计

调试回放系统将 Agent 的执行过程持久化为可重放的轨迹，支持事后分析和单步调试：

```
完整轨迹持久化（每轮存储）
├── 元数据：session_id / turn_id / timestamp / model / cost
├── 输入快照：user_input + system_prompt + tool_definitions + memory_context
├── 执行序列：有序的 Span 列表（含每个 Span 的完整输入/输出/耗时）
└── 输出快照：final_output + total_cost + total_tokens + success_flag

时间线可视化（Gantt 风格）
┌──────────────────────────────────────────────────┐
│  Turn #1                              total: 3.2s │
│  ├─ verify_input   ████                 0.4s      │
│  ├─ build_context  ███                  0.3s      │
│  ├─ plan           ████████             0.8s      │
│  ├─ execute_tools  ████████████████     1.5s      │
│  │   ├─ web_search ████████             0.8s      │
│  │   └─ code_exec  █████████            0.9s      │
│  └─ verify_output  ██                   0.2s      │
└──────────────────────────────────────────────────┘

单步重放能力
- 给定任意 Span 的 input_snapshot → 重新执行该 Span → 对比输出
- 用于验证："如果换个模型/prompt，这一步结果会不会不同？"

失败轨迹自动分析（与自进化模块联动）
- 失败轨迹自动标记并推送到 Hindsight Reflect 模块
- 触发失败原因分析（LLM 判断：规划错误 / 工具误用 / 上下文不足）
- 生成改进建议并写入长期记忆（gbrain）
```

### 2.6 Exporter 适配层

```
quilin/layers/observability/exporters/
├── langfuse_exporter.py      # 推荐：Trace/Generation/Score API 完整映射
├── jaeger_exporter.py        # OTel 原生，适合已有 Jaeger 基础设施
├── prometheus_exporter.py    # 指标导出，配合 Grafana 仪表盘
├── json_file_exporter.py     # 零配置本地开发，输出到 .jsonl 文件
└── composite_exporter.py     # 组合多个 Exporter 同时输出
```

各 Exporter 的特性对比：

| Exporter | 适用场景 | 追踪 | 指标 | 评估 | 成本 |
|----------|---------|------|------|------|------|
| Langfuse | 生产推荐，开源可自托管 | Trace/Generation | Score Analytics | LLM-as-Judge | 免费/付费 |
| Jaeger | 已有 OTel 基础设施 | 完整 Span 树 | 无（需 Prometheus） | 无 | 开源免费 |
| Prometheus | 指标告警和仪表盘 | 无 | 完整指标体系 | 无 | 开源免费 |
| JSON File | 本地开发调试 | JSONL 文件 | CSV 文件 | 无 | 免费 |

### 2.7 核心接口定义

```python
from typing import Protocol, Optional, Any
from dataclasses import dataclass
from contextlib import contextmanager


@dataclass
class TokenUsage:
    input: int
    output: int
    thinking: int = 0

    @property
    def total(self) -> int:
        return self.input + self.output + self.thinking


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    name: str
    start_time: float
    attributes: dict[str, Any]

    def set_attribute(self, key: str, value: Any) -> None: ...
    def record_exception(self, exc: Exception) -> None: ...
    def end(self) -> None: ...


class Tracer(Protocol):
    """分布式追踪接口，遵循 OpenTelemetry 语义约定"""

    @contextmanager
    def start_session_span(self, session_id: str, task: str) -> Span: ...

    @contextmanager
    def start_turn_span(self, turn_id: str, user_input: str) -> Span: ...

    @contextmanager
    def start_node_span(self, node_name: str) -> Span: ...

    def record_llm_call(
        self,
        span: Span,
        model: str,
        provider: str,
        tokens: TokenUsage,
        cost_usd: float,
        thinking_mode: str = "off",
        time_to_first_token_ms: Optional[int] = None,
    ) -> None: ...

    def record_tool_call(
        self,
        span: Span,
        tool_name: str,
        params: dict,
        duration_ms: int,
        success: bool,
        result_size_bytes: int = 0,
        error_type: Optional[str] = None,
    ) -> None: ...

    def add_score(
        self,
        span: Span,
        name: str,
        value: float,
        comment: Optional[str] = None,
    ) -> None: ...


class Metrics(Protocol):
    """指标收集接口，兼容 Prometheus 数据模型"""

    def increment(
        self, name: str, value: float = 1.0, labels: dict[str, str] = {}
    ) -> None: ...

    def gauge(
        self, name: str, value: float, labels: dict[str, str] = {}
    ) -> None: ...

    def histogram(
        self, name: str, value: float, labels: dict[str, str] = {}
    ) -> None: ...


class ObservabilityProvider(Protocol):
    """可观测性层统一入口，整合 Tracer + Metrics + Logger"""

    @property
    def tracer(self) -> Tracer: ...

    @property
    def metrics(self) -> Metrics: ...

    def structured_log(
        self,
        level: str,
        component: str,
        event: str,
        data: dict,
        span: Optional[Span] = None,
    ) -> None: ...

    def flush(self) -> None:
        """强制刷新所有缓冲的遥测数据（进程退出前调用）"""
        ...
```

### 2.8 配置项

`quilin/config.yaml` 中的可观测性配置：

```yaml
observability:
  # 全局开关
  enabled: true
  
  # Exporter 配置（可多选，数据同时发送到所有配置的 Exporter）
  exporters:
    langfuse:
      enabled: true
      public_key: "${LANGFUSE_PUBLIC_KEY}"
      secret_key: "${LANGFUSE_SECRET_KEY}"
      host: "https://cloud.langfuse.com"  # 或自托管地址
    
    jaeger:
      enabled: false
      endpoint: "http://localhost:14268/api/traces"
    
    prometheus:
      enabled: true
      port: 9090
      path: "/metrics"
    
    json_file:
      enabled: true  # 本地开发默认开启
      output_dir: "./traces"
      rotate_mb: 100
  
  # 采样策略（高流量时降低采样率节省成本）
  sampling:
    default_rate: 1.0       # 100% 采样（开发环境）
    production_rate: 0.1    # 10% 采样（生产环境高流量）
    error_always_sample: true  # 错误请求始终采样
  
  # 调试回放
  replay:
    enabled: true
    storage_backend: "local"  # local | s3 | gcs
    retention_days: 30
    max_trace_size_mb: 10
  
  # 成本预算告警
  budget:
    per_turn_warn_usd: 0.10   # 单轮超过 $0.10 告警
    per_session_max_usd: 5.0  # 单会话上限 $5.0
    daily_max_usd: 100.0      # 每日上限 $100
```

---

## 三、Top 10 参考项目

### 3.1 深入参考（前 5）

#### 1. Langfuse
- **定位**：开源 LLM 工程平台，可观测性 + 评估 + prompt 管理一体化
- **GitHub**：[langfuse/langfuse](https://github.com/langfuse/langfuse)（18k+ Stars）
- **核心数据模型**：
  - `Trace`：对应一次完整任务执行
  - `Generation`：LLM 调用（携带 model、tokens、cost、input/output）
  - `Span`：非 LLM 步骤（工具调用、检索、自定义逻辑）
  - `Score`：质量评分（LLM-as-Judge 或人工标注）
- **关键特性**：
  - 原生 OTel 后端兼容，可直接接收 OTLP 格式数据
  - Score Analytics API 支持跨实验对比评分
  - 自托管（Docker/K8s）或云托管均可
  - 支持 LangChain、LiteLLM、OpenAI SDK 自动埋点
- **与 Quilin 相关性**：Generation 模型完美对应我们的 LLM Span，是首选 Exporter

#### 2. OpenLLMetry（Traceloop）
- **定位**：基于 OpenTelemetry 的 LLM 自动埋点 SDK
- **GitHub**：[traceloop/openllmetry](https://github.com/traceloop/openllmetry)
- **核心机制**：Instrumentor 模式——`import` 时自动注入 Span 到 LiteLLM、LangChain、OpenAI 等库
- **关键特性**：
  - Apache 2.0 开源，零 vendor lock-in
  - 一行代码接入（`Traceloop.init()`）自动追踪所有 LLM 调用
  - 支持 20+ LLM 供应商和框架的自动 instrumentation
  - 可将数据发送到 Langfuse、Jaeger、New Relic 等任意 OTel 后端
- **与 Quilin 相关性**：其 Instrumentor 自动埋点机制直接启发我们的 `ObservabilityMiddleware` 设计

#### 3. Arize Phoenix
- **定位**：开源 AI 可观测性与评估平台，自托管无功能限制
- **GitHub**：[Arize-ai/phoenix](https://github.com/Arize-ai/phoenix)（7k+ Stars）
- **核心特性**：
  - 基于 OTel 构建，框架和语言无关
  - 内置 Playground（对比不同 model/prompt 的输出）
  - 内置评估框架（LLM-as-Judge + 代码评估 + 人工标注）
  - 月均 250 万次下载，活跃社区
  - 原生支持 LangGraph、Claude Agent SDK、OpenAI Agents SDK
- **与 Quilin 相关性**：其评估框架中的 Evaluator 概念用于 verify_output 节点的量化评分

#### 4. LangSmith
- **定位**：LangChain 官方调试 + 评估 + 监控平台
- **核心特性**：
  - RunTree 数据结构：树状 Span 组织，完整捕获 LangGraph 状态机执行路径
  - 时间线可视化：Gantt 风格展示每个 Span 的时间区间
  - 调试回放：支持按 trace_id 获取完整执行轨迹，支持单步重跑
  - `langsmith-fetch` CLI：将 LangSmith 追踪数据直接提供给 Claude Code 等编码 Agent 分析
  - 数据集管理：将生产失败案例直接存为评估数据集
- **与 Quilin 相关性**：RunTree 数据结构和时间线可视化 UX 直接启发我们的调试回放设计

#### 5. AgentOps
- **定位**：Agent 专用可观测性平台，专注 Agent 生命周期管理
- **GitHub**：[AgentOps-AI/agentops](https://github.com/AgentOps-AI/agentops)
- **核心特性**：
  - Agent 专用 Span 类型：`session_span` / `agent_span` / `operation_span` / `workflow_span`
  - Session 维度的聚合指标：整体延迟、总成本、成功率
  - 实时监控：LLM 调用、工具使用、数据库查询、Agent 间通信的任务图可视化
  - 时间回溯调试（time-travel debugging）：任意历史时间点重放
  - 集成 CrewAI、AutoGen、OpenAI Agents SDK
- **与 Quilin 相关性**：其 Agent 专用指标体系（step_count / tool_usage / cost_per_step）直接映射到我们的效率指标

### 3.2 观察参考（后 5）

#### 6. Helicone
- **定位**：代理层 LLM 可观测性，请求级缓存 + 成本追踪
- **GitHub**：[Helicone/helicone](https://github.com/Helicone/helicone)（YC W23）
- **核心机制**：作为 API 代理层，一行代码修改 endpoint 即可接入，无需修改业务代码
- **关键特性**：语义缓存（相似请求直接返回缓存结果）、按用户/模型/时间维度成本分摊
- **局限**：代理模式增加额外网络延迟；对 streaming 的支持相对薄弱

#### 7. Braintrust
- **定位**：AI 可观测性 + 评估一体化平台，强调 CI 集成和回归检测
- **核心特性**：
  - 实验对比：同一数据集跑不同 prompt/model，自动检测回归
  - Loop AI 助手：自动生成 prompt 优化建议和评分器
  - Braintrust Gateway：统一 LLM 网关 + 追踪 + 评估
  - 免费计划：每月 100 万日志事件
- **局限**：非完全开源，部分核心功能为付费功能

#### 8. Weave（Weights & Biases）
- **定位**：W&B 旗下 LLM 开发工具包，实验追踪 + 评估 + 监控
- **GitHub**：[wandb/weave](https://github.com/wandb/weave)
- **核心特性**：`@weave.op` 装饰器自动追踪函数输入/输出/成本/延迟；实验比较（并排对比不同配置）；与 AWS Bedrock 和 NVIDIA 深度集成
- **局限**：与 W&B 生态强耦合；对纯 Agent 场景的支持相对 AgentOps 弱

#### 9. Lunary
- **定位**：开源 GenAI 监控 + 分析 + prompt 管理平台
- **GitHub**：lunary-ai/lunary（repo 已下线，2026-04-22 验证 404）
- **核心特性**：Apache 2.0 开源、自托管友好；聊天回放（对话历史时间线）；用户分析（用户粒度的使用统计）；内置 PII 脱敏和内容过滤
- **局限**：功能集相对有限，更适合聊天机器人场景而非复杂 Agent

#### 10. Traceloop OpenLLMetry SDK（Python/TS 分离版）
- **定位**：与第 2 项同源，但提供了更细粒度的 SDK 分包
- **核心特性**：
  - `opentelemetry-instrumentation-openai`、`opentelemetry-instrumentation-anthropic` 等独立包
  - 允许只引入需要的 instrumentation，减少依赖体积
  - 标准 OTel Span 属性命名，兼容任意 OTel 后端
- **与 Quilin 相关性**：我们按需引入特定 instrumentation 包而非整体 SDK

---

## 四、吸收内化方案

### 4.1 从 Langfuse 吸收：Trace/Generation 模型映射

Langfuse 将 LLM 调用抽象为 `Generation` 对象，携带比普通 Span 更丰富的语义信息：

| Langfuse Generation 字段 | Quilin LLM Span 属性 | 说明 |
|--------------------------|--------------------------|------|
| `model` | `llm.model` | 模型标识 |
| `usage.input` | `llm.tokens_input` | 输入 token |
| `usage.output` | `llm.tokens_output` | 输出 token |
| `usage.total` | 派生计算 | 总 token |
| `cost` | `llm.cost_usd` | 成本（USD）|
| `input` | `llm.prompt_snapshot` | 完整输入（含 system prompt）|
| `output` | `llm.completion_snapshot` | 完整输出 |
| `metadata.thinking_mode` | `llm.thinking_mode` | 思考模式扩展属性 |
| `metadata.thinking_tokens` | `llm.tokens_thinking` | 思考 token 扩展属性 |

**内化策略**：`langfuse_exporter.py` 将我们的 LLM Span 自动转换为 Langfuse Generation 对象，将 Tool Span 转换为 Langfuse Span，将 `add_score()` 调用映射到 Langfuse Score API。

### 4.2 从 OpenLLMetry 吸收：自动埋点 Instrumentor 模式

OpenLLMetry 的 Instrumentor 机制让可观测性对业务代码透明：

```python
# OpenLLMetry 的做法（启发源）
from traceloop.sdk import Traceloop
Traceloop.init()  # 一行初始化，自动 patch 所有 LLM 库

# Quilin 的内化（ObservabilityMiddleware）
class ObservabilityMiddleware:
    """在 LLMClient 和 ToolRouter 层自动注入 Span，业务代码无感知"""

    def __init__(self, provider: ObservabilityProvider):
        self._provider = provider
        self._patch_llm_client()
        self._patch_tool_router()

    def _patch_llm_client(self) -> None:
        """monkey-patch LiteLLM completion() 自动开启 LLM Span"""
        original = litellm.completion
        def patched(*args, **kwargs):
            with self._provider.tracer.start_node_span("llm_call") as span:
                result = original(*args, **kwargs)
                self._provider.tracer.record_llm_call(span, ...)
                return result
        litellm.completion = patched
```

### 4.3 从 Arize Phoenix 吸收：评估框架集成

Phoenix 的 Evaluator 概念为每个 Span 提供量化评分，映射到 `verify_output` 节点：

```python
class StepEvaluator(Protocol):
    """Phoenix Evaluator 概念的内化：为每个节点输出打分"""

    def evaluate(
        self,
        span: Span,
        input: dict,
        output: dict,
    ) -> float:
        """返回 0.0（完全失败）到 1.0（完全成功）的评分"""
        ...

# 具体实现示例
class VerifyOutputEvaluator(StepEvaluator):
    """调用 LLM 判断 verify_output 节点的输出质量"""

    async def evaluate(self, span, input, output) -> float:
        score = await llm_judge(
            criteria="Did the agent output correctly address the user's request?",
            input=input["user_request"],
            output=output["agent_response"],
        )
        self._tracer.add_score(span, "output_quality", score)
        return score
```

### 4.4 从 LangSmith 吸收：调试回放 UX 设计

LangSmith 的 RunTree 数据结构和 `langsmith-fetch` CLI 提供了两个具体启发：

**RunTree → TraceTree**：我们定义 `TraceTree` 数据类，以树状结构存储完整执行轨迹，每个节点是一个 Span，子节点是该 Span 内产生的子 Span。

**时间线可视化**：在本地 JSON 导出模式下，提供 `quilin trace view <trace_id>` CLI 命令，在终端用 ASCII Gantt 图展示执行时间线（参见 2.5 节的时间线图示）。

**单步重放**：给定 `trace_id` + `span_id`，重新执行该 Span 的逻辑，用于验证修复效果：

```bash
python -m quilin.tools.replay \
  --trace-id 4bf92f3577b34da6 \
  --span-id 00f067aa0ba902b7 \
  --model claude-haiku-4-5  # 可换不同模型对比
```

### 4.5 从 AgentOps 吸收：Agent 专用指标维度

AgentOps 将 Agent 指标从"请求级"提升到"任务级"，我们直接采纳其指标分类体系：

| AgentOps 指标 | Quilin 指标 | 含义 |
|--------------|----------------|------|
| `session.cost` | `omni_cost_per_turn_usd` | 单轮总成本 |
| `session.latency` | `omni_turn_total_latency_ms` | 单轮总延迟 |
| `step_count` | `omni_turn_steps_count` | 每轮执行步数 |
| `tool_usage` | `omni_tool_calls_total` | 工具调用次数 |
| `self_correction_count` | `omni_turn_replanning_count` | 重规划次数（自纠错的代理指标）|
| `success_rate` | `omni_session_task_completion_rate` | 任务完成率 |

---

## 五、与 Harness 组件映射

可观测性层以横切关注点（Cross-Cutting Concern）的形式嵌入所有层，通过依赖注入而非侵入式修改实现。

```
Quilin 组件                   可观测性挂载点
─────────────────────────────────────────────────────────────
Quilin.run()               →  Session Span 开启/关闭
LangGraph 状态机                →  Node Span（每个节点自动埋点）
LLMClient.chat()                →  LLM Span + Token/Cost 记录
ToolRouter.execute()            →  Tool Span + 工具健康指标
quilin-mem retrieve/store       →  Tool Span（内存操作）
MCPBus.send/receive()           →  Tool Span（MCP 通信）
PluginRegistry.get_provider()   →  Gauge（已注册 Provider 数量）
```

### 5.1 Quilin 核心循环集成示例

```python
class Quilin:
    def __init__(self, obs: ObservabilityProvider, ...):
        self._obs = obs

    async def run(self, session_id: str, task: str) -> str:
        async with self._obs.tracer.start_session_span(session_id, task) as sess:
            for turn_index, user_input in enumerate(self._turns()):
                async with self._obs.tracer.start_turn_span(
                    turn_id=f"{session_id}:turn:{turn_index}",
                    user_input=user_input,
                ) as turn:
                    result = await self._run_graph(turn)
                    self._obs.metrics.histogram(
                        "omni_turn_total_latency_ms",
                        turn.duration_ms,
                    )
            return result

    async def _run_node(self, node_name: str, current_state: AgentState) -> AgentState:
        async with self._obs.tracer.start_node_span(node_name) as node:
            handler = self._nodes[node_name]
            new_state = await handler(current_state)
            self._obs.structured_log(
                level="INFO",
                component="StateGraph",
                event="node_complete",
                data={"node": node_name, "output_keys": list(new_state.keys())},
                span=node,
            )
            return new_state
```

### 5.2 与各层的集成点

| 层 | 集成点 | 可观测性动作 |
|----|-------|------------|
| **LLM Brain** | `LLMClient.chat()` 返回后 | 记录 LLM Span：model/tokens/cost/latency |
| **Memory** | quilin-mem retrieve/store 前后 | 记录 Tool Span：检索延迟/命中数 |
| **Memory Tier Transition**（D-18 2026-04-20 NEW-12） | FIFO Working→Episodic / Discard-all / Reflector 抽取触发时 | 记录 `memory_tier_transition` Span，attrs `{from_tier, to_tier, items_affected, tokens_before, tokens_after, trigger: fifo\|discard_all\|reflect}`；Counter `memory.tier_transitions_total{from,to,trigger}`；Histogram `memory.compression_ratio`。用于 debug "agent 突然忘了上下文" 回归。 |
| **Planning** | `plan` 节点执行后 | 记录规划质量评分（StepEvaluator）|
| **Tools** | `ToolRouter.execute()` 前后 | 记录 Tool Span：工具名/参数/耗时/成功率 |
| **Orchestration** | MCPBus 消息发送/接收 | 记录跨 Agent 通信延迟 |
| **Sub-Agent 进度** | ProgressAggregator 接收报告时 | 记录进度 Gauge + WebSocket 推送 Dashboard + IM 推送（含防刷屏限制） |
| **Guardrails** | 拦截动作触发时 | 记录 WARN 日志 + guardrail_trigger 指标 |
| **Deployment** | 容器健康检查 | 暴露 `/metrics` 端点供 Prometheus 拉取 |

### 5.3 IM 进度汇报机制

当用户通过 IM 工具（Telegram/Slack/微信等）与 Quilin 交互时，无法查看 WebUI Dashboard。可观测性层需要提供 **IM 通道的主动进度推送**能力：

```python
class IMProgressPusher:
    """
    IM 场景下的 Sub-Agent 进度推送器。
    数据源：ProgressAggregator（06-multi-agent）
    推送通道：IM adapter（09-deployment-runtime）
    """
    
    def __init__(
        self,
        im_adapter,
        min_push_interval_s: float = 15.0,   # 防刷屏：最短推送间隔
        push_on_checkpoint: bool = True,       # 检查点时推送
        push_on_heartbeat: bool = False,       # 心跳时推送（默认关闭）
    ):
        self._adapter = im_adapter
        self._min_interval = min_push_interval_s
        self._last_push_time: float = 0
    
    async def on_progress(self, report: "ProgressReport") -> None:
        """接收进度报告，决定是否推送到 IM"""
        now = time.time()
        
        # 强制推送条件：任务开始、完成、失败、需要用户决策
        force_push = report.status in (
            AgentStatus.SUCCESS, AgentStatus.FAILED
        ) or report.error_hint is not None
        
        # 普通推送条件：满足最短间隔 + 配置允许
        should_push = force_push or (
            now - self._last_push_time >= self._min_interval
            and (
                (self._push_on_checkpoint and report.trigger == "checkpoint")
                or (self._push_on_heartbeat and report.trigger == "heartbeat")
            )
        )
        
        if should_push:
            await self._adapter.send(self._format_message(report))
            self._last_push_time = now
            self._metrics.counter("omni_im_progress_push_total", 
                                  labels={"trigger": report.trigger})
        else:
            self._metrics.counter("omni_im_progress_push_suppressed_total")
```

**IM 推送消息格式示例**：

```
📌 任务进度 [2/5]
━━━━━━━━━━━━━━━
🔧 Sub-Agent: code-reviewer
📋 当前步骤：分析依赖关系
⏱️ 已运行 45s，预计还需 30s
━━━━━━━━━━━━━━━
整体进度：████████░░ 40%
```

---

## 六、验证标准

### 6.1 功能验证

**链路追踪完整性**
- [ ] 任意一次 Agent 执行，能通过 `session_id` 查到完整的 Span 树（Session → Turn → Node → LLM/Tool）
- [ ] LLM Span 必须携带 `model`、`tokens_input`、`tokens_output`、`cost_usd` 四个核心属性
- [ ] Tool Span 必须携带 `tool_name`、`duration_ms`、`success` 三个核心属性
- [ ] 并行工具调用正确表示为同一 Node Span 下的兄弟 Span（非嵌套）

**指标准确性**
- [ ] `omni_llm_tokens_input_total` 与 LLM API 返回的 `usage.input_tokens` 误差 < 1%
- [ ] `omni_tool_error_rate` 在工具稳定运行 10 分钟后保持 < 5%
- [ ] `omni_cost_per_turn_usd` 与 Langfuse Generation 记录的成本一致

**日志关联性**
- [ ] 所有 ERROR 级别日志包含有效的 `trace_id` 和 `span_id`
- [ ] `trace_id` 可用于在追踪后端（Langfuse/Jaeger）精确定位对应 Span

**调试回放**
- [ ] 对失败的 Turn，能在 3 分钟内通过 `trace_id` 定位到失败的具体 Span
- [ ] 单步重放能复现相同输入下的确定性输出（temperature=0 时）

### 6.2 性能验证

| 指标 | 要求 |
|------|------|
| 可观测性 overhead | < 5% 的 Turn 总延迟增加 |
| Span 写入延迟 | P99 < 10ms（异步写入，不阻塞主流程）|
| 日志写入延迟 | P99 < 1ms（异步缓冲写入）|
| Exporter 背压 | 队列满时降级丢弃（不阻塞 Agent 执行）|
| 内存占用 | Span 缓冲区 < 50MB |

### 6.3 可靠性验证

- [ ] Langfuse 宕机时，Agent 执行不受影响（Exporter 降级到 JSON 文件）
- [ ] JSON 文件 Exporter 在磁盘满时停止写入并记录 ERROR 日志，不抛出异常
- [ ] Prometheus scrape 失败不影响指标计数器的本地累积

### 6.4 成本预算验证

- [ ] 单轮成本超过 `budget.per_turn_warn_usd` 时，在 `turn.end` 时触发 WARN 日志
- [ ] 单会话成本超过 `budget.per_session_max_usd` 时，下一轮开始前抛出 `BudgetExceededError`
- [ ] 每日成本告警通过 Prometheus Alertmanager 规则配置，不硬编码到业务代码

### 6.5 集成测试场景

```python
# 测试：完整执行链路产生正确 Span 树
async def test_session_produces_complete_span_tree():
    harness = Quilin(obs=InMemoryObservabilityProvider())
    await harness.run(session_id="test-001", task="搜索并总结 AI 新闻")

    spans = harness.obs.get_all_spans()
    assert any(s.name == "session" for s in spans)
    assert any(s.name == "turn" for s in spans)
    assert any(s.name == "plan" for s in spans)
    assert any(s.name == "llm_call" for s in spans)

    # LLM Span 必须有 cost 属性
    llm_spans = [s for s in spans if s.name == "llm_call"]
    for span in llm_spans:
        assert "llm.cost_usd" in span.attributes
        assert span.attributes["llm.cost_usd"] >= 0


# 测试：Exporter 故障不影响 Agent 执行
async def test_exporter_failure_does_not_block_agent():
    obs = ObservabilityProvider(
        exporters=[FailingExporter(), JsonFileExporter(path="/tmp/test")]
    )
    harness = Quilin(obs=obs)
    # 即使 FailingExporter 每次抛异常，Agent 也应正常返回结果
    result = await harness.run(session_id="test-002", task="1+1=?")
    assert result is not None
```

---

> **文档版本**：v1.0 | **最后更新**：2026-04-13
> 
> 关联文档：[01-llm-integration](../01-llm-integration/README.md) | [03-memory](../03-memory/README.md) | [05-tool](../05-tool/README.md) | [06-multi-agent](../06-multi-agent/README.md)
