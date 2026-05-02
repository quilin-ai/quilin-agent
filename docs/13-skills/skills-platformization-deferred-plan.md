# Skills M2+（后续平台化阶段）平台化延后路径 / Skills M2+ Platformization Deferred Path

English: Linear record: `QUI-22`. This document defines the deferred path for Skills M2+（the later platformization phase after M0/M1 runtime stability）. It covers platformization（技能平台化，把本地技能扩展成可分发、可治理、可观测的平台能力）, ToolSearch（按需工具搜索，用来在需要时才取回完整工具 schema 或工具组细节）, background nudge（后台提示/提醒，用来在空闲或低负载时建议沉淀新 skill 或改进现有 skill）, and runtime pressure（运行时压力，指技能、工具、插件和后台任务数量增长后对 token、延迟、安全和可观测性造成的负担）.

中文：Linear 记录：`QUI-22`。本文定义 Skills M2+（M0/M1 运行时稳定后的后续平台化阶段）的延后路径，覆盖 platformization（技能平台化，把本地技能扩展成可分发、可治理、可观测的平台能力）、ToolSearch（按需工具搜索，用来在需要时才取回完整工具 schema 或工具组细节）、background nudge（后台提示/提醒，用来在空闲或低负载时建议沉淀新 skill 或改进现有 skill）和 runtime pressure（运行时压力，指技能、工具、插件和后台任务数量增长后对 token、延迟、安全和可观测性造成的负担）。

English: This document deliberately does not replace `docs/13-skills/skills-frontier-assimilation.md` or `docs/13-skills/skills-runtime-implementation-plan.md`. `QUI-56` owns the frontier decision. `QUI-67` owns the first runtime implementation: manifest（技能包清单，用来声明包结构、权限、依赖和版本）, provenance（来源记录，用来证明安装字节来自哪里）, eval runner（评测运行器，用来证明触发质量和任务收益）, local lockfile, and validation diagnostics. `QUI-22` begins only when those pieces are real enough that platform-level scale becomes the bottleneck.

中文：本文刻意不替代 `docs/13-skills/skills-frontier-assimilation.md` 或 `docs/13-skills/skills-runtime-implementation-plan.md`。`QUI-56` 负责前沿决策；`QUI-67` 负责第一版运行时实现：manifest（技能包清单，用来声明包结构、权限、依赖和版本）、provenance（来源记录，用来证明安装字节来自哪里）、eval runner（评测运行器，用来证明触发质量和任务收益）、本地锁文件和校验诊断。只有这些能力足够真实后，平台级规模才会成为瓶颈，`QUI-22` 才进入实现。

## 资料来源 / Sources

English: Agent Skills official documentation is the compatibility baseline. The specification defines `SKILL.md`, YAML（YAML Ain't Markup Language，一种人可读配置格式）frontmatter, optional `scripts/`, `references/`, and `assets/`, and progressive disclosure（渐进披露，用来先加载少量元数据、需要时再加载完整内容）. It recommends keeping the main skill under 500 lines and loading resources only when needed: [Agent Skills specification](https://agentskills.io/specification) and [description optimization guide](https://agentskills.io/skill-creation/optimizing-descriptions).

中文：Agent Skills 官方文档是兼容性基线。该规范定义了 `SKILL.md`、YAML（YAML Ain't Markup Language，一种人可读配置格式）文件头、可选 `scripts/`、`references/` 和 `assets/`，以及 progressive disclosure（渐进披露，用来先加载少量元数据、需要时再加载完整内容）。它建议主技能文件保持在 500 行以内，并且只在需要时加载资源：[Agent Skills specification](https://agentskills.io/specification) 和 [description optimization guide](https://agentskills.io/skill-creation/optimizing-descriptions)。

English: Tool and plugin distribution patterns should follow current official platform signals rather than inventing a separate ecosystem too early. The OpenAI Agents SDK（OpenAI Agent 开发工具包，用来组合模型、工具、MCP 服务和运行时控制）documents hosted MCP server tools, `allowedTools`, human approval for sensitive tool calls, and `deferLoading` with `toolSearchTool()` for on-demand tool definition loading: [OpenAI Agents SDK MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/). The OpenAI Apps SDK（OpenAI 应用开发工具包，用来基于 MCP 构建 ChatGPT 内应用）is built on MCP and adds app logic plus interface delivery: [Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk).

