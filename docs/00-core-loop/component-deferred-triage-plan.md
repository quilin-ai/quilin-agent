# 组件延后工作分流规则 / Component Deferred-Work Triage Rules

Planning timestamp: 2026-05-02 Asia/Shanghai workspace time. Linear（the internal issue tracker used as Quilin's task and execution record source）record: `QUI-45`. This document creates no new Linear issue and does not modify `agent-bridge.md`（the Claude Code and Codex collaboration protocol file）.

规划时间：2026-05-02（工作区 Asia/Shanghai 时间）。Linear（Quilin 用作任务与执行记录源的内部 issue 追踪系统）记录：`QUI-45`。本文不创建新的 Linear issue，也不修改 `agent-bridge.md`（Claude Code 与 Codex 的协作协议文件）。

## 目标 / Goal

The goal is to define how component-level deferred work is triaged after the old docs backlog was migrated into Linear. Deferred work means planned work that is real enough to preserve, but not yet active enough to consume an implementation slot, a new project, or a new issue.

目标是定义旧 docs backlog 迁移到 Linear 后，组件级延后工作如何分流。Deferred work（延后工作）指值得保留、但尚未活跃到需要占用实现切片、新 project（项目）或新 issue 的计划工作。

This document is a rulebook, not a live task board. Linear remains the live source for status, owner, blocker, and project placement; this file records the triage criteria that agents should apply before changing Linear.

本文是规则书，不是实时任务看板。Linear 仍然是 status（状态）、owner（负责人）、blocker（阻塞关系）和 project placement（项目归属）的实时来源；本文只记录 agent 在改动 Linear 前应使用的分流标准。

## 输入范围 / Input Scope

The current component backlog lane is represented by `QUI-14` through `QUI-22`, covering LLM Integration, Context, Memory, Planning, Tools, Safety, Observability, Runtime, and Skills. The Iter F（the future scale-out iteration governed by local runtime evidence）lane is represented by `QUI-9` through `QUI-13`. The roadmap lane is represented by `QUI-44`, `QUI-45`, and `QUI-46`.

当前 component backlog（组件积压）通道由 `QUI-14` 到 `QUI-22` 表示，覆盖 LLM Integration、Context、Memory、Planning、Tools、Safety、Observability、Runtime 和 Skills。Iter F（由本地 runtime 实证治理的未来规模化迭代）通道由 `QUI-9` 到 `QUI-13` 表示。路线图通道由 `QUI-44`、`QUI-45` 和 `QUI-46` 表示。

This scope intentionally excludes active F0/F1 execution issues such as frontier-assimilation decisions, runtime implementation slices, and verification baselines. Those issues can be related to backlog items, but they should not be replaced by the backlog issue itself.

该范围刻意排除活跃 F0/F1 执行 issue，例如前沿吸收决策、运行时实现切片和验证基线。这些 issue 可以关联到 backlog 条目，但不应被 backlog issue 本身替代。

## 分流原则 / Triage Principles

A backlog issue should stay open when it still represents a capability family that is larger than the current implementation slice. Capability family means a coherent area such as provider control, context compression, memory evaluation, safety threat modeling, or observability backend work.

当一个 backlog issue 仍代表比当前实现切片更大的能力族时，它应保持 open。Capability family（能力族）指 provider 控制、上下文压缩、记忆评测、安全威胁模型或可观测后端工作这类连贯领域。

A backlog issue should be promoted into an outcome project only when there is enough evidence to define a concrete outcome, acceptance criteria, dependencies, and owner boundary. Outcome project means a Linear project organized around a user-visible or system-visible result rather than a loose component category.

只有当已有足够证据定义具体结果、验收标准、依赖关系和负责人边界时，backlog issue 才应提升到 outcome project（以结果为目标的项目）。Outcome project 指围绕用户可见或系统可见结果组织的 Linear 项目，而不是松散的组件分类。

A follow-up should stay as a comment when it is a note, probe, research result, subagent log, review finding, or small refinement under an existing owner. Comment-only follow-up means the work is recorded in Linear without consuming another issue number.

当后续只是 note（备注）、probe（调研记录）、research result（调研结果）、subagent log（子 agent 日志）、review finding（复核发现）或既有 owner 下的小改进时，它应只写 comment。Comment-only follow-up（仅评论后续）指工作记录在 Linear 里，但不消耗新的 issue 编号。

## 免费额度纪律 / Free-Plan Budget Discipline

The Linear workspace is on the free plan with a 250-issue cap. Treat issue numbers as scarce: prefer comments, related links, and existing issue descriptions before creating anything new.

