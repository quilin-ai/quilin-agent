# Agent Mesh 延后运行时路径规划 / Agent Mesh Deferred Runtime Path Plan

> Linear record: `QUI-10`. Input documents: `docs/11-agent-mesh/mesh-frontier-assimilation.md` and `docs/11-agent-mesh/local-meshclient-implementation-plan.md`. Planning snapshot: 2026-05-02, Asia/Shanghai.
>
> Linear 记录：`QUI-10`。输入文档：`docs/11-agent-mesh/mesh-frontier-assimilation.md` 和 `docs/11-agent-mesh/local-meshclient-implementation-plan.md`。规划快照：2026-05-02，Asia/Shanghai。

## 结论 / Decision

English: `QUI-63` is a sufficient first implementation slice for Agent Mesh. It should deliver a local-first `MeshClient`（a local runtime client that publishes capability cards, discovers local peer agents, exchanges requests, queues inbox events, and enforces identity, permission, and audit policy before any remote networking exists）inside the TypeScript agent core.

中文：`QUI-63` 已经足够作为 Agent Mesh 的第一实现切片。它应在 TypeScript agent core（类型化 JavaScript 的 Agent 核心）里交付本机优先 `MeshClient`（本机运行时客户端，用于发布能力名片、发现本机同伴 Agent、交换请求、排队收件事件，并在远程网络出现前执行身份、权限和审计策略）。

English: `QUI-10` should not pull LAN/mDNS（Local Area Network plus Multicast DNS, local network discovery that can broadcast service identity and capability metadata）, daemon/gateway（daemon is a long-running background process; gateway is a policy and routing proxy between clients and remote services）, federation（cross-instance trust and routing between separately managed agent systems）, relay（a forwarding service that carries messages when peers cannot connect directly）, public mesh（internet-visible agent discovery and routing）, or remote trust（cryptographic and policy checks for non-local peers）into that first slice.

中文：`QUI-10` 不应把 LAN/mDNS（Local Area Network 加 Multicast DNS，即局域网加组播域名发现；它会广播服务身份和能力元数据）、daemon/gateway（daemon 是长期运行的后台进程；gateway 是位于客户端和远程服务之间的策略与路由代理）、federation（由不同主体管理的 Agent 系统之间的跨实例信任和路由）、relay（在同伴无法直连时转发消息的服务）、public mesh（互联网可见的 Agent 发现与路由）或 remote trust（面向非本机同伴的密码学与策略校验）混进第一阶段。

English: The deferred runtime path is a sequence of explicit reopen gates. Each gate must prove that local identity, Agent Card privacy, permission grants, `WriteAuthority`（the central write-permission gate for agent-initiated writes）, and observability events already work locally before adding broader network reach.

中文：延后运行时路径是一组显式重开门槛。每个门槛都必须先证明本机身份、Agent Card（Agent 能力名片）隐私、权限授权、`WriteAuthority`（Agent 发起写入的中央写权限门）和可观测事件已经在本机可用，再扩大网络触达范围。

## 输入综合 / Input Synthesis

English: `mesh-frontier-assimilation.md` concludes that the strongest current Agent Mesh direction is local-first interoperability, not daemon-first LAN networking. It recommends A2A v1（Agent2Agent version 1, a Linux Foundation hosted protocol for agent-to-agent collaboration）for peer-agent protocol shape, MCP Streamable HTTP（Model Context Protocol streamable HTTP transport, a POST/GET plus optional server event stream transport for tool and resource sessions）for tool transport alignment, and explicit deferral of LAN/mDNS and federation to `QUI-10`.

中文：`mesh-frontier-assimilation.md` 的结论是：Agent Mesh 当前最强方向是本机优先互操作，而不是先做 daemon-first LAN networking（先写守护进程和局域网组网）。它建议用 A2A v1（Agent2Agent version 1，一种 Linux Foundation 托管的 Agent 间协作协议）作为同伴 Agent 协议形状，用 MCP Streamable HTTP（Model Context Protocol 可流式 HTTP 传输，用 POST/GET 和可选服务端事件流承载工具与资源会话）对齐工具传输，并把 LAN/mDNS 与 federation 明确延后到 `QUI-10`。

