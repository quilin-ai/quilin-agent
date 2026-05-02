# 工具延后运行时规划 / Tools Runtime Deferred Plan

> English: Linear record: `QUI-18`. This document covers the deferred runtime path for the whole Tools system, not the already separate BrowserProvider implementation plan. It is a planning artifact only; it does not implement TypeScript runtime code, does not start benchmark work, does not create new Linear issues, and does not modify `agent-bridge.md`.
>
> 中文：Linear 记录：`QUI-18`。本文覆盖整个 Tools 系统的 deferred runtime（延后运行时）路径，而不是已有的 BrowserProvider 单点实现计划。本文只是规划产物；不实现 TypeScript 运行时代码，不启动 benchmark（基准测试）工作，不新建 Linear issue，也不修改 `agent-bridge.md`。

## 结论 / Verdict

English: `QUI-18` should remain open after this document because the runtime code is still not implemented. The delivered value here is a bounded contract for the next Tools runtime: browser provider（浏览器提供方，负责选择网页抓取、结构化浏览器自动化或真实会话自动化）, MCP client hardening（Model Context Protocol client hardening，模型上下文协议客户端加固）, CLI-Anything adapter（Command Line Interface Anything adapter，把图形界面软件转成命令行工具的适配器）, OpenAPI gateway（OpenAPI 网关，把有规范的 HTTP API 暴露成受控工具）, Computer Use integration（计算机使用能力集成，通过截图与键鼠动作控制界面）, generic sandbox family（通用沙箱族，用同一接口管理不同隔离后端）, and tool-result contracts（工具结果契约，定义工具输出、错误、预算和审计字段）.

中文：`QUI-18` 在本文完成后仍应保持 open，因为运行时代码尚未实现。本文交付的是下一阶段 Tools runtime 的边界契约：browser provider（浏览器提供方，负责选择网页抓取、结构化浏览器自动化或真实会话自动化）、MCP client hardening（Model Context Protocol client hardening，模型上下文协议客户端加固）、CLI-Anything adapter（Command Line Interface Anything adapter，把图形界面软件转成命令行工具的适配器）、OpenAPI gateway（OpenAPI 网关，把有规范的 HTTP API 暴露成受控工具）、Computer Use integration（计算机使用能力集成，通过截图与键鼠动作控制界面）、generic sandbox family（通用沙箱族，用同一接口管理不同隔离后端），以及 tool-result contracts（工具结果契约，定义工具输出、错误、预算和审计字段）。

English: The implementation order should be contract-first: freeze `ToolResultV2` and the shared policy envelope, then harden MCP and OpenAPI as structured machine interfaces, then add browser and Computer Use providers behind the same gate, then promote sandbox providers as execution backends. BrowserProvider remains one route family inside this runtime; it must not become the policy layer.

中文：实现顺序应是 contract-first（先冻结契约）：先冻结 `ToolResultV2` 与共享策略信封，再加固 MCP 和 OpenAPI 这类结构化机器接口，然后把 browser 与 Computer Use provider 放到同一个 gate 后面，最后把 sandbox provider 提升为执行后端。BrowserProvider 只是这个运行时里的一个路由族；它不应变成策略层本身。

## 范围边界 / Scope Boundary

English: The existing `browser-provider-implementation-plan.md` owns the BrowserProvider v1 route matrix and provider-specific browser slices. This document owns the larger deferred runtime boundary: how tool surfaces are loaded, authorized, executed, isolated, normalized, and audited across browser, MCP, CLI-generated tools, OpenAPI tools, Computer Use, and sandboxes.

中文：已有 `browser-provider-implementation-plan.md` 负责 BrowserProvider v1 路由矩阵和浏览器提供方的具体切片。本文负责更大的 deferred runtime 边界：browser、MCP、CLI 生成工具、OpenAPI 工具、Computer Use 和 sandbox 在加载、授权、执行、隔离、归一化与审计上如何共享一套规则。

English: Runtime code is intentionally out of scope for this task. The acceptance bar for this document is that future implementation issues can use it as a checklist without reopening architecture questions about provider boundaries, ownership, and minimum verification gates.

中文：本任务刻意不写运行时代码。本文的验收标准是：后续实现 issue 可以把它当作 checklist（检查清单），而不需要重新讨论 provider 边界、归属和最低验证门槛。

## 当前事实 / Current Facts

