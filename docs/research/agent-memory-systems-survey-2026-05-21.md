# Agent Memory 系统调研合并报告 / Agent Memory Systems Survey

> Draft for Claude/Codex review. Sources: `competitor-analysis-codex.md`, `external-survey-codex.md`, `quilin-mem-competitive-strategy-claude.md`, and `external-survey-claude.md`.
>
> Claude/Codex 协商草稿。来源：`competitor-analysis-codex.md`、`external-survey-codex.md`、`quilin-mem-competitive-strategy-claude.md`、`external-survey-claude.md`。

## 1. 执行摘要 / Executive Summary

The target is not to build "another memory plugin". The target is a perfect memory system for Quilin: local-first, evidence-preserving, temporally correct, safe to mutate, measurable under long-horizon workloads, and useful across CLI, REPL, Web, Mac App, skills, self-evolution, and imported memories from other agents. The market has converged on a few strong pieces: Mem0-style fast extraction and benchmark discipline, Zep-style temporal graph, MemPalace/MemMachine-style ground-truth preservation, GBrain/Codex-style durable background jobs, Claude Code-style file memory and staleness UX, and AgentMemory/Claude-Mem-style lifecycle hooks. No competitor combines those with Quilin's global WriteAuthority, Soul Import, four-client runtime, Skill system, and self-evolution loop.

目标不是再做一个 memory plugin，而是给 Quilin 做一个“完美记忆系统”：本地优先、保留证据、时态正确、写入安全、长周期可评测，并能服务 CLI、REPL、Web、Mac App、skills、自进化和从其他 agent 导入的历史记忆。业界已经收敛出若干强组件：Mem0 的快速抽取和评测纪律、Zep 的时态图、MemPalace/MemMachine 的原始证据保真、GBrain/Codex 的可靠后台任务、Claude Code 的文件记忆和过期感知 UX、AgentMemory/Claude-Mem 的生命周期 hooks。没有任何竞品把这些与 Quilin 的全局 WriteAuthority、Soul Import、四客户端运行时、Skill 系统和自进化闭环组合起来。

The core strategy is therefore: do not add layers for their own sake. Ship a governed memory operating system. The foundation is an append-only evidence and `FactEvent` stream, actor-scoped provenance, temporal validity, version chains, and soft-delete rollback. Retrieval then becomes hybrid and cautious: BM25/vector/entity/KG fusion, low-confidence rejection, consensus checks for suspicious top-K results, progressive disclosure, and context handoff that never lets untrusted memories become instructions. Background intelligence runs through `quilin-daemon`, not the chat path: batch consolidation, predictive warming, skill maturity, foresight reminders, and memory integrity evaluation all share leases, idle budget, observability, and WriteAuthority.

核心策略因此不是为了层级而加层级，而是交付一个受治理的 memory operating system。基础是 append-only evidence 与 `FactEvent` 流、按参与者作用域记录的 provenance、时态有效期、版本链和 soft-delete 回滚。检索层再做 hybrid 且谨慎：BM25/vector/entity/KG 融合、低置信拒答、可疑 top-K 的 consensus check、progressive disclosure，以及保证低可信记忆不会变成指令的 Context handoff。后台智能通过 `quilin-daemon` 跑，而不是挤进 chat path：批量整理、预测预热、skill maturity、foresight 提醒和记忆完整性评测都共享 lease、idle budget、可观测性和 WriteAuthority。

The first week should not chase all ideas. The first week should make memory safer and more measurable: versioned evidence/provenance, batch LLM dedupe plus low-confidence rejection, and a memory integrity eval lane. These unlock the later differentiators: reverse Soul Export, four-client conflict resolution, trace-to-skill, provenance visualizer, and multi-modal resources.

第一周不应追逐所有 idea。第一周应先让 memory 更安全、更可测：版本化 evidence/provenance、batch LLM dedupe 加低置信拒答、memory integrity eval lane。它们会解锁后续差异化：反向 Soul Export、四客户端冲突解决、trace-to-skill、provenance 可视化和多模态资源记忆。

## 2. 调研合并总览 / Combined Overview

