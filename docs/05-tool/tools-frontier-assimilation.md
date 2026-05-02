# 工具前沿吸收报告 / Tools Frontier Assimilation

> Research date: 2026-05-02 in the Asia/Shanghai workspace. Linear record: [QUI-52](https://linear.app/quilin-agent/issue/QUI-52/f0tools-sandboxbrowser-routing-与-mcp-生产语义决策-decide-tools-sandbox). This document does not create new Linear work items; all follow-up recommendations map to QUI-52, QUI-62, QUI-18, or QUI-21.
>
> 调研日期：工作区 Asia/Shanghai 时区 2026-05-02。Linear 记录：[QUI-52](https://linear.app/quilin-agent/issue/QUI-52/f0tools-sandboxbrowser-routing-与-mcp-生产语义决策-decide-tools-sandbox)。本文不创建新的 Linear 工作项；所有后续建议只映射到 QUI-52、QUI-62、QUI-18 或 QUI-21。

## 结论 / Verdict

Quilin's Tools direction remains directionally strong: the current repository already has a TypeScript `ToolRouter`, `MCPRegistry`, stdio MCP client hardening, `WriteAuthority` write gate, `web_fetch` SSRF guard, and a benchmark `DockerSandbox`. The frontier has moved, however, from "can call tools safely" to "can route sandboxed agents, browser providers, MCP production semantics, and computer-use surfaces under one typed policy plane."

Quilin 的 Tools 方向仍然是对的：当前仓库已有 TypeScript `ToolRouter`、`MCPRegistry`、stdio MCP client 加固、`WriteAuthority` 写入权限门、`web_fetch` SSRF 防护，以及 benchmark 用的 `DockerSandbox`。但前沿门槛已经从“能安全调用工具”上移到“能在一个 typed policy plane（带类型的策略平面）下路由沙箱 Agent、浏览器提供方、MCP 生产语义和 computer-use 表面”。

Quilin is not yet the strongest implementation because the runtime surface is still thin: `ToolResult` is only `{ content, isError }`, MCP is stdio-first with fixed timeouts, sandbox support lives in the benchmark harness rather than a reusable `SandboxRouter`, and `BrowserProvider` / `Computer Use` are documented but not implemented.

Quilin 还不是最强实现，因为运行时表面仍然偏薄：`ToolResult` 只有 `{ content, isError }`，MCP 仍以 stdio 为主且超时固定，sandbox 支持还在 benchmark harness 中而不是可复用的 `SandboxRouter`，`BrowserProvider` 与 `Computer Use` 已写在文档里但尚未实现。

The strongest near-term shape is a four-layer Tools substrate: `ToolRouter` as the host policy gate, `SandboxRouter` for isolated workspaces and sandbox-as-tool, `BrowserProvider` for cost-aware browser routing, and `MCPGateway` for identity, budgets, timeouts, tasks, and structured errors.

近期最强形态应是四层 Tools 基座：`ToolRouter` 作为宿主策略 gate，`SandboxRouter` 负责隔离工作区与 sandbox-as-tool（把沙箱 Agent 包成工具），`BrowserProvider` 负责按成本和能力路由浏览器工具，`MCPGateway` 负责 identity（身份）、budget（预算）、timeout（超时）、task（长任务）和 structured error（结构化错误）。

## 术语 / Terms

SandboxAgent（沙箱 Agent）means an agent that owns or receives an isolated workspace with files, shell/code capabilities, permissions, snapshots, and resumable session state.

SandboxAgent（沙箱 Agent）指拥有或接收隔离工作区的 Agent；该工作区包含文件、shell/code 能力、权限、快照和可恢复 session state（会话状态）。

sandbox-as-tool（把沙箱作为工具）means exposing a sandboxed or nested agent run as a callable tool, usually with `max_turns`, approval boundaries, and either a shared read-only session or a separate mutable sandbox.

sandbox-as-tool（把沙箱作为工具）指把一个沙箱内或嵌套 Agent 运行暴露成可调用工具，通常带 `max_turns`（最大回合数）、审批边界，以及共享只读 session 或独立可变 sandbox。

BrowserProvider routing（浏览器提供方路由）means choosing between static fetch, Playwright MCP, browser-use, Stagehand, Skyvern, Steel, and Computer Use based on task class, authentication needs, cost, determinism, and safety.

BrowserProvider routing（浏览器提供方路由）指根据任务类型、认证需求、成本、确定性和安全性，在静态抓取、Playwright MCP、browser-use、Stagehand、Skyvern、Steel 和 Computer Use 之间选择执行路径。

MCP（Model Context Protocol，模型上下文协议）production semantics（生产语义）means the runtime rules around identity, authorization, request budget, timeout, cancellation, long-running tasks, output schemas, structured errors, rate limits, and audit logs.

MCP（Model Context Protocol，模型上下文协议）production semantics（生产语义）指围绕身份、授权、请求预算、超时、取消、长任务、输出 schema、结构化错误、限流和审计日志的运行时规则。

Computer Use（计算机使用）means a model-visible GUI control surface based on screenshots and input actions such as click, type, scroll, keypress, drag, and wait. It should remain a high-cost fallback, not the default browser path.

Computer Use（计算机使用）指模型可见的 GUI 控制面，基于截图与点击、输入、滚动、按键、拖拽、等待等动作。它应作为高成本兜底，而不是默认浏览器路径。

## 来源与可信度 / Sources And Confidence

| Source / 来源 | Confidence / 可信度 | Evidence / 证据 | Quilin implication / 对 Quilin 的含义 |
|---|---:|---|---|
| [MCP lifecycle 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) | High / 高 | Official latest spec page says the lifecycle negotiates versions and capabilities, and recommends configurable request timeouts, cancellation, and max timeout enforcement. | MCP client should move from one fixed timeout to per-request policy, cancellation, and negotiated capability handling. |
| [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | High / 高 | Official spec defines HTTP authorization through OAuth 2.1, Protected Resource Metadata, scope challenges, and Resource Indicators; stdio credentials are expected from environment. | Remote MCP must carry explicit identity and least-privilege scopes; stdio env allowlists are necessary but insufficient for HTTP MCP. |
| [MCP tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | High / 高 | Official spec defines `structuredContent`, `outputSchema`, protocol errors vs tool execution errors, input validation, access controls, rate limits, output sanitization, client timeouts, and audit logs. | `ToolResult` must gain typed output, typed errors, schema validation, rate-limit metadata, and audit fields. |
| [MCP tasks 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) | High but experimental / 高但实验性 | Official spec marks tasks experimental and defines durable task state, `taskSupport`, `ttl`, `pollInterval`, cancellation, and terminal states including failed task when tool result has `isError`. | Long sandbox/browser work should expose a local job handle now and align with MCP Tasks once SDK support is stable. |
| [OpenAI Agents SDK SandboxAgent concepts](https://openai.github.io/openai-agents-python/sandbox/guide/) | High, beta / 高，beta | Official SDK docs describe Sandbox Agents as beta, persistent workspaces, manifests, users, permissions, snapshots, live session injection, resume, and sandbox agents exposed as tools. | QUI-62 should implement session-oriented sandboxing, not only one-shot command execution. |
| [OpenAI Agents SDK tools guide](https://openai.github.io/openai-agents-js/guides/tools/) | High / 高 | Official SDK docs separate hosted tools, local execution tools, agents-as-tools, MCP servers, computer use, shell hosted containers, deferred tool search, approvals, and per-tool timeouts. | Quilin should keep host-controlled execution, add deferred tool loading, and treat Computer Use as a local provider behind approvals. |
| [browser-use GitHub](https://github.com/browser-use/browser-use) and [browser-use authentication docs](https://docs.browser-use.com/open-source/customize/browser/authentication) | High OSS / 高开源 | GitHub shows about 91.5k stars and recent releases; docs cover real Chrome profiles, storage state persistence, TOTP 2FA, allowed domains, and cloud profiles. | browser-use is the best default provider for authenticated, session-heavy browser tasks, but should not be the only provider. |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | High OSS/official / 高开源且官方 | Microsoft repo describes structured accessibility snapshots, no vision model requirement, persistent profiles, isolated storage state, extension mode, HTTP transport, and warns it is not a security boundary. | Playwright MCP should be the low-cost structured browser provider, with a separate sandbox/security boundary outside it. |
| [Browserbase Stagehand](https://github.com/browserbase/stagehand) | High OSS / 高开源 | Repo shows about 22.4k stars and positions Stagehand as code plus natural language browser automation with `act`, `extract`, `agent`, caching, and self-healing. | Stagehand is a strong TypeScript provider for deterministic production workflows and schema-backed extraction. |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | High OSS with license caution / 高开源但注意许可 | Repo shows about 21.5k stars and combines Playwright, LLMs, computer vision, workflows, AI fallback, credential integrations, and 2FA support; license is AGPL-3.0. | Skyvern is best as a provider spike for visually brittle RPA-style sites, not as a core dependency without license review. |
| [Steel Browser](https://github.com/steel-dev/steel-browser) | Medium-high OSS / 中高开源 | Repo shows about 6.9k stars and provides browser sessions, CDP/Puppeteer/Playwright/Selenium access, proxy support, extensions, anti-detection, cleanup, screenshots, PDFs, and self-host/cloud modes. | Steel is an infrastructure provider for cloud browser sessions, proxy/stealth, and debugging, not a replacement for BrowserProvider policy. |
| [Bridging Protocol and Production MCP paper](https://arxiv.org/abs/2603.13417) | Medium research / 中等研究 | The paper proposes identity-scoped routing, adaptive timeout budget allocation, and structured error recovery for production MCP deployments. | Useful as a design prompt, but official MCP spec should remain the contract source. |

| 来源 | 可信度 | 证据 | 对 Quilin 的含义 |
|---|---:|---|---|
| [MCP lifecycle 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) | 高 | 官方最新 spec 说明 lifecycle 会协商版本和 capability，并建议可配置请求超时、取消通知和最大超时。 | MCP client 应从单一固定超时升级为按请求策略、取消和协商 capability。 |
| [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | 高 | 官方 spec 定义 HTTP 授权基于 OAuth 2.1、Protected Resource Metadata、scope challenge 和 Resource Indicators；stdio 凭证来自环境变量。 | 远程 MCP 必须携带显式身份与最小权限 scope；stdio env allowlist 必要但不足以覆盖 HTTP MCP。 |
| [MCP tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | 高 | 官方 spec 定义 `structuredContent`、`outputSchema`、协议错误与工具执行错误、输入校验、访问控制、限流、输出清洗、客户端超时和审计日志。 | `ToolResult` 必须增加 typed output、typed error、schema 校验、限流元数据和审计字段。 |
| [MCP tasks 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) | 高但实验性 | 官方 spec 标明 tasks 仍为实验性，并定义 durable task state、`taskSupport`、`ttl`、`pollInterval`、取消，以及包含 `isError` 时失败的终态。 | 长时间 sandbox/browser 工作现在应先暴露本地 job handle，等 SDK 稳定后对齐 MCP Tasks。 |
| [OpenAI Agents SDK SandboxAgent concepts](https://openai.github.io/openai-agents-python/sandbox/guide/) | 高，beta | 官方 SDK 文档描述 Sandbox Agents 为 beta，包含持久工作区、manifest、用户、权限、快照、live session 注入、恢复，以及沙箱 Agent 作为工具。 | QUI-62 应实现 session-oriented sandboxing（面向会话的沙箱），而不只是一次性命令执行。 |
| [OpenAI Agents SDK tools guide](https://openai.github.io/openai-agents-js/guides/tools/) | 高 | 官方 SDK 文档区分 hosted tools、本地执行工具、agents-as-tools、MCP servers、computer use、hosted shell container、deferred tool search、审批和 per-tool timeout。 | Quilin 应保留宿主控制执行，加入 deferred tool loading，并把 Computer Use 放在审批后的本地 provider 后面。 |
| [browser-use GitHub](https://github.com/browser-use/browser-use) 和 [browser-use authentication docs](https://docs.browser-use.com/open-source/customize/browser/authentication) | 高开源 | GitHub 显示约 91.5k stars 与近期 release；文档覆盖真实 Chrome profile、storage state 持久化、TOTP 2FA、allowed domains 和 cloud profiles。 | browser-use 是认证与 session-heavy 浏览器任务的最佳默认 provider，但不应成为唯一 provider。 |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | 高开源且官方 | Microsoft repo 描述 structured accessibility snapshots、无需 vision model、持久 profile、隔离 storage state、extension 模式、HTTP transport，并提醒它不是安全边界。 | Playwright MCP 应作为低成本结构化浏览器 provider，安全边界应在它之外。 |
| [Browserbase Stagehand](https://github.com/browserbase/stagehand) | 高开源 | Repo 显示约 22.4k stars，并把 Stagehand 定位为 code + natural language 的浏览器自动化，支持 `act`、`extract`、`agent`、缓存和 self-healing。 | Stagehand 是 TypeScript 生产 workflow 与 schema-backed extraction 的强 provider。 |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | 高开源但注意许可 | Repo 显示约 21.5k stars，并结合 Playwright、LLM、computer vision、workflows、AI fallback、credential integrations 和 2FA；许可为 AGPL-3.0。 | Skyvern 适合 visually brittle RPA-style sites（视觉脆弱的 RPA 网站）provider spike，不宜在未做许可 review 前成为核心依赖。 |
| [Steel Browser](https://github.com/steel-dev/steel-browser) | 中高开源 | Repo 显示约 6.9k stars，并提供 browser sessions、CDP/Puppeteer/Playwright/Selenium 接入、proxy、extension、anti-detection、cleanup、screenshot、PDF、自托管/云模式。 | Steel 是 cloud browser session、proxy/stealth 与 debugging 的基础设施 provider，不是 BrowserProvider policy 的替代品。 |
| [Bridging Protocol and Production MCP paper](https://arxiv.org/abs/2603.13417) | 中等研究 | 论文提出 identity-scoped routing、adaptive timeout budget allocation 和 structured error recovery 用于 production MCP。 | 可作为设计提示，但正式契约仍以官方 MCP spec 为准。 |

## 当前差距 / Current Quilin Gaps

The current codebase has the right foundation but misses several production-level contracts. The table below uses local code evidence from `packages/agent-core/src/tools/`, `benchmarks/src/sandbox/`, `docs/05-tool/README.md`, and `docs/09-deployment-runtime/README.md`.

当前代码库有正确地基，但缺少若干 production-level contracts（生产级契约）。下表基于 `packages/agent-core/src/tools/`、`benchmarks/src/sandbox/`、`docs/05-tool/README.md` 和 `docs/09-deployment-runtime/README.md` 的本地证据。

| Area / 领域 | Current Quilin state / 当前状态 | Frontier gap / 前沿差距 | Existing issue / 既有 issue |
|---|---|---|---|
| Tool result contract / 工具结果契约 | `ToolResult` is only `toolCallId`, `content`, and `isError`. | Missing `structuredContent`, `outputSchema`, typed error code, retryability, budget, latency, provider, and audit metadata. | QUI-52, QUI-18 |
| MCP transport / MCP 传输 | `MCPClientManager` supports stdio spawn with command/env/arg hardening. | Missing Streamable HTTP/SSE, OAuth resource identity, scope challenges, per-server auth, reconnect/backoff policy. | QUI-52, QUI-18 |
| MCP timeouts / MCP 超时 | Connect/list use 5s, tool call uses 30s default. | Missing per-tool and per-request timeout policy, cancellation notifications, progress-aware max timeout, and task fallback. | QUI-52, QUI-18 |
| MCP structured errors / MCP 结构化错误 | Client detects `isError` and JSON `error` markers in text. | Missing explicit protocol-vs-execution error mapping, error taxonomy, retry advice, and machine-readable failure payloads. | QUI-52, QUI-18 |
| Sandbox runtime / 沙箱运行时 | Docker sandbox exists in `benchmarks/src/sandbox/docker.ts` with network none, read-only rootfs, CPU/memory/PID/time/output bounds. | Missing runtime `SandboxRouter`, persistent sessions, snapshots, resumable state, install/dependency policy, provider abstraction, and nested sandbox-as-tool. | QUI-62, QUI-21 |
| Sandbox identity / 沙箱身份 | Benchmark sandbox has mounts and command execution, but no user/permission manifest. | Missing per-agent user identity, read-only explorer vs mutator roles, shared session policy, and permission manifest. | QUI-62 |
| Browser routing / 浏览器路由 | `docs/05-tool/README.md` defines BrowserProvider as future target. | Missing implemented providers, route policy, profile/session store, storage-state handling, auth/2FA paths, and per-provider cost model. | QUI-18 |
| Computer Use / 计算机使用 | Documented as low-priority GUI action surface. | Missing local `Computer` adapter, action approval policy, screenshot redaction, sensitive page handling, and fallback routing. | QUI-18, QUI-21 |
| Tool discovery budget / 工具发现预算 | Registry can register builtins and MCP tools, namespaced by server. | Missing deferred tool loading / tool search, namespace-level summaries, per-run tool exposure budgets, and policy-aware discoverability. | QUI-18 |

| 领域 | 当前状态 | 前沿差距 | 既有 issue |
|---|---|---|---|
| 工具结果契约 | `ToolResult` 只有 `toolCallId`、`content` 和 `isError`。 | 缺少 `structuredContent`、`outputSchema`、typed error code、retryability、budget、latency、provider 和 audit metadata。 | QUI-52、QUI-18 |
| MCP 传输 | `MCPClientManager` 支持 stdio spawn，并有 command/env/arg 加固。 | 缺少 Streamable HTTP/SSE、OAuth resource identity、scope challenge、per-server auth、reconnect/backoff policy。 | QUI-52、QUI-18 |
| MCP 超时 | connect/list 为 5s，tool call 默认 30s。 | 缺少 per-tool/per-request timeout policy、取消通知、progress-aware max timeout 和 task fallback。 | QUI-52、QUI-18 |
| MCP 结构化错误 | Client 能识别 `isError` 和文本 JSON 里的 `error` marker。 | 缺少 protocol-vs-execution error 显式映射、错误分类、retry advice 和机器可读失败 payload。 | QUI-52、QUI-18 |
| 沙箱运行时 | `benchmarks/src/sandbox/docker.ts` 已有 Docker sandbox，包含 network none、read-only rootfs、CPU/memory/PID/time/output 限制。 | 缺少 runtime `SandboxRouter`、持久 session、snapshot、resumable state、依赖安装策略、provider 抽象和 nested sandbox-as-tool。 | QUI-62、QUI-21 |
| 沙箱身份 | Benchmark sandbox 有 mount 与命令执行，但没有 user/permission manifest。 | 缺少 per-agent user identity、只读 explorer 与 mutator 角色、共享 session 策略和权限 manifest。 | QUI-62 |
| 浏览器路由 | `docs/05-tool/README.md` 把 BrowserProvider 定义为 future target。 | 缺少已实现 provider、路由策略、profile/session store、storage-state、认证/2FA 路径和 provider 成本模型。 | QUI-18 |
| Computer Use | 文档中作为低优先级 GUI action surface。 | 缺少 local `Computer` adapter、动作审批策略、截图脱敏、敏感页面处理和兜底路由。 | QUI-18、QUI-21 |
| 工具发现预算 | Registry 能注册 builtin 与 MCP tools，并按 server namespace 命名。 | 缺少 deferred tool loading / tool search、namespace summary、per-run tool exposure budget 和 policy-aware discoverability。 | QUI-18 |

## 前沿方案 / Frontier Shape

The next Tools architecture should treat sandbox, browser, and MCP as providers behind one host-controlled policy layer. The host remains responsible for write authorization, identity, budgets, secrets, approvals, observability, and audit.

下一阶段 Tools 架构应把 sandbox、browser 和 MCP 都视为同一个宿主策略层背后的 provider。宿主仍负责写权限、身份、预算、密钥、审批、可观测性和审计。

```text
ToolRouter
  -> PolicyGate: identity, WriteAuthority, budget, timeout, audit
  -> MCPGateway: stdio + HTTP, auth, capabilities, tasks, structured errors
  -> SandboxRouter: local-dev, Docker, hosted/cloud, snapshots, session state
  -> BrowserProvider: fetch, Playwright MCP, browser-use, Stagehand, Skyvern, Steel, Computer Use
```

```text
ToolRouter
  -> PolicyGate: 身份、WriteAuthority、预算、超时、审计
  -> MCPGateway: stdio + HTTP、认证、capability、task、结构化错误
  -> SandboxRouter: local-dev、Docker、hosted/cloud、快照、session state
  -> BrowserProvider: fetch、Playwright MCP、browser-use、Stagehand、Skyvern、Steel、Computer Use
```

SandboxAgent should become a first-class Tools pattern. A parent agent can call a read-only sandbox explorer against the same live session, or call a mutating sandbox worker in a separate sandbox image. This matches OpenAI's beta SandboxAgent composition model and avoids giving every tool the same filesystem rights.

SandboxAgent 应成为 Tools 的一等模式。父 Agent 可以在同一个 live session 中调用只读 sandbox explorer，也可以在独立沙箱镜像里调用可变 sandbox worker。这与 OpenAI beta SandboxAgent composition model 对齐，也避免所有工具拥有相同文件系统权限。

BrowserProvider should not pick one winner. It should use a route matrix: static fetch for cheap read-only pages, Playwright MCP for structured accessibility-tree automation, browser-use for authenticated persistent sessions, Stagehand for TypeScript deterministic workflows, Skyvern for visual/RPA fallback, Steel for hosted browser infrastructure, and Computer Use only when DOM/API/browser automation cannot reach the target.

BrowserProvider 不应只选一个赢家，而应使用路由矩阵：cheap read-only 页面走静态抓取，结构化 accessibility-tree 自动化走 Playwright MCP，认证持久会话走 browser-use，TypeScript 确定性 workflow 走 Stagehand，视觉/RPA 兜底走 Skyvern，hosted browser infrastructure 走 Steel，只有 DOM/API/browser automation 无法触达目标时才走 Computer Use。

MCP should be treated as a protocol, not as the policy boundary. Playwright MCP explicitly says it is not a security boundary; the same principle applies broadly. Quilin must wrap MCP tools with its own identity, budget, timeout, access-control, and structured error layer.

MCP 应被视为协议，而不是策略边界。Playwright MCP 明确说明它不是安全边界；这个原则应推广到所有 MCP 工具。Quilin 必须在 MCP tools 外包一层自己的 identity、budget、timeout、access-control 和 structured error。

## 内化建议 / Assimilation Recommendations

| Priority / 优先级 | Recommendation / 建议 | Why / 原因 | Existing issue / 既有 issue |
|---|---|---|---|
| Must | Define `ToolResultV2` with `content`, `structuredContent`, `outputSchemaId`, `error.kind`, `error.code`, `retryable`, `timeout`, `budget`, `provider`, `latencyMs`, `traceId`, and `auditRef`. | This is the base contract needed for MCP structured output, sandbox failures, browser routing, and deterministic recovery. | QUI-52, QUI-18 |
| Must | Promote benchmark `DockerSandbox` into a runtime `SandboxRouter` interface with `create`, `execute`, `install`, `snapshot`, `resume`, `destroy`, `networkPolicy`, `mounts`, `resourceLimits`, and `structuredFailure`. | Sandbox-as-tool requires persistent, resumable, inspectable sessions instead of one-shot shell execution. | QUI-62, QUI-21 |
| Must | Add sandbox identity and permission manifests: per-agent user, read/write/exec bits, shared-session vs isolated-session policy, and read-only explorer defaults. | OpenAI SandboxAgent's strongest pattern is not just Docker; it is user/permission-scoped agent composition. | QUI-62 |
| Must | Freeze an MCP production contract: stdio + future HTTP transport, OAuth resource identity for HTTP, env-only credential allowlist for stdio, per-tool timeout, cancellation, structured error normalization, and audit logging. | Official MCP spec now covers auth, timeout, structured output, and task patterns that Quilin should not reinvent loosely. | QUI-52, QUI-18 |
| Must | Implement BrowserProvider v1 with `FetchProvider`, `PlaywrightMCPProvider`, and `BrowserUseProvider`; route by `readOnly`, `needsAuth`, `needsInteraction`, `needsSession`, `sensitivePage`, and `costClass`. | These three providers cover the highest-value surface without adopting heavy visual or cloud dependencies too early. | QUI-18 |
| Must | Keep Computer Use behind explicit approval, screenshot redaction, domain/app allowlists, and a "last resort" route reason. | Computer Use is powerful but high-cost and high-risk; it should not replace structured browser automation. | QUI-18, QUI-21 |
| Should | Add per-run and per-tool budgets: token budget, wall-clock budget, output byte budget, retry budget, provider spend budget, and concurrency budget. | MCP spec requires rate limiting and timeouts, while production agents need explicit cost and resource accounting. | QUI-52, QUI-18 |
| Should | Add long-running task handles for sandbox/browser work now, then map them to MCP Tasks when SDK support stabilizes. | MCP Tasks are experimental but point to the right durable job model for expensive tool calls. | QUI-52, QUI-18 |
| Should | Add deferred tool loading and namespace summaries for large tool surfaces. | OpenAI tool search and Playwright MCP's CLI-vs-MCP note both reinforce that loading every tool schema is too expensive. | QUI-18 |
| Should | Build a browser session store with Playwright storage state, real Chrome profile import, cloud profile adapters, TOTP placeholders, and domain-scoped credentials. | browser-use and Playwright MCP both show session state is the difference between toy browsing and production browsing. | QUI-18, QUI-21 |
| Could | Spike Stagehand as the TypeScript production workflow provider. | Its `act`/`extract`/`agent` model and caching/self-healing fit repeatable operational workflows. | QUI-18 |
| Could | Spike Skyvern as a visual/RPA fallback, with license review before dependency adoption. | It is strong for visually unstable workflows but AGPL-3.0 changes integration constraints. | QUI-18 |
| Could | Spike Steel as browser infrastructure for hosted sessions, proxy, stealth, and debug UI. | It solves browser infrastructure concerns that Quilin should not rebuild immediately. | QUI-18, QUI-21 |
| Could | Evaluate OpenAI hosted container shell, E2B, Modal, and Daytona as cloud sandbox providers under the same `SandboxRouter` interface. | Provider neutrality keeps Quilin from hard-coding a sandbox vendor too early. | QUI-62, QUI-21 |

| 优先级 | 建议 | 原因 | 既有 issue |
|---|---|---|---|
| Must | 定义 `ToolResultV2`，包含 `content`、`structuredContent`、`outputSchemaId`、`error.kind`、`error.code`、`retryable`、`timeout`、`budget`、`provider`、`latencyMs`、`traceId` 和 `auditRef`。 | 这是 MCP structured output、sandbox failure、browser routing 和 deterministic recovery 的基础契约。 | QUI-52、QUI-18 |
| Must | 把 benchmark `DockerSandbox` 提升为 runtime `SandboxRouter` 接口，覆盖 `create`、`execute`、`install`、`snapshot`、`resume`、`destroy`、`networkPolicy`、`mounts`、`resourceLimits` 和 `structuredFailure`。 | sandbox-as-tool 需要持久、可恢复、可检查 session，而不是一次性 shell execution。 | QUI-62、QUI-21 |
| Must | 增加 sandbox identity 与 permission manifest：per-agent user、read/write/exec bits、shared-session vs isolated-session policy，以及只读 explorer 默认值。 | OpenAI SandboxAgent 的强点不只是 Docker，而是 user/permission-scoped agent composition。 | QUI-62 |
| Must | 冻结 MCP 生产契约：stdio + future HTTP transport、HTTP 的 OAuth resource identity、stdio 的 env-only credential allowlist、per-tool timeout、取消、结构化错误归一化和审计日志。 | 官方 MCP spec 已覆盖 auth、timeout、structured output 和 task pattern，Quilin 不应松散重造。 | QUI-52、QUI-18 |
| Must | 实现 BrowserProvider v1：`FetchProvider`、`PlaywrightMCPProvider` 和 `BrowserUseProvider`；按 `readOnly`、`needsAuth`、`needsInteraction`、`needsSession`、`sensitivePage` 和 `costClass` 路由。 | 这三个 provider 覆盖最高价值表面，又不必过早引入重型视觉或云依赖。 | QUI-18 |
| Must | Computer Use 必须放在显式审批、截图脱敏、domain/app allowlist 和“last resort”路由理由之后。 | Computer Use 能力强但成本高、风险高；不应替代结构化浏览器自动化。 | QUI-18、QUI-21 |
| Should | 增加 per-run 与 per-tool budget：token、wall-clock、output byte、retry、provider spend 和 concurrency budget。 | MCP spec 要求限流和超时，而 production agents 需要显式成本与资源核算。 | QUI-52、QUI-18 |
| Should | 现在先为 sandbox/browser 长任务增加本地 task handle，等 SDK 稳定后映射到 MCP Tasks。 | MCP Tasks 仍是实验性，但它指向昂贵工具调用所需的 durable job model。 | QUI-52、QUI-18 |
| Should | 为大型工具面增加 deferred tool loading 与 namespace summary。 | OpenAI tool search 与 Playwright MCP 的 CLI-vs-MCP 注释都说明一次性加载所有 schema 成本过高。 | QUI-18 |
| Should | 建立 browser session store，支持 Playwright storage state、真实 Chrome profile import、cloud profile adapters、TOTP placeholder 和 domain-scoped credentials。 | browser-use 与 Playwright MCP 都显示 session state 是 toy browsing 与 production browsing 的分界线。 | QUI-18、QUI-21 |
| Could | Spike Stagehand 作为 TypeScript production workflow provider。 | 它的 `act`/`extract`/`agent` 模型以及 caching/self-healing 适合可重复运营 workflow。 | QUI-18 |
| Could | Spike Skyvern 作为 visual/RPA fallback，并在采用依赖前做 license review。 | 它适合视觉不稳定 workflow，但 AGPL-3.0 会改变集成约束。 | QUI-18 |
| Could | Spike Steel 作为 hosted session、proxy、stealth 和 debug UI 的 browser infrastructure。 | 它解决 Quilin 不应立即重建的浏览器基础设施问题。 | QUI-18、QUI-21 |
| Could | 在同一 `SandboxRouter` 接口下评估 OpenAI hosted container shell、E2B、Modal 和 Daytona 作为 cloud sandbox providers。 | Provider neutrality（提供方中立）避免 Quilin 过早绑定沙箱供应商。 | QUI-62、QUI-21 |

## 路由矩阵 / Routing Matrix

Browser and computer tools should be selected by task semantics, not by project popularity. The default route should minimize cost and risk while preserving enough capability to finish the task.

浏览器与 computer tools 应按任务语义选择，而不是按项目名气选择。默认路由应在保留完成能力的同时最小化成本和风险。

| Task signal / 任务信号 | Preferred route / 首选路径 | Fallback / 兜底 | Issue / Issue |
|---|---|---|---|
| Static public page, read-only / 静态公开页面，只读 | `web_fetch` or `FetchProvider` | Playwright MCP if rendering is needed | QUI-18 |
| Interactive page, no login / 交互页面，无登录 | Playwright MCP accessibility snapshot | Stagehand if repeatable workflow is needed | QUI-18 |
| Authenticated personal session / 已登录个人会话 | browser-use real Chrome profile or Playwright MCP extension mode | browser-use storage state / cloud profile | QUI-18, QUI-21 |
| Production repeatable workflow / 生产可重复 workflow | Stagehand code + natural language | browser-use or Playwright MCP | QUI-18 |
| Visually brittle RPA site / 视觉脆弱 RPA 站点 | Skyvern-style visual provider | Computer Use with approval | QUI-18 |
| Cloud browser with stealth/proxy/debug / 云浏览器、隐身、代理、调试 | Steel or Browserbase-style infrastructure provider | Self-hosted Playwright service | QUI-18, QUI-21 |
| Non-browser GUI or canvas-only target / 非浏览器 GUI 或纯 canvas 目标 | Computer Use provider | Human handoff | QUI-18, QUI-21 |

| 任务信号 | 首选路径 | 兜底 | Issue |
|---|---|---|---|
| 静态公开页面，只读 | `web_fetch` 或 `FetchProvider` | 如果需要渲染再走 Playwright MCP | QUI-18 |
| 交互页面，无登录 | Playwright MCP accessibility snapshot | 如果是可重复 workflow，走 Stagehand | QUI-18 |
| 已登录个人会话 | browser-use real Chrome profile 或 Playwright MCP extension mode | browser-use storage state / cloud profile | QUI-18、QUI-21 |
| 生产可重复 workflow | Stagehand code + natural language | browser-use 或 Playwright MCP | QUI-18 |
| 视觉脆弱 RPA 站点 | Skyvern-style visual provider | 带审批的 Computer Use | QUI-18 |
| 云浏览器、隐身、代理、调试 | Steel 或 Browserbase-style infrastructure provider | 自托管 Playwright service | QUI-18、QUI-21 |
| 非浏览器 GUI 或纯 canvas 目标 | Computer Use provider | Human handoff（人工接管） | QUI-18、QUI-21 |

## 不建议 / Anti-Recommendations

Do not make browser-use the only browser route. It is strongest for authenticated, session-heavy tasks, but Playwright MCP is cheaper for structured pages, Stagehand is stronger for TypeScript repeatable workflows, and Computer Use should remain a last resort.

不要把 browser-use 设成唯一浏览器路径。它在认证与重会话任务上最强，但结构化页面用 Playwright MCP 更便宜，TypeScript 可重复 workflow 用 Stagehand 更强，Computer Use 应只做最后兜底。

Do not treat MCP server configuration as authorization. MCP is the protocol boundary; Quilin still needs host-side identity, tool allowlists, budget enforcement, output validation, and audit.

不要把 MCP server 配置当成授权。MCP 是协议边界；Quilin 仍需要宿主侧 identity、tool allowlist、budget enforcement、output validation 和 audit。

Do not promote LocalSandbox to production. It may remain useful for trusted local development, but production sandboxing should be Docker or a stronger provider with explicit network, filesystem, resource, and lifecycle controls.

不要把 LocalSandbox 提升为生产方案。它可以继续用于可信本地开发，但生产沙箱应是 Docker 或更强 provider，并具备明确的网络、文件系统、资源和生命周期控制。

Do not let Computer Use bypass `WriteAuthority`. GUI actions can mutate state as surely as shell/file tools, so high-impact actions need the same approval and audit discipline.

不要让 Computer Use 绕过 `WriteAuthority`。GUI action 与 shell/file tools 一样会改变状态，因此高影响动作需要同样的审批与审计纪律。

## 下一步 / Next Steps

QUI-52 should record this decision: Quilin's Tools plan remains frontier-aligned if it upgrades from tool-call plumbing to a policy-first Tools substrate with `ToolResultV2`, `SandboxRouter`, `BrowserProvider`, and MCP production semantics.

QUI-52 应记录此决策：如果 Quilin 从 tool-call plumbing（工具调用接线）升级到 policy-first Tools substrate（策略优先工具基座），并包含 `ToolResultV2`、`SandboxRouter`、`BrowserProvider` 与 MCP production semantics，那么 Tools 方案仍与前沿对齐。

QUI-62 should absorb the SandboxRouter and production DockerSandbox work first, because browser/computer-use and sandbox-as-tool both need the same session, resource, network, output, and structured failure model.

QUI-62 应优先吸收 SandboxRouter 与 production DockerSandbox 工作，因为 browser/computer-use 与 sandbox-as-tool 都依赖同一套 session、resource、network、output 和 structured failure model。

QUI-18 should own BrowserProvider v1, Computer Use gating, deferred tool loading, and MCP HTTP/tool-surface expansion. QUI-21 should own deployment/runtime lifecycle, hot config, daemon session ownership, sandbox suspend/resume, and cloud provider configuration.

QUI-18 应负责 BrowserProvider v1、Computer Use gating、deferred tool loading 和 MCP HTTP/tool-surface 扩展。QUI-21 应负责 deployment/runtime lifecycle、hot config、daemon session ownership、sandbox suspend/resume 和 cloud provider configuration。
