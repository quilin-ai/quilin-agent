# 路由、缓存、成本证据基线 / Routing, Cache, and Cost Evidence Baseline

> Scope: Linear QUI-74. This evidence file defines measurable baselines for model routing（模型路由，the decision that maps a task to a provider and model）, prompt cache（提示缓存，provider-side reuse of repeated prompt prefixes or explicit cached content）, TTFT（Time To First Token，首 token 延迟，从请求发出到第一个 streamed text/reasoning/tool event 的延迟）, token cost（token 成本，按输入、缓存命中/写入、输出 token 和 provider price 计算的费用）, and output quality（输出质量，用固定评测样例和 rubric 判定的可用性）.
>
> 范围：Linear QUI-74。本文定义 model routing（模型路由，即把任务映射到供应商和模型的决策）、prompt cache（提示缓存，即供应商侧复用重复 prompt 前缀或显式缓存内容）、TTFT（Time To First Token，首 token 延迟，即从请求发出到第一个流式 text/reasoning/tool event 的延迟）、token cost（token 成本，即按输入、缓存命中/写入、输出 token 和供应商价格计算的费用）和 output quality（输出质量，即用固定评测样例和 rubric 判断可用性）的可测基线。

> Evidence date: 2026-05-02 Asia/Shanghai. Provider prices and cache behavior are time-sensitive; every live run must store the exact pricing source URL, access date, model ID, and provider response usage fields used for cost calculation.
>
> 证据日期：Asia/Shanghai 2026-05-02。供应商价格和缓存行为具有时效性；每次 live run（真实接口运行）都必须保存用于成本计算的价格来源 URL、访问日期、模型 ID 和供应商返回的 usage（用量）字段。

## 结论摘要 / Summary

The minimum acceptable baseline is a 4 provider paths（供应商路径，Quilin through AI SDK/provider code to one upstream API）x 4 scenario matrix: OpenAI, Anthropic, Google/Gemini, and DeepSeek, each covering short routing, long-prefix cache, tool/schema behavior, and quality reasoning. A provider path passes only when route selection, TTFT measurement, cache evidence, cost normalization, and output quality are all recorded.

最低可接受基线是一个 4 个 provider paths（供应商路径，即 Quilin 通过 AI SDK/provider 代码到上游 API 的路径）x 4 个场景的矩阵：OpenAI、Anthropic、Google/Gemini 和 DeepSeek，每条路径都覆盖短任务路由、长前缀缓存、工具/schema 行为和质量推理。只有 route selection（路由选择）、TTFT 测量、缓存证据、成本归一化和输出质量都被记录时，该供应商路径才算通过。

Use provider-native cache evidence before wall-clock inference: OpenAI exposes cached tokens in `usage.prompt_tokens_details.cached_tokens`; Anthropic exposes cache creation/read input tokens; Google/Gemini exposes cached content token counts in usage metadata and supports explicit `cachedContent`; DeepSeek exposes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.

优先使用供应商原生缓存证据，而不是只看 wall-clock（墙钟时间）推断：OpenAI 在 `usage.prompt_tokens_details.cached_tokens` 暴露缓存 token；Anthropic 暴露 cache creation/read input tokens；Google/Gemini 在 usage metadata（用量元数据）中暴露 cached content token count 并支持显式 `cachedContent`；DeepSeek 暴露 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。

The baseline is intentionally not a production SLA（Service Level Agreement，服务等级协议）. It is a verification gate for QUI-59 and QUI-60: it proves that the instrumentation can observe route choice, first-token latency, cache hit/miss, cost, and task quality across the four required provider paths.

该基线刻意不定义 production SLA（Service Level Agreement，服务等级协议）。它是 QUI-59 和 QUI-60 的验证门槛：证明当前 instrumentation（观测埋点）能在四条必须覆盖的供应商路径上观测路由选择、首 token 延迟、缓存命中/未命中、成本和任务质量。

## 官方证据快照 / Official Evidence Snapshot

The table below records the official evidence used to set the measurement shape. Price numbers are examples from the cited pages on 2026-05-02; live evaluation must re-read current pricing before calculating pass/fail cost.

下表记录用于确定测量形态的官方证据。价格数字是 2026-05-02 从引用页面读取的示例；真实评测在计算成本通过/失败前必须重新读取当时最新价格。