The fourteen local repositories fall into five families: memory libraries (`mem0`, `agentmemory`, `MemMachine` client), standalone services (`letta`, `zep`, `mempalace`, `MemMachine`, `gbrain`), host plugins (`hermes-agent`, OpenClaw memory plugins), native harness memory (`codex`, `claude-code`, OpenClaw), and production/domain systems (`EverOS`, `TencentDB-Agent-Memory`, `claude-mem`). The extension survey adds papers and platforms: MemGPT, Generative Agents, MemoryBank, Reflexion, A-MEM, Zep, Mem0, MIRIX, MemMachine, LongMemEval, LoCoMo, MemBench, BEAM, PerLTQA, DialSim, EvoMemBench, GroupMemBench, LangMem, LlamaIndex Memory, AutoGen Teachability, Honcho, MemX, and vector database memory layers.

十四个本地仓库可分成五类：memory libraries（`mem0`、`agentmemory`、`MemMachine` client）、独立服务（`letta`、`zep`、`mempalace`、`MemMachine`、`gbrain`）、host plugins（`hermes-agent`、OpenClaw memory plugins）、native harness memory（`codex`、`claude-code`、OpenClaw）和生产/领域系统（`EverOS`、`TencentDB-Agent-Memory`、`claude-mem`）。扩展调研补充了论文和平台：MemGPT、Generative Agents、MemoryBank、Reflexion、A-MEM、Zep、Mem0、MIRIX、MemMachine、LongMemEval、LoCoMo、MemBench、BEAM、PerLTQA、DialSim、EvoMemBench、GroupMemBench、LangMem、LlamaIndex Memory、AutoGen Teachability、Honcho、MemX 和向量数据库 memory layers。

The strongest pattern is convergence, not contradiction. Everyone needs persistent raw evidence, extracted facts, retrieval fusion, background consolidation, and some form of user/profile memory. The disagreement is where authority lives: Letta and AgeMem let agents manage memory directly; MemPalace and MemMachine preserve evidence first; Zep and Graphiti emphasize temporal graph truth; GBrain and Codex emphasize durable operational mechanics; Claude Code and markdown systems emphasize user-visible files. Quilin should combine these but keep authority outside the LLM.

最强模式是收敛，不是冲突。所有系统都需要持久原始证据、抽取事实、融合检索、后台整理，以及某种用户/画像记忆。分歧在于权力放在哪里：Letta 和 AgeMem 让 agent 直接管理记忆；MemPalace 和 MemMachine 优先保留证据；Zep 和 Graphiti 强调时态图真值；GBrain 和 Codex 强调可靠运维机制；Claude Code 和 Markdown 系统强调用户可见文件。Quilin 应组合这些，但必须把 authority 放在 LLM 之外。

## 3. 横向对比矩阵 / Comparison Matrix

| Dimension | Best external signal | Quilin current/planned | Gap or decision |
|---|---|---|---|
| Memory tiers | Letta blocks, EverOS 8 types, MIRIX 6 types | working / episodic / semantic / skill | Keep 4 layers; add orthogonal type and resource pointers |
| Raw evidence | MemPalace, MemMachine, Tencent refs | Planned FactEvent/provenance, partial logs | Need first-class raw observation/evidence store |
| Temporal truth | Zep/Graphiti, GBrain effective dates | KG + valid_from/to planned | Need validity everywhere, not only KG |
| Versioning | Letta git memory, Memoria, agentmemory chain | Supersedes planned, not full chain | Add version/parent/isLatest/snapshots |
| Write safety | GBrain destructive guard, OWASP | WriteAuthority globally ahead | Extend to delete impact preview + TTL rollback |
| Poisoning defense | A-MemGuard, AgentPoison, MemoryGraft | Poisoning checks planned | Add consensus-check retrieval and safety lessons |
| Retrieval | Mem0, GBrain, MemX, AgentMemory | Hybrid retriever implemented/planned | Add low-confidence rejection and progressive disclosure |
| Background jobs | Codex two-stage queue, GBrain jobs, Claude autoDream | `quilin-daemon` design | Implement durable leases/heartbeat/running caps |
| Dedupe/consolidation | Mem0 batch path, MemMachine splitter | Consolidator exists; per-pair too slow | Batch cluster LLM judge first |
| Importance | Generative Agents scalar; SCM multi-dimensional | Scalar importance/access/time | Add multi-dimensional importance and intent weighting |
| Foresight | EverOS ForesightModel | DepartureContext string lists | Add prospective memory model |
| Procedural memory | Voyager, EverOS AgentCase→Skill, Skill-Pro | 13-skills strong substrate | Add trace-to-skill maturity pipeline |
| Multi-client | Rare; Letta server-only, GBrain service | CLI/REPL/Web/Mac App planned | Unique but needs conflict resolution |
| Portability | Claude markdown, GBrain markdown SoT | Soul Import forward planned | Add reverse Soul Export |
| Multi-modal | MIRIX, GBrain multimodal chunks | Text-first | Pre-reserve ResourceStore/resource_pointer |
| Benchmarks | LongMemEval, LoCoMo, MemBench, BEAM | Local fixture lane planned | Add write-integrity, actor attribution, BEAM-scale lanes |
| User correction UX | Letta editable blocks, markdown systems | Web memory page exists | Need correction, conflict, provenance visualizer |
| Project context | Claude/Codex files, QUILIN.md planned | QUILIN.md exists/planned | Use current project as retrieval boost signal |
| Observability | GBrain doctor, Claude-Mem audit | Event log exists | Add audit 5-field + run/provenance graph |