English: The current repo already has a TypeScript `ToolRouter`, a registry path for builtin tools and MCP stdio servers, `web_fetch` with server-side request forgery protection, `WriteAuthority` as the central write gate, and benchmark-only Docker sandbox code. The missing layer is a typed runtime substrate that makes browser actions, MCP calls, generated command-line tools, OpenAPI calls, Computer Use actions, and sandbox execution produce the same policy and result records.

中文：当前仓库已有 TypeScript `ToolRouter`、builtin 工具与 MCP stdio server 的注册路径、带 SSRF（Server-Side Request Forgery，服务端请求伪造）防护的 `web_fetch`、作为中央写入 gate 的 `WriteAuthority`，以及仅服务 benchmark 的 Docker sandbox 代码。缺失层是一套 typed runtime substrate（带类型的运行时基座），让浏览器动作、MCP 调用、生成的命令行工具、OpenAPI 调用、Computer Use 动作和 sandbox 执行都产出同一种策略记录与结果记录。

English: The current `ToolResult` shape is too thin for this runtime. MCP already distinguishes structured content, output schemas, protocol errors, tool execution errors, input validation, rate limits, output sanitization, confirmation, timeouts, and audit expectations. Quilin needs its own host-side result contract because protocol output alone cannot represent local approval, sandbox lease, credential scope, redaction, retryability, and user-facing audit references.

中文：当前 `ToolResult` 形状不足以支撑这个运行时。MCP 已经区分 structured content（结构化内容）、output schema（输出结构约束）、protocol error（协议错误）、tool execution error（工具执行错误）、输入校验、限流、输出清洗、确认、超时和审计要求。Quilin 需要自己的宿主侧结果契约，因为协议输出本身无法表达本地审批、sandbox lease（沙箱租约）、credential scope（凭证范围）、redaction（脱敏）、retryability（是否可重试）和面向用户的审计引用。

## 运行时骨架 / Runtime Spine

English: The deferred Tools runtime should have a single spine: `ToolSurfaceLoader -> ActionEnvelope -> PolicyGate -> ProviderAdapter -> ToolResultV2 -> Observability`. `ToolSurfaceLoader`（工具表面加载器） decides which schemas enter context, `ActionEnvelope`（动作信封） normalizes the requested effect, `PolicyGate` applies safety and write rules, `ProviderAdapter` executes the selected route, `ToolResultV2` normalizes results, and Observability records traceable events.

中文：延后 Tools runtime 应有一条统一骨架：`ToolSurfaceLoader -> ActionEnvelope -> PolicyGate -> ProviderAdapter -> ToolResultV2 -> Observability`。`ToolSurfaceLoader`（工具表面加载器）决定哪些 schema 进入上下文，`ActionEnvelope`（动作信封）标准化请求效果，`PolicyGate` 执行安全与写入规则，`ProviderAdapter` 执行被选中的路径，`ToolResultV2` 归一化结果，Observability 记录可追踪事件。

English: The policy layer must sit above every provider. MCP server metadata, OpenAPI descriptions, CLI-Anything generated manifests, browser page content, and screenshots are useful evidence, but they are not trusted authorization sources unless the host configuration explicitly trusts that source for that purpose.

中文：策略层必须位于每个 provider 之上。MCP server metadata、OpenAPI 描述、CLI-Anything 生成的 manifest、浏览器页面内容和截图都是有用证据，但除非宿主配置明确把某个来源授权为对应用途的可信来源，它们都不是可信授权源。

```text
ToolRouter
  -> ToolSurfaceLoader: deferred schemas, namespace summaries, token budget
  -> ActionEnvelope: actor, effect, target, credential scope, user goal
  -> PolicyGate: WriteAuthority, safety classifier, approval, budget
  -> ProviderAdapter:
       browser | mcp | cli_anything | openapi | computer_use | sandbox
  -> ToolResultV2: structured content, failure, retry, audit, trace
  -> Observability: logs, traces, metrics, Linear evidence references
```

```text
ToolRouter
  -> ToolSurfaceLoader: 延后 schema、命名空间摘要、token 预算
  -> ActionEnvelope: 执行者、效果、目标、凭证范围、用户目标
  -> PolicyGate: WriteAuthority、安全分类器、审批、预算
  -> ProviderAdapter:
       browser | mcp | cli_anything | openapi | computer_use | sandbox
  -> ToolResultV2: 结构化内容、失败、重试、审计、追踪
  -> Observability: 日志、追踪、指标、Linear 证据引用
```

