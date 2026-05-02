# 对话工程重启门槛 / Conversation Engineering Restart Gate

> Scope: Linear `QUI-13`. Evidence checked on 2026-05-02 Asia/Shanghai. This document only defines when Conversation Engineering（对话工程，用上下文、记忆、行为约束和评估让 Agent 的表达更自然但不牺牲正确性）may restart from its parked research-note state. It does not implement runtime（运行时，即真实请求中会执行的代码路径）behavior, and it must not be used to mark the issue `Done`.
>
> 范围：Linear `QUI-13`。证据在 2026-05-02 Asia/Shanghai 校准。本文只定义 Conversation Engineering（对话工程，用上下文、记忆、行为约束和评估让 Agent 的表达更自然但不牺牲正确性）什么时候可以从 parked research note（暂缓研究笔记）状态重启。本文不实现 runtime（运行时，即真实请求中会执行的代码路径）行为，也不能被用来把 issue 标为 `Done`。

## 结论 / Decision

Conversation Engineering stays parked until the core loop（核心回路，Agent 接收输入、装配上下文、调用模型、使用工具、校验输出并回写状态的最小闭环）is stable and the surrounding component runtimes have local evidence. Benchmark（基准评测，用固定任务和评分规则比较系统能力）postconditions are no longer a restart gate because Benchmark is frozen and lowest priority. Restarting earlier would turn style into an unverified second control plane.

Conversation Engineering 继续保持 parked，直到 core loop（核心回路，Agent 接收输入、装配上下文、调用模型、使用工具、校验输出并回写状态的最小闭环）稳定，且相邻组件 runtime 有本地实证。Benchmark（基准评测，用固定任务和评分规则比较系统能力）后置条件不再是重启门槛，因为 Benchmark 已冻结并降为最低优先级。过早重启会把风格变成未验证的第二控制面。

When it restarts, it must enter the real ContextAssembler（上下文装配器，把系统规则、用户输入、记忆、工具结果和运行状态排布成模型输入的模块）and runtime behavior path. A prose-only personality note, prompt appendix, or “make it sound alive” instruction is not a restart.

重启时，它必须接入真实的 ContextAssembler（上下文装配器，把系统规则、用户输入、记忆、工具结果和运行状态排布成模型输入的模块）和 runtime behavior 路径。只有人格文案、prompt 附录，或“让它听起来更像真人”的指令，都不算重启。

## 当前状态 / Current State

The current submodule is a research note under `docs/02-context/conversation-engineering/README.md`. It contains useful design ideas, but it is intentionally not active product behavior. Its six layers are recipes, not committed runtime contracts.

当前子模块是 `docs/02-context/conversation-engineering/README.md` 下的 research note。它包含有价值的设计想法，但刻意不是已启用的产品行为。它的六层设计是配方，不是已承诺的 runtime 契约。

The host component is `02-context`. Context already owns prompt/session assembly, temporal awareness（时间感知，用当前时间、消息间隔和跨 session 时间线调整上下文）, memory bridge（记忆桥接，把 Memory 结果转成 Context 可消费结构）, injection scanning（注入扫描，识别把低可信内容伪装成高优先级指令的风险）, and token budgeting. Conversation Engineering must attach to those paths instead of bypassing them.

宿主组件是 `02-context`。Context 已经负责 prompt/session assembly、temporal awareness（时间感知，用当前时间、消息间隔和跨 session 时间线调整上下文）、memory bridge（记忆桥接，把 Memory 结果转成 Context 可消费结构）、injection scanning（注入扫描，识别把低可信内容伪装成高优先级指令的风险）和 token budgeting。Conversation Engineering 必须接入这些路径，而不是绕过它们。

`QUI-13` should remain open after this document. The issue represents a future runtime capability family: restart gate, integration design, implementation, tests, observability, and user-facing behavior validation. This file completes only the gate definition.

本文完成后，`QUI-13` 仍应保持 open。该 issue 代表未来的 runtime 能力族：重启门槛、集成设计、实现、测试、可观测性和用户侧行为验证。本文只完成门槛定义。

## 非目标 / Non-Goals

This work does not create a new persona layer. Persona（人格设定，即显式写给模型的角色或语气描述）can be one input, but it cannot own instruction priority, memory updates, tool permission, safety refusal, or factual claims.

本文不创建新的 persona layer。Persona（人格设定，即显式写给模型的角色或语气描述）可以是一个输入，但不能拥有指令优先级、记忆更新、工具权限、安全拒答或事实声明。

This work does not approve deliberate inaccuracy. “Human-like” language may use natural pacing, uncertainty, and selective detail, but it must not fabricate memories, hide evidence, weaken safety boundaries, or reduce task correctness.

