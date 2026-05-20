# 竞品记忆系统分析 / Competitor Memory System Analysis

This document is an independent local-repository review of fourteen agent memory implementations. It focuses on architecture, storage, write path, retrieval path, consolidation, user interface, evidence quality, and what Quilin can learn if the goal is not merely to match them, but to build a stronger memory system.

本文档是对十四个 agent 记忆实现的独立本地仓库调研。重点不是复述 README，而是比较它们的架构、存储、写入、检索、整理、用户接口、实证质量，以及 Quilin 如果要做出更强记忆系统应该吸收什么。

## 证据范围 / Evidence Scope

The reviewed repositories are `~/repo/mem/MemMachine`, `~/repo/mem/letta`, `~/repo/mem/zep`, `~/repo/mem/agentmemory`, `~/repo/mem/mem0`, `~/repo/mem/mempalace`, `~/repo/mem/EverOS`, `~/repo/mem/claude-mem`, `~/repo/mem/TencentDB-Agent-Memory`, `~/repo/mem/gbrain`, plus `~/repo/hermes-agent`, `~/repo/codex`, `~/repo/openclaw`, and `~/repo/claude-code`. The analysis uses local source files, READMEs, config files, tests, and examples available in those checkouts.

本次调研覆盖 `~/repo/mem/MemMachine`、`~/repo/mem/letta`、`~/repo/mem/zep`、`~/repo/mem/agentmemory`、`~/repo/mem/mem0`、`~/repo/mem/mempalace`、`~/repo/mem/EverOS`、`~/repo/mem/claude-mem`、`~/repo/mem/TencentDB-Agent-Memory`、`~/repo/mem/gbrain`，以及 `~/repo/hermes-agent`、`~/repo/codex`、`~/repo/openclaw`、`~/repo/claude-code`。结论来自这些本地 checkout 中的源码、README、配置、测试和示例。

## 执行结论 / Executive Take

The strongest competitors do not win by one memory trick. Mem0 wins on low-latency additive extraction and benchmark discipline; Zep wins on temporal knowledge graph semantics; MemPalace wins on lossless local-first recall; TencentDB-Agent-Memory wins on symbolic context offload and traceability; GBrain wins on a markdown source of truth plus durable background maintenance; AgentMemory wins on coding-agent hook coverage. Quilin should not copy one of them. The opportunity is to combine lossless evidence, temporal truth maintenance, batch consolidation, safe writes, idle scheduling, and planner-visible memory into one coherent system.

最强的竞品不是靠单点技巧赢。Mem0 强在低延迟 ADD-only 抽取和 benchmark 纪律；Zep 强在时态知识图谱语义；MemPalace 强在 lossless 本地优先召回；TencentDB-Agent-Memory 强在符号化上下文 offload 和可追溯；GBrain 强在 Markdown 真相源和可靠后台维护；AgentMemory 强在 coding-agent hook 覆盖。Quilin 不应该照抄某一个，而应该把原始证据、时态真值维护、批量整理、安全写门、idle 调度和 planner 可见记忆组合成一个一致系统。

My independent view is that "beating everyone" will require fewer automatic rewrites, not more. The memory system should preserve raw observations first, derive structured facts second, and only commit destructive consolidation through explicit authority and evidence-backed proposals. LLM-based reflection should be batched and scheduled, while retrieval should be fast, deterministic, and progressively disclosed.

我的独立判断是，“打爆所有”不是靠更多自动改写，而是靠更少的不可逆写入。系统应该先保留原始观察，再派生结构化事实，最后所有破坏性整理都必须通过带证据的授权提案。LLM 反思适合批量和后台调度，检索则应该快速、确定、可逐层展开。

## 逐仓库分析 / Per-Repository Analysis

### MemMachine

MemMachine is a multi-layer memory service with working memory, episodic memory, profile memory, and agent memory persistence. The source and deployment files show PostgreSQL with pgvector and Neo4j as the main production path, with SQLite, sqlite-vec, Qdrant, and other vector backends also supported in configuration. Its semantic service runs background ingestion, embedding, retrieval, and feature consolidation with thresholds and intervals, while episodic configuration supports short-term buffers plus long-term vector or graph-backed stores. Retrieval is hybrid enough to include reranking and reciprocal-rank fusion style composition. The interface surface is broad: REST API, Python SDK, TypeScript SDK, and MCP over stdio or HTTP. Its unique value is packaging memory as a real service instead of a local helper. Quilin should learn from its service boundary and background ingestion, but avoid inheriting a heavy Postgres plus Neo4j requirement as the default personal-agent path.

MemMachine 是一个多层记忆服务，包含 working memory、episodic memory、profile memory 和 agent memory persistence。源码和部署文件显示生产路径主要是 PostgreSQL + pgvector 与 Neo4j，同时配置上也支持 SQLite、sqlite-vec、Qdrant 等后端。它的 semantic service 有后台 ingestion、embedding、retrieval 和 feature consolidation，并带阈值与间隔；episodic 配置则支持短期 buffer 和长期 vector 或 graph store。检索层有 rerank 与类似 reciprocal-rank fusion 的融合。用户接口包括 REST API、Python SDK、TypeScript SDK 和 MCP stdio/http。它的卖点是把记忆包装成真正的服务，而不是本地 helper。Quilin 可学习服务边界与后台 ingestion，但不应把 Postgres + Neo4j 作为个人 agent 默认依赖。