## BrowserProvider 边界 / BrowserProvider Boundary

English: BrowserProvider owns web-page routes, not every external action. It should choose among `FetchProvider`, Playwright MCP（Microsoft Playwright 的模型上下文协议浏览器工具）, browser-use（以真实浏览器会话和认证状态管理见长的浏览器自动化项目）, optional Stagehand spike（小范围验证切片）, and last-resort Computer Use only when the task is actually page or GUI centric.

中文：BrowserProvider 负责网页路由，不负责所有外部动作。它应在 `FetchProvider`、Playwright MCP（Microsoft Playwright 的模型上下文协议浏览器工具）、browser-use（以真实浏览器会话和认证状态管理见长的浏览器自动化项目）、可选 Stagehand spike（小范围验证切片）和最后兜底的 Computer Use 之间选择，但前提是任务确实以网页或图形界面为中心。

English: The runtime must prefer structured routes before visual routes. Public static pages should use fetch; rendered pages should use accessibility-tree automation first; authenticated sessions should use an explicitly scoped browser session; screenshots should supplement structure only when visual layout matters; raw coordinate control should remain last resort.

中文：运行时必须先选结构化路径，再选视觉路径。公开静态页面应使用 fetch；渲染页面应先使用 accessibility tree（无障碍结构树）自动化；已登录会话应使用显式限定范围的浏览器会话；截图只应在视觉布局重要时补充结构化表示；原始坐标控制应保持最后兜底。

English: BrowserProvider must consume sandbox and deployment contracts rather than owning them. Browser binary installation, persistent profile directories, sandbox leases, cloud browser provider configuration, and suspend/resume belong to Deployment/Runtime and Sandbox work; BrowserProvider only records what session and lease it used.

中文：BrowserProvider 必须消费 sandbox 与 deployment 契约，而不是自己拥有这些契约。浏览器二进制安装、持久 profile 目录、sandbox lease、云浏览器 provider 配置和 suspend/resume（暂停/恢复）属于 Deployment/Runtime 与 Sandbox 工作；BrowserProvider 只记录它使用了哪个 session 和 lease。

## MCP 客户端加固 / MCP Client Hardening

English: MCP（Model Context Protocol，模型上下文协议）must be treated as a protocol boundary, not a trust boundary. The latest MCP spec requires capability negotiation, tool listing, structured tool output, output schemas, separate protocol and execution errors, input validation, access control, rate limits, output sanitization, client-side result validation, timeouts, and audit logs.

中文：MCP（Model Context Protocol，模型上下文协议）必须被视为协议边界，而不是信任边界。最新 MCP 规范要求 capability negotiation（能力协商）、工具列表、结构化工具输出、输出 schema、协议错误与执行错误分离、输入校验、访问控制、限流、输出清洗、客户端结果校验、超时和审计日志。

English: The current stdio client hardening should be extended, not replaced. The next runtime slice should keep command and environment allowlists for stdio, then add per-request timeout policy, cancellation notifications, structured failure normalization, server capability digests, `tools/list` pagination, `tools/list_changed` refresh, and output schema validation before any result enters model-visible context.

中文：当前 stdio client 加固应继续扩展，而不是被替换。下一阶段运行时切片应保留 stdio 的命令与环境允许清单，然后增加 per-request timeout policy（按请求超时策略）、取消通知、结构化失败归一化、server capability digest（服务端能力摘要）、`tools/list` 分页、`tools/list_changed` 刷新，以及结果进入模型可见上下文前的输出 schema 校验。

English: Remote MCP over HTTP should stay deferred until OAuth（Open Authorization，开放授权协议）resource binding is implemented. The MCP authorization spec requires OAuth 2.1 resource server behavior, protected resource metadata, resource indicators, token audience validation, and secure token handling; Quilin should reject remote MCP configuration that cannot prove credential scope and target resource.

中文：HTTP 上的远程 MCP 应保持 deferred，直到 OAuth（Open Authorization，开放授权协议）resource binding（资源绑定）实现。MCP authorization 规范要求 OAuth 2.1 resource server 行为、protected resource metadata（受保护资源元数据）、resource indicators（资源指示符）、token audience validation（令牌受众校验）和安全令牌处理；Quilin 应拒绝无法证明凭证范围与目标资源的远程 MCP 配置。