| Provider path / 供应商路径 | Official cache evidence / 官方缓存证据 | Cost evidence / 成本证据 | SDK evidence / SDK 证据 |
|---|---|---|---|
| OpenAI via `@ai-sdk/openai` | OpenAI Prompt Caching is automatic for eligible prompts, reports `cached_tokens`, supports `prompt_cache_key`, and supports in-memory or 24h retention on supported models. Source: [OpenAI Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching). / OpenAI Prompt Caching（提示缓存）对符合条件的 prompt 自动启用，报告 `cached_tokens`，支持 `prompt_cache_key`，并在支持模型上支持 in-memory（内存）或 24h retention（24 小时保留）。来源：[OpenAI Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching)。 | OpenAI pricing reports input, cached input, and output prices per 1M tokens, for example flagship rows such as `gpt-5.5`, `gpt-5.4`, and mini/nano variants. Source: [OpenAI Pricing](https://platform.openai.com/docs/pricing). / OpenAI 价格页按每 100 万 token 报告 input（输入）、cached input（缓存输入）和 output（输出）价格，例如 `gpt-5.5`、`gpt-5.4` 及 mini/nano 行。来源：[OpenAI Pricing](https://platform.openai.com/docs/pricing)。 | AI SDK OpenAI provider exposes OpenAI models and provider options through `@ai-sdk/openai`. Source: [AI SDK OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai). / AI SDK OpenAI provider（供应商适配层）通过 `@ai-sdk/openai` 暴露 OpenAI 模型和 provider options（供应商选项）。来源：[AI SDK OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)。 |
| Anthropic via `@ai-sdk/anthropic` | Anthropic Prompt Caching supports automatic caching and explicit cache breakpoints with `cache_control`; usage reports cache read and creation tokens; cache entries are organization-isolated. Source: [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching). / Anthropic Prompt Caching 支持 automatic caching（自动缓存）和带 `cache_control` 的 explicit cache breakpoints（显式缓存断点）；usage 会报告 cache read（缓存读取）和 cache creation（缓存创建）token；缓存按组织隔离。来源：[Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)。 | Anthropic pricing states cache-write and cache-read multipliers: 5-minute write 1.25x base input, 1-hour write 2x base input, cache read 0.1x base input. Source: [Anthropic Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing). / Anthropic 价格页声明缓存写入和读取倍率：5 分钟写入为基础输入价 1.25x，1 小时写入为 2x，缓存读取为 0.1x。来源：[Anthropic Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing)。 | AI SDK Anthropic provider supports `@ai-sdk/anthropic`, tool streaming, provider options, effort, and thinking controls. Source: [AI SDK Anthropic Provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic). / AI SDK Anthropic provider 支持 `@ai-sdk/anthropic`、tool streaming（工具流式输出）、provider options、effort（推理力度）和 thinking（思考）控制。来源：[AI SDK Anthropic Provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)。 |
| Google/Gemini via `@ai-sdk/google` | Gemini API supports implicit caching on Gemini 2.5 models and explicit caching through cached content objects with TTL（Time To Live，存活时间）; cached tokens appear in `usage_metadata`. Source: [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching). / Gemini API 在 Gemini 2.5 模型上支持 implicit caching（隐式缓存），并通过带 TTL（Time To Live，存活时间）的 cached content objects（缓存内容对象）支持 explicit caching（显式缓存）；缓存 token 出现在 `usage_metadata`。来源：[Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)。 | Gemini pricing reports input, output including thinking tokens, context caching price, and cache storage per 1M tokens per hour. Source: [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing). / Gemini 价格页报告 input、包含 thinking tokens（思考 token）的 output、context caching（上下文缓存）价格，以及按每 100 万 token 每小时计费的缓存存储价格。来源：[Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing)。 | AI SDK Google provider supports `@ai-sdk/google`, `cachedContent`, `thinkingConfig`, and `providerMetadata.google.usageMetadata`. Source: [AI SDK Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai). / AI SDK Google provider 支持 `@ai-sdk/google`、`cachedContent`、`thinkingConfig` 和 `providerMetadata.google.usageMetadata`。来源：[AI SDK Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)。 |
| DeepSeek via `@ai-sdk/deepseek` or OpenAI-compatible provider | DeepSeek Context Caching on Disk is enabled by default; hits require matching persisted prefix units and usage reports `prompt_cache_hit_tokens` plus `prompt_cache_miss_tokens`. Source: [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache). / DeepSeek Context Caching on Disk（磁盘上下文缓存）默认启用；命中需要匹配已持久化的前缀单元，usage 报告 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。来源：[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)。 | DeepSeek pricing reports cache-hit input, cache-miss input, and output prices for `deepseek-v4-flash` and `deepseek-v4-pro`; old `deepseek-chat` and `deepseek-reasoner` names are compatibility aliases. Source: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing). / DeepSeek 价格页报告 `deepseek-v4-flash` 和 `deepseek-v4-pro` 的缓存命中输入、缓存未命中输入和输出价格；旧 `deepseek-chat` 与 `deepseek-reasoner` 名称是兼容别名。来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)。 | AI SDK DeepSeek provider supports `@ai-sdk/deepseek`, default base URL `https://api.deepseek.com`, streaming, and thinking mode via model or provider option. Source: [AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek). / AI SDK DeepSeek provider 支持 `@ai-sdk/deepseek`、默认 base URL `https://api.deepseek.com`、streaming（流式输出）和通过模型或 provider option 控制 thinking mode（思考模式）。来源：[AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)。 |