The matrix says Quilin should not become EverOS-heavy or Mem0-black-box. It should stay local-first and typed, then add the missing operational contracts that make memory trustworthy under real usage.

矩阵说明 Quilin 不应变成 EverOS 式重基础设施，也不应变成 Mem0 式黑盒 API。它应保持 local-first 和 typed，然后补齐真实使用中让记忆可信的运维契约。

## 4. quilin-mem 现状定位 / Quilin Position

### 4.1 已对齐 / Already Aligned

1. Quilin already has a four-layer model: working, episodic, semantic, and skill.
2. It already chose Python MCP provider plus TypeScript agent-core boundary, matching the active architecture.
3. It already has SQLite, FTS5/BM25, KG, vector retriever interfaces, hybrid retriever, reranker, event log, profile store, and observer/consolidator direction.
4. It already moved away from default Graphiti dependency toward self-owned temporal KG.
5. It already has L3a Observer, Reflector, Consolidator, and idle budget concepts.
6. It already treats `user.md`, `soul.md`, and `QUILIN.md` as durable identity/project artifacts.
7. It already treats Skills as procedural memory with `SKILL.md`, catalog-first injection, on-demand body loading, safety scan, and WriteAuthority-gated CRUD.
8. It already has docs for append-only `FactEvent`, provenance receipt, quarantine, poisoning checks, and stable Context handoff.

1. Quilin 已有 working、episodic、semantic、skill 四层模型。
2. Quilin 已选择 Python MCP provider 与 TypeScript agent-core 边界，符合当前架构。
3. Quilin 已有 SQLite、FTS5/BM25、KG、vector retriever interface、hybrid retriever、reranker、event log、profile store，以及 observer/consolidator 方向。
4. Quilin 已从默认依赖 Graphiti 转向自有 temporal KG。
5. Quilin 已有 L3a Observer、Reflector、Consolidator 和 idle budget 概念。
6. Quilin 已把 `user.md`、`soul.md`、`QUILIN.md` 当作持久身份/项目资产。
7. Quilin 已把 Skills 作为 procedural memory，包含 `SKILL.md`、catalog-first injection、按需加载 body、安全扫描和 WriteAuthority-gated CRUD。
8. Quilin docs 已规划 append-only `FactEvent`、provenance receipt、quarantine、poisoning checks 和 stable Context handoff。

### 4.2 已超前 / Already Ahead

1. **WriteAuthority as a global gate**: competitors usually gate inside one memory module or not at all; Quilin can govern file writes, memory mutation, skill creation, idle writes, and self-evolution proposals through one authority plane.
2. **Four-client shared memory**: CLI, REPL, Web, and Mac App sharing `~/.quilin` is a harder and more valuable problem than server-only memory.
3. **Soul Import**: scanning other agent frameworks to seed `user.md`, `soul.md`, `QUILIN.md`, and quilin-mem is a unique cold-start advantage.

1. **WriteAuthority 全局门禁**：竞品通常只在单个 memory 模块内做 gate，或完全没有；Quilin 可以用一套 authority plane 管文件写入、memory mutation、skill creation、idle writes 和 self-evolution proposals。
2. **四客户端共享记忆**：CLI、REPL、Web、Mac App 共享 `~/.quilin`，比 server-only memory 更难也更有价值。
3. **Soul Import**：扫描其他 agent framework 来 seed `user.md`、`soul.md`、`QUILIN.md` 和 quilin-mem，是独特冷启动优势。

### 4.3 差距明显 / Clear Gaps

