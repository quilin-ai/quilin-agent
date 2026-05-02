# 供应商控制平面实现计划 / Provider Control Plane Implementation Plan

> Scope: Linear `QUI-59`, with explicit mapping to `QUI-48`, `QUI-74`, and `QUI-52`. This plan synthesizes `docs/01-llm-integration/llm-frontier-assimilation.md` and `docs/01-llm-integration/routing-cache-cost-evidence.md`.
>
> 范围：Linear `QUI-59`，并明确映射到 `QUI-48`、`QUI-74` 和 `QUI-52`。本文综合 `docs/01-llm-integration/llm-frontier-assimilation.md` 与 `docs/01-llm-integration/routing-cache-cost-evidence.md`。

## 目标 / Goal

The goal is to turn the LLM（Large Language Model，大语言模型）provider decision into an implementation plan for a Quilin-owned `ProviderControlPlane`（供应商控制平面，用来统一决定供应商、模型、预算、缓存、失败回退和错误处理）. Vercel AI SDK（Artificial Intelligence Software Development Kit，人工智能软件开发工具包）v6 remains the execution abstraction, but it should not be the only place where routing, budget, fallback, or provider evidence is decided.
>
> 目标是把 LLM（Large Language Model，大语言模型）供应商决策转成 Quilin 自有 `ProviderControlPlane`（供应商控制平面，用来统一决定供应商、模型、预算、缓存、失败回退和错误处理）的实现计划。Vercel AI SDK（Artificial Intelligence Software Development Kit，人工智能软件开发工具包）v6 继续作为执行抽象，但 routing（路由）、budget（预算）、fallback（失败回退）或供应商证据不应只藏在 SDK 内部。

Benchmark（基准测试，用来比较系统能力的标准化评测）is frozen unless the user explicitly asks. The immediate priority is to make the LLM runtime control plane strong enough for local route decisions, provider evidence, cost accounting, and error records.
>
> 除非用户明确要求，Benchmark（基准测试，用来比较系统能力的标准化评测）工作保持冻结。当前优先级是先把 LLM runtime control plane（大语言模型运行时控制面）做强，用于本地路由决策、供应商证据、成本核算和错误记录。

## 输入结论 / Input Conclusions

`llm-frontier-assimilation.md` concludes that Quilin should keep Vercel AI SDK v6, add a typed `ProviderControlPlane`, support both AI Gateway（模型网关，通过一个入口对多个供应商/模型做路由）and direct provider paths（直接供应商路径，即直接调用某个供应商的 SDK 或 API（Application Programming Interface，应用程序接口））, and require provider live evidence before a route becomes default.
>
> `llm-frontier-assimilation.md` 的结论是：Quilin 应继续使用 Vercel AI SDK v6，增加类型化 `ProviderControlPlane`，同时支持 AI Gateway（模型网关，通过一个入口对多个供应商/模型做路由）与 direct provider paths（直接供应商路径，即直接调用某个供应商的 SDK 或 API（Application Programming Interface，应用程序接口）），并在任何路由成为默认前要求供应商实机证据。

`routing-cache-cost-evidence.md` defines the measurable gate: four provider paths, OpenAI, Anthropic, Google/Gemini, and DeepSeek, each covering short text routing, long-prefix cache behavior, tool/schema（结构约束，用来校验工具参数或结构化输出）behavior, and quality reasoning. It also requires route records, first-event latency, native cache evidence, normalized cost, raw usage, model ID（Identifier，模型标识符）, and pass/fail thresholds.
>
> `routing-cache-cost-evidence.md` 定义了可测门槛：四条供应商路径 OpenAI、Anthropic、Google/Gemini 和 DeepSeek，每条都覆盖短文本路由、长前缀缓存行为、tool/schema（工具结构约束，用来校验工具参数或结构化输出）行为和质量推理。它还要求记录路由、首事件延迟、供应商原生缓存证据、归一化成本、原始用量、model ID（Identifier，模型标识符）和通过/失败阈值。

## 控制面边界 / Control Plane Boundary

