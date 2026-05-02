# LLM 接入前沿吸收决策 / LLM Frontier Assimilation Decision

> Evidence date: 2026-05-02 Asia/Shanghai. Scope: Linear `QUI-48`, with mappings to `QUI-59`, `QUI-74`, `QUI-52`, and `QUI-18`. This file is a component decision note, not a benchmark（基准测试，用来比较系统能力的标准化评测）execution plan; Benchmark work is frozen unless the user explicitly asks for it.
>
> 证据日期：Asia/Shanghai 2026-05-02。范围：Linear `QUI-48`，并映射到 `QUI-59`、`QUI-74`、`QUI-52` 和 `QUI-18`。本文是组件决策文档，不是 benchmark（基准测试，用来比较系统能力的标准化评测）执行计划；除非用户明确要求，Benchmark 工作保持冻结。

## 结论 / Conclusion

Quilin should keep Vercel AI SDK v6（Vercel 的 TypeScript 模型调用工具包第 6 版，用来统一多供应商模型调用）as the primary in-process LLM abstraction, but it should add a Quilin-owned `ProviderControlPlane`（供应商控制平面，用来决定模型、路由、预算和错误处理）above it. The control plane should select between direct provider packages and AI Gateway-style routing（网关式模型路由，即一个入口动态选择供应商/模型）, enforce per-run spend caps（单次运行成本上限）, normalize structured errors（结构化错误分类）, and record live provider evidence before any route becomes default.
>
> Quilin 应继续把 Vercel AI SDK v6 作为进程内 LLM（大语言模型）调用抽象，但需要在它上方增加 Quilin 自己的 `ProviderControlPlane`（供应商控制平面，用来决定模型、路由、预算和错误处理）。这个控制平面要在 direct provider packages（直接供应商包）和 AI Gateway-style routing（网关式模型路由，即一个入口动态选择供应商/模型）之间做选择，强制执行 per-run spend caps（单次运行成本上限），归一化 structured errors（结构化错误分类），并在任何 route（路由）成为默认前记录 provider live evidence（供应商实机证据）。

`docs/01-llm-integration/routing-cache-cost-evidence.md` already defines the 4-provider x 4-scenario evidence gate. This decision file turns that gate into component architecture: route profiles, cache policy, fallback policy, rate-limit policy, error taxonomy, and live-matrix acceptance.
>
> `docs/01-llm-integration/routing-cache-cost-evidence.md` 已经定义 4 个供应商 x 4 类场景的证据门槛。本文把该门槛转成组件架构：route profile（路由档案）、cache policy（缓存策略）、fallback policy（失败回退策略）、rate-limit policy（限流策略）、error taxonomy（错误分类）和 live-matrix acceptance（实机矩阵验收）。

The strongest current pattern is not "one universal gateway for everything" or "direct SDK calls only". It is a hybrid: use AI Gateway-style routing when provider interchangeability, observability, pricing discovery, `order`/`only`, `models`, and provider timeout metadata are useful; use direct provider packages when provider-native options, raw cache evidence, specialized reasoning controls, or data-control constraints matter.
>
> 当前最强方案不是“所有调用都走一个统一网关”，也不是“只走直接 SDK 调用”。更合理的是 hybrid（混合模式）：当需要供应商可替换性、可观测性、价格发现、`order`/`only`、`models` 和供应商超时元数据时使用 AI Gateway-style routing；当需要供应商原生选项、原始缓存证据、专门 reasoning（推理）控制或数据控制约束时走 direct provider packages。

## 一手来源 / Primary Sources

The Vercel AI Gateway provider exposes multi-provider access, model discovery, pricing metadata, usage observability, and provider-specific options through AI SDK. It supports models from OpenAI, Anthropic, Google, DeepSeek, and others, and exposes routing metadata through `providerMetadata.gateway.routing`. Sources: [AI SDK AI Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway), [Vercel AI Gateway provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering).
>
> Vercel AI Gateway provider（Vercel 网关供应商适配层）通过 AI SDK 暴露多供应商访问、模型发现、价格元数据、用量可观测性和供应商专用选项。它支持 OpenAI、Anthropic、Google、DeepSeek 等模型，并通过 `providerMetadata.gateway.routing` 暴露路由元数据。来源：[AI SDK AI Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway)、[Vercel AI Gateway provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)。