English: `local-meshclient-implementation-plan.md` narrows `QUI-63` to TypeScript contracts, local Agent Card generation, local discovery, request/respond, inbox queues, identity and permission policy, audit records, and MCP transport validation helpers without remote execution. It explicitly states that `QUI-10` owns deferred network transport and any Rust or Go runtime transport decision.

中文：`local-meshclient-implementation-plan.md` 把 `QUI-63` 收窄为 TypeScript 契约、本机 Agent Card 生成、本机发现、请求/响应、收件箱队列、身份与权限策略、审计记录，以及不执行远程调用的 MCP 传输校验 helper（辅助逻辑）。它明确说明 `QUI-10` 负责延后的网络传输，以及任何 Rust 或 Go 运行时传输决策。

English: Therefore `QUI-10` should be treated as a later architecture decision record and validation plan, not as immediate implementation permission. Its first job is to define when a deferred path is allowed to reopen, what must be measured, and which boundary owns the behavior.

中文：因此 `QUI-10` 应被视为后续架构决策记录和验证计划，而不是立即实现许可。它的第一职责是定义：某条延后路径什么时候允许重开、必须测量什么，以及该行为由哪个边界负责。

## 第一阶段边界 / First-Stage Boundary

English: The first stage is local-only. One Quilin-compatible peer can publish a minimal A2A-shaped Agent Card, another local peer can discover it, send a harmless request, receive a response through an inbox queue, fail to call a privileged capability without a grant, and leave structured audit events for both success and block paths.

中文：第一阶段只做本机。一个 Quilin-compatible peer（兼容 Quilin 的同伴 Agent）可以发布最小 A2A 形状的 Agent Card，另一个本机 peer 可以发现它、发送无害请求、通过收件箱队列收到响应、在没有授权时调用高权限能力失败，并为成功路径和阻断路径都留下结构化审计事件。

English: The first stage excludes LAN discovery, multicast announcement, public HTTP endpoints, remote MCP calls, gateway dependency, relay dependency, federation metadata, signed remote identity, and any daemon that becomes a separate lifecycle owner. These exclusions are not omissions; they are safety and debuggability constraints.

中文：第一阶段排除局域网发现、组播公告、公开 HTTP endpoint（网络端点）、远程 MCP 调用、gateway 依赖、relay 依赖、federation 元数据、签名远程身份，以及任何会成为独立生命周期所有者的 daemon。这些排除不是遗漏，而是安全性和可调试性约束。

English: The first stage may keep future-shaped fields if they are inert. For example, an Agent Card may reserve `supportedInterfaces`, version metadata, or signature slots, but those fields must not imply that Quilin is already listening on a remote transport or accepting remote trust.

中文：第一阶段可以保留面向未来的字段，但它们必须是惰性的。例如，Agent Card 可以预留 `supportedInterfaces`、版本元数据或签名槽位，但这些字段不得暗示 Quilin 已经监听远程传输或接受远程信任。

## 延后项一：LAN/mDNS / Deferred Item 1: LAN/mDNS

English: Trigger condition: reopen LAN/mDNS only after local `MeshClient` identity, public-card redaction, authenticated extended cards, permission grants, audit records, and inbox recovery are implemented and tested. Direct configuration by explicit card file or card URL should be proven before multicast discovery.

中文：触发条件：只有在本机 `MeshClient` 身份、公开名片脱敏、认证扩展名片、权限授权、审计记录和收件箱恢复都已经实现并测试后，才重开 LAN/mDNS。显式 card 文件或 card URL 的直接配置，应先于组播发现被证明可用。

English: Risk: mDNS can reveal service identity, capability labels, project presence, and machine activity to the local network. It can also create confusing trust UX if discovery is mistaken for authorization.

中文：风险：mDNS 可能把服务身份、能力标签、项目存在性和机器活动暴露给局域网。它也可能制造混乱的 trust UX（信任体验），让用户误把“发现到了”理解成“已经授权了”。

English: Minimum verification: discovery must return candidates only, never grants. Tests must prove that an mDNS-discovered peer cannot fetch an authenticated extended card, enqueue a privileged request, or trigger `WriteAuthority` without explicit user approval or an existing signed trust record.