### Letta

Letta, descended from MemGPT, treats memory as an agent-owned resource. Its core abstraction is editable memory blocks such as `human` and `persona`, plus recall and archival memory accessed through tools. Storage is primarily Postgres with pgvector, with Redis, Pinecone, and Temporal-related infrastructure visible in configuration. The write strategy is model-mediated: the agent can update its own blocks and call memory tools when context pressure or task needs require it. Retrieval combines in-context core memory with searchable recall or archival stores. Consolidation is less about batch dedupe and more about controlled memory pressure, editable blocks, and sleep-time or group-agent flows. Its interface is an API, CLI, hosted service, and SDK-style agent platform. The lesson for Quilin is that memory must be a first-class agent action surface, not only a retrieval plugin; however, Quilin should add stronger write authorization and evidence trails than Letta exposes by default.

Letta 继承自 MemGPT，核心思想是把记忆当作 agent 自己可操作的资源。它的核心抽象是可编辑 memory blocks，例如 `human` 和 `persona`，再配合通过工具访问的 recall memory 与 archival memory。存储主要是 Postgres + pgvector，配置中也能看到 Redis、Pinecone 和 Temporal 相关基础设施。写入策略由模型驱动：agent 在上下文压力或任务需要时可以更新自己的 blocks 或调用 memory tools。检索则把 in-context core memory 与可搜索的 recall/archival store 结合。它的整理更偏向 memory pressure、可编辑 blocks、sleep-time 或 group-agent 流程，而不是单纯 batch dedupe。接口包括 API、CLI、hosted service 和 SDK。Quilin 应学习“记忆是 agent 动作面”这一点，但默认必须比 Letta 更强调 WriteAuthority 和证据链。

### Zep

Zep is now positioned as a context-engineering platform, with the open repository focused on SDKs, examples, tools, evaluation harnesses, and integrations rather than the full cloud service internals. Its important architectural idea is Graphiti-style temporal knowledge graph memory: relationships and facts can carry validity intervals such as `valid_at` and `invalid_at`, allowing retrieval to answer what was true when, not just what is semantically close. Storage and serving are cloud-oriented, with graph and memory APIs exposed through Python, TypeScript, and Go SDKs. Writes come from chat history, business data, documents, and events; retrieval is relationship-aware, temporally filtered, and optimized for low-latency context assembly. Zep's lesson is that time is not metadata decoration. For Quilin, temporal validity should become a core field on semantic facts and graph edges, especially for user preferences, names, project state, and contradictions.

Zep 现在更像一个 context-engineering 平台，开源仓库主要保留 SDK、示例、工具、评测和集成，而不是完整云服务内部实现。它最重要的架构点是 Graphiti 风格的时态知识图谱：关系和事实可以带 `valid_at`、`invalid_at` 这类有效期，让检索能回答“什么时候为真”，而不仅是“语义上接近什么”。它的存储和服务更偏云端，通过 Python、TypeScript、Go SDK 暴露 graph 与 memory API。写入来源包括聊天历史、业务数据、文档和事件；检索强调关系感知、时间过滤和低延迟上下文组装。Zep 给 Quilin 的教训是：时间不是装饰性 metadata。Quilin 应把 temporal validity 作为 semantic facts 和 graph edges 的核心字段，尤其用于用户偏好、称呼、项目状态和矛盾事实。

### AgentMemory

AgentMemory is a coding-agent memory system built around hooks, a local server, and a very large feature surface. Its types distinguish raw observations, compressed observations, memories, slots, relations, profiles, graph nodes, graph edges, lessons, routines, insights, audit records, leases, and team namespaces. Storage is local-first and broad: the schema defines multiple KV namespaces for observations, memories, summaries, BM25 indexes, embeddings, relations, profiles, graph state, semantic/procedural memory, audit, actions, leases, checkpoints, mesh state, and more. Writes are event-driven through hooks from tools and sessions, then compressed and consolidated. Retrieval is hybrid BM25 plus vector plus graph, with entity extraction, query expansion, and rank fusion. The interface is a shared memory server and many MCP tools for coding agents. Its unique value is practical capture coverage across real coding workflows. Quilin can learn hook coverage, team scope, and progressive coding memory, while keeping a smaller core to avoid feature sprawl.

AgentMemory 是面向 coding agent 的记忆系统，围绕 hooks、本地 server 和很大的功能面展开。它的类型区分 raw observations、compressed observations、memories、slots、relations、profiles、graph nodes、graph edges、lessons、routines、insights、audit records、leases 和 team namespaces。存储本地优先且范围很广：schema 定义了 observations、memories、summaries、BM25 indexes、embeddings、relations、profiles、graph state、semantic/procedural memory、audit、actions、leases、checkpoints、mesh state 等多个命名空间。写入由工具和 session hooks 事件驱动，再做压缩与整理。检索是 BM25 + vector + graph，配合实体抽取、query expansion 和 rank fusion。接口是共享 memory server 和大量 MCP tools。它的独特价值是真实 coding workflow 的捕获覆盖。Quilin 可学习 hook 覆盖、team scope 和 coding memory，但核心需要更克制，避免功能面失控。