## CLI-Anything 适配器 / CLI-Anything Adapter

English: CLI-Anything（Command Line Interface Anything，把 GUI-only 软件生成为命令行 harness 的项目）should enter Quilin as a quarantined generator plus a validated adapter, not as an unrestricted runtime self-modifier. Generated harnesses must be treated like third-party code until they pass provenance, schema, sandbox, and behavior checks.

中文：CLI-Anything（Command Line Interface Anything，把 GUI-only 软件生成为命令行 harness 的项目）进入 Quilin 时应是 quarantined generator（隔离生成器）加 validated adapter（已验证适配器），而不是无限制的运行时自我修改器。生成的 harness 在通过来源、schema、sandbox 和行为检查前，必须被视作第三方代码。

English: The adapter should accept only harnesses that provide a stable command contract: `--help`, `--json`, deterministic exit codes, machine-readable errors, bounded stdout and stderr, declared file/network effects, declared dependency install steps, and a manifest that can be converted into a `ToolSurfaceLoader` namespace.

中文：该适配器只应接受提供稳定命令契约的 harness：`--help`、`--json`、确定性退出码、机器可读错误、有界 stdout/stderr、声明的文件/网络效果、声明的依赖安装步骤，以及可转换为 `ToolSurfaceLoader` 命名空间的 manifest。

English: Runtime generation should require explicit user approval. Build-time pre-generation can be allowed for known tools, but runtime generation for a new desktop application must run inside a sandbox, produce a diffable artifact, run validation commands, and register only after the user approves the generated tool surface.

中文：运行时生成必须要求用户显式批准。对已知工具可以允许 build-time pre-generation（构建期预生成），但为新的桌面应用运行时生成时，必须在 sandbox 内执行，产出可 diff 的 artifact（产物），运行验证命令，并且只有在用户批准生成的工具表面后才能注册。

## OpenAPI 网关 / OpenAPI Gateway

English: OpenAPI（OpenAPI Specification，用于描述 HTTP API 的规范）gateway should be a first-class machine-interface route. If a task can be completed by a documented, typed HTTP operation, the gateway should beat browser automation because it is cheaper, more deterministic, easier to authorize, and easier to validate.

中文：OpenAPI（OpenAPI Specification，用于描述 HTTP API 的规范）gateway 应是一等 machine-interface route（机器接口路径）。如果任务能通过有文档、有类型的 HTTP 操作完成，网关应优先于浏览器自动化，因为它更便宜、更确定、更容易授权，也更容易校验。

English: The gateway must parse operation methods, parameters, request bodies, response schemas, server origins, and security requirements from the entry OpenAPI document. It should reject specs that cannot bound response sizes, cannot resolve required security schemes, use unsupported authentication, or attempt live mutations without approval metadata.

中文：网关必须从入口 OpenAPI 文档解析 operation method（操作方法）、参数、请求体、响应 schema、server origin（服务来源）和 security requirement（安全要求）。对于无法约束响应大小、无法解析必需安全方案、使用不支持认证方式，或试图在没有审批元数据时执行线上修改的 spec，网关应拒绝。

English: The route policy should classify `GET` and `HEAD` as read candidates, while `POST`, `PUT`, `PATCH`, and `DELETE` require effect classification before execution. Method names are not enough: an unsafe `GET` must still be escalated if the spec or endpoint behavior indicates mutation, export, credential use, or external send.

中文：路由策略应把 `GET` 与 `HEAD` 分类为只读候选，而 `POST`、`PUT`、`PATCH` 和 `DELETE` 必须在执行前做效果分类。方法名本身不够：如果 spec 或端点行为表明会修改、导出、使用凭证或外发数据，即使是不安全的 `GET` 也必须升级风险。

## Computer Use 集成 / Computer Use Integration

English: Computer Use（计算机使用，通过截图观察并执行鼠标键盘动作的能力）should be a local provider behind the same `ActionEnvelope` and `WriteAuthority` path. The OpenAI Agents SDK now models computer use as a host-provided `Computer` implementation with actions such as screenshot, click, scroll, type, wait, move, keypress, and drag; Quilin should use that as a shape reference, not as permission to bypass host policy.

