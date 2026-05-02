# BrowserProvider 实现计划 / BrowserProvider Implementation Plan

> Execution date: 2026-05-02 in the Asia/Shanghai workspace. Linear record: `QUI-18`. This document is a planning artifact only; it does not start benchmark work and does not create new Linear issues.
>
> 执行日期：工作区 Asia/Shanghai 时区 2026-05-02。Linear 记录：`QUI-18`。本文只负责实现规划；不启动 benchmark（基准测试）工作，也不新建 Linear issue。

> Inputs: `docs/05-tool/tools-frontier-assimilation.md`, `docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`, `docs/05-tool/README.md`, and current `packages/agent-core/src/tools/` evidence. `docs/09-deployment-runtime/sandbox-router-implementation-plan.md` does not exist in the current workspace, so sandbox lifecycle references come from the deployment/runtime frontier note.
>
> 输入来源：`docs/05-tool/tools-frontier-assimilation.md`、`docs/09-deployment-runtime/deployment-runtime-frontier-assimilation.md`、`docs/05-tool/README.md`，以及当前 `packages/agent-core/src/tools/` 的本地证据。当前工作区没有 `docs/09-deployment-runtime/sandbox-router-implementation-plan.md`，所以沙箱生命周期引用来自部署/运行时前沿文档。

## 结论 / Verdict

BrowserProvider v1（浏览器提供方第一版，负责在不同浏览器/网页工具之间做策略路由）should be implemented as a host-controlled routing layer behind `ToolRouter`, not as a single dependency choice. The first production slice should ship `FetchProvider`, Playwright MCP（Microsoft Playwright 的 Model Context Protocol 浏览器工具，提供结构化网页操作能力）, and browser-use（以真实浏览器会话和认证状态管理见长的浏览器自动化项目）as the three active routes.

BrowserProvider v1（浏览器提供方第一版，负责在不同浏览器/网页工具之间做策略路由）应实现为 `ToolRouter` 背后的宿主控制路由层，而不是选择某一个单独依赖。第一版生产切片应把 `FetchProvider`、Playwright MCP（Microsoft Playwright 的 Model Context Protocol 浏览器工具，提供结构化网页操作能力）和 browser-use（以真实浏览器会话和认证状态管理见长的浏览器自动化项目）作为三条主动路径。

Stagehand（Browserbase 的 TypeScript 浏览器自动化框架，适合可重复的代码加自然语言工作流）should enter only as a bounded spike（小范围验证切片，用于验证价值和风险）after the three active routes are stable. Skyvern（面向视觉脆弱网页流程的自动化项目）and Steel（面向云浏览器会话、代理和调试的浏览器基础设施）should stay deferred because they add heavier runtime, licensing, or infrastructure questions.

Stagehand（Browserbase 的 TypeScript 浏览器自动化框架，适合可重复的代码加自然语言工作流）只应在三条主动路径稳定后作为 bounded spike（小范围验证切片，用于验证价值和风险）进入。Skyvern（面向视觉脆弱网页流程的自动化项目）和 Steel（面向云浏览器会话、代理和调试的浏览器基础设施）应保持延后，因为它们会引入更重的运行时、许可或基础设施问题。

Computer Use（计算机使用，基于截图和鼠标/键盘动作控制图形界面的能力）must be a last-resort provider with approval, redaction, allowlists, budget caps, and audit records. It can mutate accounts and local state as strongly as shell or file tools, so it must remain behind `WriteAuthority`（统一写入权限门，负责审批和审计高风险写操作）instead of bypassing normal tool policy.

Computer Use（计算机使用，基于截图和鼠标/键盘动作控制图形界面的能力）必须作为最后兜底路径，并带审批、脱敏、allowlist（允许清单）、预算上限和审计记录。它对账号和本地状态的修改能力不低于 shell 或文件工具，所以必须位于 `WriteAuthority`（统一写入权限门，负责审批和审计高风险写操作）之后，不能绕开正常工具策略。

## 当前事实 / Current Facts

The current TypeScript tool contract is still thin: `ToolResult` contains only `toolCallId`, `content`, and `isError`, while `ToolRouter` validates parameters, executes a tool, and returns only string content plus error status. BrowserProvider v1 therefore needs a small local metadata envelope even before a full `ToolResultV2` lands under `QUI-52`.

