# 自进化前沿吸收 / Self-Evolution Frontier Assimilation

> Date: 2026-05-02 Asia/Shanghai. Linear: [QUI-58](https://linear.app/quilin-agent/issue/QUI-58/f0self-evolution-轨迹失败分析与-gepa-吸收决策-decide-self-evolution-trajectories), related to [QUI-68](https://linear.app/quilin-agent/issue/QUI-68/f1实现自进化-trajectorystorefailureanalyzer-与离线优化-implement-self-evolution) and [QUI-12](https://linear.app/quilin-agent/issue/QUI-12/iter-f实现-trajectory-to-patch-自进化闭环-implement-trajectory-to-patch-self).
>
> 日期：2026-05-02（Asia/Shanghai）。Linear： [QUI-58](https://linear.app/quilin-agent/issue/QUI-58/f0self-evolution-轨迹失败分析与-gepa-吸收决策-decide-self-evolution-trajectories)，关联 [QUI-68](https://linear.app/quilin-agent/issue/QUI-68/f1实现自进化-trajectorystorefailureanalyzer-与离线优化-implement-self-evolution) 与 [QUI-12](https://linear.app/quilin-agent/issue/QUI-12/iter-f实现-trajectory-to-patch-自进化闭环-implement-trajectory-to-patch-self)。

## 结论 / Verdict

Quilin's Self-Evolution plan remains directionally strong, but it is not yet the strongest implemented solution. The strongest 2026 shape is a proposal-only loop: TrajectoryStore（运行轨迹存储，用来持久化 Agent 输入、推理、工具调用、观测、成本和结果的事件仓库） feeds FailureAnalyzer（失败分析器，用来把失败轨迹归因到可修复类别的诊断层）, GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法） or DSPy（Declarative Self-improving Python，一个把 LLM（Large Language Model，大语言模型）程序拆成可评测模块并离线优化的框架） proposes prompt / skill / scaffold changes offline, local-eval-driven prompt and skill optimization（基于本地评测的提示词和技能优化，用固定本地数据集和指标比较候选版本） validates them, and human-reviewed patch proposals（人工审核补丁提案，即只生成 diff、证据和评测报告，由人类通过 PR（pull request，代码评审合入请求）或等价审批决定是否合入） remain the only path to runtime-affecting change.

Quilin 的 Self-Evolution（自进化）方案方向仍然强，但当前还不是“已实现的最强方案”。2026 年最强的形态应是 proposal-only loop（只提案闭环）：TrajectoryStore（运行轨迹存储，用来持久化 Agent 输入、推理、工具调用、观测、成本和结果的事件仓库）供给 FailureAnalyzer（失败分析器，用来把失败轨迹归因到可修复类别的诊断层）；GEPA（Genetic-Pareto，一种用自然语言反思和帕累托搜索优化文本参数的算法）或 DSPy（Declarative Self-improving Python，一个把 LLM（Large Language Model，大语言模型）程序拆成可评测模块并离线优化的框架）在线下提出 prompt / skill / scaffold 修改；local-eval-driven prompt and skill optimization（基于本地评测的提示词和技能优化，用固定本地数据集和指标比较候选版本）验证候选；human-reviewed patch proposals（人工审核补丁提案，即只生成 diff、证据和评测报告，由人类通过 PR（pull request，代码评审合入请求）或等价审批决定是否合入）仍是影响 runtime behavior（运行时行为）的唯一路径。

The important correction is that Quilin should not copy MiniMax M2.7's autonomous scaffold-code modification as a product behavior. MiniMax is the strongest evidence that trajectory-to-change loops can work, but Quilin's safer product advantage should be transparent offline optimization plus WriteAuthority（统一写权限门，用来裁决所有 Agent 发起写入的单一运行时 gate） plus human review.

关键修正是：Quilin 不应把 MiniMax M2.7 的自主 scaffold-code modification（脚手架代码修改）照搬成产品行为。MiniMax 是 trajectory-to-change loop（从轨迹到修改的闭环）可行的最强证据，但 Quilin 的更安全产品优势应是透明的 offline optimization（离线优化）+ WriteAuthority（统一写权限门，用来裁决所有 Agent 发起写入的单一运行时 gate）+ 人工审核。

Given the user's current priority, public Benchmark work is frozen and lowest priority. Self-Evolution should first absorb the strongest domain practices for trace capture, failure diagnosis, offline optimization, proposal review, and skill lifecycle; no Self-Evolution Iter may add or modify Benchmark code unless the user explicitly asks.

根据用户当前优先级，公开 Benchmark 工作已冻结并降为最低优先级。Self-Evolution 应先吸收轨迹采集、失败诊断、离线优化、提案审核和技能生命周期的领域最强实践；除非用户明确要求，任何 Self-Evolution Iter 都不得新增或修改 Benchmark 代码。

## 来源与可信度 / Sources And Confidence

GitHub stars below were checked with authenticated `gh repo view` on 2026-05-02. They are adoption signals, not design proof, because repository popularity can change and can lag technical quality.

下表 GitHub stars（星标数）于 2026-05-02 通过已认证的 `gh repo view` 检查。它们只是 adoption signal（采用度信号），不是设计正确性的证明，因为仓库热度会变化，也可能滞后于技术质量。

| Source | Links | Current signal | Confidence | What Quilin should absorb |
|---|---|---:|---|---|
| MiniMax M2.7 | [official news](https://www.minimax.io/news/minimax-m27-en), [model page](https://www.minimax.io/models/text/m27) | Official report: autonomous loop over 100+ rounds, 30% internal eval gain, 97% skill adherence across 40 complex skills | High for vendor claim; Medium for reproducibility | Keep the loop shape, not the automatic runtime write behavior |
| DSPy | [optimizer docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md), [repo](https://github.com/stanfordnlp/dspy) | 34,137 stars; optimizers include BootstrapFewShot（a DSPy optimizer that builds few-shot demonstrations from examples）, MIPROv2（a DSPy optimizer that uses Bayesian search over instructions and examples）, GEPA | High | Use module signatures, metrics, train/dev split, saveable optimized artifacts |
| GEPA | [paper](https://arxiv.org/abs/2507.19457), [repo](https://github.com/gepa-ai/gepa) | 4,160 stars; ICLR 2026 Oral paper claim: 35x fewer rollouts than GRPO（Group Relative Policy Optimization，一种强化学习优化方法） in reported tasks | High for method; Medium until Quilin reproduces locally | Treat trajectories and grader feedback as textual gradients for offline proposals |
| OpenAI Cookbook self-evolving agents | [cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining) | Official worked pattern: human review, LLM-as-judge（用另一个模型按 rubric 打分）, evals, rollback importance, GEPA adapter | High | Adopt eval-backed loop structure and rollback requirement |
| Langfuse | [overview](https://langfuse.com/docs), [datasets](https://langfuse.com/docs/evaluation/experiments/datasets), [repo](https://github.com/langfuse/langfuse) | 26,433 stars; traces, prompt management, datasets, experiments, OTel（OpenTelemetry，跨系统追踪、指标和日志标准） support | High | Use versioned datasets, trace-linked prompts, production trace to offline eval flow |
| Arize Phoenix | [docs](https://arize.com/docs/phoenix/), [repo](https://github.com/Arize-ai/phoenix) | 9,497 stars; OTel/OpenInference（LLM 应用遥测语义与工具生态） tracing, evals, datasets, span replay | High | Adopt span replay, trace-to-dataset, experiment comparison patterns |
| OpenTelemetry GenAI | [semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Development status; defines GenAI events, exceptions, metrics, model spans, agent spans, MCP（Model Context Protocol，模型与外部工具/服务连接协议） conventions | High for portability; Medium for stability | Make TrajectoryStore OTel-compatible but versioned behind Quilin schema |
| OpenHands | [agent architecture](https://docs.openhands.dev/sdk/arch/agent), [persistence](https://docs.openhands.dev/sdk/guides/convo-persistence), [GitHub Action](https://docs.openhands.dev/openhands/usage/run-openhands/github-action), [repo](https://github.com/OpenHands/OpenHands) | 72,471 stars; event-driven action/observation loop; persisted event files; PR review loop | High | Adopt event-sourced trajectories and PR-first human feedback loop |
| SWE-agent / mini-swe-agent | [trajectory docs](https://swe-agent.com/latest/usage/trajectories/), [SWE-agent repo](https://github.com/SWE-agent/SWE-agent), [mini-swe-agent repo](https://github.com/SWE-agent/mini-swe-agent) | 19,117 stars for SWE-agent; 4,136 for mini-swe-agent; trajectories can become demonstrations | High | Store reproducible trajectory, config, predictions, logs, and demo extraction metadata |
| Promptfoo | [getting started](https://www.promptfoo.dev/docs/getting-started/), [coding agent evals](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/), [repo](https://github.com/promptfoo/promptfoo) | 20,766 stars; agent evals, CI, assertions, cost/latency thresholds | High | Make prompt/skill changes testable as CI-friendly configs |
| OpenAI Evals | [repo](https://github.com/openai/evals) | 18,336 stars; framework and registry for LLM and LLM-system evals | High | Keep private eval sets for product behavior and public evals for comparable reporting |
| Voyager | [paper](https://arxiv.org/abs/2305.16291), [repo](https://github.com/MineDojo/Voyager) | 6,867 stars; skill library and lifelong task exploration | Medium-high | Use success trajectories to propose reusable skills, but route persistence through 13-skills |
| AutoSkill / SkillFlow | [AutoSkill arXiv](https://arxiv.org/abs/2603.01145), [SkillFlow arXiv](https://arxiv.org/abs/2604.17308) | 2026 preprints; SkillFlow reports skill evolution can improve or regress depending on model | Medium | Add skill-patch utility metrics and regression checks before any skill is trusted |

| 来源 | 链接 | 当前信号 | 可信度 | Quilin 应吸收什么 |
|---|---|---:|---|---|
| MiniMax M2.7 | [官方新闻](https://www.minimax.io/news/minimax-m27-en), [模型页](https://www.minimax.io/models/text/m27) | 官方报告：自主循环 100+ 轮、内部评测提升 30%、40 个复杂技能上 97% adherence（遵循率） | 对厂商声明为高；对可复现性为中 | 保留闭环形态，不保留自动写 runtime 的产品行为 |
| DSPy | [优化器文档](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md), [仓库](https://github.com/stanfordnlp/dspy) | 34,137 stars；优化器包含 BootstrapFewShot（从示例构造 few-shot demonstrations 的 DSPy 优化器）、MIPROv2（用贝叶斯搜索优化指令和示例的 DSPy 优化器）、GEPA | 高 | 使用模块签名、指标、训练/开发集切分、可保存优化产物 |
| GEPA | [论文](https://arxiv.org/abs/2507.19457), [仓库](https://github.com/gepa-ai/gepa) | 4,160 stars；ICLR 2026 Oral 论文报告在相关任务上比 GRPO（Group Relative Policy Optimization，一种强化学习优化方法）少用最高 35 倍 rollout | 对方法为高；在 Quilin 本地复现前为中 | 把轨迹与评分器反馈当作 textual gradients（文本梯度）生成离线提案 |
| OpenAI Cookbook self-evolving agents | [Cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining) | 官方可运行模式：human review、LLM-as-judge（用另一个模型按 rubric 打分）、evals、rollback 重要性、GEPA adapter | 高 | 采用评测驱动闭环结构与回滚要求 |
| Langfuse | [总览](https://langfuse.com/docs), [数据集](https://langfuse.com/docs/evaluation/experiments/datasets), [仓库](https://github.com/langfuse/langfuse) | 26,433 stars；trace、prompt management、datasets、experiments、OTel（OpenTelemetry，跨系统追踪、指标和日志标准）支持 | 高 | 使用版本化数据集、trace-linked prompts（与轨迹关联的提示词）、生产轨迹到离线评测流 |
| Arize Phoenix | [文档](https://arize.com/docs/phoenix/), [仓库](https://github.com/Arize-ai/phoenix) | 9,497 stars；OTel/OpenInference（LLM 应用遥测语义与工具生态） tracing、evals、datasets、span replay | 高 | 吸收 span replay、trace-to-dataset、experiment comparison（实验对比）模式 |
| OpenTelemetry GenAI | [语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Development status（开发中）；定义 GenAI events、exceptions、metrics、model spans、agent spans、MCP（Model Context Protocol，模型与外部工具/服务连接协议）conventions | 对可移植性为高；对稳定性为中 | 让 TrajectoryStore 兼容 OTel，但在 Quilin schema 后做版本封装 |
| OpenHands | [Agent 架构](https://docs.openhands.dev/sdk/arch/agent), [持久化](https://docs.openhands.dev/sdk/guides/convo-persistence), [GitHub Action](https://docs.openhands.dev/openhands/usage/run-openhands/github-action), [仓库](https://github.com/OpenHands/OpenHands) | 72,471 stars；event-driven action/observation loop（事件驱动的动作/观测循环）；持久化事件文件；PR review loop | 高 | 采用 event-sourced trajectories（事件溯源轨迹）和 PR-first 人工反馈闭环 |
| SWE-agent / mini-swe-agent | [轨迹文档](https://swe-agent.com/latest/usage/trajectories/), [SWE-agent 仓库](https://github.com/SWE-agent/SWE-agent), [mini-swe-agent 仓库](https://github.com/SWE-agent/mini-swe-agent) | SWE-agent 19,117 stars；mini-swe-agent 4,136 stars；轨迹可转成 demonstrations（示范样本） | 高 | 存储可复现 trajectory、config、predictions、logs 与 demo extraction metadata（示范提取元数据） |
| Promptfoo | [入门](https://www.promptfoo.dev/docs/getting-started/), [coding agent evals](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/), [仓库](https://github.com/promptfoo/promptfoo) | 20,766 stars；Agent evals、CI、assertions、cost/latency thresholds | 高 | 让 prompt/skill 变更可以用 CI-friendly configs（适合 CI 的配置）测试 |
| OpenAI Evals | [仓库](https://github.com/openai/evals) | 18,336 stars；LLM 与 LLM-system eval framework（评测框架）和 registry（注册表） | 高 | 保留私有 eval sets 衡量产品行为，公共 eval 用于可比较报告 |
| Voyager | [论文](https://arxiv.org/abs/2305.16291), [仓库](https://github.com/MineDojo/Voyager) | 6,867 stars；skill library（技能库）和 lifelong task exploration（持续任务探索） | 中高 | 用成功轨迹提出可复用技能，但持久化必须走 13-skills |
| AutoSkill / SkillFlow | [AutoSkill arXiv](https://arxiv.org/abs/2603.01145), [SkillFlow arXiv](https://arxiv.org/abs/2604.17308) | 2026 preprints（预印本）；SkillFlow 报告 skill evolution 可提升也可回退，取决于模型与任务 | 中 | 在任何技能被信任前加入 skill-patch utility metrics（技能补丁效用指标）和回归检查 |

## 当前差距 / Current Quilin Gap

Local evidence: `rg -n "TrajectoryStore|FailureAnalyzer|ScaffoldModifier|ABEvaluator|GEPA|MIPROv2|BootstrapFewShot" packages providers benchmarks` returned no matches on 2026-05-02, which means these are still spec-level or roadmap-level names outside docs. Positive foundations already exist: `WriteAuthority` is implemented in `packages/agent-core/src/safety/write-authority.ts`; `skill_manage` routes writes through `WriteAuthority`; memory consolidator tests show dry-run-only idle proposals; existing frozen benchmark submissions already carry score / cost / reasoning_trace fields in slices.

本地证据：2026-05-02 运行 `rg -n "TrajectoryStore|FailureAnalyzer|ScaffoldModifier|ABEvaluator|GEPA|MIPROv2|BootstrapFewShot" packages providers benchmarks` 没有命中，说明这些名字在代码层仍未落地，主要停留在 spec 或 roadmap。正向基础已经存在：`WriteAuthority` 已在 `packages/agent-core/src/safety/write-authority.ts` 实现；`skill_manage` 的写入会经过 `WriteAuthority`；memory consolidator 测试显示 idle proposal（空闲提案）仅 dry-run；既有且已冻结的 benchmark submission 切片已经携带 score / cost / reasoning_trace 字段。

| Area | Current Quilin state | Gap against frontier |
|---|---|---|
| TrajectoryStore | README defines event schema; observability and benchmark traces exist in separate slices | No unified event-sourced trajectory store with replay, OTel mapping, privacy redaction, dataset export, and retention policy |
| FailureAnalyzer | README lists categories and aggregation idea | No executable analyzer, no rubric-backed failure taxonomy, no confidence calibration, no cross-run pattern store |
| GEPA/DSPy offline optimization | Listed as Iter F candidate; no code wrapper found | No adapter that converts Quilin traces + evaluator feedback into GEPA/DSPy train/dev sets and optimized artifacts |
| Local-eval-driven prompt / skill optimization | Existing Benchmark harness code is frozen; local component evidence is active | No small local self-evolution eval pack for prompt/skill proposals; no dataset versioning or candidate comparison table |
| Human-reviewed patch proposals | Safety docs and WriteAuthority say scaffold patch is critical and future | No proposal artifact schema, PR template, reviewer decision state, or scaffold_patch gate implementation |
| Avoid automatic runtime code modification | Core README decision is correct; Self-Evolution README still contains stale pseudo-code comments that label Level 1/2 modifications as automatic | Need to reconcile wording so every scaffold-impacting proposal is review-only and never auto-applied |
| Skill self-evolution | 13-skills has `skill_manage`, guards, CRUD, catalog, hot loading | 10-self-evolution has no implemented extractor that creates skill drafts from success trajectories and sends them through 13-skills only |

| 领域 | Quilin 当前状态 | 与前沿差距 |
|---|---|---|
| TrajectoryStore | README 定义事件 schema；observability 与 benchmark trace 分散存在 | 尚无统一的 event-sourced trajectory store，缺 replay、OTel 映射、隐私脱敏、dataset export（数据集导出）与 retention policy（保留策略） |
| FailureAnalyzer | README 列出类别与聚合思路 | 尚无可执行分析器、rubric-backed failure taxonomy（由评分规则支撑的失败分类）、置信度校准、跨运行模式库 |
| GEPA/DSPy offline optimization | 被列为 Iter F 候选；代码中未找到 wrapper | 尚无把 Quilin trace + evaluator feedback 转成 GEPA/DSPy train/dev set 与优化产物的 adapter |
| 基于本地评测的提示词/技能优化 | 既有 Benchmark harness 代码已冻结；活跃方向是本地组件实证 | 尚无小型本地 self-evolution eval pack（自进化评测包）来评估 prompt/skill proposal；缺数据集版本与候选对比表 |
| 人工审核补丁提案 | Safety docs 与 WriteAuthority 将 scaffold patch 设为 critical future path | 尚无 proposal artifact schema（提案产物结构）、PR template（PR 模板）、reviewer decision state（审核状态）或 scaffold_patch gate 实现 |
| 避免自动修改 runtime code | Core README 决策正确；Self-Evolution README 的伪代码注释仍把 Level 1/2 写成 automatic（自动） | 需要统一措辞，确保所有影响 scaffold 的提案都是 review-only（只审核后合入），绝不自动应用 |
| Skill self-evolution | 13-skills 已有 `skill_manage`、guards、CRUD、catalog 与 hot loading | 10-self-evolution 尚无从成功轨迹提取 skill draft 并且只通过 13-skills 持久化的 extractor |

## 推荐内化 / Recommended Assimilation

### Must / 必须

1. Implement a TrajectoryStore MVP as an append-only event log with schema version, run id, parent trace id, event type, actor, tool/action name, input hash, output hash, redaction state, score/cost fields, and artifact pointers. It should store full sensitive payloads only behind local retention and redaction controls, while exporting a sanitized dataset view for optimization.

1. 实现 TrajectoryStore MVP（最小可用版本）为 append-only event log（只追加事件日志），字段包含 schema version、run id、parent trace id、event type、actor、tool/action name、input hash、output hash、redaction state、score/cost fields 和 artifact pointers。完整敏感 payload 只应保存在本地 retention（保留）与 redaction（脱敏）控制后面；离线优化只导出 sanitized dataset view（已脱敏数据集视图）。

2. Define FailureAnalyzer output as a typed diagnostic record: failure category, failing event range, direct evidence, counterfactual expected behavior, proposed change target, confidence, evaluator references, and "no proposal" reason. This prevents LLM diagnosis from becoming unverifiable prose.

2. 把 FailureAnalyzer 输出定义成 typed diagnostic record（类型化诊断记录）：failure category、failing event range、direct evidence、counterfactual expected behavior、proposed change target、confidence、evaluator references 与 "no proposal" reason。这样可以避免 LLM 诊断变成不可验证的散文。

3. Treat GEPA/DSPy as offline workers, not runtime dependencies. The worker should consume frozen train/dev datasets, emit candidate prompt/skill/scaffold artifacts, include full evaluator scores, and never write into `packages/`, `providers/`, `docs/`, or skill roots directly.

3. 将 GEPA/DSPy 视为 offline workers（离线 worker），不要作为 runtime dependency（运行时依赖）。worker 应消费冻结的 train/dev datasets（训练/开发集），输出候选 prompt/skill/scaffold 产物和完整 evaluator scores，且绝不直接写入 `packages/`、`providers/`、`docs/` 或 skill roots。

4. Add a proposal artifact schema before implementation: `proposal_id`, source trajectories, failure pattern, candidate diff, optimizer provenance, eval matrix, regression summary, risk level, WriteAuthority decision, reviewer decision, and rollback instructions.

4. 实现前先加入 proposal artifact schema（提案产物结构）：`proposal_id`、source trajectories、failure pattern、candidate diff、optimizer provenance（优化器来源记录）、eval matrix、regression summary、risk level、WriteAuthority decision、reviewer decision 与 rollback instructions。

5. Make every scaffold-impacting proposal `riskLevel:"critical"` and `origin:"agent"` or `origin:"idle"` before a future `scaffold_patch` tool can exist. `origin:"idle"` must remain denied unless the session explicitly opts into auto trust, and even then critical changes must confirm.

5. 任何影响 scaffold 的 proposal 在未来 `scaffold_patch` tool 存在前，都必须标成 `riskLevel:"critical"`，并带 `origin:"agent"` 或 `origin:"idle"`。`origin:"idle"` 在 session 明确 opt-in auto trust 前必须保持 deny；即使 opt-in，critical 变更也必须 confirm。

### Should / 应该

1. Align TrajectoryStore with OpenTelemetry GenAI but do not depend on unstable OTel field names as the internal canonical schema. Use a Quilin schema and maintain an exporter to OTel / OpenInference-style spans.

1. TrajectoryStore 应兼容 OpenTelemetry GenAI，但不要把仍在变化的 OTel 字段名当成内部 canonical schema（规范结构）。应使用 Quilin 自己的 schema，并维护到 OTel / OpenInference-style spans 的 exporter。

2. Borrow OpenHands' persisted event-file pattern for granular access: one event file per sequence step or one SQLite row per event, plus a conversation/run manifest. This improves replay and avoids monolithic JSON trajectory files becoming slow.

2. 借鉴 OpenHands 的 persisted event-file pattern（持久化事件文件模式）以获得细粒度访问：每个 sequence step 一个事件文件，或 SQLite 每事件一行，再加 conversation/run manifest。这样有利于 replay（回放），也避免单个巨大 JSON trajectory 文件变慢。

3. Use SWE-agent's reproducibility bundle pattern: every optimization run should include config, logs, predictions/proposals, exit statuses, and exact evaluator versions.

3. 借鉴 SWE-agent 的 reproducibility bundle（可复现包）模式：每次优化运行都应包含 config、logs、predictions/proposals、exit statuses 与精确 evaluator versions。

4. Build a small self-evolution local eval pack and do not connect public benchmarks unless the user explicitly asks. It should include 20-50 tasks from Quilin's own workflows: research, docs, coding, skill extraction, safety refusal, and tool-choice failure cases.

4. 构建小型 self-evolution local eval pack（本地自进化评测包）；除非用户明确要求，不接入公共 benchmark。它应包含 Quilin 自身 workflow 的 20-50 个任务：research、docs、coding、skill extraction、safety refusal 与 tool-choice failure cases。

5. Add skill-patch utility metrics: success-rate delta, misuse-rate delta, token/cost delta, retrieval precision, and regression count. SkillFlow shows high skill usage can still fail to improve task success, so "used skill" is not enough.

5. 增加 skill-patch utility metrics（技能补丁效用指标）：success-rate delta、misuse-rate delta、token/cost delta、retrieval precision 与 regression count。SkillFlow 显示高技能使用率不一定提高任务成功率，所以“用了技能”本身不足以证明价值。

6. Update the stale automatic-modification wording in the Self-Evolution README when QUI-58 moves from decision to spec cleanup. The architectural rule should be: automated generation is allowed; automated application to runtime behavior is not.

6. 当 QUI-58 从决策进入 spec cleanup（规格清理）时，更新 Self-Evolution README 中陈旧的 automatic-modification wording（自动修改措辞）。架构规则应是：允许 automated generation（自动生成），不允许 automated application to runtime behavior（自动应用到运行时行为）。

### Could / 可以

1. Add a `TrajectoryDatasetBuilder` that turns failure clusters into Langfuse/Phoenix-style datasets and stores exact dataset versions for reproducible offline runs.

1. 增加 `TrajectoryDatasetBuilder`，把 failure clusters（失败聚类）转成 Langfuse/Phoenix-style datasets，并保存精确 dataset versions，支持可复现离线运行。

2. Add an optimizer comparison harness with `static_metaprompt`, `DSPy.MIPROv2`, `DSPy.BootstrapFewShot`, and `GEPA` candidates on the same frozen dataset. Keep the cheapest deterministic baseline so gains are attributable.

2. 增加 optimizer comparison harness（优化器对比 harness），在同一个冻结数据集上比较 `static_metaprompt`、`DSPy.MIPROv2`、`DSPy.BootstrapFewShot` 与 `GEPA` 候选。保留最便宜的 deterministic baseline（确定性基线），让收益可归因。

3. Add a trace visualizer later, but only after the artifact schema stabilizes. OpenHands has a trajectory visualizer, but Quilin should first make data complete and replayable.

3. 后续可以加入 trace visualizer（轨迹可视化器），但应等 artifact schema 稳定之后。OpenHands 已有 trajectory visualizer；Quilin 应先确保数据完整且可回放。

4. Mirror accepted proposals into `docs/10-self-evolution/fusion-index.md` after human review, keeping rejected proposals as Linear comments rather than docs truth.

4. 对通过人工审核的 proposal，可再同步到 `docs/10-self-evolution/fusion-index.md`；被拒绝的 proposal 应留在 Linear comment，而不是写成 docs truth（文档真相）。

## Linear 映射 / Linear Mapping

| Recommendation | Primary issue | Secondary issue | Notes |
|---|---|---|---|
| F0 decision, source evidence, README wording cleanup | QUI-58 | QUI-12 | This document is the evidence artifact; wording cleanup can be a QUI-58 follow-up comment |
| TrajectoryStore + FailureAnalyzer implementation | QUI-68 | QUI-12 | QUI-68 is already blocked by QUI-58 and has the right acceptance criteria |
| GEPA/DSPy offline worker and optimizer comparison | QUI-68 | QUI-12 | Keep as offline proposal generator; no direct writes |
| Human-reviewed proposal artifact and `scaffold_patch` gate | QUI-68 | QUI-12 / 07-safety docs | Needs WriteAuthority integration before any write path exists |
| Skill extraction from success trajectories | QUI-68 | QUI-22 | 10-self-evolution extracts drafts; 13-skills persists through `skill_manage` |
| Public Benchmark dependency and coding target | QUI-47 | QUI-68 | Frozen/canceled; use local eval pack only unless the user explicitly asks for Benchmark work |

| 建议 | 主 issue | 次 issue | 说明 |
|---|---|---|---|
| F0 决策、来源证据、README 措辞清理 | QUI-58 | QUI-12 | 本文是 evidence artifact（证据产物）；措辞清理可作为 QUI-58 后续 comment |
| TrajectoryStore + FailureAnalyzer 实现 | QUI-68 | QUI-12 | QUI-68 已被 QUI-58 阻塞，且验收标准匹配 |
| GEPA/DSPy 离线 worker 与优化器对比 | QUI-68 | QUI-12 | 只作为离线 proposal generator（提案生成器）；不直接写入 |
| 人工审核 proposal artifact 与 `scaffold_patch` gate | QUI-68 | QUI-12 / 07-safety docs | 任何写路径存在前必须先接入 WriteAuthority |
| 从成功轨迹提取 skill | QUI-68 | QUI-22 | 10-self-evolution 只提取 draft；13-skills 通过 `skill_manage` 持久化 |
| 公共 Benchmark 依赖与 coding target | QUI-47 | QUI-68 | 已冻结/取消；除非用户明确要求 Benchmark 工作，只使用本地评测包 |

## 推荐 F1 形态 / Recommended F1 Shape

The F1 implementation should start with four non-invasive components: `TrajectoryStore`, `FailureAnalyzer`, `ProposalStore`, and `OfflineOptimizerWorker`. The first three can be TypeScript-first because they sit near the agent core, safety, skills, and local evaluation artifacts. The optimizer worker can be Python-first through MCP because DSPy/GEPA are Python-native.

F1 实现应从四个非侵入组件开始：`TrajectoryStore`、`FailureAnalyzer`、`ProposalStore` 与 `OfflineOptimizerWorker`。前三者可 TypeScript-first，因为它们靠近 agent core、safety、skills 与本地评测产物。optimizer worker 可 Python-first 并通过 MCP 接入，因为 DSPy/GEPA 原生在 Python 生态。

The first loop should be intentionally boring: record a run, mark a failure, generate a diagnostic record, select a frozen local eval dataset, run one cheap baseline plus one optimizer candidate, produce a patch proposal, and stop. The success criterion is not automatic improvement; it is an auditable artifact that a reviewer can accept or reject without rerunning the whole investigation.

第一版闭环应刻意保持朴素：记录一次 run，标记一次 failure，生成 diagnostic record，选择冻结的本地 eval dataset，运行一个便宜 baseline 和一个 optimizer candidate，产出 patch proposal，然后停止。成功标准不是自动改好，而是生成 reviewer 不必重跑完整调查也能接受或拒绝的 auditable artifact（可审计产物）。

## 不应内化 / Do Not Assimilate

Do not add a path where GEPA, DSPy, FailureAnalyzer, idle evolution, or any future scaffold modifier directly edits runtime code. This includes apparently low-risk prompt or skill changes, because they can still create silent behavior drift.

不要加入让 GEPA、DSPy、FailureAnalyzer、idle evolution 或任何未来 scaffold modifier 直接编辑 runtime code 的路径。这也包括看似低风险的 prompt 或 skill 修改，因为它们仍可能造成 silent behavior drift（用户无感的行为漂移）。

Do not optimize against public benchmarks. Public Benchmark work is frozen unless the user explicitly asks, and Self-Evolution needs a local product-fit dataset that catches Quilin-specific safety gates, documentation rules, bilingual requirements, skill lifecycle behavior, and collaboration protocol behavior.

不要面向公共 benchmark 优化。除非用户明确要求，公共 Benchmark 工作已冻结；Self-Evolution 需要 local product-fit dataset（本地产品适配数据集），覆盖 Quilin 特有的 safety gates、文档规则、中英双语要求、技能生命周期行为和协作协议行为。

Do not treat LLM-as-a-judge（用另一个模型按 rubric 打分） as ground truth. It is a fast signal for triage, but every proposal should carry deterministic checks where possible, human review state, and a rollback path.

不要把 LLM-as-a-judge（用另一个模型按 rubric 打分）当成 ground truth（绝对真值）。它是快速 triage signal（分诊信号），但每个 proposal 都应尽可能携带 deterministic checks（确定性检查）、human review state 与 rollback path。