当前 Linear workspace 使用免费版，最多 250 个 issue。必须把 issue 编号视作稀缺资源：新建任何条目前，优先使用 comment、related link（关联链接）和既有 issue 描述。

At fewer than 200 issues, agents may still create a new issue when the promotion criteria are met. At 200 issues, agents must ask the user before bulk creation. At 225 issues, agents must stop creating new issues unless the user explicitly approves the specific new issue.

当 issue 少于 200 个时，agent 仍可在满足提升标准时新建 issue。达到 200 个 issue 后，批量创建前必须询问用户。达到 225 个 issue 后，除非用户明确批准某个具体新 issue，否则 agent 必须停止新建。

No agent should create an issue just to show activity. Execution logs, idle exploration, cross-review, competitor issue intake, and architecture/performance notes should default to comments on existing issues plus bilingual docs when the output is research-like.

任何 agent 都不应为了展示活跃而新建 issue。执行日志、空闲探索、交叉 review、竞品 issue 吸收，以及架构/性能笔记，默认应写到既有 issue 的 comment；如果输出属于调研类，还要写入中英双语 docs。

## 提升到 Outcome Project 的标准 / Promotion Criteria

Promote a backlog item when it has a measurable result. Examples include "local MeshClient can exchange Agent Cards with a peer process", "observability dashboard can answer a failed-run question without raw-log reading", or "memory evaluator can score a fixed local fixture and emit normalized reports".

当 backlog 条目拥有可衡量结果时，才提升它。例如：“本机 MeshClient 能与同伴进程交换 Agent Card（Agent 能力说明卡）”、“可观测仪表盘能在不读原始日志的情况下回答失败运行问题”，或“记忆评测器能对固定本地 fixture（测试样例）打分并输出标准化报告”。

Promote when the work crosses at least two components and needs coordinated delivery. Cross-component work means the acceptance path depends on multiple owners, such as Tools plus Deployment for sandbox lifecycle, Observability plus local trace review for runtime evidence, or Self-Evolution plus Safety plus Skills for human-reviewed scaffold proposals. Do not promote Benchmark work unless the user explicitly asks.

当工作跨越至少两个组件且需要协调交付时，才提升它。Cross-component work（跨组件工作）指验收路径依赖多个 owner，例如 Tools 与 Deployment 共同负责 sandbox 生命周期，Observability 与本地 trace review 共同负责 runtime evidence（运行时实证），或 Self-Evolution、Safety、Skills 共同负责人工审核的 scaffold proposal（脚手架提案）。除非用户明确要求，不要提升 Benchmark 工作。

Promote when blockers or sequencing would be lost inside a comment thread. If a future task has a real blocked-by relationship, release gate, owner handoff, or visible delivery milestone, it deserves an issue or project rather than another comment.

当 blocker（阻塞关系）或先后顺序会淹没在 comment thread（评论串）里时，才提升它。如果未来任务有真实 blocked-by 关系、发布门槛、负责人交接或可见交付里程碑，它就应使用 issue 或 project，而不是继续写 comment。

Do not promote merely because a component has many notes. Many notes under one capability family are a signal to summarize the comments into a bilingual component plan first; only the resulting concrete outcome should become a project.

不要只因为某个组件备注很多就提升。一个能力族下有很多备注，首先说明应把 comment 汇总成中英双语组件规划；只有汇总后形成的具体结果才应变成 project。

## 只写 Comment 的标准 / Comment-Only Criteria

Use comments for single-agent status updates, validation logs, line counts, and subagent handoff notes. These records explain what happened but do not create independent ownership.

单 agent 状态更新、验证日志、行数和 subagent handoff（子 agent 交接）备注应写 comment。这些记录用于说明发生了什么，但不创建独立权属。

Use comments for evidence that strengthens an existing issue but does not change its acceptance criteria. Examples include a new upstream link, a small competitor issue finding, a frozen Benchmark caveat, or a docs/process reminder.

能强化既有 issue、但不改变验收标准的证据应写 comment。例如新的上游链接、小型竞品 issue 发现、已冻结的 Benchmark 注意事项，或 docs/process 提醒。

Use comments for deferred implementation ideas when the component already has an open backlog issue. For example, a new LLM provider fallback idea belongs on `QUI-14` unless it has a separate owner, blocker, or release gate.

当组件已经有 open backlog issue 时，延后实现想法应写 comment。例如新的 LLM provider fallback（模型供应商降级）想法默认写到 `QUI-14`，除非它有独立负责人、阻塞关系或发布门槛。

Use comments for idle exploration unless it produces a reviewed research artifact. If exploration produces a reusable decision, write the result into the relevant component docs and link that doc from the existing issue.