本文不批准刻意不准确。“像真人”的语言可以使用自然节奏、不确定表达和选择性细节，但不得编造记忆、隐藏证据、削弱安全边界或降低任务正确性。

This work does not run public benchmarks now or later by default. Benchmark work is frozen unless the user explicitly asks; Conversation Engineering must rely on local component evidence and paired regression tests.

本文现在和默认后续都不运行公开 benchmark。除非用户明确要求，Benchmark 工作保持冻结；Conversation Engineering 必须依靠本地组件实证和成对回归测试。

## 重启门槛 / Restart Gates

Gate 1 is core-loop stability. The core loop must have a repeatable local run path, deterministic trace（可追踪记录，用机器可关联字段说明一次决策如何产生）identifiers, successful tool execution fixtures, safety classification, and recoverable error handling. Conversation Engineering cannot be restarted while the base loop is still changing its execution contract.

门槛 1 是 core-loop stability。核心回路必须具备可重复的本地运行路径、确定性 trace（可追踪记录，用机器可关联字段说明一次决策如何产生）标识、成功的工具执行 fixture（固定输入输出样例，用来验证行为没有漂移）、安全分类和可恢复错误处理。基础回路执行契约仍在漂移时，不得重启 Conversation Engineering。

Gate 2 is component runtime evidence. `01-llm-integration`, `02-context`, `03-memory`, `04-planning`, `05-tool`, `06-multi-agent`, `07-safety-guardrails`, `08-observability`, and `10-self-evolution` must each expose the local evidence that Conversation Engineering will depend on. The minimum evidence is not a README statement; it is passing fixtures, trace fields, or runtime tests.

门槛 2 是组件 runtime 实证。`01-llm-integration`、`02-context`、`03-memory`、`04-planning`、`05-tool`、`06-multi-agent`、`07-safety-guardrails`、`08-observability` 和 `10-self-evolution` 必须分别暴露 Conversation Engineering 会依赖的本地证据。最低证据不是 README 声明，而是通过的 fixture、trace 字段或 runtime 测试。

Gate 3 is Benchmark freeze compliance. GAIA（一个面向通用助理能力的基准评测，覆盖推理、检索和工具使用）, BFCL v4（Berkeley Function Calling Leaderboard 第四版，一个测试函数和工具调用能力的基准评测）, and the canceled coding benchmark replacement tracked by Linear `QUI-47` must not be used as restart gates or code targets unless the user explicitly asks for Benchmark work.

门槛 3 是 Benchmark 冻结合规。GAIA（一个面向通用助理能力的基准评测，覆盖推理、检索和工具使用）、BFCL v4（Berkeley Function Calling Leaderboard 第四版，一个测试函数和工具调用能力的基准评测），以及 Linear `QUI-47` 曾追踪且现已取消的替代编码 benchmark，都不得作为重启门槛或代码目标，除非用户明确要求 Benchmark 工作。

Gate 4 is safety precedence. `07-safety-guardrails` must be able to prove that style guidance is always lower priority than safety policy, project rules, explicit user instructions, tool permissions, and verified task evidence. A style rule that conflicts with those sources must be dropped or weakened, with the reason recorded.

门槛 4 是安全优先。`07-safety-guardrails` 必须证明风格指导永远低于安全策略、项目规则、明确用户指令、工具权限和已验证任务证据。与这些来源冲突的风格规则必须被丢弃或弱化，并记录原因。

Gate 5 is memory provenance. `03-memory` must provide user-profile signals with provenance（来源追踪，说明信息从哪里来、可信度如何）and revocation（撤销能力，允许删除或失效旧偏好）before any relationship-style adaptation becomes durable. A single message cannot silently become a permanent preference.

门槛 5 是记忆来源追踪。`03-memory` 必须提供带 provenance（来源追踪，说明信息从哪里来、可信度如何）和 revocation（撤销能力，允许删除或失效旧偏好）的用户画像信号，然后任何关系风格适配才能变成持久状态。单条消息不能静默变成永久偏好。

Gate 6 is observability. `08-observability` must be able to join each style decision to a run trace, prompt build, model request, safety decision, and evaluation sample. If a response feels better but correctness drops, the trace must show whether style placement caused the regression.

门槛 6 是可观测性。`08-observability` 必须能把每个风格决策关联到 run trace、prompt build、模型请求、安全决策和评测样例。如果回复“感觉更好”但正确性下降，trace 必须显示是否由风格排布导致回归。

## 重启后的必接路径 / Required Restart Path

The first runtime object should be `ConversationStyleSource`（对话风格来源，描述语气、节奏、关系状态和时间连续性的低优先级上下文输入）. It must carry source, confidence, expiry, safety classification, and whether the signal is session-only or durable.