AI SDK Core usage fields are the normalization target: `inputTokens`, `inputTokenDetails.cacheReadTokens`, `inputTokenDetails.cacheWriteTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens`, `totalTokens`, raw provider usage, and provider metadata. Source: [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).

AI SDK Core 的 usage 字段是归一化目标：`inputTokens`、`inputTokenDetails.cacheReadTokens`、`inputTokenDetails.cacheWriteTokens`、`outputTokens`、`outputTokenDetails.reasoningTokens`、`totalTokens`、原始供应商 usage 和 provider metadata。来源：[AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)。

## 指标定义 / Metric Definitions

Model routing（模型路由） is measured as a structured decision record, not as a hidden branch. Each LLM invocation must record `route_key`, `provider_path`, `configured_model_id`, `effective_model_id`, `capability_required`, `capability_supported`, `reasoning_mode`, `cache_strategy`, and `fallback_used`.

Model routing（模型路由）必须以结构化决策记录衡量，而不是隐藏分支。每次 LLM 调用都必须记录 `route_key`、`provider_path`、`configured_model_id`、`effective_model_id`、`capability_required`、`capability_supported`、`reasoning_mode`、`cache_strategy` 和 `fallback_used`。

Prompt cache（提示缓存） is measured with native provider fields when available. Quilin should normalize OpenAI `cached_tokens`, Anthropic cache read/write tokens, Google `cachedContentTokenCount`, and DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` into `TokenUsage.cache.readTokens`, `TokenUsage.cache.writeTokens`, and raw metadata for audit.

Prompt cache（提示缓存）优先用供应商原生字段衡量。Quilin 应把 OpenAI `cached_tokens`、Anthropic cache read/write tokens、Google `cachedContentTokenCount` 和 DeepSeek `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` 归一化到 `TokenUsage.cache.readTokens`、`TokenUsage.cache.writeTokens`，同时保留 raw metadata（原始元数据）以便审计。

TTFT（Time To First Token，首 token 延迟） starts after local prompt assembly and immediately before the outbound provider request. It stops at the first streamed semantic event: text delta, reasoning delta, tool-call-start, or tool-call-args-delta. It must not use final response time as a substitute.

TTFT（Time To First Token，首 token 延迟）从本地 prompt assembly（提示组装）结束且即将发出供应商请求时开始计时。它在第一个流式语义事件到达时停止：text delta、reasoning delta、tool-call-start 或 tool-call-args-delta。不得用最终响应时间替代 TTFT。

Token cost（token 成本） is computed from the actual usage fields and a pricing snapshot. The cost record must separate non-cached input, cache read input, cache write input, output, reasoning output when separately exposed, and provider-specific cache storage where applicable.

Token cost（token 成本）用实际 usage 字段和价格快照计算。成本记录必须拆分 non-cached input（非缓存输入）、cache read input（缓存读取输入）、cache write input（缓存写入输入）、output（输出）、供应商单独暴露时的 reasoning output（推理输出）和适用时的供应商缓存存储费用。

Output quality（输出质量） is measured by deterministic checks first, then rubric scoring only when no deterministic oracle exists. Tool calls, JSON mode, and benchmark-style questions must use exact/schema/regex checks; open-ended summaries may use a 0-2 rubric with a stored reference answer.

Output quality（输出质量）优先用 deterministic checks（确定性检查）衡量，只有没有确定性 oracle（判定答案）时才用 rubric scoring（评分量表）。工具调用、JSON mode 和 benchmark-style questions（基准风格问题）必须使用精确、schema 或 regex 检查；开放式摘要可以用带参考答案的 0-2 分量表。

## 成本归一化 / Cost Normalization

All provider costs must be normalized to USD per request and USD per 1M tokens. Use the exact model and tier that the run used; do not apply a cheaper cached-input row unless the provider response proves cache usage.

所有供应商成本必须归一化为每请求 USD 和每 100 万 token USD。使用运行时实际模型和 tier（计费层级）；除非供应商响应证明发生缓存使用，否则不得套用更便宜的 cached-input 行。

```text
request_cost_usd =
  no_cache_input_tokens * input_price_per_token
