# 生产供应商矩阵计划 / Production Provider Matrix Plan

> Evidence date: 2026-05-02 Asia/Shanghai. Scope: Linear `QUI-14`. This file is a future production backlog boundary for LLM（Large Language Model，大语言模型）provider operations; it is not the same artifact as frontier absorption in `llm-frontier-assimilation.md` or the near-term `ProviderControlPlane`（供应商控制平面，用来统一决定供应商、模型、预算、缓存、失败回退和错误处理）implementation plan in `provider-control-plane-plan.md`.
>
> 证据日期：Asia/Shanghai 2026-05-02。范围：Linear `QUI-14`。本文是 LLM（Large Language Model，大语言模型）供应商运行生产化的未来 backlog（待办边界）；它不是 `llm-frontier-assimilation.md` 的前沿吸收决策，也不是 `provider-control-plane-plan.md` 的近期 `ProviderControlPlane`（供应商控制平面，用来统一决定供应商、模型、预算、缓存、失败回退和错误处理）实现计划。

## 边界 / Boundary

`llm-frontier-assimilation.md` decides that Quilin should use a hybrid direct-provider and AI Gateway（模型网关，通过一个入口访问多个供应商/模型）strategy. `provider-control-plane-plan.md` turns that decision into the first implementation path for route decisions, attempt records, cost control, rate limits, and normalized errors.
>
> `llm-frontier-assimilation.md` 决定 Quilin 应采用直连供应商与 AI Gateway（模型网关，通过一个入口访问多个供应商/模型）混合策略。`provider-control-plane-plan.md` 把这个决策转成第一阶段实现路径：路由决策、尝试记录、成本控制、限流和归一化错误。

This `QUI-14` file owns the production backlog that remains after the first control plane exists: the provider matrix as a durable runtime catalog, bounded fallback and retry policy, reasoning replay and carry-over, an Ollama（本机模型运行服务，用来在用户机器上运行本地模型）production adapter, and streaming token accounting.
>
> 本 `QUI-14` 文件承载第一阶段控制面存在之后仍要完成的生产化 backlog：把供应商矩阵做成持久 runtime catalog（运行时目录）、有边界的失败后备与重试策略、reasoning replay/carry-over（推理状态复用/延续）、Ollama（本机模型运行服务，用来在用户机器上运行本地模型）生产适配器，以及 streaming token accounting（流式 token 计量）。

The file should not be used to mark runtime work complete. It is a backlog and acceptance-gate document. Linear `QUI-14` should remain open until code emits the records and behaviors described here, even if this document is complete.
>
> 本文件不应被用来宣称运行时代码完成。它是 backlog 与验收门槛文档。即使本文完成，Linear `QUI-14` 也应继续保持打开，直到代码实际输出本文定义的记录并具备相应行为。

## 一手来源 / Primary Sources

The Vercel AI SDK（Vercel 的 TypeScript 模型调用工具包）provides `streamText`, `maxRetries`, timeout controls including `chunkMs` for stalled streams, provider warnings, response metadata, and `modelId` evidence. Source: [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).
>
> Vercel AI SDK（Vercel 的 TypeScript 模型调用工具包）提供 `streamText`、`maxRetries`、包括 `chunkMs` 卡住流检测在内的超时控制、供应商 warning（警告）、响应元数据和 `modelId` 证据。来源：[AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)。

The Vercel AI SDK exposes `createProviderRegistry`（供应商注册表，用统一字符串 ID 管理多个供应商和模型）and language model middleware（模型中间件，用来包裹模型调用并加入日志、缓存、保护或推理提取）as the closest official extension points for provider registration and cross-provider behavior. Sources: [AI SDK provider registry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry), [AI SDK middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware).
>
> Vercel AI SDK 暴露 `createProviderRegistry`（供应商注册表，用统一字符串 ID 管理多个供应商和模型）与 language model middleware（模型中间件，用来包裹模型调用并加入日志、缓存、保护或推理提取），这是供应商注册和跨供应商行为最接近官方的扩展点。来源：[AI SDK provider registry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry)、[AI SDK middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)。