当前 TypeScript 工具契约仍然偏薄：`ToolResult` 只有 `toolCallId`、`content` 和 `isError`，而 `ToolRouter` 只做参数校验、执行工具，并返回字符串内容和错误状态。因此 BrowserProvider v1 在 `QUI-52` 完整落地 `ToolResultV2` 之前，也需要一个小型本地 metadata envelope（元数据包）。

The current `web_fetch` tool already provides useful `FetchProvider` groundwork: it restricts protocols to HTTP/HTTPS, has timeout and response-size bounds, and strips sensitive authentication headers unless the host is allowlisted. BrowserProvider should preserve these safety properties instead of replacing them with a weaker generic fetch.

当前 `web_fetch` 工具已经提供了有用的 `FetchProvider` 地基：它把协议限制在 HTTP/HTTPS，具备超时和响应大小边界，并且除非主机位于允许清单，否则会剥离敏感认证请求头。BrowserProvider 应保留这些安全性质，而不是用更弱的通用 fetch 替换它。

The deployment/runtime frontier note assigns sandbox lifecycle, leases, labels, readiness probes, cleanup deadlines, suspend/resume, and cloud provider configuration to `QUI-21` and `QUI-62`. BrowserProvider should depend on those contracts for persistent browser sessions, but it should not own Docker, gVisor（在容器和宿主之间增加用户态内核边界的容器运行时）, or cloud sandbox implementation.

部署/运行时前沿文档已经把沙箱生命周期、lease（租约）、label（标签）、readiness probe（就绪探针）、清理截止时间、暂停/恢复和云提供方配置归给 `QUI-21` 与 `QUI-62`。BrowserProvider 应依赖这些契约来承载持久浏览器会话，但不应自己负责 Docker、gVisor（在容器和宿主之间增加用户态内核边界的容器运行时）或云沙箱实现。

## BrowserProvider v1 路由矩阵 / BrowserProvider v1 Routing Matrix

BrowserProvider routing（浏览器提供方路由，按任务语义选择网页工具的策略）should choose the cheapest route that can complete the task while preserving safety, determinism, and auditability. The route decision must be recorded as data, not hidden inside prose.

BrowserProvider routing（浏览器提供方路由，按任务语义选择网页工具的策略）应选择能完成任务且成本最低的路径，同时保持安全性、确定性和可审计性。路由决策必须记录为数据，而不是藏在自然语言里。

| Signal / 信号 | Primary provider / 主路径 | Fallback / 兜底 | Why / 原因 | Linear |
|---|---|---|---|---|
| Public static page, read-only / 公开静态页面，只读 | `FetchProvider`（基于 `web_fetch` 的只读抓取路径） | Playwright MCP when rendering is required / 需要渲染时走 Playwright MCP | Lowest cost, easiest to bound, existing SSRF guard can be reused / 成本最低、边界最清晰，可复用现有 SSRF（Server-Side Request Forgery，服务端请求伪造）防护 | `QUI-18`, `QUI-52` |
| Public rendered page, no login / 公开渲染页面，无登录 | Playwright MCP | `FetchProvider` for final static fetch / 最终静态读取可回退 `FetchProvider` | Structured accessibility tree avoids vision cost and keeps actions machine-readable / 结构化可访问性树避免视觉成本，并让动作保持机器可读 | `QUI-18`, `QUI-52` |
| Authenticated browser session / 已登录浏览器会话 | browser-use | Playwright MCP extension/profile mode after policy review / 策略评审后可用 Playwright MCP 扩展或 profile 模式 | Real Chrome profile and storage-state handling are the strongest near-term auth path / 真实 Chrome profile 与 storage-state（浏览器登录状态）管理是近期最强认证路径 | `QUI-18`, `QUI-21` |
| Repeatable operational workflow / 可重复运营流程 | Playwright MCP first, Stagehand spike second / 先 Playwright MCP，再 Stagehand spike | browser-use when auth/session dominates / 认证或会话占主导时走 browser-use | Keep v1 dependency light; validate Stagehand only where code-plus-natural-language workflows pay off / 第一版保持依赖轻量；只在代码加自然语言工作流收益明确时验证 Stagehand | `QUI-18` |
| Visually brittle RPA page / 视觉脆弱 RPA 页面 | Playwright MCP or browser-use attempt / 先尝试 Playwright MCP 或 browser-use | Skyvern deferred, Computer Use with approval / Skyvern 延后，Computer Use 带审批兜底 | Visual RPA（Robotic Process Automation，面向重复图形界面流程的自动化）is valuable but too heavy for v1 core / 视觉 RPA 有价值，但对第一版核心过重 | `QUI-18`, `QUI-21` |
| Cloud browser, proxy, stealth, debug UI / 云浏览器、代理、隐身、调试界面 | Defer to `QUI-21` provider configuration / 延后到 `QUI-21` 提供方配置 | Steel deferred / Steel 延后 | This is runtime infrastructure, not BrowserProvider policy / 这是运行时基础设施，不是 BrowserProvider 策略本身 | `QUI-18`, `QUI-21` |
| Non-browser GUI or canvas-only target / 非浏览器 GUI 或纯 canvas 目标 | Computer Use with approval / 带审批的 Computer Use | Human handoff / 人工接管 | This is outside normal DOM/API automation and carries higher mutation risk / 超出普通 DOM（Document Object Model，网页结构树）或 API（Application Programming Interface，程序接口）自动化范围，修改风险更高 | `QUI-18`, `QUI-21` |