### Mem0

Mem0 is the strongest example of benchmark-driven memory product design. Its current direction emphasizes a single-pass ADD-only extraction algorithm: instead of asking the LLM to decide add/update/delete per item in a loop, it extracts new facts, performs entity linking, and retrieves with multiple signals. Storage is adapter-heavy, spanning Qdrant, Pinecone, pgvector, Chroma, Redis, Milvus, Elasticsearch, MongoDB, Weaviate, Azure AI Search, Neptune Analytics, and SQLite metadata. Retrieval combines semantic similarity, BM25-style keyword matching, entity matching, reranking, and temporal signals, with benchmark claims across LoCoMo, LongMemEval, and BEAM. Interfaces include Python SDK, npm SDK, CLI, self-hosted server, cloud, and skills. The key lesson is to optimize memory as a measured product: one-pass write path, cheap retrieval, explicit evaluation. Quilin should copy the discipline, not necessarily the broad vector-store adapter matrix.

Mem0 是最典型的 benchmark-driven 记忆产品。它当前方向强调 single-pass ADD-only extraction：不让 LLM 在循环里逐条判断 add/update/delete，而是先抽取新事实，再做 entity linking，并用多信号检索。存储适配器非常多，包括 Qdrant、Pinecone、pgvector、Chroma、Redis、Milvus、Elasticsearch、MongoDB、Weaviate、Azure AI Search、Neptune Analytics 和 SQLite metadata。检索结合 semantic similarity、BM25 keyword、entity matching、reranking 和 temporal signals，并对 LoCoMo、LongMemEval、BEAM 给出实测。接口包括 Python SDK、npm SDK、CLI、自托管 server、cloud 和 skills。关键教训是把记忆当作被度量的产品来优化：一次写入、低成本检索、明确评测。Quilin 应复制这种纪律，而不必复制庞大的 vector-store 适配矩阵。

### MemPalace

MemPalace argues against over-summarization. Its design stores original content verbatim, organizes it as a palace with people or projects as wings, topics as rooms, and content as drawers, and searches scoped spaces instead of one flat memory heap. The default backend is ChromaDB with a pluggable backend interface, while its knowledge graph is local SQLite with temporal entity-relationship validity, invalidation, and timeline queries. Writes are mostly local-first and idempotent through agents, diaries, hooks, and sweepers. Retrieval is high-recall semantic or hybrid search, optionally with LLM reranking, and its benchmark claims are unusually strong for raw non-LLM retrieval. The user interface includes a 29-tool MCP server and local workflows. Quilin should learn the lossless-first principle: raw memories, tool outputs, and observations must remain citeable even after semantic facts are extracted or consolidated.

MemPalace 反对过度摘要。它保留原始内容 verbatim，并用 palace 结构组织：people/projects 是 wings，topics 是 rooms，content 是 drawers，同时在 scoped space 中搜索，而不是把所有记忆扔进一个平面堆。默认后端是 ChromaDB，并提供 pluggable backend；知识图谱则是本地 SQLite，支持时态实体关系、失效和 timeline query。写入通过 agents、diaries、hooks、sweepers 本地优先且幂等。检索强调高召回 semantic 或 hybrid search，可选 LLM rerank，且在 raw non-LLM retrieval 上给出了很强 benchmark。用户接口包括 29 个 MCP tools 和本地流程。Quilin 应学习 lossless-first 原则：原始记忆、工具输出、观察记录必须在 semantic facts 被抽取或整理后仍可引用。

### EverOS / EverCore

EverOS, through EverCore, presents a production-style memory operating system. Its architecture separates agentic, memory, retrieval, business, infrastructure, and core framework layers. Memory construction extracts MemCells from conversations, classifies them into episodes, profiles, preferences, relationships, and semantic knowledge, then stores and indexes them. Retrieval includes semantic vector search, BM25, hybrid reciprocal-rank fusion, reranking, and agentic multi-round recall. Infrastructure is heavier than most local agents: MongoDB as primary store, Elasticsearch for BM25, Milvus for vectors, Redis cache, queues, rate limiting, distributed locks, and tenant isolation. The interface is more of a platform architecture and use-case kit than a small SDK. The lesson is operational maturity: lifecycle management, tenant boundaries, distributed locks, and test coverage matter. Quilin should adopt the lifecycle and testing ideas, not the whole multi-database stack by default.

EverOS 通过 EverCore 展示了生产级 memory operating system 的形态。它把系统拆成 agentic、memory、retrieval、business、infrastructure 和 core framework 六层。memory construction 从 conversations 抽取 MemCells，分类为 episodes、profiles、preferences、relationships 和 semantic knowledge，然后存储与索引。检索包括 semantic vector search、BM25、hybrid reciprocal-rank fusion、reranking 和 agentic multi-round recall。基础设施比大多数本地 agent 重：MongoDB 主存、Elasticsearch 做 BM25、Milvus 做向量、Redis cache、队列、rate limiting、distributed locks 和 tenant isolation。接口更像平台架构和 use-case kit，而不是小 SDK。它的教训是工程成熟度：生命周期、租户边界、分布式锁和测试覆盖很重要。Quilin 应吸收 lifecycle 与测试思想，但默认不要引入整套多数据库栈。