中文：最小验证：发现结果只能是 candidate（候选同伴），不能是授权。测试必须证明，通过 mDNS 发现的 peer 不能在没有用户显式批准或已有签名信任记录时获取认证扩展名片、入队高权限请求，或触发 `WriteAuthority`。

English: Boundary: A2A owns the candidate Agent Card shape; MCP owns no discovery behavior here; Observability（the runtime visibility layer that records traces, metrics, logs, and audit events）must record discovery attempt, candidate count, rejected candidate reason, approval prompt, and final trust decision.

中文：边界：A2A 负责候选 Agent Card 的形状；MCP 在这里不负责发现行为；Observability（记录 trace、metrics、logs 和 audit event 的运行时可见性层）必须记录发现尝试、候选数量、候选拒绝原因、审批提示和最终信任决策。

## 延后项二：daemon/gateway / Deferred Item 2: daemon/gateway

English: Trigger condition: reopen daemon/gateway only after a local runtime has stable lifecycle events, durable inbox semantics, explicit stop/resume behavior, and a clear reason why in-process `MeshClient` is insufficient. The reason must be operational, such as multi-process sharing, background delivery, or remote policy enforcement.

中文：触发条件：只有在本机运行时已经具备稳定生命周期事件、可恢复收件箱语义、明确 stop/resume（停止/恢复）行为，并且有清晰理由说明进程内 `MeshClient` 不够用时，才重开 daemon/gateway。该理由必须是运维性的，例如多进程共享、后台投递或远程策略执行。

English: Risk: a daemon creates a second lifecycle owner and can silently keep privileges after the interactive session ends. A gateway can centralize power before Quilin has enough local audit discipline, turning a routing helper into a hidden policy authority.

中文：风险：daemon 会创造第二个生命周期所有者，并可能在交互式 session 结束后继续静默保留权限。gateway 可能在 Quilin 本机审计纪律足够成熟前集中权力，把路由 helper 变成隐藏的策略权威。

English: Minimum verification: daemon/gateway prototypes must prove explicit start/stop, per-project scope isolation, credential non-retention, structured health reporting, trace propagation, and `WriteAuthority` consultation for every write-capable request. A failed daemon must not lose inbox events or grant permissions by default.

中文：最小验证：daemon/gateway 原型必须证明显式 start/stop、项目级作用域隔离、不保留凭证、结构化健康报告、trace（追踪）传播，以及每个具备写能力的请求都会咨询 `WriteAuthority`。daemon 失败时不得丢失收件事件，也不得默认授予权限。

English: Boundary: A2A may define the peer-facing protocol bindings; MCP may be proxied only for tool/resource sessions with its own authorization requirements; Observability owns health, heartbeat, lifecycle, and policy-decision event schemas.

中文：边界：A2A 可以定义面向同伴的协议绑定；MCP 只可在满足自身授权要求时被代理为工具/资源会话；Observability 负责 health（健康状态）、heartbeat（心跳）、生命周期和策略决策事件 schema（结构定义）。

## 延后项三：federation / Deferred Item 3: Federation

English: Trigger condition: reopen federation only after local trust records, signed cards, revocation, audit export, and explicit tenant/project boundaries exist. Federation must start with static, explicitly approved peers before any automated directory exchange.

中文：触发条件：只有在本机信任记录、签名名片、撤销机制、审计导出和明确 tenant/project boundary（租户/项目边界）存在后，才重开 federation。federation 必须从静态、显式批准的同伴开始，而不是先做自动目录交换。

English: Risk: federation turns local capability labels into cross-boundary promises. It can leak project metadata, confuse ownership, and make incident response difficult if revocation and audit trails are incomplete.

中文：风险：federation 会把本机能力标签变成跨边界承诺。如果撤销和审计链不完整，它可能泄露项目元数据、混淆所有权，并让事故响应变困难。

English: Minimum verification: a federated peer must fail closed when signature validation, issuer policy, scope match, or revocation check fails. Tests must include card rotation, revoked trust, stale card cache, and cross-project denial.

中文：最小验证：当签名校验、签发方策略、作用域匹配或撤销检查失败时，联邦同伴必须 fail closed（默认拒绝）。测试必须包含名片轮换、已撤销信任、过期名片缓存和跨项目拒绝。