中文：Computer Use（计算机使用，通过截图观察并执行鼠标键盘动作的能力）应是同一 `ActionEnvelope` 和 `WriteAuthority` 路径后的本地 provider。OpenAI Agents SDK 已把 computer use 建模为宿主提供的 `Computer` 实现，动作包括 screenshot、click、scroll、type、wait、move、keypress 和 drag；Quilin 应把这作为形状参考，而不是绕过宿主策略的理由。

English: The first Computer Use integration must support three modes: read-only observe, approved browser fallback, and approved native-app fallback. It must not silently control the user's real desktop. Real desktop access requires app allowlists, screen-region limits, screenshot redaction, credential boundary checks, action budgets, and a visible audit trail.

中文：第一版 Computer Use integration 必须支持三种模式：只读 observe（观察）、已批准的浏览器兜底、已批准的原生应用兜底。它不得静默控制用户真实桌面。真实桌面访问需要 app allowlist（应用允许清单）、屏幕区域限制、截图脱敏、凭证边界检查、动作预算和可见审计链。

English: Screenshots are data exfiltration surfaces. The runtime must redact password fields, one-time-code fields, visible access tokens, payment data, email or chat content outside the approved task, and user-selected privacy rectangles before screenshots are stored, sent to a model, or attached to logs.

中文：截图是 data exfiltration surface（数据外泄表面）。运行时必须在截图被存储、发送给模型或附加到日志前，脱敏密码字段、一次性验证码字段、可见 access token、支付数据、任务授权范围外的邮件或聊天内容，以及用户选择的隐私矩形区域。

## 通用沙箱族 / Generic Sandbox Family

English: Generic sandbox family（通用沙箱族）means one `SandboxRouter` contract with multiple providers, not one universal sandbox. Docker should be the first production provider because the repo already has benchmark Docker evidence; LocalSandbox should remain development-only; gVisor can harden Linux container workloads; Firecracker can cover microVM isolation when hardware virtualization and provider complexity are justified; WebAssembly System Interface can cover narrow deterministic plugin-style execution.

中文：Generic sandbox family（通用沙箱族）指一个 `SandboxRouter` 契约后面挂多个 provider，而不是一个万能沙箱。Docker 应作为第一个 production provider，因为仓库已经有 benchmark Docker 证据；LocalSandbox 应保持 development-only；gVisor 可加固 Linux 容器工作负载；Firecracker 可在硬件虚拟化和 provider 复杂度合理时覆盖 microVM（微型虚拟机）隔离；WebAssembly System Interface 可覆盖窄范围、确定性的插件式执行。

English: The sandbox family must expose the same lifecycle fields regardless of provider: create, execute, install, snapshot, resume, suspend, destroy, network policy, mount policy, resource policy, output policy, lease owner, cleanup deadline, failure kind, trace identifier, and audit reference.

中文：无论 provider 是什么，sandbox family 都必须暴露同一组生命周期字段：create、execute、install、snapshot、resume、suspend、destroy、network policy、mount policy、resource policy、output policy、lease owner、cleanup deadline、failure kind、trace identifier 和 audit reference。

English: Browser and Computer Use tasks should use sandbox only when the target can be safely represented inside that sandbox. A sandboxed browser session is appropriate for public or task-scoped browser work; it is not automatically appropriate for controlling the user's existing personal desktop session.

中文：Browser 与 Computer Use 任务只有在目标能安全表示在该 sandbox 内时才应使用 sandbox。沙箱化浏览器会话适合公开或任务限定的浏览器工作；它并不自动适合控制用户现有的个人桌面会话。

## 工具结果契约 / Tool-Result Contract

English: `ToolResultV2` should be the shared output envelope for all deferred runtime surfaces. It should embed MCP structured content when available, OpenAPI validated response bodies, CLI JSON output, BrowserProvider route records, Computer Use final screenshot references, and Sandbox command results without forcing all providers into a single untyped string.

中文：`ToolResultV2` 应成为所有 deferred runtime surface 的共享输出信封。它应在可用时嵌入 MCP structured content、OpenAPI 校验后的响应体、CLI JSON 输出、BrowserProvider 路由记录、Computer Use 最终截图引用和 Sandbox 命令结果，而不是把所有 provider 强行压成一个无类型字符串。