### Claude-Mem

Claude-Mem is optimized for Claude Code-style workflows. It captures lifecycle events through hooks such as session start, prompt submit, post-tool-use, stop, and session end, then stores observations, generated memory items, events, and context packs in SQLite/Postgres-style schemas with Chroma vector search. It exposes an HTTP worker service, viewer, and search tooling. Its retrieval path uses progressive disclosure: compact search results first, timeline next, and full observations only when needed, reducing token usage. Writes are event-driven and can be generated by worker jobs with provider-backed summarization. Consolidation is practical rather than theoretical: collect observations, generate useful memories, cite sources, and expose them to the next agent session. The lesson for Quilin is that memory UX matters. Search should return compact, cited, inspectable results before injecting large text into the prompt.

Claude-Mem 针对 Claude Code 工作流优化。它通过 session start、prompt submit、post-tool-use、stop、session end 等 hooks 捕获生命周期事件，再把 observations、generated memory items、events 和 context packs 存入 SQLite/Postgres 风格 schema，并配 Chroma vector search。它提供 HTTP worker service、viewer 和 search 工具。检索路径采用 progressive disclosure：先返回 compact search results，再看 timeline，最后按需取 full observations，从而省 token。写入由事件驱动，也可由 worker jobs 调用模型生成摘要。它的整理很务实：收集观察、生成有用记忆、引用来源，并让下一次 agent session 可用。Quilin 的教训是记忆 UX 很关键：搜索应该先返回紧凑、带引用、可检查的结果，而不是直接把大段文本塞进 prompt。

### TencentDB-Agent-Memory

TencentDB-Agent-Memory combines symbolic short-term memory with layered long-term memory. Its short-term context strategy offloads raw tool outputs into referenced files, keeps step summaries in JSONL, and injects a Mermaid canvas as a symbolic top layer; `node_id` links high-level summaries back to raw evidence. Its long-term personalization pyramid is L0 conversation, L1 atom, L2 scenario, and L3 persona, with a roadmap toward skill generation from traces and scenario patterns. Storage defaults to SQLite plus sqlite-vec, with Tencent Cloud VectorDB optional. Retrieval uses BM25, vector search, scene navigation, persona generation, and local-LLM prompts/parsers. Interfaces are oriented around OpenClaw integration, offload modules, extractors, and local memory tools. The unique lesson is traceable symbolic compression: context compression should preserve navigation structure and provenance, not just shorten text.

TencentDB-Agent-Memory 把符号化短期记忆和分层长期记忆结合起来。它的短期上下文策略会把原始工具输出 offload 到引用文件，把步骤摘要保存为 JSONL，并把 Mermaid canvas 作为符号化顶层注入；`node_id` 可以把高层摘要追溯到原始证据。长期 personalization pyramid 是 L0 conversation、L1 atom、L2 scenario、L3 persona，并规划从 traces 和 scenario patterns 生成 skills。存储默认 SQLite + sqlite-vec，可选 Tencent Cloud VectorDB。检索使用 BM25、vector search、scene navigation、persona generation 和 local-LLM prompts/parsers。接口面向 OpenClaw 集成、offload modules、extractors 和本地工具。它的独特教训是可追溯的符号压缩：context compression 不应只是缩短文本，还要保留导航结构和 provenance。

### GBrain

GBrain is closest to a personal knowledge operating system. Its source of truth is a markdown brain repository, while PGLite/Postgres with pgvector acts as the retrieval index. The loop is signal, search, respond, write, auto-link, and sync. Retrieval is hybrid vector HNSW plus BM25 plus reciprocal-rank fusion, source-tier boosting, intent-aware rewriting, and graph query. Writes update markdown pages, auto-link typed edges without LLM calls, and sync database indexes. Background jobs run through a durable Postgres-native queue, with cron enrichment, crash recovery, leases, doctor/autopilot health remediation, and protected phases such as synthesize, patterns, and consolidate. Evaluation is unusually explicit: BrainBench, LongMemEval-style replay, contradiction eval, and cache behavior. Quilin should learn its source-of-truth split: human-readable durable memory plus machine indexes, not indexes as the only truth.

GBrain 最接近个人 knowledge operating system。它用 Markdown brain repo 作为 truth source，用 PGLite/Postgres + pgvector 作为 retrieval index。循环是 signal、search、respond、write、auto-link、sync。检索是 hybrid vector HNSW + BM25 + reciprocal-rank fusion、source-tier boost、intent-aware rewriting 和 graph query。写入会更新 Markdown pages，用零 LLM 的 auto-link 生成 typed edges，并同步数据库索引。后台任务由 Postgres-native durable queue 执行，带 cron enrichment、crash recovery、leases、doctor/autopilot health remediation，以及 synthesize、patterns、consolidate 等保护阶段。评测也很明确：BrainBench、LongMemEval-style replay、contradiction eval 和 cache behavior。Quilin 应学习它的 source-of-truth 分离：人类可读的 durable memory 加机器索引，而不是把 index 当唯一真相。

### Hermes Agent

