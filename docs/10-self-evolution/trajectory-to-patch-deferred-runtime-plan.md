# 轨迹到补丁延后运行时规划 / Trajectory-To-Patch Deferred Runtime Plan

> Linear record: `QUI-12`. Input documents: `docs/10-self-evolution/self-evolution-frontier-assimilation.md`, `docs/10-self-evolution/self-evolution-runtime-implementation-plan.md`, `docs/07-safety-guardrails/agentic-risk-baseline.md`, and `docs/13-skills/skills-runtime-implementation-plan.md`. Planning snapshot: 2026-05-02, Asia/Shanghai.
>
> Linear 记录：`QUI-12`。输入文档：`docs/10-self-evolution/self-evolution-frontier-assimilation.md`、`docs/10-self-evolution/self-evolution-runtime-implementation-plan.md`、`docs/07-safety-guardrails/agentic-risk-baseline.md` 和 `docs/13-skills/skills-runtime-implementation-plan.md`。规划快照：2026-05-02，Asia/Shanghai。

## 结论 / Decision

English: `QUI-12` should remain open as the deferred runtime owner for the full trajectory-to-patch self-evolution loop（从运行轨迹生成补丁建议的自进化闭环）. It should not duplicate `QUI-68`, which owns the first proposal-only runtime slice: trajectory capture, failure diagnosis, offline candidate generation, evaluation comparison, and a `pending_review` patch proposal.

中文：`QUI-12` 应继续保留为完整 trajectory-to-patch self-evolution loop（从运行轨迹生成补丁建议的自进化闭环）的延后运行时负责人。它不应重复 `QUI-68`，后者负责第一版只提案运行时切片：轨迹采集、失败诊断、离线候选生成、评测对比，以及状态为 `pending_review` 的补丁提案。

English: The architectural invariant is strict: Quilin may collect evidence, diagnose failures, generate candidate diffs, and prepare review artifacts, but it must not automatically apply scaffold patches. Scaffold patch（脚手架补丁，指会改变系统提示词、工具配置、工作流、策略或运行时代码行为的改动） must pass through `WriteAuthority`（统一写权限门，用来裁决所有 Agent 发起写入动作的运行时 gate） and human review before it can affect runtime behavior.

中文：架构不变式必须严格：Quilin 可以收集证据、诊断失败、生成候选 diff，并准备审核产物，但不能自动应用 scaffold patch（脚手架补丁，指会改变系统提示词、工具配置、工作流、策略或运行时代码行为的改动）。任何脚手架补丁必须经过 `WriteAuthority`（统一写权限门，用来裁决所有 Agent 发起写入动作的运行时 gate）和人工审核后，才能影响运行时行为。

English: Idle evolution（空闲自进化，即用户未主动交互时进行的后台分析和提案准备） remains default OFF. When explicitly enabled, it may run bounded collection, clustering, and proposal drafting, but `origin:"idle"` must stay visible in every proposal, and no idle path may write to `packages/`, `providers/`, `docs/`, skill roots, or provider configuration.

中文：Idle evolution（空闲自进化，即用户未主动交互时进行的后台分析和提案准备）默认仍为 OFF。即使用户显式启用，它也只能执行有预算边界的采集、聚类和提案草拟；每个提案都必须保留 `origin:"idle"`，并且任何空闲路径都不得写入 `packages/`、`providers/`、`docs/`、skill roots（技能根目录）或模型供应商配置。

## 来源与前沿依据 / Sources And Frontier Inputs

English: OpenAI's official self-evolving agents cookbook describes a measurable improvement loop that combines feedback, evaluation, human review, and iterative prompt refinement. Quilin should absorb the loop shape and the human-review discipline, not an automatic production-write path. Source: [OpenAI Cookbook: Self-Evolving Agents](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining).

中文：OpenAI 官方 self-evolving agents cookbook（自进化 Agent 示例）描述了结合反馈、评测、人工审核和迭代提示词优化的可度量改进闭环。Quilin 应吸收闭环形态和人工审核纪律，而不是吸收自动写入生产行为。来源：[OpenAI Cookbook: Self-Evolving Agents](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining)。

