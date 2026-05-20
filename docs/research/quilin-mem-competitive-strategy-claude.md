# quilin-mem 竞品全景调研与"打爆"升级路线 / Competitive Landscape & Upgrade Roadmap

> Independent Claude research, parallel with Codex. Cross-perspective diff to be reconciled in §6.
>
> 独立的 Claude 调研报告,与 Codex 并行进行。两份报告差异将在第 6 节交叉对齐。

> **Author**: Claude subagent · **Date**: 2026-05-21 · **Scope**: 14 agent-memory repos (10 in `~/repo/mem/`, 4 in `~/repo/`)
>
> **作者**:Claude 调研 subagent;**日期**:2026-05-21;**调研范围**:14 个 agent 记忆仓库(`~/repo/mem/` 下 10 个 + `~/repo/` 下 4 个)。

---

## 一、总览 / Overview

The 14 repos surveyed split into four families by deployment shape and design intent:
**(a) Library / SDK** — drop-in Python or TypeScript packages: `mem0`, `agentmemory`, `MemMachine` (client), `claude-mem` (TS multi-tenant);
**(b) Standalone Service** — long-running server with HTTP / MCP / gRPC: `letta`, `mempalace`, `MemMachine` (server), `zep` (cloud SaaS shell + Graphiti reference), `gbrain` (PGLite + serve --http);
**(c) Plugin Provider** inside an existing agent harness: `hermes-agent/plugins/memory/*` (8 plugins including `mem0`, `supermemory`, `honcho`, `byterover`, `retaindb`, `holographic`, `openviking`, `hindsight`);
**(d) Vendor / Domain-Specific** with bundled infra opinion: `EverOS` (FastAPI + multi-DB), `TencentDB-Agent-Memory` (Tencent Cloud VectorDB), `gbrain` (YC Garry Tan, brand-new project);
**(e) Native Harness Memory** baked into the agent runtime: `codex/codex-rs/state/src/runtime/memories.rs` (two-stage SQLite job queue), `openclaw/extensions/memory-core/*` (sleep / dreaming metaphor), `claude-code/src/memdir/*` (4-type taxonomy markdown files).

14 个 repo 按部署形态和设计意图分为四大族 + 一个特殊族:
**(a) 库 / SDK**——可直接 `import` 的 Python 或 TypeScript 包:`mem0`、`agentmemory`、`MemMachine` 的 client、`claude-mem` 的 TS 多租户包;
**(b) 独立服务**——常驻 server,通过 HTTP / MCP / gRPC 暴露能力:`letta`、`mempalace`、`MemMachine` 的 server、`zep`(云 SaaS 壳子 + Graphiti 参考实现)、`gbrain`(PGLite + `serve --http`);
**(c) 插件 Provider**——挂在已有 agent harness 内的插件,典型如 `hermes-agent/plugins/memory/*`,一个 harness 里挂 8 个 memory plugin(mem0 / supermemory / honcho / byterover / retaindb / holographic / openviking / hindsight);
**(d) 厂商 / 领域定制**——带强基础设施倾向:`EverOS`(FastAPI + 多数据库)、`TencentDB-Agent-Memory`(腾讯云向量库)、`gbrain`(YC Garry Tan 新项目,2026 年 5 月仍在 v0.37 迭代);
**(e) 嵌入 Harness 的原生记忆层**——直接长在 agent runtime 里:`codex/codex-rs/state/src/runtime/memories.rs`(SQLite 两阶段 job queue)、`openclaw/extensions/memory-core/*`(睡眠 / 做梦隐喻)、`claude-code/src/memdir/*`(4 类型 + markdown 文件)。

The most important cross-cutting observation is that **the field has moved beyond "LongMemEval %"** — Graphiti is at 71.2%, Mem0 v2 at 93.4%, MemPalace raw mode at 96.6%, AgentMemory at 96.2%. The frontier in 2026 is **operational** (production multi-tenant safety, audit, soft-delete TTL, blast-radius preview, two-stage job queue with stale-job stealing, plugin orchestration, multi-modality, prompt-cache-friendly assembly), not "another retrieval algorithm". Quilin-mem already covers about 60% of the algorithmic axis; the upgrade opportunities are concentrated on the operational / safety / multi-client axes — exactly where 4-client (CLI / REPL / Web / Mac App) Quilin can pull away.

最关键的横截面观察是:**业界已经走过了"LongMemEval 分数"内卷阶段**——Graphiti 71.2%、Mem0 v2 93.4%、MemPalace raw mode 96.6%、AgentMemory 96.2%,前沿已不再是"再发明一个检索算法"。2026 年的前沿是**工程化层面**:生产级多租户安全、审计、软删除 TTL、删除前爆炸半径预览、两阶段任务队列 + 过期 job 抢占、插件编排、多模态、prompt-cache 友好的组装顺序。quilin-mem 在算法轴已经覆盖约 60%,升级空间集中在**工程化 / 安全 / 多客户端轴**——这恰好是 quilin 4 客户端(CLI / REPL / Web / Mac App)的天然主场。

---

## 二、逐个 repo 分析 / Per-Repo Analysis

### 2.1 mem0ai/mem0 — Library, V3 Phased Batch Pipeline