Hermes has a pragmatic layered memory story: local `MEMORY.md` and `USER.md` files for declarative facts, SQLite session logs with FTS5 and LLM summarization, and pluggable external memory providers such as Honcho, Supermemory, Hindsight, OpenViking, and Holographic. Writes happen through tools, session capture, provider synchronization, and plugin-specific observation modes. Retrieval combines prompt injection of local memory, session search, provider auto-injection, and provider tools. Consolidation is lightweight but tied into a closed learning loop with periodic nudges and autonomous skill creation after complex tasks. Its interface is the agent CLI plus plugin configuration. The lesson for Quilin is provider abstraction: users may want different memory backends, but the agent needs a single normalized contract for recall, write, profile, and session sync.

Hermes 的记忆实现很务实：本地 `MEMORY.md` 和 `USER.md` 保存声明式事实，SQLite session logs 配 FTS5 和 LLM summarization，并支持 Honcho、Supermemory、Hindsight、OpenViking、Holographic 等外部 memory providers。写入来自工具、session capture、provider synchronization 和插件自己的 observation modes。检索结合本地 memory prompt injection、session search、provider auto-injection 和 provider tools。整理比较轻量，但接入了 periodic nudges 和复杂任务后的 autonomous skill creation。接口是 agent CLI 和插件配置。Quilin 的教训是 provider abstraction：用户可能需要不同记忆后端，但 agent 自身必须有统一的 recall、write、profile、session sync 契约。

### Codex

Codex currently has memory as an experimental feature rather than a full competitor memory platform. The inspected code exposes a `MemoryTool` feature flag for startup memory extraction and file-backed memory consolidation, with memory extension code, MCP memory tests, and protocol support for reset and thread memory mode. Its adjacent memory mechanisms are more mature than the memory engine itself: `AGENTS.md` project instructions, skills, plugins, hooks, and hardened path checks for skill directories. Storage is file-backed outputs such as `MEMORY.md`, summaries, and skills, not a temporal graph or vector memory product. Writes are gated by feature flags and startup extraction jobs. Retrieval is mostly file/context based. The lesson for Quilin is not retrieval quality, but safety and integration discipline: memory should be feature-gated, testable, path-safe, and integrated with project instructions and skills.

Codex 目前的 memory 更像实验特性，而不是完整竞品平台。已检查代码中有 `MemoryTool` feature flag，用于 startup memory extraction 和 file-backed memory consolidation，并有 memory extension、MCP memory tests、reset 与 thread memory mode 协议支持。它相邻的记忆机制比 memory engine 更成熟：`AGENTS.md` 项目指令、skills、plugins、hooks，以及针对 skill 目录的路径安全测试。存储是 `MEMORY.md`、summaries、skills 等文件输出，而不是时态图或向量记忆产品。写入由 feature flag 和 startup extraction jobs 控制。检索主要是 file/context based。Quilin 应学习的不是检索质量，而是安全与集成纪律：memory 必须 feature-gated、可测试、路径安全，并与项目指令和 skills 集成。

### OpenClaw

OpenClaw exposes memory as a configurable plugin and backend surface. Its configuration supports memory search over `MEMORY.md`, memory files, and optionally session transcripts; a QMD sidecar pipeline; sqlite-vec-backed hybrid BM25 plus vector search; MMR reranking; per-query timeouts; snippet and injection budgets; extra collections for cross-agent transcript search; and optional MCPorter daemon routing. Changelog and plugin references show active memory, memory-core dreaming, memory-wiki, memory-lancedb, repair and dedupe recovery flows, heartbeat-driven promotion, and ChatGPT import ingestion. Writes are plugin-driven and can be triggered by channel/session scopes or dreaming events. Retrieval is backend-dependent but clearly optimized for local search and prompt injection budgets. The lesson for Quilin is configurability at the edge: advanced users need backend choice and scoped memory, but the core must keep one canonical lifecycle.

OpenClaw 把 memory 暴露成可配置的 plugin 和 backend 面。它的配置支持搜索 `MEMORY.md`、memory files 和可选 session transcripts；支持 QMD sidecar pipeline；支持 sqlite-vec 的 BM25 + vector hybrid search；支持 MMR reranking、per-query timeout、snippet 与 injection budgets、跨 agent transcript search 的 extra collections，以及可选 MCPorter daemon route。changelog 和 plugin 命中显示它有 active memory、memory-core dreaming、memory-wiki、memory-lancedb、repair/dedupe recovery flows、heartbeat-driven promotion 和 ChatGPT import ingestion。写入由 plugin 驱动，可由 channel/session scopes 或 dreaming events 触发。检索依赖 backend，但明显围绕本地搜索和 prompt injection budget 优化。Quilin 的教训是边缘配置能力：高级用户需要 backend choice 和 scoped memory，但核心生命周期必须保持唯一。

### Claude Code

Claude Code's memory implementation is file-backed and idle-oriented. The `autoDream` service launches a forked subagent to run a consolidation prompt when time and session gates pass, using a lock file to avoid concurrent runs and stale ownership. Its prompt explicitly orients on the memory directory, gathers recent signals, updates topic files, converts relative dates to absolute dates, deletes contradicted facts, prunes the entrypoint, and keeps the index under size constraints. Storage is the auto-memory directory and topic files, not a vector database. Writes happen through the forked dream agent, gated by config, environment, session count, time intervals, and locks. Retrieval is whatever the main Claude memory loading path reads from these files. The key lesson is operational simplicity: cheap gates, lock files, forked background workers, and concrete consolidation prompts can deliver value without a complex service.