第一个 runtime 对象应是 `ConversationStyleSource`（对话风格来源，描述语气、节奏、关系状态和时间连续性的低优先级上下文输入）。它必须携带来源、置信度、过期时间、安全分类，以及该信号是仅本 session 有效还是可持久化。

The second runtime object should be `ConversationPlacementDecision`（对话风格排布决策，说明哪些风格信号被放入模型输入、放在哪里、为什么）. Context must place it in a bounded low-authority section, below safety, developer/project rules, explicit user requirements, active task evidence, and tool results.

第二个 runtime 对象应是 `ConversationPlacementDecision`（对话风格排布决策，说明哪些风格信号被放入模型输入、放在哪里、为什么）。Context 必须把它放在有边界的低权威小节，低于安全、开发者或项目规则、明确用户需求、当前任务证据和工具结果。

The third runtime object should be `ConversationBehaviorTrace`（对话行为轨迹，记录风格输入如何影响输出但不泄露私密推理）. It should include selected style dimensions, rejected style dimensions, conflict reasons, model path, sampling knobs, post-processing decisions, and evaluation join keys.

第三个 runtime 对象应是 `ConversationBehaviorTrace`（对话行为轨迹，记录风格输入如何影响输出但不泄露私密推理）。它应包含被选择的风格维度、被拒绝的风格维度、冲突原因、模型路径、采样控制参数、后处理决策和评估关联键。

The runtime behavior must include a pre-generation gate and a post-generation check. The pre-generation gate decides what style guidance may enter the prompt. The post-generation check verifies that the output did not use style to hide uncertainty, invent memory, skip required evidence, or soften a required safety refusal.

Runtime behavior 必须包含生成前门槛和生成后检查。生成前门槛决定哪些风格指导可以进入 prompt。生成后检查验证输出没有用风格隐藏不确定性、编造记忆、跳过必要证据，或软化必要的安全拒答。

## Context Assembly 接入 / Context Assembly Integration

Context assembly must treat style as one source class, not as a hidden override. The selection pipeline should rank style sources after system rules, project rules, active user requirements, verified memory, tool outputs, and current task facts.

Context assembly 必须把风格视为一种来源类型，而不是隐藏覆盖层。选择流水线应把风格来源排在系统规则、项目规则、当前用户需求、已验证记忆、工具输出和当前任务事实之后。

The placement rule should be explicit: style may affect pacing, format density, warmth, pushback strength, and continuity references; style may not change truth conditions, permissions, citations, refusal boundaries, or evidence ordering.

排布规则必须明确：风格可以影响节奏、格式密度、温度、反驳力度和连续性引用；风格不得改变真假条件、权限、引用、安全拒答边界或证据排序。

The budget rule should be explicit. A style block has a token ceiling and must be the first optional block dropped under budget pressure unless the task is explicitly about conversational quality. Losing style is acceptable; losing safety, user requirements, or task evidence is not.

预算规则必须明确。风格块有 token 上限，并且在预算紧张时必须是第一个可选丢弃块，除非任务明确就是对话质量。丢失风格可以接受；丢失安全、用户需求或任务证据不可接受。

## Runtime Behavior 接入 / Runtime Behavior Integration

Runtime behavior must use measurable controls rather than vague prose. Examples include opening diversity cap, maximum filler frequency, allowed pushback level, response density target, continuity-reference eligibility, and refusal wording style.

Runtime behavior 必须使用可度量控制，而不是模糊文案。例如开头多样性上限、填充词最大频率、允许反驳力度、回复密度目标、连续性引用资格，以及拒答措辞风格。

Runtime behavior must be reversible. A session flag should disable Conversation Engineering without changing task logic, tool access, memory retrieval, or safety behavior. This is required for paired regression tests.

Runtime behavior 必须可逆。一个 session flag（会话级开关，用来开启或关闭某项运行行为）应能关闭 Conversation Engineering，同时不改变任务逻辑、工具访问、记忆检索或安全行为。这是成对回归测试的前提。

Runtime behavior must be auditable without reading raw private conversation text. The trace should record dimensions and reason codes, while sensitive user content stays redacted according to the observability redaction policy.

Runtime behavior 必须在不读取原始私密对话文本的情况下可审计。trace 应记录维度和原因码，而敏感用户内容按可观测性脱敏策略保持脱敏。

## 验收测试 / Acceptance Tests

Test 1 is paired correctness. Run the same task with Conversation Engineering off and on. The answer may differ in pacing or tone, but factual claims, citations, tool arguments, safety outcome, and final task result must remain equivalent.

测试 1 是成对正确性。用关闭和开启 Conversation Engineering 的方式运行同一任务。答案可以在节奏或语气上不同，但事实声明、引用、工具参数、安全结果和最终任务结果必须等价。

Test 2 is safety conflict. Inject a style source that asks for a warmer or more permissive answer while the task requires refusal or tool gating. The runtime must reject or weaken the style source and record the conflict reason.