## 提供方契约 / Provider Contracts

`FetchProvider`（只读网页抓取提供方）should wrap the existing `web_fetch` behavior and expose a browser-specific result shape: final URL, status code when available, content type, byte count, redirect count, timeout, stripped-auth-header flag, and SSRF decision. It should never accept cookies or credential headers unless a host allowlist has been explicitly configured.

`FetchProvider`（只读网页抓取提供方）应封装现有 `web_fetch` 行为，并暴露浏览器专用结果形态：最终 URL、可用时的状态码、内容类型、字节数、重定向次数、超时、是否剥离认证请求头，以及 SSRF 决策。除非显式配置 host allowlist（主机允许清单），它不应接受 cookie 或凭证请求头。

`PlaywrightMCPProvider`（Playwright MCP 提供方，通过 Microsoft Playwright 的 MCP 浏览器工具执行结构化浏览器动作）should be the default rendered-page provider. Its boundary is structured browser interaction, not security isolation; the host must still enforce domain allowlists, action budgets, timeouts, and output sanitization.

`PlaywrightMCPProvider`（Playwright MCP 提供方，通过 Microsoft Playwright 的 MCP 浏览器工具执行结构化浏览器动作）应作为默认渲染页面提供方。它的边界是结构化浏览器交互，不是安全隔离；宿主仍必须强制 domain allowlist（域名允许清单）、动作预算、超时和输出清洗。

`BrowserUseProvider`（browser-use 提供方，使用真实浏览器会话完成认证和复杂交互）should own session-heavy tasks: authenticated websites, storage-state import/export, user-approved local Chrome profile reuse, and recovery from expired sessions. It should require a `sessionScope` field so a task cannot accidentally reuse a personal profile outside its approved domain set.

`BrowserUseProvider`（browser-use 提供方，使用真实浏览器会话完成认证和复杂交互）应负责重会话任务：已登录网站、storage-state 导入导出、用户批准的本地 Chrome profile 复用，以及登录过期恢复。它必须要求 `sessionScope` 字段，避免任务在批准域名集合之外意外复用个人 profile。

`StagehandProvider`（Stagehand 提供方，面向 TypeScript 的代码加自然语言浏览器流程）should not be active in v1. The spike should prove three things before promotion: schema-backed extraction improves reliability, repeated workflow code is simpler than Playwright MCP scripts, and the provider can emit the same budget and audit fields as the other routes.

`StagehandProvider`（Stagehand 提供方，面向 TypeScript 的代码加自然语言浏览器流程）不应在 v1 直接启用。升级前的 spike 必须证明三件事：schema-backed extraction（由结构约束支持的信息抽取）提升可靠性、可重复流程代码比 Playwright MCP 脚本更简单，并且该提供方能输出和其他路径相同的预算与审计字段。