English: Boundary: A2A owns card, task, and message compatibility; Quilin owns trust policy and project scoping; Observability owns cross-boundary audit correlation; MCP remains tool/resource transport and must not become the federation control plane.

中文：边界：A2A 负责名片、任务和消息兼容；Quilin 负责信任策略和项目作用域；Observability 负责跨边界审计关联；MCP 仍是工具/资源传输，不应成为 federation 控制面。

## 延后项四：relay / Deferred Item 4: Relay

English: Trigger condition: reopen relay only when there is a concrete need for offline delivery, network address translation traversal, or asynchronous remote progress delivery that cannot be solved by local inbox persistence and explicit direct configuration.

中文：触发条件：只有当出现明确的离线投递、网络地址转换穿透，或本机收件箱持久化加显式直接配置无法解决的异步远程进度投递需求时，才重开 relay。

English: Risk: a relay can see metadata even when payloads are encrypted. It can become a hidden dependency for liveness, ordering, retries, and denial-of-service behavior. It also expands the abuse surface if public peers can enqueue work through it.

中文：风险：即使 payload（载荷）被加密，relay 仍可能看到元数据。它会变成 liveness（活性）、排序、重试和拒绝服务行为的隐藏依赖。如果公开同伴能通过它入队任务，也会扩大滥用表面。

English: Minimum verification: relay prototypes must prove end-to-end peer identity preservation, replay protection, per-peer rate limits, payload redaction or encryption, queue expiry, trace continuity, and blocked delivery when trust is missing or revoked.

中文：最小验证：relay 原型必须证明端到端同伴身份保持、防重放、按同伴限流、载荷脱敏或加密、队列过期、trace 连续性，以及缺失或撤销信任时阻断投递。

English: Boundary: A2A can provide task and message semantics over a relay binding; relay must not decide authorization; Observability must expose relay queue depth, retry count, delivery latency, rejection reason, and peer identity fingerprints.

中文：边界：A2A 可以通过 relay binding（中继绑定）提供任务和消息语义；relay 不得决定授权；Observability 必须暴露 relay 队列深度、重试次数、投递延迟、拒绝原因和同伴身份指纹。

## 延后项五：public mesh / Deferred Item 5: Public Mesh

English: Trigger condition: reopen public mesh only after local and explicitly configured remote peers have stable trust, revocation, abuse controls, card privacy tiers, and user-visible governance. Public discovery must be opt-in and scoped, not a default runtime behavior.

中文：触发条件：只有在本机和显式配置的远程同伴已经具备稳定信任、撤销、滥用控制、名片隐私层级和用户可见治理后，才重开 public mesh。公开发现必须是 opt-in（选择加入）且有作用域，不得成为默认运行时行为。

English: Risk: public mesh changes Quilin from a local agent runtime into an internet-facing service. It introduces spam, prompt injection, metadata harvesting, capability probing, denial-of-wallet, and legal/compliance concerns.

中文：风险：public mesh 会把 Quilin 从本机 Agent runtime（运行时）变成面向互联网的服务。它会引入垃圾请求、prompt injection（提示注入）、元数据抓取、能力探测、成本耗尽攻击，以及法律/合规问题。

English: Minimum verification: public mesh must have explicit enablement, per-capability allowlists, spend caps, rate limits, abuse reporting, card privacy checks, structured consent logs, and a safe shutdown path that removes public presence.

中文：最小验证：public mesh 必须具备显式启用、按能力 allowlist（允许列表）、成本上限、限流、滥用报告、名片隐私检查、结构化同意日志，以及能够移除公开存在性的安全关闭路径。

English: Boundary: A2A may define public-facing compatibility; Quilin owns product consent and safety; MCP tools must never be exposed through public mesh without Tools and Safety approval; Observability must make public exposure visible in dashboard and audit export.

中文：边界：A2A 可以定义面向公开网络的兼容性；Quilin 负责产品同意和安全；MCP 工具未经 Tools 与 Safety 批准绝不能通过 public mesh 暴露；Observability 必须在 dashboard（仪表盘）和审计导出中让公开暴露状态可见。

## 延后项六：remote trust / Deferred Item 6: Remote Trust

English: Trigger condition: reopen remote trust only after local identity and permission records are stable, Agent Card signing format is chosen, key storage boundaries are defined, and revocation can be tested. Remote trust is a prerequisite for federation, relay, and public mesh, not a cleanup task after them.