空闲探索默认写 comment，除非它产出已审核的调研 artifact（产物）。如果探索产出可复用决策，应把结果写入相关组件 docs，并在既有 issue 中链接该文档。

## 关闭或保持 Open 的标准 / Close Or Keep-Open Criteria

Close a backlog issue only when every item in its capability family has either landed, been explicitly rejected, or moved to a more precise open issue/project. Closing must include evidence: linked docs, validation commands, commit hashes when code landed, and the target issue that now owns any remaining work.

只有当某个能力族内的全部条目都已经落地、被明确拒绝，或迁移到更精确的 open issue/project 时，才能关闭 backlog issue。关闭时必须带证据：链接文档、验证命令、代码落地时的 commit hash，以及现在承接剩余工作的目标 issue。

Keep a backlog issue open when it still protects a future decision boundary. A decision boundary means a choice that should not be made before more implementation, local runtime, or user-workflow evidence exists. Benchmark evidence must not be required unless the user explicitly asks.

当 backlog issue 仍保护未来决策边界时，应保持 open。Decision boundary（决策边界）指必须等更多实现、本地 runtime（运行时）或用户工作流证据存在后才能做的选择。除非用户明确要求，不得把 Benchmark 实证设为必需条件。

Keep a roadmap issue open when its trigger has not fired. For example, `QUI-44` should stay open until local runtime evidence justifies Iter F scale-out, and `QUI-46` should stay open until Iter F evidence exists.

当 roadmap issue（路线图 issue）的触发条件尚未满足时，应保持 open。例如，`QUI-44` 应保持 open，直到本地 runtime 实证足以启动 Iter F 规模化；`QUI-46` 应保持 open，直到 Iter F 实证存在。

Do not reopen a closed backlog issue just because a related idea appears. Reopen only if the closure evidence was wrong or if the remaining work cannot be represented by comments or a more precise existing issue.

不要只因为出现相关想法就重开已关闭 backlog issue。只有当关闭证据错误，或剩余工作无法由 comment 或更精确的既有 issue 表达时，才重开。

## 当前保持 Open 的 Issue / Issues That Should Stay Open

Based on the 2026-05-02 Linear snapshot, `QUI-9`, `QUI-10`, `QUI-11`, `QUI-12`, and `QUI-13` should remain open because they represent Iter F scale-out capability families whose triggers depend on local runtime stabilization evidence. Benchmark is frozen and must not be used as the trigger.

基于 2026-05-02 的 Linear 快照，`QUI-9`、`QUI-10`、`QUI-11`、`QUI-12` 和 `QUI-13` 应保持 open，因为它们代表 Iter F 规模化能力族，其触发依赖本地 runtime 稳定实证。Benchmark 已冻结，不得作为触发条件。

Based on the same snapshot, `QUI-14`, `QUI-15`, `QUI-16`, `QUI-17`, `QUI-19`, `QUI-20`, and `QUI-22` should remain open because each still represents a component capability family with work beyond current F0/F1 slices.

基于同一快照，`QUI-14`、`QUI-15`、`QUI-16`、`QUI-17`、`QUI-19`、`QUI-20` 和 `QUI-22` 应保持 open，因为每个 issue 仍代表一个超出当前 F0/F1 切片的组件能力族。

`QUI-44`, `QUI-45`, and `QUI-46` should remain open as roadmap governance issues. `QUI-44` governs the eventual Iter F launch, `QUI-45` governs component deferred-work triage, and `QUI-46` prevents premature Iter G（the hypothetical post-Iter-F iteration）scope definition.

`QUI-44`、`QUI-45` 和 `QUI-46` 应作为路线图治理 issue 保持 open。`QUI-44` 负责未来 Iter F 启动，`QUI-45` 负责组件延后工作分流，`QUI-46` 防止过早定义 Iter G（假设中的 Iter F 后续迭代）范围。

`QUI-18` and `QUI-21` were observed as Done in the 2026-05-02 snapshot. They should not be reopened by default; follow-up sandbox, browser, runtime packaging, and lifecycle notes should first map to `QUI-52`, `QUI-62`, `QUI-77`, or comments on `QUI-18`/`QUI-21`, depending on ownership.

在 2026-05-02 快照中，`QUI-18` 和 `QUI-21` 已处于 Done。默认不应重开它们；sandbox、browser、runtime packaging（运行时打包）和生命周期后续备注，应按权属优先映射到 `QUI-52`、`QUI-62`、`QUI-77`，或写到 `QUI-18`/`QUI-21` 的 comment。

## 组件映射规则 / Component Mapping Rules