1. No production-grade idle job queue with leases, heartbeat, stale stealing, and running caps.
2. No full memory version chain, snapshot, checkout, or git-style time-travel API.
3. No first-class raw observation/evidence store connected to every derived fact.
4. No actor-scoped provenance for multi-party, multi-client, and imported memories.
5. No consensus-check retrieval or low-confidence rejection.
6. No destructive guard with impact preview, soft-delete TTL, and rollback.
7. No explicit memory type taxonomy orthogonal to layers.
8. No FORESIGHT/prospective memory for future commitments and reminders.
9. No trace-to-skill maturity pipeline.
10. No multi-modal ResourceStore or reserved schema for non-text resources.

1. 缺少带 lease、heartbeat、stale stealing、running cap 的生产级 idle job queue。
2. 缺少完整 memory version chain、snapshot、checkout 和 git-style time-travel API。
3. 缺少与所有派生事实相连的一等 raw observation/evidence store。
4. 缺少面向多方、多客户端和导入记忆的 actor-scoped provenance。
5. 缺少 consensus-check retrieval 和低置信拒答。
6. 缺少 impact preview、soft-delete TTL 和 rollback 的 destructive guard。
7. 缺少与 layer 正交的 memory type taxonomy。
8. 缺少面向未来承诺和提醒的 FORESIGHT/prospective memory。
9. 缺少 trace-to-skill maturity pipeline。
10. 缺少 multi-modal ResourceStore 或为非文本资源预留 schema。

## 5. 打爆所有的升级 Roadmap / Upgrade Roadmap

The roadmap merges the 20 ideas from both agents into 10 workstreams. Priority means sequencing, not value. High items are prerequisites for trust and correctness.

该 roadmap 把双方 20 条 idea 去重合并成 10 个 workstream。优先级表示落地顺序，不代表价值。High 项是信任和正确性的前置条件。

| Pri | Workstream | Merged ideas | Unique | Safety critical | Est. |
|---|---|---|---|---|---|
| High | Evidence + Versioned Truth Core | raw evidence, FactEvent, version chain, multi-source trace, memory snapshots/time-travel | Yes | Yes | 4-5 joint days |
| High | Safe Retrieval Gate | low-confidence rejection, consensus-check retrieval, poisoning quarantine, safety_lesson | No | Yes | 2-3 joint days |
| High | Batch Consolidation + Destructive Guard | batch LLM judge, soft-delete TTL, impact preview, WriteAuthority delete gate | No | Yes | 3 joint days |
| High | Memory Integrity Eval | write-integrity benchmark, participation vs observation scoring, actor attribution fixtures | Yes | Yes | 2 joint days |
| High | Durable Idle Runtime | `quilin-daemon`, job queue, leases, heartbeat, running caps, budget pool | Yes | Yes | 3-4 joint days |
| Medium | Multi-Client + Project Scope | four-client conflict resolution, QUILIN.md retrieval boost, actor/client writer metadata | Yes | Yes | 3 joint days |
| Medium | Procedural Memory Pipeline | trace-to-skill compiler, AgentCase→Skill maturity, verification tests | Yes | Yes | 4 joint days |
| Medium | Foresight + Predictive Warmer | prospective memory, sleep-time predictive warmer, active reminders | Partly | Medium | 3 joint days |
| Medium | Salience + Taxonomy | multidimensional importance, memory type taxonomy, staleness UX | No | Medium | 2 joint days |
| Low | Portability + Resource UX | reverse Soul Export, provenance visualizer, ResourceStore/multimodal pointers | Yes | Medium | 4-6 joint days |

### 5.1 High 1 — Evidence + Versioned Truth Core

Ship `memory_records` version fields (`version`, `parent_id`, `supersedes`, `is_latest`, `forget_after`, `strength`), a `memory_sources` table, actor-scoped provenance, and a `memory_snapshot` table. Every derived semantic/profile/procedural fact should point to one or more raw observations, and every correction should create a new event rather than mutate history. This merges Codex's evidence-first judgment, Claude's version-chain/time-travel findings, Letta/Memoria git-style ideas, AgentMemory's `supersedes`, and Claude-Mem's `memory_sources`.

