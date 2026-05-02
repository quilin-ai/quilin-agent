# 生产路由与监督者移交延期计划 / Production Routing and Supervisor Handoff Deferred Plan

English: This document is the deferred runtime backlog for Linear `QUI-17`（the existing Planning production routing and supervisor handoff issue）. It owns the future production boundary for planner routing, supervisor handoff, cross-process handoff routing, RouteLLM（a learned large-language-model routing framework that chooses between stronger and cheaper models under a quality/cost threshold）cost routing, and a local tiny classifier（a small local model used only as an optional low-cost routing signal）.

中文：本文档是 Linear `QUI-17`（现有 Planning 生产路由与监督者移交任务）的延期运行时 backlog。它负责未来生产边界：planner routing（规划器路由，即把一次用户请求分派到合适规划路径）、supervisor handoff（监督者移交，即主 Agent 把子任务交给可管理的子 Agent）、cross-process handoff routing（跨进程移交路由，即把移交请求发到另一个本机或远端进程）、RouteLLM（一个学习型大语言模型路由框架，在质量/成本阈值下选择强模型或便宜模型）成本路由，以及 local tiny classifier（本地小分类器，只作为可选低成本路由信号）。

English: This file is intentionally separate from `docs/04-planning/planning-durable-runtime-frontier.md`. That earlier file decides the durable execution direction; this file defines the future production backlog boundary, trigger conditions, input/output contracts, and acceptance gates that must be satisfied before `QUI-17` can move from planning to implementation closure.

中文：本文刻意与 `docs/04-planning/planning-durable-runtime-frontier.md` 分开。前者负责决定可恢复执行方向；本文负责定义未来生产 backlog 的边界、触发条件、输入输出契约和验收门槛，只有这些被实现后 `QUI-17` 才能从规划进入实现关闭。

## 一、结论 / Decision

English: `QUI-17` should remain open after this document because the production runtime code is not implemented. The correct state is "documented deferred runtime path": contracts are clear enough to guide implementation, but no production planner router, supervisor handoff router, cross-process dispatcher, RouteLLM-style cost router, or local classifier gate has landed in code.

中文：本文完成后 `QUI-17` 不应标记为 Done，因为生产运行时代码尚未实现。正确状态是“延期运行时路径已文档化”：契约已经足够指导实现，但生产规划器路由、监督者移交路由、跨进程派发器、RouteLLM 风格成本路由，以及本地分类器门禁都还没有代码落地。

English: The first implementation must keep Planning as the decision layer, not the execution owner. Planning emits typed route decisions and typed handoff envelopes; Durable Runtime（可恢复运行时，负责队列、租约、恢复和子任务交付的执行层）executes them; Provider Control Plane（供应商控制平面，负责供应商、模型、预算和失败回退选择）executes model routing; Observability（可观测性组件）records route facts and handoff state transitions.

中文：第一版实现必须让 Planning 继续作为决策层，而不是执行所有者。Planning 产出类型化路由决策和类型化移交封包；Durable Runtime（可恢复运行时，负责队列、租约、恢复和子任务交付的执行层）执行它们；Provider Control Plane（供应商控制平面，负责供应商、模型、预算和失败回退选择）执行模型路由；Observability（可观测性组件）记录路由事实和移交状态转换。

English: Benchmark（基准测试，用标准任务衡量系统能力）work is frozen unless the user explicitly asks. These production routing contracts are prerequisites for local long-task and cost-sensitive evaluation, not benchmark work themselves.

中文：除非用户明确要求，Benchmark（基准测试，用标准任务衡量系统能力）工作保持冻结。这些生产路由契约是本地长任务与成本敏感评测前置条件，本身不是 benchmark 工作。

## 二、资料依据 / Source Basis

English: OpenAI Agents SDK（Software Development Kit，软件开发工具包）documents handoffs as tool-shaped transfers, with `inputType` for model-generated routing metadata and `inputFilter` for controlling the history received by the next agent. Source: [OpenAI Agents JS handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/).