中文：工具和插件分发模式应跟随当前官方平台信号，不应过早发明一套独立生态。OpenAI Agents SDK（OpenAI Agent 开发工具包，用来组合模型、工具、MCP 服务和运行时控制）文档记录了 hosted MCP server tools（托管 MCP 服务工具）、`allowedTools`、敏感工具调用的人类批准，以及通过 `toolSearchTool()` 搭配 `deferLoading` 按需加载工具定义：[OpenAI Agents SDK MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/)。OpenAI Apps SDK（OpenAI 应用开发工具包，用来基于 MCP 构建 ChatGPT 内应用）建立在 MCP 之上，并增加应用逻辑与界面交付：[Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)。

English: Registry design should remain metadata-first. The official MCP Registry（Model Context Protocol Registry，模型上下文协议注册表，用来发现 MCP 服务元数据）describes itself as a metadata repository, uses namespace verification, exposes discovery through REST/OpenAPI, and delegates code security scanning to package registries or downstream marketplaces: [MCP Registry overview](https://modelcontextprotocol.io/registry/about).

中文：注册表设计应保持 metadata-first（元数据优先）。官方 MCP Registry（Model Context Protocol Registry，模型上下文协议注册表，用来发现 MCP 服务元数据）把自己定义为元数据仓库，使用 namespace verification（命名空间验证），通过 REST/OpenAPI 暴露发现接口，并把代码安全扫描交给包注册表或下游市场：[MCP Registry overview](https://modelcontextprotocol.io/registry/about)。

English: Background work must be resumable, bounded, and auditable. OpenAI's background mode runs long tasks asynchronously and exposes polling/cancel behavior, while Codex product documentation emphasizes isolated task environments, real-time progress, terminal/test evidence, and background work that preserves human focus: [Background mode](https://developers.openai.com/api/docs/guides/background), [Introducing Codex](https://openai.com/index/introducing-codex/), and [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/).

中文：后台工作必须可恢复、有边界、可审计。OpenAI 的 background mode（后台模式，用来异步运行长任务）支持轮询和取消；Codex 产品文档强调隔离任务环境、实时进度、终端/测试证据，以及用于保持人类专注的后台工作：[Background mode](https://developers.openai.com/api/docs/guides/background)、[Introducing Codex](https://openai.com/index/introducing-codex/) 和 [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/)。

## 延后原因 / Why This Is Deferred

English: The current Skills runtime already has M0/M1 responsibilities: catalog injection, `skill_view`, conditional activation, CRUD（create/read/update/delete，创建/读取/更新/删除能力）, safety scanning, hot discovery, and post-compact recovery. Platformization should not start until `QUI-67` proves the package, eval, provenance, and capability policy contract with executable tests.

中文：当前 Skills 运行时已经承担 M0/M1 职责：目录注入、`skill_view`、条件激活、CRUD（create/read/update/delete，创建/读取/更新/删除能力）、安全扫描、热发现和压缩后恢复。只有 `QUI-67` 用可执行测试证明包、评测、来源和能力策略契约后，平台化才应该开始。

English: The first trigger is scale. A small local skill set is cheaper and safer with catalog plus `skill_view`. ToolSearch adds value only when the combined tool and skill surface is large enough that exposing names, descriptions, and schemas up front creates measurable context cost or model confusion.

中文：第一个触发条件是规模。小型本地技能集用 catalog 加 `skill_view` 更便宜也更安全。只有工具与技能合并表面足够大，导致前置暴露名称、描述和 schema 产生可测量上下文成本或模型混淆时，ToolSearch 才有收益。

English: The second trigger is distribution. Plugin-contributed skill roots（由插件贡献的技能目录，用来让插件随包附带技能）and registry-installed skills require publisher identity, dependency declaration, revocation, update policy, and workspace-level trust controls. Those concerns are platform concerns, not local loader concerns.

中文：第二个触发条件是分发。Plugin-contributed skill roots（由插件贡献的技能目录，用来让插件随包附带技能）和注册表安装技能需要发布者身份、依赖声明、撤销、更新策略和工作区级信任控制。这些是平台问题，不是本地加载器问题。

English: The third trigger is self-evolution pressure. Self-evolution（自进化，用来从轨迹中提出改进建议）may propose new skills from successful trajectories, but it must not directly apply runtime behavior changes. `QUI-22` should define the platform review path after `QUI-68` proves proposal artifacts and `skill_manage` remains the only persistence gateway.

中文：第三个触发条件是自进化压力。Self-evolution（自进化，用来从轨迹中提出改进建议）可以从成功轨迹中提出新技能，但不得直接应用运行时行为变化。`QUI-22` 应在 `QUI-68` 证明提案产物后定义平台审核路径，并保持 `skill_manage` 是唯一持久化入口。

## 触发条件 / Activation Triggers

English: `QUI-22` should move from deferred planning to implementation only when at least two of these conditions are true: available tools exceed 100, active skills exceed 50, plugin-delivered skills exist in more than one source, background nudge proposals exceed a weekly review threshold, or measured prompt cost from catalog/schema exposure exceeds the budget set by `QUI-74`.

中文：只有至少两个条件成立时，`QUI-22` 才应从延后规划进入实现：可用工具超过 100 个、活跃技能超过 50 个、多个来源存在插件交付技能、background nudge 提案超过每周审核阈值，或 catalog/schema 暴露带来的提示成本超过 `QUI-74` 设定预算。

English: A hard trigger exists if the runtime has evidence that tool or skill selection quality is degrading. Evidence can include repeated wrong tool selection, duplicate tool names, schema hallucination（模式幻觉，指模型编造不存在的工具参数或结构）, broad skill over-triggering, or rising first-turn token cost.

中文：如果运行时有证据证明工具或技能选择质量正在下降，则构成硬触发。证据包括反复选错工具、重复工具名、schema hallucination（模式幻觉，指模型编造不存在的工具参数或结构）、技能过度触发，或首轮 token 成本上升。

English: Another hard trigger exists when plugin or registry skills become externally shared. Public or team-wide sharing requires revocation, audit trails, update pinning, publisher trust, and installation receipts before users can safely depend on it.

中文：当插件或注册表技能开始外部共享时，也构成硬触发。公共或团队级共享需要撤销、审计轨迹、更新锁定、发布者信任和安装凭据，用户才能安全依赖它。

## 平台化边界 / Platformization Boundary

English: Platformization means Quilin gains a control plane（控制面，用来管理元数据、策略、状态和审核）for skills, not that skills become ordinary tools. A skill remains an instruction asset. A tool remains an executable action. The control plane coordinates discovery, policy, promotion, revocation, and observability across both.

中文：平台化意味着 Quilin 为 skills 增加 control plane（控制面，用来管理元数据、策略、状态和审核），不是把 skill 变成普通 tool。Skill 仍是指令资产；tool 仍是可执行动作。控制面负责横跨二者的发现、策略、晋级、撤销和可观测性。

English: The platform should expose three stable surfaces: `SkillIndex`（技能索引，用来检索名称、描述、来源、版本和能力）, `SkillPolicy`（技能策略，用来决定加载、执行和升级确认）, and `SkillProposalQueue`（技能提案队列，用来承接后台或自进化生成的候选变更）.

中文：平台应暴露三个稳定表面：`SkillIndex`（技能索引，用来检索名称、描述、来源、版本和能力）、`SkillPolicy`（技能策略，用来决定加载、执行和升级确认）和 `SkillProposalQueue`（技能提案队列，用来承接后台或自进化生成的候选变更）。

English: The local runtime should continue to work without the platform service. Platform features should degrade to local-only manifests, local lockfiles, local eval reports, and no automatic publishing. This keeps developer workflows usable when offline.

中文：本地运行时应在没有平台服务时继续可用。平台功能应降级为仅使用本地 manifest、本地锁文件、本地评测报告，并禁止自动发布。这样离线开发流程仍可工作。

## ToolSearch 契约 / ToolSearch Contract

English: ToolSearch is not a replacement for `skill_view`. `skill_view` loads a selected skill body. ToolSearch loads or narrows tool definitions when too many tools, MCP servers（Model Context Protocol servers，模型上下文协议服务，用来把模型连接到外部工具和数据源）, plugin tools, or generated helper tools would otherwise bloat the prompt.

中文：ToolSearch 不是 `skill_view` 的替代品。`skill_view` 加载已选技能正文。ToolSearch 在工具、MCP servers（Model Context Protocol servers，模型上下文协议服务，用来把模型连接到外部工具和数据源）、插件工具或生成辅助工具过多时，按需加载或收窄工具定义，避免提示膨胀。

English: The first contract is a two-level catalog. The stable prompt should expose only compact tool groups, tool names, one-line descriptions, risk level, and retrieval key. Full JSON Schema（JavaScript Object Notation Schema，一种描述 JSON 参数结构的格式）should be fetched only after the model selects a likely tool group.

中文：第一项契约是两级目录。稳定 prompt 应只暴露紧凑工具组、工具名、一句话描述、风险级别和检索键。完整 JSON Schema（JavaScript Object Notation Schema，一种描述 JSON 参数结构的格式）只有在模型选中可能相关的工具组后才取回。

```ts
export interface DeferredToolSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly group: "builtin" | "mcp" | "plugin" | "skill_helper";
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly retrievalKey: string;
  readonly requiredApprovals: readonly string[];
}

export interface ToolSearchRequest {
  readonly query: string;
  readonly allowedGroups: readonly DeferredToolSummary["group"][];
  readonly maxResults: number;
  readonly budgetTokens: number;
  readonly skillContext?: {
    readonly activeSkillId: string;
    readonly declaredCapabilities: readonly string[];
  };
}

export interface ToolSearchResult {
  readonly summaries: readonly DeferredToolSummary[];
  readonly fullSchemas: readonly {
    readonly id: string;
    readonly jsonSchema: unknown;
    readonly schemaDigest: string;
  }[];
  readonly auditRef: string;
}
```

English: The second contract is schema provenance. Every full tool schema returned by ToolSearch must carry a digest, source identity, version, and audit reference. This prevents silent tool replacement when two tools share a similar name or a plugin updates its exported tools.

中文：第二项契约是 schema provenance（模式来源记录，用来追踪工具参数结构来自哪里）。ToolSearch 返回的每个完整工具 schema 都必须带摘要、来源身份、版本和审计引用。这样可以避免两个工具名称相似或插件更新导出工具时发生静默替换。

English: The third contract is safety prefiltering. ToolSearch must not return tools outside the current workspace policy, trust tier, skill capability declaration, or `WriteAuthority`（统一写权限门，用来集中审批所有 agent 写入动作）mode. Retrieval should reduce prompt cost, not bypass policy.

中文：第三项契约是安全预过滤。ToolSearch 不得返回超出当前 workspace policy（工作区策略）、信任等级、技能能力声明或 `WriteAuthority`（统一写权限门，用来集中审批所有 agent 写入动作）模式的工具。检索应降低提示成本，而不是绕过策略。

## 插件技能根契约 / Plugin Skill Roots Contract

English: A plugin（插件，用来向 Agent 提供工具、技能、连接器或界面扩展）may contribute skill roots only through its manifest. The manifest must declare package identity, version, skill root path, export policy, dependency list, tool groups, required MCP servers, and whether skills are user-visible, workspace-visible, or internal helper skills.

中文：plugin（插件，用来向 Agent 提供工具、技能、连接器或界面扩展）只能通过 manifest 声明贡献 skill roots（技能根目录）。manifest 必须声明包身份、版本、技能根路径、导出策略、依赖列表、工具组、所需 MCP 服务，以及技能是用户可见、工作区可见还是内部辅助技能。

```json
{
  "schemaVersion": 1,
  "pluginId": "io.quilin.example.docs",
  "version": "1.0.0",
  "skills": [
    {
      "root": "skills/docs-writer",
      "visibility": "workspace",
      "trustTier": "plugin",
      "requiredToolGroups": ["file", "markdown"],
      "capabilityProfile": "docs-write-only"
    }
  ]
}
```

English: Plugin skill roots should be read-only from the Skills runtime unless the plugin explicitly supports updates through a signed package update flow. Agent-created edits to plugin-bundled skills should create overlay skills（覆盖层技能，用来在本地记录差异而不改原插件包）or proposals, not mutate installed plugin bytes.

中文：除非插件通过签名包更新流程明确支持更新，否则 Skills 运行时应把插件技能根目录视为只读。Agent 对插件内置技能的修改应创建 overlay skills（覆盖层技能，用来在本地记录差异而不改原插件包）或提案，而不是直接改已安装插件字节。

English: Plugin removal must revoke contributed skills and tool groups together. If a session has an active skill from a removed plugin, the runtime should finish the current step, block new activations, record a policy event, and ask for user confirmation before any write.

中文：插件移除必须同时撤销贡献的技能和工具组。如果一个 session（会话）正在使用已移除插件提供的技能，运行时应完成当前步骤、阻止新的激活、记录策略事件，并在任何写入前要求用户确认。

## Background Nudge 契约 / Background Nudge Contract

English: Background nudge is a proposal generator, not an automatic writer. It may inspect completed trajectories（任务轨迹，用来记录一次任务从输入到输出的执行过程）, repeated corrections, failed triggers, and user-confirmed workflows, then suggest skill creation or skill improvement. It must not apply a skill change without human review.

中文：background nudge 是提案生成器，不是自动写入器。它可以检查已完成 trajectories（任务轨迹，用来记录一次任务从输入到输出的执行过程）、重复纠正、触发失败和用户确认的工作流，然后建议创建或改进技能。未经人审，它不得应用技能变更。

English: A nudge candidate must include trigger evidence, task-lift hypothesis（任务收益假设，用来说明新技能预计能改善什么）, proposed `SKILL.md` diff, capability declaration, safety scan result, estimated maintenance cost, and a reason why this should be a skill rather than a memory, prompt, tool, or documentation update.

中文：一个 nudge candidate（后台提醒候选）必须包含触发证据、task-lift hypothesis（任务收益假设，用来说明新技能预计能改善什么）、拟议 `SKILL.md` diff、能力声明、安全扫描结果、预估维护成本，以及为什么它应是 skill 而不是 memory、prompt、tool 或文档更新。

```ts
export interface SkillNudgeProposal {
  readonly proposalId: string;
  readonly source: "trajectory" | "user_correction" | "failed_trigger" | "review_pattern";
  readonly target: "create_skill" | "update_skill" | "retire_skill" | "merge_skills";
  readonly evidenceRefs: readonly string[];
  readonly proposedDiffRef: string;
  readonly capabilityProfile: string;
  readonly expectedLift: {
    readonly triggerPrecisionRisk: "low" | "medium" | "high";
    readonly taskLiftHypothesis: string;
    readonly estimatedTokenDelta: number;
  };
  readonly requiredReview: "human" | "maintainer";
}
```

English: Nudge cadence must be bounded. The default state is off. When enabled, it should have a daily token budget, max proposals per week, quiet hours, and a dedupe window so the same weak signal does not repeatedly interrupt the user or flood Linear.

中文：后台提醒频率必须受限。默认状态是关闭。启用后，它应具备每日 token 预算、每周最大提案数、免打扰时段和去重窗口，避免同一个弱信号反复打断用户或刷爆 Linear。

## 自进化接线 / Self-Evolution Wiring

English: `QUI-68` should produce self-evolution proposal artifacts. `QUI-22` should decide which accepted artifacts become platform-managed skill changes. The boundary is simple: self-evolution discovers and proposes; Skills validates, stores, evaluates, and exposes; `WriteAuthority` approves writes.

中文：`QUI-68` 应产出自进化提案产物。`QUI-22` 应决定哪些已接受产物会变成平台管理的技能变更。边界很简单：self-evolution 发现并提案；Skills 校验、存储、评测和暴露；`WriteAuthority` 审批写入。

English: Accepted self-evolution skill proposals should enter the same promotion gates as human-authored skills. They need format validation, path safety, capability policy, trigger-quality eval, task-lift eval, provenance receipt, and a reviewer decision before becoming active by default.

中文：已接受的自进化技能提案应进入与人类手写技能相同的晋级门禁。它们需要格式校验、路径安全、能力策略、触发质量评测、任务收益评测、来源凭据和审核决定，才能默认激活。

English: Rejected proposals should stay in Linear comments or proposal storage, not docs truth. Docs should record accepted architecture and verified evidence, not every speculative idea generated by background analysis.

中文：被拒绝的提案应留在 Linear comment 或提案存储中，而不是写入 docs truth（文档真相）。docs 应记录已接受架构和已验证证据，而不是后台分析生成的每个猜想。

## 运行时压力模型 / Runtime Pressure Model

English: Skills M2+ should track five pressure metrics: prompt surface size, schema retrieval count, skill activation count, tool-call approval count, and background proposal count. These metrics should be emitted as structured observability events so reviewers can diagnose scale problems without reading raw transcripts.

中文：Skills M2+ 应追踪五类压力指标：prompt surface size（提示表面大小）、schema retrieval count（schema 检索次数）、skill activation count（技能激活次数）、tool-call approval count（工具调用批准次数）和 background proposal count（后台提案次数）。这些指标应以结构化可观测性事件输出，让审核者无需阅读原始执行记录也能诊断规模问题。

English: Prompt pressure should be measured before adding ToolSearch. The platform should record baseline catalog tokens, deferred catalog tokens, tool schema tokens fetched by search, cache hit rate, wrong-tool retry count, and first-action latency. ToolSearch is a win only if it reduces total cost or error rate under real workloads.

中文：加入 ToolSearch 前必须先测量提示压力。平台应记录基线 catalog token、延迟目录 token、通过搜索取回的工具 schema token、缓存命中率、错误工具重试次数和首次动作延迟。只有在真实工作负载下降低总成本或错误率时，ToolSearch 才算收益。

English: Safety pressure should be measured as policy interventions, not just blocked actions. The runtime should count `allow`, `allow_with_warning`, `needs_review`, `reject`, and `escalate` decisions per skill, per plugin, and per tool group.

中文：安全压力应按策略介入计量，而不只是按被阻断动作计量。运行时应按每个 skill、每个 plugin 和每个 tool group 统计 `allow`、`allow_with_warning`、`needs_review`、`reject` 和 `escalate` 决策。

English: Review pressure should be measured before enabling background nudge broadly. A useful nudge system creates a small number of high-confidence proposals. A noisy nudge system becomes hidden task management debt.

中文：在广泛启用 background nudge 之前，应先测量审核压力。有用的后台提醒系统只产生少量高置信提案；嘈杂的后台提醒系统会变成隐藏任务管理债务。

## 验收门槛 / Acceptance Gates

English: Platformization acceptance requires a local-first platform mode. With no remote service, Quilin must still discover local/project/plugin skills, validate manifests, enforce capability policy, run eval reports, and expose a read-only index for the current workspace.

中文：平台化验收要求具备 local-first（本地优先）平台模式。即使没有远程服务，Quilin 仍必须能发现本地/项目/插件技能、校验 manifest、执行能力策略、运行评测报告，并为当前工作区暴露只读索引。

English: ToolSearch acceptance requires a reproducible comparison against the current catalog-plus-`skill_view` path. The comparison must show prompt token reduction, no increase in wrong-tool selection, stable schema digest logging, and correct policy filtering for denied tools.

中文：ToolSearch 验收要求与当前 catalog 加 `skill_view` 路径做可复现对比。对比必须展示提示 token 降低、错误工具选择不增加、schema 摘要日志稳定，以及被拒绝工具能正确被策略过滤。

English: Background nudge acceptance requires a dry-run mode. The dry run must produce proposals with evidence references, but no filesystem write, no automatic `skill_manage`, no issue creation, and no activation change. Human review must be the only path from proposal to active skill.

中文：background nudge 验收要求具备 dry-run（试运行）模式。试运行必须产出带证据引用的提案，但不进行文件写入、不自动调用 `skill_manage`、不创建 issue、不改变激活状态。从提案到活跃技能的唯一路径必须是人审。

English: Plugin skill acceptance requires install, update, disable, and uninstall tests. The tests must prove that plugin skill roots are read-only, plugin removal revokes activations, overlays do not mutate plugin bytes, and all contributed tools pass the same policy checks as built-in tools.

中文：插件技能验收要求具备安装、更新、禁用和卸载测试。这些测试必须证明插件技能根目录只读、插件移除会撤销激活、覆盖层不会修改插件字节，并且所有插件贡献工具都经过与内置工具相同的策略检查。

English: Observability acceptance requires dashboard-ready events for skill discovery, activation, ToolSearch retrieval, nudge proposal creation, proposal review, policy decision, schema digest mismatch, and plugin revocation.

中文：可观测性验收要求为技能发现、激活、ToolSearch 检索、后台提案创建、提案审核、策略决策、schema 摘要不匹配和插件撤销输出 dashboard-ready events（可直接进入仪表盘的事件）。

## 当前不做 / Non-Goals

English: Do not build a hosted public skill marketplace from `QUI-22` before local platform contracts pass. A marketplace without reliable evals, provenance, revocation, and policy enforcement would expand risk faster than capability.

中文：在本地平台契约通过前，不要从 `QUI-22` 建设托管公共技能市场。如果没有可靠评测、来源记录、撤销和策略执行，市场会比能力更快放大风险。

English: Do not use background nudge to create unlimited tasks or Linear issues. The workspace has a 250-issue free-plan cap, so nudge output should be batched into existing issues or proposal logs unless an accepted change needs independent ownership.

中文：不要让 background nudge 创建无限任务或 Linear issue。当前 workspace 使用 250 issue 免费版，因此后台提醒输出应批量写入现有 issue 或提案日志，除非已接受变更需要独立负责人。

English: Do not treat ToolSearch as a quality guarantee. It is a retrieval and prompt-budget mechanism. Skill and tool quality still depends on descriptions, schemas, evals, safety policy, and observed task outcomes.

中文：不要把 ToolSearch 当成质量保证。它只是检索和提示预算机制。技能与工具质量仍依赖描述、schema、评测、安全策略和已观测任务结果。

English: Do not let plugins bypass Skills runtime rules. Plugin-delivered skills must pass the same path, size, content, capability, provenance, and eval gates as local or registry skills.

中文：不要让插件绕过 Skills 运行时规则。插件交付技能必须通过与本地或注册表技能相同的路径、大小、内容、能力、来源和评测门禁。

## Linear 映射 / Linear Mapping

English: `QUI-22` owns this deferred platform path and should remain open after this document because no runtime code has implemented platform control plane behavior, ToolSearch integration, background nudge dry-run, plugin skill roots, or pressure metrics yet.

中文：`QUI-22` 负责本文的延后平台路径；本文完成后仍应保持 open，因为平台控制面行为、ToolSearch 集成、background nudge 试运行、插件技能根目录和压力指标尚未有运行时代码实现。

English: `QUI-67` remains the prerequisite for package runtime. `QUI-68` remains the prerequisite for self-evolution proposal artifacts. `QUI-52` owns tool routing and sandbox execution. `QUI-64` owns action-level safety decisions. `QUI-74` owns cost, token, and latency vocabulary used by pressure metrics.

中文：`QUI-67` 仍是技能包运行时前置条件。`QUI-68` 仍是自进化提案产物前置条件。`QUI-52` 负责工具路由和沙箱执行。`QUI-64` 负责动作级安全决策。`QUI-74` 负责压力指标使用的成本、token 和延迟词汇。

English: Future comments on `QUI-22` should update evidence, trigger status, and implementation readiness rather than creating new issues. A new issue is justified only when platformization produces a separable implementation deliverable with its own owner, blocker, and acceptance criteria.

中文：`QUI-22` 的后续 comment 应更新证据、触发状态和实现就绪度，而不是新建 issue。只有当平台化产生可拆分实现交付物，并且需要独立负责人、阻塞关系和验收标准时，才应新建 issue。