English: DSPy optimizer documentation shows that optimizer workers can synthesize few-shot examples, propose natural-language instructions, and search candidate programs from traces and metrics. Quilin should place DSPy（Declarative Self-improving Python，一个把大语言模型程序拆成可评测模块并离线优化的框架） behind an offline worker boundary so it emits artifacts rather than writes. Source: [DSPy optimizer docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md).

中文：DSPy 优化器文档显示，优化器 worker 可以从轨迹与指标中合成 few-shot examples（少样本示例）、提出自然语言指令，并搜索候选程序。Quilin 应把 DSPy（Declarative Self-improving Python，一个把大语言模型程序拆成可评测模块并离线优化的框架）放在离线 worker 边界之后，让它只输出产物而不是执行写入。来源：[DSPy optimizer docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md)。

English: OpenTelemetry GenAI semantic conventions define portable spans for model and tool operations and warn that captured inputs, outputs, and tool arguments can contain sensitive information. Quilin should map trajectory events to OpenTelemetry（跨系统追踪、指标和日志标准） where useful, but keep a Quilin-owned schema, redaction profile, and payload reference model. Source: [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/).

中文：OpenTelemetry GenAI 语义约定定义了模型与工具操作的可移植 span（追踪片段），并提醒输入、输出和工具参数可能包含敏感信息。Quilin 应在有价值时把轨迹事件映射到 OpenTelemetry（跨系统追踪、指标和日志标准），但内部仍保留 Quilin 自有 schema（结构定义）、脱敏配置和载荷引用模型。来源：[OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)。