落地 `memory_records` 版本字段（`version`、`parent_id`、`supersedes`、`is_latest`、`forget_after`、`strength`）、`memory_sources` 表、actor-scoped provenance 和 `memory_snapshot` 表。每条派生 semantic/profile/procedural fact 都必须指向一个或多个 raw observations，每次纠错都创建新事件而不是改写历史。该项合并了 Codex 的 evidence-first 判断、Claude 的 version-chain/time-travel 发现、Letta/Memoria 的 git-style idea、AgentMemory 的 `supersedes` 和 Claude-Mem 的 `memory_sources`。

Plane split: `QUI-191A memory evidence store`, `QUI-191B version chain`, `QUI-191C memory snapshot checkout`.

Plane 拆分：`QUI-191A memory evidence store`、`QUI-191B version chain`、`QUI-191C memory snapshot checkout`。

### 5.2 High 2 — Safe Retrieval Gate

Add a retrieval-level gate above hybrid recall. It should return `insufficient_memory_evidence` when confidence is low, and run consensus checks when top-K memories disagree or carry low trust. Divergent candidates go to quarantine and may generate `safety_lesson` records. This is where A-MemGuard, MemX, OWASP Agent Memory Guard, AgentPoison, MemoryGraft, and Quilin's existing poisoning docs converge.

在 hybrid recall 之上增加 retrieval-level gate。置信度低时返回 `insufficient_memory_evidence`；top-K 记忆互相冲突或低可信时运行 consensus check。偏离候选进入 quarantine，并可生成 `safety_lesson`。这是 A-MemGuard、MemX、OWASP Agent Memory Guard、AgentPoison、MemoryGraft 和 Quilin 现有 poisoning docs 的交汇点。

Plane split: `QUI-191D low-confidence rejection`, `QUI-191E consensus retrieval gate`.

Plane 拆分：`QUI-191D low-confidence rejection`、`QUI-191E consensus retrieval gate`。

### 5.3 High 3 — Batch Consolidation + Destructive Guard

Replace per-pair dedupe judgment with batch cluster JSON while keeping the `memory_consolidate_plan` wire shape stable. Add destructive impact preview, WriteAuthority decision, 72-hour soft-delete TTL, and recovery before any true delete. This turns QUI-189's batch judge into a safe production consolidation path and absorbs GBrain's destructive guard.

把 per-pair dedupe judgment 替换成 batch cluster JSON，同时保持 `memory_consolidate_plan` wire shape 不变。任何真实删除前都必须有 destructive impact preview、WriteAuthority decision、72 小时 soft-delete TTL 和 recovery。这把 QUI-189 的 batch judge 升级成安全生产整理路径，并吸收 GBrain 的 destructive guard。

Plane split: `QUI-189 batch LLM judge`, `QUI-191F destructive guard`.

Plane 拆分：`QUI-189 batch LLM judge`、`QUI-191F destructive guard`。

### 5.4 High 4 — Memory Integrity Eval

Create a local deterministic eval lane that tests memory writes, not only retrieval. Cases should cover wrong profile writes, observation-vs-participation separation, actor attribution, concurrent writes, supersession, rollback, poisoning, no-source memory creation, and bilingual turns. Public LongMemEval/LoCoMo/BEAM remain evidence lanes, but the CI gate should be local and reproducible.

创建本地确定性 eval lane，专门测试 memory writes，而不只测 retrieval。Case 应覆盖错误画像写入、observation-vs-participation 分离、actor attribution、并发写、supersession、rollback、poisoning、无来源记忆创建和中英双语轮次。公开 LongMemEval/LoCoMo/BEAM 保持为证据 lane，但 CI gate 应本地、可复现。

Plane split: `QUI-191G memory integrity fixtures`, `QUI-191H actor attribution fixtures`.

Plane 拆分：`QUI-191G memory integrity fixtures`、`QUI-191H actor attribution fixtures`。

### 5.5 High 5 — Durable Idle Runtime

Implement `quilin-daemon` as the scheduler/control-plane worker with a durable run table, budget leases, retry/backoff, heartbeat, stale-run recovery, singleton jobs, OTel-style events, and WriteAuthority orchestration. Memory jobs, User Insight, self-evolution proposals, skill background work, token monitor, and future benchmark schedules should register as jobs rather than inventing loops.

实现 `quilin-daemon` 作为 scheduler/control-plane worker，包含 durable run table、budget leases、retry/backoff、heartbeat、stale-run recovery、singleton jobs、OTel-style events 和 WriteAuthority orchestration。Memory jobs、User Insight、自进化 proposals、skill background work、token monitor 和未来 benchmark schedules 都应注册为 jobs，而不是各自发明 loop。