AI Gateway now has first-class model fallbacks（模型失败回退，即主模型失败后按顺序尝试备选模型）through `providerOptions.gateway.models`, provider ordering/filtering through `order` and `only`, and provider timeout metadata through `providerTimeouts`. Sources: [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks), [Vercel provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts), [Vercel provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering).
>
> AI Gateway 现在已经通过 `providerOptions.gateway.models` 支持一等的 model fallbacks（模型失败回退，即主模型失败后按顺序尝试备选模型），通过 `order` 和 `only` 支持供应商排序/过滤，并通过 `providerTimeouts` 暴露供应商超时元数据。来源：[Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)、[Vercel provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts)、[Vercel provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)。

AI SDK Core exposes the common operational hooks Quilin needs: `maxRetries`, `timeout` with total/step/chunk timing, `providerOptions`, `providerMetadata`, warnings for unsupported settings, `finishReason`, raw finish reasons, response metadata, and normalized usage fields including cache read/write tokens. Sources: [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text), [AI SDK settings](https://ai-sdk.dev/docs/ai-sdk-core/settings).
>
> AI SDK Core 暴露了 Quilin 需要的通用运行钩子：`maxRetries`、带 total/step/chunk（总耗时/单步/流式片段）控制的 `timeout`、`providerOptions`、`providerMetadata`、不支持设置的 warnings（警告）、`finishReason`、原始结束原因、响应元数据，以及包含缓存读写 token 的归一化 usage（用量）字段。来源：[AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)、[AI SDK settings](https://ai-sdk.dev/docs/ai-sdk-core/settings)。

The Vercel AI SDK v6（第 6 版）GitHub epic records the v6 release shape: Provider V3 test classes, stable `output` support for structured generation, warning logging, experimental context object, and provider-executed tool work. The open fallback request is still useful as a caution: application-owned fallback policy should log failed model/provider attempts and not depend on silent SDK behavior. Sources: [vercel/ai v6 epic #8662](https://github.com/vercel/ai/issues/8662), [vercel/ai fallback request #9950](https://github.com/vercel/ai/issues/9950).
>
> Vercel AI SDK v6（第 6 版）的 GitHub epic 记录了 v6 的发布形态：Provider V3 测试类、结构化生成的稳定 `output` 支持、warning logging（警告日志）、experimental context object（实验性上下文对象）和供应商执行工具相关工作。开放的 fallback request（失败回退需求）仍有警示价值：应用层应拥有自己的 fallback policy，记录失败模型/供应商尝试，而不是依赖静默 SDK 行为。来源：[vercel/ai v6 epic #8662](https://github.com/vercel/ai/issues/8662)、[vercel/ai fallback request #9950](https://github.com/vercel/ai/issues/9950)。

OpenAI prompt caching（提示缓存，即复用重复 prompt 前缀降低延迟和输入成本）is automatic for eligible prompts, reports `cached_tokens`, supports `prompt_cache_key`, and supports `prompt_cache_retention` with `in_memory` or `24h` on supported models. OpenAI rate limits are measured by requests and tokens, and response headers expose remaining and reset data. Sources: [OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching), [OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits), [OpenAI error codes](https://platform.openai.com/docs/guides/error-codes).
>
> OpenAI prompt caching（提示缓存，即复用重复 prompt 前缀降低延迟和输入成本）会在符合条件时自动启用，报告 `cached_tokens`，支持 `prompt_cache_key`，并在支持模型上支持 `in_memory` 或 `24h` 的 `prompt_cache_retention`。OpenAI 的 rate limits（限流）按请求和 token 衡量，响应头暴露剩余额度和重置时间。来源：[OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching)、[OpenAI rate limits](https://platform.openai.com/docs/guides/rate-limits)、[OpenAI error codes](https://platform.openai.com/docs/guides/error-codes)。

Anthropic prompt caching supports explicit cache breakpoints through `cache_control` / AI SDK `cacheControl`, reports cache creation/read tokens, and uses distinct cache-write/cache-read pricing. Anthropic rate limits include RPM（requests per minute，每分钟请求数）, ITPM（input tokens per minute，每分钟输入 token 数）, and OTPM（output tokens per minute，每分钟输出 token 数）with `retry-after` and rate-limit headers. Sources: [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Anthropic rate limits](https://docs.anthropic.com/en/api/rate-limits), [Anthropic errors](https://docs.anthropic.com/en/api/errors), [AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic).
>
> Anthropic prompt caching 支持通过 `cache_control` / AI SDK `cacheControl` 设置显式缓存断点，会报告 cache creation/read tokens（缓存写入/读取 token），并使用不同的缓存写入/读取价格。Anthropic rate limits 包括 RPM（requests per minute，每分钟请求数）、ITPM（input tokens per minute，每分钟输入 token 数）和 OTPM（output tokens per minute，每分钟输出 token 数），并通过 `retry-after` 和限流响应头暴露状态。来源：[Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)、[Anthropic rate limits](https://docs.anthropic.com/en/api/rate-limits)、[Anthropic errors](https://docs.anthropic.com/en/api/errors)、[AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)。

Google/Gemini supports implicit caching on Gemini 2.5 models and explicit cached content objects with TTL（Time To Live，缓存存活时间）and `usage_metadata`. Gemini rate limits are model-specific, and common backend errors include `RESOURCE_EXHAUSTED` for rate-limit exhaustion. Sources: [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching), [Gemini pricing](https://ai.google.dev/pricing), [Gemini rate limits](https://ai.google.dev/gemini-api/docs/quota), [Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting), [AI SDK Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai).
>
> Google/Gemini 支持 Gemini 2.5 模型上的 implicit caching（隐式缓存）和带 TTL（Time To Live，缓存存活时间）及 `usage_metadata` 的 explicit cached content objects（显式缓存内容对象）。Gemini rate limits 按模型区分，常见后端错误包括表示限流耗尽的 `RESOURCE_EXHAUSTED`。来源：[Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)、[Gemini pricing](https://ai.google.dev/pricing)、[Gemini rate limits](https://ai.google.dev/gemini-api/docs/quota)、[Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)、[AI SDK Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)。

DeepSeek exposes an official AI SDK provider, reasoning mode controls, disk-backed context caching, and cache hit/miss token evidence. Its official rate-limit page says DeepSeek does not set a fixed user concurrency limit, but its error page still documents 429 and 503 paths; therefore Quilin must treat DeepSeek as "best-effort high-throughput" rather than "no throttling needed". Sources: [AI SDK DeepSeek provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek), [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/), [DeepSeek rate limit](https://api-docs.deepseek.com/quick_start/rate_limit/), [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing).
>
> DeepSeek 暴露官方 AI SDK provider、reasoning mode（推理模式）控制、基于磁盘的 context caching（上下文缓存）和缓存命中/未命中 token 证据。它的官方 rate-limit 页面称 DeepSeek 不设置固定用户并发限制，但错误页仍记录 429 和 503 路径；因此 Quilin 应把 DeepSeek 当成“尽力而为的高吞吐供应商”，而不是“不需要限流”。来源：[AI SDK DeepSeek provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)、[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)、[DeepSeek rate limit](https://api-docs.deepseek.com/quick_start/rate_limit/)、[DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes)、[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)。

## 架构吸收项 / Architecture Absorption Items

### 1. ProviderControlPlane（供应商控制平面）

Introduce a `ProviderControlPlane`（供应商控制平面）that owns the decision before every model call: route profile, provider path, effective model, gateway/direct mode, cache strategy, retry policy, fallback sequence, timeout policy, spend cap, and expected telemetry. The lower `LLMClient` should execute the decision and report facts; it should not silently invent a new provider or fallback.
>
> 引入 `ProviderControlPlane`（供应商控制平面），负责每次模型调用前的决策：route profile（路由档案）、provider path（供应商路径）、effective model（实际模型）、gateway/direct mode（网关/直接模式）、cache strategy（缓存策略）、retry policy（重试策略）、fallback sequence（回退序列）、timeout policy（超时策略）、spend cap（成本上限）和预期遥测。底层 `LLMClient` 只执行决策并报告事实；不得静默发明新的供应商或回退。

The control plane should output a typed `LLMRouteDecision`（模型路由决策记录）with at least `route_id`, `intent_class`, `provider_mode`, `primary_model`, `fallback_models`, `allowed_providers`, `preferred_provider_order`, `cache_policy`, `budget_policy`, `retry_policy`, `timeout_policy`, and `live_matrix_required`.
>
> 控制平面应输出类型化的 `LLMRouteDecision`（模型路由决策记录），至少包含 `route_id`、`intent_class`、`provider_mode`、`primary_model`、`fallback_models`、`allowed_providers`、`preferred_provider_order`、`cache_policy`、`budget_policy`、`retry_policy`、`timeout_policy` 和 `live_matrix_required`。

### 2. 路由分层 / Routing Layers

Use three routing layers. Layer 1 is capability routing（能力路由）: whether the task needs tool calling, structured output, reasoning, multimodal input, long context, or strict cache evidence. Layer 2 is policy routing（策略路由）: cost ceiling, data policy, latency class, trust level, and region/provider allowlist. Layer 3 is provider execution routing（供应商执行路由）: direct package or AI Gateway-style provider order/fallback.
>
> 使用三层路由。第一层是 capability routing（能力路由）：任务是否需要工具调用、结构化输出、reasoning（推理）、多模态输入、长上下文或严格缓存证据。第二层是 policy routing（策略路由）：成本上限、数据策略、延迟等级、信任级别和地域/供应商 allowlist（允许列表）。第三层是 provider execution routing（供应商执行路由）：直接供应商包或 AI Gateway-style 的供应商排序/失败回退。

Gateway mode should be used for interchangeable commodity calls, canary routing, and outage handling. Direct provider mode should be used when a call depends on provider-native semantics such as OpenAI `promptCacheKey`, Anthropic `cacheControl`, Google `cachedContent`, DeepSeek cache metadata, or raw provider-specific reasoning behavior.
>
> Gateway mode（网关模式）适合可替换的通用调用、canary routing（金丝雀路由，小流量验证新路径）和故障处理。Direct provider mode（直接供应商模式）适合依赖供应商原生语义的调用，例如 OpenAI `promptCacheKey`、Anthropic `cacheControl`、Google `cachedContent`、DeepSeek 缓存元数据，或供应商专用的原始 reasoning（推理）行为。

### 3. PromptCachePolicy（提示缓存策略）

Prompts should be assembled as `static_prefix + semi_static_context + dynamic_suffix`. The stable prefix should include system instructions, tool schemas, glossary, and durable project facts. Volatile items such as timestamps, retrieved snippets, user request deltas, and current filesystem evidence should stay in the dynamic suffix.
>
> Prompt（提示）应按 `static_prefix + semi_static_context + dynamic_suffix` 组装。稳定前缀包含系统指令、工具 schema（工具参数结构）、术语表和持久项目事实。时间戳、检索片段、用户请求增量和当前文件系统证据等易变项应留在动态后缀。

Provider-specific cache policy should be explicit. OpenAI uses `promptCacheKey` and `promptCacheRetention` only for high-volume stable prefixes. Anthropic applies up to a small, deterministic set of `cacheControl` breakpoints. Google creates explicit cached content only for large reusable corpora with known TTL. DeepSeek relies on byte-stable prefix construction and records `promptCacheHitTokens` / `promptCacheMissTokens`.
>
> 供应商专用缓存策略必须显式。OpenAI 只在高流量稳定前缀上使用 `promptCacheKey` 和 `promptCacheRetention`。Anthropic 使用少量、确定性的 `cacheControl` 断点。Google 只为大型可复用语料创建带明确 TTL 的显式缓存内容。DeepSeek 依赖字节稳定前缀构造，并记录 `promptCacheHitTokens` / `promptCacheMissTokens`。

### 4. BudgetGuard（预算保护器）

Add a local `BudgetGuard`（预算保护器）before calling the provider. It estimates worst-case cost from input tokens, configured `maxOutputTokens`, reasoning budget, cache-write cost, cache-read expectations, and provider price snapshot. If the estimate exceeds `per_run_spend_cap_usd`, the route must downshift, ask for approval, or fail with `budget_exceeded` before spending tokens.
>
> 在调用供应商前增加本地 `BudgetGuard`（预算保护器）。它用输入 token、配置的 `maxOutputTokens`、reasoning budget（推理预算）、缓存写入成本、预期缓存读取和供应商价格快照估算最坏成本。如果估算超过 `per_run_spend_cap_usd`，路由必须降级、请求确认或在花费 token 前以 `budget_exceeded` 失败。

The final cost record must use actual usage, not only the estimate. It should preserve raw provider usage, normalized usage, pricing source URL, access date, model ID, route ID, cache read/write tokens, and total USD cost. This extends `QUI-74` from a verification matrix into production cost accounting.
>
> 最终成本记录必须使用实际 usage（用量），不能只用估算。它应保留供应商原始 usage、归一化 usage、价格来源 URL、访问日期、模型 ID、路由 ID、缓存读写 token 和总美元成本。这把 `QUI-74` 从验证矩阵扩展成生产成本核算。

### 5. FallbackPolicy（失败回退策略）

Fallback should be explicit, bounded, and logged. Retry the same provider only for retryable transport/server/rate-limit errors. Switch provider/model only when the fallback candidate satisfies the same capability contract, budget policy, data policy, and safety policy. Never fallback silently on structured-output or tool-call failures unless the failed schema/tool evidence is stored.
>
> Fallback（失败回退）必须显式、有边界、可记录。只有遇到可重试的传输、服务器或限流错误时，才重试同一供应商。只有备选供应商/模型满足相同能力契约、预算策略、数据策略和安全策略时，才切换供应商/模型。结构化输出或工具调用失败时不得静默 fallback，除非保存了失败 schema（结构约束）或工具证据。

In gateway mode, use `providerOptions.gateway.models`, `order`, `only`, and `providerTimeouts`, then read `providerMetadata.gateway.routing.attempts`. In direct mode, implement the same attempt ledger locally: each attempt records provider, model, error class, HTTP status, retryability, timeout, rate-limit headers, and whether any tokens were billed.
>
> 在 gateway mode（网关模式）中，使用 `providerOptions.gateway.models`、`order`、`only` 和 `providerTimeouts`，然后读取 `providerMetadata.gateway.routing.attempts`。在 direct mode（直接模式）中，本地实现同等 attempt ledger（尝试记录账本）：每次尝试记录供应商、模型、错误类别、HTTP 状态、可重试性、超时、限流响应头和是否产生 token 计费。

### 6. RateLimitPolicy（限流策略）

Rate-limit handling must combine provider headers and local admission control. OpenAI exposes request/token remaining and reset headers. Anthropic exposes request/input/output token limits and `retry-after`. Gemini exposes model-tier quota and backend `RESOURCE_EXHAUSTED`. DeepSeek claims no fixed user rate limit, but can return slow keep-alive streams, 429, and 503; Quilin should still apply concurrency caps and stuck-stream timeouts.
>
> Rate-limit handling（限流处理）必须结合供应商响应头和本地准入控制。OpenAI 暴露请求/token 的剩余和重置响应头。Anthropic 暴露请求、输入 token、输出 token 限制和 `retry-after`。Gemini 暴露模型层级 quota（配额）和后端 `RESOURCE_EXHAUSTED`。DeepSeek 声称没有固定用户限流，但可能返回缓慢 keep-alive（保活）流、429 和 503；Quilin 仍应应用并发上限和卡住流超时。

The first implementation should use a conservative local token bucket（令牌桶，一种平滑限流算法）per provider path. The bucket should count estimated input tokens before the request and reconcile actual usage after completion. Failed attempts should still update request-rate pressure and backoff state.
>
> 第一版实现应对每条 provider path（供应商路径）使用保守的本地 token bucket（令牌桶，一种平滑限流算法）。令牌桶在请求前计入估算输入 token，并在完成后用实际 usage 对账。失败尝试也应更新请求速率压力和 backoff（退避）状态。

### 7. Structured Error Taxonomy（结构化错误分类）

Normalize provider and AI SDK errors into a small Quilin taxonomy: `auth_error`, `permission_error`, `invalid_request`, `unsupported_capability`, `rate_limited`, `quota_or_spend_exhausted`, `provider_overloaded`, `provider_timeout`, `network_error`, `stream_protocol_error`, `tool_schema_error`, `structured_output_error`, `safety_blocked`, `budget_exceeded`, and `unknown_provider_error`.
>
> 将供应商和 AI SDK 错误归一化为一组小型 Quilin 分类：`auth_error`、`permission_error`、`invalid_request`、`unsupported_capability`、`rate_limited`、`quota_or_spend_exhausted`、`provider_overloaded`、`provider_timeout`、`network_error`、`stream_protocol_error`、`tool_schema_error`、`structured_output_error`、`safety_blocked`、`budget_exceeded` 和 `unknown_provider_error`。

Each normalized error should carry `retryable`, `fallback_allowed`, `requires_user_action`, `provider`, `model`, `http_status`, `raw_code`, `request_id`, `rate_limit_reset_at`, and `billed_usage_if_known`. This is the minimum needed for routing, observability, cost control, and user-facing explanations.
>
> 每个归一化错误都应携带 `retryable`、`fallback_allowed`、`requires_user_action`、`provider`、`model`、`http_status`、`raw_code`、`request_id`、`rate_limit_reset_at` 和 `billed_usage_if_known`。这是路由、可观测性、成本控制和面向用户解释所需的最低字段。

## 供应商差异决策表 / Provider Difference Decision Table

| Provider / 供应商 | Best use / 最适用场景 | Cache decision / 缓存决策 | Routing decision / 路由决策 | Risk / 风险 |
|---|---|---|---|---|
| OpenAI | General coding, structured output, fast mainstream model path. / 通用编码、结构化输出、主流快速模型路径。 | Use automatic prompt caching; set `promptCacheKey` only for stable route-local prefixes. / 使用自动提示缓存；只对稳定路由局部前缀设置 `promptCacheKey`。 | Direct for cache/key control; gateway for canary or failover. / 需要缓存/key 控制时直连；需要金丝雀或故障回退时走网关。 | Rate/spend headers must be preserved; cached prompts still count toward rate limits. / 必须保留限流/花费响应头；缓存 prompt 仍计入限流。 |
| Anthropic | Long planning, tool streaming, high-quality reasoning, explicit cache breakpoints. / 长规划、工具流、强推理、显式缓存断点。 | Use `cacheControl` breakpoints; track creation/read tokens and write/read multipliers. / 使用 `cacheControl` 断点；跟踪写入/读取 token 和倍率。 | Direct when thinking/cache semantics matter; gateway when Bedrock/Vertex failover is useful. / thinking/cache 语义重要时直连；需要 Bedrock/Vertex 回退时走网关。 | ITPM/OTPM limits and `retry-after` must drive admission control. / ITPM/OTPM 限制和 `retry-after` 必须驱动准入控制。 |
| Google/Gemini | Long context, multimodal file input, explicit cached corpora, low-cost flash path. / 长上下文、多模态文件输入、显式缓存语料、低成本 flash 路径。 | Use implicit cache for repeated prefixes; explicit `cachedContent` for reusable corpora with TTL. / 重复前缀用隐式缓存；可复用语料用带 TTL 的显式 `cachedContent`。 | Direct for cachedContent and file flows; gateway for provider-order experiments. / cachedContent 和文件流直连；供应商排序实验走网关。 | Quota and backend `RESOURCE_EXHAUSTED` must be separated from schema/model errors. / quota 和后端 `RESOURCE_EXHAUSTED` 必须与 schema/模型错误分离。 |
| DeepSeek | Cost-sensitive long-context work, reasoning route backup, OpenAI-compatible path. / 成本敏感长上下文、推理备选路由、OpenAI 兼容路径。 | Rely on disk cache evidence: hit/miss tokens and stable prefixes. / 依赖磁盘缓存证据：命中/未命中 token 和稳定前缀。 | Direct for raw cache evidence; gateway only if metadata parity is proven. / 需要原始缓存证据时直连；只有元数据等价验证后才走网关。 | No fixed rate limit claim does not remove need for local concurrency and stuck-stream control. / “无固定限流”不等于无需本地并发和卡住流控制。 |

## 实机矩阵验收 / Provider Live Matrix Acceptance

`QUI-74` defines the measurement gate. `QUI-48` should require that every route profile has either a current provider live matrix（供应商实机矩阵，即真实 API 调用记录集合）or an explicit `blocked` status with the missing key, missing model access, or provider outage recorded.
>
> `QUI-74` 定义测量门槛。`QUI-48` 应要求每个 route profile（路由档案）要么有当前 provider live matrix（供应商实机矩阵，即真实 API 调用记录集合），要么有明确的 `blocked` 状态，并记录缺失 key、缺失模型权限或供应商故障。

The live matrix must include four lanes: short route, long-prefix cache, tool/schema, and quality reasoning. The matrix should not only verify output quality; it must also verify route decision, effective model, first-event latency, cache evidence, normalized usage, cost, structured error handling, and fallback attempts.
>
> 实机矩阵必须包含四条 lane（测试通道）：短路由、长前缀缓存、工具/schema 和质量推理。矩阵不能只验证输出质量；还必须验证路由决策、实际模型、首事件延迟、缓存证据、归一化 usage、成本、结构化错误处理和 fallback attempts（回退尝试）。

## Linear 映射 / Linear Mapping

| Issue / 事项 | Absorption decision / 吸收决策 |
|---|---|
| `QUI-48` | Owns this decision: `ProviderControlPlane`, route profiles, gateway/direct split, fallback, budget, rate limit, and error taxonomy. / 承载本文决策：`ProviderControlPlane`、路由档案、网关/直连切分、失败回退、预算、限流和错误分类。 |
| `QUI-59` | Implement provider matrix and fallback behavior using the route decision record and attempt ledger defined here. / 按本文的路由决策记录和尝试账本实现供应商矩阵与失败回退行为。 |
| `QUI-74` | Remains the measurable evidence gate for routing, cache, cost, time-to-first-token, and quality. / 继续作为路由、缓存、成本、首 token 延迟和质量的可测证据门槛。 |
| `QUI-52` | Tools integration must consume `unsupported_capability`, `tool_schema_error`, and fallback attempt data instead of guessing provider behavior. / 工具集成必须消费 `unsupported_capability`、`tool_schema_error` 和回退尝试数据，而不是猜测供应商行为。 |
| `QUI-18` | Safety/permission logic must receive provider path, spend cap state, fallback status, and structured error categories for user-visible approval decisions. / 安全/权限逻辑必须接收供应商路径、成本上限状态、回退状态和结构化错误分类，用于面向用户的确认决策。 |

## Must / Should / Could

Must: add a typed route decision record, a local budget guard, a structured error taxonomy, and an attempt ledger before enabling automatic provider/model fallback. These are required because gateway fallback and SDK retries can otherwise hide behavioral changes from the agent loop.
>
> Must（必须）：在启用自动供应商/模型 fallback 前，加入类型化路由决策记录、本地预算保护器、结构化错误分类和尝试账本。这些是必需项，因为网关回退和 SDK 重试否则可能向 agent loop（智能体循环）隐藏行为变化。

Must: preserve provider-native cache evidence and raw metadata even when using normalized AI SDK usage. Cache savings are only valid when the provider response proves cache read/write or hit/miss tokens.
>
> Must（必须）：即使使用 AI SDK 归一化 usage，也要保留供应商原生缓存证据和原始元数据。只有供应商响应证明缓存读取/写入或命中/未命中 token 时，缓存节省才有效。

Should: use gateway mode for operational resilience, provider ordering, and model fallback when direct provider features are not needed. Gateway metadata should be treated as first-class trace evidence, not a convenience detail.
>
> Should（应该）：当不需要直接供应商特性时，用 gateway mode 做运行韧性、供应商排序和模型失败回退。Gateway metadata（网关元数据）应被视为一等 trace evidence（追踪证据），不是便利细节。

Should: use direct mode for Anthropic cache breakpoints, Google explicit cached content, DeepSeek cache hit/miss evidence, and OpenAI prompt-cache key/retention experiments until gateway metadata parity is proven.
>
> Should（应该）：在网关元数据等价性被证明前，对 Anthropic 缓存断点、Google 显式缓存内容、DeepSeek 缓存命中/未命中证据和 OpenAI prompt-cache key/retention 实验使用 direct mode。

Could: add OpenRouter or LiteLLM-style external gateways later as additional provider paths, but only after the same route decision, budget guard, error taxonomy, and live matrix requirements apply. They are not needed to complete `QUI-48`.
>
> Could（可以）：之后可以把 OpenRouter 或 LiteLLM-style external gateways（外部模型网关）作为额外供应商路径加入，但必须先满足同样的路由决策、预算保护、错误分类和实机矩阵要求。它们不是完成 `QUI-48` 的必要条件。

## 下一步 / Next Steps

For `QUI-59`, implement the route decision and attempt ledger in TypeScript around the existing `LLMClient`. The first implementation should support direct OpenAI, Anthropic, Google, DeepSeek, plus gateway mode where `providerOptions.gateway.models`, `order`, `only`, and `providerTimeouts` are configured from the route profile.
>
> 对 `QUI-59`，在现有 `LLMClient` 外围用 TypeScript 实现路由决策和尝试账本。第一版应支持 direct OpenAI、Anthropic、Google、DeepSeek，以及从 route profile 配置 `providerOptions.gateway.models`、`order`、`only` 和 `providerTimeouts` 的 gateway mode。

For `QUI-74`, keep the 40-call live matrix, but extend each JSON record with `route_decision`, `attempts`, `normalized_error`, `budget_estimate_usd`, `budget_actual_usd`, and `fallback_allowed`. This turns evidence into a reusable regression fixture rather than a one-off benchmark artifact.
>
> 对 `QUI-74`，保留 40 次调用的实机矩阵，但给每条 JSON 记录增加 `route_decision`、`attempts`、`normalized_error`、`budget_estimate_usd`、`budget_actual_usd` 和 `fallback_allowed`。这样证据会变成可复用回归样例，而不是一次性的 benchmark 产物。

For `QUI-52` and `QUI-18`, consume the new error and route metadata at the tool/safety boundary. Unsupported capabilities, tool schema failures, budget exhaustion, and provider fallback should be visible to the agent supervisor before any tool execution or user approval prompt is generated.
>
> 对 `QUI-52` 和 `QUI-18`，在工具/安全边界消费新的错误和路由元数据。Unsupported capabilities（不支持能力）、tool schema failures（工具结构失败）、budget exhaustion（预算耗尽）和 provider fallback（供应商回退）应在任何工具执行或用户确认提示生成前对 agent supervisor（智能体监督器）可见。