Claude Code 的 memory 是 file-backed 且 idle-oriented。`autoDream` service 在时间和 session gates 通过后启动 forked subagent 执行 consolidation prompt，并用 lock file 避免并发运行和 stale ownership。它的 prompt 明确要求先理解 memory directory，收集近期信号，更新 topic files，把相对日期转成绝对日期，删除被矛盾推翻的事实，裁剪 entrypoint，并控制 index 大小。存储是 auto-memory directory 和 topic files，而不是 vector database。写入由 forked dream agent 执行，受 config、environment、session count、time intervals 和 locks 控制。检索则依赖主 Claude memory loading path 读取这些文件。关键教训是运维简单性：便宜的 gates、lock files、forked background workers 和具体 consolidation prompts 就能带来价值，不一定一开始就需要复杂服务。

## 横向对比矩阵 / Cross-Repository Matrix

The table compresses each system into the dimensions that matter for Quilin architecture. "Gate" means an explicit permission or safety boundary for memory writes, not merely an API key or feature flag.

下表把各系统压缩到 Quilin 架构最相关的维度。“Gate”指显式的写入权限或安全边界，而不只是 API key 或 feature flag。

| System | Tiers / Naming | Temporal Handling | LLM Scheduling | Write Gate | Cross-Session Scope | Deployment | Evidence |
|---|---|---|---|---|---|---|---|
| MemMachine | working, episodic, profile, agent persistence | Episodic stores and graph-backed context; temporal less central than Zep | Background ingestion plus request-time retrieval | Service/API controls; no Quilin-style WriteAuthority observed | Per-agent and profile-oriented | Service, REST, SDK, MCP | Source, config, Docker/Helm |
| Letta | core blocks, recall, archival, skills/subagents | Memory pressure and archival recall; weak explicit validity windows | Agent-mediated synchronous tools plus sleep/group flows | Agent tool policy; no strong human gate by default | Per-agent with user/persona blocks | API, CLI, hosted, SDK | Source, config, examples |
| Zep | graph facts, episodes, user/business data | Strong temporal KG with validity intervals | Cloud/service ingestion and context assembly | Service-level controls | Per-user, app, business graph | Cloud-first SDK/API | Examples, eval harness, docs |
| AgentMemory | raw obs, compressed obs, memories, relations, routines, profiles, team | Timeline and graph relations present | Hook-driven plus background compression/consolidation | Local server policies; broad audit namespaces | User, workspace, team | Local server, MCP | Source, tests, benchmark claims |
| Mem0 | user/session/agent memory, facts, entities | Temporal signals and entity-linked facts | Single-pass extraction, low-latency retrieval | API controls; destructive write minimized by ADD-only path | User, session, agent | Library, server, cloud | Benchmarks and source |
| MemPalace | wings, rooms, drawers, diaries, KG | Temporal KG validity and timelines | Mostly local ingestion; optional LLM rerank | Local workflow; no central authority gate | Agent, person, project scoped | Local package, MCP | Benchmarks, source |
| EverCore | MemCells, episodes, profiles, preferences, relationships, semantic | Lifecycle and tenant-aware; temporal less distinctive than Zep | Extraction, classification, agentic multi-round recall | Platform controls, rate limits, locks | Multi-tenant | Multi-service platform | Architecture docs, tests |
| Claude-Mem | observations, memory items, context packs, events | Timeline search and citations | Worker jobs from lifecycle hooks | Hook/server controls; privacy tags | Session and project memory | Local worker, viewer, MCP | Source and schemas |
| TencentDB-Agent-Memory | short-term refs/steps/canvas, L0-L3 long-term | Traceable node lineage; persona evolution | Extractors, local LLM prompts, offload loops | Local tool boundary; no universal WriteAuthority | OpenClaw agent/project | Local package plus optional cloud DB | Source, paper-like README, claims |
| GBrain | markdown pages, graph edges, DB index, jobs | Strong typed graph, contradiction eval, time-aware jobs | Cron/minion durable background jobs | Git/source-of-truth discipline, leases | Personal and shared brain | Local PGLite or Postgres | Source, evals, corpus stats |
| Hermes | MEMORY.md, USER.md, sessions, external providers | Session history and provider-specific modeling | Session tools, periodic nudges, provider sync | Plugin gating and approvals | Per-user/project/provider | CLI plus plugins | Source and plugin docs |
| Codex | MEMORY.md, summaries, skills | Mostly file snapshot and thread mode | Startup extraction jobs | Feature flag and path safety | Project/thread | CLI feature | Source and tests |
| OpenClaw | memory files, sessions, QMD collections, plugins | Scope and transcript history; dreaming promotion | Active memory, heartbeat, dreaming | Plugin config; scoped injection limits | Channel, session, agent, collection | App/plugin, sidecar daemon | Config, changelog, source hits |
| Claude Code | topic files, auto-memory entrypoint | Date normalization in consolidation prompt | Idle autoDream after time/session gates | Config, environment gates, lock file | User memory directory | CLI internal background job | Source |

## Quilin 现状与差距 / Quilin Position and Gaps