Plane split: `QUI-188 idle scheduler`, `QUI-191I memory job queue`.

Plane 拆分：`QUI-188 idle scheduler`、`QUI-191I memory job queue`。

### 5.6 Medium 1 — Multi-Client + Project Scope

Add `last_writer_client`, writer actor, per-client conflict detection, and conflict UI for CLI/REPL/Web/Mac App writes. Treat current project context and `QUILIN.md` as a first-class retrieval boost signal so project memory does not bleed across repositories. This is a unique Quilin opportunity because server-only systems do not face the same four-client local-state problem.

为 CLI/REPL/Web/Mac App 写入增加 `last_writer_client`、writer actor、跨客户端冲突检测和 conflict UI。把当前项目上下文和 `QUILIN.md` 当作一等 retrieval boost signal，避免项目记忆跨仓库污染。这是 Quilin 独有机会，因为 server-only 系统不会面对同一个四客户端本地状态问题。

Plane split: `QUI-191J multi-client conflict resolution`, `QUI-191K project retrieval boost`.

Plane 拆分：`QUI-191J multi-client conflict resolution`、`QUI-191K project retrieval boost`。

### 5.7 Medium 2 — Procedural Memory Pipeline

Use self-evolution trajectories and successful repeated task patterns to create `AgentCase` records. When enough similar high-quality cases accumulate, the idle daemon proposes a `SKILL.md` candidate with activation conditions, preconditions, verification commands, expected evidence, failure cases, and provenance. Human approval through WriteAuthority remains mandatory.

用 self-evolution trajectories 和重复成功任务模式创建 `AgentCase` records。当足够多相似高质量 case 聚集时，idle daemon 生成一个 `SKILL.md` candidate，包含 activation conditions、preconditions、verification commands、expected evidence、failure cases 和 provenance。通过 WriteAuthority 的人工批准仍是强制条件。

Plane split: `QUI-191L AgentCase records`, `QUI-191M trace-to-skill proposals`.

Plane 拆分：`QUI-191L AgentCase records`、`QUI-191M trace-to-skill proposals`。

### 5.8 Medium 3 — Foresight + Predictive Warmer

Add `ForesightModel` for user commitments, future tasks, reminders, and time-bounded intentions. Then add a conservative predictive warmer: idle jobs can precompute likely next context only when a task is predictable and budget is available. This should not answer before the user asks; it should prepare evidence and cacheable context.

增加 `ForesightModel`，用于用户承诺、未来任务、提醒和有时间边界的意图。然后增加保守的 predictive warmer：只有任务可预测且预算可用时，idle jobs 才预计算可能的下一步上下文。它不应在用户提问前回答，而是准备证据和可缓存上下文。

Plane split: `QUI-191N foresight memory`, `QUI-191O predictive warmer`.

Plane 拆分：`QUI-191N foresight memory`、`QUI-191O predictive warmer`。

### 5.9 Medium 4 — Salience + Taxonomy

Replace scalar importance with a small vector such as novelty, utility, personal relevance, actionability, recency, and stability. Add orthogonal memory types such as user, feedback, project, reference, pattern, bug, workflow, foresight, and resource. Add Claude Code-style staleness rendering: "47 days ago" plus system-reminder wrapping for old memories.

把单一 importance 替换成小向量，例如 novelty、utility、personal relevance、actionability、recency 和 stability。增加与 layer 正交的 memory types，例如 user、feedback、project、reference、pattern、bug、workflow、foresight 和 resource。增加 Claude Code 风格过期感知：`47 days ago` 字符串和旧记忆的 system-reminder wrapper。

Plane split: `QUI-191P multidimensional importance`, `QUI-191Q memory type taxonomy`, `QUI-191R staleness perception`.

Plane 拆分：`QUI-191P multidimensional importance`、`QUI-191Q memory type taxonomy`、`QUI-191R staleness perception`。

### 5.10 Low — Portability + Resource UX

Add reverse Soul Export so Quilin can export curated memories back to Claude Code, OpenClaw, Hermes, Codex, Gemini CLI, and OpenCode formats. Add a Web provenance visualizer after provenance/version data exists. Reserve ResourceStore/resource_pointer fields for screenshots, PDFs, images, and future multimodal memory, but do not prioritize full multimodal indexing until real user demand appears.