`ProviderControlPlane` should own the decision before each model call. It should choose the route profile（路由档案，即一组模型能力、成本、缓存和安全策略配置）, provider mode（供应商模式，即 gateway 或 direct）, model, fallback chain（失败回退链，即主路径失败后的有限备选路径序列）, cache policy, rate-limit model（限流模型，即请求、输入 token、输出 token 和并发的准入规则）, spend cap（成本上限，即单次运行允许花费的最高金额）, timeout, and required telemetry.
>
> `ProviderControlPlane` 应负责每次模型调用前的决策。它要选择 route profile（路由档案，即一组模型能力、成本、缓存和安全策略配置）、provider mode（供应商模式，即 gateway 或 direct）、模型、fallback chain（失败回退链，即主路径失败后的有限备选路径序列）、缓存策略、rate-limit model（限流模型，即请求、输入 token、输出 token 和并发的准入规则）、spend cap（成本上限，即单次运行允许花费的最高金额）、超时和必须记录的遥测。

The lower model client should execute the decision and report facts. It should not silently change provider, switch model, ignore unsupported capabilities, or retry across providers without an explicit attempt record.
>
> 底层模型客户端只应执行决策并回报事实。它不应静默切换供应商、切换模型、忽略不支持的能力，或在没有明确 attempt record（尝试记录）的情况下跨供应商重试。

## 核心数据契约 / Core Data Contracts

`LLMRouteRequest`（模型路由请求，用来描述一次模型调用需要什么能力） should include the intent class, requested capabilities, user-visible risk level, data-control constraints, maximum output tokens（模型输出单位上限，影响上下文和计费）, reasoning budget, stream requirement, tool schemas, structured output schema, cache profile, and per-run spend cap in USD（United States Dollar，美元）.
>
> `LLMRouteRequest`（模型路由请求，用来描述一次模型调用需要什么能力）应包含意图类别、所需能力、用户可见风险等级、数据控制约束、maximum output tokens（最大输出 token，即模型输出单位上限，影响上下文和计费）、推理预算、是否需要流式输出、工具 schema、结构化输出 schema、缓存配置档和以 USD（United States Dollar，美元）计价的单次运行成本上限。

`LLMRouteDecision`（模型路由决策，用来固定这次调用允许怎么执行） should include `route_id`, `provider_mode`, `primary_provider`, `primary_model`, `fallback_chain`, `allowed_providers`, `gateway_options`, `direct_options`, `cache_policy`, `rate_limit_policy`, `budget_policy`, `timeout_policy`, `required_checks`, and `live_matrix_required`.
>
> `LLMRouteDecision`（模型路由决策，用来固定这次调用允许怎么执行）应包含 `route_id`、`provider_mode`、`primary_provider`、`primary_model`、`fallback_chain`、`allowed_providers`、`gateway_options`、`direct_options`、`cache_policy`、`rate_limit_policy`、`budget_policy`、`timeout_policy`、`required_checks` 和 `live_matrix_required`。

`ProviderAttempt`（供应商尝试记录，用来保存每一次真实调用或失败尝试） should include provider, model, gateway or direct mode, start time, first event time, final latency, normalized usage, raw provider usage, raw provider metadata, rate-limit headers, normalized error, billed usage if known, fallback reason, and whether the attempt changed user-visible behavior.
>
> `ProviderAttempt`（供应商尝试记录，用来保存每一次真实调用或失败尝试）应包含供应商、模型、网关或直连模式、开始时间、首事件时间、最终延迟、归一化用量、供应商原始用量、供应商原始元数据、限流响应头、归一化错误、已知计费用量、失败回退原因，以及该尝试是否改变了用户可见行为。

`ProviderRunRecord`（供应商运行记录，用来让后续 reviewer（审核者）复算通过/失败） should combine the route request, route decision, attempt ledger（尝试账本，用来按顺序保存每次供应商调用和失败原因）, final result, normalized cost, cache metrics, and quality result into one JSON（JavaScript Object Notation，一种结构化数据格式）record emitted to logs and trace storage（追踪存储，用来保存可复盘的运行事件）.
>
> `ProviderRunRecord`（供应商运行记录，用来让后续 reviewer（审核者）复算通过/失败）应把路由请求、路由决策、attempt ledger（尝试账本，用来按顺序保存每次供应商调用和失败原因）、最终结果、归一化成本、缓存指标和质量结果合并为一条 JSON（JavaScript Object Notation，一种结构化数据格式）记录，输出到日志和 trace storage（追踪存储，用来保存可复盘的运行事件）。

## 实机矩阵 / Provider Live Matrix

The provider live matrix（供应商实机矩阵，即真实 API 调用形成的能力和证据矩阵） should be a gate for `QUI-59`, not a benchmark substitute. It proves that the runtime can observe and control provider behavior before larger evaluation work starts.
>
> Provider live matrix（供应商实机矩阵，即真实 API 调用形成的能力和证据矩阵）应作为 `QUI-59` 的门槛，而不是 benchmark 的替代品。它证明运行时能在更大规模评测开始前观测并控制供应商行为。

