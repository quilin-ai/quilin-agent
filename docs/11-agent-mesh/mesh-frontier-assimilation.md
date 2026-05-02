# Agent Mesh 前沿吸收报告 / Agent Mesh Frontier Assimilation

> Research snapshot: 2026-05-02 Asia/Shanghai. Linear task: [QUI-54](https://linear.app/quilin-agent/issue/QUI-54/f0agent-mesha2a-v1-与-mcp-streamable-http-决策-decide-agent-mesh-a2a-v1).
>
> 调研快照：2026-05-02（Asia/Shanghai）。Linear 任务：[QUI-54](https://linear.app/quilin-agent/issue/QUI-54/f0agent-mesha2a-v1-与-mcp-streamable-http-决策-decide-agent-mesh-a2a-v1)。

## 结论 / Conclusion

Agent Mesh remains the right component direction only if Quilin narrows the first implementation slice to a local-first interoperability layer. The strongest current path is not a custom daemon-first LAN mesh. It is a `MeshClient`（本机优先 Agent Mesh 客户端：在本机进程内提供发现、请求、收件队列和安全检查的 SDK/运行时边界） that speaks current A2A v1（Agent2Agent，一种 Linux Foundation 托管的 Agent 互操作协议） concepts, publishes an Agent Card（Agent 能力名片：声明身份、能力、协议入口和安全要求的 JSON 文档）, and can bridge MCP Streamable HTTP（Model Context Protocol 的 HTTP 流式传输：用 POST/GET 和可选 Server-Sent Events 承载远程 MCP 会话） without exposing memory or tools by default.

Agent Mesh 方向仍然成立，但 Quilin 的第一实现切片必须收窄为“本机优先的互操作层”。当前最强路径不是先做自定义 daemon-first LAN mesh（先写守护进程和局域网组网的方案），而是先做 `MeshClient`（本机优先 Agent Mesh 客户端：在本机进程内提供发现、请求、收件队列和安全检查的 SDK/运行时边界），吸收 A2A v1（Agent2Agent，一种 Linux Foundation 托管的 Agent 互操作协议）概念，发布 Agent Card（Agent 能力名片：声明身份、能力、协议入口和安全要求的 JSON 文档），并能桥接 MCP Streamable HTTP（Model Context Protocol 的 HTTP 流式传输：用 POST/GET 和可选 Server-Sent Events 承载远程 MCP 会话），同时默认不暴露 memory（记忆）或 tools（工具）。

The recommendation is to explicitly defer LAN/mDNS（局域网/Multicast DNS 自动发现：通过本地链路广播发现服务的机制） to `QUI-10`. A2A v1 already standardizes web-first Agent Card discovery through well-known URLs, registries, and direct configuration, while MCP's latest transport guidance strongly favors localhost binding and explicit auth for local HTTP servers. mDNS is useful later, but it adds privacy, trust, and network-debug surface before Quilin has a stable local identity, permission, and audit story.

建议明确把 LAN/mDNS（局域网/Multicast DNS 自动发现：通过本地链路广播发现服务的机制）推迟到 `QUI-10`。A2A v1 已经通过 well-known URL（标准约定路径）、registry（目录/注册表）和 direct configuration（直接配置）标准化了 web-first Agent Card discovery（基于 Web 的 Agent 能力名片发现）；MCP 最新 transport（传输层）规范也强调本地 HTTP server（HTTP 服务）应绑定 localhost（本机回环地址）并具备显式认证。mDNS 后续有价值，但在 Quilin 的本机 identity（身份）、permissions（权限）和 audit（审计）尚未稳定前，会过早引入隐私、信任和网络调试复杂度。

## 调研方法 / Research Method

I used primary or first-party sources first: the A2A v1 specification and releases, MCP 2025-11-25 specification and security guidance, Linux Foundation project pages, GitHub repository metadata, and official docs for Agentgateway and AGNTCY. GitHub stars and release dates below were checked with authenticated `gh` commands on 2026-05-02 where available.

我优先使用官方或一手来源：A2A v1 specification（规范）与 releases（发布记录）、MCP 2025-11-25 specification（规范）与安全指南、Linux Foundation 项目页面、GitHub 仓库元数据，以及 Agentgateway 和 AGNTCY 的官方文档。下方 GitHub stars（星标数）和 release dates（发布时间）在 2026-05-02 通过已认证 `gh` 命令核验。

I also verified local Quilin state before writing this report. Evidence: `crates/mesh-sdk/src/lib.rs` is 26 lines and only declares a marker trait; `rg` finds `MeshClient`, A2A, Agent Card, mDNS, and `meshd` only in docs/design material, not in runtime implementation; `rg` finds no implemented MCP Streamable HTTP headers such as `MCP-Session-Id` or `MCP-Protocol-Version` under `packages/agent-core`.

写入本报告前也做了 Quilin 本地状态实证。证据：`crates/mesh-sdk/src/lib.rs` 只有 26 行，并且只声明 marker trait（标记 trait）；`rg` 只在 docs/design（文档/设计材料）里找到 `MeshClient`、A2A、Agent Card、mDNS 和 `meshd`，没有找到 runtime implementation（运行时实现）；`rg` 在 `packages/agent-core` 下没有找到已实现的 MCP Streamable HTTP 头，如 `MCP-Session-Id` 或 `MCP-Protocol-Version`。

## 来源与可信度 / Sources And Credibility

| Source / 来源 | What it proves / 证明内容 | Credibility / 可信度 | Quilin use / Quilin 用法 |
|---|---|---:|---|
| [A2A spec latest](https://a2a-protocol.org/dev/specification/) | Latest released A2A version is 1.0.0; Agent Card discovery uses `/.well-known/agent-card.json`, registries/catalogs, and direct configuration; A2A supports JSON-RPC, HTTP+JSON, and gRPC（Google Remote Procedure Call，一种基于 HTTP/2 的强类型 RPC 协议） bindings. / 最新 A2A 发布版是 1.0.0；Agent Card 通过 `/.well-known/agent-card.json`、目录/注册表和直接配置发现；A2A 支持 JSON-RPC、HTTP+JSON 和 gRPC（Google Remote Procedure Call，一种基于 HTTP/2 的强类型 RPC 协议）绑定。 | High, official spec / 高，官方规范 | Use as the Agent Card and peer-agent protocol source of truth. / 作为 Agent Card 与 peer-agent（同伴 Agent）协议真相源。 |
| [A2A v1.0.0 GitHub release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0) | v1.0.0 shipped 2026-03-12 with multi-protocol support, v1 breaking changes, OAuth modernization, multi-tenancy, and protobuf cleanup. / v1.0.0 于 2026-03-12 发布，包含多协议支持、v1 breaking changes（破坏性变更）、OAuth 现代化、多租户和 protobuf 清理。 | High, official release / 高，官方发布 | Pin F1 design to A2A v1, not older v0.2.x examples. / F1 设计对齐 A2A v1，而不是旧 v0.2.x 示例。 |
| [A2A and MCP comparison](https://a2a-protocol.org/dev/topics/a2a-and-mcp/) | A2A is for agent-to-agent task collaboration; MCP is for agent-to-tool/resource integration; they are complementary. / A2A 面向 Agent 之间的任务协作；MCP 面向 Agent 使用工具/资源；两者互补。 | High, official docs / 高，官方文档 | Keep Mesh as peer-agent interop; keep MCP in Tool layer for tools. / Mesh 负责 peer-agent 互操作；MCP 仍主要归工具层。 |
| [A2A SDK page](https://a2a-protocol.org/dev/sdk/) and [A2A GitHub org](https://github.com/a2aproject) | Official SDKs exist for Python, Go, Java, JavaScript/TypeScript, C#/.NET, and Rust; repo snapshot: `a2aproject/A2A` 23,538 stars, `a2a-python` 1,873, `a2a-js` 527, `a2a-samples` 1,545. / 官方 SDK 覆盖 Python、Go、Java、JavaScript/TypeScript、C#/.NET 和 Rust；仓库快照：`a2aproject/A2A` 23,538 stars，`a2a-python` 1,873，`a2a-js` 527，`a2a-samples` 1,545。 | High, official docs and GitHub / 高，官方文档与 GitHub | Prefer official SDK/schema reuse over hand-rolled protocol objects. / 优先复用官方 SDK/schema，而不是手写协议对象。 |
| [MCP 2025-11-25 base spec](https://modelcontextprotocol.io/specification/2025-11-25/basic) | Latest MCP version is 2025-11-25; all implementations must support base protocol and lifecycle; auth is for HTTP-based transport. / 最新 MCP 版本是 2025-11-25；实现必须支持基础协议和 lifecycle（生命周期）；auth（认证/授权）面向 HTTP 传输。 | High, official spec / 高，官方规范 | Align terminology and versioning for remote MCP. / 对齐远程 MCP 的术语和版本。 |
| [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | Streamable HTTP replaces older HTTP+SSE; it uses one endpoint, POST/GET, optional SSE（Server-Sent Events，服务器向客户端推送事件的 HTTP 流机制）, session IDs, and protocol version headers; local servers should bind localhost and validate Origin. / Streamable HTTP 取代旧 HTTP+SSE；使用单 endpoint、POST/GET、可选 SSE（Server-Sent Events，服务器向客户端推送事件的 HTTP 流机制）、session ID 和协议版本头；本地 server 应绑定 localhost 并校验 Origin。 | High, official spec / 高，官方规范 | Implement only local/loopback first; remote requires explicit auth and SSRF controls. / 先实现本机/回环；远程必须显式 auth 和 SSRF 控制。 |
| [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) | HTTP auth is OAuth 2.1 based; token audience validation is mandatory; token passthrough is forbidden; local MCP server setup must require clear user consent and sandboxing. / HTTP auth 基于 OAuth 2.1；token audience（令牌受众）校验是强要求；禁止 token passthrough（令牌透传）；本地 MCP server 配置必须有清晰用户同意和沙箱。 | High, official spec/docs / 高，官方规范/文档 | Map mesh tool exposure through existing `WriteAuthority` and audit trail. / 将 mesh 工具暴露映射到现有 `WriteAuthority` 和审计链路。 |
| [MCP 2026 roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) | Transport scalability, agent communication, metadata via `.well-known`, and enterprise readiness are active MCP priorities; no additional official transport is planned this cycle. / 传输扩展性、Agent communication（Agent 通信）、`.well-known` 元数据和企业就绪是 MCP 2026 重点；本周期不计划增加更多官方 transport。 | High, official maintainer blog / 高，官方维护者博客 | Do not invent a competing MCP transport for Mesh. / 不为 Mesh 发明竞争性 MCP 传输。 |
| [Agentgateway GitHub](https://github.com/agentgateway/agentgateway) and [Agentgateway docs](https://agentgateway.dev/docs/standalone/latest/about/introduction/) | Agentgateway is a Linux Foundation open-source agentic proxy for MCP/A2A with auth, RBAC（Role-Based Access Control，基于角色的访问控制）, CEL policy, rate limiting, TLS, and OpenTelemetry; repo snapshot: 2,565 stars, v1.1.0 on 2026-04-09. / Agentgateway 是 Linux Foundation 托管的开源 agentic proxy（Agent 流量代理），面向 MCP/A2A，提供 auth、RBAC（Role-Based Access Control，基于角色的访问控制）、CEL policy、限流、TLS 和 OpenTelemetry；仓库快照：2,565 stars，2026-04-09 发布 v1.1.0。 | High for project facts; medium for product claims / 项目事实高，产品自述中 | Assimilate gateway control-plane patterns, not as F1 dependency. / 吸收 gateway 控制面模式，不作为 F1 依赖。 |
| [AGNTCY identity docs](https://docs.agntcy.org/identity/creating_identities/) and [AGNTCY directory docs](https://docs.agntcy.org/dir/hosted-agent-directory/) | AGNTCY models identities, badges, directory records, A2A card modules, MCP server modules, and Sigstore signing; `agntcy/dir` snapshot: 151 stars, v1.2.0 on 2026-04-15. / AGNTCY 建模 identity（身份）、badge（发现凭证）、directory record（目录记录）、A2A card module、MCP server module 和 Sigstore 签名；`agntcy/dir` 快照：151 stars，2026-04-15 发布 v1.2.0。 | Medium-high, first-party but smaller adoption / 中高，一手但采用度较小 | Borrow registry metadata concepts for later; keep local-first now. / 借鉴 registry 元数据概念，当前仍保持本机优先。 |
| [RFC 6762 mDNS](https://datatracker.ietf.org/doc/html/rfc6762.html) and [RFC 8882 DNS-SD privacy/security](https://www.ietf.org/ietf-ftp/rfc/rfc8882.html) | mDNS is local-link multicast DNS; DNS-SD over mDNS exposes offering/requesting identities and service information, which can breach privacy. / mDNS 是本地链路 multicast DNS；DNS-SD over mDNS 会暴露服务提供方/请求方身份和服务信息，可能造成隐私泄露。 | High, IETF standards / 高，IETF 标准 | Defer LAN/mDNS until identity and trust UX are ready. / identity 和 trust UX 稳定前推迟 LAN/mDNS。 |

## Quilin 当前差距 / Current Quilin Gaps

The current Agent Mesh implementation is intentionally not a runtime. `crates/mesh-sdk/src/lib.rs` is 26 lines and contains only a Rust marker trait, while `docs/11-agent-mesh/README.md` states that Agent Mesh runtime, `MeshClient`, A2A/Agent Card, mDNS/LAN discovery, and gRPC/HTTP SSE bridge are not connected to Quilin runtime.

当前 Agent Mesh 实现有意不是 runtime（运行时）。`crates/mesh-sdk/src/lib.rs` 只有 26 行，并且只包含 Rust marker trait（标记 trait）；`docs/11-agent-mesh/README.md` 明确说明 Agent Mesh runtime、`MeshClient`、A2A/Agent Card、mDNS/LAN discovery 和 gRPC/HTTP SSE bridge 均未接入 Quilin runtime。

The current Agent Card draft in `docs/11-agent-mesh/README.md` is closer to the historical AgentMesh design than to A2A v1. A2A v1 expects a top-level Agent Card with `supportedInterfaces`, `capabilities`, `securitySchemes`, `security`, input/output modes, skills, versioning, caching, and optional JWS/JCS signatures. Quilin's current YAML sketch uses an `agent:` wrapper, `runtime`, `visibility`, and `pubkey` fields that are useful locally but not A2A-v1 canonical.

当前 `docs/11-agent-mesh/README.md` 里的 Agent Card 草案更接近历史 AgentMesh 设计，而不是 A2A v1。A2A v1 期望顶层 Agent Card 包含 `supportedInterfaces`、`capabilities`、`securitySchemes`、`security`、输入/输出模式、skills、versioning、caching，以及可选 JWS/JCS signatures（签名）。Quilin 当前 YAML 草案使用 `agent:` 包裹、`runtime`、`visibility` 和 `pubkey` 字段，这些对本机有用，但不是 A2A v1 canonical（规范形态）。

The current protocol shape is also too custom. The historical AgentMesh doc defines an envelope, `mesh.send`, `mesh.request`, rooms, topics, mDNS, and federation before pinning A2A v1 semantics. A2A v1 already gives Quilin request, streaming, task state, push notification, version header, and protocol-binding vocabulary. Quilin should avoid creating an incompatible parallel protocol unless it is only adapter-local metadata.

当前协议形状也过于自定义。历史 AgentMesh 文档先定义 envelope、`mesh.send`、`mesh.request`、rooms（房间）、topics（主题）、mDNS 和 federation（联邦），再 loosely（松散地）提到 A2A。A2A v1 已经提供 request（请求）、streaming（流式）、task state（任务状态）、push notification（推送通知）、version header（版本头）和 protocol binding（协议绑定）词汇。除非只是 adapter-local metadata（适配器本地元数据），Quilin 应避免创建不兼容的平行协议。

MCP Streamable HTTP is not implemented. `docs/05-tool/README.md` has a planning pseudocode transport string `"stdio" | "sse" | "http"`, but `rg` finds no runtime support for `MCP-Session-Id`, `MCP-Protocol-Version`, Streamable HTTP POST/GET behavior, or remote MCP authorization.

MCP Streamable HTTP 尚未实现。`docs/05-tool/README.md` 只有规划伪代码里的 `"stdio" | "sse" | "http"` transport 字符串；`rg` 没有找到 `MCP-Session-Id`、`MCP-Protocol-Version`、Streamable HTTP POST/GET 行为或 remote MCP authorization（远程 MCP 授权）的 runtime 支持。

Security foundations exist but are not wired to Mesh. Quilin already has `WriteAuthority`（写权限门：所有 Agent 发起写入进入工具沙箱前必须经过的运行时执行器）, SSRF（Server-Side Request Forgery，服务端请求伪造） guards, structured logs, and OTel-like spans. Agent Mesh must reuse these instead of introducing a separate permission/audit path.

安全基础已经存在，但还没有接到 Mesh。Quilin 已经有 `WriteAuthority`（写权限门：所有 Agent 发起写入进入工具沙箱前必须经过的运行时执行器）、SSRF（Server-Side Request Forgery，服务端请求伪造）防护、结构化日志和近似 OTel（OpenTelemetry，一套可观测性遥测标准）的 spans（追踪片段）。Agent Mesh 必须复用这些能力，不能引入另一套权限/审计路径。

## 领域吸收判断 / Frontier Assimilation Findings

### A2A v1 是同伴协议主线 / A2A v1 Is The Peer Protocol Backbone

A2A v1 is now stable enough to be Quilin's external agent interoperability target. Its strongest fit is the Agent Card, protocol binding declaration, streaming/task lifecycle, and authenticated extended-card model. For Quilin, the key move is to make local `MeshClient.discover()` return A2A-shaped Agent Cards even before remote network discovery exists.

A2A v1 现在已经足够稳定，可以作为 Quilin 的外部 Agent 互操作目标。它最适合 Quilin 吸收的是 Agent Card、protocol binding declaration（协议绑定声明）、streaming/task lifecycle（流式与任务生命周期）和 authenticated extended-card（认证后扩展能力名片）模型。对 Quilin 来说，关键动作是在远程网络发现存在之前，就让本机 `MeshClient.discover()` 返回 A2A-shaped（A2A 形状的）Agent Cards。

Quilin should not expose internal memory, files, or tools through a public card. A2A v1 explicitly supports public cards plus authenticated extended cards, so Quilin can publish a minimal local card and require explicit user/trust approval before returning richer capabilities.

Quilin 不应通过 public card（公开能力名片）暴露内部 memory、files（文件）或 tools。A2A v1 明确支持 public card 加 authenticated extended card，因此 Quilin 可以先发布最小本机 card，并在返回更丰富能力前要求显式用户/trust（信任）批准。

### MCP Streamable HTTP 是工具传输而非 Mesh 替代 / MCP Streamable HTTP Is Tool Transport, Not Mesh Replacement

MCP remains the right protocol for tools and resources. Streamable HTTP matters because it lets MCP servers run as remote services and supports server-to-client messages over optional SSE streams. It does not replace A2A for long-running peer-agent collaboration, and it should not become Quilin's inbound agent-message mechanism.

MCP 仍然是 tools/resources（工具/资源）的正确协议。Streamable HTTP 重要，是因为它让 MCP server 能作为远程服务运行，并通过可选 SSE streams 支持 server-to-client messages（服务端到客户端消息）。它不能替代 A2A 的长期 peer-agent 协作，也不应该成为 Quilin 的入站 Agent 消息机制。

For F1, the pragmatic boundary is: local stdio MCP remains default; local Streamable HTTP can be accepted only on loopback with Origin validation; remote Streamable HTTP requires OAuth-style auth, token audience validation, explicit trust, and SSRF-safe discovery. Anything beyond that belongs after the first local MeshClient slice.

对 F1 来说，务实边界是：本地 stdio MCP 仍是默认；本地 Streamable HTTP 只能在 loopback（回环地址）上接受，并进行 Origin 校验；远程 Streamable HTTP 必须有 OAuth-style auth（OAuth 风格认证授权）、token audience validation（令牌受众校验）、显式 trust 和 SSRF-safe discovery（防 SSRF 的发现流程）。超出这些的内容应放在第一个本机 MeshClient 切片之后。

### Identity, Permissions, And Audit Must Lead / 身份、权限、审计必须前置

A2A and MCP both provide protocol hooks, but neither removes Quilin's responsibility to define local authorization. A2A says authorization boundaries are agent-defined and must be checked before operations that could leak resources. MCP forbids token passthrough and warns that bad proxying destroys accountability and audit trails.

A2A 和 MCP 都提供协议 hook（挂钩），但不会替 Quilin 定义本地授权。A2A 说明 authorization boundaries（授权边界）由 Agent 自己定义，并且必须在可能泄露资源的操作前检查。MCP 禁止 token passthrough，并警告错误代理会破坏 accountability（可追责性）和 audit trails（审计链）。

The local identity model should therefore start simple: a stable local agent id, per-project scope, a trust record, and per-capability grants. The permission check should happen before a peer can call tools, request memory, or enqueue a task that could trigger writes. Audit should record caller, target, card version, capability, decision, trace id, and whether `WriteAuthority` was consulted.

因此本机 identity model（身份模型）应从简单版本开始：稳定本机 agent id、per-project scope（项目级作用域）、trust record（信任记录）和 per-capability grants（按能力授权）。permission check（权限检查）应发生在 peer（同伴）调用工具、请求 memory，或入队可能触发写入的 task 之前。audit 应记录 caller（调用方）、target（目标）、card version（能力名片版本）、capability（能力）、decision（决策）、trace id，以及是否咨询过 `WriteAuthority`。

### Agentgateway 和 AGNTCY 值得吸收但不应成为 F1 依赖 / Agentgateway And AGNTCY Are Inputs, Not F1 Dependencies

Agentgateway is useful because it shows where production A2A/MCP systems are heading: policy, rate limits, TLS, RBAC/CEL, protocol-aware telemetry, and OpenTelemetry. Quilin should copy the control-plane lessons but not require a gateway to make local Agent Mesh useful.

Agentgateway 有价值，因为它显示生产级 A2A/MCP 系统正在走向：policy（策略）、rate limit（限流）、TLS、RBAC/CEL、协议感知 telemetry（遥测）和 OpenTelemetry。Quilin 应吸收这些 control-plane（控制面）经验，但不应要求用户先部署 gateway 才能使用本机 Agent Mesh。

AGNTCY is useful because it models signed directory records, badges, A2A card modules, MCP server modules, and search/discovery UX. It is not yet the adoption leader by stars, but it is a strong source for future registry shape and provenance. Quilin can defer registry integration while keeping Agent Card fields compatible with future directory export.

AGNTCY 有价值，因为它建模 signed directory records（签名目录记录）、badges（发现凭证）、A2A card modules、MCP server modules 和 search/discovery UX（搜索/发现体验）。它还不是 star 数最高的采用领导者，但对未来 registry shape（目录形态）和 provenance（来源证明）很有参考价值。Quilin 可以推迟 registry integration，同时保持 Agent Card 字段未来可导出到目录。

### LAN/mDNS 应推迟 / LAN/mDNS Should Be Deferred

The previous AgentMesh design made mDNS a week-2 milestone. Current evidence argues against that sequencing. A2A v1 does not require LAN discovery; MCP local HTTP security guidance prefers localhost; RFC 8882 warns that DNS-SD over mDNS exposes identities and service details; Quilin has not yet shipped local card signing, trust prompts, or permissioned capability calls.

旧 AgentMesh 设计把 mDNS 放在第二周 milestone（里程碑）。当前证据不支持这个顺序。A2A v1 不要求 LAN discovery；MCP 本地 HTTP 安全指南偏向 localhost；RFC 8882 警告 DNS-SD over mDNS 会暴露身份和服务细节；Quilin 还没有交付本机 card signing（能力名片签名）、trust prompts（信任确认）或 permissioned capability calls（带权限的能力调用）。

The right sequencing is local-only first, static/direct configuration second, registry export third, and only then LAN/mDNS. When mDNS returns, it should discover candidates only, never establish trust. Trust must still require explicit approval or an existing signed trust record.

正确顺序应是：先 local-only（仅本机），再 static/direct configuration（静态/直接配置），再 registry export（目录导出），最后才是 LAN/mDNS。mDNS 回来时也只能发现 candidates（候选节点），不能建立信任。信任仍必须要求显式批准或已有 signed trust record（签名信任记录）。

## 内化建议 / Assimilation Recommendations

| Priority / 优先级 | Recommendation / 建议 | Why / 原因 | Linear mapping / Linear 映射 |
|---|---|---|---|
| Must / 必须 | Build `MeshClient` local-first: `whoami`, `publishCard`, `discover`, `request`, `respond`, `subscribeInbox`, and an inbox event queue. / 构建本机优先 `MeshClient`：`whoami`、`publishCard`、`discover`、`request`、`respond`、`subscribeInbox` 和 inbox event queue。 | Gives Quilin useful interop without daemon, LAN, or remote trust. / 不依赖 daemon、LAN 或远程信任，也能让 Quilin 具备有用互操作能力。 | `QUI-63` |
| Must / 必须 | Make the Quilin Agent Card A2A v1-shaped, with `supportedInterfaces`, `capabilities`, `securitySchemes`, `security`, `defaultInputModes`, `defaultOutputModes`, `skills`, `version`, and cache metadata. / 将 Quilin Agent Card 做成 A2A v1 形状，包含 `supportedInterfaces`、`capabilities`、`securitySchemes`、`security`、`defaultInputModes`、`defaultOutputModes`、`skills`、`version` 和缓存元数据。 | Current YAML is not A2A-v1 canonical. / 当前 YAML 不是 A2A v1 规范形态。 | `QUI-63` |
| Must / 必须 | Treat public cards as minimal; expose richer capabilities only through authenticated extended-card behavior. / public card 保持最小化；更丰富能力只通过 authenticated extended-card 行为暴露。 | Prevents accidental memory/tool leakage. / 防止意外泄露 memory/tools。 | `QUI-63` |
| Must / 必须 | Route every mesh-originated write or privileged tool call through `WriteAuthority`, and log a mesh audit record with caller, target, card version, capability, decision, trace id, and risk level. / 所有 mesh 来源的写入或高权限工具调用必须经过 `WriteAuthority`，并记录包含调用方、目标、card version、能力、决策、trace id 和风险等级的 mesh audit record。 | Reuses existing safety contract and avoids a second permission system. / 复用现有安全契约，避免第二套权限系统。 | `QUI-63` |
| Must / 必须 | Implement MCP Streamable HTTP terminology and transport checks before any remote transport: Origin validation, localhost default, `MCP-Session-Id`, `MCP-Protocol-Version`, session expiry, and 404 re-init handling. / 在任何远程传输前实现 MCP Streamable HTTP 术语和传输检查：Origin 校验、默认 localhost、`MCP-Session-Id`、`MCP-Protocol-Version`、session 过期和 404 重新初始化处理。 | The latest MCP spec is explicit, and remote MCP is a security boundary. / 最新 MCP 规范很明确，远程 MCP 是安全边界。 | `QUI-63` |
| Must / 必须 | Defer LAN/mDNS, federation, relay, public mesh, and libp2p/DHT（分布式哈希表，用于 P2P 网络发现的结构） to a later `QUI-10` decision. / 将 LAN/mDNS、federation、relay、public mesh 和 libp2p/DHT（分布式哈希表，用于 P2P 网络发现的结构）推迟到后续 `QUI-10` 决策。 | Network discovery before local trust and audit is premature. / 本机 trust 与 audit 未稳定前做网络发现为时过早。 | `QUI-10` |
| Should / 应该 | Prefer the official A2A JavaScript/TypeScript SDK or generated schema types for protocol objects. / 协议对象优先使用官方 A2A JavaScript/TypeScript SDK 或生成 schema types。 | Reduces drift from v1. / 降低偏离 v1 的风险。 | `QUI-63` |
| Should / 应该 | Keep MCP in the Tool layer and expose A2A agents as peer agents, not generic tools, unless a specific skill is intentionally projected as an MCP resource/tool. / MCP 保留在 Tool 层；A2A agents 作为 peer agents 暴露，不默认伪装成通用工具，除非某个 skill 被有意投影为 MCP resource/tool。 | Matches A2A/MCP official split. / 符合 A2A/MCP 官方分工。 | `QUI-63` |
| Should / 应该 | Add conformance fixtures using `a2a-samples`, `a2a-inspector`, or `a2a-tck` once the first `MeshClient` slice exists. / 第一版 `MeshClient` 存在后，用 `a2a-samples`、`a2a-inspector` 或 `a2a-tck` 增加兼容性 fixtures。 | Catches protocol drift early. / 早期发现协议漂移。 | `QUI-63` |
| Should / 应该 | Borrow Agentgateway-style telemetry fields for mesh spans: protocol, binding, peer id, task id, method, auth outcome, policy outcome, and latency. / 借鉴 Agentgateway 风格，为 mesh spans 增加 protocol、binding、peer id、task id、method、auth outcome、policy outcome 和 latency。 | Makes audit and debugging possible without a gateway dependency. / 不依赖 gateway 也能审计和调试。 | `QUI-63` |
| Should / 应该 | Keep Agent Card export compatible with future AGNTCY-style directory records, including locator, skills, version, provider, and signatures. / 保持 Agent Card 未来可导出为 AGNTCY 风格目录记录，包括 locator、skills、version、provider 和 signatures。 | Leaves room for future registry without doing registry now. / 不做 registry 的同时保留未来空间。 | `QUI-10` |
| Could / 可以 | Add signed Agent Cards with JWS/JCS for remote or cross-project trust, after local cards work unsigned. / 本机 unsigned card 工作后，为远程或跨项目 trust 增加 JWS/JCS signed Agent Cards。 | A2A supports signatures, but local F1 can start simpler. / A2A 支持签名，但本机 F1 可以先简化。 | `QUI-10` |
| Could / 可以 | Prototype static direct configuration before mDNS: `mesh peer add <card-url-or-file>`. / 在 mDNS 前原型化静态直接配置：`mesh peer add <card-url-or-file>`。 | Gives explicit trust UX and avoids multicast privacy issues. / 提供显式 trust UX，避免 multicast 隐私问题。 | `QUI-10` |
| Could / 可以 | Watch AGNTCY SLIM（Secure Low Latency Interactive Messaging，一个 AGNTCY 的低延迟消息传输项目） as a future custom A2A binding, but do not adopt it now. / 观察 AGNTCY SLIM（Secure Low Latency Interactive Messaging，一个 AGNTCY 的低延迟消息传输项目）作为未来 A2A 自定义 binding，但当前不采用。 | Interesting for later transport, not needed for local MeshClient. / 对后续 transport 有趣，但本机 MeshClient 不需要。 | `QUI-10` |

## 推荐第一切片 / Recommended First Slice

The first implementation slice should be a TypeScript-first local `MeshClient` in the Quilin runtime, with the Rust `mesh-sdk` remaining a stub until `QUI-10` reopens runtime transport. This matches Quilin's current core runtime split and avoids premature Rust/Go daemon work.

第一实现切片应是 Quilin runtime 中 TypeScript-first（TypeScript 优先）的本机 `MeshClient`，Rust `mesh-sdk` 在 `QUI-10` 重新打开 runtime transport 前继续保持 stub。这符合 Quilin 当前 core runtime（核心运行时）切分，也避免过早进入 Rust/Go daemon 工作。

The slice should support local Agent Card generation, local discovery, request/response through an in-process queue, inbox presentation to the active session, explicit permission gates for capabilities, and audit spans. It should not support LAN, mDNS, federation, public mesh, unauthenticated remote MCP, or remote push adapters.

该切片应支持本机 Agent Card 生成、本机 discovery、通过 in-process queue（进程内队列）的 request/response、向活跃 session 展示 inbox、对 capabilities 做显式权限 gate，以及 audit spans。它不应支持 LAN、mDNS、federation、public mesh、未认证 remote MCP 或 remote push adapters。

The minimum acceptance test should prove that one local Quilin-compatible peer can publish a minimal A2A card, another peer can discover it, request a harmless capability, fail to call a privileged capability without permission, and leave a structured audit trail.

最低验收测试应证明：一个本机 Quilin-compatible peer 可以发布最小 A2A card，另一个 peer 可以发现它、请求无害能力、在无权限时调用高权限能力失败，并留下结构化 audit trail。

## 决策记录 / Decision Record

Decision: continue Agent Mesh, but redefine F1 as local-first A2A/MCP interop with identity, permissions, and audit as first-class gates.

决策：继续 Agent Mesh，但把 F1 重新定义为本机优先的 A2A/MCP 互操作，并把身份、权限和审计作为一等 gate。

Rejected for F1: custom `meshd` daemon, LAN/mDNS auto-discovery, public federation relay, libp2p/DHT, and a custom envelope that competes with A2A task/message semantics.

F1 拒绝项：自定义 `meshd` daemon、LAN/mDNS 自动发现、public federation relay（公开联邦中继）、libp2p/DHT，以及与 A2A task/message semantics（任务/消息语义）竞争的自定义 envelope。

Deferred to `QUI-10`: runtime transport architecture, remote push adapters, direct peer configuration, signed cards for remote trust, LAN/mDNS, gateway compatibility, registry export, and any Rust/Go daemon decision.

推迟到 `QUI-10`：runtime transport architecture、远程 push adapters、direct peer configuration、远程 trust 的 signed cards、LAN/mDNS、gateway compatibility、registry export，以及任何 Rust/Go daemon 决策。

Implementation owner issue: `QUI-63` should absorb the Must items for local `MeshClient`, A2A v1 Agent Card, MCP Streamable HTTP alignment, identity checks, permission checks, and audit records.

实现承接 issue：`QUI-63` 应吸收本机 `MeshClient`、A2A v1 Agent Card、MCP Streamable HTTP 对齐、identity checks、permission checks 和 audit records 这些 Must 项。