Vercel AI Gateway supports model fallbacks through `providerOptions.gateway.models`, provider filtering and ordering through `only` and `order`, and provider timeout evidence through `providerTimeouts` and routing attempt metadata. Sources: [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks), [Vercel provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering), [Vercel provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts).
>
> Vercel AI Gateway 支持通过 `providerOptions.gateway.models` 做模型失败后备，通过 `only` 与 `order` 做供应商过滤和排序，并通过 `providerTimeouts` 与 routing attempt metadata（路由尝试元数据）保留供应商超时证据。来源：[Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)、[Vercel provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)、[Vercel provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts)。

OpenAI Responses API（OpenAI 的多轮响应接口）documents reasoning items（模型推理状态项）, `previous_response_id`, encrypted reasoning content, and streaming via semantic events. Sources: [OpenAI reasoning guide](https://platform.openai.com/docs/guides/reasoning), [OpenAI conversation state](https://platform.openai.com/docs/guides/conversation-state?api-mode=responses), [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses).
>
> OpenAI Responses API（OpenAI 的多轮响应接口）记录了 reasoning items（模型推理状态项）、`previous_response_id`、encrypted reasoning content（加密推理内容）和基于语义事件的流式响应。来源：[OpenAI reasoning guide](https://platform.openai.com/docs/guides/reasoning)、[OpenAI conversation state](https://platform.openai.com/docs/guides/conversation-state?api-mode=responses)、[OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)。

Ollama exposes an HTTP API（Hypertext Transfer Protocol API，基于 HTTP 的本地接口）with `POST /api/chat`, streaming JSON objects, `tools`, structured `format`, `think`, `keep_alive`, and final response statistics. Ollama also maintains an official JavaScript client whose API is designed around the same REST API. Sources: [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md), [Ollama JavaScript library](https://github.com/ollama/ollama-js).
>
> Ollama 暴露 HTTP API（Hypertext Transfer Protocol API，基于 HTTP 的本地接口），包括 `POST /api/chat`、流式 JSON 对象、`tools`、结构化 `format`、`think`、`keep_alive` 和最终响应统计。Ollama 也维护官方 JavaScript 客户端，其 API 围绕同一 REST API（Representational State Transfer API，一种常见 HTTP 接口风格）设计。来源：[Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)、[Ollama JavaScript library](https://github.com/ollama/ollama-js)。

## 生产供应商矩阵 / Production Provider Matrix

The production matrix should be a runtime catalog, not a static table in docs. It should describe every provider path Quilin can use: direct OpenAI, direct Anthropic, direct Google/Gemini, direct DeepSeek, AI Gateway, and local Ollama. Each entry should declare capabilities, cost model, cache evidence, reasoning behavior, streaming behavior, structured-output support, tool-calling support, data policy, credentials, and live evidence age.
>
> 生产供应商矩阵应是 runtime catalog（运行时目录），而不是 docs 里的静态表。它应描述 Quilin 可用的每条供应商路径：OpenAI 直连、Anthropic 直连、Google/Gemini 直连、DeepSeek 直连、AI Gateway 和本地 Ollama。每个条目都应声明能力、成本模型、缓存证据、推理行为、流式行为、结构化输出支持、工具调用支持、数据策略、凭证和实机证据新鲜度。

The matrix should be loaded by the LLM runtime during startup, validated before the first provider call, and snapshotted into every `ProviderRunRecord`（供应商运行记录，用来复盘每一次模型调用）. A route may use only matrix entries whose capability and policy flags match the `LLMRouteDecision`（模型路由决策，用来固定本次调用允许怎么执行）.
>
> 该矩阵应在 LLM runtime（大语言模型运行时）启动时加载，在首次供应商调用前校验，并快照写入每条 `ProviderRunRecord`（供应商运行记录，用来复盘每一次模型调用）。一条路由只能使用能力和策略标记匹配 `LLMRouteDecision`（模型路由决策，用来固定本次调用允许怎么执行）的矩阵条目。

The first production shape should include `provider_path`, `provider_mode`, `model_id`, `capabilities`, `required_env`, `credential_scope`, `data_residency`, `stream_protocol`, `usage_mapping`, `retry_policy_id`, `fallback_group_id`, `reasoning_state_adapter`, `cost_source`, `last_live_matrix_at`, and `promotion_state`.
>
> 第一版生产形态应包含 `provider_path`、`provider_mode`、`model_id`、`capabilities`、`required_env`、`credential_scope`、`data_residency`、`stream_protocol`、`usage_mapping`、`retry_policy_id`、`fallback_group_id`、`reasoning_state_adapter`、`cost_source`、`last_live_matrix_at` 和 `promotion_state`。

The trigger to modify the matrix is any new provider, model snapshot, local model tag, gateway provider order, cost policy, data policy, or reasoning/caching behavior. The matrix should reject changes that lack a current live record or an explicit `blocked` reason.
>
> 触发修改矩阵的条件包括：新增供应商、模型快照、本地模型 tag、网关供应商顺序、成本策略、数据策略，或推理/缓存行为变化。矩阵应拒绝缺少当前实机记录且没有明确 `blocked` 原因的变更。

Acceptance requires a machine-readable matrix fixture, schema validation, at least one live or blocked record for each enabled provider path, trace-visible matrix version, and a route decision that proves why a provider path was eligible.
>
> 验收要求包括：可机器读取的矩阵 fixture（样例配置）、schema 校验、每条启用供应商路径至少一条实机或 blocked（阻塞）记录、trace（追踪）中可见的矩阵版本，以及能证明供应商路径为何符合条件的路由决策。

## 失败后备与重试策略 / Fallback And Retry Policy

Fallback（失败后备，即主供应商或模型失败后切换到预先批准的备选路径）and retry（重试，即同一路径短暂失败后的再次尝试）must be separate runtime concepts. Retry should normally stay within the same provider path. Fallback is a behavior change and must require capability, data-policy, safety-policy, and budget-policy equivalence.
>
> Fallback（失败后备，即主供应商或模型失败后切换到预先批准的备选路径）与 retry（重试，即同一路径短暂失败后的再次尝试）必须是两个独立运行时概念。Retry 通常应留在同一供应商路径内。Fallback 是行为变更，必须要求能力、数据策略、安全策略和预算策略等价。

The runtime should set AI SDK `maxRetries` only when Quilin can still observe every retry attempt. Until that evidence is proven, production routes should prefer `maxRetries: 0` and let `ProviderControlPlane` own retry loops and attempt ledgers.
>
> 只有当 Quilin 能观察每一次重试尝试时，运行时才应设置 AI SDK 的 `maxRetries`。在证据证明前，生产路由应优先使用 `maxRetries: 0`，由 `ProviderControlPlane` 自己管理重试循环和 attempt ledger（尝试账本）。

Gateway fallback may use `providerOptions.gateway.models`, `order`, `only`, and `providerTimeouts`, but the result is acceptable only when `providerMetadata.gateway.routing.attempts` is copied into Quilin trace storage. Direct fallback must produce the same local attempt ledger shape.
>
> 网关后备可以使用 `providerOptions.gateway.models`、`order`、`only` 和 `providerTimeouts`，但只有当 `providerMetadata.gateway.routing.attempts` 被复制进 Quilin trace storage（追踪存储）时，结果才可接受。直连后备必须输出同等形状的本地尝试账本。

Retryable errors are limited to network failures, provider overload, provider timeout, stream chunk timeout, and rate-limit states with a known retry window. Authentication errors, permission errors, invalid requests, unsupported capabilities, safety blocks, and schema errors should not be retried until the request is repaired.
>
> 可重试错误只限于网络失败、供应商过载、供应商超时、流式片段超时，以及带明确重试窗口的限流状态。认证错误、权限错误、无效请求、不支持能力、安全阻断和 schema（结构约束）错误，在请求被修复前不应重试。

The trigger to enable fallback is not "provider list has more than one model". It is a route-level declaration that the fallback group has passed live equivalence for output shape, tool behavior, structured output, reasoning behavior, cache metadata, cost accounting, and user-visible policy.
>
> 启用 fallback 的触发条件不是“供应商列表里有多个模型”。它必须是一条路由级声明：该 fallback group（后备组）已经通过输出形态、工具行为、结构化输出、推理行为、缓存元数据、成本核算和用户可见策略的实机等价验证。

Acceptance requires a deterministic `ProviderAttempt` record for every try, a hard cap on attempts, exponential backoff with jitter（随机扰动，用来避免并发重试同时打爆供应商）, no silent provider substitution, and a final answer record that names the winning provider and every failed attempt.
>
> 验收要求包括：每次尝试都有确定性的 `ProviderAttempt` 记录、尝试次数有硬上限、带 jitter（随机扰动，用来避免并发重试同时打爆供应商）的指数退避、没有静默供应商替换，以及最终答案记录写明胜出的供应商和所有失败尝试。

## 推理状态复用与延续 / Reasoning Replay And Carry-Over

Reasoning replay/carry-over（推理状态复用/延续，即跨工具调用或跨轮次保留模型可继续使用的推理状态）should be provider-specific and opt-in by route. It must never expose raw hidden reasoning to the user or to unrelated tools. The runtime should preserve only provider-approved opaque items, response IDs, summaries, or encrypted content.
>
> Reasoning replay/carry-over（推理状态复用/延续，即跨工具调用或跨轮次保留模型可继续使用的推理状态）应按供应商专门处理，并由路由显式开启。它绝不能把原始隐藏推理暴露给用户或无关工具。运行时只应保留供应商批准的不透明项目、响应 ID、摘要或加密内容。

For OpenAI Responses API routes, the production adapter should support `previous_response_id` when provider-side state is allowed, and encrypted reasoning item carry-over when stateless or zero-data-retention mode requires the client to return reasoning items. The adapter should record whether state came from provider storage or client-carried encrypted content.
>
> 对 OpenAI Responses API 路由，生产适配器应在允许供应商侧状态时支持 `previous_response_id`，并在 stateless（无状态）或 zero-data-retention（零数据保留）模式需要客户端回传推理项时支持加密推理项延续。适配器应记录状态来自供应商存储，还是来自客户端携带的加密内容。

For AI SDK routes that expose visible reasoning text or reasoning deltas, Quilin may use middleware only as an adapter layer. The runtime must distinguish visible model-emitted reasoning text from opaque provider reasoning state, because they have different safety, privacy, and replay rules.
>
> 对暴露可见推理文本或推理增量的 AI SDK 路由，Quilin 可以只把 middleware（模型中间件）作为适配层使用。运行时必须区分模型输出的可见推理文本与不透明供应商推理状态，因为两者的安全、隐私和复用规则不同。

For Ollama thinking models, the adapter should treat `think` and message-level `thinking` as local-model metadata. It may replay this state only within the same local session, same model tag, same data-policy scope, and same user-approved route profile.
>
> 对 Ollama thinking models（会输出思考字段的本地模型），适配器应把 `think` 和 message-level `thinking` 视为本地模型元数据。它只能在同一本地 session（会话）、同一模型 tag、同一数据策略范围和同一用户批准路由档案内复用该状态。

The trigger to enable reasoning carry-over is a multi-step agent route where tool outputs or function-call results return to the same reasoning model. Single-turn commodity calls should keep reasoning state disabled to reduce privacy risk, storage cost, and cross-route coupling.
>
> 启用推理状态延续的触发条件是多步 agent route（智能体路由），其中工具输出或函数调用结果会返回同一个推理模型。单轮通用调用应保持推理状态关闭，以降低隐私风险、存储成本和跨路由耦合。

Acceptance requires a `ReasoningStateRecord` with provider, model, route ID, state kind, storage mode, redaction policy, expiry, token impact, and replay result. A failed replay must degrade to a fresh reasoning call with an explicit trace event, not silently mix old and new state.
>
> 验收要求包括一条 `ReasoningStateRecord`，记录供应商、模型、路由 ID、状态类型、存储模式、脱敏策略、过期时间、token 影响和复用结果。复用失败必须降级成一次全新的推理调用，并写明 trace 事件，不得静默混合旧状态和新状态。

## Ollama 生产适配器 / Ollama Production Adapter

Ollama should be treated as a local provider path, not as a toy development shortcut. It needs the same route decision, attempt ledger, stream accounting, structured error taxonomy, and capability matrix as remote providers, with local capacity replacing USD cost as the primary scarce resource.
>
> Ollama 应被视为本地供应商路径，而不是开发期玩具捷径。它需要与远程供应商相同的路由决策、尝试账本、流式计量、结构化错误分类和能力矩阵，只是用本地容量替代 USD 成本作为主要稀缺资源。

The adapter should use `POST /api/chat` as the main chat path, support streaming and non-streaming modes, map `tools` into Quilin tool-call records, map structured `format` into structured-output validation, and pass `keep_alive` through a route policy rather than hard-coding it.
>
> 适配器应以 `POST /api/chat` 作为主聊天路径，支持流式和非流式模式，把 `tools` 映射为 Quilin 工具调用记录，把结构化 `format` 映射为结构化输出校验，并通过路由策略传递 `keep_alive`，而不是硬编码。

The production adapter should add local preflight checks: daemon reachable, model tag exists, model family supports required tools or structured output, context size is sufficient, memory pressure is acceptable, and concurrency quota is available. Missing model tags should produce a blocked provider record unless the user explicitly approves a pull.
>
> 生产适配器应增加本地预检查：daemon（后台服务）可达、模型 tag 存在、模型族支持所需工具或结构化输出、上下文长度足够、内存压力可接受、并发额度可用。缺失模型 tag 应产生 blocked provider record（阻塞供应商记录），除非用户明确批准拉取模型。

The adapter may use the official `ollama` JavaScript client or direct HTTP calls, but either path must sit behind Quilin's own wrapper. The wrapper must keep raw Ollama statistics, stream events, local errors, model load time, prompt evaluation count, generation count, and total duration, because these fields are the local equivalent of remote usage and latency evidence.
>
> 适配器可以使用官方 `ollama` JavaScript 客户端或直连 HTTP 调用，但两条路径都必须放在 Quilin 自有 wrapper（包装层）后。该 wrapper 必须保留 Ollama 原始统计、流事件、本地错误、模型加载时间、prompt evaluation count（提示评估数量）、generation count（生成数量）和总耗时，因为这些字段是本地路径对应远程用量与延迟证据的等价物。

The trigger to promote Ollama into production routes is not "Ollama works locally". Promotion requires local capability fixtures for text, streaming, tools, structured output, reasoning state if used, stuck-stream timeout, model unload behavior, and concurrency pressure.
>
> 把 Ollama 提升到生产路由的触发条件不是“Ollama 本地能跑”。提升需要本地能力 fixture，覆盖文本、流式、工具、结构化输出、使用时的推理状态、卡住流超时、模型卸载行为和并发压力。

Acceptance requires a repeatable local matrix run, no implicit model pulls, deterministic timeout behavior, no global mutation of `keep_alive`, and trace records that let a reviewer distinguish local model failure from Quilin routing failure.
>
> 验收要求包括：可重复的本地矩阵运行、不隐式拉取模型、确定性的超时行为、不全局修改 `keep_alive`，以及能让 reviewer（审核者）区分本地模型失败与 Quilin 路由失败的追踪记录。

## 流式 Token 计量 / Streaming Token Accounting

Streaming token accounting（流式 token 计量，即在模型边输出边处理时估算、对账和记录 token 用量）must separate estimated usage from final provider usage. During the stream, Quilin may estimate input, visible output, reasoning output, and tool-call JSON size. After the stream finishes, the run record must reconcile provider-reported usage when available.
>
> Streaming token accounting（流式 token 计量，即在模型边输出边处理时估算、对账和记录 token 用量）必须区分估算用量和供应商最终用量。流式过程中，Quilin 可以估算输入、可见输出、推理输出和工具调用 JSON 大小。流结束后，运行记录必须在可用时对账供应商报告的用量。

The runtime should create a `StreamAccountingSession` before the provider call. It should track route ID, provider path, model ID, input token estimate, maximum output tokens, reasoning budget, first byte time, first semantic event time, last chunk time, chunk timeout, finish reason, provisional output tokens, and final usage.
>
> 运行时应在供应商调用前创建 `StreamAccountingSession`。它应跟踪路由 ID、供应商路径、模型 ID、输入 token 估算、最大输出 token、推理预算、首字节时间、首个语义事件时间、最后片段时间、片段超时、结束原因、临时输出 token 和最终用量。

AI SDK `streamText` should be consumed through events or parts that preserve warnings, response metadata, model ID, finish reason, provider metadata, and usage fields. The stream should always be drained or explicitly aborted so final usage and errors are not lost.
>
> AI SDK `streamText` 应通过保留 warning、响应元数据、模型 ID、结束原因、供应商元数据和用量字段的事件或片段来消费。流必须总是被完整消费或明确中止，避免丢失最终用量和错误。

OpenAI streaming should preserve semantic event names when using the Responses API. Reasoning tokens can be billed before visible output appears, so a stream that times out before visible text may still have cost and must be recorded as `incomplete_with_possible_billing`.
>
> 使用 OpenAI Responses API 做流式调用时，应保留语义事件名称。推理 token 可能在可见输出出现前就已经计费，因此一个在可见文本前超时的流仍可能有成本，必须记录为 `incomplete_with_possible_billing`。

Ollama streaming should treat each JSON object as a stream part and map the final object statistics into prompt tokens, generated tokens, total duration, load duration, and local throughput. If the final object is missing, the run must stay provisional and cannot be used as production cost or latency evidence.
>
> Ollama 流式输出应把每个 JSON 对象视为一个 stream part（流片段），并把最终对象统计映射为提示 token、生成 token、总耗时、加载耗时和本地吞吐量。如果最终对象缺失，该运行必须保持 provisional（临时估算）状态，不能作为生产成本或延迟证据。

The trigger for strict streaming accounting is any route that streams to the user, calls tools mid-stream, carries reasoning state, or has a spend cap. Non-streaming calls should still emit the same accounting record with stream fields set to null.
>
> 启用严格流式计量的触发条件包括：任何向用户流式输出、流中调用工具、携带推理状态或带成本上限的路由。非流式调用也应输出同一计量记录，只是把流式字段设为 null。

Acceptance requires estimate-before-call, provisional updates during the stream, final reconciliation, explicit incomplete states, chunk-timeout evidence, and a test that proves a cancelled or failed stream cannot be counted as a successful low-cost run.
>
> 验收要求包括：调用前估算、流中临时更新、结束后最终对账、明确的 incomplete（未完成）状态、片段超时证据，以及一个证明取消或失败流不能被记作成功低成本运行的测试。

## 运行时数据契约 / Runtime Data Contracts

`ProductionProviderProfile`（生产供应商档案）should be the durable matrix entry. It should be versioned and included by reference in every route decision, so reviewers can reconstruct which provider facts were believed at the time of the call.
>
> `ProductionProviderProfile`（生产供应商档案）应作为持久矩阵条目。它应带版本，并通过引用写入每个路由决策，让 reviewer 可以复原调用当时系统相信的供应商事实。

```ts
interface ProductionProviderProfile {
  readonly providerPath: string;
  readonly providerMode: "direct" | "gateway" | "local";
  readonly modelId: string;
  readonly capabilities: readonly string[];
  readonly usageMapping: string;
  readonly retryPolicyId: string;
  readonly fallbackGroupId?: string;
  readonly reasoningStateAdapter?: string;
  readonly lastLiveMatrixAt?: string;
  readonly promotionState: "blocked" | "candidate" | "canary" | "default";
}
```

`ProviderAttempt` should remain the common evidence unit across direct, gateway, and local providers. Gateway attempts can be imported from gateway metadata, but Quilin must normalize them into this same shape before logs, traces, or reviews consume them.
>
> `ProviderAttempt` 应继续作为直连、网关和本地供应商的共同证据单位。网关尝试可以从网关元数据导入，但 Quilin 必须在日志、追踪或 review 消费前把它们归一化成同一形态。

```ts
interface ProviderAttempt {
  readonly providerPath: string;
  readonly modelId: string;
  readonly attemptIndex: number;
  readonly startedAt: string;
  readonly firstSemanticEventAt?: string;
  readonly finishedAt?: string;
  readonly outcome: "success" | "retryable_error" | "blocked_error" | "aborted";
  readonly normalizedError?: string;
  readonly billedUsageKnown: boolean;
  readonly finalUsage?: Record<string, unknown>;
  readonly rawMetadataRef?: string;
}
```

`StreamAccountingSession` should connect budget preflight, stream progress, and final reconciliation. It is the record that prevents incomplete streams from being treated as cheap successes.
>
> `StreamAccountingSession` 应连接预算预检查、流式进度和最终对账。它是防止未完成流被误当成低成本成功运行的记录。

```ts
interface StreamAccountingSession {
  readonly routeId: string;
  readonly providerPath: string;
  readonly inputTokenEstimate: number;
  readonly maxOutputTokens: number;
  readonly reasoningTokenBudget?: number;
  readonly firstSemanticEventAt?: string;
  readonly lastChunkAt?: string;
  readonly provisionalOutputTokens: number;
  readonly finalUsage?: Record<string, unknown>;
  readonly accountingState: "estimated" | "streaming" | "reconciled" | "incomplete";
}
```

## 实现切片 / Implementation Slices

Slice 1 should add the production provider matrix loader and schema validation. It should fail closed when an enabled route references a missing provider profile or a provider profile with stale live evidence.
>
> 切片 1 应增加生产供应商矩阵加载器和 schema 校验。当启用路由引用缺失供应商档案或实机证据过期的供应商档案时，它应显式失败。

Slice 2 should move retry and fallback execution into Quilin-owned attempt loops, with AI SDK internal retries disabled unless attempt visibility is proven. Gateway fallback should be accepted only after gateway attempt metadata is normalized.
>
> 切片 2 应把 retry 与 fallback 执行移入 Quilin 自有尝试循环；除非能证明尝试可见，否则禁用 AI SDK 内部重试。网关后备只有在网关尝试元数据被归一化后才可接受。

Slice 3 should implement provider-specific reasoning state adapters, starting with OpenAI Responses API state and then local Ollama thinking metadata. Other providers should remain `reasoning_state_adapter: none` until their replay semantics are proven.
>
> 切片 3 应实现供应商专用推理状态适配器，先从 OpenAI Responses API 状态和本地 Ollama thinking metadata 开始。其他供应商在复用语义被证明前应保持 `reasoning_state_adapter: none`。

Slice 4 should add the Ollama production adapter with local preflight checks, raw stream preservation, final statistics mapping, explicit model-tag blocking, and concurrency controls.
>
> 切片 4 应增加 Ollama 生产适配器，包含本地预检查、原始流保留、最终统计映射、明确模型 tag 阻塞和并发控制。

Slice 5 should add streaming token accounting across remote and local providers. This slice should prove that successful, failed, aborted, and stalled streams all produce auditable records.
>
> 切片 5 应为远程和本地供应商增加流式 token 计量。该切片应证明成功、失败、中止和卡住的流都会产生可审计记录。

## 验收门槛 / Acceptance Gates

`QUI-14` should be considered runtime-complete only when production routes can prove provider eligibility, attempt ordering, fallback decisions, reasoning state decisions, local Ollama capacity decisions, and stream usage reconciliation from machine-readable records.
>
> 只有当生产路由能用机器可读记录证明供应商符合条件、尝试顺序、后备决策、推理状态决策、本地 Ollama 容量决策和流式用量对账时，`QUI-14` 才能视为 runtime-complete（运行时完成）。

The minimum acceptance set is: matrix schema tests, route eligibility tests, same-provider retry tests, cross-provider fallback tests, OpenAI reasoning carry-over tests, Ollama local adapter tests, stalled-stream tests, cancelled-stream tests, and final usage reconciliation tests.
>
> 最小验收集合是：矩阵 schema 测试、路由资格测试、同供应商重试测试、跨供应商后备测试、OpenAI 推理状态延续测试、Ollama 本地适配器测试、卡住流测试、取消流测试和最终用量对账测试。

The issue should not be marked Done after this document alone, because no TypeScript runtime code, provider matrix loader, Ollama adapter, reasoning state adapter, or stream accounting implementation has been verified in this task.
>
> 仅完成本文后不应把 issue 标记为 Done，因为本任务没有验证 TypeScript 运行时代码、供应商矩阵加载器、Ollama 适配器、推理状态适配器或流式计量实现。

## Linear 映射 / Linear Mapping

`QUI-14` owns this production backlog boundary: provider matrix runtime catalog, retry/fallback execution policy, reasoning replay/carry-over, Ollama production adapter, and streaming token accounting. It should remain open until implementation and verification land.
>
> `QUI-14` 承载本文的生产化 backlog 边界：供应商矩阵运行时目录、重试/失败后备执行策略、推理状态复用/延续、Ollama 生产适配器和流式 token 计量。它应在实现与验证落地前保持打开。

`QUI-48` remains the architecture decision source. `QUI-59` remains the first implementation plan for the provider control plane. `QUI-14` should start only after those foundations provide route decisions and attempt records that production features can extend.
>
> `QUI-48` 继续作为架构决策来源。`QUI-59` 继续作为供应商控制平面的第一阶段实现计划。`QUI-14` 应在这些基础提供可扩展的路由决策和尝试记录后启动。