English: OpenHands documents an event-driven reasoning-action loop and a persistence layout where individual event files replace one monolithic trajectory file for better granular access. Quilin should absorb that event-sourced shape for replay and review, while keeping its own safety gates. Sources: [OpenHands Agent architecture](https://docs.openhands.dev/sdk/arch/agent) and [OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence).

中文：OpenHands 文档描述了事件驱动的 reasoning-action loop（推理-行动循环），以及用单个事件文件替代巨大 trajectory file（轨迹文件）的持久化布局，以获得更细粒度访问。Quilin 应吸收这种 event-sourced（事件溯源）形态用于回放和审核，同时保留自己的安全门。来源：[OpenHands Agent architecture](https://docs.openhands.dev/sdk/arch/agent) 和 [OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)。

English: Langfuse and Phoenix both show that production observations can be converted into versioned datasets and experiments. Quilin should use the same pattern: selected trajectories become frozen local evaluation datasets before any optimizer can compare a candidate. Sources: [Langfuse datasets and experiments](https://langfuse.com/docs/evaluation/experiments/datasets) and [Phoenix experiments](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments).

中文：Langfuse 和 Phoenix 都展示了把生产 observation（观测记录）转换为版本化 dataset（数据集）与 experiment（实验）的模式。Quilin 应使用同样模式：被选中的轨迹必须先变成冻结本地评测数据集，然后优化器才能比较候选方案。来源：[Langfuse datasets and experiments](https://langfuse.com/docs/evaluation/experiments/datasets) 和 [Phoenix experiments](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments)。

English: SWE-agent trajectory documentation shows the value of storing reproducible trajectories for later inspection and demonstration extraction. Quilin should keep config, model route, tool events, outputs, exit state, and evaluator version together so proposal evidence can be replayed. Source: [SWE-agent trajectories](https://swe-agent.com/0.7/usage/trajectories/).

中文：SWE-agent 轨迹文档展示了保存可复现轨迹以便后续检查和提取示范样本的价值。Quilin 应把配置、模型路由、工具事件、输出、退出状态和评测器版本放在一起保存，让提案证据可以回放。来源：[SWE-agent trajectories](https://swe-agent.com/0.7/usage/trajectories/)。

## 延后范围 / Deferred Scope

English: `QUI-12` starts only after `QUI-68` proves a controlled failure can produce a complete proposal artifact without applying it. The deferred scope is larger: multiple trajectory sources, pattern mining across tasks, richer optimizer workers, proposal queues, reviewer workflows, User Insight Engine（用户洞察引擎，从用户行为模式中产生可解释产品洞察的子系统） integration, and long-running idle analysis.

中文：`QUI-12` 只有在 `QUI-68` 证明一个受控失败能生成完整提案产物且不会应用该提案之后才启动。延后范围更大：多种轨迹来源、跨任务模式挖掘、更丰富的优化器 worker、提案队列、审核工作流、User Insight Engine（用户洞察引擎，从用户行为模式中产生可解释产品洞察的子系统）集成，以及长时间空闲分析。

English: The deferred scope does not grant permission to implement automatic patch application, silent prompt mutation, automatic skill persistence, dependency updates, provider configuration writes, or runtime policy changes. These remain outside Self-Evolution's direct authority.

中文：延后范围不授予自动应用补丁、静默修改提示词、自动持久化技能、更新依赖、写入供应商配置或改变运行时策略的权限。这些行为仍然不属于 Self-Evolution（自进化）的直接权力。

## 目标运行流 / Target Runtime Flow

English: The target flow is `TrajectoryCollector -> TrajectoryStore -> FailureAnalyzer -> PatternMiner -> DatasetBuilder -> OptimizerWorker -> EvalComparator -> PatchProposal -> WriteAuthority -> HumanReview -> HumanAppliedChange`. Each arrow must carry an artifact id, hash, source issue, and redaction state.

中文：目标流程是 `TrajectoryCollector -> TrajectoryStore -> FailureAnalyzer -> PatternMiner -> DatasetBuilder -> OptimizerWorker -> EvalComparator -> PatchProposal -> WriteAuthority -> HumanReview -> HumanAppliedChange`。每条箭头都必须携带 artifact id（产物标识）、hash（哈希）、来源 issue 和脱敏状态。

```text
Runtime events
  -> TrajectoryCollector
  -> append-only TrajectoryStore
  -> FailureAnalyzer diagnostics
  -> cross-run pattern mining
  -> frozen local dataset
  -> optimizer worker candidates
  -> before/after evaluation comparison
  -> human-reviewed patch proposal
  -> WriteAuthority decision record
  -> human PR or equivalent review path
```

English: A proposal may be generated by the main agent, a subagent, or an idle worker, but it always stops at review. The runtime must treat proposal creation and proposal application as separate systems with separate permissions.

中文：提案可以由主 Agent、subagent（子 Agent）或空闲 worker 生成，但必须始终停在审核处。运行时必须把提案创建和提案应用视为两个拥有不同权限的系统。

## TrajectoryCollector（轨迹采集器）边界

English: `TrajectoryCollector` is the runtime capture boundary. It observes selected events from the agent loop, model routing, context assembly, tool calls, safety decisions, skill activations, memory retrievals, checkpointing, and user feedback. It should not analyze, optimize, or decide whether a patch is needed.

中文：`TrajectoryCollector`（轨迹采集器）是运行时采集边界。它观察 Agent 循环、模型路由、上下文组装、工具调用、安全决策、技能激活、记忆检索、checkpoint（检查点）和用户反馈中的选定事件。它不应分析、不应优化，也不应判断是否需要补丁。

English: The collector should be low-latency and loss-aware. If capture fails, the user task should continue, but the run should carry an `observability_gap` diagnostic candidate so later self-evolution does not mistake missing telemetry for successful behavior.

中文：采集器应低延迟且能感知丢失。如果采集失败，用户任务应继续执行，但该次运行应携带 `observability_gap`（可观测性缺口）诊断候选，避免后续自进化把缺失遥测误判为行为成功。

English: The collector must classify payload handling before storage: `metadata_only`, `redacted_content`, `full_content_local_only`, or `hash_only`. Raw user content, secrets, file bodies, tool outputs, and model messages must never be exported to optimizer workers unless the redaction profile explicitly allows it.

中文：采集器必须在存储前给载荷处理分类：`metadata_only`、`redacted_content`、`full_content_local_only` 或 `hash_only`。原始用户内容、密钥、文件正文、工具输出和模型消息不得导出给优化器 worker，除非脱敏配置明确允许。

English: `TrajectoryCollector` should align event names with Observability documents where possible. When OpenTelemetry field names are unstable or too broad, the collector should store Quilin canonical fields first and provide an exporter later.

中文：`TrajectoryCollector` 应尽量与 Observability（可观测性）文档中的事件名对齐。当 OpenTelemetry 字段名不稳定或过宽时，采集器应先保存 Quilin 规范字段，后续再提供 exporter（导出器）。

## TrajectoryStore（轨迹存储）边界

English: `TrajectoryStore` is append-only. Append-only means corrections, redactions, reviewer notes, and evaluator results become later events instead of rewriting earlier records. This protects auditability and lets failed proposals be explained after the fact.

中文：`TrajectoryStore`（轨迹存储）必须只追加。只追加意味着修正、脱敏、审核备注和评测结果都会成为后续事件，而不是改写旧记录。这样可以保护审计性，并让失败提案事后可解释。

English: The store owns retention, indexing, sanitized export, replay bundles, and source links. It should support lookup by run id, session id, Linear issue, failure category, user-approved feedback, and proposal id.

中文：轨迹存储负责保留策略、索引、脱敏导出、回放包和来源链接。它应支持按 run id（运行标识）、session id（会话标识）、Linear issue、失败类别、用户批准反馈和 proposal id（提案标识）查询。

English: The store must never become a hidden memory system. Long-term facts about the user belong to Memory（记忆系统），while trajectory evidence belongs to Self-Evolution. Only an explicit User Insight Engine handoff may promote a repeated behavioral pattern into a profile or insight candidate.

中文：轨迹存储不得变成隐藏记忆系统。关于用户的长期事实属于 Memory（记忆系统），轨迹证据属于 Self-Evolution。只有显式的 User Insight Engine 交接，才能把重复行为模式提升为 profile（用户画像）或 insight（洞察）候选。

## FailureAnalyzer（失败分析器）边界

English: `FailureAnalyzer` converts trajectories into typed diagnostics. It may combine deterministic rules, evaluator output, and LLM judge（大语言模型裁判，用另一个模型按规则判断失败原因的辅助信号） reasoning, but the final diagnostic must point to concrete events and evidence references.

中文：`FailureAnalyzer`（失败分析器）把轨迹转换成类型化诊断。它可以结合确定性规则、评测器输出和 LLM judge（大语言模型裁判，用另一个模型按规则判断失败原因的辅助信号）推理，但最终诊断必须指向具体事件和证据引用。

English: The analyzer should separate failure classification from repair selection. It can say the run failed because of a context gap, tool execution error, skill trigger miss, verification gap, provider routing error, safety block, or user-requirement miss. It should not directly choose a patch until pattern support and evaluation data exist.

中文：分析器应区分失败分类和修复选择。它可以判断运行失败来自上下文缺口、工具执行错误、技能触发漏判、验证缺失、供应商路由错误、安全阻断或用户需求遗漏。但在存在模式支持和评测数据前，它不应直接选择补丁。

English: Every diagnostic must include a `noProposalReason` when no patch should be generated. Valid reasons include insufficient evidence, unsafe target, duplicate pattern, outside current priority, user-private data, or already-covered issue.

中文：当不应生成补丁时，每条诊断都必须包含 `noProposalReason`。有效原因包括证据不足、目标不安全、重复模式、不符合当前优先级、涉及用户私密数据或已有 issue 覆盖。

## PatternMiner（模式挖掘器）边界

English: `PatternMiner`（模式挖掘器，用多条诊断寻找重复失败或机会模式的组件） turns individual diagnostics into candidate improvement patterns. It prevents overfitting one unlucky run and creates the minimum support threshold before optimizer workers are allowed to spend tokens.

中文：`PatternMiner`（模式挖掘器，用多条诊断寻找重复失败或机会模式的组件）把单条诊断转换为候选改进模式。它防止系统过拟合一次偶发失败，并在优化器 worker 消耗 token 前建立最小支持阈值。

English: Pattern mining should support two lanes. The failure lane looks for repeated broken behavior. The opportunity lane looks for repeated success patterns that can become skill drafts or user insights without changing runtime policy.

中文：模式挖掘应支持两条通道。失败通道寻找重复的错误行为。机会通道寻找重复的成功模式，这些模式可以变成 skill draft（技能草稿）或用户洞察，但不改变运行时策略。

English: The first automatic proposal threshold should stay conservative: at least three similar diagnostics, one deterministic regression fixture, or one explicit human-marked critical failure. Lower thresholds should only create investigation notes, not patch proposals.

中文：第一版自动提案阈值应保持保守：至少三条相似诊断、一个确定性回归 fixture（固定测试样例），或一次人工标记的关键失败。更低阈值只能生成调查备注，不能生成补丁提案。

## OptimizerWorker（优化器 Worker）边界

English: `OptimizerWorker`（优化器工作进程，即读取冻结数据并输出候选改进产物的离线进程） is not in the user-task path. It consumes frozen datasets, evaluator rubrics, redacted trajectory bundles, and baseline artifacts; it emits candidate artifacts and rationales.

中文：`OptimizerWorker`（优化器工作进程，即读取冻结数据并输出候选改进产物的离线进程）不在用户任务路径中。它消费冻结数据集、评测规则、脱敏轨迹包和基线产物；输出候选产物和理由。

English: Optimizer workers may host static metaprompt search, DSPy optimizers, GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法）, or future local algorithms. All of them must share the same interface and must not receive filesystem write authority.

中文：优化器 worker 可以托管静态 metaprompt（元提示词）搜索、DSPy 优化器、GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法）或未来本地算法。它们必须共享同一接口，并且不得获得文件系统写权限。

English: The worker must reuse model routing, cache, cost, and telemetry vocabulary from LLM Integration and Observability. It cannot silently pick a more expensive provider, bypass prompt cache accounting, or hide failed candidate runs.

中文：worker 必须复用 LLM Integration（模型集成）与 Observability 的模型路由、缓存、成本和遥测词汇。它不能静默选择更昂贵供应商，不能绕过 prompt cache（提示词缓存）计费，也不能隐藏失败候选运行。

English: Optimizer output should be narrow. Valid outputs are prompt candidate, skill draft, tool policy candidate, context policy candidate, evaluator improvement suggestion, documentation-only patch draft, or runtime scaffold proposal. Direct workspace edits are invalid output.

中文：优化器输出应保持收窄。有效输出包括提示词候选、技能草稿、工具策略候选、上下文策略候选、评测器改进建议、仅文档补丁草稿，或运行时脚手架提案。直接编辑工作区不是有效输出。

## PatchProposal（补丁提案）边界

English: `PatchProposal`（补丁提案，即 diff、证据、评测对比、风险和回滚说明的审核包） is the first point where a candidate becomes visible to a reviewer as a possible change. It is not a change application mechanism.

中文：`PatchProposal`（补丁提案，即 diff、证据、评测对比、风险和回滚说明的审核包）是候选方案首次作为可能变更展示给审核者的地方。它不是变更应用机制。

English: Every patch proposal must contain source trajectories, failure pattern, candidate artifact hash, generated diff or synthetic diff, before/after evaluation matrix, regression summary, redaction summary, risk level, `WriteAuthority` request preview, reviewer state, and rollback instructions.

中文：每个补丁提案都必须包含来源轨迹、失败模式、候选产物哈希、生成 diff 或 synthetic diff（合成差异）、优化前后评测矩阵、回归摘要、脱敏摘要、风险等级、`WriteAuthority` 请求预览、审核状态和回滚说明。

English: Any proposal that changes prompts, skills, policies, runtime scaffold, provider routing, or tool permissions should default to `riskLevel:"critical"` until Safety explicitly defines a lower-risk class. Documentation-only proposals may be lower risk, but still need a Linear record and reviewer visibility.

中文：任何会修改提示词、技能、策略、运行时脚手架、供应商路由或工具权限的提案，都应默认 `riskLevel:"critical"`，除非 Safety（安全组件）明确规定某类变更风险更低。仅文档提案可以更低风险，但仍需要 Linear 记录和审核者可见性。

English: Proposal storage should prefer records and comments. Materialized patch files under `.patches/` should be created only when a user or reviewer asks for them, and they remain non-versioned generated artifacts until accepted through the normal review path.

中文：提案存储应优先使用记录和 comment。只有当用户或审核者要求时，才应在 `.patches/` 下生成补丁文件；在通过正常审核路径前，它们仍是非版本化的生成产物。

## WriteAuthority 与人工审核 / WriteAuthority And Human Review

English: The first gate is semantic: the action-level classifier should decide whether a proposal is allowed to ask for review at all. The second gate is `WriteAuthority`, which records the write request, origin, risk, summary, detail, evidence references, and decision.

中文：第一道门是语义门：动作级分类器应判断一个提案是否允许请求审核。第二道门是 `WriteAuthority`，它记录写入请求、来源、风险、摘要、细节、证据引用和决策。

English: `origin:"idle"` must remain denied for direct writes in the default trust mode. Even in an explicit auto-trust session, critical scaffold proposals must require confirmation and human review before application.

中文：在默认信任模式下，`origin:"idle"` 对直接写入必须保持拒绝。即使在显式 auto-trust（自动信任）会话里，关键脚手架提案也必须在应用前要求确认和人工审核。

English: Only a human-reviewed PR（pull request，代码评审合入请求）or an equivalent human approval path may apply a proposal. Agents may prepare evidence, compare candidates, and respond to review feedback, but they may not claim that human approval happened.

中文：只有人工审核 PR（pull request，代码评审合入请求）或等价人工审批路径可以应用提案。Agent 可以准备证据、比较候选和回应 review feedback（评审反馈），但不能声称已经获得人工批准。

English: Future `scaffold_patch` tools must fail closed unless they receive a proposal id, dataset hash, evidence hashes, `WriteAuthority` decision, human review reference, and rollback plan. Missing any one of these inputs should block application.

中文：未来的 `scaffold_patch` 工具必须 fail closed（缺证据时默认拒绝），除非收到 proposal id、数据集哈希、证据哈希、`WriteAuthority` 决策、人工审核引用和回滚计划。任一输入缺失都应阻断应用。

## User Insight Engine（用户洞察引擎）边界

English: User Insight Engine turns repeated user behavior and successful interaction patterns into explainable insights. It is adjacent to Self-Evolution, but it must not become a hidden route for changing runtime scaffold or writing user profile facts without review.

中文：User Insight Engine（用户洞察引擎）把重复用户行为和成功交互模式转换为可解释洞察。它与 Self-Evolution 相邻，但不得变成隐藏通道，用来改变运行时脚手架或未经审核写入用户画像事实。

English: Its allowed outputs are insight candidates, user-facing suggestions, profile update proposals, memory consolidation prompts, and skill-draft candidates. Each output must include evidence ranges, confidence, privacy classification, and a user-visible reason.

中文：它允许输出 insight candidate（洞察候选）、面向用户的建议、画像更新提案、记忆整理提示和技能草稿候选。每个输出都必须包含证据范围、置信度、隐私分类和用户可见原因。

English: User Insight Engine may recommend that a repeated behavior deserves a new skill, but Skills owns persistence. It may recommend that a repeated preference belongs in memory, but Memory owns profile writes. It may recommend scaffold improvement, but Self-Evolution owns proposal evidence and Safety owns write authority.

中文：User Insight Engine 可以建议某个重复行为值得沉淀为新技能，但 Skills（技能系统）负责持久化。它可以建议某个重复偏好属于记忆，但 Memory 负责画像写入。它可以建议脚手架改进，但 Self-Evolution 负责提案证据，Safety 负责写入权限。

## 空闲自进化 / Idle Evolution

English: Idle evolution is opt-in only. Default OFF means no background token spend, no browsing, no proposal generation, and no scaffold write attempt when the user has not explicitly enabled it.

中文：空闲自进化只能显式选择加入。默认 OFF 意味着用户未明确启用时，不进行后台 token 消耗、不浏览、不生成提案，也不尝试脚手架写入。

English: When enabled, idle evolution should obey budget, schedule, scope, and source limits. It may consolidate trajectories, cluster failures, draft low-priority proposals, and prepare review summaries. It must record Linear comments for non-trivial work and keep artifacts in docs or proposal records when the task is research-oriented.

中文：启用后，空闲自进化应遵守预算、调度、作用域和来源限制。它可以整理轨迹、聚类失败、草拟低优先级提案，并准备审核摘要。非琐碎工作必须写 Linear comment；调研类任务还必须把产物放入 docs 或提案记录。

English: Idle workers should not compete with active user work. If a user task begins, idle workers should stop assigning new work, checkpoint current analysis, and resume only when the configured idle window returns.

中文：空闲 worker 不应与活跃用户任务竞争。如果用户任务开始，空闲 worker 应停止分配新工作，checkpoint（检查点保存）当前分析，并只在配置的空闲窗口恢复后继续。

## 延后重开门槛 / Deferred Reopen Gates

English: Gate 1 is `QUI-68` completion. A controlled failure must produce trajectory, diagnostic, frozen dataset, candidate artifact, evaluation comparison, and patch proposal with no runtime-affecting write.

中文：门槛 1 是 `QUI-68` 完成。一个受控失败必须生成轨迹、诊断、冻结数据集、候选产物、评测对比和补丁提案，并且不发生任何影响运行时行为的写入。

English: Gate 2 is redaction confidence. Sanitized exports must prove that optimizer workers can run without raw secrets, private file bodies, or unrelated user content.

中文：门槛 2 是脱敏可信度。脱敏导出必须证明优化器 worker 可以在没有原始密钥、私有文件正文或无关用户内容的情况下运行。

English: Gate 3 is evaluation stability. Local self-evolution datasets must be versioned, replayable, and strong enough to catch at least safety regression, context regression, skill regression, cost regression, and documentation-language regression.

中文：门槛 3 是评测稳定性。本地自进化数据集必须版本化、可回放，并且足以捕获安全回归、上下文回归、技能回归、成本回归和文档语言回归。

English: Gate 4 is review workflow maturity. Reviewers must be able to sort proposals by risk, component, evidence strength, regression count, and expected benefit without manually reading raw logs.

中文：门槛 4 是审核工作流成熟度。审核者必须能按风险、组件、证据强度、回归数量和预期收益排序提案，而不需要人工阅读原始日志。

English: Gate 5 is idle discipline. Idle evolution must demonstrate default OFF, bounded token budget, visible Linear records, checkpoint/resume behavior, and no automatic scaffold application.

中文：门槛 5 是空闲纪律。空闲自进化必须证明默认 OFF、token 预算有界、Linear 记录可见、具备 checkpoint/resume（检查点/恢复）行为，并且不会自动应用脚手架补丁。

## 组件权属 / Component Ownership

English: Self-Evolution owns trajectory diagnostics, pattern mining, optimizer orchestration, proposal artifacts, and proposal lifecycle. It does not own tool permissions, skill persistence, memory profile writes, provider routing authority, or production deployment.

中文：Self-Evolution 负责轨迹诊断、模式挖掘、优化器编排、提案产物和提案生命周期。它不负责工具权限、技能持久化、记忆画像写入、供应商路由权力或生产部署。

English: Observability owns spans, metrics, logs, trace correlation, sampling, redaction export shape, and dashboard visibility. Self-Evolution consumes those events but should not invent a parallel trace system.

中文：Observability 负责 span、metric（指标）、log（日志）、trace correlation（追踪关联）、采样、脱敏导出形状和 dashboard（仪表盘）可见性。Self-Evolution 消费这些事件，但不应发明并行追踪系统。

English: Safety owns action classification, `WriteAuthority`, critical-risk policy, permission bypass detection, and audit invariants. Every proposal that can change behavior must satisfy Safety's gate before human review can apply it.

中文：Safety 负责动作分类、`WriteAuthority`、关键风险策略、权限绕过检测和审计不变式。每个可能改变行为的提案在人工审核应用前，都必须满足 Safety 的 gate。

English: Skills owns `SKILL.md` persistence, manifest validation, provenance, eval runner, and `skill_manage`. Self-Evolution may propose skill drafts, but it cannot directly create or modify persisted skills.

中文：Skills 负责 `SKILL.md` 持久化、manifest（清单）校验、provenance（来源记录）、eval runner（评测运行器）和 `skill_manage`。Self-Evolution 可以提出技能草稿，但不能直接创建或修改已持久化技能。

English: Memory owns user profile and long-term fact persistence. User Insight Engine may create profile update proposals, but Memory and user approval decide whether a fact is saved.

中文：Memory 负责用户画像和长期事实持久化。User Insight Engine 可以创建画像更新提案，但事实是否保存由 Memory 和用户批准决定。

## 不做事项 / Non-Goals

English: Do not build a path where `TrajectoryCollector`, `FailureAnalyzer`, `PatternMiner`, `OptimizerWorker`, idle evolution, or User Insight Engine writes directly to runtime files.

中文：不要建立让 `TrajectoryCollector`、`FailureAnalyzer`、`PatternMiner`、`OptimizerWorker`、空闲自进化或 User Insight Engine 直接写入运行时文件的路径。

English: Do not treat a higher benchmark score as sufficient approval for a scaffold patch. Benchmark（基准评测，用标准任务集比较系统能力） evidence is useful, but it does not replace safety review, product review, and rollback planning.

中文：不要把更高 benchmark（基准评测，用标准任务集比较系统能力）分数当作脚手架补丁的充分批准条件。基准证据有用，但不能替代安全审核、产品审核和回滚计划。

English: Do not expose raw trajectory payloads to third-party optimizers by default. External optimizer use requires an explicit export profile, documented retention behavior, and user approval when private content could leave the machine.

中文：不要默认把原始轨迹载荷暴露给第三方优化器。使用外部优化器必须有显式导出配置、已记录的保留行为，并且当私有内容可能离开本机时需要用户批准。

English: Do not create new Linear issues for every pattern, candidate, or review note. The free-plan cap means `QUI-12` should reuse comments and only create separate issues when independent ownership, blockers, or acceptance criteria are required.

中文：不要为每个模式、候选或审核备注都创建新的 Linear issue。免费版额度意味着 `QUI-12` 应复用 comment；只有需要独立负责人、阻塞关系或验收标准时才创建单独 issue。

## 最小验收 / Minimum Acceptance

English: This deferred plan is acceptable when it clearly separates `QUI-12` from `QUI-68`, defines the boundaries of `TrajectoryCollector`, `FailureAnalyzer`, optimizer worker, patch proposal, `WriteAuthority`, human review, idle evolution, and User Insight Engine, and records official source inputs.

中文：当本文清晰区分 `QUI-12` 与 `QUI-68`，定义 `TrajectoryCollector`、`FailureAnalyzer`、优化器 worker、补丁提案、`WriteAuthority`、人工审核、空闲自进化和 User Insight Engine 的边界，并记录官方来源输入时，本延后规划即达标。

English: A future implementation of `QUI-12` may start only after all reopen gates are satisfied and after reviewers can inspect proposal evidence without reading raw logs. Until then, `QUI-12` should remain open as the umbrella issue for the larger Iter F self-evolution runtime.

中文：未来 `QUI-12` 实现只有在所有重开门槛满足，并且审核者能在不阅读原始日志的情况下检查提案证据后，才可以启动。在此之前，`QUI-12` 应保持 open（打开）状态，作为更大 Iter F 自进化运行时的 umbrella issue（伞状总 issue）。

English: Documentation verification for this task is glossary lint, whitespace diff check, and line count. Runtime verification is intentionally deferred because this document defines boundaries and gates rather than adding executable code.

中文：本任务的文档验证是术语 lint、whitespace diff check（空白字符差异检查）和行数统计。运行时验证有意延后，因为本文定义边界与门槛，而不是新增可执行代码。
