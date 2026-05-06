# Context 前沿吸收决策 / Context Frontier Assimilation Decision

> Scope: Linear QUI-49. Evidence checked on 2026-05-02 Asia/Shanghai. This document decides what Quilin should absorb for context cache（上下文缓存，复用稳定上下文以降低成本和首 token 延迟）, relevance selection（相关性选择，按任务挑选最有用上下文）, token-aware compression（按 token 预算压缩，在固定窗口内保留关键事实）, runtime delta channel（运行时增量通道，只传变更和可恢复事件）, and long-context / RAG（Retrieval-Augmented Generation，检索增强生成，用检索补足模型上下文窗口）.

> 范围：Linear QUI-49。证据在 2026-05-02 Asia/Shanghai 校准。本文决策 Quilin 应吸收的 context cache（上下文缓存，复用稳定上下文以降低成本和首 token 延迟）、relevance selection（相关性选择，按任务挑选最有用上下文）、token-aware compression（按 token 预算压缩，在固定窗口内保留关键事实）、runtime delta channel（运行时增量通道，只传变更和可恢复事件）以及 long-context / RAG（Retrieval-Augmented Generation，检索增强生成，用检索补足模型上下文窗口）方案。

## 结论 / Decision

The current Quilin design is directionally correct, but F1（Linear 中下一轮运行时规模化实现阶段）should upgrade it from a prompt assembly module into a measurable context operating layer. The core policy is: cache stable prefixes, select before compressing, preserve provenance（来源追踪，用来判断上下文来自哪里以及是否可信）, stream deltas rather than repeated full state, and treat large context windows as scarce working memory rather than free storage.

Quilin 当前设计方向正确，但 F1（Linear 中下一轮运行时规模化实现阶段）应把它从 prompt 组装模块升级为可度量的上下文运行层。核心策略是：缓存稳定前缀、先选择再压缩、保留 provenance（来源追踪，用来判断上下文来自哪里以及是否可信）、用增量流替代重复全量状态，并把大上下文窗口当成稀缺工作记忆而不是免费仓库。

The implementation target for QUI-60 is a five-stage pipeline: `ContextSource` normalization, relevance gating, evidence ordering, budget-aware compression, and cache/delta instrumentation. Each stage must emit structured evidence so QUI-74 can measure TTFT（Time To First Token，首 token 延迟）, cached tokens, quality, and failure cases.

QUI-60 的实现目标是五阶段流水线：`ContextSource` 标准化、相关性门控、证据排布、预算感知压缩、缓存和增量通道观测。每一阶段都必须输出结构化证据，让 QUI-74 能衡量 TTFT（Time To First Token，首 token 延迟）、缓存 token、质量和失败案例。

## 一手证据 / Primary Evidence

OpenAI Prompt Caching supports in-memory and extended retention. Eligible prompts start at 1,024 tokens, usage reports `cached_tokens`, and supported models can keep cached prefixes for up to 24 hours through `prompt_cache_retention`. Source: [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching).

OpenAI Prompt Caching 支持内存保留和延长保留。符合条件的 prompt 从 1,024 token 开始，usage 会报告 `cached_tokens`，支持的模型可通过 `prompt_cache_retention` 把缓存前缀最长保留到 24 小时。来源：[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)。