`SkyvernProvider`（Skyvern 提供方，面向视觉脆弱流程的自动化路径）should remain deferred until there is a license review and a concrete page class that Playwright MCP plus browser-use cannot handle. The plan should absorb its workflow ideas, but not add an AGPL-licensed dependency into the core without review.

`SkyvernProvider`（Skyvern 提供方，面向视觉脆弱流程的自动化路径）应延后，直到完成 license review（许可评审）并确认存在 Playwright MCP 加 browser-use 无法处理的具体网页类型。计划可以吸收它的 workflow（工作流）思想，但不能在未经评审时把 AGPL 授权依赖加入核心。

`SteelProvider`（Steel 提供方，面向云浏览器会话、代理、扩展和调试基础设施）should remain a deployment/runtime option, not a core BrowserProvider dependency. BrowserProvider should expose a provider-neutral session contract so `QUI-21` can later bind Steel, Browserbase, or a self-hosted Playwright service without changing routing policy.

`SteelProvider`（Steel 提供方，面向云浏览器会话、代理、扩展和调试基础设施）应保持为部署/运行时选项，而不是 BrowserProvider 核心依赖。BrowserProvider 应暴露 provider-neutral session contract（提供方中立的会话契约），让 `QUI-21` 后续能接入 Steel、Browserbase 或自托管 Playwright 服务，而无需改动路由策略。

## Computer Use 边界 / Computer Use Boundaries

Computer Use should be modeled as `ComputerUseProvider`, a last-resort GUI provider with screenshot observation and input actions. Its supported actions in v1 should be limited to `observe`, `click`, `type`, `keypress`, `scroll`, `drag`, `wait`, and `stop`; each mutating action must carry a route reason and approval state.

Computer Use 应建模为 `ComputerUseProvider`，即通过截图观察和输入动作执行任务的最后兜底 GUI 提供方。v1 支持动作应限制为 `observe`、`click`、`type`、`keypress`、`scroll`、`drag`、`wait` 和 `stop`；每个会改变状态的动作都必须携带路由理由和审批状态。

Approval must be action-aware. Read-only observation can be allowed under a read policy, but text entry, form submission, file upload, checkout, account setting changes, and destructive UI operations must route through `WriteAuthority` with the same CRITICAL confirmation semantics used by shell/file tools.

审批必须感知具体动作。只读观察可以在 read policy（只读策略）下允许，但文本输入、表单提交、文件上传、结账、账号设置修改和破坏性界面操作必须经过 `WriteAuthority`，并使用和 shell/file 工具一致的 CRITICAL（关键风险）确认语义。

Screenshot redaction（截图脱敏，用遮盖或删除敏感区域来降低泄露风险）must happen before model-visible screenshots are stored or sent to a model. Minimum v1 redaction should cover password fields, one-time-code fields, visible access tokens, credit-card-like number groups, email inbox bodies unless explicitly allowed, and user-selected screen rectangles.

Screenshot redaction（截图脱敏，用遮盖或删除敏感区域来降低泄露风险）必须在模型看到、存储或发送截图之前执行。v1 最小脱敏范围应覆盖密码字段、一次性验证码字段、可见 access token（访问令牌）、类似信用卡号的数字组、未显式允许的邮箱正文，以及用户选择的屏幕矩形区域。

Allowlists（允许清单，用于限制工具可触达的域名、应用或动作）must include domain allowlists for browser pages, app allowlists for native GUI targets, file picker allowlists for uploads/downloads, and action allowlists for high-risk gestures. Deny-by-default should apply when the target cannot be classified.

Allowlists（允许清单，用于限制工具可触达的域名、应用或动作）必须包括浏览器页面的域名允许清单、原生 GUI 目标的应用允许清单、上传/下载的文件选择允许清单，以及高风险手势的动作允许清单。当目标无法分类时，应默认拒绝。

## OpenAPI Gateway 边界 / OpenAPI Gateway Boundaries

OpenAPI gateway（基于 OpenAPI 规范把 HTTP API 暴露为工具的网关）belongs to the same tool surface as BrowserProvider but must not be hidden inside it. BrowserProvider handles web pages and GUI interaction; OpenAPI gateway handles documented machine APIs with schemas, authentication policy, request validation, response validation, and rate limits.