English: Minimum fields are `schemaVersion`, `toolCallId`, `traceId`, `surface`, `provider`, `operation`, `content`, `structuredContent`, `outputSchemaId`, `isError`, `failure`, `retryable`, `budget`, `latencyMs`, `approval`, `credentialScope`, `redactionProfile`, `sandboxLeaseId`, `auditRef`, and `evidenceRefs`.

中文：最小字段应包括 `schemaVersion`、`toolCallId`、`traceId`、`surface`、`provider`、`operation`、`content`、`structuredContent`、`outputSchemaId`、`isError`、`failure`、`retryable`、`budget`、`latencyMs`、`approval`、`credentialScope`、`redactionProfile`、`sandboxLeaseId`、`auditRef` 和 `evidenceRefs`。

```ts
export interface ToolResultV2 {
  readonly schemaVersion: 2;
  readonly toolCallId: string;
  readonly traceId: string;
  readonly surface:
    | "browser"
    | "mcp"
    | "cli_anything"
    | "openapi"
    | "computer_use"
    | "sandbox"
    | "builtin";
  readonly provider: string;
  readonly operation: string;
  readonly content: readonly ToolContentBlock[];
  readonly structuredContent?: unknown;
  readonly outputSchemaId?: string;
  readonly isError: boolean;
  readonly failure?: ToolFailure;
  readonly retryable: boolean;
  readonly budget: ToolBudgetRecord;
  readonly latencyMs: number;
  readonly approval: ToolApprovalRecord;
  readonly credentialScope?: string;
  readonly redactionProfile: "none" | "secret_safe" | "pii_safe" | "secret_and_pii_safe";
  readonly sandboxLeaseId?: string;
  readonly auditRef: string;
  readonly evidenceRefs: readonly string[];
}
```

```ts
// 中文说明：这个接口是实现目标，不是本任务新增的运行时代码。
// 它让不同工具表面用同一个结果信封携带结构化内容、失败、预算和审计。
```

English: `ToolFailure` should distinguish policy rejection, provider unavailable, authentication missing, authorization denied, timeout, cancellation, rate limit, schema validation failure, output truncation, unsafe output, sandbox failure, browser session failure, and unknown provider error. Recovery logic depends on this taxonomy, so free-form error strings are not acceptable as the only result.

中文：`ToolFailure` 应区分 policy rejection（策略拒绝）、provider unavailable（提供方不可用）、authentication missing（缺少认证）、authorization denied（授权被拒）、timeout（超时）、cancellation（取消）、rate limit（限流）、schema validation failure（结构校验失败）、output truncation（输出截断）、unsafe output（不安全输出）、sandbox failure（沙箱失败）、browser session failure（浏览器会话失败）和 unknown provider error（未知提供方错误）。恢复逻辑依赖这个分类，因此自由文本错误不能作为唯一结果。

## 验收门槛 / Acceptance Gates

English: Browser gates: route-policy tests must prove API-first, fetch-first, structured-browser-first, session-scoped browser-use, and last-resort Computer Use ordering. Session tests must prove approved origins, profile boundaries, screenshot redaction, action budget depletion, and route audit records.

中文：Browser 验收门槛：路由策略测试必须证明 API-first、fetch-first、structured-browser-first、session-scoped browser-use 和 last-resort Computer Use 的优先级。会话测试必须证明已批准 origin、profile 边界、截图脱敏、动作预算扣减和路由审计记录。

English: MCP gates: stdio allowlists must stay in place; per-request timeouts and cancellation must be testable; `tools/list` pagination and `tools/list_changed` refresh must be handled; output schemas must be validated; protocol errors must not be collapsed into tool execution errors; remote HTTP MCP must reject missing OAuth resource binding.

中文：MCP 验收门槛：stdio 允许清单必须保留；按请求超时和取消必须可测试；必须处理 `tools/list` 分页和 `tools/list_changed` 刷新；必须校验输出 schema；协议错误不得塌缩成工具执行错误；远程 HTTP MCP 在缺少 OAuth resource binding 时必须拒绝。

English: CLI-Anything gates: generated harnesses must run inside a sandbox before registration, expose `--json`, pass schema conversion, declare effects, pass smoke validation, produce bounded output, and require approval before any new runtime-generated tool becomes callable.

中文：CLI-Anything 验收门槛：生成的 harness 必须先在 sandbox 内运行再注册，暴露 `--json`，通过 schema 转换，声明效果，通过 smoke validation（冒烟验证），产出有界输出，并且任何运行时新生成工具在可调用前都必须获得批准。