测试 2 是安全冲突。注入一个要求更温和或更宽松回答的风格来源，同时任务需要拒答或工具权限门槛。Runtime 必须拒绝或弱化该风格来源，并记录冲突原因。

Test 3 is memory provenance. Provide a relationship hint with no Memory approval, then provide the same hint with an approved provenance receipt. The first run may use it only as session-local style; the second may use it according to the Memory expiry and revocation rules.

测试 3 是记忆来源追踪。先提供一个未经 Memory 批准的关系提示，再提供同一个带来源凭据的已批准提示。第一次运行最多只能把它当成 session-local style；第二次可以按 Memory 的过期和撤销规则使用。

Test 4 is budget pressure. Force the prompt builder below its normal token budget. The style block must shrink or disappear before safety rules, explicit user requirements, current task evidence, and required tool schemas are dropped.

测试 4 是预算压力。把 prompt builder 压到低于正常 token 预算。风格块必须在安全规则、明确用户需求、当前任务证据和必要工具 schema 被丢弃之前缩小或消失。

Test 5 is local paired regression. After the component gates pass, run local non-Benchmark fixtures and verify that enabling Conversation Engineering does not change factual correctness, tool arguments, safety outcome, provenance, or final task result.

测试 5 是本地成对回归。在组件门槛通过后，运行本地非 Benchmark fixture，并验证开启 Conversation Engineering 不会改变事实正确性、工具参数、安全结果、来源追踪或最终任务结果。

## Linear 关闭规则 / Linear Closure Rule

`QUI-13` should not be marked `Done` by this document. The issue can close only after the runtime objects exist, the ContextAssembler consumes them, the pre-generation and post-generation gates run in tests, observability joins are emitted, and paired correctness tests pass.

`QUI-13` 不应因为本文被标为 `Done`。只有 runtime 对象存在、ContextAssembler 消费它们、生成前与生成后门槛在测试中运行、可观测关联被输出，并且成对正确性测试通过后，该 issue 才能关闭。

The next useful Linear activity should be comments or child slices under the same issue until the free-plan issue budget allows a separate implementation split. New issues are not required for this gate document.

下一步有价值的 Linear 活动应是在同一个 issue 下继续用 comment 或子切片承接，直到免费版 issue 额度允许拆出独立实现项。本文这份门槛文档不需要新建 issue。

## 参考 / References

OpenAI Agents SDK（OpenAI Agents software development kit，用来构建可调用工具、携带上下文并可追踪运行过程的 Agent 开发包）documents local runtime context separately from model-visible context, and says additional information reaches the model through instructions, input, tools, retrieval, or web search. This supports the rule that Conversation Engineering must be placed through Context assembly rather than hidden runtime state.

OpenAI Agents SDK（OpenAI Agents software development kit，用来构建可调用工具、携带上下文并可追踪运行过程的 Agent 开发包）把本地 runtime context 和模型可见上下文分开，并说明额外信息通过 instructions、input、tools、retrieval 或 web search 进入模型。这支持本文规则：Conversation Engineering 必须通过 Context assembly 排布，而不是藏在 runtime 状态里。

Source: [OpenAI Agents SDK Context Management](https://openai.github.io/openai-agents-js/guides/context/).

来源：[OpenAI Agents SDK Context Management](https://openai.github.io/openai-agents-js/guides/context/)。

OpenAI’s Model Spec discussion treats behavior, personality, uncertainty, safety boundaries, and instruction hierarchy as separate concerns with different failure modes. This supports the rule that style must not override safety, authority, or correctness.

OpenAI 的 Model Spec 说明把行为、人格、不确定表达、安全边界和指令层级视为不同关注点，并且它们有不同失败模式。这支持本文规则：风格不得覆盖安全、权威或正确性。

Source: [Inside our approach to the Model Spec](https://openai.com/index/our-approach-to-the-model-spec/).

来源：[Inside our approach to the Model Spec](https://openai.com/index/our-approach-to-the-model-spec/)。

OpenAI’s context engineering cookbook emphasizes trimming, compression, focused context, tool-call accuracy, cost, latency, and observability for long-running multi-turn agents. This supports the rule that Conversation Engineering must wait for component runtime evidence and traceability.

OpenAI 的 context engineering cookbook 强调长多轮 Agent 中的裁剪、压缩、聚焦上下文、工具调用准确性、成本、延迟和可观测性。这支持本文规则：Conversation Engineering 必须等待组件 runtime 实证和可追踪性。

Source: [Context Engineering - Short-Term Memory Management with Sessions from OpenAI Agents SDK](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory).

来源：[Context Engineering - Short-Term Memory Management with Sessions from OpenAI Agents SDK](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory)。