OpenAPI gateway（基于 OpenAPI 规范把 HTTP API 暴露为工具的网关）属于同一个工具表面，但不能藏在 BrowserProvider 内部。BrowserProvider 处理网页和 GUI 交互；OpenAPI gateway 处理有文档的机器 API，并负责 schema（结构约束）、认证策略、请求校验、响应校验和限流。

The route order should prefer OpenAPI gateway over browser automation when a reliable API exists. This prevents wasting browser sessions on tasks that can be performed through a typed HTTP request, and it gives `ToolResultV2` cleaner structured outputs than screenshots or page text.

当存在可靠 API 时，路由顺序应优先 OpenAPI gateway，再考虑浏览器自动化。这样可以避免把浏览器会话浪费在可通过 typed HTTP request（带类型的 HTTP 请求）完成的任务上，也能让 `ToolResultV2` 获得比截图或页面文本更清晰的结构化输出。

OpenAPI gateway should reject three classes by default: undocumented live mutations without approval metadata, endpoints that require secrets not present in a credential allowlist, and schemas that cannot produce bounded response sizes. BrowserProvider should only be allowed to compensate after OpenAPI gateway returns a structured "not available" or "not authorized" result.

OpenAPI gateway 默认应拒绝三类请求：没有审批元数据的未文档化线上修改、需要未在凭证允许清单中的密钥的端点，以及无法产生有界响应大小的 schema。只有当 OpenAPI gateway 返回结构化的“不可用”或“未授权”结果后，BrowserProvider 才能补位。

## 延迟工具加载 / Deferred Tool Loading

Deferred tool loading（延迟工具加载，先暴露工具命名空间摘要，需要时再加载完整工具 schema）should be mandatory for browser and OpenAPI surfaces because these providers can expose many actions. The model should first see compact capabilities such as `browser.read`, `browser.interact`, `browser.session`, `computer.use`, and `api.call`; full schemas load only after route selection.

Deferred tool loading（延迟工具加载，先暴露工具命名空间摘要，需要时再加载完整工具 schema）对浏览器和 OpenAPI 表面应是强制要求，因为这些提供方可能暴露大量动作。模型应先看到紧凑能力摘要，例如 `browser.read`、`browser.interact`、`browser.session`、`computer.use` 和 `api.call`；完整 schema 只在路由选择后加载。

The namespace summary should include provider capabilities, risk level, auth requirements, estimated latency, estimated token cost, estimated external spend, and whether the route can mutate remote state. This lets the planner choose a route without paying the token cost for every provider-specific action schema.

命名空间摘要应包含提供方能力、风险等级、认证要求、预计延迟、预计 token 成本、预计外部花费，以及该路径是否可能修改远端状态。这样规划器可以在不支付所有 provider-specific action schema（提供方专属动作结构）token 成本的情况下选择路径。

Full tool schemas should load through an auditable `ToolSurfaceLoader`（工具表面加载器，负责按策略加载工具 schema）that records who requested the surface, why it was needed, what policy allowed it, and how many tokens were added to the context. This maps directly to `QUI-52` because tool discovery budget belongs to the shared tool contract.

完整工具 schema 应通过可审计的 `ToolSurfaceLoader`（工具表面加载器，负责按策略加载工具 schema）加载，并记录谁请求了该工具表面、为什么需要、哪个策略允许，以及向上下文增加了多少 token。这直接映射到 `QUI-52`，因为工具发现预算属于共享工具契约。

## 预算与审计字段 / Budget And Audit Fields

Every BrowserProvider route should emit a `BrowserRouteRecord`（浏览器路由记录，用于审计和复盘一次路由决策）even if the current `ToolResult` cannot yet carry all fields. Until `ToolResultV2` exists, the record can be written to logs and referenced through a compact `auditRef` in the string content.

每次 BrowserProvider 路由都应产生 `BrowserRouteRecord`（浏览器路由记录，用于审计和复盘一次路由决策），即使当前 `ToolResult` 还不能承载所有字段。在 `ToolResultV2` 出现前，该记录可以写入日志，并通过字符串内容里的紧凑 `auditRef` 引用。

Minimum budget fields are `tokenBudget`, `wallClockMs`, `actionBudget`, `retryBudget`, `outputByteBudget`, `externalSpendUsd`, `providerConcurrency`, and `screenshotBudget`. These fields should be enforced before execution and decremented after each provider action.