Quilin already has several advantages most competitors lack: a documented four-tier memory plan, L3a Observer, Reflector and Consolidator direction, WriteAuthority as a first-class safety primitive, MCP integration, a multi-client architecture, user and soul profile work, and an idle scheduler design that can become a shared runtime for memory, self-evolution, skills, and token monitoring. This gives Quilin a stronger governance foundation than systems that only optimize recall.

Quilin 已经拥有多数竞品缺少的优势：文档化的四层记忆方案、L3a Observer、Reflector 和 Consolidator 方向、作为一等安全原语的 WriteAuthority、MCP 集成、多客户端架构、user/soul profile 工作，以及可服务 memory/self-evolution/skills/token monitoring 的 idle scheduler 设计。这让 Quilin 在治理基础上强于只优化 recall 的系统。

The largest gaps are evidence preservation, temporal truth maintenance, evaluation, and operations. Quilin should not let semantic facts become the only durable memory. It needs a lossless observation layer with citations, validity windows on facts and graph edges, benchmark/replay tests for memory quality, durable background jobs, and progressive disclosure APIs. Without these, reflection and consolidation can become plausible but unverifiable text rewriting.

最大的差距是证据保留、时态真值维护、评测和运维。Quilin 不能让 semantic facts 成为唯一 durable memory。它需要带 citations 的 lossless observation layer、facts 与 graph edges 的 validity windows、memory quality 的 benchmark/replay tests、可靠后台任务，以及 progressive disclosure API。否则 reflection 和 consolidation 容易变成看似合理但不可验证的文本改写。

## 升级建议 / Upgrade Recommendations

Each recommendation names the competitor idea, the Quilin change surface, and an effort estimate. The estimates assume the current Quilin memory implementation continues to use local-first storage first, and only adds heavier services behind optional adapters.

每条建议都标明来源 idea、Quilin 修改面和工时估计。工时假设 Quilin 当前 memory implementation 继续以 local-first 存储为默认，只把更重的服务作为可选 adapter。

| Priority | Competitor Idea | Quilin Change | Effort | Why It Matters |
|---|---|---|---|---|
| P0 | Mem0 batch-like low-latency extraction and current batch LLM judge proposal | Replace per-pair dedupe judgment with batch cluster JSON inside Consolidator while keeping `memory_consolidate_plan` wire shape unchanged | 2-3 days | Avoids 36 pair calls for 9 records and keeps MCP calls within timeout |
| P0 | MemPalace lossless-first storage and Tencent traceable refs | Add a raw observation/evidence table for memory facts, tool outputs, and cited source spans; every semantic fact should link back to evidence ids | 4-7 days | Prevents irreversible hallucinated summaries and makes consolidation auditable |
| P0 | Zep temporal KG and GBrain contradiction eval | Add `valid_from`, `valid_to`, `invalidated_by`, and contradiction metadata to semantic facts and KG edges | 1-2 weeks | User names, preferences, project status, and policies change over time |
| P1 | Claude-Mem progressive disclosure | Add memory search APIs/tools that return compact hits, then timeline, then full evidence payloads | 3-5 days | Reduces prompt bloat and gives agents inspectable recall |
| P1 | GBrain durable Minions and Claude Code autoDream gates | Implement `quilin-daemon` idle scheduler with run table, leases, lock/stale recovery, and bounded budget pool | 1-2 weeks | Memory cleanup must survive crashes and not block chat/web |
| P1 | Tencent symbolic context offload | Add a short-term context offload lane: raw refs, step summaries, and optional graph/canvas summaries with source ids | 1-2 weeks | Compresses long tool sessions without losing navigation or provenance |
| P1 | AgentMemory coding hooks and OpenClaw scoped collections | Capture richer coding lifecycle events with per-user, per-project, per-workspace scopes | 1 week | Makes Quilin memory useful across sessions and clients without global pollution |
| P2 | Mem0, MemPalace, GBrain benchmark discipline | Create a memory-specific eval harness using replayed conversations, contradiction cases, and retrieval gold sets | 1 week | Makes "better memory" measurable instead of subjective |
| P2 | Hermes provider abstraction | Define a narrow memory provider contract for recall/write/profile/session sync, with local implementation first | 1 week | Allows optional external providers without corrupting Quilin's canonical lifecycle |
| P2 | Letta editable core blocks | Expose selected profile/persona blocks as explicit user-editable memory surfaces in WebUI and CLI | 3-5 days | Users need to correct identity and preferences directly, not only through chat |

## 打爆机会 / Opportunities To Beat Them

The first opportunity is a dual-truth memory model: lossless raw evidence plus structured semantic truth. MemPalace keeps raw content, Zep keeps temporal graph truth, and GBrain keeps markdown source of truth, but none of the reviewed systems clearly combines all three with an explicit write authority. Quilin can make every derived fact cite its observation, every contradiction point to the superseded fact, and every destructive action require a proposal and gate.

第一个机会是 dual-truth memory model：lossless 原始证据 + structured semantic truth。MemPalace 保留 raw content，Zep 保留 temporal graph truth，GBrain 保留 Markdown source of truth，但调研系统中没有哪个清晰地把三者和显式 WriteAuthority 组合起来。Quilin 可以让每个派生事实都引用 observation，每个矛盾都指向被替代事实，每个破坏性动作都必须先形成 proposal 并过 gate。