中文：触发条件：只有在本机身份与权限记录稳定、Agent Card 签名格式已选择、密钥存储边界已定义，并且撤销可测试后，才重开 remote trust。remote trust 是 federation、relay 和 public mesh 的前置条件，不是这些能力上线后的收尾工作。

English: Risk: remote trust mistakes are high blast-radius failures. A trusted peer can request work, influence model context, and potentially trigger write-capable operations. Weak key handling or stale trust records can turn old approvals into persistent vulnerabilities.

中文：风险：remote trust 错误属于高影响面失败。受信同伴可以请求工作、影响模型上下文，并可能触发具备写能力的操作。薄弱密钥处理或过期信任记录会把旧批准变成持续漏洞。

English: Minimum verification: signed-card validation, issuer pinning, trust record expiry, revocation, key rotation, least-privilege grants, and audit replay must all have deterministic tests. Remote trust must default to no trust when any required proof is missing.

中文：最小验证：签名名片校验、签发方 pinning（固定信任对象）、信任记录过期、撤销、密钥轮换、最小权限授权和审计回放都必须有确定性测试。任何必需证明缺失时，remote trust 必须默认无信任。

English: Boundary: A2A may carry signed card metadata; Quilin owns trust-store policy and user approval; MCP authorization remains separate and must validate token audience when HTTP transport is used; Observability must link trust decisions to trace IDs and audit IDs.

中文：边界：A2A 可以承载签名名片元数据；Quilin 负责 trust-store（信任存储）策略和用户审批；MCP 授权保持独立，并在使用 HTTP 传输时校验 token audience（令牌受众）；Observability 必须把信任决策关联到 trace ID 和 audit ID。

## A2A、MCP、可观测性边界 / A2A, MCP, And Observability Boundaries

English: A2A owns peer-agent interoperability: Agent Cards, supported interfaces, task/message semantics, streaming or progress vocabulary, and authenticated extended-card behavior. Quilin may add local metadata, but it should not invent a competing peer-message protocol when A2A vocabulary is enough.

中文：A2A 负责同伴 Agent 互操作：Agent Card、支持的接口、任务/消息语义、流式或进度词汇，以及认证扩展名片行为。Quilin 可以增加本机元数据，但在 A2A 词汇足够时，不应发明与之竞争的同伴消息协议。

English: MCP owns tool and resource integration. MCP endpoints, sessions, authorization, `MCP-Session-Id`, `MCP-Protocol-Version`, Origin validation, and HTTP session recovery belong to the Tools boundary. Mesh may carry identity and audit metadata into a tool call, but Mesh should not make MCP a peer-agent control plane.

中文：MCP 负责工具与资源集成。MCP endpoint、session、授权、`MCP-Session-Id`、`MCP-Protocol-Version`、Origin 校验和 HTTP session 恢复都属于 Tools 边界。Mesh 可以把身份和审计元数据带入工具调用，但 Mesh 不应把 MCP 变成同伴 Agent 控制面。

English: Observability owns event consistency across all deferred paths. Every reopened path must emit stable events for discovery, trust decision, permission decision, inbox delivery, request lifecycle, transport retry, and failure reason. These events should later feed `QUI-20` dashboard and audit export.

中文：Observability 负责所有延后路径中的事件一致性。每条重开的路径都必须为 discovery、trust decision、permission decision、inbox delivery、request lifecycle（请求生命周期）、transport retry（传输重试）和 failure reason（失败原因）发出稳定事件。这些事件后续应进入 `QUI-20` 的 dashboard 和审计导出。

## Linear 映射 / Linear Mapping

English: `QUI-10` owns this deferred runtime path: LAN/mDNS, daemon/gateway, federation, relay, public mesh, remote trust, direct remote configuration, and any later Rust or Go transport runtime decision.

中文：`QUI-10` 负责本文定义的延后运行时路径：LAN/mDNS、daemon/gateway、federation、relay、public mesh、remote trust、直接远程配置，以及任何后续 Rust 或 Go 传输运行时决策。

English: `QUI-63` owns the first local `MeshClient` slice and must remain scoped to local Agent Card generation, local discovery, local request/respond, inbox queue, identity, permission, audit, and MCP terminology/validation helpers.

