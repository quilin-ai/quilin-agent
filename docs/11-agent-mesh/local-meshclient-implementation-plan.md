# 本机 MeshClient 实现规划 / Local MeshClient Implementation Plan

> Linear record: `QUI-63`. Research and planning snapshot: 2026-05-02, Asia/Shanghai. This document intentionally does not create new Linear issues because the workspace is under the Linear free-plan 250-issue cap.
>
> Linear 记录：`QUI-63`。调研与规划快照：2026-05-02，Asia/Shanghai。本文件刻意不创建新的 Linear issue，因为当前 workspace 受 Linear 免费版 250 个 issue 上限约束。

## 结论 / Decision

English: `QUI-63` should implement the first Agent Mesh slice as a local-first `MeshClient`（a local runtime client that lets Quilin discover peer agents, publish a capability card, exchange requests, receive inbox events, and enforce identity/permission/audit policy before any remote networking exists）inside the TypeScript agent core. The first slice must make local interop useful without a daemon, without LAN/mDNS, and without exposing memory or tools by default.

中文：`QUI-63` 应把第一个 Agent Mesh 切片实现为 TypeScript agent core（类型化 JavaScript 的 Agent 核心）里的本机优先 `MeshClient`（本机运行时客户端，用于让 Quilin 在远程网络存在前发现同伴 Agent、发布能力名片、交换请求、接收收件事件，并执行身份/权限/审计策略）。第一切片必须在没有 daemon（守护进程）、没有 LAN/mDNS、默认不暴露记忆或工具的情况下，先让本机互操作变得有用。

English: The external protocol shape should be A2A v1-shaped. A2A（Agent2Agent, a Linux Foundation hosted protocol for agent-to-agent collaboration）defines Agent Card discovery, supported interfaces, skills, security requirements, task/message interactions, and authenticated extended cards. Quilin should use those concepts as the compatibility target while keeping the first implementation local and in-process.

中文：外部协议形状应对齐 A2A v1。A2A（Agent2Agent，一种 Linux Foundation 托管的 Agent 间协作协议）定义了 Agent Card（Agent 能力名片）发现、支持的接口、技能、安全要求、任务/消息交互，以及认证后的扩展能力名片。Quilin 应把这些概念作为兼容目标，同时让第一版实现保持本机、进程内。

English: MCP（Model Context Protocol, a protocol for connecting agents and models to tools and resources）stays in the Tools layer. MCP Streamable HTTP（MCP 可流式 HTTP 传输，用 POST/GET 和可选 Server-Sent Events 承载远程 MCP 会话）is relevant to terminology, transport checks, and future bridging, but it should not become Quilin's peer-agent message protocol.

中文：MCP（Model Context Protocol，模型上下文协议，用于把 Agent 和模型连接到工具与资源）仍属于 Tools 层。MCP Streamable HTTP（MCP 可流式 HTTP 传输，用 POST/GET 和可选 Server-Sent Events 承载远程 MCP 会话）与术语、传输检查和后续桥接有关，但不应成为 Quilin 的同伴 Agent 消息协议。

English: LAN/mDNS（Local Area Network plus Multicast DNS, local network service discovery that can broadcast service identity and capability metadata）must remain deferred to `QUI-10`. Local identity, permission grants, audit records, and Agent Card privacy boundaries must exist before network discovery is reopened.

中文：LAN/mDNS（Local Area Network 加 Multicast DNS，即局域网加组播域名发现；它会广播服务身份和能力元数据）必须继续延后到 `QUI-10`。在重新开启网络发现前，本机身份、权限授权、审计记录和 Agent Card 隐私边界必须先存在。

## 输入依据 / Inputs

English: This plan synthesizes `docs/11-agent-mesh/mesh-frontier-assimilation.md`, which already concludes that Agent Mesh should narrow F1 to a local-first `MeshClient`, A2A v1 Agent Card, MCP Streamable HTTP terminology alignment, and identity/permission/audit gates.