Anthropic Prompt Caching is breakpoint-based: it caches the full prefix across tools, system, and messages up to a `cache_control` boundary. The default cache lifetime is 5 minutes, with an optional 1-hour mode, and the pricing table makes cache reads much cheaper than normal input. Source: [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Anthropic Prompt Caching 是断点式缓存：它会缓存 tools、system、messages 中直到 `cache_control` 边界为止的完整前缀。默认缓存生命周期为 5 分钟，也支持 1 小时模式，价格表显示缓存读取远低于普通输入成本。来源：[Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

Gemini explicit context caching is designed for large stable context reused by shorter requests, including code repository analysis and large document sets. It bills by cached token count and TTL（Time To Live，缓存存活时间）, treats cached content as a prompt prefix, and returns cached-token counts in `usage_metadata`. Source: [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching).

Gemini 显式上下文缓存适合“大块稳定上下文被短请求反复引用”的场景，包括代码仓库分析和大型文档集。它按缓存 token 数与 TTL（Time To Live，缓存存活时间）计费，把缓存内容视为 prompt 前缀，并在 `usage_metadata` 中返回缓存 token 数。来源：[Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)。

DeepSeek context caching is enabled by default, persists cache prefix units on disk, and exposes `prompt_cache_hit_tokens` plus `prompt_cache_miss_tokens` in usage. It is best-effort rather than guaranteed, so Quilin must treat provider（模型供应商或推理服务路径）cache evidence as measured data, not as an assumption. Source: [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache).

DeepSeek 上下文缓存默认开启，会在磁盘上持久化缓存前缀单元，并在 usage 中暴露 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。它是 best-effort（尽力而为）而不是保证命中，因此 Quilin 必须把 provider（模型供应商或推理服务路径）缓存证据当成实测数据，而不是假设。来源：[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)。

Anthropic Context Editing shows the right runtime compression shape for tool-heavy agents: server-side clearing can remove old tool results or thinking blocks, report `cleared_input_tokens`, and preview token counts. It also warns that clearing can invalidate prompt cache prefixes, so compression must be cache-aware. Source: [Anthropic Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing).

Anthropic Context Editing 展示了重工具 Agent 的正确运行时压缩形态：服务端清理可以移除旧工具结果或 thinking block（思考块，模型推理过程中的中间内容），报告 `cleared_input_tokens`，并预估清理后的 token 数。同时它提醒清理可能让 prompt cache 前缀失效，所以压缩必须感知缓存。来源：[Anthropic Context Editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)。

OpenAI Conversations and Responses APIs（Application Programming Interfaces，应用程序接口，用于让应用调用模型与会话状态服务）show a durable state pattern: conversation objects can persist messages, tool calls, tool outputs, and other items, while `previous_response_id` chains generated responses. OpenAI also states that previous input tokens are still billed, so durable state is not a free replacement for token budgeting. Source: [OpenAI Conversation State](https://developers.openai.com/api/docs/guides/conversation-state).

OpenAI Conversations 和 Responses APIs（Application Programming Interfaces，应用程序接口，用于让应用调用模型与会话状态服务）展示了持久状态模式：conversation object 可以保存 messages、tool calls、tool outputs 和其他 item，`previous_response_id` 可以串联生成结果。OpenAI 同时说明历史输入 token 仍会计费，因此持久状态不能替代 token 预算。来源：[OpenAI Conversation State](https://developers.openai.com/api/docs/guides/conversation-state)。

The MCP（Model Context Protocol，模型上下文协议，用于 Agent 与工具服务之间传输结构化消息）Streamable HTTP（Hypertext Transfer Protocol，网页和服务之间传输请求与响应的协议）specification defines a practical delta-channel baseline: POST/GET（HTTP 写入和读取请求方法）on one endpoint, optional SSE（Server-Sent Events，服务器向客户端持续推送事件的 HTTP 流式机制）, resumability through event IDs and `Last-Event-ID`, and session IDs through `Mcp-Session-Id`. Source: [MCP Transports 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

MCP（Model Context Protocol，模型上下文协议，用于 Agent 与工具服务之间传输结构化消息）Streamable HTTP（Hypertext Transfer Protocol，网页和服务之间传输请求与响应的协议）规范定义了可用的增量通道基线：单一 endpoint 上的 POST/GET（HTTP 写入和读取请求方法）、可选 SSE（Server-Sent Events，服务器向客户端持续推送事件的 HTTP 流式机制）、通过事件 ID 与 `Last-Event-ID` 恢复流、通过 `Mcp-Session-Id` 维护会话。来源：[MCP Transports 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

Vercel AI SDK（Vercel AI Software Development Kit，Quilin 当前 TypeScript LLM 抽象层）has a production-shaped stream pattern: `useChat` can resume active streams, but applications must persist messages, active stream IDs, and stream data. Source: [AI SDK Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams).

Vercel AI SDK（Vercel AI Software Development Kit，Quilin 当前 TypeScript LLM 抽象层）已有接近生产形态的流恢复模式：`useChat` 可以恢复活跃流，但应用必须自己持久化 messages、active stream ID 和 stream data。来源：[AI SDK Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)。

## 缓存吸收项 / Cache Absorption

Quilin should keep the current static/dynamic prompt boundary, but QUI-60 must promote it into a provider-neutral `CachePlan`. The plan should record `stable_prefix_hash`, `eligible_prefix_tokens`, provider mode, retention policy, expected write/read behavior, and the raw usage fields returned by the provider. Here `hash` means a stable digest used to prove whether the cacheable prefix changed.

Quilin 应保留现有静态/动态 prompt 边界，但 QUI-60 必须把它升级为供应商无关的 `CachePlan`。该计划应记录 `stable_prefix_hash`、`eligible_prefix_tokens`、供应商模式、保留策略、预期写入/读取行为，以及供应商返回的原始 usage 字段。这里的 `hash` 指稳定摘要，用来证明可缓存前缀是否发生变化。

The safe default is `stable-system-prefix`: identity, safety rules, stable tool guidance, and stable output schemas go before the cache boundary; per-turn memory recall, current filesystem state, tool outputs, time, and user input stay after the boundary. This follows OpenAI, Anthropic, Gemini, and DeepSeek prefix-matching behavior.

安全默认策略是 `stable-system-prefix`：身份、安全规则、稳定工具指导、稳定输出 schema 放在缓存边界前；每轮记忆召回、当前文件系统状态、工具输出、时间和用户输入放在缓存边界后。这符合 OpenAI、Anthropic、Gemini 和 DeepSeek 的前缀匹配行为。

QUI-74 already defines provider cache evidence; QUI-49 should add the Context-side requirement that every prompt build emits cache eligibility before the LLM（Large Language Model，大语言模型，负责生成和推理）call. A run cannot claim cache improvement unless the artifact contains both the intended `CachePlan` and observed provider usage.

QUI-74 已定义供应商缓存证据；QUI-49 应补充 Context 侧要求：每次 prompt build 都要在 LLM（Large Language Model，大语言模型，负责生成和推理）调用前输出缓存资格。一次运行不能只凭速度声称缓存改进，必须同时保存预期 `CachePlan` 和供应商实测 usage。

## 相关性选择吸收项 / Relevance Selection Absorption

Quilin should implement relevance selection as a staged gate（验收门或筛选门，用明确条件决定内容能否进入下一阶段）, not one top-K query. The minimum chain is candidate generation, metadata（元数据，用来描述来源、时间、权限和可信度的结构化字段）filtering, hybrid scoring, reranking, diversity control, and final placement. OpenAI Retrieval supports metadata filters, rankers, score thresholds, and hybrid search weight controls; LlamaIndex exposes similarity filters, sentence-level optimizers, rerankers, recency postprocessors, and long-context reorder. Sources: [OpenAI Retrieval](https://developers.openai.com/api/docs/guides/retrieval) and [LlamaIndex Node Postprocessors](https://developers.llamaindex.ai/python/framework/module_guides/querying/node_postprocessors/node_postprocessors/).

Quilin 应把相关性选择实现为分阶段 gate（验收门或筛选门，用明确条件决定内容能否进入下一阶段），而不是一次 top-K 查询。最低链路是候选生成、metadata（元数据，用来描述来源、时间、权限和可信度的结构化字段）filtering（元数据过滤）、hybrid scoring（混合打分）、reranking（重排）、diversity control（多样性控制）和最终排布。OpenAI Retrieval 支持元数据过滤、ranker、score threshold 和 hybrid search 权重；LlamaIndex 提供相似度过滤、句子级优化、重排器、时效性后处理和长上下文重排。来源：[OpenAI Retrieval](https://developers.openai.com/api/docs/guides/retrieval) 与 [LlamaIndex Node Postprocessors](https://developers.llamaindex.ai/python/framework/module_guides/querying/node_postprocessors/node_postprocessors/)。

The selection score should be multi-factor: semantic similarity, keyword overlap, source authority, freshness, user intent match, dependency to current files, and safety trust tier. This is necessary because enterprise and codebase contexts fail when stale or low-authority chunks outrank current internal evidence.

选择分数应是多因子：语义相似度、关键词重合、来源权威度、时效性、用户意图匹配、与当前文件的依赖关系、安全可信等级。这是必要的，因为企业和代码库上下文常常不是“找不到信息”，而是陈旧或低权威片段排在当前内部证据前面。

SARA（Selective and Adaptive Retrieval-augmented Generation，一种把文本片段和语义压缩向量结合的检索增强生成方法）adds a useful research direction: combine natural-language snippets with compressed semantic representations, then rerank iteratively. Quilin should not train a SARA model now, but should copy the interface shape: selected context should preserve both exact spans and compact semantic summaries. Source: [SARA paper](https://arxiv.org/abs/2507.05633).

SARA（Selective and Adaptive Retrieval-augmented Generation，一种把文本片段和语义压缩向量结合的检索增强生成方法）提供了有价值的研究方向：同时使用自然语言片段和压缩语义表示，再迭代重排。Quilin 现在不应训练 SARA 模型，但应吸收接口形态：被选中的上下文应同时保留精确原文片段和紧凑语义摘要。来源：[SARA paper](https://arxiv.org/abs/2507.05633)。

## 压缩吸收项 / Compression Absorption

Compression should be triggered by budget pressure, cache economics, and quality risk, not by window overflow alone. The 2026 prompt compression study reports that compression can improve speed only when prompt length, compression ratio, and hardware fit; otherwise the compression step cancels out gains. Source: [Prompt Compression in the Wild](https://arxiv.org/abs/2604.02985).

压缩触发条件不应只有窗口溢出，还应包括预算压力、缓存经济性和质量风险。2026 年 prompt compression 研究显示，只有在 prompt 长度、压缩比例和硬件条件匹配时，压缩才可能提升速度；否则压缩步骤本身会抵消收益。来源：[Prompt Compression in the Wild](https://arxiv.org/abs/2604.02985)。

The practical F1 compressor should support four lanes: lossless trimming of mechanical bloat, extractive compression that keeps cited spans, abstractive summarization for low-risk history, and provider-side context editing when available. Each compressed item must retain `source_ids`, `original_tokens`, `compressed_tokens`, `loss_mode`, and `confidence`.

F1 的实际压缩器应支持四条通道：无损清理机械噪音、保留引用片段的抽取式压缩、用于低风险历史的摘要式压缩、以及供应商可用时的服务端 context editing。每个压缩结果必须保留 `source_ids`、`original_tokens`、`compressed_tokens`、`loss_mode` 和 `confidence`。

Contextual Memory Virtualisation（上下文记忆虚拟化，一种把会话历史建模为可分支状态图并进行结构化裁剪的方案）is relevant for multi-agent（多 Agent 协作，多条执行会话并行推进同一目标）sessions. Its DAG（Directed Acyclic Graph，有向无环图，用来表达可分支可恢复的会话状态）snapshot and trim primitives suggest that Quilin should preserve user and assistant messages verbatim where required, while stripping tool-output bloat and metadata. Source: [CMV paper](https://arxiv.org/abs/2602.22402).

Contextual Memory Virtualisation（上下文记忆虚拟化，一种把会话历史建模为可分支状态图并进行结构化裁剪的方案）对 multi-agent（多 Agent 协作，多条执行会话并行推进同一目标）会话有参考价值。它的 DAG（Directed Acyclic Graph，有向无环图，用来表达可分支可恢复的会话状态）snapshot 和 trim 原语说明：Quilin 应在必要时逐字保留用户和助手消息，同时清理工具输出噪音和机械元数据。来源：[CMV paper](https://arxiv.org/abs/2602.22402)。

## 长上下文吸收项 / Long-Context Absorption

Long windows do not eliminate context selection. Chroma's Context Rot experiments show that model performance can become non-uniform as input length grows, even on tasks that look simple, and that presentation order matters. Source: [Chroma Context Rot](https://www.trychroma.com/research/context-rot).

长窗口不能消除上下文选择。Chroma 的 Context Rot 实验显示，随着输入长度增加，即使看似简单的任务，模型表现也会变得不稳定，并且信息呈现顺序很关键。来源：[Chroma Context Rot](https://www.trychroma.com/research/context-rot)。

Quilin should therefore implement position-aware placement. High-confidence task instructions, safety constraints, and active goals stay near the front; current user input, next action constraints, and high-priority retrieved evidence stay near the end; bulky but lower-risk context stays in the middle only after compression.

因此 Quilin 应实现位置感知排布。高置信任务指令、安全约束和当前目标靠前；当前用户输入、下一步动作约束和高优先级检索证据靠后；体积大但风险较低的上下文只有压缩后才放中部。

LlamaIndex `LongContextReorder` and the original "Lost in the Middle" finding support this placement rule: important details should not be buried in the center of a long input. Sources: [LlamaIndex LongContextReorder](https://developers.llamaindex.ai/python/framework-api-reference/postprocessor/long_context_reorder/) and [Lost in the Middle](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Language-Models-Use-Long).

LlamaIndex 的 `LongContextReorder` 与原始 "Lost in the Middle" 发现都支持这个排布规则：关键细节不应埋在长输入中间。来源：[LlamaIndex LongContextReorder](https://developers.llamaindex.ai/python/framework-api-reference/postprocessor/long_context_reorder/) 与 [Lost in the Middle](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Language-Models-Use-Long)。

Chroma Context-1 adds a stronger future direction: a retrieval subagent can decompose queries, iteratively search, and self-edit its context by discarding irrelevant passages. Quilin should not depend on this model, but should expose a compatible `ContextSelectionTrace` so a future retrieval subagent can plug in. Source: [Chroma Context-1](https://www.trychroma.com/research/context-1).

Chroma Context-1 提供了更强的未来方向：检索子 Agent 可以拆解查询、迭代搜索，并通过丢弃无关片段来 self-edit（自我编辑）上下文。Quilin 不应依赖该模型，但应暴露兼容的 `ContextSelectionTrace`，方便未来接入检索子 Agent。来源：[Chroma Context-1](https://www.trychroma.com/research/context-1)。

## 增量通道吸收项 / Runtime Delta Channel Absorption

The runtime delta channel should be implemented as event sourcing for context, not as a UI-only stream. Every durable change should become a typed event: `context.source_added`, `context.source_selected`, `context.source_compressed`, `context.cache_plan_emitted`, `context.delta_sent`, and `context.resume_cursor_saved`.

运行时增量通道应实现为上下文的 event sourcing（事件溯源，用事件记录状态变化），而不是仅供 UI 使用的流。每个持久变更都应变成类型化事件：`context.source_added`、`context.source_selected`、`context.source_compressed`、`context.cache_plan_emitted`、`context.delta_sent` 和 `context.resume_cursor_saved`。

MCP Streamable HTTP and AI SDK resumable streams imply the same invariant: a disconnected client must resume from a cursor（游标，用来表示已消费到哪条事件）, not force the model to rebuild or resend the full context. For Quilin, the cursor should bind to session ID, stream ID, last event ID, selected source hashes, and the active cache prefix hash.

MCP Streamable HTTP 和 AI SDK 可恢复流暗示同一个不变量：断线客户端必须能从 cursor（游标，用来表示已消费到哪条事件）恢复，而不是迫使模型重建或重发完整上下文。对 Quilin 来说，cursor 应绑定 session ID、stream ID、last event ID、已选 source hash 和活跃缓存前缀 hash。

This delta channel belongs to QUI-60 because it decides what Context emits. Transport-level implementation can later connect to 08 Observability and 11 Agent Mesh, but the Context contract must be fixed first.

这个增量通道属于 QUI-60，因为它决定 Context 输出什么。传输层实现之后可以接入 08 Observability 和 11 Agent Mesh，但必须先固定 Context 契约。

## Linear 映射 / Linear Mapping

QUI-49 is the decision record. Close it only after this document is reviewed and the F1 work items are reflected as comments on existing issues rather than new Linear issues.

QUI-49 是决策记录。只有在本文被 review，并且 F1 工作项已作为 comment 映射到既有 issue 后，才应关闭它；不要因为本文产生新 Linear issue。

QUI-60 owns the implementation of relevance selection, token-aware compression, runtime delta channel, and cache evaluation. Its acceptance should require `CachePlan`, `ContextSelectionTrace`, `CompressionTrace`, and `DeltaStreamTrace` artifacts.

QUI-60 负责实现相关性选择、按 token 预算压缩、运行时增量通道和缓存评测。它的验收应要求产出 `CachePlan`、`ContextSelectionTrace`、`CompressionTrace` 和 `DeltaStreamTrace` 产物。

QUI-51 and QUI-65 own Memory integration. Context selection must consume quilin-mem recall results with source authority, freshness, contradiction status, and user-profile stability fields; Context must not hide memory poisoning or provenance failure.

QUI-51 和 QUI-65 负责 Memory 集成。Context selection 必须消费带有来源权威度、时效性、矛盾状态和用户画像稳定性字段的 quilin-mem 召回结果；Context 不得掩盖 memory poisoning（记忆投毒）或 provenance failure（来源追踪失败）。

QUI-73 already defines the long-memory evaluation baseline. QUI-60 should reuse its local fixture（固定测试样例集，用于可重复验证）lane to test whether selected context contains the right recalled facts without overloading the active prompt.

QUI-73 已定义长期记忆评测基线。QUI-60 应复用其中的本地 fixture（固定测试样例集，用于可重复验证）lane，测试被选中的上下文是否包含正确召回事实，同时不让活跃 prompt 过载。

QUI-74 already defines provider routing, cache, cost, and quality metrics. QUI-60 should feed it Context-side traces（结构化执行轨迹，用来还原一次上下文决策过程）, and QUI-74 should remain the source of pass/fail thresholds for provider cache metrics.

QUI-74 已定义供应商路由、缓存、成本和质量指标。QUI-60 应向它提供 Context 侧 traces（结构化执行轨迹，用来还原一次上下文决策过程），而 QUI-74 继续作为供应商缓存指标通过/失败阈值的来源。

## 最小验收门槛 / Minimum Acceptance Gates

The first F1 gate is deterministic and local: given fixed `ContextSource` fixtures, the selector must drop irrelevant sources, keep cited high-authority sources, preserve contradiction metadata, and produce stable ordering under the same inputs.

第一道 F1 gate 是确定性本地门槛：给定固定 `ContextSource` fixture，selector 必须丢弃无关 source、保留有引用的高权威 source、保存矛盾元数据，并在相同输入下输出稳定排序。

The second F1 gate is budget-aware: when a target token budget is reduced, the compressor must remove or compress lower-value context first, preserve exact cited spans for high-risk facts, and emit before/after token counts.

第二道 F1 gate 是预算感知：当目标 token 预算降低时，compressor 必须优先移除或压缩低价值上下文，保留高风险事实的精确引用片段，并输出压缩前后的 token 数。

The third F1 gate is cache-aware: changing per-turn memory or time context must not change the stable prefix hash. Changing static rules or tool schema must change the hash and force a new cache plan.

第三道 F1 gate 是缓存感知：每轮变化的记忆或时间上下文不得改变稳定前缀 hash；静态规则或工具 schema 改变时必须改变 hash，并生成新的缓存计划。

The fourth F1 gate is delta-aware: stream resumption must continue from the last saved event ID and must not duplicate already-consumed context events. Cancellation must be explicit, not inferred from transport disconnect.

第四道 F1 gate 是增量感知：流恢复必须从最后保存的 event ID 继续，不能重复已消费的上下文事件。取消必须是显式动作，不能从传输断开中推断。

The fifth F1 gate is quality-aware: selected and compressed context must pass a small answer-quality fixture that checks factual correctness, abstention when evidence is missing, and source citation stability.

第五道 F1 gate 是质量感知：被选择和压缩后的上下文必须通过小型回答质量 fixture，检查事实正确性、证据缺失时的拒答，以及引用来源稳定性。

## 不做什么 / Non-Goals

Do not start benchmark-first（基准测试优先）work from this document. The current priority is component frontier absorption; benchmark harness（基准测试脚手架，用来运行和记录评测）work should follow after Context, Memory, LLM routing（大语言模型路由，把任务分配到合适模型或供应商路径）, Tools, and Safety expose measurable component contracts.

不要从本文启动 benchmark-first（基准测试优先）的工作。当前优先级是组件前沿吸收；benchmark harness（基准测试脚手架，用来运行和记录评测）应在 Context、Memory、LLM routing（大语言模型路由，把任务分配到合适模型或供应商路径）、Tools 和 Safety 暴露可测组件契约之后再推进。

Do not create a new Linear issue for these follow-ups unless an independent blocker or owner boundary appears. Under the 250-issue free-plan limit, QUI-49, QUI-60, QUI-51, QUI-65, QUI-73, and QUI-74 are enough to track this work through comments.

除非出现独立 blocker（阻塞项）或 owner boundary（负责人边界），不要为这些后续项新建 Linear issue。在 250 个 issue 的免费版限制下，QUI-49、QUI-60、QUI-51、QUI-65、QUI-73 和 QUI-74 足够通过 comment 跟踪这项工作。

## 下一步 / Next Steps

QUI-60 should begin with data contracts, not algorithms: define `ContextSource`, `CachePlan`, `ContextSelectionTrace`, `CompressionTrace`, and `DeltaStreamTrace` in TypeScript, then wire tests around deterministic fixtures before adding provider live runs.

QUI-60 应从数据契约开始，而不是直接写算法：先在 TypeScript 中定义 `ContextSource`、`CachePlan`、`ContextSelectionTrace`、`CompressionTrace` 和 `DeltaStreamTrace`，再围绕确定性 fixture 接测试，最后再加入供应商 live run。

QUI-51 and QUI-65 should expose memory recall metadata that Context can rank: source kind, authority, created/updated time, contradiction group, confidence, and user-profile impact. Without those fields, Context can only guess relevance.

QUI-51 和 QUI-65 应暴露 Context 可排序的记忆召回元数据：来源类型、权威度、创建/更新时间、矛盾组、置信度和用户画像影响。没有这些字段，Context 只能猜测相关性。

QUI-74 should consume Context traces as first-class metric input. Cache hit rate, TTFT, cost, and quality should be joined with the exact Context decisions that produced the prompt, so regressions can be traced to selection, compression, cache placement, or provider behavior.

QUI-74 应把 Context trace 当作一等指标输入。缓存命中率、TTFT、成本和质量应与产生 prompt 的具体 Context 决策关联起来，这样回归才能定位到选择、压缩、缓存放置或供应商行为。