+ cache_read_tokens * cache_read_price_per_token
+ cache_write_tokens * cache_write_price_per_token
+ output_tokens * output_price_per_token
+ cache_storage_tokens * cache_storage_price_per_token_hour * ttl_hours
```

```text
request_cost_usd（每请求美元成本） =
  no_cache_input_tokens（非缓存输入 token） * input_price_per_token（输入单 token 价格）
+ cache_read_tokens（缓存读取 token） * cache_read_price_per_token（缓存读取单 token 价格）
+ cache_write_tokens（缓存写入 token） * cache_write_price_per_token（缓存写入单 token 价格）
+ output_tokens（输出 token） * output_price_per_token（输出单 token 价格）
+ cache_storage_tokens（缓存存储 token） * cache_storage_price_per_token_hour（缓存存储单 token 每小时价格） * ttl_hours（缓存存活小时数）
```

For OpenAI, cache write has no separate explicit fee in the official prompt-caching guide; use normal input price for uncached input and cached-input price only for `cached_tokens`. For Anthropic, cache creation uses the official 5-minute or 1-hour write multiplier and cache reads use the read multiplier. For Google/Gemini explicit caching, include both cached-token price and storage TTL cost. For DeepSeek, split input into hit and miss tokens exactly as reported.

对于 OpenAI，官方 prompt-caching guide 未列单独缓存写入费用；对非缓存输入使用普通 input price，只对 `cached_tokens` 使用 cached-input price。对于 Anthropic，cache creation 使用官方 5 分钟或 1 小时写入倍率，cache read 使用读取倍率。对于 Google/Gemini 显式缓存，需要同时计入缓存 token 价格和 TTL 存储成本。对于 DeepSeek，按报告的 hit 与 miss token 精确拆分输入。

## 缓存放置策略 / Cache Placement Strategies

Strategy A: stable system prefix（稳定系统前缀）. Put long-lived system instructions, tool definitions, schemas, glossary, and durable project context first; put per-turn user input, retrieved snippets, timestamps, and volatile state last. This matches OpenAI and Gemini best practices for common prefixes, DeepSeek prefix matching, and Quilin `PromptBuilder`'s `staticPrefix`/`dynamicSuffix` split.

策略 A：stable system prefix（稳定系统前缀）。把长期不变的系统指令、工具定义、schema、术语表和持久项目上下文放在最前；把每轮用户输入、检索片段、时间戳和易变状态放在最后。这与 OpenAI 和 Gemini 对 common prefix（公共前缀）的最佳实践、DeepSeek 的前缀匹配，以及 Quilin `PromptBuilder` 的 `staticPrefix`/`dynamicSuffix` 切分一致。

Strategy B: provider explicit breakpoint（供应商显式断点）. For Anthropic, mark the final cache-eligible system segment with `cache_control` and keep Quilin's cap of four applied breakpoints. For Google/Gemini, create explicit cached content for large reusable corpora and pass `providerOptions.google.cachedContent`. For OpenAI, use `prompt_cache_key` and `prompt_cache_retention` only when the route has a stable high-volume prefix. DeepSeek has no explicit placement API in the OpenAI-format path, so the placement control is byte-stable prefix construction.

策略 B：provider explicit breakpoint（供应商显式断点）。对 Anthropic，在最后一个可缓存系统段上标记 `cache_control`，并保持 Quilin 当前最多应用四个断点的实现边界。对 Google/Gemini，为大型可复用语料创建 explicit cached content（显式缓存内容），并传入 `providerOptions.google.cachedContent`。对 OpenAI，只在路由有稳定高流量前缀时使用 `prompt_cache_key` 和 `prompt_cache_retention`。DeepSeek 的 OpenAI-format path 没有显式放置 API，因此放置控制来自 byte-stable prefix construction（字节稳定前缀构造）。

Strategy C: conversation append-only prefix（对话追加式前缀）. Preserve previous user/assistant/tool turns byte-for-byte and append the new user turn at the end. Do not rewrite earlier turns, reorder tools, or inject fresh timestamps into the cached prefix. If compaction is needed, perform it at an explicit session boundary and start a new cache lineage.

策略 C：conversation append-only prefix（对话追加式前缀）。逐字节保留之前的 user/assistant/tool turns（用户、助手、工具轮次），并把新的用户轮次追加到末尾。不要重写早期轮次、重排工具或把新时间戳注入缓存前缀。如果需要 compaction（压缩），在明确的 session boundary（会话边界）执行，并开启新的缓存血缘。

Strategy D: route-local cache identity（路由局部缓存身份）. Group cache keys by route, prompt profile, tool schema version, and model family, not by individual request ID. This avoids over-fragmentation while still preventing unrelated tasks from sharing an incompatible prefix.

策略 D：route-local cache identity（路由局部缓存身份）。按 route（路由）、prompt profile（提示配置档）、tool schema version（工具 schema 版本）和 model family（模型族）分组缓存 key，而不是按单个请求 ID 分组。这样既避免过度碎片化，也防止无关任务共享不兼容前缀。

## 通过/失败阈值 / Pass-Fail Thresholds

These thresholds are the minimum QUI-74 gate. A result may be marked "warn" for provider outage or rate limiting only when the raw provider error and retry metadata are stored; otherwise missing data is a fail.

这些阈值是 QUI-74 的最低门槛。只有保存了供应商原始错误和 retry metadata（重试元数据）时，才可因供应商故障或限流标为 "warn"；否则缺失数据即失败。

| Metric / 指标 | Pass threshold / 通过阈值 | Fail threshold / 失败阈值 |
|---|---|---|
| Routing / 路由 | 100% of matrix invocations record expected `provider_path`, `configured_model_id`, `effective_model_id`, capability check, and fallback flag. / 矩阵中 100% 调用记录预期 `provider_path`、`configured_model_id`、`effective_model_id`、能力检查和 fallback flag。 | Any silent provider/model substitution, missing route record, or unsupported capability executed without explicit failure. / 任何静默供应商/模型替换、缺失路由记录，或在不支持能力时没有显式失败却继续执行。 |
| Cache observability / 缓存可观测性 | Cache suite uses a static prefix of at least 4,500 estimated tokens and stores provider-native cache evidence for cold and warm calls. / 缓存套件使用至少 4,500 个估算 token 的静态前缀，并保存 cold（冷）与 warm（热）调用的供应商原生缓存证据。 | Any provider path lacks hit/miss or read/write evidence when the official API exposes it. / 供应商官方 API 暴露命中/未命中或读取/写入证据，但该路径没有记录。 |
| Warm cache hit ratio / 热缓存命中率 | Median warm `cache_read_tokens / eligible_prefix_tokens` is at least 0.70 for implicit-cache paths and at least 0.80 for explicit-cache paths. / 热调用中位数 `cache_read_tokens / eligible_prefix_tokens`：隐式缓存路径至少 0.70，显式缓存路径至少 0.80。 | Median warm ratio is below threshold, or all warm calls report zero cache tokens. / 热调用中位数低于阈值，或所有热调用都报告零缓存 token。 |
| TTFT measurement / 首 token 延迟测量 | 100% of streaming runs record `request_start_ms`, `first_event_ms`, `ttft_ms`, and first event type. / 100% 流式运行记录 `request_start_ms`、`first_event_ms`、`ttft_ms` 和第一个事件类型。 | Any streaming run only records final latency, or has no first-event timestamp. / 任一流式运行只记录最终延迟，或没有第一个事件时间戳。 |
| TTFT short-route ceiling / 短路由首 token 上限 | Per provider, median short-route TTFT is <= 3,000 ms and p95 is <= 8,000 ms across the three short-route repetitions. / 每个供应商在三次短路由重复中，TTFT 中位数 <= 3,000 ms 且 p95 <= 8,000 ms。 | Median > 3,000 ms or p95 > 8,000 ms without stored provider/rate-limit warning. / 中位数 > 3,000 ms 或 p95 > 8,000 ms，且没有保存供应商或限流 warning。 |
| TTFT cache regression / 缓存延迟回归 | Median warm long-prefix TTFT is <= 110% of the cold long-prefix TTFT and p95 warm TTFT is <= 15,000 ms. / 长前缀热调用 TTFT 中位数 <= 冷调用 TTFT 的 110%，且热调用 p95 <= 15,000 ms。 | Warm cache is materially slower: median warm TTFT > 110% of cold TTFT, or p95 > 15,000 ms. / 热缓存显著更慢：热调用中位数 > 冷调用的 110%，或 p95 > 15,000 ms。 |
| Cache input unit cost / 缓存输入单位成本 | Warm cached-input unit cost is <= 30% of the same model's cache-miss input unit cost, after provider-specific write/storage rules. / 按供应商写入/存储规则计算后，热缓存输入单位成本 <= 同模型未命中输入单位成本的 30%。 | Warm cached-input unit cost > 30%, or cost is computed without a dated pricing snapshot. / 热缓存输入单位成本 > 30%，或没有带日期价格快照却计算成本。 |
| Request cost accounting / 请求成本核算 | 100% of calls produce non-negative USD cost and preserve raw usage fields used in the calculation. / 100% 调用产出非负 USD 成本，并保留用于计算的原始 usage 字段。 | Any call has negative/NaN cost, missing usage, or unverifiable price mapping. / 任一调用成本为负数/NaN、缺失 usage，或价格映射不可验证。 |
| Output quality / 输出质量 | Each provider path reaches weighted score >= 0.85, with 100% pass on tool/schema fixtures and zero critical safety/format failures. / 每条供应商路径加权分数 >= 0.85，工具/schema 样例 100% 通过，且关键安全/格式失败为零。 | Weighted score < 0.85, any malformed required tool/schema output, or any critical safety/format failure. / 加权分数 < 0.85，任何必需工具/schema 输出格式错误，或任何关键安全/格式失败。 |

## 最小评测矩阵 / Minimum Eval Matrix

Run the matrix in live mode only when the four provider API keys are intentionally configured. If a key is absent, mark the row as blocked rather than skipping it silently.

只有在四个供应商 API key 被明确配置时，才以 live mode（真实接口模式）运行该矩阵。如果缺少 key，把对应行标为 blocked（阻塞），不得静默跳过。

| Scenario ID / 场景 ID | Purpose / 目的 | Prompt shape / Prompt 形态 | Repetitions / 重复次数 | Required assertions / 必须断言 |
|---|---|---|---:|---|
| R1 short route / R1 短路由 | Verify model routing and short TTFT. / 验证模型路由和短 TTFT。 | <= 500 input tokens, no cache expectation, thinking disabled unless provider requires otherwise. / 输入 <= 500 token，不期待缓存，除非供应商强制否则关闭 thinking。 | 3 per provider / 每供应商 3 次 | Expected provider/model selected; streamed first event recorded; deterministic answer exact or regex pass. / 选择预期供应商/模型；记录流式首事件；确定性答案精确或 regex 通过。 |
| C1 long-prefix cache / C1 长前缀缓存 | Verify prompt cache, cost delta, and TTFT cache regression. / 验证提示缓存、成本差异和 TTFT 缓存回归。 | >= 4,500-token stable prefix, short changing user suffix, output capped to <= 128 tokens. / 至少 4,500 token 稳定前缀、短动态用户后缀、输出限制 <= 128 token。 | 1 cold + 2 warm per provider / 每供应商 1 次冷调用 + 2 次热调用 | Native cache evidence; warm hit ratio; cache input unit cost; TTFT cold/warm comparison. / 原生缓存证据；热命中率；缓存输入单位成本；TTFT 冷/热对比。 |
| T1 tool/schema / T1 工具与 schema | Verify provider path supports tool calling or structured output without hidden fallback. / 验证供应商路径支持工具调用或结构化输出，且没有隐藏 fallback。 | One simple tool with strict JSON arguments and one forced structured JSON answer. / 一个带严格 JSON 参数的简单工具，以及一个强制结构化 JSON 答案。 | 2 fixtures per provider / 每供应商 2 个样例 | Tool name and arguments match schema; JSON validates; route record says capability supported. / 工具名和参数匹配 schema；JSON 校验通过；路由记录显示能力受支持。 |
| Q1 quality / Q1 质量 | Verify output quality independent of cache. / 验证不依赖缓存的输出质量。 | Three fixed tasks: code reasoning, concise synthesis, and multi-step planning with known rubric. / 三个固定任务：代码推理、简明综合和多步规划，并带已知 rubric。 | 3 fixtures per provider / 每供应商 3 个样例 | Weighted score >= 0.85; no critical hallucinated tool, unsafe instruction, or schema violation. / 加权分数 >= 0.85；没有关键工具幻觉、不安全指令或 schema 违反。 |

The minimum run therefore makes 10 calls per provider path and 40 calls total. This is small enough for CI-like manual verification while still exercising the five required metric families.

因此最小运行量为每条供应商路径 10 次调用，总计 40 次调用。这个规模足够小，可用于类似 CI 的人工验证，同时仍覆盖五类必需指标。

## 供应商路径验收 / Provider Path Acceptance

OpenAI passes when the run proves an OpenAI route through `@ai-sdk/openai`, records the effective model ID, observes `cached_tokens` on the warm long-prefix calls, computes cost with the current OpenAI cached-input row, and stores `prompt_cache_key`/retention only when configured.

OpenAI 通过条件：运行证明调用经由 `@ai-sdk/openai` 的 OpenAI 路由，记录 effective model ID（实际模型 ID），在长前缀热调用中观察到 `cached_tokens`，使用当前 OpenAI cached-input 行计算成本，并且只在配置时保存 `prompt_cache_key`/retention。

Anthropic passes when the run proves an Anthropic route through `@ai-sdk/anthropic`, records applied `cache_control` breakpoints or automatic caching mode, captures cache creation/read tokens, and applies the official write/read multipliers for cost.

Anthropic 通过条件：运行证明调用经由 `@ai-sdk/anthropic` 的 Anthropic 路由，记录已应用的 `cache_control` breakpoints 或 automatic caching mode，捕获 cache creation/read tokens，并使用官方写入/读取倍率计算成本。

Google/Gemini passes when the run proves a Google/Gemini route through `@ai-sdk/google`, captures `providerMetadata.google.usageMetadata` or raw usage metadata, and for explicit caching records the `cachedContent` name, TTL, cached token count, and storage cost.

Google/Gemini 通过条件：运行证明调用经由 `@ai-sdk/google` 的 Google/Gemini 路由，捕获 `providerMetadata.google.usageMetadata` 或 raw usage metadata，并在显式缓存时记录 `cachedContent` 名称、TTL、缓存 token 数和存储成本。

DeepSeek passes when the run proves a DeepSeek route through `@ai-sdk/deepseek` or Quilin's OpenAI-compatible DeepSeek provider path, records whether thinking mode selected `deepseek-v4-flash` compatibility behavior, and computes cost from `prompt_cache_hit_tokens` plus `prompt_cache_miss_tokens`.

DeepSeek 通过条件：运行证明调用经由 `@ai-sdk/deepseek` 或 Quilin 的 OpenAI-compatible DeepSeek provider path，记录 thinking mode 是否选择 `deepseek-v4-flash` 兼容行为，并用 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens` 计算成本。