The second opportunity is planner-visible memory, not just prompt-visible memory. Most systems retrieve snippets into context. Quilin can let memory influence planning, tool choice, safety classification, skill selection, and self-evolution proposals through typed contracts. This would make memory part of the agent control loop instead of a smarter search box.

第二个机会是 planner-visible memory，而不只是 prompt-visible memory。多数系统只是把 snippets 检索进上下文。Quilin 可以通过 typed contracts 让记忆影响 planning、tool choice、safety classification、skill selection 和 self-evolution proposals。这样记忆就不只是更聪明的搜索框，而是 agent control loop 的组成部分。

The third opportunity is safe idle intelligence. GBrain has durable jobs, Claude Code has autoDream gates, and OpenClaw has dreaming-style plugins. Quilin can unify memory consolidation, user insight mining, token monitoring, skill scan, and self-evolution proposals under one `quilin-daemon`, with shared budget, leases, observability, and authority gates. That gives the system background cognition without silent mutation.

第三个机会是安全的 idle intelligence。GBrain 有 durable jobs，Claude Code 有 autoDream gates，OpenClaw 有 dreaming-style plugins。Quilin 可以用一个 `quilin-daemon` 统一 memory consolidation、user insight mining、token monitoring、skill scan 和 self-evolution proposals，并共享 budget、leases、observability 和 authority gates。这样系统能有后台认知，但不会静默突变。

The fourth opportunity is bilingual and multi-client memory quality. Most reviewed systems are English-first and single-surface. Quilin's Web, CLI, MCP, profile, soul import, and Chinese-first user requirements make it possible to design memory inspection, correction, and consolidation as a product surface instead of hidden infrastructure.

第四个机会是中英双语和多客户端的记忆质量。多数被调研系统 English-first 且单界面。Quilin 的 Web、CLI、MCP、profile、soul import，以及中文优先用户需求，使它可以把 memory inspection、correction、consolidation 做成产品界面，而不是隐藏基础设施。

## 我不同意的地方 / Disagreements and Cautions

I disagree with the instinct to make "more layers" the primary target. The best systems are not those with the most layer names. The systems that matter preserve evidence, retrieve cheaply, maintain time, and prove quality with evals. Quilin should keep the four-tier design but add provenance, validity, and evaluation before inventing more tier labels.

我不同意把“更多层级”作为主要目标。最强系统不是层级名字最多的系统，而是能保留证据、低成本检索、维护时间语义，并用评测证明质量的系统。Quilin 可以保留四层设计，但应先补 provenance、validity 和 evaluation，而不是继续发明层级名。

I also disagree with making a cloud-scale multi-database stack the default. EverCore and MemMachine show what production services need, but a personal agent should start local-first with SQLite/PGLite-style durability, then expose Postgres/vector/KG adapters only when the user has scale requirements. Heavy infrastructure too early will slow iteration and make the memory system harder to trust.

我也不同意默认上云规模多数据库栈。EverCore 和 MemMachine 展示了生产服务需要什么，但个人 agent 应从 SQLite/PGLite 风格的 local-first durability 起步，再在用户有规模需求时提供 Postgres/vector/KG adapters。过早引入重基础设施会拖慢迭代，也会降低用户对记忆系统的信任。

Finally, I would not let LLM observers become the only writer. Mem0's ADD-only path, MemPalace's verbatim store, Tencent's raw refs, and GBrain's markdown truth source all point in the same direction: model-generated memory is useful, but it must sit on top of non-LLM evidence. Quilin's strongest path is model-assisted memory, not model-owned memory.

最后，我不建议让 LLM observers 成为唯一 writer。Mem0 的 ADD-only path、MemPalace 的 verbatim store、Tencent 的 raw refs、GBrain 的 Markdown truth source 都指向同一个方向：模型生成的记忆有用，但必须建立在非 LLM 证据之上。Quilin 最强的路线应该是 model-assisted memory，而不是 model-owned memory。

## 建议落地顺序 / Suggested Sequencing

The first implementation wave should land batch dedupe, raw evidence links, progressive disclosure search, and temporal validity metadata. These are high leverage because they directly fix correctness, latency, and auditability without requiring a new database service.

第一波实现应落 batch dedupe、raw evidence links、progressive disclosure search 和 temporal validity metadata。这些点杠杆最高，因为它们直接修 correctness、latency 和 auditability，而且不要求先引入新的数据库服务。

The second wave should land the `quilin-daemon` scheduler, short-term symbolic offload, and memory-specific evaluation harness. That turns memory from a passive store into a governed background subsystem, while still keeping writes bounded and inspectable.

第二波应落 `quilin-daemon` scheduler、short-term symbolic offload 和 memory-specific evaluation harness。这样 memory 会从被动 store 变成有治理的后台子系统，同时保持写入有边界、可检查。

The third wave should expand provider adapters, WebUI correction surfaces, and cross-workspace/team memory. These are valuable, but they should wait until the canonical local lifecycle is trustworthy.

第三波再扩 provider adapters、WebUI correction surfaces 和 cross-workspace/team memory。这些都很有价值，但应等 canonical local lifecycle 可信之后再做。