中文：本规划综合 `docs/11-agent-mesh/mesh-frontier-assimilation.md`；该文件已经得出结论：Agent Mesh 的 F1 应收窄为本机优先 `MeshClient`、A2A v1 Agent Card、MCP Streamable HTTP 术语对齐，以及身份/权限/审计 gate（执行门）。

English: It also imports the Tools decision that MCP must be wrapped by a host-controlled policy plane, the Safety decision that every consequential action needs an action-level policy record, and the Observability decision that runtime steps should emit stable lifecycle events with trace and audit references.

中文：本文也吸收 Tools 决策中“MCP 必须被宿主控制的策略平面包裹”、Safety 决策中“每个有后果动作都需要动作级策略记录”，以及 Observability 决策中“运行时步骤应发出带 trace（追踪）和 audit（审计）引用的稳定生命周期事件”的结论。

English: Current Quilin state still matches the frontier report: `docs/11-agent-mesh/README.md` describes the older AgentMesh daemon path, while the actual Rust `mesh-sdk` is a stub and no runtime `MeshClient` is wired into agent core. Therefore this file is a planning document, not a claim that the local MeshClient already exists.

中文：当前 Quilin 状态仍与前沿报告一致：`docs/11-agent-mesh/README.md` 描述的是较早的 AgentMesh daemon 路线，而实际 Rust `mesh-sdk` 仍是 stub（占位实现），运行时 `MeshClient` 尚未接入 agent core。因此本文是实现规划，不声称本机 MeshClient 已经存在。

## 官方协议约束 / Official Protocol Constraints