## 运行记录字段 / Run Record Fields

Every eval call should emit one JSON record to stdout and the trace store. The record must be stable enough for a later reviewer to recompute pass/fail without rerunning the provider request.

每次评测调用都应向 stdout 和 trace store（追踪存储）输出一条 JSON 记录。该记录必须足够稳定，使后续 reviewer（审核者）无需重跑供应商请求也能重新计算通过/失败。

```json
{
  "linear_issue": "QUI-74",
  "scenario_id": "C1",
  "provider_path": "openai",
  "sdk_package": "@ai-sdk/openai",
  "configured_model_id": "configured-at-runtime",
  "effective_model_id": "returned-by-provider-or-sdk",
  "route_key": "quick|standard|deep|tool|cache",
  "capability_required": ["streaming", "cache", "tool_calling"],
  "capability_supported": true,
  "fallback_used": false,
  "cache_strategy": "stable-system-prefix",
  "request_start_ms": 0,
  "first_event_ms": 0,
  "ttft_ms": 0,
  "first_event_type": "text|reasoning|tool-call-start|tool-call-args-delta",
  "latency_total_ms": 0,
  "usage_normalized": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0
  },
  "usage_raw": {},
  "pricing_snapshot": {
    "source_url": "https://...",
    "accessed_at": "2026-05-02",
    "currency": "USD"
  },
  "cost_usd": {
    "input_no_cache": 0,
    "input_cache_read": 0,
    "input_cache_write": 0,
    "output": 0,
    "cache_storage": 0,
    "total": 0
  },
  "quality": {
    "fixture_id": "q1-code-reasoning",
    "score": 1,
    "max_score": 1,
    "critical_failure": false
  }
}
```

