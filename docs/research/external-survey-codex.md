# Agent Memory 扩展调研 / External Survey

This is Codex's independent external survey for the Quilin memory-system strategy work. It complements the local fourteen-repository review in `docs/research/competitor-analysis-codex.md` by adding papers, benchmarks, additional repositories, and already-written Quilin design insights.

这是 Codex 为 Quilin 记忆系统战略工作独立产出的扩展调研。它补充 `docs/research/competitor-analysis-codex.md` 的十四仓库本地调研，覆盖论文、benchmark、额外开源仓库，以及 Quilin 现有 docs 中已经写过的设计洞察。

Search note: the available Codex environment exposes WebSearch and normal web browsing. Exa and Tavily were requested, but no callable Exa/Tavily tools are available in this session, so this report only cites sources opened or found through the available web search path.

检索说明：当前 Codex 环境暴露的是 WebSearch 与普通网页浏览。用户要求 Exa 和 Tavily，但本 session 没有可调用的 Exa/Tavily 工具，因此本文只引用当前可用 web search 路径找到并打开过的来源。

## 1. 论文 / Papers

Each paper entry gives the core idea, then the relevance to `quilin-mem`. Links point to arXiv, OpenReview, official repositories, or primary framework documentation where possible.

每条论文记录先给核心 idea，再写与 `quilin-mem` 的关系。链接优先使用 arXiv、OpenReview、官方仓库或框架一手文档。