English: The A2A specification defines an Agent Card as a self-describing manifest containing identity, capabilities, skills, communication methods, and security requirements. The card includes fields such as `name`, `description`, `supportedInterfaces`, `version`, `capabilities`, `securitySchemes`, top-level security requirements, skill-level `securityRequirements`, `defaultInputModes`, `defaultOutputModes`, `skills`, and optional signatures. Source: [A2A AgentCard specification](https://a2a-protocol.org/dev/specification/).

中文：A2A 规范把 Agent Card 定义为自描述 manifest（清单）：包含身份、能力、技能、通信方式和安全要求。该名片包含 `name`、`description`、`supportedInterfaces`、`version`、`capabilities`、`securitySchemes`、顶层安全要求、技能级 `securityRequirements`、`defaultInputModes`、`defaultOutputModes`、`skills` 以及可选签名等字段。来源：[A2A AgentCard specification](https://a2a-protocol.org/dev/specification/)。

English: A2A discovery supports well-known URLs, registries/catalogs, and direct configuration. For Quilin's first slice, only direct configuration and local registry discovery are needed; well-known URL export can be represented in the card shape but should not require an HTTP server.

中文：A2A discovery（发现机制）支持 well-known URL（标准约定路径）、registry/catalog（注册表/目录）和 direct configuration（直接配置）。对 Quilin 第一切片来说，只需要直接配置和本机注册表发现；well-known URL 导出可以体现在名片形状里，但不应要求先启动 HTTP 服务。

English: A2A supports public cards and authenticated extended cards. The public Agent Card should contain only safe capability labels, supported local interface metadata, version, provider, and non-sensitive skill descriptions. The authenticated extended card may contain richer skills, route hints, or tool-backed capabilities only after identity and permission checks pass.

中文：A2A 支持公开能力名片与认证后的扩展能力名片。公开 Agent Card 只能包含安全能力标签、受支持的本机接口元数据、版本、provider（提供方）和不敏感技能描述。认证扩展能力名片只有在身份与权限检查通过后，才可以包含更丰富技能、路由提示或工具支撑能力。

English: MCP Streamable HTTP currently defines stdio and Streamable HTTP as standard transports. Streamable HTTP uses a single endpoint, HTTP POST/GET, optional SSE（Server-Sent Events, an HTTP event stream that lets a server push events to a client）, `MCP-Session-Id`, `MCP-Protocol-Version`, explicit session expiry handling, localhost binding guidance, Origin validation, and proper authentication. Source: [MCP transport specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

中文：MCP Streamable HTTP 当前定义 stdio（标准输入输出进程通信）和 Streamable HTTP 为标准传输。Streamable HTTP 使用单 endpoint（端点）、HTTP POST/GET、可选 SSE（Server-Sent Events，一种让服务端向客户端推送事件的 HTTP 事件流）、`MCP-Session-Id`、`MCP-Protocol-Version`、显式 session（会话）过期处理、localhost（本机回环地址）绑定建议、Origin（请求来源）校验和适当认证。来源：[MCP transport specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

English: The A2A documentation explicitly separates peer-agent collaboration from MCP tool/resource integration. This means Quilin may later represent selected A2A skills as MCP resources, but the first MeshClient must not collapse peer agents into generic tools by default. Source: [A2A and MCP comparison](https://a2a-protocol.org/dev/topics/a2a-and-mcp/).

中文：A2A 文档明确区分同伴 Agent 协作和 MCP 工具/资源集成。这意味着 Quilin 未来可以把部分 A2A skills（技能）投影为 MCP resources（资源），但第一版 MeshClient 默认不能把同伴 Agent 折叠成通用工具。来源：[A2A and MCP comparison](https://a2a-protocol.org/dev/topics/a2a-and-mcp/)。

## 第一实现切片 / First Implementation Slice

English: The first slice is an in-process TypeScript `MeshClient`. It exposes `whoami`, `publishCard`, `discover`, `getExtendedCard`, `request`, `respond`, `enqueueInboxEvent`, `subscribeInbox`, and `ackInboxEvent`. These methods are local runtime APIs, not network protocol endpoints.

中文：第一切片是一个进程内 TypeScript `MeshClient`。它暴露 `whoami`、`publishCard`、`discover`、`getExtendedCard`、`request`、`respond`、`enqueueInboxEvent`、`subscribeInbox` 和 `ackInboxEvent`。这些方法是本机运行时 API（应用程序接口），不是网络协议端点。

English: `publishCard` builds a Quilin Agent Card from the current project identity, runtime version, loaded high-level capabilities, supported local interface kind, security requirements, and cache/version metadata. It must not include raw tool schemas, file paths, memory records, environment variables, secrets, or current conversation content.

中文：`publishCard` 根据当前项目身份、运行时版本、已加载的高层能力、支持的本机接口类型、安全要求以及缓存/版本元数据生成 Quilin Agent Card。它不得包含原始工具 schema（结构定义）、文件路径、记忆记录、环境变量、密钥或当前对话内容。

English: `discover` returns local cards from an in-process or file-backed registry scoped to the current workspace. It may read directly configured card files later, but it must not scan LAN, mDNS, public registries, or remote URLs in this slice.

中文：`discover` 从当前 workspace（工作区）作用域内的进程内或文件持久化 registry（注册表）返回本机名片。后续可以读取直接配置的 card 文件，但本切片不得扫描 LAN、mDNS、公开注册表或远程 URL。

English: `request` creates a local peer request, assigns a task/message identifier, evaluates identity and permission policy, writes an audit event, and delivers the request to the target peer's inbox queue. It should support request/response and later streaming, but the first implementation can model streaming as multiple inbox events.

中文：`request` 创建本机同伴请求，分配 task/message identifier（任务/消息标识），评估身份和权限策略，写入审计事件，并把请求投递到目标同伴的收件队列。它应支持请求/响应，并为后续 streaming（流式输出）保留空间；第一版可以把 streaming 建模为多条收件事件。

English: `respond` attaches an answer, rejection, or progress event to an existing request. It must check that the responder owns the target inbox item and must record whether the response is final, retryable, blocked, or waiting for user input.

中文：`respond` 把回答、拒绝或进度事件附加到已有请求上。它必须检查 responder（响应方）是否拥有目标收件项，并记录该响应是 final（最终）、retryable（可重试）、blocked（被阻断）还是 waiting for user input（等待用户输入）。

English: `subscribeInbox` presents incoming mesh events to the active session, WebUI Dashboard, or durable parent inbox later. If there is no active session, events remain queued and visible on the next resume path. This mirrors the Durable Sub-Agent Runtime inbox/outbox discipline without depending on that implementation being complete first.

中文：`subscribeInbox` 把入站 mesh event（多 Agent 网络事件）呈现给活跃 session、WebUI Dashboard（网页仪表盘），或后续的 durable parent inbox（可恢复父运行收件箱）。如果没有活跃 session，事件保持排队，并在下次恢复路径中可见。这复用了 Durable Sub-Agent Runtime 的收发件箱纪律，但不要求该实现先完成。

## Agent Card 契约 / Agent Card Contract

English: Quilin should generate an A2A v1-shaped public card with a stable local `agentId` in metadata, a human-readable `name`, a conservative `description`, ordered `supportedInterfaces`, `version`, `capabilities`, `securitySchemes`, top-level security requirements, `defaultInputModes`, `defaultOutputModes`, and `skills` with skill-level `securityRequirements` when needed. The implementation should use official A2A schema or generated types where possible, because hand-written field names will drift.

中文：Quilin 应生成 A2A v1 形状的公开名片：在 metadata（元数据）中放稳定本机 `agentId`，并包含人类可读的 `name`、保守的 `description`、有序 `supportedInterfaces`、`version`、`capabilities`、`securitySchemes`、顶层安全要求、`defaultInputModes`、`defaultOutputModes`，以及在需要时带技能级 `securityRequirements` 的 `skills`。实现时应尽量使用官方 A2A schema 或生成类型，因为手写字段名容易漂移。

English: The first `supportedInterfaces` entry should be local-only, for example a Quilin-specific binding identifier such as `urn:quilin:mesh:local:v1` and a local URL-like locator that is not routable outside the process or workspace. This records intent without pretending that Quilin already serves a public A2A HTTP endpoint.

中文：第一条 `supportedInterfaces` 应是 local-only（仅本机）的，例如 Quilin 专用 binding identifier（绑定标识）`urn:quilin:mesh:local:v1`，以及一个不会路由到进程或工作区外的本机 URL-like locator（类 URL 定位符）。这样可以记录意图，又不会假装 Quilin 已经提供公开 A2A HTTP endpoint。

English: Public card skills should be coarse-grained. Safe examples are `code_review`, `planning_support`, `documentation_review`, and `read_only_repository_analysis`. Risky capabilities such as shell execution, file writes, browser writes, memory export, credential use, or skill installation must not appear in the public card as callable rights.

中文：公开名片里的 skills 应保持粗粒度。安全示例包括 `code_review`、`planning_support`、`documentation_review` 和 `read_only_repository_analysis`。shell execution（命令行执行）、file writes（文件写入）、browser writes（浏览器写入）、memory export（记忆导出）、credential use（凭证使用）或 skill installation（技能安装）等高风险能力，不得作为可调用权利出现在公开名片中。

English: The authenticated extended card should be computed per caller identity and per project scope. It can expose extra skill details, allowed effects, required approval tier, timeout/budget class, and audit requirements, but only after `MeshIdentity`, `MeshPermissionGrant`, and `WriteAuthority` policy checks pass.

中文：认证扩展能力名片应按 caller identity（调用方身份）和项目作用域动态计算。它可以暴露更多技能细节、允许的 effect（动作效果）、所需审批层级、timeout/budget class（超时/预算类别）和审计要求，但只有在 `MeshIdentity`、`MeshPermissionGrant` 和 `WriteAuthority` 策略检查通过后才能返回。

English: Signed Agent Cards with JWS（JSON Web Signature, a JSON-based signature format）and JCS（JSON Canonicalization Scheme, a deterministic JSON canonicalization standard used before signing）are not required in the local-only slice. The card contract should leave a `signatures` field path open so `QUI-10` can add remote trust later.

中文：本机-only 切片不要求 JWS（JSON Web Signature，一种 JSON 签名格式）和 JCS（JSON Canonicalization Scheme，签名前使用的确定性 JSON 规范化标准）签名能力名片。但名片契约应保留 `signatures` 字段路径，方便 `QUI-10` 后续加入远程信任。

## 身份、权限与审计 / Identity, Permission, And Audit

English: The minimum identity model is `MeshIdentity`: a stable local agent ID, project scope, runtime kind, process/session reference, card version, optional trust record, and optional authenticated caller subject. It is a local authorization identity, not a global internet identity.

中文：最小身份模型是 `MeshIdentity`：稳定本机 Agent ID、项目作用域、运行时类型、进程/session 引用、card version（名片版本）、可选 trust record（信任记录）和可选 authenticated caller subject（认证调用主体）。它是本地授权身份，不是全球互联网身份。

English: The minimum permission model is `MeshPermissionGrant`: caller, target, capability, effect, scope, expiry, approval tier, and reason. The important field is `effect`, because a peer request that eventually writes files or calls privileged tools must not be treated as a harmless chat message.

中文：最小权限模型是 `MeshPermissionGrant`：调用方、目标、能力、effect、作用域、过期时间、审批层级和理由。关键字段是 `effect`，因为最终会写文件或调用高权限工具的同伴请求，不能被当成无害聊天消息。

English: Every `request`, `respond`, `getExtendedCard`, and privileged inbox delivery must create a `MeshAuditEvent`. It should include caller ID, target ID, card version, capability, effect, decision, decision source, trace ID, inbox event ID, Linear issue reference when available, and whether `WriteAuthority` was consulted.

中文：每次 `request`、`respond`、`getExtendedCard` 和高权限 inbox delivery（收件投递）都必须创建 `MeshAuditEvent`。它应包含 caller ID、target ID、card version、capability、effect、decision（决策）、decision source（决策来源）、trace ID、inbox event ID、可用时的 Linear issue 引用，以及是否咨询过 `WriteAuthority`。

English: `WriteAuthority`（the central write-permission gate for agent-initiated writes）remains the write decision owner. Mesh policy can decide whether a peer may ask for a write-capable action, but actual file writes, shell execution, browser state changes, scaffold patch proposals, or skill creation must still route through `WriteAuthority`.

中文：`WriteAuthority`（Agent 发起写入的中央写权限门）仍是写入决策所有者。Mesh policy 可以决定某个 peer（同伴 Agent）是否可以请求具备写能力的动作，但实际文件写入、命令行执行、浏览器状态改变、脚手架补丁提案或技能创建仍必须经过 `WriteAuthority`。

## 收件事件队列 / Inbox Event Queue

English: The inbox event queue is the first durable surface for local MeshClient interop. It stores requests, responses, progress, rejections, card updates, and permission prompts as ordered events with ack status. It should be append-only at first so recovery and audit can replay what happened.

中文：收件事件队列是本机 MeshClient 互操作的第一个可恢复表面。它按顺序存储 request（请求）、response（响应）、progress（进度）、rejection（拒绝）、card update（名片更新）和 permission prompt（权限确认）事件，并带 ack（确认）状态。第一版应采用 append-only（只追加）方式，便于恢复和审计回放。

English: The queue can begin in memory with optional JSON file persistence under an existing runtime state directory, but the contract should not assume memory-only behavior. If the process exits after a peer delivered a request but before the active session sees it, recovery must still be able to surface the event.

中文：队列可以从内存实现开始，并可选地在已有 runtime state directory（运行时状态目录）下用 JSON 文件持久化，但契约不应假设只能驻留内存。如果进程在 peer 投递请求后、活跃 session 看到请求前退出，恢复流程仍必须能够呈现该事件。

English: The minimum event shape is small: `eventId`, `threadId`, `requestId`, `kind`, `caller`, `target`, `cardVersion`, `capability`, `effect`, `payloadRef`, `status`, `createdAt`, `traceId`, `auditRef`, and optional `requiresUserInput`. Raw payloads should be redacted or stored by reference when they may contain private content.

中文：最小事件形状应保持小型：`eventId`、`threadId`、`requestId`、`kind`、`caller`、`target`、`cardVersion`、`capability`、`effect`、`payloadRef`、`status`、`createdAt`、`traceId`、`auditRef`，以及可选 `requiresUserInput`。当原始 payload（载荷）可能含有私密内容时，应脱敏或按引用存储。

English: Queue delivery states should start with `queued`, `presented`, `acknowledged`, `responded`, `blocked`, `expired`, and `failed`. These are operational states, not model outputs, so they should be deterministic and easy to assert in tests.

中文：队列投递状态应从 `queued`、`presented`、`acknowledged`、`responded`、`blocked`、`expired` 和 `failed` 开始。这些是运维状态，不是模型输出，因此应是确定性的，并且易于在测试中断言。

## MCP Streamable HTTP 对齐 / MCP Streamable HTTP Alignment

English: MeshClient must use MCP terms precisely. A peer agent is not an MCP tool. A tool server is not an A2A peer by default. A future bridge may project a narrow peer skill as an MCP resource or tool, but that bridge must preserve caller identity, permission scope, and audit references.

中文：MeshClient 必须精确使用 MCP 术语。peer agent（同伴 Agent）不是 MCP tool。tool server（工具服务）默认也不是 A2A peer。未来 bridge（桥接层）可以把一个狭窄的 peer skill 投影为 MCP resource 或 tool，但必须保留调用方身份、权限范围和审计引用。

English: For the first slice, MCP Streamable HTTP work is limited to terminology and validation helpers. If Quilin sees a remote MCP endpoint in mesh-related configuration, it should require explicit opt-in, localhost default for local HTTP, Origin validation, `MCP-Session-Id` handling, `MCP-Protocol-Version` handling, session 404 re-initialization, and OAuth-style authorization before any real remote call.

中文：第一切片中，MCP Streamable HTTP 工作仅限术语和验证 helper（辅助函数）。如果 Quilin 在 mesh 相关配置中看到远程 MCP endpoint，应在任何真实远程调用前要求显式 opt-in（选择加入）、本地 HTTP 默认 localhost、Origin 校验、`MCP-Session-Id` 处理、`MCP-Protocol-Version` 处理、session 404 重新初始化，以及 OAuth-style authorization（OAuth 风格授权）。

English: This plan does not add unauthenticated remote MCP, remote push adapters, public relay, gateway dependency, or custom MCP transport. Those belong to `QUI-10` or later Tools/Deployment work after local identity and audit are stable.

中文：本规划不增加未认证远程 MCP、远程 push adapter（推送适配器）、公开 relay（中继）、gateway（网关）依赖或自定义 MCP transport。这些属于 `QUI-10` 或后续 Tools/Deployment 工作，前提是本机身份与审计已经稳定。

## 数据契约草案 / Data Contract Sketch

English: The following sketch is intentionally small and should be treated as implementation guidance, not a final public API. It exists to make the first slice testable.

中文：下面的草案刻意保持小型，应视为实现指导，而不是最终公开 API。它的目的只是让第一切片可测试。

```ts
interface MeshIdentity {
  readonly agentId: string;
  readonly projectScope: string;
  readonly runtime: "quilin";
  readonly sessionId?: string;
  readonly cardVersion: string;
  readonly trustRecordId?: string;
}

interface MeshPermissionGrant {
  readonly callerId: string;
  readonly targetId: string;
  readonly capability: string;
  readonly effect: "read" | "respond" | "tool_call" | "file_write" | "shell_exec" | "browser_write" | "memory_read";
  readonly scope: readonly string[];
  readonly approvalTier: "read_only" | "ask_on_write" | "auto_opt_in" | "critical";
  readonly expiresAt?: string;
  readonly reason: string;
}

interface MeshInboxEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly kind: "request" | "response" | "progress" | "rejection" | "card_update" | "permission_prompt";
  readonly caller: MeshIdentity;
  readonly target: MeshIdentity;
  readonly capability: string;
  readonly effect: MeshPermissionGrant["effect"];
  readonly payloadRef: string;
  readonly status: "queued" | "presented" | "acknowledged" | "responded" | "blocked" | "expired" | "failed";
  readonly traceId: string;
  readonly auditRef: string;
  readonly createdAt: string;
  readonly requiresUserInput?: boolean;
}

interface MeshAuditEvent {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly callerId: string;
  readonly targetId: string;
  readonly cardVersion: string;
  readonly capability: string;
  readonly effect: MeshPermissionGrant["effect"];
  readonly decision: "allow" | "confirm" | "block";
  readonly decisionSource: "mesh_policy" | "write_authority" | "human";
  readonly traceId: string;
  readonly inboxEventId?: string;
  readonly writeAuthorityConsulted: boolean;
}
```

## 实现顺序 / Implementation Order

English: Slice 1 should define the TypeScript contracts and a local in-memory registry. Acceptance: `publishCard` returns an A2A v1-shaped public card, `discover` returns the current local card, and the public card contains no raw tools, memory records, secrets, file paths, or environment values.

中文：切片 1 应定义 TypeScript 契约和本机内存 registry。验收：`publishCard` 返回 A2A v1 形状的公开名片，`discover` 返回当前本机名片，并且公开名片不包含原始工具、记忆记录、密钥、文件路径或环境变量值。

English: Slice 2 should add public card versus authenticated extended card behavior. Acceptance: an unauthenticated caller only sees coarse safe skills, while an authenticated caller with a matching grant can see extended skill metadata and required approval tiers.

中文：切片 2 应加入公开名片与认证扩展能力名片行为。验收：未认证调用方只能看到粗粒度安全技能；具备匹配授权的认证调用方可以看到扩展技能元数据和所需审批层级。

English: Slice 3 should add request/respond and inbox event delivery. Acceptance: one local peer can send a harmless request, the target sees a queued inbox event, the target responds, and the caller receives a response event with a shared trace ID.

中文：切片 3 应加入 request/respond 和 inbox event 投递。验收：一个本机 peer 可以发送无害请求，目标看到 queued 收件事件，目标完成响应，调用方收到带同一 trace ID 的响应事件。

English: Slice 4 should add identity/permission/audit enforcement. Acceptance: an unauthorized privileged request is blocked before delivery, a harmless request is allowed, and both paths produce `MeshAuditEvent` records. Any write-capable request must prove that `WriteAuthority` was consulted before execution.

中文：切片 4 应加入身份/权限/审计执行。验收：未授权高权限请求在投递前被阻断，无害请求被允许，两条路径都产生 `MeshAuditEvent` 记录。任何具备写能力的请求都必须证明执行前咨询过 `WriteAuthority`。

English: Slice 5 should add MCP Streamable HTTP alignment helpers without remote execution. Acceptance: validation rejects non-local unauthenticated MCP endpoints, requires `MCP-Protocol-Version` and secure session handling for HTTP MCP configuration, and labels this as Tools-layer transport validation rather than Mesh peer messaging.

中文：切片 5 应加入 MCP Streamable HTTP 对齐 helper，但不做远程执行。验收：校验逻辑拒绝非本机、未认证的 MCP endpoint；对 HTTP MCP 配置要求 `MCP-Protocol-Version` 和安全 session 处理；并明确把它标记为 Tools 层传输校验，而不是 Mesh peer messaging。

## Linear 映射 / Linear Mapping

English: `QUI-63` owns this implementation plan and the first local `MeshClient` slice: card generation, local discovery, request/respond, inbox event queue, identity/permission/audit, and MCP Streamable HTTP terminology alignment.

中文：`QUI-63` 负责本文和第一个本机 `MeshClient` 切片：能力名片生成、本机发现、请求/响应、收件事件队列、身份/权限/审计，以及 MCP Streamable HTTP 术语对齐。

English: `QUI-54` owns the broader Agent Mesh frontier decision. This plan is the concrete follow-up that narrows that decision into a first implementation boundary.

中文：`QUI-54` 负责更大的 Agent Mesh 前沿决策。本文是把该决策收窄为第一实现边界的具体承接。

English: `QUI-10` owns deferred network transport: LAN/mDNS, daemon or gateway decisions, remote push adapters, federation, relay, signed cards for remote trust, registry export, and any Rust/Go runtime transport decision.

中文：`QUI-10` 负责延后的网络传输：LAN/mDNS、daemon 或 gateway 决策、远程推送适配器、federation（联邦）、relay、远程信任签名名片、registry export（目录导出），以及任何 Rust/Go runtime transport 决策。

English: `QUI-20` owns observability, dashboard, and audit export. MeshClient should emit trace and audit records that `QUI-20` can later surface, but `QUI-63` does not need to build the dashboard.

中文：`QUI-20` 负责可观测性、仪表盘和审计导出。MeshClient 应发出 `QUI-20` 后续可展示的 trace 与 audit 记录，但 `QUI-63` 不需要实现仪表盘。

English: `QUI-52` owns Tools and MCP production semantics. `QUI-63` should align terms and carry identity/audit metadata, while actual MCP server calls, tool schemas, structured tool results, and sandbox/browser routing remain under Tools.

中文：`QUI-52` 负责 Tools 和 MCP 生产语义。`QUI-63` 应对齐术语并携带身份/审计元数据；实际 MCP server 调用、工具 schema、结构化工具结果和 sandbox/browser routing（沙箱/浏览器路由）仍归 Tools。

## 非目标 / Non-Goals

English: This task does not start benchmark work. Benchmark（基准测试）is frozen unless the user explicitly asks; Agent Mesh should rely on local component contracts and runtime evidence.

中文：本任务不启动 benchmark 工作。除非用户明确要求，benchmark（基准测试）保持冻结；Agent Mesh 应依赖本地组件契约和 runtime 实证。

English: This task does not implement LAN discovery, mDNS, a public relay, a federation protocol, a custom daemon, a Rust transport runtime, or a Go `meshd` dependency.

中文：本任务不实现 LAN 发现、mDNS、公开 relay、federation protocol、自定义 daemon、Rust 传输运行时或 Go `meshd` 依赖。

English: This task does not modify `agent-bridge.md`. AgentBridge remains the cross-agent collaboration protocol; MeshClient is a product runtime component.

中文：本任务不修改 `agent-bridge.md`。AgentBridge 仍是跨 Agent 协作协议；MeshClient 是产品运行时组件。

## 最小验证门槛 / Minimum Verification Gates

English: Documentation verification for this plan is glossary lint plus whitespace diff check. Implementation verification later should include unit tests for public card redaction, extended card authorization, local discovery, request/respond delivery, unauthorized privileged request blocking, audit record creation, and MCP HTTP configuration rejection.

中文：本文档的验证是术语 lint（术语检查）加 whitespace diff check（空白字符差异检查）。后续实现验证应包含单元测试：公开名片脱敏、扩展名片授权、本机发现、请求/响应投递、未授权高权限请求阻断、审计记录创建，以及 MCP HTTP 配置拒绝。

English: A future implementation may claim `QUI-63` done only when a local peer can publish a public card, another peer can discover it, send a harmless request, receive a response through the inbox queue, fail to call a privileged capability without a grant, and leave a structured audit trail for both success and block paths.

中文：未来实现只有在证明以下行为后，才可以声称 `QUI-63` 完成：一个本机 peer 可以发布公开名片，另一个 peer 可以发现它、发送无害请求、通过收件队列收到响应、在没有授权时调用高权限能力失败，并为成功与阻断路径都留下结构化审计链。