```json
{
  "linear_issue": "QUI-74",
  "scenario_id": "C1",
  "provider_path": "openai（供应商路径）",
  "sdk_package": "@ai-sdk/openai（SDK 包）",
  "configured_model_id": "运行时配置的模型",
  "effective_model_id": "供应商或 SDK 返回的实际模型",
  "route_key": "quick|standard|deep|tool|cache（路由键）",
  "capability_required": ["streaming（流式输出）", "cache（缓存）", "tool_calling（工具调用）"],
  "capability_supported": true,
  "fallback_used": false,
  "cache_strategy": "stable-system-prefix（稳定系统前缀）",
  "request_start_ms": 0,
  "first_event_ms": 0,
  "ttft_ms": 0,
  "first_event_type": "text|reasoning|tool-call-start|tool-call-args-delta（首事件类型）",
  "latency_total_ms": 0,
  "usage_normalized": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0
  },
  "usage_raw": {},
  "pricing_snapshot": {
    "source_url": "https://...",
    "accessed_at": "2026-05-02",
    "currency": "USD"
  },
  "cost_usd": {
    "input_no_cache": 0,
    "input_cache_read": 0,
    "input_cache_write": 0,
    "output": 0,
    "cache_storage": 0,
    "total": 0
  },
  "quality": {
    "fixture_id": "q1-code-reasoning（评测样例 ID）",
    "score": 1,
    "max_score": 1,
    "critical_failure": false
  }
}
```