For LLM Integration, `QUI-14` stays open until provider live matrix, fallback, retry, reasoning carry-over, local adapter, and streaming token accounting have either landed or been delegated to narrower outcome issues.

对 LLM Integration，`QUI-14` 应保持 open，直到 provider live matrix（供应商在线验证矩阵）、fallback、retry、reasoning carry-over（推理上下文延续）、本地 adapter（适配器）和 streaming token accounting（流式 token 计数）已落地，或已转交给更窄的 outcome issue。

For Context, `QUI-15` stays open until relevance selection, compression, runtime delta channel, and Conversation Engineering dependency handling are either landed or rejected with evidence.

对 Context，`QUI-15` 应保持 open，直到 relevance selection（相关性选择）、compression（压缩）、runtime delta channel（运行时增量通道）和 Conversation Engineering 依赖处理已落地，或基于证据被拒绝。

For Memory, `QUI-16` and `QUI-11` stay open because the L3a observer path, long-memory evaluation expansion, archival policy, and production idle-evolution gates remain broader than the current memory runtime implementation plan.

对 Memory，`QUI-16` 和 `QUI-11` 应保持 open，因为 L3a observer（轻量记忆观察器）路径、长期记忆评测扩展、归档策略和生产 idle-evolution（空闲自进化）门禁，仍大于当前 memory runtime 实现规划。

For Planning and Multi-Agent, `QUI-17` and `QUI-9` stay open until durable supervisor execution, typed handoff, cross-process routing, and progress aggregation are represented by runtime code and verification evidence.

对 Planning 与 Multi-Agent，`QUI-17` 和 `QUI-9` 应保持 open，直到 durable supervisor execution（可恢复的监督器执行）、typed handoff（带类型的交接）、跨进程路由和进度聚合，都由运行时代码与验证证据承接。

For Tools and Runtime, avoid reopening `QUI-18` and `QUI-21` unless their Done evidence is found to be invalid. New notes should map to the active sandbox/router/runtime issues first, and only become new issues when they need independent delivery.

对 Tools 与 Runtime，除非发现 `QUI-18` 和 `QUI-21` 的 Done 证据无效，否则不要重开。新备注应优先映射到活跃 sandbox/router/runtime issue；只有需要独立交付时才新建 issue。

For Safety, `QUI-19` stays open because production threat modeling, XML isolation, deeper verification layers, secret scrubbing, personally identifiable information detection, and multitenant boundaries are still future hardening work.

对 Safety，`QUI-19` 应保持 open，因为 production threat modeling（生产威胁模型）、XML isolation（XML 隔离）、更深验证层、secret scrubbing（密钥清理）、personally identifiable information detection（个人身份信息检测）和多租户边界仍属于未来加固工作。

For Observability, `QUI-20` stays open until exporter, backend, dashboard, retention, redaction, and trace-to-eval consumption become working runtime paths rather than only contracts and plans.

对 Observability，`QUI-20` 应保持 open，直到 exporter（导出器）、backend（后端）、dashboard（仪表盘）、retention（保留策略）、redaction（脱敏）和 trace-to-eval 消费都成为可运行路径，而不只是契约和规划。

For Skills, `QUI-22` stays open until M2+ platformization, ToolSearch integration, background nudge behavior, and pressure from plugins/self-evolution/tool count are real enough to define a separate outcome.

对 Skills，`QUI-22` 应保持 open，直到 M2+ platformization（平台化）、ToolSearch 集成、background nudge（后台提醒）行为，以及来自插件、自进化和工具数量的真实压力足够明确，能定义独立 outcome。

## 路线图映射规则 / Roadmap Mapping Rules

`QUI-44` should absorb Iter F launch readiness comments, but it should not start implementation before local runtime evidence justifies scale-out. Benchmark path evidence is frozen unless the user explicitly asks. If a subagent discovers a scale-out idea tonight, it should comment on `QUI-44` or the matching component backlog issue, not create a new Iter F issue.

`QUI-44` 应吸收 Iter F 启动就绪度 comment，但在本地 runtime 证据足以支撑规模化前，不应启动实现。除非用户明确要求，Benchmark 路径实证保持冻结。如果 subagent 今晚发现规模化想法，应 comment 到 `QUI-44` 或匹配的组件 backlog issue，而不是新建 Iter F issue。

`QUI-45` should absorb triage-policy refinements, issue-budget notes, and component-deferred review summaries. It should not absorb component-specific implementation logs when a more specific component issue exists.

`QUI-45` 应吸收分流策略修订、issue 额度备注和组件延后工作复核摘要。当存在更具体的组件 issue 时，它不应吸收组件专属实现日志。