最小预算字段是 `tokenBudget`、`wallClockMs`、`actionBudget`、`retryBudget`、`outputByteBudget`、`externalSpendUsd`、`providerConcurrency` 和 `screenshotBudget`。这些字段应在执行前强制检查，并在每个 provider action（提供方动作）之后扣减。

Minimum audit fields are `traceId`, `toolCallId`, `routeId`, `provider`, `routeReason`, `riskLevel`, `approvalState`, `principalId`, `sessionScope`, `targetOrigin`, `allowedOrigins`, `redactionProfile`, `startedAt`, `endedAt`, `latencyMs`, `status`, and `failureKind`. These fields make browser work reviewable in Linear comments, local logs, and future observability traces.

最小审计字段是 `traceId`、`toolCallId`、`routeId`、`provider`、`routeReason`、`riskLevel`、`approvalState`、`principalId`、`sessionScope`、`targetOrigin`、`allowedOrigins`、`redactionProfile`、`startedAt`、`endedAt`、`latencyMs`、`status` 和 `failureKind`。这些字段让浏览器任务能在 Linear comment、本地日志和未来可观测性 trace（追踪记录）中被复盘。

Minimum session fields are `sessionId`, `sessionOwner`, `storageStateRef`, `profileRef`, `sandboxLeaseId`, `networkPolicy`, `mountPolicy`, `resumePolicy`, and `cleanupDeadline`. Ownership of sandbox leases and resume behavior remains with `QUI-21` and `QUI-62`; BrowserProvider only consumes and reports these values.

最小会话字段是 `sessionId`、`sessionOwner`、`storageStateRef`、`profileRef`、`sandboxLeaseId`、`networkPolicy`、`mountPolicy`、`resumePolicy` 和 `cleanupDeadline`。沙箱 lease 与恢复行为的归属仍在 `QUI-21` 和 `QUI-62`；BrowserProvider 只消费并报告这些值。

## 实施切片 / Implementation Slices

Slice 1 should define route types and records: `BrowserTask`, `BrowserRoutePolicy`, `BrowserProvider`, `BrowserRouteRecord`, and `BrowserProviderResult`. Acceptance is a pure unit-testable route policy that chooses `FetchProvider`, Playwright MCP, browser-use, or Computer Use based on explicit task signals.

切片 1 应定义路由类型和记录：`BrowserTask`、`BrowserRoutePolicy`、`BrowserProvider`、`BrowserRouteRecord` 和 `BrowserProviderResult`。验收标准是一个可纯单元测试的路由策略，能根据显式任务信号选择 `FetchProvider`、Playwright MCP、browser-use 或 Computer Use。

Slice 2 should wrap existing `web_fetch` as `FetchProvider`. Acceptance is preservation of protocol restrictions, timeout limits, response-size limits, redirect limits, authentication-header stripping, and SSRF decisions, plus route record emission.

切片 2 应把现有 `web_fetch` 封装为 `FetchProvider`。验收标准是保留协议限制、超时限制、响应大小限制、重定向限制、认证请求头剥离和 SSRF 决策，并额外产生路由记录。

Slice 3 should add Playwright MCP through the existing MCP registry path. Acceptance is that browser tools are namespaced, loaded through deferred tool loading, bounded by per-tool timeouts, and wrapped with route/audit metadata rather than being exposed as raw MCP tools.

切片 3 应通过现有 MCP registry（MCP 工具注册表）路径接入 Playwright MCP。验收标准是浏览器工具有命名空间、通过延迟工具加载进入、受 per-tool timeout（单工具超时）约束，并被路由/审计元数据包裹，而不是作为原始 MCP 工具直接暴露。

Slice 4 should add browser-use as a session-heavy provider. Acceptance is that all profile reuse requires explicit `sessionScope`, domain allowlists, approval for personal profile access, and a storage-state reference that can be owned by deployment/runtime lifecycle code.

切片 4 应增加 browser-use 作为重会话提供方。验收标准是所有 profile 复用都需要显式 `sessionScope`、域名允许清单、个人 profile 访问审批，以及一个可由部署/运行时代码管理的 storage-state 引用。