## 对 QUI-59 与 QUI-60 的约束 / Constraints For QUI-59 And QUI-60

QUI-59 should not close provider routing work until every route emits the run record fields above and fails closed on unsupported capabilities. A route that falls back silently cannot satisfy this baseline even if the final answer is correct.

QUI-59 在每条路由都输出上述运行记录字段，并且对不支持能力 fail closed（显式失败）之前，不应关闭 provider routing 工作。即使最终答案正确，静默 fallback（失败回退）也不能满足本基线。

QUI-60 should not close cache/cost work until cache evidence is native-provider-backed for all four provider paths and cost calculation can be recomputed from saved raw usage plus saved pricing snapshots.

QUI-60 在四条供应商路径的缓存证据都由供应商原生字段支撑，并且成本计算可由保存的 raw usage 与价格快照重新计算之前，不应关闭 cache/cost 工作。

Future work should be logged as comments on QUI-74, QUI-59, or QUI-60 unless it needs independent ownership, blockers, or acceptance criteria under the Linear free-plan budget rule.

后续工作应优先作为 comment（评论）写入 QUI-74、QUI-59 或 QUI-60；只有在确实需要独立负责人、阻塞关系或验收标准时，才按 Linear 免费额度纪律考虑独立 issue。

## 来源 / Sources

OpenAI official sources: [Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching), [Pricing](https://platform.openai.com/docs/pricing), and [AI SDK OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai).

OpenAI 官方来源：[Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching)、[Pricing](https://platform.openai.com/docs/pricing) 和 [AI SDK OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)。

Anthropic official sources: [Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing), and [AI SDK Anthropic Provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic).

Anthropic 官方来源：[Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)、[Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) 和 [AI SDK Anthropic Provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)。

Google/Gemini official sources: [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching), [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing), and [AI SDK Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai).

Google/Gemini 官方来源：[Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)、[Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing) 和 [AI SDK Google Provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)。

DeepSeek official sources: [Context Caching](https://api-docs.deepseek.com/guides/kv_cache), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing), [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion), and [AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek).

DeepSeek 官方来源：[Context Caching](https://api-docs.deepseek.com/guides/kv_cache)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion) 和 [AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)。

AI SDK Core source: [`streamText` usage and provider metadata](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).

AI SDK Core 来源：[`streamText` usage 和 provider metadata](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)。