English: OpenAPI gates: spec parsing must resolve operations, server origins, security requirements, request schemas, and response schemas from the entry document. Mutation operations must require approval metadata; response bodies must be size-bounded and schema-validated; credential scopes must match declared security requirements.

中文：OpenAPI 验收门槛：spec 解析必须从入口文档解析 operation、server origin、security requirement、request schema 和 response schema。修改类操作必须要求审批元数据；响应体必须有大小边界并通过 schema 校验；凭证范围必须匹配声明的安全要求。

English: Computer Use gates: read-only observe must be separable from mutating actions; every mutating action must pass `WriteAuthority`; screenshots must be redacted before model visibility; app and domain allowlists must be enforced; unknown windows, origins, or coordinate targets must fail closed.

中文：Computer Use 验收门槛：只读 observe 必须和修改类动作分离；每个修改类动作都必须经过 `WriteAuthority`；截图必须先脱敏再进入模型可见范围；应用和域名允许清单必须执行；未知窗口、origin 或坐标目标必须 fail closed（失败即拒绝）。

English: Sandbox gates: Docker must remain the first production provider; LocalSandbox must be explicitly dev-only; gVisor, Firecracker, WebAssembly System Interface, and hosted providers must enter only as provider-neutral spikes; every provider must report lifecycle, lease, resource, network, mount, output, failure, trace, and audit fields.

中文：Sandbox 验收门槛：Docker 必须保持第一个 production provider；LocalSandbox 必须明确为 dev-only；gVisor、Firecracker、WebAssembly System Interface 和托管 provider 只能作为 provider-neutral spike 进入；每个 provider 都必须报告 lifecycle、lease、resource、network、mount、output、failure、trace 和 audit 字段。

English: Tool-result gates: every deferred surface must return `ToolResultV2` or a compatibility wrapper that can be losslessly upgraded to it. Tests must assert structured content, output schema identifiers, failure taxonomy, retryability, approval linkage, credential scope, redaction profile, and audit references.

中文：工具结果验收门槛：每个 deferred surface 都必须返回 `ToolResultV2`，或返回可无损升级到 `ToolResultV2` 的兼容 wrapper。测试必须断言结构化内容、输出 schema 标识、失败分类、是否可重试、审批链接、凭证范围、脱敏配置和审计引用。

## Linear 映射 / Linear Mapping

English: `QUI-18` owns the Tools runtime deferred path described here, plus the future implementation work for browser provider integration, MCP client hardening surface, OpenAPI gateway routing, Computer Use gating, CLI-Anything adapter boundaries, and the cross-provider acceptance gates. It should not be marked Done until runtime code and tests exist.

中文：`QUI-18` 负责本文描述的 Tools runtime deferred path，以及后续 browser provider integration、MCP client hardening surface、OpenAPI gateway routing、Computer Use gating、CLI-Anything adapter boundary 和跨 provider 验收门槛的实现工作。在运行时代码与测试存在前，它不应标记 Done。

English: `QUI-52` should own shared Tools substrate details such as `ToolResultV2`, structured errors, deferred tool loading, namespace summaries, budget records, and cross-provider audit fields. `QUI-62` should own the runtime `SandboxRouter`. `QUI-21` should own deployment/runtime session ownership, cloud provider configuration, daemon lifecycle, suspend/resume, and hot config.

中文：`QUI-52` 应负责共享 Tools substrate 细节，例如 `ToolResultV2`、结构化错误、延后工具加载、命名空间摘要、预算记录和跨 provider 审计字段。`QUI-62` 应负责运行时 `SandboxRouter`。`QUI-21` 应负责 deployment/runtime session ownership、云 provider 配置、daemon 生命周期、suspend/resume 和 hot config。

English: `QUI-64` should own action-level safety classification and post-tool verification. `QUI-20` should own observability storage, dashboard surfaces, and trace-to-eval links. This document creates no new issue because the Linear workspace is on a free-plan issue cap.

中文：`QUI-64` 应负责动作级安全分类和工具后验证。`QUI-20` 应负责可观测性存储、dashboard surface 和 trace-to-eval 链接。本文不新建 issue，因为当前 Linear workspace 使用免费版 issue 上限。

## 参考资料 / References

English: Official MCP Tools specification, version 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/server/tools. Used for structured content, output schemas, error separation, input validation, access control, rate limits, output sanitization, confirmation, timeouts, and audit expectations.