Slice 5 should add Computer Use as a gated fallback. Acceptance is screenshot redaction before model visibility, action allowlists, risk classification for each action, `WriteAuthority` approval for mutations, and denial by default for unknown apps or origins.

切片 5 应增加 Computer Use 作为受控兜底路径。验收标准是截图在模型可见前脱敏、动作允许清单、每个动作的风险分类、修改动作经过 `WriteAuthority` 审批，以及未知应用或来源默认拒绝。

Slice 6 should define OpenAPI gateway boundaries and preference order without implementing a full gateway in BrowserProvider. Acceptance is route policy that prefers API tools when a matching typed endpoint exists, and only falls back to browser automation after a structured unavailable or unauthorized result.

切片 6 应定义 OpenAPI gateway 边界和优先级，而不是在 BrowserProvider 内实现完整网关。验收标准是当存在匹配的 typed endpoint（带类型端点）时路由策略优先选择 API 工具，并且只有在收到结构化的不可用或未授权结果后才回退到浏览器自动化。

## Linear 映射 / Linear Mapping

`QUI-18` owns BrowserProvider v1, Computer Use gating, OpenAPI gateway boundary definition, deferred tool loading for browser/API surfaces, and the route matrix in this document.

`QUI-18` 负责 BrowserProvider v1、Computer Use gating（计算机使用审批门）、OpenAPI gateway 边界定义、浏览器/API 表面的延迟工具加载，以及本文的路由矩阵。

`QUI-52` owns the shared Tools substrate: `ToolResultV2`, MCP（Model Context Protocol，模型上下文协议）production semantics, structured errors, per-tool timeouts, cancellation, and audit fields shared by browser, API, sandbox, and normal tools.

`QUI-52` 负责共享 Tools substrate（工具基座）：`ToolResultV2`、MCP（Model Context Protocol，模型上下文协议）生产语义、结构化错误、单工具超时、取消，以及浏览器、API、沙箱和普通工具共用的审计字段。

`QUI-21` owns deployment/runtime concerns: browser binary installation, profile storage location, daemon ownership of long-lived sessions, suspend/resume, cloud browser configuration, and platform-specific path isolation.

`QUI-21` 负责部署/运行时事项：浏览器二进制安装、profile 存储位置、守护进程对长生命周期会话的归属、暂停/恢复、云浏览器配置，以及平台路径隔离。

`QUI-62` owns sandbox lifecycle contracts consumed by BrowserProvider: sandbox leases, network policy, mount policy, readiness probes, cleanup deadlines, and structured failure records for browser sessions running inside isolated environments.

`QUI-62` 负责 BrowserProvider 消费的沙箱生命周期契约：沙箱 lease、网络策略、挂载策略、就绪探针、清理截止时间，以及隔离环境内浏览器会话的结构化失败记录。

## 验证门禁 / Verification Gates

Documentation gates for this planning slice are glossary lint and whitespace diff check. Code implementation gates should be added later under the owning issues because this task deliberately avoids runtime code changes.

本文档切片的验证门禁是 glossary lint（术语规则检查）和 whitespace diff check（空白字符差异检查）。代码实现门禁应在后续所属 issue 下添加，因为本任务刻意不修改运行时代码。

Implementation gates for `QUI-18` should include route-policy unit tests, `FetchProvider` SSRF/auth-header regression tests, Playwright MCP namespace-loading tests, browser-use session-scope tests, Computer Use approval/redaction tests, OpenAPI-preference route tests, and audit-record snapshot tests.

`QUI-18` 的实现门禁应包括路由策略单元测试、`FetchProvider` SSRF/认证请求头回归测试、Playwright MCP 命名空间加载测试、browser-use 会话范围测试、Computer Use 审批/脱敏测试、OpenAPI 优先级路由测试，以及审计记录快照测试。

Runtime gates owned by `QUI-21` and `QUI-62` should verify that browser sessions have platform-correct paths, sandbox leases, cleanup deadlines, resumable handles, and honest `needs_replay` states when a session cannot be resumed safely.

`QUI-21` 和 `QUI-62` 负责的运行时门禁应验证浏览器会话具备平台正确路径、沙箱 lease、清理截止时间、可恢复句柄，以及当会话无法安全恢复时诚实进入 `needs_replay`（需要安全重放或人工复核的状态）。