中文：`QUI-63` 负责第一个本机 `MeshClient` 切片，并且必须保持在本机 Agent Card 生成、本机发现、本机请求/响应、收件箱队列、身份、权限、审计，以及 MCP 术语/校验 helper 范围内。

English: `QUI-54` owns the frontier decision that made A2A v1 and MCP Streamable HTTP alignment the correct direction. `QUI-10` should not revisit that decision unless the upstream protocols materially change.

中文：`QUI-54` 负责前沿决策：A2A v1 与 MCP Streamable HTTP 对齐是正确方向。除非上游协议发生实质变化，`QUI-10` 不应重新推翻该决策。

English: `QUI-20` owns dashboard, trace, metric, log, and audit export surfaces. Deferred Mesh runtime work must produce event contracts that `QUI-20` can display and verify, but `QUI-10` should not implement the full dashboard itself.

中文：`QUI-20` 负责 dashboard、trace、metric（指标）、log（日志）和审计导出表面。延后 Mesh runtime 工作必须产生 `QUI-20` 能展示和验证的事件契约，但 `QUI-10` 不应自己实现完整 dashboard。

## 重开顺序 / Reopen Sequence

English: Step 1 is direct remote configuration after `QUI-63`: a user explicitly adds a card file or card URL, Quilin treats it as an untrusted candidate, and no privileged capability is visible until trust is granted.

中文：步骤 1 是 `QUI-63` 之后的直接远程配置：用户显式添加 card 文件或 card URL，Quilin 把它视为未受信 candidate，并且在授权前不展示任何高权限能力。

English: Step 2 is signed cards and remote trust: choose the signing format, define trust records, implement expiry and revocation, and prove least-privilege grants through deterministic tests.

中文：步骤 2 是签名名片和 remote trust：选择签名格式，定义信任记录，实现过期和撤销，并通过确定性测试证明最小权限授权。

English: Step 3 is daemon/gateway only if there is a measured lifecycle or multi-process need. The prototype must remain per-project scoped and must not become a hidden global trust authority.

中文：步骤 3 是 daemon/gateway，但只有在测量后确认存在生命周期或多进程需求时才做。原型必须保持项目级作用域，不能变成隐藏的全局信任权威。

English: Step 4 is LAN/mDNS candidate discovery. It must discover candidates only, never authorize them, and must present privacy impact to the user before enabling multicast.

中文：步骤 4 是 LAN/mDNS 候选发现。它只能发现 candidate，不能授权 candidate，并且必须在启用组播前向用户展示隐私影响。

English: Step 5 is relay, federation, and public mesh only after remote trust, revocation, abuse controls, rate limits, spend caps, and public exposure audit are already working.

中文：步骤 5 是 relay、federation 和 public mesh，但只有在 remote trust、撤销、滥用控制、限流、成本上限和公开暴露审计都已经工作后才推进。

## 最小验收 / Minimum Acceptance

English: `QUI-10` planning is acceptable when this document clearly separates first-stage local `MeshClient` work from deferred network runtime work, defines trigger conditions and risks for each deferred item, and maps the work to existing Linear issues without creating new issues.

中文：当本文清晰区分第一阶段本机 `MeshClient` 工作与延后网络运行时工作，为每个延后项定义触发条件和风险，并把工作映射到既有 Linear issue 且不新建 issue 时，`QUI-10` 规划即达到可接受状态。

English: A future `QUI-10` implementation may start only when the relevant trigger condition is satisfied and when verification can prove fail-closed behavior, explicit user approval, audit traceability, and no accidental exposure of memory, tools, files, credentials, or conversation content.

中文：未来 `QUI-10` 实现只有在相关触发条件满足，并且验证能够证明 fail-closed 行为、显式用户批准、审计可追踪，以及不会意外暴露记忆、工具、文件、凭证或对话内容后，才可以启动。

English: Documentation verification for this task is glossary lint plus whitespace diff check. Implementation verification is intentionally deferred because this task is a planning artifact, not runtime code.

中文：本任务的文档验证是术语 lint 加 whitespace diff check（空白字符差异检查）。实现验证有意延后，因为本任务是规划产物，不是运行时代码。