| Provider path / 供应商路径 | Text check / 文本检查 | Stream check / 流式检查 | Tool check / 工具检查 | Reasoning check / 推理检查 | Cache check / 缓存检查 | Error check / 错误检查 |
|---|---|---|---|---|---|---|
| OpenAI direct / OpenAI 直连 | Deterministic short answer with effective model ID. / 确定性短回答并记录实际模型 ID。 | First semantic event timestamp and final usage. / 记录首个语义事件时间戳和最终用量。 | Strict tool arguments or structured output schema. / 校验严格工具参数或结构化输出 schema。 | Reasoning token field when exposed by model. / 模型暴露时记录推理 token 字段。 | `cached_tokens`, `prompt_cache_key`, and retention when configured. / 配置时记录 `cached_tokens`、`prompt_cache_key` 和保留策略。 | HTTP（Hypertext Transfer Protocol，超文本传输协议）status, raw code, retryability, and request ID. / 记录 HTTP 状态、原始错误码、可重试性和请求 ID。 |
| Anthropic direct / Anthropic 直连 | Deterministic short answer with model ID. / 确定性短回答并记录模型 ID。 | Text/tool stream event order and first event latency. / 记录文本/工具流事件顺序和首事件延迟。 | Tool call streaming and schema validation. / 校验工具调用流和 schema。 | Thinking or effort configuration when used. / 使用时记录 thinking 或 effort 配置。 | `cache_control`, cache creation tokens, and cache read tokens. / 记录 `cache_control`、缓存创建 token 和缓存读取 token。 | `retry-after`, request token limit, input token limit, and output token limit. / 记录 `retry-after`、请求限额、输入 token 限额和输出 token 限额。 |
| Google/Gemini direct / Google/Gemini 直连 | Deterministic short answer with Gemini model ID. / 确定性短回答并记录 Gemini 模型 ID。 | First text or tool event from streaming response. / 记录流式响应中的首个文本或工具事件。 | Function calling or structured output support. / 校验函数调用或结构化输出能力。 | `thinkingConfig` and reasoning tokens when exposed. / 暴露时记录 `thinkingConfig` 和推理 token。 | Implicit cache usage or explicit `cachedContent` with TTL（Time To Live，缓存存活时间）. / 记录隐式缓存或带 TTL（Time To Live，缓存存活时间）的显式 `cachedContent`。 | `RESOURCE_EXHAUSTED` and quota errors mapped separately from invalid request errors. / 将 `RESOURCE_EXHAUSTED` 和配额错误从无效请求错误中分离。 |
| DeepSeek direct / DeepSeek 直连 | Deterministic short answer with selected model. / 确定性短回答并记录选择的模型。 | Streaming keep-alive and stuck-stream timeout behavior. / 记录流式保活和卡住流超时行为。 | Tool or structured output through AI SDK provider support. / 通过 AI SDK provider 支持校验工具或结构化输出。 | Reasoning mode selected through model or provider option. / 通过模型或供应商选项记录推理模式。 | `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. / 记录 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。 | 429, 503, slow stream, and provider overload mapped explicitly. / 显式映射 429、503、慢流和供应商过载。 |
| AI Gateway / 模型网关 | Same text fixture, with effective upstream provider. / 使用相同文本样例并记录实际上游供应商。 | Gateway routing metadata plus first event latency. / 记录网关路由元数据和首事件延迟。 | Only enabled when tool capability parity is proven. / 只有证明工具能力等价时启用。 | Only enabled when reasoning metadata parity is proven. / 只有证明推理元数据等价时启用。 | Only accepted when cache metadata parity is proven. / 只有证明缓存元数据等价时接受。 | `providerMetadata.gateway.routing.attempts` preserved as trace evidence. / 保留 `providerMetadata.gateway.routing.attempts` 作为追踪证据。 |

The minimum run should keep the `QUI-74` shape: short route, long-prefix cache, tool/schema, and quality reasoning. `QUI-59` adds implementation checks around gateway/direct choice, fallback chain behavior, rate-limit admission, spend cap enforcement, and normalized error taxonomy.
>
> 最小运行应保留 `QUI-74` 的形态：短路由、长前缀缓存、工具/schema 和质量推理。`QUI-59` 在此基础上增加网关/直连选择、失败回退链行为、限流准入、成本上限强制执行和归一化错误分类的实现检查。

## 路由流程 / Routing Flow

Step 1: classify capability requirements. The control plane should decide whether the call requires plain text, streaming, tool calling, structured output, reasoning, long context, native cache evidence, or provider-specific metadata.
>
> 第一步：分类能力需求。控制面应判断本次调用是否需要纯文本、流式输出、工具调用、结构化输出、推理、长上下文、供应商原生缓存证据或供应商专用元数据。

Step 2: apply policy constraints. The control plane should filter providers by data policy, allowed provider list, user trust level, rate-limit state, spend cap, and feature support.
>
> 第二步：应用策略约束。控制面应按数据策略、允许的供应商列表、用户信任级别、限流状态、成本上限和功能支持情况过滤供应商。

Step 3: choose gateway or direct. Gateway mode is preferred for interchangeable commodity calls, canary routing（小流量验证新路径的路由方式）, outage handling, and model fallback where metadata parity is already proven. Direct mode is required when the call depends on provider-native cache controls, raw usage metadata, reasoning behavior, or strict data-control constraints.
>
> 第三步：选择网关或直连。对于可替换的通用调用、canary routing（小流量验证新路径的路由方式）、故障处理，以及已经证明元数据等价的模型失败回退，优先使用网关模式。当调用依赖供应商原生缓存控制、原始用量元数据、推理行为或严格数据控制约束时，必须使用直连模式。

Step 4: run budget and rate-limit preflight. The control plane should estimate input tokens, possible cache-write cost, maximum output tokens, reasoning budget, and request pressure before the provider receives the request.
>
> 第四步：执行预算和限流预检查。控制面应在供应商收到请求前估算输入 token、可能的缓存写入成本、最大输出 token、推理预算和请求压力。

Step 5: execute attempts and reconcile facts. Each attempt should reconcile actual usage, cache evidence, cost, rate-limit headers, route metadata, and errors back into the attempt ledger before any fallback attempt starts.
>
> 第五步：执行尝试并对账事实。每次尝试都应在任何失败回退尝试开始前，把实际用量、缓存证据、成本、限流响应头、路由元数据和错误对账回尝试账本。

## 网关与直连切换 / Gateway And Direct Switching

Gateway mode should use `providerOptions.gateway.models`, provider `order`, provider `only`, and provider timeout configuration when the route can tolerate provider interchangeability. The implementation must preserve gateway routing metadata, especially attempted provider/model pairs and timeout outcomes.
>
> 网关模式应在路由可以接受供应商可替换时使用 `providerOptions.gateway.models`、供应商 `order`、供应商 `only` 和供应商超时配置。实现必须保留网关路由元数据，尤其是尝试过的供应商/模型组合和超时结果。

Direct mode should use provider packages or direct API paths when the route needs OpenAI prompt cache keys, Anthropic cache breakpoints, Google/Gemini cached content, DeepSeek cache hit/miss evidence, or raw provider reasoning metadata.
>
> 直连模式应在路由需要 OpenAI 提示缓存 key、Anthropic 缓存断点、Google/Gemini 缓存内容、DeepSeek 缓存命中/未命中证据，或供应商原始推理元数据时使用供应商包或 direct API（直连应用程序接口）路径。

The first implementation should mark each route as `gateway_allowed`, `gateway_preferred`, or `direct_required`. `direct_required` should be the default until the gateway path proves metadata parity for that route's required checks.
>
> 第一版实现应把每条路由标为 `gateway_allowed`、`gateway_preferred` 或 `direct_required`。在网关路径证明该路由所需检查的元数据等价前，默认应使用 `direct_required`。

## 失败回退链 / Fallback Chain

The fallback chain（失败回退链，即主供应商或模型失败后的有限备选序列） should be explicit in `LLMRouteDecision`. It should never be inferred at runtime from a generic provider list.
>
> Fallback chain（失败回退链，即主供应商或模型失败后的有限备选序列）应明确写入 `LLMRouteDecision`。它不应在运行时从通用供应商列表里临时推断。

Fallback is allowed only when the next candidate satisfies the same capability requirements, data policy, budget policy, safety policy, and live-matrix status. If the failed call involved structured output or tool calling, the failed schema/tool evidence must be stored before fallback proceeds.
>
> 只有当下一个候选路径满足同样的能力要求、数据策略、预算策略、安全策略和实机矩阵状态时，才允许失败回退。如果失败调用涉及结构化输出或工具调用，必须先保存失败的 schema 或工具证据，才能继续回退。

Same-provider retries should be limited to retryable transport errors, server overload, provider timeout, and rate-limit states with known retry windows. Cross-provider fallback should be treated as a behavior change and recorded in the final result.
>
> 同供应商重试应限制在可重试传输错误、服务器过载、供应商超时，以及带已知重试窗口的限流状态。跨供应商失败回退应被视为行为变化，并写入最终结果。

## 限流模型 / Rate-Limit Model

The first rate-limit model（限流模型，即请求进入供应商前的本地准入与退避规则） should use local token buckets（令牌桶，一种平滑限流算法）per provider path. It should track requests, estimated input tokens, estimated output tokens, active streaming calls, and provider-specific backoff state.
>
> 第一版 rate-limit model（限流模型，即请求进入供应商前的本地准入与退避规则）应为每条供应商路径使用本地 token buckets（令牌桶，一种平滑限流算法）。它应跟踪请求数、估算输入 token、估算输出 token、活跃流式调用数和供应商专用退避状态。

OpenAI should reconcile request and token reset headers when available. Anthropic should reconcile requests per minute, input tokens per minute, output tokens per minute, and `retry-after`. Google/Gemini should map quota and `RESOURCE_EXHAUSTED` into retry or blocked states. DeepSeek should still use local concurrency and stuck-stream protection even though its public docs do not define a fixed user concurrency limit.
>
> OpenAI 应在可用时对账请求和 token 重置响应头。Anthropic 应对账每分钟请求数、每分钟输入 token、每分钟输出 token 和 `retry-after`。Google/Gemini 应把配额与 `RESOURCE_EXHAUSTED` 映射到可重试或阻塞状态。DeepSeek 即使公开文档不定义固定用户并发限制，也仍应使用本地并发保护和卡住流保护。

Failed attempts should still update request pressure, backoff state, and error counters. Otherwise a failing provider can be retried too aggressively and consume the session budget without making progress.
>
> 失败尝试仍应更新请求压力、退避状态和错误计数。否则失败中的供应商可能被过度重试，消耗 session（会话）预算却没有实际进展。

## 成本上限 / Spend Cap

The `BudgetGuard`（预算保护器，用来在花费 token 前估算并阻止超预算调用） should run before each attempt. It should estimate worst-case cost from input tokens, cache-write expectations, maximum output tokens, reasoning budget, provider price snapshot, and fallback chain width.
>
> `BudgetGuard`（预算保护器，用来在花费 token 前估算并阻止超预算调用）应在每次尝试前运行。它应根据输入 token、缓存写入预期、最大输出 token、推理预算、供应商价格快照和失败回退链宽度估算最坏成本。

If the estimate exceeds the configured spend cap, the control plane should choose one of three explicit outcomes: downshift to a cheaper route, ask for user approval, or fail closed（显式失败并停止执行）with `budget_exceeded`. It should not send a provider request and discover the overspend afterward.
>
> 如果估算超过配置的成本上限，控制面应在三种明确结果中选择：降级到更便宜的路由、请求用户确认，或 fail closed（显式失败并停止执行）为 `budget_exceeded`。它不应先发出供应商请求，再事后发现超支。

After completion, actual cost should be computed from actual usage, not only the estimate. The record must keep pricing source URL（Uniform Resource Locator，统一资源定位符）, access date, model ID, provider path, raw usage, normalized usage, cache read/write tokens, reasoning tokens, and total USD cost.
>
> 完成后，实际成本应按实际用量计算，而不是只保留估算。记录必须保留 pricing source URL（价格来源统一资源定位符）、访问日期、model ID、供应商路径、原始用量、归一化用量、缓存读取/写入 token、推理 token 和总 USD 成本。

## 提示缓存指标 / Prompt Cache Metrics

Prompt cache metrics（提示缓存指标，用来判断稳定前缀是否真的被供应商复用并降低成本） should be normalized across providers while preserving raw provider evidence. The normalized fields should include `eligible_prefix_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_hit_tokens`, `cache_miss_tokens`, `cache_storage_tokens`, `cache_ttl_seconds`, `cache_key`, `cache_lineage_id`, and `cache_unit_cost_usd`.
>
> Prompt cache metrics（提示缓存指标，用来判断稳定前缀是否真的被供应商复用并降低成本）应跨供应商归一化，同时保留供应商原始证据。归一化字段应包含 `eligible_prefix_tokens`、`cache_read_tokens`、`cache_write_tokens`、`cache_hit_tokens`、`cache_miss_tokens`、`cache_storage_tokens`、`cache_ttl_seconds`、`cache_key`、`cache_lineage_id` 和 `cache_unit_cost_usd`。

OpenAI should map `cached_tokens` into cache-read evidence. Anthropic should map cache creation and cache read tokens separately. Google/Gemini should map implicit cache usage or explicit `cachedContent` usage metadata, plus storage cost for cached content. DeepSeek should map `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` exactly as reported.
>
> OpenAI 应把 `cached_tokens` 映射为缓存读取证据。Anthropic 应分别映射缓存创建 token 和缓存读取 token。Google/Gemini 应映射隐式缓存用量或显式 `cachedContent` 用量元数据，并为缓存内容计入存储成本。DeepSeek 应按报告原样映射 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。

Cache claims should fail closed when the provider exposes native cache evidence but the run record does not contain it. Wall-clock latency improvement alone is not enough evidence that cache worked.
>
> 如果供应商暴露原生缓存证据但运行记录没有保存，该缓存声明应显式失败。仅靠 wall-clock（墙钟时间）延迟改善，不足以证明缓存生效。

## 归一化错误分类 / Normalized Error Taxonomy

The normalized error taxonomy（归一化错误分类，即把不同供应商错误映射成 Quilin 可决策的小集合） should be small enough for routing and user explanations, but detailed enough to drive retry, fallback, budget, and tool behavior.
>
> Normalized error taxonomy（归一化错误分类，即把不同供应商错误映射成 Quilin 可决策的小集合）应足够小，便于路由和面向用户解释；同时要足够具体，可以驱动重试、失败回退、预算和工具行为。

| Error class / 错误类别 | Meaning / 含义 | Retry / 重试 | Fallback / 失败回退 | User action / 用户动作 |
|---|---|---|---|---|
| `auth_error` | Missing or invalid credential. / 凭证缺失或无效。 | No / 否 | No / 否 | Fix key or login. / 修复 key 或登录。 |
| `permission_error` | Account lacks model or feature access. / 账号缺少模型或功能权限。 | No / 否 | Only if policy allows another provider. / 仅策略允许其他供应商时。 | Request access or approve fallback. / 申请权限或批准回退。 |
| `invalid_request` | Prompt, option, or payload rejected. / 提示、选项或载荷被拒绝。 | No / 否 | No until request is repaired. / 修复请求前不回退。 | Fix configuration. / 修复配置。 |
| `unsupported_capability` | Provider cannot satisfy required tool, stream, reasoning, cache, or schema behavior. / 供应商不能满足所需工具、流式、推理、缓存或 schema 行为。 | No / 否 | Yes if equivalent capability exists. / 若有等价能力则可以。 | Possibly approve route change. / 可能需要批准路由变更。 |
| `rate_limited` | Request or token quota temporarily exhausted. / 请求或 token 配额暂时耗尽。 | Yes after reset. / 重置后可以。 | Yes if same policy is satisfied. / 满足同策略时可以。 | Usually none. / 通常无需动作。 |
| `quota_or_spend_exhausted` | Provider quota or configured spend cap exhausted. / 供应商配额或配置成本上限耗尽。 | No / 否 | Only if budget remains. / 仅预算仍可用时。 | Raise quota or cap. / 提高配额或上限。 |
| `provider_overloaded` | Upstream service unavailable or overloaded. / 上游服务不可用或过载。 | Yes with backoff. / 退避后可以。 | Yes / 可以 | Usually none. / 通常无需动作。 |
| `provider_timeout` | No response or no first event before timeout. / 超时前无响应或无首事件。 | Yes with shorter route or backoff. / 可用更短路由或退避重试。 | Yes / 可以 | Usually none. / 通常无需动作。 |
| `network_error` | Local or transport failure before provider response. / 供应商响应前的本地或传输故障。 | Yes / 可以 | Maybe / 视情况 | Check network if persistent. / 持续发生时检查网络。 |
| `stream_protocol_error` | Stream malformed, stuck, or ended inconsistently. / 流格式错误、卡住或异常结束。 | Yes with new attempt. / 可新尝试。 | Yes if capability parity exists. / 能力等价时可以。 | Usually none. / 通常无需动作。 |
| `tool_schema_error` | Tool arguments or schema output invalid. / 工具参数或 schema 输出无效。 | Maybe with repaired prompt. / 修复提示后可能。 | Only after evidence is stored. / 保存证据后才可以。 | Usually none. / 通常无需动作。 |
| `structured_output_error` | JSON or typed output cannot be validated. / JSON 或类型化输出无法校验。 | Maybe with stricter route. / 更严格路由下可能。 | Only after evidence is stored. / 保存证据后才可以。 | Usually none. / 通常无需动作。 |
| `safety_blocked` | Provider or local policy blocked content. / 供应商或本地策略阻止内容。 | No / 否 | No unless safety policy allows. / 除非安全策略允许。 | User must revise request. / 用户需修改请求。 |
| `budget_exceeded` | Local estimate or actual path would exceed spend cap. / 本地估算或实际路径会超过成本上限。 | No / 否 | Only to cheaper route. / 仅能回退到更便宜路由。 | Approve higher cap or shorter route. / 批准更高上限或更短路由。 |
| `unknown_provider_error` | Raw provider error is not yet classified. / 原始供应商错误尚未分类。 | Conservative no by default. / 默认保守不重试。 | Conservative no by default. / 默认保守不回退。 | Review taxonomy. / 审核分类。 |

Each normalized error should carry `retryable`, `fallback_allowed`, `requires_user_action`, `provider`, `model`, `http_status`, `raw_code`, `request_id`, `rate_limit_reset_at`, `billed_usage_if_known`, and `raw_error_redacted`.
>
> 每个归一化错误都应携带 `retryable`、`fallback_allowed`、`requires_user_action`、`provider`、`model`、`http_status`、`raw_code`、`request_id`、`rate_limit_reset_at`、`billed_usage_if_known` 和 `raw_error_redacted`。

## Gemini 支持 / Gemini Provider Support

Gemini provider support（Gemini 供应商支持，即通过 Google/Gemini 路径调用 Gemini 模型并保留其专用元数据） should be a first-class `QUI-59` requirement, not a later optional provider. The first implementation should use the AI SDK Google provider for direct mode and should keep the model ID, `providerMetadata.google.usageMetadata`, cache evidence, quota errors, and thinking configuration.
>
> Gemini provider support（Gemini 供应商支持，即通过 Google/Gemini 路径调用 Gemini 模型并保留其专用元数据）应作为 `QUI-59` 的一等要求，而不是后续可选供应商。第一版实现应在直连模式使用 AI SDK Google provider，并保留模型 ID、`providerMetadata.google.usageMetadata`、缓存证据、配额错误和 thinking 配置。

Gemini explicit cache support should create or reference `cachedContent` only for large reusable corpora with known TTL, storage cost, and cache lineage. Normal repeated prompt prefixes should first use implicit caching and record usage metadata before introducing explicit cache objects.
>
> Gemini 显式缓存支持只应为具备明确 TTL、存储成本和缓存血缘的大型可复用语料创建或引用 `cachedContent`。普通重复提示前缀应先使用隐式缓存，并在引入显式缓存对象前记录用量元数据。

Gemini error mapping should separate quota exhaustion, backend overload, invalid request, unsupported feature, and safety blocking. This matters because each category produces a different route decision: wait, fallback, repair request, choose direct mode, or ask the user to revise content.
>
> Gemini 错误映射应区分配额耗尽、后端过载、无效请求、不支持功能和安全阻止。这很重要，因为每一类都会产生不同路由决策：等待、失败回退、修复请求、选择直连模式，或请用户修改内容。

## 实现切片 / Implementation Slices

Slice 1 should add the typed route request and route decision objects around the existing LLM client. This slice should be docs-aligned and should not perform live calls yet.
>
> 切片 1 应在现有 LLM 客户端外围增加类型化路由请求和路由决策对象。该切片应先与文档对齐，暂不执行真实调用。

Slice 2 should add direct provider path support for OpenAI, Anthropic, Google/Gemini, and DeepSeek, with run records for text, stream, tool, reasoning, cache, and error checks.
>
> 切片 2 应增加 OpenAI、Anthropic、Google/Gemini 和 DeepSeek 的直连供应商路径支持，并为文本、流式、工具、推理、缓存和错误检查输出运行记录。

Slice 3 should add gateway mode and gateway metadata preservation. Gateway mode should remain disabled for any route whose required cache, reasoning, tool, or error metadata is not yet equivalent to direct mode.
>
> 切片 3 应增加网关模式和网关元数据保留。对于任何缓存、推理、工具或错误元数据尚未与直连模式等价的路由，网关模式应保持禁用。

Slice 4 should add `BudgetGuard`, rate-limit admission, and spend-cap outcomes. This slice should fail closed before spending provider tokens when the estimated request exceeds cap.
>
> 切片 4 应增加 `BudgetGuard`、限流准入和成本上限结果。当估算请求超过上限时，该切片应在花费供应商 token 前显式失败。

Slice 5 should add fallback chain execution with a local attempt ledger. This slice should prove that each fallback attempt preserves capability, data policy, safety policy, and budget policy.
>
> 切片 5 应增加带本地尝试账本的失败回退链执行。该切片应证明每次回退尝试都保持能力、数据策略、安全策略和预算策略不变。

Slice 6 should run the provider live matrix and store reusable JSON records. This is component verification, not Benchmark work.
>
> 切片 6 应运行供应商实机矩阵并保存可复用 JSON 记录。这是组件验证，不是 Benchmark 工作。

## 验收门槛 / Acceptance Gates

`QUI-59` should not be marked done until every supported provider path emits `LLMRouteDecision`, `ProviderAttempt`, normalized usage, normalized cost, native cache evidence when exposed, and normalized errors for the relevant fixtures.
>
> 在每条受支持供应商路径都能为相关样例输出 `LLMRouteDecision`、`ProviderAttempt`、归一化用量、归一化成本、供应商暴露时的原生缓存证据和归一化错误之前，`QUI-59` 不应标记完成。

Silent provider substitution should be a hard failure. A final answer can be correct while the route is still invalid if Quilin cannot prove which provider/model ran, whether fallback happened, what it cost, or which capability checks passed.
>
> 静默供应商替换应视为硬失败。即使最终答案正确，只要 Quilin 不能证明哪个供应商/模型被执行、是否发生失败回退、成本是多少、哪些能力检查通过，该路由仍然无效。

Live-gated checks（实机门禁检查，即需要真实供应商调用才能验证的检查）should be blocked explicitly when credentials or model access are missing. Missing keys should create a blocked run record, not a silent skip.
>
> Live-gated checks（实机门禁检查，即需要真实供应商调用才能验证的检查）在缺少凭证或模型权限时应显式标记阻塞。缺失 key 应产生 blocked（阻塞）运行记录，而不是静默跳过。

## Linear 映射 / Linear Mapping

`QUI-59` owns implementation of this plan: provider live matrix, route decisions, gateway/direct switching, fallback chain, rate-limit model, spend cap, prompt cache metrics, normalized error taxonomy, and Gemini provider support.
>
> `QUI-59` 承载本文的实现：供应商实机矩阵、路由决策、网关/直连切换、失败回退链、限流模型、成本上限、提示缓存指标、归一化错误分类和 Gemini 供应商支持。

`QUI-48` is the upstream decision source. The implementation should not reopen the architecture question unless live evidence disproves the hybrid gateway/direct plan.
>
> `QUI-48` 是上游决策来源。除非实机证据推翻混合网关/直连方案，否则实现不应重新打开架构问题。

`QUI-74` is the measurement baseline. Its 4 provider x 4 scenario matrix supplies the evidence shape, pass/fail thresholds, cache metrics, cost fields, and run-record requirements that `QUI-59` should implement.
>
> `QUI-74` 是测量基线。它的 4 个供应商 x 4 个场景矩阵提供 `QUI-59` 应实现的证据形态、通过/失败阈值、缓存指标、成本字段和运行记录要求。

`QUI-52` consumes the output at the tools boundary. Tool routing must receive `unsupported_capability`, `tool_schema_error`, fallback attempt data, spend-cap state, and provider path evidence instead of guessing provider behavior.
>
> `QUI-52` 在工具边界消费本文输出。工具路由必须接收 `unsupported_capability`、`tool_schema_error`、失败回退尝试数据、成本上限状态和供应商路径证据，而不是猜测供应商行为。

## 最小后续动作 / Minimum Next Actions

Implement the route decision objects first, then wire one direct provider path end to end before expanding to all four providers. The first provider should prove the full record shape, because multiplying a weak record across four providers would create more noise than confidence.
>
> 先实现路由决策对象，再把一条直连供应商路径端到端打通，最后扩展到四个供应商。第一条供应商路径应先证明完整记录形态，因为把薄弱记录复制到四个供应商只会制造噪音，而不是增加可信度。

After one direct path passes, add the remaining direct paths, then gateway mode, then fallback chain execution. The component should only move toward benchmark work after the live matrix proves that the control plane can explain and replay every meaningful provider decision.
>
> 一条直连路径通过后，再加入其余直连路径、网关模式和失败回退链执行。只有当实机矩阵证明控制面能解释并复盘每个重要供应商决策后，该组件才应进入 benchmark 工作。