中文：OpenAI Agents SDK（Software Development Kit，软件开发工具包）把 handoff 记录为工具形态的转交，使用 `inputType` 表达模型生成的路由元数据，并使用 `inputFilter` 控制下一个 Agent 接收的历史。来源：[OpenAI Agents JS handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)。

English: LangChain and LangGraph document two relevant production patterns: supervisor-style coordination, where a central controller decides which specialist agent acts next, and handoff-style transfer, where the active agent changes. Sources: [LangChain multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent), [LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs), and [LangGraph JS supervisor](https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-supervisor.html).

中文：LangChain 和 LangGraph 文档化了两个相关生产模式：supervisor-style coordination（监督者协调，由中心控制器决定下一个专家 Agent）和 handoff-style transfer（移交式转交，当前活跃 Agent 会切换）。来源：[LangChain multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)、[LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs) 和 [LangGraph JS supervisor](https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-supervisor.html)。

English: Agent Protocol（一个面向生产 Agent 服务的开放接口草案）separates agents, threads, runs, cancellation, and run history. Quilin should copy that separation for cross-process handoff routing without adopting the protocol as a dependency. Source: [Agent Protocol](https://langchain-ai.github.io/agent-protocol/).

中文：Agent Protocol（一个面向生产 Agent 服务的开放接口草案）拆分了 agents、threads、runs、cancel 和 run history。Quilin 应借鉴这种拆分来设计跨进程移交路由，但不把该协议作为依赖。来源：[Agent Protocol](https://langchain-ai.github.io/agent-protocol/)。

English: RouteLLM documents learned routing between a stronger expensive model and a weaker cheaper model, controlled by a cost threshold that trades cost against quality. Quilin should treat this as a future cost-routing strategy under Provider Control Plane evidence, not as an intent classifier. Sources: [RouteLLM GitHub](https://github.com/lm-sys/RouteLLM), [LMSYS RouteLLM blog](https://www.lmsys.org/blog/2024-07-01-routellm/), and [RouteLLM paper](https://arxiv.org/abs/2406.18665).

中文：RouteLLM 记录了一种学习型路由：在强但昂贵的模型和弱但便宜的模型之间选择，并通过 cost threshold（成本阈值）控制成本与质量取舍。Quilin 应把它作为 Provider Control Plane 证据约束下的未来成本路由策略，而不是意图分类器。来源：[RouteLLM GitHub](https://github.com/lm-sys/RouteLLM)、[LMSYS RouteLLM blog](https://www.lmsys.org/blog/2024-07-01-routellm/) 和 [RouteLLM paper](https://arxiv.org/abs/2406.18665)。

English: vLLM Semantic Router（vLLM 生态中的语义路由项目）shows a broader signal-driven routing pattern: keyword, embedding, domain, fact-check, feedback, and preference signals can feed a decision engine. Quilin should use this as design evidence for signal composition, not as a required dependency. Source: [vLLM Semantic Router overview](https://vllm-semantic-router.com/docs/v0.1/overview/semantic-router-overview).

中文：vLLM Semantic Router（vLLM 生态中的语义路由项目）展示了更广义的信号驱动路由模式：keyword、embedding、domain、fact-check、feedback 和 preference 等信号可以进入决策引擎。Quilin 应把它作为信号组合设计依据，而不是必选依赖。来源：[vLLM Semantic Router overview](https://vllm-semantic-router.com/docs/v0.1/overview/semantic-router-overview)。

English: Hugging Face Optimum ONNX（Open Neural Network Exchange，一种可跨运行时执行模型的格式）documents local accelerated text-classification pipelines. Quilin should use this only for optional offline or low-cost classification experiments after the main LLM path is stable. Source: [Hugging Face Optimum ONNX Runtime pipelines](https://huggingface.co/docs/optimum-onnx/onnxruntime/usage_guides/pipelines).

中文：Hugging Face Optimum ONNX（Open Neural Network Exchange，一种可跨运行时执行模型的格式）文档化了本地加速 text-classification（文本分类）pipeline。Quilin 只应在主大语言模型路径稳定后，把它用于可选离线或低成本分类实验。来源：[Hugging Face Optimum ONNX Runtime pipelines](https://huggingface.co/docs/optimum-onnx/onnxruntime/usage_guides/pipelines)。

English: Cloudflare Agents documents durable fibers and workflows that survive process eviction and persist intermediate state. Quilin should use the idea as evidence for handoff recovery boundaries, not as a default hosting assumption. Sources: [Cloudflare Agents durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/) and [Cloudflare Agents workflows](https://developers.cloudflare.com/agents/concepts/workflows/).

中文：Cloudflare Agents 文档化了 durable fiber（可恢复执行纤程）和 workflow（工作流），可以在进程被回收后继续并持久化中间状态。Quilin 应把它作为移交恢复边界的证据，而不是默认托管假设。来源：[Cloudflare Agents durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/) 和 [Cloudflare Agents workflows](https://developers.cloudflare.com/agents/concepts/workflows/)。

## 三、范围边界 / Scope Boundary

English: Production planner routing means deciding which Planning path handles a request before runtime execution starts. It covers `simple_answer`, `single_tool`, `multi_step_linear`, `multi_step_parallel`, `clarification`, `supervisor_required`, and `deferred_due_to_budget` decisions.

中文：生产规划器路由是指在运行时执行开始前，决定一次请求应由哪条 Planning 路径处理。它覆盖 `simple_answer`、`single_tool`、`multi_step_linear`、`multi_step_parallel`、`clarification`、`supervisor_required` 和 `deferred_due_to_budget` 等决策。

English: Supervisor handoff means Planning has decided that a subtask should be delegated to a managed child run. The handoff must carry target capability, input payload, history filter, write scope, cancellation policy, retry policy, result schema, and trace metadata.

中文：监督者移交是指 Planning 已决定把某个子任务委派给受管理的子运行。移交必须携带目标能力、输入载荷、历史过滤、写入范围、取消策略、重试策略、结果 schema 和追踪元数据。

English: Cross-process handoff routing means choosing whether a handoff stays in-process, moves to another local process, or later crosses into Agent Mesh（Agent 间网络协作层，用于跨进程或跨机器通信）. The first production route must default to in-process or local-process only; remote mesh routing remains behind `QUI-10`.

中文：跨进程移交路由是指决定一次移交留在同进程、转到另一个本地进程，还是未来进入 Agent Mesh（Agent 间网络协作层，用于跨进程或跨机器通信）。第一版生产路由必须默认只支持同进程或本地进程；远端 mesh 路由继续留在 `QUI-10` 后面。

English: RouteLLM-style cost routing means choosing model strength from cost and quality evidence. It must be owned by Provider Control Plane and exposed to Planning as a route signal, not implemented as a hidden branch inside the planner.

中文：RouteLLM 风格成本路由是指基于成本与质量证据选择模型强度。它必须由 Provider Control Plane 负责，并以路由信号形式暴露给 Planning，而不是在 planner 里做隐藏分支。

English: Local tiny classifier means a local model can propose a routing hint when the deployment is offline, cost-capped, or running in batch mode. It must never override the main LLM（Large Language Model，大语言模型）structural dispatch unless a dedicated experiment proves parity.

中文：本地小分类器是指在离线、成本受限或批处理部署中，本地模型可以提出路由提示。除非专门实验已经证明等价，否则它绝不能覆盖主 LLM（Large Language Model，大语言模型）的结构化分派结果。

## 四、非目标 / Non-Goals

English: `QUI-17` does not own queue leases, heartbeat renewal, runtime locks, parent inbox/outbox persistence, child process supervision, or no-dropped-completion guarantees. Those belong to `QUI-61` and `QUI-9`.

中文：`QUI-17` 不负责队列租约、心跳续期、运行时锁、父运行收发件箱持久化、子进程监督，也不负责完成通知不丢失保证。这些属于 `QUI-61` 和 `QUI-9`。

English: `QUI-17` does not own provider implementation, gateway fallback, cache accounting, live provider matrix, or normalized provider errors. Those belong to `QUI-59` and `QUI-74`.

中文：`QUI-17` 不负责供应商实现、网关失败回退、缓存核算、供应商实机矩阵或归一化供应商错误。这些属于 `QUI-59` 和 `QUI-74`。

English: `QUI-17` does not own remote mesh trust, LAN discovery, daemon gateway, federation, relay, or public mesh routing. Those remain deferred under `QUI-10`.

中文：`QUI-17` 不负责远端 mesh 信任、局域网发现、daemon gateway（后台守护进程网关）、联邦、relay（中继）或公网 mesh 路由。这些继续由 `QUI-10` 延后处理。

## 五、触发条件 / Trigger Conditions

English: Production planner routing should be implemented when the current structural dispatch cannot distinguish at least three production cases: short direct answer, tool-backed single step, and managed multi-step handoff. Until then, the existing Planning path can remain local and rule-light.

中文：当当前结构化分派无法稳定区分至少三类生产场景时，应实现生产规划器路由：短直接回答、工具驱动单步任务、受管理多步移交。在此之前，现有 Planning 路径可以继续保持本地和轻规则。

English: Supervisor handoff should be enabled only when `TypedHandoffEnvelope`（结构化任务移交封包）and durable child run state have code-level schema tests. A prompt-only handoff is not acceptable for production.

中文：监督者移交只能在 `TypedHandoffEnvelope`（结构化任务移交封包）和可恢复子运行状态拥有代码级 schema 测试后启用。只靠 prompt 的移交不能进入生产。

English: Cross-process routing should be enabled only when local in-process handoff has trace evidence, cancellation evidence, retry evidence, and parent inbox acknowledgement evidence. Moving across a process boundary before local evidence exists increases failure modes without adding user value.

中文：跨进程路由只能在本地同进程移交已有 trace（追踪）证据、取消证据、重试证据和父运行收件确认后启用。在本地证据不足前跨进程，只会增加失败模式，不会增加用户价值。

English: RouteLLM-style cost routing should be enabled only after `QUI-59` produces route records with normalized cost, model quality labels, fallback attempts, and provider metadata. Without these records, cost routing cannot be audited.

中文：RouteLLM 风格成本路由只能在 `QUI-59` 产出包含归一化成本、模型质量标签、失败回退尝试和供应商元数据的路由记录后启用。没有这些记录，成本路由无法审计。

English: Local tiny classifier should be enabled only under explicit configuration for offline or cost-capped deployment. It must publish precision, recall, confusion matrix, fallback rate, and disagreement rate against main-LLM structural dispatch before it can influence default routes.

中文：本地小分类器只能在离线或成本受限部署中通过显式配置启用。它影响默认路由前，必须发布 precision（精确率）、recall（召回率）、confusion matrix（混淆矩阵）、回退率，以及与主大语言模型结构化分派的不一致率。

## 六、输入输出契约 / Input and Output Contracts

English: `PlannerRoutingRequest` is the input to the production planner router. It should be built after Context assembly and before any tool or child-agent side effect.

中文：`PlannerRoutingRequest` 是生产规划器路由器的输入。它应在 Context（上下文）组装完成后、任何工具或子 Agent 副作用发生前构造。

```ts
interface PlannerRoutingRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly userGoal: string;
  readonly structuralSignals: {
    readonly hasToolCalls: boolean;
    readonly toolCallCount: number;
    readonly hasPlanSketch: boolean;
    readonly needsClarification: boolean;
  };
  readonly budget: {
    readonly tokenRemaining: number;
    readonly turnRemaining: number;
    readonly spendCapUsd?: number;
  };
  readonly capabilitiesRequired: readonly string[];
  readonly riskTier: "read_only" | "ask_on_write" | "auto_opt_in" | "critical";
  readonly traceId: string;
}
```

English: `PlannerRoutingDecision` is the output from the planner router. It must be deterministic from the request plus configured policies, and it must be written to trace storage before execution starts.

中文：`PlannerRoutingDecision` 是规划器路由器的输出。它必须由请求和已配置策略确定，并且必须在执行开始前写入 trace storage（追踪存储）。

```ts
interface PlannerRoutingDecision {
  readonly schemaVersion: 1;
  readonly route:
    | "simple_answer"
    | "single_tool"
    | "multi_step_linear"
    | "multi_step_parallel"
    | "clarification"
    | "supervisor_required"
    | "deferred_due_to_budget";
  readonly strategy: "cot" | "react" | "plan_and_execute";
  readonly requiresSupervisor: boolean;
  readonly requiresProviderRoute: boolean;
  readonly requiresHandoffEnvelope: boolean;
  readonly reasonCodes: readonly string[];
  readonly traceId: string;
}
```

English: `SupervisorHandoffPlan` is Planning's output when `requiresSupervisor` is true. It is not a runtime dispatch record; it is the typed intent that `QUI-61` must later persist into parent outbox.

中文：`SupervisorHandoffPlan` 是 `requiresSupervisor` 为 true 时 Planning 的输出。它不是运行时派发记录；它是类型化意图，后续由 `QUI-61` 持久化进父运行 outbox（发件箱）。

```ts
interface SupervisorHandoffPlan {
  readonly schemaVersion: 1;
  readonly handoffKind: "in_process" | "local_process" | "mesh_deferred";
  readonly receiverCapability: string;
  readonly inputSchemaRef: string;
  readonly inputPayloadRef: string;
  readonly historyFilter: "full" | "summary" | "task_only" | "custom";
  readonly writeScope: readonly string[];
  readonly retryPolicyRef: string;
  readonly cancellationPolicyRef: string;
  readonly resultSchemaRef: string;
  readonly traceId: string;
}
```

English: `CrossProcessRouteDecision` is the future boundary between Planning and Agent Mesh. The first version should support only `in_process` and `local_process`; `remote_mesh` must fail closed until `QUI-10` supplies trust and routing evidence.

中文：`CrossProcessRouteDecision` 是 Planning 与 Agent Mesh 之间的未来边界。第一版只应支持 `in_process` 和 `local_process`；在 `QUI-10` 提供信任与路由证据前，`remote_mesh` 必须显式失败。

```ts
interface CrossProcessRouteDecision {
  readonly schemaVersion: 1;
  readonly mode: "in_process" | "local_process" | "remote_mesh";
  readonly allowed: boolean;
  readonly deniedReason?: "mesh_deferred" | "missing_trust" | "missing_observability" | "budget_blocked";
  readonly processTarget?: string;
  readonly timeoutMs: number;
  readonly traceId: string;
}
```

English: `CostRoutingSignal` is the only RouteLLM-style surface Planning should see. It is a signal from Provider Control Plane, not a planner-owned model selection.

中文：`CostRoutingSignal` 是 Planning 应看到的唯一 RouteLLM 风格表面。它来自 Provider Control Plane，而不是 planner 自己拥有的模型选择。

```ts
interface CostRoutingSignal {
  readonly schemaVersion: 1;
  readonly costStrategy: "none" | "threshold_router" | "quality_floor_router";
  readonly recommendedModelTier: "cheap" | "balanced" | "strong";
  readonly costThreshold?: number;
  readonly qualityFloor?: number;
  readonly evidenceRecordRef?: string;
  readonly mayDownshift: boolean;
  readonly traceId: string;
}
```

English: `TinyClassifierSignal` is advisory. It can reduce token cost in offline or batch mode, but it cannot be the sole production decision source.

中文：`TinyClassifierSignal` 只是建议性信号。它可以在离线或批处理模式下降低 token 成本，但不能成为唯一生产决策来源。

```ts
interface TinyClassifierSignal {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly modelRef: string;
  readonly predictedRoute: PlannerRoutingDecision["route"];
  readonly confidence: number;
  readonly calibrated: boolean;
  readonly disagreementWithStructural?: boolean;
}
```

## 七、生产路由流程 / Production Routing Flow

English: Step 1 is structural dispatch. Planning reads the main model response shape and derives whether the request looks like direct answer, single tool, multi-step, or clarification. This remains the default because it costs no extra model call.

中文：第一步是结构化分派。Planning 读取主模型响应形状，并推导请求看起来是直接回答、单工具、多步任务还是澄清。这继续作为默认路径，因为它不需要额外模型调用。

English: Step 2 is policy enrichment. Planning adds risk tier, budget state, context pressure, write scope, user override, available skills, and supervisor availability.

中文：第二步是策略补充。Planning 加入风险等级、预算状态、上下文压力、写入范围、用户 override（用户显式覆盖）、可用技能和监督者可用性。

English: Step 3 is route decision. Planning chooses the route, strategy, supervisor requirement, and whether a Provider Control Plane cost signal is needed before the next model call.

中文：第三步是路由决策。Planning 选择 route、strategy、是否需要监督者，以及下一次模型调用前是否需要 Provider Control Plane 成本信号。

English: Step 4 is handoff plan construction. When supervisor handoff is required, Planning emits `SupervisorHandoffPlan` and stops before runtime dispatch. Durable Runtime owns the actual child run.

中文：第四步是移交计划构造。需要监督者移交时，Planning 产出 `SupervisorHandoffPlan` 并在运行时派发前停止。实际子运行由 Durable Runtime 负责。

English: Step 5 is trace commit. Every route decision, cost signal, classifier hint, and handoff plan must be emitted as a trace event before execution. A route that cannot be explained later is not a production route.

中文：第五步是追踪提交。每个路由决策、成本信号、分类器提示和移交计划都必须在执行前作为 trace event（追踪事件）输出。事后无法解释的路由不能算生产路由。

## 八、验收门槛 / Acceptance Gates

English: Gate 1 is deterministic contract tests. The same `PlannerRoutingRequest` and policy snapshot must always produce the same `PlannerRoutingDecision`, including reason codes.

中文：门槛 1 是确定性契约测试。同一个 `PlannerRoutingRequest` 和策略快照必须始终产出相同的 `PlannerRoutingDecision`，包括 reason codes（原因代码）。

English: Gate 2 is route trace coverage. Tests must prove that every route decision writes trace data with `runId`, `traceId`, route, strategy, reason codes, budget state, and handoff requirement.

中文：门槛 2 是路由追踪覆盖。测试必须证明每个路由决策都会写入包含 `runId`、`traceId`、route、strategy、reason codes、预算状态和移交需求的追踪数据。

English: Gate 3 is handoff schema validation. Any supervisor handoff must validate input schema, result schema, history filter, write scope, retry policy, cancellation policy, and trace metadata before runtime dispatch.

中文：门槛 3 是移交 schema 校验。任何监督者移交都必须在运行时派发前校验输入 schema、结果 schema、历史过滤、写入范围、重试策略、取消策略和追踪元数据。

English: Gate 4 is local-only cross-process safety. `remote_mesh` must fail closed with `mesh_deferred` until `QUI-10` proves remote identity, trust, observability, and failure recovery.

中文：门槛 4 是本地优先的跨进程安全。直到 `QUI-10` 证明远端身份、信任、可观测性和失败恢复前，`remote_mesh` 必须以 `mesh_deferred` 显式失败。

English: Gate 5 is provider evidence before cost routing. RouteLLM-style routing cannot affect default model tiers until `QUI-59` and `QUI-74` provide cost and quality run records that can be replayed by a reviewer.

中文：门槛 5 是成本路由前必须有供应商证据。RouteLLM 风格路由不能影响默认模型层级，除非 `QUI-59` 和 `QUI-74` 已提供可由 reviewer（审核者）复算的成本与质量运行记录。

English: Gate 6 is classifier calibration. A local tiny classifier cannot influence default routing until it has a fixed evaluation set, calibration curve, confusion matrix, disagreement handling rule, and fail-open path back to main-LLM structural dispatch.

中文：门槛 6 是分类器校准。本地小分类器不能影响默认路由，除非它有固定评测集、校准曲线、混淆矩阵、不一致处理规则，以及回到主大语言模型结构化分派的 fail-open（失败时回到更安全主路径）路径。

English: Gate 7 is user-visible explanation. When routing defers, downshifts model tier, asks for clarification, or chooses a supervisor, the system must be able to produce a concise user-facing reason without exposing private chain-of-thought.

中文：门槛 7 是用户可见解释。当路由延后、降低模型层级、请求澄清或选择监督者时，系统必须能产出简洁的用户可见原因，同时不暴露私有思维链。

## 九、失败模式 / Failure Modes

English: Failure mode 1 is hidden cost routing. If the model tier changes without a `CostRoutingSignal` and provider evidence reference, the route is unauditable and must fail the acceptance gate.

中文：失败模式 1 是隐藏成本路由。如果模型层级变化没有 `CostRoutingSignal` 和供应商证据引用，该路由无法审计，必须无法通过验收门槛。

English: Failure mode 2 is prompt-only handoff. If a child run receives only a prose summary without schema, write scope, retry policy, cancellation policy, and trace ID, the supervisor cannot recover or prove delivery.

中文：失败模式 2 是纯 prompt 移交。如果子运行只收到自然语言摘要，而没有 schema、写入范围、重试策略、取消策略和 trace ID，监督者就无法恢复，也无法证明交付。

English: Failure mode 3 is premature cross-process routing. If a handoff crosses a process boundary before local delivery is proven, retries and cancellation can duplicate side effects or drop final results.

中文：失败模式 3 是过早跨进程路由。如果移交在本地交付被证明前跨越进程边界，重试和取消可能重复副作用或丢失最终结果。

English: Failure mode 4 is classifier overreach. A tiny classifier that overrides structural dispatch can silently downgrade hard tasks. It must stay advisory until measured against production traces.

中文：失败模式 4 是分类器越权。覆盖结构化分派的小分类器可能静默降级困难任务。它必须保持建议性，直到用生产轨迹完成度量。

## 十、实现切片 / Implementation Slices

English: Slice 1 should add `PlannerRoutingRequest` and `PlannerRoutingDecision` types plus deterministic tests. No model routing, no child runtime, and no cross-process dispatch should be added in this slice.

中文：切片 1 应增加 `PlannerRoutingRequest` 和 `PlannerRoutingDecision` 类型及确定性测试。该切片不应增加模型路由、子运行时或跨进程派发。

English: Slice 2 should add trace emission for planner routing. The trace record must be enough for Observability to render why a route was selected and whether it required a supervisor.

中文：切片 2 应增加规划器路由的追踪输出。追踪记录必须足够让 Observability 展示为什么选择该路由，以及是否需要监督者。

English: Slice 3 should add `SupervisorHandoffPlan` construction and schema validation. Runtime dispatch remains under `QUI-61`; Planning stops after producing the handoff plan.

中文：切片 3 应增加 `SupervisorHandoffPlan` 构造和 schema 校验。运行时派发仍归 `QUI-61`；Planning 在产出移交计划后停止。

English: Slice 4 should add local-only `CrossProcessRouteDecision` with `remote_mesh` denied by default. This prepares the Agent Mesh boundary without implementing remote mesh routing.

中文：切片 4 应增加本地优先的 `CrossProcessRouteDecision`，并默认拒绝 `remote_mesh`。这会准备 Agent Mesh 边界，但不实现远端 mesh 路由。

English: Slice 5 should consume `CostRoutingSignal` from Provider Control Plane after `QUI-59` evidence exists. It should not train or ship a RouteLLM-style router inside Planning.

中文：切片 5 应在 `QUI-59` 证据存在后消费 Provider Control Plane 产出的 `CostRoutingSignal`。它不应在 Planning 内训练或发布 RouteLLM 风格路由器。

English: Slice 6 should add a disabled-by-default `TinyClassifierSignal` experiment harness for offline and cost-capped deployments. Promotion to default route influence requires a later Linear comment with calibration evidence.

中文：切片 6 应增加默认关闭的 `TinyClassifierSignal` 实验 harness（实验脚手架，用来跑固定评测和记录结果），用于离线和成本受限部署。要提升为默认路由影响因素，必须后续在 Linear comment 中补充校准证据。

## 十一、Linear 映射 / Linear Mapping

English: `QUI-17` owns this production routing backlog and the future Planning-side contracts. It should remain open until at least Slices 1 through 3 are implemented and validated in code.

中文：`QUI-17` 负责本文的生产路由 backlog 和未来 Planning 侧契约。至少切片 1 到切片 3 完成代码实现和验证前，它应保持 open。

English: `QUI-50` owns the durable execution direction and has already decided that Planning emits durable contracts while runtime executes them. `QUI-17` should not reopen that decision.

中文：`QUI-50` 负责可恢复执行方向，并已经决定 Planning 产出可恢复契约、runtime 执行契约。`QUI-17` 不应重新打开该决策。

English: `QUI-61` owns durable sub-agent runtime, parent inbox/outbox, heartbeat/lease, retry/idempotency, and child lifecycle. `QUI-17` only prepares the typed handoff plan that runtime later consumes.

中文：`QUI-61` 负责可恢复子 Agent 运行时、父运行收发件箱、心跳/租约、重试/幂等和子生命周期。`QUI-17` 只准备后续由 runtime 消费的类型化移交计划。

English: `QUI-59` and `QUI-74` own provider routing evidence, cost accounting, gateway/direct behavior, and route quality records. `QUI-17` can consume their signals only after their evidence gates pass.

中文：`QUI-59` 和 `QUI-74` 负责供应商路由证据、成本核算、网关/直连行为和路由质量记录。`QUI-17` 只能在它们的证据门槛通过后消费其信号。

English: `QUI-10` owns remote Agent Mesh runtime. `QUI-17` must keep remote handoff as `mesh_deferred` until `QUI-10` supplies identity, trust, routing, and observability contracts.

中文：`QUI-10` 负责远端 Agent Mesh 运行时。`QUI-17` 必须把远端移交保持为 `mesh_deferred`，直到 `QUI-10` 提供身份、信任、路由和可观测契约。

## 十二、关闭条件 / Closure Conditions

English: `QUI-17` can be marked Done only after code exists for planner route contracts, deterministic route tests, trace emission, supervisor handoff plan construction, schema validation, and a documented reason for keeping RouteLLM-style and local-classifier routing disabled or experimental.

中文：只有当规划器路由契约、确定性路由测试、追踪输出、监督者移交计划构造、schema 校验，以及保持 RouteLLM 风格和本地分类器路由为关闭或实验状态的说明都已有代码后，`QUI-17` 才能标记 Done。

English: This document alone does not satisfy the closure condition. It satisfies the planning artifact requirement and should be referenced by the future implementation PR.

中文：仅本文档不满足关闭条件。它满足规划产物要求，并应被未来实现 PR 引用。