`QUI-46` should stay quiet until Iter F produces evidence. Premature ideas for Iter G should be comments only, and they must state which missing Iter F evidence would make the idea actionable.

`QUI-46` 应在 Iter F 产生实证前保持安静。过早的 Iter G 想法只应写 comment，并必须说明缺少哪类 Iter F 证据会让该想法变得可执行。

## 决策流程 / Decision Flow

First, identify the smallest existing issue that owns the capability family. If one exists, write a comment there and link any bilingual doc artifact.

第一步，识别拥有该能力族的最小既有 issue。如果存在，就在该 issue 写 comment，并链接任何中英双语文档产物。

Second, decide whether the work changes acceptance criteria, dependencies, or owner boundaries. If not, do not create or promote anything.

第二步，判断该工作是否改变验收标准、依赖关系或负责人边界。如果没有改变，就不要新建或提升任何事项。

Third, if the work needs coordinated delivery across components, propose promotion from backlog into an outcome project. The proposal should name the result, non-goals, acceptance gates, and existing issues that will be linked rather than duplicated.

第三步，如果该工作需要跨组件协调交付，就提出从 backlog 提升到 outcome project。提案应说明结果、非目标、验收门槛，以及会被关联而不是重复创建的既有 issue。

Fourth, before creating any new issue, check the free-plan thresholds and the existing related issues. If the same work can be expressed by a comment or relation, reuse the existing issue.

第四步，新建 issue 前，先检查免费版阈值和既有关联 issue。如果同一工作可以用 comment 或 relation（关联关系）表达，就复用既有 issue。

## 反模式 / Anti-Patterns

Do not create one issue per subagent. Subagent execution should be recorded as comments on the issue that owns the work.

不要按每个 subagent 新建一个 issue。Subagent 执行应作为 comment 记录到拥有该工作的 issue。

Do not create a new issue for every upstream or competitor finding. A finding should become a new issue only when it changes ownership, acceptance criteria, or delivery sequencing.

不要为每个上游或竞品发现新建 issue。只有当发现改变负责人、验收标准或交付顺序时，它才应变成新 issue。

Do not turn docs into a replacement backlog. Docs may explain triage rules, architecture facts, evidence summaries, and current-state snapshots; live task state belongs in Linear.

不要把 docs 变成替代 backlog。Docs 可以解释分流规则、架构事实、证据摘要和当前状态快照；实时任务状态属于 Linear。

Do not close a broad backlog issue immediately after one F1 slice lands. The broad issue should close only when the family-level deferred work is exhausted, rejected, or fully moved into narrower open issues.

不要在一个 F1 切片落地后立刻关闭宽 backlog issue。宽 issue 只有在能力族级别延后工作已经耗尽、被拒绝，或全部迁移到更窄 open issue 后才应关闭。

## Linear 映射 / Linear Mapping

`QUI-45` owns this triage rulebook and future refinements to component-deferred routing. It should stay open while component backlog issues still need periodic review.

`QUI-45` 负责本文的分流规则书，以及未来组件延后工作路由的修订。只要组件 backlog issue 仍需要周期性复核，`QUI-45` 就应保持 open。

`QUI-44` owns the Iter F launch decision. `QUI-46` owns the post-Iter-F direction decision. They should not absorb component-specific evidence unless the evidence affects the roadmap trigger.

`QUI-44` 负责 Iter F 启动决策。`QUI-46` 负责 Iter F 后方向决策。除非组件证据影响路线图触发条件，否则它们不应吸收组件专属证据。

`QUI-14` through `QUI-22` remain the preferred component backlog homes. `QUI-18` and `QUI-21` are closed in the current snapshot, so future related notes should first map to their active related issues or to comments, not automatic reopening.

`QUI-14` 到 `QUI-22` 仍是优先的组件 backlog 归宿。当前快照中 `QUI-18` 和 `QUI-21` 已关闭，所以未来相关备注应优先映射到它们的活跃关联 issue 或 comment，而不是自动重开。

## 验证 / Verification

This file should be validated with `python3 scripts/lint-glossary.py docs/00-core-loop/component-deferred-triage-plan.md`, `git diff --check -- docs/00-core-loop/component-deferred-triage-plan.md`, and `wc -l docs/00-core-loop/component-deferred-triage-plan.md`.

本文应使用 `python3 scripts/lint-glossary.py docs/00-core-loop/component-deferred-triage-plan.md`、`git diff --check -- docs/00-core-loop/component-deferred-triage-plan.md` 和 `wc -l docs/00-core-loop/component-deferred-triage-plan.md` 验证。