**Architecture / 架构**: Python library exposing `Memory` and `AsyncMemory` classes (`mem0/memory/main.py:331` 同步, `:1795` 异步; main.py 共 `wc -l 3222` 行). Single-table model in vector store (no separate working / episodic / semantic tier — flat list scoped by `(user_id, agent_id, run_id)`). The `add()` method is the central pipeline (`mem0/memory/main.py:573-971`): Phase 0 context gathering → Phase 1 existing memory retrieval (top-10 vector search on parsed messages) → Phase 2 **single LLM extraction call** with UUID-to-integer mapping for anti-hallucination (`main.py:716-721`) → Phase 3 batch embed → Phase 4-5 hash dedup (md5 of content vs `existing_hashes`, `main.py:786-803`) → Phase 6 batch persist → Phase 7 **global entity dedup with batch search + entity store upsert** (`main.py:866-955`) → Phase 8 history audit. Retrieval (`main.py:1126-1237`) goes through `_search_vector_store` with optional reranker (`main.py:1230-1235`) and a rich filter operator language (`AND`/`OR`/`NOT`/`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`nin`/`contains`/`icontains`/`*`, `main.py:1239-1314`).

架构:Python 库,导出 `Memory`(同步)和 `AsyncMemory`(异步)两个类。Vector store 是单表扁平模型(没有 working/episodic/semantic 多 tier),通过 `(user_id, agent_id, run_id)` 三元组做 scope。`add()` 是核心 8 阶段流水线:取上下文 → 取已有相似记忆 → **单次 LLM 抽取**(用 UUID→int 映射防幻觉) → 批 embed → md5 hash 去重 → 批写入 vector store → **全局 entity 去重 + entity store upsert** → audit history。检索叠加 `AND/OR/NOT + 10 种比较操作符` 的高级元数据过滤。

**Unique selling points / 独特卖点**:
- 17+ vector backends(faiss/qdrant/pgvector/chroma/redis/milvus/pinecone/weaviate/turbopuffer/opensearch/cassandra/valkey/elasticsearch/s3_vectors/azure_mysql/baidu/mongodb)+ 5 rerankers(cohere/hf/llm/zero_entropy/sentence_transformer)
- 抗幻觉 UUID→int 映射:LLM 看到 0, 1, 2 这种整数 ID,看不见真 UUID,杜绝伪造 ID
- Procedural Memory 独立支持(`_create_procedural_memory`, `main.py:1618-1655`)
- Per-memory **history audit log**:每次 UPDATE / DELETE 都进 history 表,带 `prev_value / new_value / actor_id / role / is_deleted` ;mem0 在更新时还做 **entity store cleanup → re-link**(`main.py:1717-1718`)

**What we can learn / 不能学**:Phase 0-8 流水线 + UUID→int 抗幻觉 + 高级 filter operators 全部值得吸收。**不学的部分**:扁平 single-table 模型对长会话不够友好(没 working tier 概念),`infer=True` 默认每条 add 都跑一次 LLM,成本不可接受;不学 17 个 vector backend 适配(quilin 只用 SQLite + FTS5 已足够,backend 矩阵是商业卖点)。

---

### 2.2 letta-ai/letta — Service, Virtual Context with Block + Git + Archive

**Architecture / 架构**: Python FastAPI server (`letta/letta/server/*`), Postgres + SQLAlchemy ORM, **Block-based core memory**(`letta/schemas/block.py:67`)— each Block is a first-class entity with `value / limit (CORE_MEMORY_BLOCK_CHAR_LIMIT) / read_only / label / tags / template_id / preserve_on_migration / base_template_id` (15+ 字段). Default blocks are `Human` and `Persona` (`block.py:117, 124`). The `Memory` schema (`letta/schemas/memory.py:68`) holds an ordered list of blocks plus `file_blocks` and an `agent_type` (which controls prompt rendering). Letta 2026 ships **two breakthroughs**:
- **Git-backed memory** (`letta/services/block_manager_git.py:30`, 596 行): when agent has the `git-memory-enabled` tag (`block_manager_git.py:27`), all writes go to **GCS (object storage) as source of truth → PostgreSQL as cache**, providing full version history. `enable_git_memory_for_agent` / `disable_git_memory_for_agent` (`block_manager_git.py:359, 485`). This implements "Context Repositories" — you can `git checkout` to a previous memory state.
- **Named shared Archives** (`letta/services/archive_manager.py:30`, 718 行): an Archive is a named, multi-agent-attachable collection of vector passages. `list_archives_async(agent_id=...)` (`archive_manager.py:103`) supports `before/after/limit/ascending/name`-filtered cursor pagination. Multiple agents can mount the same Archive (`ArchivesAgents` join table) — shared long-term knowledge base.

架构:Python FastAPI server,Postgres + SQLAlchemy ORM。核心创新是 **Block 作为一等公民**(15+ 字段:value/limit/read_only/label/tags/template_id/preserve_on_migration),默认两个 Block 是 Human + Persona,Letta 2026 两个重大特性:**git-backed memory**(GCS 是 source of truth,PostgreSQL 是 cache,完整版本历史,可 git checkout 历史记忆状态)+ **Named Archives**(多个 agent 可挂载同一个 Archive 共享 vector passages,带 cursor pagination)。

**Unique selling points / 独特卖点**:
- **Memory Template System**:Block 带 `template_id / template_name / base_template_id / deployment_id / entity_id / preserve_on_migration` —— 用户可发布 Memory Template 复用(类似 dotfiles share)
- `git_enabled` 时 prompt rendering 用 `system/human` 前缀,**显式区分 system-owned 与 user-owned blocks**
- `validate_file_blocks_no_duplicates` field validator(`memory.py:84-104`)— 工程纪律
- `agent_type` 控制 prompt 渲染(`memory.py:75`)— 多 agent 类型共享同一套 schema

**What we can learn / 不能学**:**Block as first-class entity 完全值得借鉴**——quilin 的 Working Memory 现在是 deque,如果改成 Block 集合可以做 read_only / template / per-block char limit;**Git-backed memory + Archive 是 Iter G-H 的目标灵感**(对应 quilin 现已规划的 verbatim 冷热归档,但 git 是更工程化的版本控制方案)。**不学的部分**:整套 Postgres + Alembic + Pydantic ORM 太重(248k LOC 半个生态);GCS hard dependency 不可接受;不需要内嵌 OpenAI SDK 类型(`memory.py:12` import `openai.types.beta.function_tool.FunctionTool`)。

---

### 2.3 getzep/zep — Cloud SaaS Shell + Graphiti Reference

**Architecture / 架构**: Repo 实际是 Zep Cloud 的开源外壳——SDK examples + ontology + eval harness + Go legacy 桥(`zep/legacy/src/setup_ce.go`),核心 Zep server 闭源跑在云端。Pythonic interaction is through `zep_cloud.client.Zep` SDK (`examples/python/simple.py`). The Open Ontology system (`zep/ontology/default_ontology.py`) is the most valuable artifact: 9 default entity types (User / Assistant / Preference / Location / Event / Object / Topic / Organization / Document) + 2 default edge types (LocatedAt / OccurredAt). **Preference is marked as highest-priority classification** ("IMPORTANT: Prioritize this classification over ALL other classifications except User and Assistant", `default_ontology.py:24-30`). Users can define **custom EntityModel / EdgeModel** as Pydantic classes with typed fields (`examples/python/advanced.py:14-90`: Person / Destination / Accommodation / Experience / TravelService / Visits / StaysAt / Participates / Books). Behind the scenes, Zep Cloud uses Graphiti for temporal KG with bi-temporal edges.

架构:Repo 本身是 Zep Cloud 的开源外壳,核心 server 闭源在云端。最有价值的产物是 **Open Ontology** ——9 个默认 entity type(User / Assistant / Preference / Location / Event / Object / Topic / Organization / Document)+ 2 个默认 edge type(LocatedAt / OccurredAt),**Preference 被显式标记为最高优先级**(只低于 User 和 Assistant)。用户可通过继承 `EntityModel` / `EdgeModel` 定义自己的领域 schema(travel:Person / Destination / Accommodation / Experience / TravelService + Visits / StaysAt / Participates / Books),后端用 Graphiti 跑时序 KG。

**Unique selling points / 独特卖点**:
- **类型化 EntityModel + EdgeModel** 让用户用 Pydantic 定义业务领域 KG schema —— 这是 quilin 当前 KG 没有的领域扩展点
- **9 + 2 default ontology** 是一个非常合理的"开箱即用就够用 80% 业务"的 schema
- **Preference 强优先级**的设计哲学:用户偏好是最重要的记忆类别

**What we can learn / 不能学**:**Ontology 设计 + Preference 优先级**完全值得借鉴,可直接吸收为 quilin KG 的默认 schema。**不学的部分**:不依赖 Zep Cloud SaaS;不引入 Graphiti `import graphiti_core`(D-20 已决策放弃);不要走整套 SDK + cloud-only 路线。

---

### 2.4 letta 衍生:Letta agents are also referenced by hermes-agent — see 2.6.

---

### 2.5 MemPalace — Verbatim, "No Summaries. Ever."

**Architecture / 架构**: Python package (`mempalace/mempalace/*`, 23.5k LOC, 见 `wc -l` 顶 5:mcp_server.py 2751 + repair.py 1583 + cli.py 1570 + miner.py 1396 + dialect.py 1091)。Chroma vector store as backend (`palace.py:47` `_DEFAULT_BACKEND = ChromaBackend()`)。Hierarchical model: **Wing → Hall → Room → Closet → Drawer** —— **drawer 是 verbatim chunk,完全不压缩**(`miner.py:7` "Stores verbatim chunks as drawers. No summaries. Ever.")。Two collection layers: `mempalace_drawers`(verbatim chunks)+ `mempalace_closets`(searchable index layer,`palace.py:77`)。`NORMALIZE_VERSION = 2`(`palace.py:57`)做 schema migration —— 当 normalization pipeline 升级时,旧 drawer 自动被识别为 "not mined" 重新 mine。

架构:Python 包,Chroma 向量库作后端。层次模型 Wing → Hall → Room → Closet → Drawer,**drawer 是 verbatim chunk,完全不做摘要**。两层 collection:drawers(原文)+ closets(检索索引)。带 `NORMALIZE_VERSION` 做版本化迁移——normalization pipeline 升级时旧 drawer 自动被标记为 not mined 重 mine。

**Unique selling points / 独特卖点**:
- **96.6% LongMemEval raw mode** —— 当前 SOTA
- "No summaries. Ever." 哲学 —— 完全消除信息损失风险
- `repair.py` 1583 行(三大文件之一)—— 把损坏 / 漂移的 drawers 自动修复,**这是 quilin 没有的运维能力**
- Wing/Hall/Room 隐喻易理解,5 天爆发 19.5k stars(2026-04)
- spellcheck.py / dialect.py / convo_scanner.py —— 全面针对 conversation log 做语义清洗(quilin 没有)

**What we can learn / 不能学**:**NORMALIZE_VERSION 自动迁移机制** 完全值得借鉴(quilin store_schema.py 升级时手动迁移),**repair.py 自动修复** 是 production-grade 运维能力,**spellcheck + dialect 清洗** 对 quilin 中英混合输入特别值得。**不学的部分**:Wing/Hall/Room 隐喻虽然好看但增加 agent 认知负担,quilin 已经用 layer 1-4 已经够;"no summaries ever" 在长会话场景下会爆炸,quilin 的 episodic 压缩仍然必要。

---

### 2.6 hermes-agent/plugins/memory — Multi-Provider Plugin Architecture

**Architecture / 架构**: `agent/memory_manager.py:190` `MemoryManager` 类(555 行)实现了 **builtin + at most 1 external** 的多 provider 编排架构。Each provider implements `MemoryProvider` ABC with 6 methods: `system_prompt_block()` / `prefetch()` / `queue_prefetch()` / `sync_turn()` / `get_tool_schemas()` / `handle_tool_call()` / `on_turn_start()`。`MemoryManager` 做 fan-out 调用 + tool name 冲突检测 (`memory_manager.py:236-243`)。8 plugins shipped:
- `hindsight/__init__.py` 1747 行 —— reflect/retain/recall 三核操作
- `retaindb/__init__.py` 766 行 —— RetainDB cloud + **dialectic synthesis** + Agent self-model from SOUL.md prefetched each turn
- `openviking/__init__.py` 938 行 —— L0/L1/L2 filesystem hierarchical
- `holographic/holographic.py` 203 行 —— Holographic Reduced Representations (HRR) with phase encoding (Plate 1995, Gayler 2004)
- `honcho/__init__.py` 1328 行 —— peer cards + dialectic Q&A
- `byterover/__init__.py` 383 行 —— `brv` CLI + hierarchical context tree
- `mem0/__init__.py` 373 行 —— mem0 adapter
- `supermemory/__init__.py` 791 行 —— supermemory adapter

架构:`MemoryManager` 实现 builtin + 最多 1 个 external 的多 provider 架构,每个 provider 实现 6 个 ABC 方法(system_prompt_block / prefetch / sync_turn / on_turn_start 等),MemoryManager 做 fan-out + tool name 冲突检测。挂了 8 个 plugin,覆盖不同设计哲学(hindsight 三核 reflect/retain/recall、retaindb 云 + SOUL.md prefetch、openviking L0/L1/L2 文件分层、holographic HRR 相位编码、honcho peer cards、byterover CLI 上下文树、mem0、supermemory)。

**Unique selling points / 独特卖点**:
- **Plugin orchestration 模型**:一个 harness 同时挂多个 memory provider,失败不阻塞,tool name 冲突自动检测
- **RetainDB dialectic synthesis**:每轮 prefetch 用 LLM 合成用户理解
- **Holographic HRR**(`holographic.py:43-108`):用 SHA-256 deterministic phase encoding + bind/unbind/bundle 代数 —— 跨进程 / 机器 / 语言确定可复现(`encode_atom` 用 SHA-256 而非 numpy RNG)

**What we can learn / 不能学**:**Plugin architecture + tool name 冲突检测 + builtin/external 二分** 可借鉴成 quilin 第二阶段 memory provider 接口,让用户挂自己喜欢的外部 provider。**RetainDB dialectic synthesis 每轮 prefetch 用 LLM 合成用户画像** 值得借鉴(对应 quilin Iter K 计划但更激进)。**不学**:HRR 是研究方向,工程价值低;byterover 强依赖外部 CLI,quilin 已经走 MCP stdio 不重复造轮子;8 个 plugin 全挂的复杂度对单产品过度。

---

### 2.7 codex/codex-rs/state/src/runtime/memories.rs — Production Job Queue

**Architecture / 架构**: Rust + SQLx + SQLite,memories.rs 单文件 **4715 行**(惊人体量)。Two-stage memory consolidation pipeline:
- **Stage 1**(per-thread): `try_claim_stage1_job` (`:478`) → 提取 `raw_memory + rollout_summary` → `mark_stage1_job_succeeded` (`:665`)
- **Stage 2**(global): `enqueue_global_consolidation` (`:866`) → `try_claim_global_phase2_job` (`:883`) → `heartbeat_global_phase2_job` (`:1020`) → `mark_global_phase2_job_succeeded` (`:1056`)
- **Stale job stealing**: test `stage1_running_stale_can_be_stolen_but_fresh_running_is_skipped` (`:1378`) — 过期 running job 可被抢占,新鲜的不能
- **Running cap enforcement**: `stage1_concurrent_claims_respect_running_cap` (`:1501`) 、`claim_stage1_jobs_enforces_global_running_cap` (`:1938`) — 防 LLM 并发打爆
- **Pollution detection**: `mark_thread_memory_mode_polluted` (`:419`)

架构:Rust + SQLite,memories.rs 单文件 4715 行,实现两阶段记忆 consolidation 任务队列(Stage 1 per-thread + Stage 2 全局),支持 heartbeat / stale running job 被抢占 / 新鲜 running 跳过 / global + per-thread running cap 限流 / pollution detection,完全 production-grade。

**Unique selling points / 独特卖点**:
- **完整的分布式 job queue**:`try_claim` + `heartbeat` + `mark_succeeded` + `mark_failed` + `mark_failed_if_unowned` —— 接近 Sidekiq / RQ / Borg 的 job 抢占语义
- **Stage1 → Stage2 严格分阶段**:thread 级提取后,全局 phase2 才做跨 thread consolidation(避免互相干扰)
- **Pollution mode**:一旦 thread 记忆模式被污染,后续 stage1 跳过该 thread
- **Tests-as-spec**:测试名直接描述行为(stale_can_be_stolen / fresh_running_skipped / running_cap_enforced / processes_two_full_batches_across_startup_passes)

**What we can learn / 不能学**:**Two-stage job queue + heartbeat + stale stealing + running cap** 完全是 quilin idle_evolution 缺的工程化基建——现在 quilin `idle_budget.py` 107 行只是个 daily token budget 框架,没有 job queue / heartbeat / stale 概念。**不学**:Rust + SQLx 重写不现实(quilin 是 Python provider),但 Python 用 `asyncio.Task` + SQLite `WHERE locked_at < now() - interval`-style query 完全可以复刻同样语义,只是 LOC 会比 codex 小很多。

---

### 2.8 openclaw/extensions/memory-core — Sleep / Dreaming Metaphor

**Architecture / 架构**: TypeScript extensions,核心文件 `dreaming.ts` 788 行 + `short-term-promotion.ts` 1884 行 + `rem-evidence.ts` 1077 行。实现"睡眠驱动 memory consolidation":
- **Light sleep**(legacy): 浅整理
- **REM sleep**(legacy): 深度整理
- **Deep dreaming**(current): 通过 cron job 驱动(`MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion"`, `dreaming.ts:34`)
- **System event token**(`__openclaw_memory_core_short_term_promotion_dream__`)做 cron 内部信号
- **Short-term promotion**(1884 行):把 short-term memory 候选升级到 long-term,依赖 `applyShortTermPromotions / repairShortTermPromotionArtifacts / rankShortTermPromotionCandidates`
- **REM evidence**(1077 行):证据收集(为什么这条 memory 应该 promote)

架构:TypeScript extension,用"睡眠"隐喻驱动 memory consolidation——light sleep / REM sleep / deep dreaming 三阶段,通过 cron job 调度,带 system event token 内部信号,short-term-promotion 1884 行做候选升级 + 修复 + 排序,rem-evidence 1077 行做证据收集。

**Unique selling points / 独特卖点**:
- **Cron-driven dreaming** + 明确 `MANAGED_BY` cron tag —— 可独立管理 / 升级 / 禁用
- **Heartbeat isolated session suffix**(`HEARTBEAT_ISOLATED_SESSION_SUFFIX = ":heartbeat"`, `dreaming.ts:42`)—— heartbeat 不污染主 session
- 区分 dream / dream-narrative / dream-markdown(三个独立文件: dreaming.ts / dreaming-narrative.ts / dreaming-markdown.ts)— **三关注点分离**(执行 / 叙事化输出 / markdown 渲染)

**What we can learn / 不能学**:**Heartbeat isolated session** 概念可直接借鉴(quilin idle evolution 时如何隔离不污染 main thread)。**Cron-managed dreaming**(用户可看到 cron 是 managed_by memory-core,可自行启停)是非常友好的 UX。**不学**:**sleep metaphor 是 hype**,工程上没必要包装,直接叫 consolidator-level-N 就够,而且 quilin 已经用 idle_evolution 这个名字。

---

### 2.9 claude-code/src/memdir — 4-Type Markdown Taxonomy

**Architecture / 架构**: TypeScript module in Claude Code 主仓 `src/memdir/`(8 文件)。Filesystem-only persistence(每条 memory 是一个 markdown 文件 with YAML frontmatter)。**4-type taxonomy**(`memoryTypes.ts:16-21`):
- `user` — 用户的角色、目标、知识(always private)
- `feedback` — 用户给的指令性反馈(default private, team 仅项目级约定)
- `project` — 项目特定上下文(strongly team-biased)
- `reference` — 任何其他参考材料
Memory files 自带 `scope: private | team`(`teamMemPaths.ts`, `teamMemPrompts.ts`)。**Memory age perception**(`memoryAge.ts:15-20`)把 mtime 转成 `"47 days ago"` 字符串(因为 LLM 处理 ISO timestamp 差,看不出 stale)。**Freshness caveat**(`memoryAge.ts:33-42`)对 >1 天的 memory 自动加 `<system-reminder>This memory is N days old. ...</system-reminder>` wrapper。

架构:TypeScript 模块,每条 memory 是 markdown 文件 + YAML frontmatter,纯文件系统持久化。4 种 type(user / feedback / project / reference),每条带 scope(private / team)。最巧的是 `memoryAge.ts` 把 mtime 转成 `"47 days ago"` 字符串(LLM 对 ISO timestamp 不敏感),对 >1 天的 memory 自动加 `<system-reminder>` 提示"这是 N 天前的快照,不要当事实断言"。

**Unique selling points / 独特卖点**:
- **"47 days ago" 字符串化 timestamp** + **automatic staleness `<system-reminder>` wrapping** —— 这是 prompt engineering 与 memory 的工程化结合,quilin 完全没有
- **`when_to_save` / `how_to_use` / `body_structure` XML self-describing prompt**(`memoryTypes.ts:42-69`)—— LLM 读 prompt 就知道这条 memory 该怎么写 / 怎么用 / 应该长什么样
- **4-type 纯 markdown taxonomy** —— 完全人类可读,VCS 友好

**What we can learn / 不能学**:**"N days ago" 字符串化 + staleness system-reminder + when_to_save/how_to_use XML self-doc** 三条完全值得立刻吸收,工时低、收益高。**不学**:**纯 filesystem 不要 vector store** 对 quilin 检索精度是降级;**只在 markdown 文件层做 memory** 错失了 KG / Verbatim / Skill 等结构化能力。但 **xxx.md → quilin-mem 互操作**是巨大商机(quilin 已经做了 user.md sync,但 reverse direction 没做完——agent 写完 memory 后能 export 成 claude-code 兼容的 markdown 让用户 git-track)。

---

### 2.10 EverMind-AI/EverOS — Memory OS with 8 Memory Types

**Architecture / 架构**: Python FastAPI + Postgres + MongoDB + ES + Milvus(`devops_scripts/data_fix/*` 含 `es_sync_episodic_memory_docs.py` + `milvus_sync_episodic_memory_docs.py` + `mongo_fix_episodic_memory_missing_vector.py`)—— 多数据库混合存储。LOC 188k 是 5 个调研项目里最大。Core abstraction `MemoryType` enum(`api_specs/memory_models.py:78-101`)定义 **8 types**:
- `PROFILE` — 用户画像
- `EPISODIC_MEMORY` — 情景记忆
- `FORESIGHT` — **前瞻性记忆 / prospective memory**(独有!)
- `ATOMIC_FACT` — 原子事实(细粒度检索单元)
- `RAW_MESSAGE` — 原始未处理消息
- `AGENT_MEMORY` — agent 记忆(umbrella)
- `AGENT_CASE` — Agent 经验(task_intent + approach + quality_score)
- `AGENT_SKILL` — 可复用 skill(从 cluster of cases 提炼,带 `maturity_score`)

`RetrieveMethod` enum(`memory_models.py:69-75`)定义 4 种检索:`keyword / vector / hybrid / **agentic**(LLM-guided multi-round)`。`AgentSkillModel`(`memory_models.py:373-394`)有 `confidence + maturity_score + agent_case_ids`(skill ← cluster of cases)。

架构:Python FastAPI + 多数据库(Postgres / MongoDB / ES / Milvus)混合存储,LOC 188k(本次调研最大)。**8 种 memory type 含独有的 FORESIGHT(前瞻性记忆 / 用户已承诺要做但还未做的事)+ ATOMIC_FACT(细粒度事实)+ AGENT_CASE(单次经验)→ AGENT_SKILL(从 case cluster 提炼,带 maturity_score)**。4 种 retrieval method 含 **agentic(LLM-guided multi-round)**。

**Unique selling points / 独特卖点**:
- **FORESIGHT 类型独有**:`ForesightModel(content, foresight, start_time, end_time, duration_days, evidence)` —— "user 承诺 周五前 deploy" 这种事 quilin 还没建模
- **ATOMIC_FACT 子粒度**:从 episodic 抽取的细粒度事实,挂 `parent_type / parent_id` 反向链
- **AgentCase → AgentSkill 二级抽象**:case 是一次经验,skill 是 cluster 提炼,带 `maturity_score`(0.6 默认)和 `agent_case_ids`(reverse trace)
- **Agentic retrieval**:LLM 主导多轮检索 —— 比 quilin reranker 一阶段融合更激进

**What we can learn / 不能学**:**FORESIGHT + ATOMIC_FACT + AgentCase/Skill 二级抽象 + agentic retrieval** 四条完全值得借鉴(尤其 FORESIGHT 直接补 quilin 的"待办承诺"盲区,DepartureContext.pending_user_actions 现在是字符串列表,可升级为 ForesightModel)。**不学**:**多 DB 混合栈**(quilin 已锁 SQLite)、188k LOC 体量、`devops_scripts/data_fix` 这类生产侧脚本不需要。

---

### 2.11 garrytan/gbrain — YC PGLite + pgvector + Multi-Modal + Destructive Guard

**Architecture / 架构**: TypeScript(284k LOC,本次调研最大),核心是 PGLite(embedded Postgres)+ pgvector HNSW + pg_trgm tsvector full-text。**Schema 设计**(`pglite-schema.ts` 845 行):
- `sources` 表 —— **multi-brain tenancy / federated**(`sources(id, name, local_path, last_commit, config jsonb)`,`pglite-schema.ts:35`)
- `pages` 表(核心)—— 每页带 `compiled_truth / timeline / frontmatter jsonb / content_hash / emotional_weight (0..1) / effective_date / salience_touched_at / last_retrieved_at`(`:58-88`)
- `content_chunks` 表 —— `embedding vector(N) + model + token_count + language + symbol_name / symbol_type / start_line / end_line` 代码片段元数据 + **multimodal**:`modality / embedding_image vector(1024) / embedding_multimodal vector(1024)`(`:108-134`)
- 8 个索引(GIN trgm / HNSW vector / 部分索引 / 表达式索引 coalesce date)
- OAuth tables(`oauth_clients / oauth_tokens / oauth_codes / access_tokens / mcp_request_log`)—— **`gbrain serve --http` 暴露网络可访问的 PGLite**

**Destructive Guard**(`destructive-guard.ts` 337 行):3 层保护
1. Impact preview(始终显示)—— `assessDestructiveImpact()` 计算 `{pageCount, chunkCount, embeddingCount, fileCount}`
2. Confirmation gate(`--confirm-destructive` 或交互式输入 source name)
3. Soft-delete with 72h TTL(`SOFT_DELETE_TTL_HOURS = 72`)—— tombstone 后 72 小时可恢复

架构:TypeScript,核心是 PGLite embedded Postgres + pgvector HNSW + pg_trgm。Schema 含 sources(multi-brain tenancy)/ pages(compiled_truth + emotional_weight + last_retrieved_at)/ content_chunks(代码符号元数据 + multimodal text/image)+ OAuth 表(网络可访问)。**Destructive Guard 3 层**:impact preview + confirmation gate + 72h TTL soft-delete。

**Unique selling points / 独特卖点**:
- **PGLite + pgvector + HNSW** —— 不需要外部 Postgres 也能享受 production-grade 检索
- **emotional_weight 0..1 deterministic score**(tag emotion + take density + user-as-holder ratio)
- **last_retrieved_at**(`:86`)+ partial B-tree index 支持 "stale page detection"(`gbrain lsd`)
- **Destructive Guard 3 层** 完整对应 quilin WriteAuthority 设计哲学,但 quilin 只对写入做,gbrain 对**删除**也做
- **multimodal embedding(text + image + unified multimodal)** —— 1024 维 Voyage 模型

**What we can learn / 不能学**:**Destructive Guard 3 层** 完全值得借鉴(WriteAuthority 现在只管 write,应该扩展到 delete 的 impact preview + TTL soft-delete);**last_retrieved_at + stale page detection** 立刻可加;**emotional_weight 评分公式**(tag emotion + take density)是一个有趣的"deterministic salience"信号。**不学**:**multi-brain tenancy + OAuth + serve --http** 是 gbrain 商业方向(单用户 quilin 不需要);**multimodal embedding** 当前 quilin 用户场景文本为主(Iter K+ 再考虑);**284k LOC 是 SaaS 级别**(quilin-mem 11k LOC 是合理 sweet spot)。

---

### 2.12 MemMachine/MemMachine — Cluster Splitter + Reranker-Guided Ingestion

**Architecture / 架构**: Python + FastAPI(packages/server)+ JS/TS client(packages/ts-client)+ MCP HTTP + MCP stdio(`server/mcp_stdio.py`、`server/mcp_http.py`)。EpisodicMemory(`episodic_memory.py` 550 行)= short-term + long-term 组合(`EpisodicMemoryParams.short_term_memory + long_term_memory`,`:121-122`),用 `_session_key` 隔离会话。SemanticMemory(`semantic_memory.py` 836 行)。**最核心创新是 ClusterSplitter**(`cluster_splitter.py` 521 行):reranker-guided cluster splitting。
- `SplitGate.is_candidate`(`:70-97`):评估 cluster 是否值得分裂——min_cluster_size + low_similarity_threshold + time_gap + **z-score on cohesion drop**(adjacent sim std 计算 z_scores,某条 z > `cohesion_drop_zscore` 则触发)
- `RerankerClusterSplitter`(`:100`)用 reranker 对候选拆分点打分

架构:Python FastAPI + TS client + MCP(双协议 stdio/http),核心创新是 **ClusterSplitter** —— 用 z-score on adjacent similarities + max_time_gap 评估 cluster 凝聚度,凝聚度下降时分裂,再用 reranker 对拆分点打分。

**Unique selling points / 独特卖点**:
- **Cluster splitter z-score 评估**:`z_scores = (mean - sims) / std; max(z_scores) >= cohesion_drop_zscore`(`:88-95`)—— 信息论意义清晰的分裂判定
- **Reranker-guided split scoring**:不是简单 LRU/FIFO,而是用 reranker 给候选拆分点打分
- 双协议 MCP(stdio + http)+ LangChain/LangGraph/CrewAI/LlamaIndex 4 个 integration

**What we can learn / 不能学**:**Cluster splitter + z-score** 概念 quilin 完全没有(quilin consolidator dedupe 是 hash-based,不会主动分裂 cluster);**双协议 MCP**(quilin 现在只 stdio,Iter F 已有 web SSE 计划,但还没 HTTP MCP)。**不学**:**FastAPI + 多 integration** 是商业卖点,quilin 单产品集中精力做 4 客户端复用 user.md/soul.md。

---

### 2.13 TencentDB-Agent-Memory — Multi-Host Adapter + Offload

**Architecture / 架构**: TypeScript(36k LOC,本次调研最小)。`TdaiCore`(`tdai-core.ts:75`)封装核心能力。**HostAdapter abstraction**(`types.ts:154-166`):同一份代码可挂 openclaw / hermes / standalone 三个 host(`hostType: "openclaw" | "hermes" | "standalone"`,`:156`)。Layered memory in `types.ts`:
- L0 = raw conversation
- L1 = relevant memories prepended to user prompt(`RecallResult.prependContext`,`:201`)
- L3 = Persona(`recalledL3Persona`,`:207`)
- `appendSystemContext`(`:203`)—— 稳定 prefix 放 system prompt 末尾(prompt cache 友好)
- 区分 `prependContext`(动态 per-turn) vs `appendSystemContext`(稳定 stable)—— 直接对应 Mastra OM "block-level invalidation" 思想

**Offload mechanism**(`offload/` 目录):context window 满了把老 tool call/use 替换成 summary。`replaceAssistantToolUseWithSummary`(`l3-helpers.ts:184`)、`replaceWithSummary`(`:224`)、`OffloadEntry` 记录 originalLength + summaryLength。

架构:TypeScript,核心是 **HostAdapter 抽象**(同一份代码挂 openclaw / hermes / standalone)+ **prependContext(动态 per-turn,前置)vs appendSystemContext(稳定 prefix,后置)** 的二分(prompt cache 友好)+ **Offload 机制**(context 满了把老 tool call 换成 summary,保留 originalLength + summaryLength)。

**Unique selling points / 独特卖点**:
- **HostAdapter 抽象**:同一套核心代码挂 3 个 harness —— quilin 想做的事(4 客户端共用 agent server)的镜像参考
- **prependContext vs appendSystemContext 二分**:直接对应 Mastra OM 思想但更工程化
- **Offload + tool call summarization**:context 压力直接攻击 tool call 内容(大多是噪声)
- `ensure-hook-policy.ts` + `clean-context-runner.ts` + `memory-cleaner.ts` + `session-filter.ts` —— 一套工程化 hooks(36k LOC 里把这些工具类做实)

**What we can learn / 不能学**:**HostAdapter + Offload + prepend/append 二分** 三条完全值得借鉴(尤其 prepend/append 二分立刻可加进 quilin context assembly);**memory-cleaner / session-filter** 这类小工具类的工程化做法。**不学**:**完全依赖 Tencent Cloud VDB**(quilin SQLite-first);**MCP host 限定 openclaw/hermes**(quilin 自己就是 host)。

---

### 2.14 rohitg00/agentmemory — TS Lightweight, Versioned Memory

**Architecture / 架构**: TypeScript(63k LOC),`src/index.ts` 560 行,`src/types.ts` 888 行(类型定义占大头)。Provider 抽象(`MemoryProvider`)支持 agent-sdk / anthropic / gemini / openrouter / minimax / openai / noop 7 个 LLM provider。**Memory 类型**(`types.ts:81-101`)极其完整:
```ts
{ id, createdAt, updatedAt, type: 'pattern'|'preference'|'architecture'|'bug'|'workflow'|'fact',
  title, content, concepts, files, sessionIds, strength, version, parentId, supersedes,
  relatedIds, sourceObservationIds, isLatest, forgetAfter, imageRef, imageData }
```
**`RawObservation` → `CompressedObservation` 两段式**:`facts: string[]; narrative; concepts; files; importance; confidence; modality`。**15 个 ObservationType**:file_read/write/edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, image, other。**12 个 HookType**:session_start / prompt_submit / pre_tool_use / post_tool_use / post_tool_failure / pre_compact / subagent_start / subagent_stop / notification / task_completed / stop / session_end。Has **resilient providers** with circuit breaker(`providers/circuit-breaker.ts` + `resilient.ts` + `fallback-chain.ts`)。

架构:TypeScript 轻量库(63k LOC),核心是 Memory 类型完整含 **version + parentId + supersedes + isLatest + forgetAfter + strength**(完整的版本链 + 主动遗忘 + 强度模型),`RawObservation → CompressedObservation` 两段式,15 个 ObservationType + 12 个 HookType,带 **resilient providers + circuit breaker + fallback chain**。

**Unique selling points / 独特卖点**:
- **Memory version chain**:`{version, parentId, supersedes: string[], isLatest, forgetAfter}` —— 完整的"记忆历史 + 取代关系 + 主动遗忘"模型,quilin 完全没有
- **strength 字段** —— 显式衰减/增强权重
- **forgetAfter** —— 显式遗忘时间戳
- **15 ObservationType + 12 HookType** —— 完整的事件分类
- **circuit-breaker + fallback-chain + resilient providers** —— 生产级容错

**What we can learn / 不能学**:**version + parentId + supersedes + isLatest + forgetAfter + strength** 6 个字段完全可立刻加到 quilin MemoryRecord;**15 个 ObservationType 分类** 比 quilin observer 现在的 entity/time/event 三分更细;**circuit-breaker / fallback-chain** 模式可加到 quilin LLM 调用(observer / reflector / consolidator 都依赖 LLM)。**不学**:**纯 TS** 路线(quilin 是 TS+Python)。

---

### 2.15 thedotmack/claude-mem — Team Multi-Tenant, Audit Log

**Architecture / 架构**: TypeScript(100k LOC),核心是 SQLite-based multi-tenant memory server。Schema(`storage/sqlite/schema.ts`,33 个 schema version,`SERVER_STORAGE_SCHEMA_VERSION = 33`)含 8 个核心表:`projects / teams / team_members / server_sessions / agent_events / memory_items / memory_sources / api_keys / audit_log`。Key tables:
- `memory_items`(`:85-105`):`kind ∈ {observation, summary, prompt, manual}, type, title, subtitle, text, narrative, facts (json), concepts (json), files_read / files_modified (json), metadata (json), legacy_observation_id`(向后兼容旧表)
- `memory_sources`(`:107-117`):每条 memory 多个 source —— `source_type ∈ {observation, session_summary, user_prompt, manual, import}`
- `api_keys`(`:119-135`):`scopes (json), status ∈ {active, revoked}, last_used_at, expires_at`
- `audit_log`(`:137-150`):`actor_type ∈ {user, api_key, system}, actor_id, action, target_type, target_id, metadata, created_at_epoch`
- 完整索引体系(`:153-170`)含 partial indexes

架构:TypeScript SQLite-based multi-tenant memory server,schema 已演进 33 个版本,8 个核心表(projects/teams/team_members/server_sessions/agent_events/memory_items/memory_sources/api_keys/audit_log),memory_items 含 `kind ∈ {observation, summary, prompt, manual}` 区分来源,memory_sources 做多 source 反向溯源,api_keys 含 scopes/expires_at,audit_log 含 actor_type/actor_id/action/target_type/target_id 完整审计。

**Unique selling points / 独特卖点**:
- **Team workspace** with team_members table —— 团队共享 memory
- **api_keys with scopes + expires_at + revoked** —— 生产级 API 安全
- **audit_log 5 字段(actor_type/actor_id/action/target_type/target_id)** —— 完整审计
- **memory_sources 多源溯源** —— 一条 memory_item 可来自 observation + session_summary + user_prompt 等多个 source
- **legacy_observation_id** —— schema 演进期向后兼容

**What we can learn / 不能学**:**audit_log 完整 5 字段** 立刻可加(quilin 现在用 event_log 但没显式 actor_type/target_type 分类);**memory_sources 多源溯源** 解决"一条 memory 是哪些原始 turns 提炼的"反向追溯;**schema 33 个版本演进** 提醒 quilin store_schema 需要更系统的 migration 机制。**不学**:**team workspace + api_keys multi-tenant**(quilin 单用户为主,Mac App + CLI + Web + REPL 都是同一个 user)。

---

## 三、横向对比矩阵 / Comparison Matrix

| Repo | Tier 数 / 名 | 时间维度 | 存储 | LLM 调度 | dedupe / 整理 | 写入安全 | 跨 session 协作 | 部署模型 | 测试 / benchmark |
|------|-------------|----------|------|---------|--------------|---------|--------------|---------|----------------|
| **mem0** | 1 flat(scope by user/agent/run) | created_at + updated_at;无 valid_from/valid_to | 17+ vector backends + history SQLite | 同步每条 add() 跑 LLM(phased 8-stage)+ batch | hash dedup + LLM "ADD/UPDATE/DELETE" 判决 + 5 rerankers | 无显式 gate | per-user 隔离;agent 级共享 | Library | LongMemEval 93.4%(self-reported) |
| **letta** | Block-based core + Recall + Archive(无显式 tier 数,Block 是一等公民) | created_at;无 temporal edges | Postgres + GCS(git-backed)+ vector(Turbopuffer/native) | Async(FastAPI server)+ summary 工具 agent 主动 | 自然 dedup 通过 Block 替换;archive_manager 整理 | read_only flag + template_id | Named Archives 多 agent 挂载 | Service(FastAPI) | 内部 benchmark,无公开 SOTA |
| **zep** | 闭源 Cloud(参考 Graphiti) | bi-temporal edges(Graphiti) | Neo4j / FalkorDB | 同步抽取 + async consolidation | 自动 entity resolution | 无显式 gate | per-user thread + 共享 ontology | Cloud SaaS | LongMemEval 71.2%(Graphiti),Zep Cloud 私有 |
| **mempalace** | Wing / Hall / Room / Closet / Drawer(5 层物理隐喻) | created_at(无 valid_from)+ NORMALIZE_VERSION | Chroma + 2 collections(drawers + closets) | Idle scan + LLM refine | 无 dedup(verbatim),repair.py 1583 行做修复 | 无显式 gate | per-palace 单用户为主 | Library / MCP server | LongMemEval 96.6% raw mode SOTA |
| **hermes plugins** | 由 plugin 决定(8 plugin)+ MemoryManager fan-out | plugin 决定 | plugin 决定(RetainDB cloud / Mem0 SQLite / SuperMemory / etc) | MemoryManager 同步 fan-out + queue_prefetch async | plugin 决定 | 无统一 gate(各 plugin 自管) | Honcho peer cards / RetainDB project | Hermes built-in | 各 plugin 各自 benchmark |
| **codex** | 单层 raw_memory + rollout_summary(per-thread) → 全局 phase2 | source_updated_at + generated_at | SQLite(SQLx) | Stage1 per-thread + Stage2 global,带 heartbeat / running cap / stale stealing | Phase2 do consolidation | 无显式 gate(in-process Rust) | per-thread + global | Embedded in codex-rs | 31+ tests with stale/cap/conflict 场景 |
| **openclaw memory-core** | Short-term + Long-term + REM evidence | 无 temporal edges | LanceDB(memory-lancedb 子扩展) | Cron-driven dreaming(light / REM / deep) + heartbeat isolated session | applyShortTermPromotions + repair | 无 gate(openclaw 自带 permission) | per-workspace | Plugin in OpenClaw | OpenClaw QA scenarios |
| **claude-code memdir** | 4 type(user/feedback/project/reference)× 2 scope(private/team) | mtime → "N days ago" 字符串 + staleness `<system-reminder>` | Markdown files + YAML frontmatter | 同步 LLM 判决 save / 不 save(prompt 含 when_to_save) | LLM 自然替换文件 | Filesystem + Claude Code permission | per-project + team 目录 | Filesystem in CC | 无 vector benchmark(文件级) |
| **EverOS / EverCore** | 8 types(profile/episodic/foresight/atomic_fact/raw_message/agent_memory/agent_case/agent_skill) | timestamp + start_time/end_time + duration_days(ForesightModel) | Postgres + MongoDB + ES + Milvus | Pipeline-based(memory_extractor + memcell_extractor + profile_indexer) | clustering for skill extraction + dedup | 无显式 gate | per-user + group_id 共享 | FastAPI Service | EverMemBench + EvoAgentBench |
| **gbrain** | 单层 pages + content_chunks + multi-source | created_at + updated_at + effective_date + last_retrieved_at + salience_touched_at + archive_expires_at | PGLite + pgvector HNSW + pg_trgm + multimodal | Cycle phases(recompute_emotional_weight)+ enrichment + chunkers | dedup via content_hash + autopilot purge | **Destructive Guard 3 层** + 72h TTL | OAuth multi-tenant via sources | PGLite + serve --http | gbrain 自带 admin embedded eval |
| **MemMachine** | Short-term + Long-term(EpisodicMemory)+ Semantic | created_at + cluster timestamps | DB-agnostic(via cluster_store_sqlalchemy / in_memory_cluster_store) | Async ingestion + cluster splitter z-score | RerankerClusterSplitter z-score + reranker scoring | 无显式 gate | per-session_key | MCP stdio + HTTP server | LangGraph / CrewAI / LlamaIndex integrations |
| **TencentDB** | L0 + L1 + L3(Persona)+ offload | timestamp + offload originalLength/summaryLength | Tencent Cloud VDB(优先)+ SQLite migrate | Pipeline manager + offload + clean-context-runner | offload tool call summarization | 无 gate(host policy) | per-host adapter(openclaw/hermes/standalone) | TS lib + gateway | E2E vitest |
| **agentmemory** | 1 flat(Memory)+ Observation 两段 | createdAt/updatedAt/forgetAfter | provider-determined(LM Studio / openrouter / ...) | 同步 compress + summarize per provider | hash 自然替换 + supersedes 链 | 无 gate | per-sessionId | TS lib | LongMemEval / locomo 自带 benchmark |
| **claude-mem** | memory_items(kind ∈ observation/summary/prompt/manual)+ memory_sources 反向链 | created_at_epoch + last_used_at_epoch + expires_at_epoch | SQLite(33 schema versions)+ PostgreSQL alt | Server-side hooks(post_tool_use / pre_compact / etc)+ agent_events | dedup via project / team scope | api_keys scopes + audit_log 5 字段 | Team workspace + api_keys + audit | TS server | swebench batch eval |
| **quilin-mem(基线)** | 4 层(working / episodic / semantic / skill) | created_at + valid_from/valid_to(L3b bi-temporal)+ event_log | SQLite + FTS5/BM25 + KG sqlite + vector(可插) | L3a observer(rule-first + LLM)每 N 轮 + idle_budget consolidator | Hash + consolidator dedupe + Reflector info_gain | **WriteAuthority gate** + critical → ask | per-user `~/.quilin/{soul,user}.md` + 4 客户端 共享 | Python MCP server | 31/31 集成测试 + AMB benchmark + l3a-observer fixtures |

---

## 四、quilin-mem 现状 vs 竞品 / Quilin-mem vs Competitors

> 实证 source:`docs/03-memory/README.md` + `providers/memory/src/quilin_mem/*.py`(共 32 模块,11110 LOC,`wc -l` 已 run)

### 4.1 已对齐(我们已经做对的)/ Aligned

1. **4 层分级 working/episodic/semantic/skill** —— 比 mem0 扁平 single-table 更分层,比 letta block-only 更明确。`docs/03-memory/README.md:323-353`。
2. **MCP stdio server** —— `providers/memory/src/quilin_mem/server.py` 1112 行,跟 MemMachine `mcp_stdio.py` + mempalace `mcp_server.py` 同构。
3. **WriteAuthority gate**(`docs/07-safety-guardrails/README.md` §2.6.4 + `reflector.py:77-78`)—— 比 mem0 / mempalace / agentmemory / EverOS / TencentDB 都没有显式 gate 更安全。
4. **D-20 取代 D-12 默认 Graphiti**(放弃 KG dependency,自研 lazy temporal KG)—— 时机准确,与 2026-04 SOTA 反转(Mem0 v2 反超 Graphiti 22 pts)对齐。`README.md:88-103`。
5. **L3a observer rule-first + LLM 兜底** —— 与 Mastra OM 思想对齐,虽然 v2-r3 gate 仅 21.4%(`README.md:231-239`)但路线方向正确。
6. **Hybrid retrieval(vector + BM25 + KG 子图 + reranker)** —— 与 mem0 v2 / Cognee / EverOS 的 hybrid retrieval 对齐,见 `retriever.py` 292 行 + `retriever_bm25.py` + `retriever_kg.py` + `retriever_vector.py` + `reranker.py` 132 行。
7. **User Profile Store 单写方**(`profile_store.py` 642 行 + `profile_updater.py` 407 行)—— 比 mem0 / agentmemory 没有 profile 实体强,跟 EverCore ProfileModel + GlobalUserProfileModel 双层一致。
8. **KG extraction with anti-hallucination + anti-injection + SSRF guard**(D-20 Slice 1,`kg_extractor.py` 385 行)—— 比 mem0 entity_store(`mem0/memory/main.py:413-455`)有显式安全设计。

### 4.2 差距大(明显落后的 5-10 条)/ Lagging

按落后程度排序:

1. **没有 production-grade job queue**(对比 codex memories.rs 4715 行)—— quilin `idle_budget.py` 107 行只是 daily token budget,没有 try_claim/heartbeat/stale_stealing/running_cap 机制。这是 self-evolution / idle consolidator 的工程基石。
2. **没有 Memory version chain**(对比 agentmemory: version + parentId + supersedes + isLatest + forgetAfter + strength)—— quilin MemoryItem 只有 `created_at / last_accessed / access_count / importance_score`(`docs/03-memory/README.md:690-702`),无"取代关系"和"主动遗忘时间戳"。
3. **没有 FORESIGHT(前瞻性 / prospective memory)**(对比 EverOS ForesightModel)—— quilin DepartureContext 的 `pending_user_actions / pending_agent_suggestions` 是字符串列表(`README.md:528-535`),没有 start_time / end_time / duration_days / evidence,无法自动提醒"用户承诺周五前 deploy,今天周四"。
4. **没有 Destructive Guard 3 层**(对比 gbrain destructive-guard.ts 337 行)—— quilin WriteAuthority 只对 write 做 gate,对 delete 没有 impact preview + TTL soft-delete + recovery window。
5. **没有 staleness perception**(对比 claude-code memoryAge.ts)—— quilin 检索返回 raw timestamp,不转 "47 days ago",不加 `<system-reminder>` 提示 LLM "可能过时,验证再断言"。
6. **没有 type taxonomy at memory level**(对比 claude-code 4 type + agentmemory 6 type + EverOS 8 type)—— quilin 是 layer 维度分类,缺一个正交的 type 维度(user/feedback/project/reference 之类)。
7. **没有 cluster splitter**(对比 MemMachine cluster_splitter.py 521 行)—— quilin consolidator dedupe 是 hash-based,不会主动 evaluate cluster cohesion 然后分裂。
8. **没有 prependContext vs appendSystemContext 二分**(对比 TencentDB)—— quilin context assembly 是单一管线,没区分"per-turn 动态前置"和"稳定 system prefix 后置"(后者 prompt cache 友好),`docs/02-context/` 需要补。
9. **没有 multi-source 反向溯源**(对比 claude-mem memory_sources 表)—— quilin MemoryItem 有 `metadata` 但没有 `sources: list[{source_type, source_uri, legacy_id}]` 多源链。
10. **没有 audit_log 5 字段**(对比 claude-mem audit_log: actor_type/actor_id/action/target_type/target_id)—— quilin event_log 字段不完整(`event_log_schema.py` 82 行 + `event_log.py` 551 行,但缺显式 actor_type / target_type 二分)。

### 4.3 已超前(我们独特优势 2-3 条)/ Already Ahead

1. **WriteAuthority gate 跨整个 agent core**:不是 quilin-mem 内部限制,而是 agent-core 层的 `WriteAuthority` 全局 gate(`docs/07-safety-guardrails/README.md` §2.6.4 + `packages/agent-core/src/`),所有 agent-initiated 写都过这个 gate,**这是 14 个对比项目里没有的全局 capability gate**。mem0 / letta / agentmemory / EverOS 全是 memory 模块内部加 try-except,没有 cross-component gate。
2. **4 客户端共享 `~/.quilin/{soul,user}.md` + per-project `QUILIN.md`**(`docs/16-soul-import/README.md` + `docs/17-multi-client/README.md`):**这个组合在 14 个项目里完全独家**。Letta git-backed memory 是 server-only,claude-mem team workspace 是云端,gbrain 是单 PGLite。quilin 是真正的 "Mac App + CLI + REPL + Web 4 客户端,同一份 soul.md / user.md / per-project QUILIN.md" —— 这是给"工程师跨工具共用 agent"的独家方案。
3. **Soul Import: 从 6 个 agent framework(OpenClaw / Hermes / Claude Code / Codex / Gemini CLI / OpenCode)安装期扫描 → seed user.md / soul.md / QUILIN.md**(`docs/16-soul-import/README.md`):**这是 quilin 唯一卖点的硬基建**。letta / mem0 / gbrain 没有任何"从其他 agent 迁移记忆"的能力。这是 quilin 把"用户已经在用其他 agent 几年的记忆"零成本搬过来的钩子。

---

## 五、"打爆"升级建议 / Upgrade Roadmap to Win

> 工时按 Claude+Codex 联合开发节奏(1 联合日 ≈ 1-2 周个人),参考 user memory `feedback_estimate_with_codex`。
>
> Effort estimates use the Claude+Codex joint-dev cadence (1 joint-day ≈ 1-2 weeks of solo eng), anchored on the Iter J/F web ship-in-a-day precedent.

按推荐优先级排序。"unique opportunity" 标记的是 quilin 4 客户端 / WriteAuthority / Soul Import / Self-Evolution 结合点上别人无法做的事。

### 5.1 高优先级 / High Priority

#### 高-1. Staleness Perception("47 days ago" + system-reminder)

- **Idea 出处**:`claude-code/src/memdir/memoryAge.ts:7-53`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/retriever.py:292` 行 `Retriever.recall()` 返回结果时,对 `created_at > 1 day` 的 MemoryItem 自动:(a) 把 `created_at` 转 `"47 days ago"` 字符串放进 metadata; (b) 给 content 包 `<system-reminder>This memory is N days old. ...</system-reminder>`。`packages/agent-core/src/memory/` 消费端不变。
- **工时估算**:0.5 联合日(简单转换 + 单测)
- **立 Plane 哪个新 QUI**:`QUI-MEM-STALENESS` —— Memory staleness perception (47 days ago + system-reminder)
- **推荐优先级**:**高**(ROI 极高,工时极低)

#### 高-2. Memory Version Chain(version + parentId + supersedes + isLatest + forgetAfter + strength)

- **Idea 出处**:`agentmemory/src/types.ts:81-101`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/store_schema.py:1-197` 加 6 列到 `memory_records` 表(`version int default 1, parent_id text, supersedes_json text, is_latest int default 1, forget_after_epoch int, strength real default 1.0`)+ `store.py` 507 行的 upsert / search 兼容 + `store_search.py:249` filter `WHERE is_latest = 1` 默认。`reflector.py` ReflectionProposal 写新版本时把旧 id 加进 `supersedes`,旧 row 自动 `is_latest=0`。
- **工时估算**:2 联合日(schema migration + filter + tests + retrieval fallback to latest)
- **立 Plane 哪个新 QUI**:`QUI-MEM-VERSION-CHAIN` —— Memory version chain & explicit forget
- **推荐优先级**:**高**

#### 高-3. Production Job Queue for Idle Evolution

- **Idea 出处**:`codex/codex-rs/state/src/runtime/memories.rs:478,665,1020,1056,1378,1501`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/idle_budget.py:107` 升级 + 新增 `consolidator_jobs` SQLite 表(columns: `id / kind / status ∈ {queued, claimed, running, succeeded, failed} / worker_id / claimed_at / heartbeat_at / payload / outcome`)+ Python 实现 `try_claim_job(worker_id, max_running)` SQL `SELECT ... FOR UPDATE SKIP LOCKED`-like(SQLite 用 `claimed_at + worker_id IS NULL OR heartbeat_at < now - 5min`)+ `heartbeat_job(job_id, worker_id)` + `mark_succeeded / mark_failed / mark_failed_if_unowned`。Consolidator(`consolidator.py` 821 行)迁到走 job queue。
- **工时估算**:3 联合日(schema + claim/heartbeat/finish + running cap + tests with concurrent-claim conflict scenarios,代码量预期 600-900 行)
- **立 Plane 哪个新 QUI**:`QUI-MEM-JOB-QUEUE` —— Production job queue for idle evolution
- **推荐优先级**:**高**(Iter K self-evolution 真正可上线的前提)

#### 高-4. UNIQUE OPPORTUNITY:Soul Import 反向(Quilin → 6 agent framework)

- **Idea 出处**:`docs/16-soul-import/README.md`(quilin 已经做 forward import)+ claude-code memdir markdown 兼容
- **改 quilin 哪里**:Soul Import 现在是 install-time scan 6 framework → seed user.md / soul.md / QUILIN.md。**反向**:`packages/agent-core/src/integrations/` 新增 `quilin-export/` 模块,把 quilin user.md / soul.md / `MemoryRecord` 高强度子集 export 成:
  - Claude Code `~/.claude/projects/<project>/memory/*.md` 兼容格式(4 type + scope)
  - OpenClaw / Hermes memory plugin 兼容 JSONL
  - Codex `~/.codex/sessions/*.jsonl` 兼容
- **why unique**:其他 14 个项目没有任何"反向同步到 ecosystem"能力 —— 用户用了 quilin 后想试 claude-code 不会丢记忆,quilin 是真正的 **memory portable layer**(类似 cross-cloud Kubernetes)。这同时把 4 客户端的能力外溢到整个 agent ecosystem。
- **工时估算**:3 联合日(每 framework 一个 exporter ~0.5 联合日 + 测试)
- **立 Plane 哪个新 QUI**:`QUI-MEM-EXPORT-ECOSYSTEM` —— Reverse Soul Export to 6 agent frameworks
- **推荐优先级**:**高**(战略级别)

#### 高-5. UNIQUE OPPORTUNITY:Memory Sync Across 4 Clients with Conflict Resolution

- **Idea 出处**:**完全独家**——letta git-backed memory(server-only)+ claude-mem team workspace(云端)启发,但 quilin 把它做成 **跨 4 客户端的 git-like 多端同步**
- **改 quilin 哪里**:`~/.quilin/` 目录已有 user.md / soul.md / QUILIN.md(per-project) + `quilin-mem.db` SQLite,但 **4 客户端(CLI / REPL / Web / Mac App)各自打开同一个 SQLite 时可能 race**(虽然有跨语言 fcntl + proper-lockfile,但还没有显式 conflict resolution)。建议:
  - `store.py` 加 `last_modified_epoch + last_writer_client ∈ {cli, repl, web, mac}` 两列
  - Conflict detection: 同一 record 5 秒内被两个不同 client 写过,触发 `merge_strategy` (默认 LWW + 提示用户)
  - Web UI 加 conflict viewer(`apps/web/app/memory/conflicts/` route)
- **why unique**:14 个项目里没有任何 multi-client conflict resolution(letta 是 server-only 不存在 client conflict,gbrain `serve --http` 是 single server),quilin 是 desktop-first + 4 client 真正面对这个问题
- **工时估算**:2.5 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-MULTICLIENT-MERGE` —— Multi-client memory conflict resolution
- **推荐优先级**:**高**(2026-Q3 Mac App 上线前必须有)

### 5.2 中优先级 / Medium Priority

#### 中-6. Destructive Guard 3 层 + Soft-Delete TTL

- **Idea 出处**:`gbrain/src/core/destructive-guard.ts:1-337`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/store.py:507` 加 `archived_at / archive_expires_at` 列 + `assess_destructive_impact(query)` 工具函数返 `{record_count, kg_edge_count, profile_signal_count}` + WriteAuthority gate 在 destructive operation 时强制返回 impact preview + 72h TTL soft-delete(参数化:`SOFT_DELETE_TTL_HOURS=72`)+ idle worker 周期 purge expired tombstones。
- **工时估算**:2 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-DESTRUCTIVE-GUARD`
- **推荐优先级**:**中**(用户低概率删 memory 但删错代价高)

#### 中-7. FORESIGHT(Prospective Memory)

- **Idea 出处**:`EverOS/methods/EverCore/src/api_specs/memory_models.py:306-340`
- **改 quilin 哪里**:`docs/03-memory/README.md` Layer 3 加 sub-tier `ForesightStore`,新增 `providers/memory/src/quilin_mem/foresight.py`(~300 行,字段:`content / start_time / end_time / duration_days / evidence / parent_episodic_id`)+ Reflector 抽取 foresight 信号(prompt 加 "Identify user-promised future actions")+ DepartureContext.pending_user_actions 从 `list[str]` 升级为 `list[ForesightModel]` + 02-context 在 build_context 时主动注入 "user has X pending foresight items" 给系统提示。
- **工时估算**:3 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-FORESIGHT`
- **推荐优先级**:**中**(高用户感知价值 —— "Agent 主动提醒我承诺过的事")

#### 中-8. Memory Type Taxonomy(orthogonal to layer)

- **Idea 出处**:`claude-code/src/memdir/memoryTypes.ts:16-21` + `agentmemory/src/types.ts:85`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/store_schema.py` 给 `memory_records` 表加 `type TEXT CHECK(type IN ('user','feedback','project','reference','pattern','bug','workflow'))`(7-type 融合 claude-code 4 + agentmemory 4)+ store_search.py filter by type + Observer L3a prompt 加分类指令(`Classify into one of: user/feedback/project/reference/pattern/bug/workflow`)+ `reflector.py` ReflectionProposal 写时显式 type。Working/Episodic/Semantic/Skill 维度不变(layer is **when** in lifecycle,type is **what kind**)。
- **工时估算**:2 联合日(schema + classifier prompt + filter)
- **立 Plane 哪个新 QUI**:`QUI-MEM-TYPE-TAXONOMY`
- **推荐优先级**:**中**

#### 中-9. UNIQUE OPPORTUNITY:Self-Evolution 驱动的 Skill Maturity Pipeline

- **Idea 出处**:`EverOS AgentCaseModel + AgentSkillModel`(`memory_models.py:343-394`)+ `docs/10-self-evolution/` quilin 已有 spec
- **改 quilin 哪里**:**Quilin 现状**:`docs/13-skills/` 是 SSoT in filesystem `~/.quilin/skills/<slug>/SKILL.md`,`docs/10-self-evolution/` 提"agent 提议 skill_create / skill_update"。**升级**:
  - 加 `agent_cases` SQLite 表(`task_intent / approach / quality_score / parent_episodic_id`)— 不是 skill,是 raw 经验
  - L3a observer / Reflector 在每 successful task 自动产 1 个 AgentCase
  - 当 `count(similar_cases) >= 3` 且 `min(quality_score) >= 0.7` 时,**自动 propose skill_create**(via WriteAuthority,需要 human-in-loop approve)
  - Skill 自带 `maturity_score`(初始 0.6,每成功 +0.05,失败 -0.1)
- **why unique**:`EverOS` 有 AgentCase → AgentSkill 但**没有 human-in-loop**(直接落盘),quilin 的优势是 WriteAuthority gate + idle evolution 把 propose 和 apply 分离 —— **唯一能做到"agent 提议 skill,人类审核后落 ~/.quilin/skills/"的项目**。
- **工时估算**:4 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-SKILL-MATURITY` + `QUI-SE-SKILL-CASE-PIPELINE`(跨 10 + 13)
- **推荐优先级**:**中**(Iter L 之后,需要 production job queue 先在位)

### 5.3 低优先级 / Low Priority

#### 低-10. prependContext vs appendSystemContext 二分

- **Idea 出处**:`TencentDB-Agent-Memory/src/core/types.ts:201,203`
- **改 quilin 哪里**:`docs/02-context/` ContextAssembler 接口分两个返回字段(per-turn dynamic prepend vs stable system suffix),Memory recall 结果分类,prompt cache 友好
- **工时估算**:1.5 联合日(主要是 02-context 接口改 + retrieval 分流)
- **立 Plane 哪个新 QUI**:`QUI-CTX-PREPEND-APPEND-SPLIT`
- **推荐优先级**:**低**(只在 prompt cache 命中率成为瓶颈时才做,目前 quilin 还没到这个体量)

#### 低-11. Audit Log 5 字段化

- **Idea 出处**:`claude-mem/src/storage/sqlite/schema.ts:137-150`
- **改 quilin 哪里**:`providers/memory/src/quilin_mem/event_log_schema.py:82` 加 `actor_type ∈ {user, agent, idle_worker, system}` + `target_type ∈ {memory_record, kg_edge, profile_signal, skill}` + `target_id`(已有部分)+ `action ∈ {create, update, delete, recall, archive}` 标准化。
- **工时估算**:1 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-AUDIT-5FIELD`
- **推荐优先级**:**低**

#### 低-12. Multi-Source Reverse Trace

- **Idea 出处**:`claude-mem` `memory_sources` 表
- **改 quilin 哪里**:`store_schema.py` 加 `memory_sources` 表(memory_record_id ← multiple source_uris),用于 "这条记忆是哪些 turns / observations 提炼的" 反向追溯。
- **工时估算**:1 联合日
- **立 Plane 哪个新 QUI**:`QUI-MEM-SOURCE-TRACE`
- **推荐优先级**:**低**

#### 低-13. UNIQUE OPPORTUNITY:Memory Provenance Visualizer in Web

- **Idea 出处**:Quilin 已有 `apps/web/app/memory/` 页面 + KG visualization(`@xyflow/react`)(README.md:9-10)
- **改 quilin 哪里**:基于 高-2 version chain + 低-12 source trace,在 web /memory 页面加 "记忆来源图谱" tab,显示某条 semantic memory 的 supersedes 链 + parent observations → atomic facts → reflection insight 整条 provenance 路径。
- **why unique**:14 个对比项目里**没有任何项目把 memory provenance(从原始 turn 到 final semantic memory)做成可视化**,这是 4 客户端(尤其 Web)的天然 UX 卖点
- **工时估算**:2 联合日(后端 graph API + 前端 reactflow,可复用 KG 可视化基础)
- **立 Plane 哪个新 QUI**:`QUI-MEM-PROVENANCE-VIZ`
- **推荐优先级**:**低**(依赖 高-2 + 低-12,UI polish 阶段做)

### 5.4 优先级总览 / Priority Summary

| 级别 | 数量 | 总联合工时 | 个人开发等价 |
|------|------|-----------|------------|
| 高 | 5(含 2 个 unique opportunity) | 11 联合日 | 11-22 周 |
| 中 | 4(含 1 个 unique opportunity) | 11 联合日 | 11-22 周 |
| 低 | 4(含 1 个 unique opportunity) | 5.5 联合日 | 5.5-11 周 |
| **总计** | **13 项** | **27.5 联合日** | **27-55 周** |

### 5.5 Unique Opportunity 5 条精华摘要 / Unique Opportunity Highlights

> 这 5 条是 quilin 4 客户端 + WriteAuthority + Soul Import + Self-Evolution + Web 可视化 5 大基建独家组合点上才能做的事,其他 14 项目无法复制:

1. **Soul Import 反向 export 到 6 agent framework**(高-4)—— quilin 成为 memory portable layer,用户离开后可带走记忆到 claude-code / openclaw / hermes / codex / gemini-cli / opencode,quilin 反而获得网络效应。
2. **Multi-Client Memory Conflict Resolution**(高-5)—— CLI/REPL/Web/Mac App 4 客户端同时写同一份 quilin-mem.db 的真实问题,只有 quilin 面对,因此只有 quilin 能解。
3. **Self-Evolution 驱动 Skill Maturity Pipeline**(中-9)—— EverOS 有 case→skill 但没 human gate,quilin WriteAuthority + idle propose 是唯一组合,能做到"agent 提议 skill,人类审 → 落盘"。
4. **Memory Provenance Visualizer in Web**(低-13)—— 14 项目里没人做 provenance 可视化,quilin 已有 reactflow + apps/web/memory 基础,加 supersedes 链 + parent observations 反向链可视化,是天然 UX 卖点。
5. **(Bonus)Cross-Project QUILIN.md as First-Class Citizen in Retrieval Ranking** —— per-project QUILIN.md 是 quilin 已有,但当前 retrieval 没把"当前 cwd 对应 QUILIN.md"作为 ranking signal(`retrieval_profile.py` 571 行未实证)。把 cwd → project_root → QUILIN.md hash 作为 query 增强 + boost,让 Mac App / Web / CLI / REPL 在不同 cwd 下自动激活不同项目记忆。这是 14 项目都没的"工程师跨项目记忆隔离"卖点。

---

## 六、跟 Codex 的判断 diff / Cross-Perspective Diff with Codex

(留 placeholder,Codex 调研产 `competitor-analysis.md`,完成后由用户补齐两份的关键 diff 与共识)

(Placeholder — Codex independently produces `competitor-analysis.md`. The user will reconcile key disagreements / consensus here when both reports complete.)

---

## 附录 A:实证清单 / Evidence Index

所有 `file:line` 实证已散落在正文,关键来源汇总:

**quilin-mem 现状**(LOC `wc -l` 实证):
- `providers/memory/src/quilin_mem/` 32 modules,11110 LOC
- `docs/03-memory/README.md` 1378 行,`docs/03-memory/` 11 篇 docs
- 关键 module size:`observer.py:1650 / server.py:1112 / consolidator.py:821 / profile_store.py:642 / retrieval_profile.py:571 / event_log.py:551 / reflector.py:346 / kg_extractor.py:385`

**14 个竞品的关键 source**:
- mem0 `mem0/memory/main.py:573-971`(add pipeline)、`:1126-1237`(search)、`:1618-1655`(procedural)
- letta `letta/schemas/block.py:67,117,124`、`letta/services/block_manager_git.py:1-120,359,485`、`letta/services/archive_manager.py:30,103`
- zep `zep/ontology/default_ontology.py:119-139`、`zep/examples/python/advanced.py:14-90`
- mempalace `mempalace/palace.py:47,57`、`mempalace/miner.py:7`、`mempalace/repair.py:1583` LOC
- hermes `agent/memory_manager.py:190,236-243`、`plugins/memory/holographic/holographic.py:43-108`、`plugins/memory/retaindb/__init__.py:1-23`
- codex `codex-rs/state/src/runtime/memories.rs:478,665,866,883,1020,1378,1501,1938`
- openclaw `extensions/memory-core/src/dreaming.ts:1-60,42`
- claude-code `src/memdir/memoryTypes.ts:16-21,42-69`、`src/memdir/memoryAge.ts:7-53`
- EverOS `methods/EverCore/src/api_specs/memory_models.py:78-101,306-340,373-394`
- gbrain `src/core/pglite-schema.ts:35,58-88,108-134`、`src/core/destructive-guard.ts:42,52-100`
- MemMachine `packages/server/src/memmachine_server/semantic_memory/cluster_splitter.py:70-97,100`
- TencentDB `src/core/types.ts:154-166,201,203`、`src/offload/l3-helpers.ts:184,224`
- agentmemory `src/types.ts:29-101,64-79,115-127`
- claude-mem `src/storage/sqlite/schema.ts:85-150`

**工时估算锚点**(per user memory `feedback_estimate_with_codex`):1 联合日 ≈ 1-2 周个人开发;Iter J/F web 一天 ship 全部作为校准锚。