增加反向 Soul Export，让 Quilin 能把精选记忆导出回 Claude Code、OpenClaw、Hermes、Codex、Gemini CLI 和 OpenCode 格式。在 provenance/version 数据存在后增加 Web provenance visualizer。为截图、PDF、图片和未来多模态记忆预留 ResourceStore/resource_pointer 字段，但在真实用户需求出现前不优先做完整多模态索引。

Plane split: `QUI-191S reverse Soul Export`, `QUI-191T provenance visualizer`, `QUI-191U resource pointer schema`.

Plane 拆分：`QUI-191S reverse Soul Export`、`QUI-191T provenance visualizer`、`QUI-191U resource pointer schema`。

## 6. Consensus

Current consensus: Quilin should stay local-first, not cloud-first; should preserve raw evidence before semantic extraction; should use WriteAuthority for consequential memory mutations; should treat benchmark scores as evidence rather than product goals; should implement durable idle scheduling instead of provider-local loops; should make procedural memory flow through 13-skills; and should use project/user/soul artifacts as first-class memory surfaces.

Current consensus：Quilin 应保持 local-first，而不是 cloud-first；应先保留原始证据，再做 semantic extraction；有后果的 memory mutation 必须走 WriteAuthority；benchmark 分数是证据，不是产品目标；应实现 durable idle scheduling，而不是 provider-local loops；procedural memory 应流经 13-skills；project/user/soul artifacts 应成为一等记忆界面。

Both agents also agree that "perfect memory" is not one more retriever. It is a governed lifecycle: capture, prove, retrieve, reason, consolidate, correct, rollback, export, and evaluate.

双方也同意，“完美记忆”不是再加一个 retriever，而是完整受治理生命周期：capture、prove、retrieve、reason、consolidate、correct、rollback、export 和 evaluate。

## 7. Claude 独有视角 / Claude-Unique View

Claude's strongest additions are operational and product-shaped. It surfaced Codex's production job queue as a concrete reference for idle leasing, Claude Code's staleness prompt UX, GBrain's destructive guard, Letta's git-backed memory blocks, EverOS's FORESIGHT and AgentCase→AgentSkill model, TencentDB's `prependContext` vs `appendSystemContext`, and the strategic value of reverse Soul Export and four-client conflict resolution.

Claude 最强的补充是运维和产品形态。它把 Codex 的 production job queue 作为 idle lease 参考，把 Claude Code 的 staleness prompt UX、GBrain 的 destructive guard、Letta 的 git-backed memory blocks、EverOS 的 FORESIGHT 与 AgentCase→AgentSkill、TencentDB 的 `prependContext` vs `appendSystemContext`，以及 reverse Soul Export 和四客户端冲突解决的战略价值都提了出来。

My view is that Claude's highest-signal unique insight is portability: if Quilin can import from other agents and export back to them, it becomes the user's memory portability layer rather than another closed assistant.

我的判断是，Claude 独有视角里最高价值的是 portability：如果 Quilin 既能从其他 agent 导入，也能导出回它们，它就成为用户的 memory portability layer，而不只是另一个封闭 assistant。

## 8. Codex 独有视角 / Codex-Unique View

Codex's strongest additions are safety and measurement-shaped. It emphasized non-LLM raw evidence, write-integrity benchmarks, participation-vs-observation scoring, actor-scoped provenance, low-confidence retrieval rejection, and trace-to-skill compilation with verification. It also challenged the instinct to add more memory layers, arguing that evidence, time, authority, and eval matter more than tier count.

Codex 最强的补充是安全和评测形态。它强调非 LLM 原始证据、write-integrity benchmark、participation-vs-observation scoring、actor-scoped provenance、low-confidence retrieval rejection，以及带验证的 trace-to-skill compilation。它也明确反对为了层级而加层级，认为 evidence、time、authority 和 eval 比 tier count 更重要。

My independent view is that Codex's highest-signal unique insight is write integrity. Retrieval benchmarks are not enough; a memory system can pass recall tests while silently corrupting user identity, project constraints, or procedural rules.

My independent view is，Codex 独有视角里最高价值的是 write integrity。只测 retrieval benchmark 不够；一个 memory system 可以通过 recall 测试，却静默污染用户身份、项目约束或流程规则。

## 9. Disagree / 给用户拍板的冲突点