1. [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — Core idea: virtual context management moves data between fast and slow memory tiers, creating the appearance of a larger context window.

   相关性：Quilin 的 working / episodic / semantic / skill 分层与 MemGPT 的 OS-style memory hierarchy 同源，但 Quilin 不应让模型自己完全拥有写入权。MemGPT 强调“agent 管理自己的 memory”，Quilin 应升级为“agent 可提案、WriteAuthority 负责门禁、FactEvent 负责审计”。它证明 tiering 是必要的，但没有解决 provenance、poisoning 和 human-controlled destructive write。

2. [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) — Core idea: a memory stream is scored by recency, importance, and relevance, then synthesized into higher-level reflections that feed planning.

   相关性：Quilin 已经有 L3a Observer、Reflector、Consolidator 方向，Generative Agents 是这个路线的经典起点。Quilin 应保留它的 observation → reflection → planning loop，但把 reflection 从“写进 prompt 的自然语言”升级为有 trigger、budget、provenance 和 rollback 的 proposals。它也提醒我们：memory 不是只给回答用，还应该改变 planning。

3. [MemoryBank: Enhancing Large Language Models with Long-Term Memory](https://arxiv.org/abs/2305.10250) — Core idea: long-term user memory can evolve with personality modeling and forgetting/reinforcement inspired by the Ebbinghaus forgetting curve.

   相关性：Quilin 现有 profile/user.md 与 ProfileUpdater 已覆盖用户画像，但缺少显式 decay 和 reinforcement。MemoryBank 对 Quilin 的价值不是具体算法，而是把“忘记”变成一等机制：很久不用、低置信、未被引用的记忆应该降权；重复被引用或用户确认的记忆应该强化。这个方向适合接入 retrieval scoring，而不是直接删除原始证据。

4. [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) — Core idea: agents convert feedback into verbal self-reflections stored in episodic memory, improving future trials without parameter updates.

   相关性：Quilin 的 procedural/skill memory 不应只保存成功 SOP，也要保存失败后的 correction。Reflexion 提醒我们把 test failure、review finding、tool error 的“可迁移教训”作为 memory kind，而不是只写 profile facts。Quilin 可以把 Reflexion-style reflection 接到 self-evolution trajectory store 和 skill generation 中。

5. [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291) — Core idea: lifelong learning can compound through an executable skill library indexed and reused across tasks.

   相关性：Quilin 的 13-skills 已经把 Skill 与 Tool 分离，Voyager 说明 procedural memory 的最高价值是可执行、可组合、可验证，而不是自然语言建议。Quilin 应把成功工作流、修复脚本、环境操作经验沉淀成 `SKILL.md` 或 skill candidate，而不仅是 semantic memory。skill creation 必须继续走 WriteAuthority 和 skills_guard。

6. [LongMem: Augmenting Language Models with Long-Term Memory](https://arxiv.org/abs/2306.07174) — Core idea: external memory modules can extend a model beyond fixed input limits by retrieving from unlimited-length history.

   相关性：它代表“模型外长期记忆”的早期方向，但更偏 model architecture，而不是 agent runtime。Quilin 可以吸收“retrieval module 应与模型调用解耦”的思想，但不应依赖训练或模型内部改造。Quilin 的优势应该是透明、可审计、可迁移的 external memory。

7. [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110) — Core idea: Zettelkasten-style notes plus dynamic indexing and linking allow memories to reorganize themselves as new notes arrive.

   相关性：A-MEM 对 Quilin 的启发是“memory network evolution”：新增事实不只追加，也可能触发旧事实标签、摘要和链接的更新。Quilin 已有 KG 和 Consolidator，但应明确把 “link creation / link revision” 做成 proposal，不让 LLM 静默重写旧事实。它也支持把 Markdown human-readable truth 和 graph machine-readable truth结合起来。

8. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) — Core idea: a scalable memory-centric architecture extracts, consolidates, and retrieves salient information, with graph-enhanced memory improving conversational coherence.

   相关性：Mem0 给 Quilin 的最大教训是 benchmark discipline 和低延迟生产路径。Quilin 应复制它的多信号 retrieval、user/session/agent scope、entity linking 和 token/cost metrics，但不应把 memory 变成黑盒 API。Quilin 的差异化应是 local-first、evidence-first、WriteAuthority-first。

9. [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) — Core idea: agent memory can be represented as a bi-temporal knowledge graph that preserves changing relationships over time.

   相关性：Zep 是 Quilin temporal KG 设计的一手支撑。Quilin 已有 KG direction，但还应把 `valid_from`、`valid_to`、`invalidated_by`、`supersedes` 和 contradiction group 作为 memory/block/edge 的一等字段。Zep 的不足是云平台化较强；Quilin 应把时态语义做成本地默认能力。

10. [MemMachine: A Ground-Truth-Preserving Memory System for Personalized AI Agents](https://arxiv.org/abs/2604.04853) — Core idea: preserve full conversational episodes and reduce lossy extraction while still supporting profile and episodic memory.

    相关性：它与我在十四仓库报告中的“非 LLM 原始证据链”判断完全一致。Quilin 现有 `FactEvent` / provenance 设计已经朝这里走，但实现上需要把 raw events、conversation episodes、tool outputs、browser evidence 都做成可引用证据层。这个方向比再加一个 summary layer 更重要。

11. [LangMem SDK for agent long-term memory](https://blog.langchain.com/langmem-sdk-launch) and [LangMem GitHub](https://github.com/langchain-ai/langmem) — Core idea: semantic, episodic, and procedural memory can be exposed as LangGraph-native tools plus a background memory manager.

    相关性：LangMem 的价值是把 manage/search memory 做成 agent 工具，并用 background manager 自动抽取、合并和更新。Quilin 应吸收 tool-facing ergonomics，但不要复制 LangGraph coupling。对 Quilin 来说，memory tools 应该返回 typed blocks 和 citations，而不是只返回文本片段。

12. [AgeMem: Agentic Memory](https://arxiv.org/abs/2601.01885) — Core idea: long-term and short-term memory management are integrated into the agent policy as tool-based actions for store/retrieve/update/summarize/discard.

    相关性：AgeMem 提醒 Quilin：memory 操作本身是 policy 问题，不只是 storage 问题。Quilin 可以让 agent 在计划阶段提出 memory actions，但 destructive update/discard 仍必须经过 Consolidator proposal 和 WriteAuthority。这个方向适合和 planning / safety 联动。

13. [MemBench: Towards More Comprehensive Evaluation on the Memory of LLM-based Agents](https://arxiv.org/abs/2506.21605) — Core idea: memory evaluation should cover factual and reflective memory, participation and observation scenarios, effectiveness, efficiency, and capacity.

    相关性：Quilin 现有 local fixture gate 已覆盖很多指标，但 MemBench 强调 observation mode 与 participation mode 的区别。L3a Observer 和 User Insight Engine 正好需要这个拆分：有些信息是用户直接告诉 agent，有些是 agent 被动观察行为模式。Quilin 应把两类写入分别评分。

14. [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813) — Core idea: long-term chat memory can be evaluated across information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention.

    相关性：Quilin docs 已经把 LongMemEval 作为 public lane 和能力 taxonomy。它仍适合作为能力分类参考，但在 2026 年大上下文窗口环境下不应成为唯一优化目标。Quilin 应使用它的 categories，同时用 local fixtures、BEAM-style large scale 和 write-integrity tests补足。

15. [LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753) — Core idea: long-term conversation benchmark built from personas, temporal event graphs, up to 35 sessions, QA, event summarization, and multimodal dialogue generation.

    相关性：LoCoMo 适合测试 persona/event temporal recall，但公开 benchmark 的规模和 judge 可靠性需要谨慎。Quilin 可以把 speaker attribution、temporal order、multi-hop event graph 和 profile stability 抽成本地 fixtures。它不应该只刷 LoCoMo 分数。

16. [PerLTQA](https://arxiv.org/abs/2402.16288) — Core idea: a personal long-term memory dataset for memory classification, retrieval, and synthesis in QA, with 8,593 questions over 30 characters.

    相关性：PerLTQA 对 Quilin 的价值是“personal memory classification”：不是所有个人信息都应进入同一类记忆。Quilin 的 profile、episodic、semantic、procedural、safety_lesson 应在 write-time 明确分类，并能评测分类错误。它也支持把 synthesis 与 retrieval 分开评分。

17. [DialSim](https://arxiv.org/abs/2406.13144) — Core idea: simulate long, multi-party conversations and ask spontaneous questions under time limits and adversarial name-swap settings.

    相关性：Quilin 多客户端和未来群聊/协作场景会遇到 participant attribution 问题。DialSim 的 multi-party 和 adversarial swap 对 user profile 很关键：系统必须知道“谁说的”和“事实属于谁”。这应该变成本地 fixture 类别，而不是等到真实用户出错。

18. [BEAM: Beyond a Million Tokens](https://arxiv.org/abs/2510.27246) — Core idea: evaluate long-term memory at 100K to 10M-token scales across 100 conversations and 2,000 validated questions, where context stuffing fails.

    相关性：BEAM 是 Quilin 需要认真跟进的规模 benchmark。它指出 LoCoMo/LongMemEval 这类较早 benchmark 可能被大上下文模型“全塞进去”绕过。Quilin 如果要证明“打爆所有”，必须有 1M/10M 量级的 retrieval stress lane，但这应作为明确授权的 memory-specific eval，不应误伤全局 benchmark freeze。

19. [EvoMemBench](https://arxiv.org/abs/2605.18421) — Core idea: evaluate memory from a self-evolving perspective across in-episode vs cross-episode and knowledge-oriented vs execution-oriented memory.

    相关性：这是 Quilin 特别应该关注的新方向，因为 Quilin 同时有 memory 和 self-evolution。普通 benchmark 只问“能否记住事实”，EvoMemBench 更接近“能否用记忆让未来执行变好”。Quilin 应把 execution-oriented memory 纳入 skill/procedural lane。

20. [GroupMemBench](https://arxiv.org/abs/2605.14498) — Core idea: benchmark memory in multi-party conversations where agents must track speaker-specific facts, references, and changes.

    相关性：Quilin 当前更偏单用户，但未来 Web/IM/多 agent 协作会进入 multi-party。Group memory 的核心风险是错把 A 的偏好写到 B 身上。Quilin 的 `actor_id`、`source_event_id`、`profile_impact`、provenance receipt 应从一开始支持多参与者。

21. [MemX: A Local-First Long-Term Memory System for AI Assistants](https://arxiv.org/abs/2603.16171) — Core idea: local-first retrieval uses vector recall, keyword recall, RRF, four-factor reranking, and low-confidence rejection.

    相关性：MemX 支持我的 local-first 判断。Quilin 应吸收 low-confidence rejection：如果 recall 不够确定，系统应 abstain 或 ask, not hallucinate。这个机制应该进入 Context handoff 和 answer policy，而不是只在 retriever 内部。

22. [Skill-Pro / ProcMEM direction](https://arxiv.org/abs/2602.01869) — Core idea: procedural memories become reusable skills with activation, execution, termination conditions, and verification.

    相关性：Quilin 的 13-skills 已经是 procedural memory 的 natural home，但还缺从 episodic trace 到 executable skill 的严肃验证链。Skill memory 不应只是“这次做法不错”的文本，而应包含 activation condition、preconditions、verification command、failure cases 和 provenance。

23. [Episodic-Semantic Memory Architecture for Long-Horizon Scientific Agents](https://arxiv.org/abs/2605.17625) — Core idea: decouple immediate episodic context from consolidated semantic knowledge for dense long-horizon scientific workflows.

    相关性：Quilin 做代码、研究和数据任务时也会出现 dense technical context。该方向支持“episodic 原始证据”和“semantic consolidated knowledge”双轨并行。Quilin 应在 Context 中保留可回溯 episodic evidence，不要只注入 semantic summary。

24. [Soar semantic memory documentation](https://soar.eecs.umich.edu/soar_manual/06_SemanticMemory/) and [Soar episodic-memory work](https://ojs.aaai.org/index.php/AAAI/article/view/8151) — Core idea: cognitive architectures separate working, semantic, episodic, and procedural memory with different learning mechanisms.

    相关性：Soar/ACT-R 不是 LLM-agent 新论文，但它们提醒 Quilin：memory taxonomy 不应只是 UI 标签，而应对应不同写入、检索、失效、学习机制。Quilin 的 skill/procedural memory 应有 verification loop，semantic memory 应有 truth maintenance，episodic memory 应有 temporal reconstruction。

## 2. Benchmark

The benchmark landscape is fragmented. Many public results are not directly comparable because they use different model backbones, judge prompts, retrieval budgets, context limits, and whether the full history is allowed in the prompt.

Benchmark 生态很碎。很多公开分数不能直接比较，因为它们使用不同模型、judge prompt、retrieval budget、上下文长度，以及是否允许把完整历史直接塞进 prompt。

| Benchmark | What it tests | Scale / shape | Typical metrics | Current SOTA signal | Should Quilin run it? |
|---|---|---|---|---|---|
| [LongMemEval](https://arxiv.org/abs/2410.10813) | Chat assistant long-term memory: extraction, multi-session reasoning, temporal reasoning, updates, abstention | 500 curated questions over scalable chat histories | LLM-judge answer accuracy, retrieval recall/NDCG when logs exist | Vendors and memory systems now report 80-90%+ depending on setup; context stuffing can be competitive on small variants | Yes as taxonomy and smoke lane; not enough alone |
| [LoCoMo](https://arxiv.org/abs/2402.17753) | Long-term conversational QA, event summarization, multimodal dialogue generation | Conversations averaging 300 turns / 9K tokens, up to 35 sessions | F1, exact match, category breakdown, evidence recall | Mem0/MemMachine/MemPalace-style systems publish high scores, but judge/data quality concerns exist | Yes for multi-session/persona/temporal local slice; avoid leaderboard obsession |
| [MemBench](https://arxiv.org/abs/2506.21605) | Factual vs reflective memory; participation vs observation scenarios; effectiveness, efficiency, capacity | Synthetic benchmark with multiple memory levels and interaction modes | Accuracy, efficiency, capacity | Highlights failures of retrieval systems under longer inputs and reflective tasks | Yes, especially for Observer/User Insight validation |
| [PerLTQA](https://arxiv.org/abs/2402.16288) | Personal long-term memory classification, retrieval, synthesis in QA | 8,593 questions for 30 characters | Classification, retrieval, synthesis QA | Useful more as dataset structure than public leaderboard | Yes for profile classification and synthesis fixtures |
| [DialSim](https://arxiv.org/abs/2406.13144) | Real-time long-term multi-party dialogue understanding with adversarial settings | Simulator over long multi-party dialogues; time-limited questions | Accuracy under time constraints and adversarial swaps | Good stress test for attribution and real-time recall | Worth a small local adaptation |
| [BEAM](https://arxiv.org/abs/2510.27246) | Beyond-million-token long-term memory across 10 abilities | 100 conversations, 2,000 validated questions, 100K-10M token tiers | Nugget/answer accuracy, latency, scaling | Hindsight, Mem0, Graphonomous, FastMemory-style claims show this is becoming the serious scale lane | Yes, but only after explicit memory-eval authorization |
| [LOFT](https://github.com/google-deepmind/loft) | Long-context frontier tasks across retrieval, RAG, SQL-like reasoning, many-shot, multimodal | 1M+ token long-context benchmark family | Task-specific exact/rubric scores | More long-context than agent-memory specific | Optional control: tests whether long-context can replace retrieval |
| [EvoMemBench](https://arxiv.org/abs/2605.18421) | Memory from self-evolving perspective: in-episode/cross-episode and knowledge/execution memory | New 2026 benchmark direction | Task success, memory quality, efficiency | Too new for stable SOTA, but strategically aligned | High strategic value for Quilin self-evolution |
| [GroupMemBench](https://arxiv.org/abs/2605.14498) | Multi-party memory attribution and speaker-specific facts | New 2026 group conversation benchmark | Speaker attribution, retrieval/application accuracy | Too new; important for collaborative agents | Follow as multi-client/multi-agent scope grows |

Quilin should not publish a score unless each run records dataset version, source hash or commit, model, judge model, prompt, sampling config, retrieval budget, full raw outputs, and whether the full history was allowed in context.

Quilin 不应发布任何 benchmark 分数，除非每次运行记录 dataset version、source hash 或 commit、模型、judge 模型、prompt、sampling config、retrieval budget、完整原始输出，以及是否允许完整历史进入上下文。

The immediate practical move is a three-lane eval plan: local deterministic fixtures for every PR, LongMemEval/LoCoMo smoke slices for compatibility, and BEAM-style large-scale retrieval stress only under explicit memory-eval scope.

短期实际动作应是三条 eval lane：每个 PR 跑本地确定性 fixtures；LongMemEval/LoCoMo 做兼容性 smoke slices；BEAM-style 大规模 retrieval stress 只在明确授权的 memory-eval scope 下运行。

## 3. 没关注到的开源 repo / Additional Open-Source Repositories

These are not replacements for the fourteen-repository local review. They are adjacent systems worth tracking because they cover framework integration, local-first design, benchmark harnesses, or new memory modes.

这些不是十四仓库本地调研的替代品，而是值得继续跟踪的相邻系统，因为它们覆盖框架集成、本地优先、benchmark harness 或新的记忆模式。

| Repo / Project | Address | Pitch | Relation to the 14 repos |
|---|---|---|---|
| LangMem | <https://github.com/langchain-ai/langmem> | LangGraph-native memory tools and background memory manager for semantic/episodic/procedural memory | Overlaps Mem0/Letta; unique value is framework-native ergonomics |
| LlamaIndex Memory | <https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/> | Memory blocks for short-term plus long-term memory, including static, fact extraction, and vector blocks | Overlaps LangMem; useful for block priority and framework API shape |
| AutoGen Teachability | <https://autogenhub.github.io/autogen/docs/notebooks/agentchat_teachability/> | Persists user teachings as memos in a vector DB and retrieves them across chats | Lightweight baseline; good for user-teaching UX |
| LangChain Deep Agents Memory | <https://docs.langchain.com/oss/python/deepagents/memory> | Filesystem-backed long-term memory with user, agent, organization, episodic, and procedural scopes | Overlaps Codex/Claude Code file memory; useful for scope model |
| GraphZep | <https://github.com/aexy-io/graphzep> | TypeScript implementation inspired by Zep/Graphiti temporal KG memory | Complements Zep; useful if Quilin wants TS-side temporal KG ideas |
| LycheeMem | <https://github.com/LycheeMem/LycheeMem> | Lightweight long-term memory with synchronous LangGraph stages and background post-processing | Complements LangMem; useful for pipeline staging |
| memU | <https://github.com/NevaMind-AI/memU> | Memory for 24/7 proactive agents, designed for always-on intent understanding | Complements OpenClaw active memory and Quilin idle daemon direction |
| MemX | <https://arxiv.org/abs/2603.16171> | Local-first memory with RRF, four-factor rerank, and low-confidence rejection | Complements MemPalace/GBrain; reinforces local-first and abstention |
| memory-benchmarks | <https://github.com/mem0ai/memory-benchmarks> | Open evaluation suite for LoCoMo, LongMemEval, BEAM, and memory systems | Complements our eval docs; useful as harness reference |
| MemBench repo | <https://github.com/import-myself/Membench> | Official MemBench repository for factual/reflective and participation/observation evaluation | Complements local observer/user-insight tests |
| LOFT | <https://github.com/google-deepmind/loft> | Long-context benchmark for 1M+ token tasks across retrieval/RAG/SQL/multimodal | Not agent memory, but useful as “can long context replace memory?” control |
| Weaviate Verba | <https://github.com/weaviate/Verba> | RAG application over Weaviate with vector search UX | Overlaps vector memory only; useful mainly for retrieval UI patterns |
| Chroma persistent memory | <https://docs.trychroma.com/> | Persistent vector DB used by many memory prototypes | Infrastructure, not agent memory; useful as optional vector backend |
| Qdrant / Milvus / LanceDB agent memory examples | <https://qdrant.tech/>, <https://milvus.io/>, <https://lancedb.com/> | Vector DB ecosystems with agent/RAG memory examples | Backend options only; do not solve write policy or truth maintenance |
| Redis agent memory patterns | <https://redis.io/resources/redis-whitepaper-ai-agent-memory.pdf> | Redis-backed semantic/session memory patterns for LangGraph-style agents | Useful for low-latency cache/session memory, not canonical truth |

The common weakness in these additional projects is the same as in the fourteen-repo set: storage and retrieval are often treated as the core problem, while write ownership, evidence, contradiction, and user correction UX are underspecified.

这些额外项目的共同弱点与十四仓库类似：多数把存储和检索当作核心问题，而对写入权属、证据、矛盾和用户纠错 UX 规定不足。

## 4. Quilin docs 现有 research insight

Quilin's existing docs already contain many of the ideas that external systems are now converging on. The merge report should not present these as new discoveries; it should treat them as planned contracts that need implementation and prioritization.

Quilin 现有 docs 已经包含很多外部系统正在收敛的 idea。合并报告不应把它们包装成新发现，而应把它们作为已经规划、需要实现和排序的契约。

### 4.1 Memory runtime

`docs/03-memory/memory-runtime-implementation-plan.md` already defines the strongest core memory contract: raw events enter an async observer, candidates become append-only `FactEvent` records, unsafe items go to quarantine, retrieval fuses vector/keyword/entity/temporal signals, and Context receives stable blocks with provenance receipts, trust labels, freshness, contradiction metadata, and cache keys.

`docs/03-memory/memory-runtime-implementation-plan.md` 已经定义了最强的核心 memory contract：raw events 进入 async observer，candidates 变成 append-only `FactEvent`，不安全项进 quarantine，检索融合 vector/keyword/entity/temporal signals，Context 收到带 provenance receipt、trust label、freshness、contradiction metadata 和 cache key 的 stable blocks。

The most important already-thought ideas are: raw evidence is never replaced by derived memory; corrections become new events rather than destructive updates; quarantine is reviewable state; poisoning is checked at candidate, promotion, retrieval, and Context handoff; local fixtures must cover extraction, multi-hop, temporal updates, contradiction, abstention, profile stability, poisoning, provenance, and bilingual turns.

这里最重要的已规划 idea 是：派生记忆永远不能替代原始证据；纠错创建新事件而不是破坏性 update；quarantine 是可 review 状态；投毒在候选、提升、检索、Context 交接四阶段检查；本地 fixtures 必须覆盖抽取、多跳、时态更新、矛盾、拒答、画像稳定、投毒、来源和中英双语。

### 4.2 Memory README and v2 fusion design

`docs/03-memory/README.md` already records Quilin's four-layer goal and the v2 fusion architecture: Working Memory, Verbatim Episodic Store, Observation Layer, Temporal KG, Hybrid Retrieval/Fusion, Procedural/Skill Stats, and Consolidator. It explicitly names MemPalace, Mem0, Graphiti/Zep, OpenViking, and observer/reflector-style systems as orthogonal inspirations.

`docs/03-memory/README.md` 已经记录了 Quilin 的四层目标和 v2 融合架构：Working Memory、Verbatim Episodic Store、Observation Layer、Temporal KG、Hybrid Retrieval/Fusion、Procedural/Skill Stats 和 Consolidator。它已经明确把 MemPalace、Mem0、Graphiti/Zep、OpenViking、observer/reflector-style systems 作为正交灵感来源。

The gap is less in architecture imagination and more in implementation sequencing. The README already says not to bet on a single library, to keep L2 verbatim, to use lazy temporal KG only for temporal intent, and to use block-level invalidation for prompt-cache stability.

差距不在架构想象，而在实现排序。README 已经写过不要押注单一库、L2 保留 verbatim、Temporal KG 只在 temporal intent 下 lazy 使用，以及通过 block-level invalidation 保持 prompt cache 稳定。

### 4.3 Context integration

`docs/02-context/context-runtime-implementation-plan.md` already draws the correct boundary: Memory decides what facts exist and how trustworthy they are; Context decides what enters the prompt. It requires `ContextSource`, Memory block handoff, validity windows, contradiction groups, poisoning status, score components, compression trace, and cache plan trace.

`docs/02-context/context-runtime-implementation-plan.md` 已经划清边界：Memory 决定哪些事实存在、可信度如何；Context 决定什么进入 prompt。它要求 `ContextSource`、Memory block handoff、validity windows、contradiction groups、poisoning status、score components、compression trace 和 cache plan trace。

This is stronger than most external systems because it prevents retrieved memory from silently becoming instruction. It also makes prompt-cache economics first-class, which matters once memory blocks become stable or volatile prompt sections.

这比多数外部系统更强，因为它防止被召回的 memory 静默变成 instruction。它也把 prompt-cache economics 作为一等问题，这在 memory blocks 变成 stable 或 volatile prompt sections 后非常关键。

### 4.4 Idle scheduler

`docs/00-core-loop/idle-scheduler-design.md` already upgrades memory idle jobs into a cross-domain `quilin-daemon`: memory observer replay, Reflector, Consolidator, self-evolution proposals, User Insight Engine, skills, token budget monitoring, future replay, and benchmark schedules. It selects a separate process for failure isolation, leases, budget accounting, retries, observability, and WriteAuthority orchestration.

`docs/00-core-loop/idle-scheduler-design.md` 已经把 memory idle jobs 升级成跨域 `quilin-daemon`：memory observer replay、Reflector、Consolidator、self-evolution proposals、User Insight Engine、skills、token budget monitoring、future replay 和 benchmark schedules。它选择独立进程来负责失败隔离、leases、预算核算、重试、可观测和 WriteAuthority 编排。

This is a key “beat everyone” advantage if implemented: most competitors have either background jobs or memory logic, but few have a shared safety-aware idle runtime that spans memory, skills, self-evolution, and budget.

如果实现，这会成为 “打爆所有” 的关键优势：多数竞品要么有后台任务，要么有 memory logic，但很少有跨 memory、skills、self-evolution、budget 的共享安全感知 idle runtime。

### 4.5 Skills as procedural memory

`docs/13-skills/README.md` already defines Skills as knowledge/instruction assets distinct from Tools, with `SKILL.md`, catalog-first injection, on-demand `skill_view`, safety scanning, CRUD through `skill_manage`, hot reload, post-compact recovery, and future background nudge/self-evolution. This is Quilin's procedural memory substrate.

`docs/13-skills/README.md` 已经把 Skills 定义成与 Tools 不同的知识/指令资产，并包含 `SKILL.md`、catalog-first injection、按需 `skill_view`、安全扫描、通过 `skill_manage` CRUD、热加载、post-compact recovery，以及未来 background nudge/self-evolution。这就是 Quilin 的 procedural memory substrate。

External procedural-memory papers mostly confirm this direction. The missing piece is a trace-to-skill compiler with verification: activation condition, preconditions, executable steps or scripts, expected evidence, tests, and rollback.

外部 procedural-memory 论文大多确认这个方向。缺口是 trace-to-skill compiler with verification：activation condition、preconditions、可执行步骤或脚本、expected evidence、tests 和 rollback。

### 4.6 Soul Import and profile bootstrap

`docs/16-soul-import/README.md` already treats install-time framework scanning as cold-start memory bootstrap. It separates global `soul.md`, global `user.md`, and project-local `QUILIN.md`, requires WriteAuthority for CRITICAL writes, redacts secrets, produces import receipts, and maps imported framework data into quilin-mem with provenance.

`docs/16-soul-import/README.md` 已经把安装期框架扫描视为冷启动记忆 bootstrap。它分离全局 `soul.md`、全局 `user.md` 和项目级 `QUILIN.md`，要求 CRITICAL 写入走 WriteAuthority，脱敏 secrets，产出 import receipts，并把导入框架数据带 provenance 映射到 quilin-mem。

This is rare among competitors: most memory systems start from blank state or only import chat logs. Quilin can start with the user's existing agent history, but only if conflict resolution and preview UX are strong.

这在竞品中很少见：多数记忆系统从空白状态开始，或只导入聊天日志。Quilin 可以从用户已有 agent 历史开始，但前提是冲突解决和 preview UX 足够强。

### 4.7 Self-evolution

`docs/10-self-evolution/README.md` already implements a trajectory store, failure analyzer, proposal store, replay harness, sandbox policy gate, and WriteAuthority integration. This can become the execution-memory side of Quilin: memory should not only remember facts, but also remember what changed future success.

`docs/10-self-evolution/README.md` 已经实现 trajectory store、failure analyzer、proposal store、replay harness、sandbox policy gate 和 WriteAuthority 集成。这可以成为 Quilin 的 execution-memory 侧：记忆不只记事实，还应记住什么经验改变了未来成功率。

The key integration gap is a typed bridge between memory facts and self-evolution trajectories: failure lessons, skill candidates, avoided mistakes, and predicted/actual effect records should be first-class memory objects.

关键集成缺口是 memory facts 与 self-evolution trajectories 之间的 typed bridge：failure lessons、skill candidates、avoided mistakes、predicted/actual effect records 都应成为一等 memory objects。

## 5. 跟 14 repo 的 cross-reference

The external survey reinforces the same convergence pattern as the fourteen local repositories, but adds several missing axes: benchmarks, participation-vs-observation, group attribution, and self-evolving execution memory.

扩展调研强化了十四仓库本地调研中的同一收敛趋势，但额外补上了几个缺失轴：benchmark、participation-vs-observation、group attribution 和 self-evolving execution memory。

| Theme | 14-repo signal | External signal | Quilin implication |
|---|---|---|---|
| Lossless evidence | MemPalace, TencentDB-Agent-Memory, GBrain, MemMachine | MemMachine paper, MemX local-first | Implement raw evidence / observation store before aggressive summarization |
| Temporal truth | Zep, GBrain, MemPalace | Zep paper, LoCoMo, LongMemEval | Add validity windows and contradiction groups everywhere |
| Batch/cheap consolidation | Mem0, GBrain | Mem0 paper, BEAM scale pressure | Batch LLM judge and scheduled consolidation are mandatory |
| Procedural memory | Voyager-like skills in GBrain/Hermes/Codex/OpenClaw | Voyager, Skill-Pro / ProcMEM | Trace-to-skill with verification should be a roadmap item |
| Participation vs observation | AgentMemory hooks, Claude-Mem lifecycle hooks | MemBench | Score observer and chat participation separately |
| Multi-party attribution | Less covered in the 14 except group/workspace scope | DialSim, GroupMemBench | Actor identity must be first-class in provenance and profile writes |
| Local-first | MemPalace, GBrain, claude-mem, agentmemory | MemX | Keep SQLite/PGLite/local truth default; services optional |
| Eval discipline | Mem0, MemPalace, GBrain | LongMemEval, LoCoMo, MemBench, BEAM | Use local deterministic gates + public smoke + explicit scale lanes |
| Safe idle jobs | Claude Code autoDream, GBrain jobs | EvoMemBench, self-evolving memory direction | `quilin-daemon` is a strategic differentiator |
| Memory ownership | Letta editable blocks, GBrain markdown truth | LangChain scopes, Soul Import docs | Expose correction UI and source-of-truth files, not black-box memory |

## 6. 还没充分考虑但应该 ship 的 idea

These are my top five additions beyond the current docs and the fourteen-repo review. They should be candidates for the unified roadmap, not immediate code changes in this research task.

下面是我认为超出现有 docs 与十四仓库调研、但值得进入统一 roadmap 的五个新增点。本任务不写代码，只作为后续合并报告候选项。

1. **Memory write-integrity benchmark / 记忆写入完整性评测**：Most benchmarks test retrieval, but production failures often come from wrong writes, silent overwrites, or bad merges. Quilin should add a local lane that deliberately tests profile overreach, concurrent writes, restart flush, supersession, rollback, and no-source memory creation.

   **记忆写入完整性评测**：多数 benchmark 测 retrieval，但生产事故常来自错误写入、静默覆盖或错误 merge。Quilin 应新增本地 lane，专门测试 profile overreach、并发写、restart flush、supersession、rollback 和无来源记忆创建。

2. **Participation vs observation scoring / 参与式与观察式分开评分**：MemBench makes this distinction explicit. Quilin's L3a Observer, User Insight Engine, and chat-time user profile writes must be scored separately because passive observation has different consent, confidence, and poisoning risks.

   **参与式与观察式分开评分**：MemBench 明确提出这一区分。Quilin 的 L3a Observer、User Insight Engine 和 chat-time user profile writes 必须分开评分，因为被动观察在 consent、confidence、poisoning risk 上完全不同。

3. **Actor-scoped provenance / 参与者作用域来源凭据**：DialSim and GroupMemBench show that multi-party memory fails when speaker identity is weak. Quilin's `ProvenanceReceipt` should include `actor_id`, `actor_role`, `conversation_scope`, and `profile_target_id`, and profile writes should fail closed if target identity is ambiguous.

   **参与者作用域来源凭据**：DialSim 和 GroupMemBench 说明 speaker identity 弱时，多方记忆会出错。Quilin 的 `ProvenanceReceipt` 应包含 `actor_id`、`actor_role`、`conversation_scope`、`profile_target_id`，且 profile target 不明确时默认拒绝写入。

4. **Low-confidence rejection in retrieval / 检索低置信拒答**：MemX and benchmark failure reports show that wrong recall is worse than no recall. Quilin retrieval should return `insufficient_memory_evidence` when fused confidence is low, and Context should either ask a clarifying question or answer with explicit uncertainty.

   **检索低置信拒答**：MemX 和 benchmark failure reports 都显示错误召回比不召回更糟。Quilin retrieval 在融合置信度低时应返回 `insufficient_memory_evidence`，Context 应追问或带不确定性作答。

5. **Trace-to-skill compiler with eval / 带评测的轨迹到技能编译器**：Voyager and procedural-memory papers show that durable learning should become executable skill, not only prose. Quilin already has Skill infrastructure and self-evolution trajectories; it should compile repeated successful patterns into skill candidates with activation conditions, tests, provenance, and WriteAuthority review.

   **带评测的轨迹到技能编译器**：Voyager 和 procedural-memory 论文说明 durable learning 应变成可执行 skill，而不只是文字。Quilin 已有 Skill infrastructure 和 self-evolution trajectories，应把重复成功模式编译成带 activation conditions、tests、provenance 和 WriteAuthority review 的 skill candidates。

## 7. 建议合并进统一报告的路线图增量 / Roadmap Deltas For Unified Report

The unified report should keep the already-planned QUI-188/189/190 work, but add four workstreams: Memory Integrity Eval, Actor-Scoped Provenance, Observation-vs-Participation Lanes, and Trace-to-Skill Compiler. These are the pieces most likely to make Quilin stronger than systems that only optimize retrieval scores.

统一报告应保留已规划的 QUI-188/189/190 工作，但新增四条 workstream：Memory Integrity Eval、Actor-Scoped Provenance、Observation-vs-Participation Lanes 和 Trace-to-Skill Compiler。这些最可能让 Quilin 强于只优化 retrieval 分数的系统。

The sequencing should be conservative: first implement evidence and actor scopes, then add scoring lanes, then let the daemon run bounded background consolidation, then enable skill/procedural memory generation. This avoids building impressive idle jobs on top of untrustworthy memory writes.

落地顺序应保守：先实现 evidence 与 actor scopes，再加 scoring lanes，然后让 daemon 跑有边界的后台整理，最后启用 skill/procedural memory generation。这样可以避免在不可信写入基础上堆出看似很强的 idle jobs。