中文：官方 MCP Tools specification，版本 2025-11-25：https://modelcontextprotocol.io/specification/2025-11-25/server/tools。用于 structured content、output schema、错误分离、输入校验、访问控制、限流、输出清洗、确认、超时和审计要求。

English: Official MCP Lifecycle and Authorization specifications, version 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle and https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization. Used for capability negotiation, per-request timeout, cancellation, OAuth 2.1, protected resource metadata, resource indicators, and token audience validation.

中文：官方 MCP Lifecycle 与 Authorization specification，版本 2025-11-25：https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle 和 https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization。用于 capability negotiation、按请求超时、取消、OAuth 2.1、protected resource metadata、resource indicator 和 token audience validation。

English: OpenAI Agents SDK tools guide: https://openai.github.io/openai-agents-js/guides/tools/. Used for hosted tools, built-in execution tools, deferred tool search, local Computer implementation, approval handling, shell hosted container mode, and tool namespace behavior.

中文：OpenAI Agents SDK tools guide：https://openai.github.io/openai-agents-js/guides/tools/。用于 hosted tools、built-in execution tools、deferred tool search、本地 Computer 实现、审批处理、shell hosted container mode 和 tool namespace 行为。

English: OpenAI Agents SDK sandbox concepts: https://openai.github.io/openai-agents-python/sandbox/guide/. Used for persistent workspace, sandbox-session resume, isolated multi-agent patterns, and sandbox agents exposed as tools.

中文：OpenAI Agents SDK sandbox concepts：https://openai.github.io/openai-agents-python/sandbox/guide/。用于 persistent workspace、sandbox-session resume、隔离 multi-agent pattern 和 sandbox agent as tools。

English: OpenAPI Specification 3.1.1: https://spec.openapis.org/oas/v3.1.1.html. Used for HTTP operation descriptions, JSON Schema 2020-12 alignment, response objects, server origins, and security requirement objects.

中文：OpenAPI Specification 3.1.1：https://spec.openapis.org/oas/v3.1.1.html。用于 HTTP operation 描述、JSON Schema 2020-12 对齐、response object、server origin 和 security requirement object。

English: Playwright MCP snapshots: https://playwright.dev/mcp/snapshots. Used for accessibility snapshot routing, refs, re-snapshot behavior, screenshots only when visual context matters, and dialog handling.

中文：Playwright MCP snapshots：https://playwright.dev/mcp/snapshots。用于 accessibility snapshot 路由、refs、重新 snapshot、只在视觉上下文重要时结合截图，以及 dialog 处理。

English: browser-use authentication docs: https://docs.browser-use.com/open-source/customize/browser/authentication. Used for real browser profiles, storage state persistence, and authenticated automation boundaries.

中文：browser-use authentication docs：https://docs.browser-use.com/open-source/customize/browser/authentication。用于真实浏览器 profile、storage state persistence 和认证自动化边界。

English: HKUDS CLI-Anything repository: https://github.com/HKUDS/CLI-Anything. Used for the command-generation model, validation commands, Codex skill path, and GUI-to-CLI harness framing.

中文：HKUDS CLI-Anything repository：https://github.com/HKUDS/CLI-Anything。用于命令生成模型、验证命令、Codex skill 路径，以及 GUI-to-CLI harness 定位。

English: Docker Engine security docs: https://docs.docker.com/engine/security/. Used for namespaces, control groups, daemon attack surface, capabilities, image trust, AppArmor, SELinux, and user namespaces.

中文：Docker Engine security docs：https://docs.docker.com/engine/security/。用于 namespace、control group、daemon attack surface、capability、image trust、AppArmor、SELinux 和 user namespace。

English: gVisor docs, Firecracker homepage, and WASI interfaces: https://gvisor.dev/docs/, https://firecracker-microvm.github.io/, and https://wasi.dev/interfaces. Used for provider-family boundaries across userspace kernel isolation, microVM isolation, and WebAssembly System Interface execution.

中文：gVisor docs、Firecracker homepage 和 WASI interfaces：https://gvisor.dev/docs/、https://firecracker-microvm.github.io/ 和 https://wasi.dev/interfaces。用于 userspace kernel isolation、microVM isolation 和 WebAssembly System Interface execution 的 provider-family 边界。