1. **How soon to build ResourceStore**: Claude sees multi-modal Resource Memory as a schema direction now; Codex sees it as lower priority until real screenshot/PDF/image demand appears. Proposed decision: reserve `resource_pointer` now, defer full multimodal indexing.
2. **How aggressive predictive warming should be**: Claude leans toward sleep-time predictive compute; Codex worries about cost and false assumptions. Proposed decision: allow evidence/cache warming only, no proactive answer generation.
3. **How much git-style memory to expose**: Claude values time-travel/debug UX; Codex wants version/evidence first. Proposed decision: implement version chain and snapshots first, expose `memory_checkout(at)` only after eval proves correctness.
4. **How broad provider/export support should be in v1**: Claude sees reverse export as strategic high priority; Codex sees safety/evidence as prerequisite. Proposed decision: design export contract now, implement after versioned provenance exists.
5. **How many memory types to add**: Claude cites 7-8 type taxonomies; Codex warns against taxonomy sprawl. Proposed decision: keep 4 layers, add orthogonal `type` only where retrieval/gate/eval behavior changes.

1. **ResourceStore 多早做**：Claude 认为 multi-modal Resource Memory 现在就应影响 schema；Codex 认为在真实 screenshot/PDF/image 需求出现前优先级较低。建议拍板：现在预留 `resource_pointer`，完整多模态索引延后。
2. **predictive warming 多激进**：Claude 倾向 sleep-time predictive compute；Codex 担心成本和错误假设。建议拍板：只允许 evidence/cache warming，不主动生成未被请求的答案。
3. **git-style memory 暴露到什么程度**：Claude 看重 time-travel/debug UX；Codex 想先做 version/evidence。建议拍板：先实现 version chain 和 snapshots，`memory_checkout(at)` 等 eval 证明正确后再暴露。
4. **v1 provider/export 支持多广**：Claude 认为 reverse export 是战略高优；Codex 认为安全/证据是前置。建议拍板：现在设计 export contract，等 versioned provenance 存在后实现。
5. **memory types 加多少**：Claude 引用 7-8 type taxonomies；Codex 警惕 taxonomy sprawl。建议拍板：保留 4 layers，只在检索、门禁、评测行为不同的地方添加正交 `type`。

## 10. 下一步 / Actionable Next Steps

Create Plane epic **QUI-191 完美记忆系统 v2 / Perfect Memory System v2**. The epic acceptance should require that no memory mutation path bypasses provenance, versioning, safety gates, and local deterministic evaluation.

创建 Plane epic **QUI-191 完美记忆系统 v2 / Perfect Memory System v2**。Epic acceptance 应要求：任何 memory mutation path 都不得绕过 provenance、versioning、safety gates 和本地确定性评测。

Suggested sub-issues:

建议子 issue：

| Issue | Scope | Priority |
|---|---|---|
| QUI-191A | Evidence store + raw observation receipts | High |
| QUI-191B | Memory version chain + supersession read model | High |
| QUI-191C | Memory integrity local eval lane | High |
| QUI-191D | Low-confidence rejection + consensus retrieval gate | High |
| QUI-191E | Batch LLM consolidation + destructive guard | High |
| QUI-191F | Durable idle job queue under `quilin-daemon` | High |
| QUI-191G | Actor/client-scoped provenance + multi-client conflict detection | Medium |
| QUI-191H | Trace-to-skill maturity pipeline | Medium |
| QUI-191I | Foresight memory + conservative predictive warmer | Medium |
| QUI-191J | Reverse Soul Export + provenance visualizer + resource pointer schema | Low |

First-week milestone:

第一周 milestone：

1. Implement or spec-freeze the evidence/version schema and migration plan.
2. Land the batch consolidation plan with destructive guard acceptance.
3. Build the memory integrity fixture lane before expanding public benchmark work.

1. 实现或冻结 evidence/version schema 与 migration plan。
2. 落地 batch consolidation plan 和 destructive guard 验收。
3. 在扩大公开 benchmark 前，先建 memory integrity fixture lane。

The first week should end with a measurable gate: a seeded bad memory cannot become trusted profile/procedural memory, a superseded user identity does not remain active, a batch dedupe proposal can be traced to raw evidence, and a low-confidence recall causes abstention or clarification rather than hallucination.

第一周结束时应有可测 gate：种子恶意记忆不能变成可信 profile/procedural memory；被替换的用户身份不会继续 active；batch dedupe proposal 能追溯到 raw evidence；低置信召回会触发拒答或澄清，而不是幻觉回答。
