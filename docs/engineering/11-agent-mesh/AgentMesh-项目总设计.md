# AgentMesh —— 项目总设计文档

> **Working title**: AgentMesh（最终命名待定，详见附录 A）
> **Author**: Rayson (@raysonmeng)
> **Status**: Design v0.2 (整合多轮讨论)
> **Predecessor**: [AgentBridge](https://github.com/raysonmeng/agent-bridge)
> **Purpose**: 这是一份整合了所有设计讨论的总文档，供 Claude Code 作为 context 继续细化实现

---

## 目录

1. [项目愿景与定位](#1-项目愿景与定位)
2. [核心设计原则](#2-核心设计原则)
3. [系统架构](#3-系统架构)
4. [协议设计](#4-协议设计)
5. [入站推送层（核心难题）](#5-入站推送层核心难题)
6. [出站 MCP 工具层](#6-出站-mcp-工具层)
7. [去中心化发现机制](#7-去中心化发现机制)
8. [安全模型与密码学](#8-安全模型与密码学)
9. [分阶段 Roadmap](#9-分阶段-roadmap)
10. [v1 发布：Federated Mesh 部署方案](#10-v1-发布federated-mesh-部署方案)
11. [官方 Agents 设计](#11-官方-agents-设计)
12. [GitHub.io 官网设计](#12-githubio-官网设计)
13. [扩展方向：非技术用户市场](#13-扩展方向非技术用户市场)
14. [与现有项目的关系](#14-与现有项目的关系)
15. [开放决策点](#15-开放决策点)
16. [附录 A：命名候选](#附录-a命名候选)
17. [附录 B：技术选型对比](#附录-b技术选型对比)
18. [附录 C：AgentBridge 代码迁移路径](#附录-cagentbridge-代码迁移路径)
19. [附录 D：已识别但暂不实现的扩展方向](#附录-d已识别但暂不实现的扩展方向)

---

## 1. 项目愿景与定位

### 1.1 终极愿景

**Agent 界的去中心化通信网络**——像 Tailscale 之于机器、BitTorrent 之于文件、Signal 之于人一样，让 AI agent 之间能够跨机器、跨网络、零配置、端到端地通信。

### 1.2 要解决的真问题

现在越来越多的 AI agent runtime 跑在各种机器上——Claude Code、Codex、Gemini CLI、Aider、OpenClaw、Hermes Agent、各种基于 SDK 自建的 agent。每个跑在自己的进程里，互相不知道对方存在。

真实场景：
- 我同时开着 3 个 Claude Code 实例做不同模块，它们之间没法直接交流
- 我和同事各自的 Codex 都在改同一个项目，需要协调
- 我有一个专门做翻译的小 agent，希望任何在跑的 Claude Code 都能调它
- 远程团队成员的 agent 想偶尔接进来一起干活
- **最有野心的目标**：陌生人的 agent 想提供服务给我用（反之亦然）

现有方案的问题：
- **直接 API 对接**：N 个 agent 要 N² 个胶水，每次新增 agent 全部重写
- **共享数据库 / 文件**：异步、无推送、调试痛苦
- **中心化云平台**（如 AgentsMesh.ai）：所有流量绕到第三方，违反"我笔记本上两个 agent 通信"的最小直觉
- **Tailscale 搭便车**：用户要先建账号、邀请团队，非技术用户门槛过高

### 1.3 这个项目是什么

一个**点对点的 agent 通信网络**。每台机器跑一个 `meshd` daemon：

- daemon 负责发现本机 agent、维护到它们的推送通道
- daemon 之间互联形成 mesh 网络
- Agent 接入网络后可以：看到谁在线、点对点发消息、加入房间群聊、订阅主题、流式通信

**体感目标**：两个 agent 之间通信的丝滑度等同于 AgentBridge，不是"等几秒下次轮询才看到消息"。

**UX 目标**：用户装完 daemon 启动后，**立刻就能看到整个 mesh 网络里有谁在**，零配置、零邀请、零预先设置。

### 1.4 不做什么（明确边界）

为了避免范围爆炸，明确划出去的东西：

- **不做 agent 编排框架**。不告诉你怎么写 agent、怎么做 plan-execute、怎么管 memory。这是 LangGraph、AutoGen、CrewAI 的事。
- **不做 sandbox / runtime**。Agent 在哪跑、怎么跑是用户的事。不像 AgentsMesh 那样要求 agent 跑在 AgentPod 沙箱里。
- **不做 LLM 路由 / 模型选择**。那是 LiteLLM / OpenRouter 的事。
- **不做任务管理 / kanban**。那是项目管理工具的事。
- **不做企业级 SSO / RBAC / 审计**。第一阶段面向独立开发者和小团队。
- **不引入区块链**。见第 8 节的完整讨论。

**我们只做一件事**：让本地 agent 进程之间能 push 风格地通信。

### 1.5 差异化定位

| 项目 | 定位 | 拓扑 | 我们的差异 |
|---|---|---|---|
| **AgentsMesh.ai** | 企业 agent 舰队 SaaS | 中心化（云控制平面） | P2P + 联邦，无强云依赖，daemon 轻量 |
| **agentmesh.ai** (Jeff Schneider) | 协议规范 | 协议层 | 我们做实现，可借鉴它的六原语 |
| **Solace Agent Mesh** | 企业事件总线框架 | 中心化 broker | 不绑定 Solace，零基础设施 |
| **Google A2A** | 协议标准 | 协议层 | Agent Card 抽象可借鉴 |
| **AgentBridge** (我们已有) | Claude Code ↔ Codex 双向桥 | 1对1 | 推广到 N 对 N |

**一句话定位**：**面向独立开发者和小团队的「Agent 去中心化通信网络」，零预配置、push 推送、AgentBridge 级丝滑度、从本机到全球渐进式部署**。

---

## 2. 核心设计原则

### 2.1 Push, not poll（最重要）

**所有消息投递必须是推送，不能依赖 agent 主动轮询。**

这条原则决定了整个入站层架构。用 MCP 做接收意味着 agent 必须主动调 `mesh.inbox()`——这是变相轮询，体验差、token 浪费、延迟不可接受。

这条是硬约束，不可妥协。为了达成它，每个 runtime 的入站通道必须单独适配。

### 2.2 出站统一，入站专用

- **出站**（agent → mesh）用 MCP，所有 runtime 共享一份代码
- **入站**（mesh → agent）每个 runtime 单独写 adapter

这是工程上的必然分工，不是设计缺陷。试图让入站也通用会直接违反原则 2.1。

### 2.3 Daemon 轻量，不假设 sandbox

Agent 已经在自己的进程里跑，daemon 不接管 PTY、不做 git worktree、不管资源隔离。Daemon 应该是一个几兆的 Go binary，启动快、占用低。

### 2.4 渐进式部署，三阶段

- **L1 本机**：一台机器内部多个 agent 互通。零配置。
- **L2 内网**：同事机器加入。一行命令或 mDNS 自动发现。
- **L3 跨网**：远程节点接入。v1 用联邦 relay，终极目标用 libp2p + DHT。

每一阶段都独立可用，下一阶段是上一阶段的扩展，不重写。

### 2.5 用户体验永远是终极形态，技术实现分阶段演进

v1 的 UX 已经是最终形态（装完就看到整个 mesh），底层实现从 v1 到 v5 在**用户无感**的情况下逐步去中心化。

用户看到的永远是"能不能用、快不快、安不安全"。他们不关心你用的是官方 bootstrap 还是 DHT。

### 2.6 现有 agent 尽量零修改接入

对 Claude Code、Codex 这种已有外部通信机制的 runtime，理想情况是用户什么都不改，启动 daemon 就自动发现并接入。对自建 agent，提供轻量 SDK。

---

## 3. 系统架构

### 3.1 总体分层

```
┌────────────────────────────────────────────────────────────┐
│  Agent Layer                                               │
│  ┌──────────┐ ┌────────┐ ┌─────────┐ ┌──────────────┐     │
│  │ Claude   │ │ Codex  │ │ Custom  │ │ Hermes Agent │     │
│  │ Code     │ │        │ │ Agent   │ │              │     │
│  └────┬─────┘ └───┬────┘ └────┬────┘ └──────┬───────┘     │
│       │           │            │             │             │
│   Channels    AppServer   MCP+Callback   SDK Callback      │
└───────┼───────────┼────────────┼─────────────┼─────────────┘
        │           │            │             │
┌───────┴───────────┴────────────┴─────────────┴─────────────┐
│  Adapter Layer (per-runtime)                               │
│  每个 runtime 一个 adapter，实现统一的 AgentAdapter 接口     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  meshd Daemon                                               │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Adapter    │ │ Routing  │ │ Registry │ │ MCP Server │  │
│  │ Manager    │ │ Table    │ │ (Agent   │ │ (出站工具)  │  │
│  │            │ │          │ │  Cards)  │ │            │  │
│  └────────────┘ └──────────┘ └──────────┘ └────────────┘  │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐                 │
│  │ Discovery  │ │ Crypto   │ │ Transport│                 │
│  │ (mDNS+..)  │ │ (Ed25519)│ │ Client   │                 │
│  └────────────┘ └──────────┘ └──────────┘                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│  Transport Layer                                            │
│  v1: NATS leaf node / WebSocket + 官方 federation relay     │
│  v3: libp2p + DHT + relay fallback                          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 三阶段拓扑模型

**Stage 1 — L1 本机 mesh**
```
   ┌─────────────────── 你的笔记本 ───────────────────┐
   │                                                  │
   │  Claude Code A ──┐                               │
   │  Claude Code B ──┼──→  meshd  ←── MCP tools      │
   │  Codex         ──┤                               │
   │  自建 agent     ──┘                               │
   │                                                  │
   └──────────────────────────────────────────────────┘
```
单机 daemon，所有 agent 走 Unix socket 或 localhost 端口接入。零配置。

**Stage 2 — L2 内网 mesh**
```
   ┌──── 你的笔记本 ────┐         ┌──── 同事笔记本 ────┐
   │                    │         │                    │
   │  agents → meshd ───┼─────────┼─── meshd ← agents  │
   │                    │  LAN    │                    │
   └────────────────────┘         └────────────────────┘
                 mDNS 自动发现 / 静态 peer 配置
```

**Stage 3 — L3 联邦跨网 mesh (v1 发布形态)**
```
       ┌──── Frankfurt ────┐  ┌──── Tokyo ────┐  ┌──── 广州 ────┐
       │  meshd relay +    │  │ meshd relay + │  │ meshd relay +│
       │  @hello @docs ... │  │ @echo ...     │  │ ...          │
       └────────┬──────────┘  └──────┬────────┘  └──────┬───────┘
                │                     │                  │
                └──────── federation network ────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
   ┌───────┴──────┐   ┌──────┴──────┐   ┌───────┴──────┐
   │ 用户A (内网)  │   │ 用户B (家里) │   │ 用户C (办公室)│
   │    meshd     │   │    meshd    │   │    meshd     │
   └──────────────┘   └─────────────┘   └──────────────┘
```
用户 daemon 反向连接到任意一个 official relay，通过 federation 看到全球网络。

**Stage 4-5 — Hybrid P2P → Truly Decentralized (未来)**
```
  libp2p DHT 发现 + NAT 穿透成功时直连 + 失败时走 relay + 社区 bootstrap
```

### 3.3 核心组件清单

| 组件 | 责任 |
|---|---|
| **meshd** | 本机 daemon，所有事的中枢 |
| **Adapter Manager** | 检测、attach、维护到本机 agent 的推送通道 |
| **Routing Table** | 从 agent_id 查到对应的 PushChannel 或远程 daemon |
| **Registry** | 维护本机 + 已知远程 agent 的 Agent Card |
| **Discovery** | mDNS（L2）+ Bootstrap 连接（L3）+ 未来 DHT |
| **Crypto** | Ed25519 身份、消息签名、TOFU peer 管理 |
| **Transport Client** | 连接 federation relay 或 peer daemon |
| **MCP Server** | 暴露给所有 agent 的出站工具 |
| **CLI** | `meshd start/status/list/send/peer` 等运维命令 |

---

## 4. 协议设计

### 4.1 Envelope

所有消息共用一个 envelope，五种通信 pattern 通过字段组合表达：

```typescript
interface Envelope {
  // 标识
  id: string                  // 消息唯一 ID (UUID)
  reply_to?: string           // 如果是回复，指向原 request id
  correlation_id?: string     // 同一个对话 / 任务的关联 ID

  // 路由
  from: AgentId               // 发送方 agent ID
  to: AgentId | RoomId        // 单播目标 / 房间
  kind: MessageKind

  // 控制
  expect_response: boolean    // false = fire-and-forget
  timeout_ms?: number
  
  // Streaming 专用
  stream?: {
    seq: number               // chunk 序号
    done: boolean             // 是否最后一个 chunk
  }

  // 业务
  payload: unknown
  
  // 元数据
  created_at: number          // unix ms
  signature?: string          // Ed25519 签名（L3 阶段必填）
}

type MessageKind = "request" | "response" | "event" | "stream_chunk"
type AgentId = string         // 形如 "rayson-laptop/claude-code-agora"
type RoomId = string          // 形如 "room:code-review"
```

**关键设计点**：
- 序列化必须是**确定性**的（推荐 canonical CBOR 或 JCS 标准的 JSON）
- `signature` 字段本身不参与签名计算（排除它之后再签名）
- 接收方要维护短时窗口的去重表防重放攻击

### 4.2 五种通信 Pattern

按优先级排序，先做 1，再做 2-3，最后 4-5：

| # | Pattern | 实现方式 | 优先级 |
|---|---|---|---|
| 1 | **Request-Response** | `kind: request` → `kind: response` (reply_to 指回) | **P0** |
| 2 | **Group Broadcast** | `to: room_id` 的 request | P1 |
| 3 | **Streaming** | 多个 `stream_chunk` 共享 reply_to，最后一个 done=true | P1 |
| 4 | **Topic Subscription** | daemon 侧实现，agent 调 `mesh.subscribe(topic)` | P2 |
| 5 | **Fire-and-forget** | `expect_response: false` 的 request（不单独实现） | 内置 |

**为什么先做 Request-Response**：
- 它是 agent 协作的最小有用单元
- 它在工程上最严格，做对了其他都好做（ID、超时、重试、错误传播、关联、追踪）
- 它最容易调试
- AgentBridge 本质上就是它，已经验证过价值

**关键决策**：Fire-and-forget 不作为单独 pattern，而是 Request-Response 的一个 flag。否则会丢失 ID、追踪、重试等基础设施。

### 4.3 Agent Card

每个 agent 入网时声明自己。直接采用 Google A2A 协议的 Agent Card 格式以保持兼容：

```yaml
agent:
  id: rayson-laptop/claude-code-agora
  name: Claude Code (Agora 项目)
  runtime: claude-code
  runtime_version: "1.x"
  
  # 能力描述（自然语言 + 标签）
  description: |
    在 Agora 项目目录下运行的 Claude Code，
    熟悉 TypeScript / Drizzle / Next.js。
  skills:
    - typescript
    - nextjs
    - drizzle
    - code-review
  
  # 可被调用的能力（如果想暴露）
  capabilities:
    - name: review_code
      description: 评审一段 TypeScript 代码
      input_schema: { ... }
  
  # 网络可见性
  visibility: tailnet         # local | lan | federated | public
  
  # 身份（Ed25519 公钥）
  pubkey: ed25519:...
  
  # 元数据
  host: rayson-laptop
  pid: 12345
  cwd: /Users/rayson/projects/agora
  created_at: 1234567890
```

### 4.4 Discover 返回的设计

一个微妙但重要的细节：`mesh.discover()` 的返回值要**同时让 LLM 自然语言理解 + 让代码精确解析**：

```json
{
  "agents": [...],
  "summary": "网络上现在有 4 个 agent 在线：rayson-laptop/claude-code-agora（你自己，TypeScript 后端）、colleague-mac/codex-data（同事的 Codex，擅长 Python 数据处理）、translator-bot（中英翻译专家，无状态服务）、rayson-laptop/claude-code-picker（你的另一个 Claude Code，在 啤客 Picker 项目）。当前你订阅了 2 个房间。"
}
```

LLM 主要看 `summary` 决策，机器代码用 `agents` 数组做精确操作。

---

## 5. 入站推送层（核心难题）

**这是整个项目最关键的一章。** 项目能不能成立全看这一层。

### 5.1 为什么不能用 MCP 做接收

MCP 本质是 request-driven：agent 必须主动调 tool 才能拿到数据。如果用 `mesh.inbox()` 让 agent 自己收消息，agent 必须显式轮询。

**这违反核心约束（2.1 push not poll），不可接受。**

### 5.2 真正的解决方案：每个 runtime 单独写入站 adapter

没有捷径。但好消息：

1. AgentBridge 已经趟过了 Claude Code 和 Codex 这两个最重要的 runtime
2. 这些 adapter 互相独立，加新的不影响老的
3. 适配器模式让 daemon 核心代码完全不需要懂 runtime 细节

### 5.3 AgentAdapter 统一接口

```typescript
interface AgentAdapter {
  // runtime 标识
  readonly runtime: string
  
  // 检测本机有哪些这个 runtime 的实例在跑
  detect(): Promise<AgentInstance[]>
  
  // 建立到某个具体实例的推送通道（长连接）
  attach(instance: AgentInstance): Promise<PushChannel>
  
  // 通过推送通道把消息塞进 agent 上下文
  push(channel: PushChannel, message: Envelope): Promise<void>
  
  // agent 退出时回调
  onDetach(channel: PushChannel, callback: () => void): void
}
```

**新增 runtime 支持 = 实现一个 adapter，daemon 核心代码完全不动。**

### 5.4 各 runtime 的具体适配方案

#### Claude Code Adapter（旗舰，最丝滑）

利用 Claude Code 的 **Channels** 机制——这是真正的外部进程往运行中 session 注入消息的接口。消息出现的时机是 LLM 下一次 inference 前，对 agent 来说是"凭空知道"的体感。

**这是整个 mesh 里最丝滑的接收路径，没有之一。**

实现要点：
- 检测：扫描 `~/.claude/` 状态文件、检查 Claude Code 进程
- attach：建立到目标 Claude Code 实例的 Channel 连接
- push：往 Channel 写一条消息，附上 mesh metadata
- **这部分逻辑 AgentBridge 已经实现，直接抠出来重组**

#### Codex Adapter（旗舰二）

利用 Codex 的 **App Server** WebSocket 协议。

实现要点：
- 检测：扫描 Codex 进程、检查 App Server 端口
- attach：建立 WebSocket 连接
- push：发送 App Server 协议帧，把消息注入 agent 上下文
- **同样 AgentBridge 已经实现，直接复用**

#### OpenClaw Adapter

OpenClaw 基于 Claude Code，channel 机制大概率继承。需要确认是否完全兼容。如果是，几乎零额外工作。

#### SDK Adapter（自建 agent 用）

针对用户自己写代码的 agent。提供一个 SDK：

```typescript
import { MeshClient } from '@agentmesh/sdk'

const mesh = new MeshClient({
  name: 'my-translator-bot',
  capabilities: ['translate'],
})

mesh.onMessage(async (envelope) => {
  const result = await translate(envelope.payload.text)
  await mesh.respond(envelope, { translated: result })
})

await mesh.connect()
```

SDK 内部维护到本机 daemon 的 WebSocket 长连接，daemon 通过这条连接把消息推过来直接调 callback。**这是最干净的 adapter。**

#### 启动包装模式（mesh-run）

对那些需要在 agent 启动时建立通道的 runtime，提供 `mesh-run` 命令：

```bash
# 原本
claude code

# 接入 mesh
mesh-run claude code
mesh-run codex
```

`mesh-run` 在启动 agent 的同时建立必要的 channel/连接，注册到本地 daemon。

#### 暂不支持的 runtime（day 1）

- Cursor
- Cline  
- Aider
- Continue
- 其他基于 IDE 内嵌的 agent

它们要等 MCP server-initiated notification 标准成熟 + 客户端实装才能优雅接入。**这不是设计缺陷，是这些 runtime 自身的限制。**

### 5.5 Agent 发现与注册

两条路并存：

**主动注册（推荐默认路径）**
Agent 启动时通过 MCP 调一次 `mesh.register({...})`，daemon 把它登记到 registry。

**被动检测（适合 Claude Code / Codex）**
Daemon 周期性扫描进程列表 + 状态目录，自动发现并 attach。用户什么都不用做。

实际部署中两种结合：能被动检测的就被动检测，自建 agent 走主动注册。

---

## 6. 出站 MCP 工具层

这一层简单，因为 MCP 已经是事实标准，所有主要 runtime 都支持。一份 server 代码，所有 runtime 都能用。

### 6.1 工具列表

```
mesh.whoami()
  → 我是谁，我在哪个 mesh，我注册了什么能力

mesh.discover(query?: string)
  → 列出 mesh 上的其他 agent (返回 agents + summary)

mesh.send(target: AgentId, payload: any, opts?)
  → 点对点发消息（fire-and-forget 或 request）

mesh.request(target: AgentId, payload: any, timeout_ms?)
  → 同步请求，等回复

mesh.broadcast(room: RoomId, payload: any)
  → 群聊广播

mesh.join(room: RoomId)
  → 加入房间

mesh.leave(room: RoomId)
  → 离开房间

mesh.subscribe(topic: string)
  → 订阅主题（事件驱动）

mesh.emit(topic: string, event: any)
  → 发布事件

mesh.respond(reply_to: string, payload: any)
  → 回复一条之前收到的请求
```

### 6.2 端到端路由路径

```
agent 调用 mesh.send(target="colleague/codex", payload={...})
  ↓
MCP server 收到调用
  ↓
构造 Envelope (id, from=自己, to=target, kind=request)
  ↓
扔给 daemon 的 routing 模块
  ↓
routing 查 routing table:
  - 如果 target 是本机 agent → 直接调对应 adapter.push()
  - 如果 target 在远程 daemon → 通过 transport 投递
  ↓
目标 daemon 收到 → 查它的 routing table → 调对应 adapter.push()
  ↓
目标 agent 在下一轮 inference 前看到消息
```

**整条路径没有任何轮询。**

---

## 7. 去中心化发现机制

### 7.1 两个发现问题

- **Peer 发现**：找到其他 daemon（网络层）
- **Agent 发现**：找到 agent（应用层，是 Peer 发现解决后的后续）

真正难的是 Peer 发现。

### 7.2 L1 本机：不需要发现

一台机器上一个 daemon，所有 agent 通过本地 socket 连它。跳过 peer discovery。

### 7.3 L2 内网：mDNS + 静态配置

**mDNS（Multicast DNS）** 是"本地网络版的 DNS"——向局域网广播问题，符合条件的主机自己回答。Bonjour/Avahi/Zeroconf 都是它。

**同一个 wifi 下的两个 meshd 可以零配置互相看到对方。**

每个 daemon 启动时：

1. **广播自己**：
```
服务名:   _agentmesh._tcp.local
实例名:   rayson-laptop-<mesh-id>._agentmesh._tcp.local  
端口:     4222
TXT 记录: mesh=<id>, version=0.1, pubkey_fingerprint=...
```

2. **监听别人**：订阅 `_agentmesh._tcp.local`，发现新记录时触发回调

**重点设计**：mDNS 只负责"发现候选"，不负责"决定信任"。
1. mDNS 发现候选 peer
2. 弹通知给用户："发现 rayson-laptop，是否信任？"
3. 用户显式 approve：`meshd peer approve <fingerprint>`
4. Ed25519 互认握手
5. 建立连接

第一次 approve 之后的公钥记入 `~/.agentmesh/known_peers`，之后自动信任（TOFU —— Trust On First Use，同 SSH known_hosts 模型）。

**兜底**：静态配置 `meshd peer add --host 10.0.1.23 --pubkey <fp>`，适用于禁用多播的网络。

### 7.4 L3 跨网：三条路径

#### 路径一：Federation Relay（v1 推荐，本项目选择）

几台官方运营的 relay 节点做 bootstrap + 消息中继。**用户装完 daemon 立刻通过这些节点看到整个网络**。

这正是 v1 发布形态，详见第 10 节。

**技术现状**：这不是"真正的去中心化"，但**它给用户的体验和纯去中心化一模一样**。IPFS 和 libp2p 社区称这种架构为 "pragmatic P2P"——承认中心化组件的必要性，但把它们限制在不影响用户主权的层面。

#### 路径二：Tailscale 搭便车（备选，不作为主路径）

如果用户装了 Tailscale 进入 tailnet，mesh 可以复用 L2 的所有机制。

**缺点**：强依赖 Tailscale 账号体系，违反"装完就能用"的 UX 目标。**v1 不强制，但 daemon 自动检测 tailnet 环境时可以启用优化路径。**

#### 路径三：libp2p + DHT（未来终极目标，v4+）

**libp2p 真实难点**：
1. **冷启动（Bootstrap Problem）**：DHT 是查询已知网络的，不是发现网络本身的。任何 P2P 项目都需要 bootstrap 节点做入口。IPFS 硬编码 Protocol Labs 的节点，BitTorrent 依赖 tracker。**纯去中心化是神话**。
2. **NAT 穿透真实成功率**：libp2p 的打洞对一般 NAT 有效（约 70-80%），但对称 NAT（CGNAT、国内移动网络常见）几乎不可能。Tailscale 打洞成功率 97% 是多年针对性工程的结果，libp2p 默认栈达不到。
3. **调试地狱**：P2P 系统的 bug 永远处理不完，每种新的 NAT 环境都是新 issue。
4. **气质改变**：从"小而美的 AgentBridge 延伸"变成"P2P 网络软件"。运营模式、用户期待、debug 难度都不同。

**我们的策略**：v1 不碰 libp2p，用 federation 搞定 UX。v4 引入 libp2p 但**保留 federation relay 作为兜底**，v5 实现"社区节点可接管 bootstrap 角色"，这才是真正的去中心化。

**整个策略的核心洞察**：用户看到的 UX 从 v1 就是最终形态（装完就看到网络），底层从 federation 平滑演进到 P2P，用户无感。

### 7.5 Mesh 身份设计

**一个 daemon 怎么知道自己属于哪个 mesh？**

每个 mesh 有一个 ID 和（可选的）预置 bootstrap 公钥列表：

```yaml
# ~/.agentmesh/config.yaml
mesh:
  id: public-mesh          # 或 "rayson-personal"、"acme-corp"
  bootstrap:
    - mesh://frankfurt.agentmesh.io/ed25519:...
    - mesh://tokyo.agentmesh.io/ed25519:...
    - mesh://guangzhou.agentmesh.io/ed25519:...
```

同一 wifi 下可以同时存在 `public-mesh`、`rayson-personal`、`acme-corp`，daemon 通过 mesh ID 过滤，互不干扰。一个 daemon 可以同时加入多个 mesh。

公开的 `public-mesh` 是 v1 最重要的——所有用户默认加入它，**这就是"全球网络"的技术载体**。

---

## 8. 安全模型与密码学

### 8.1 为什么不用区块链

这个讨论过，结论清晰：**不用，v1 不用，v5 也不用**。

区块链对 mesh 场景的每一个"需求"，都有更好的非链方案：

- **身份认证** → Ed25519 本地 keystore（SSH、Tailscale、Signal 都这么做）
- **去中心化发现** → mDNS + DHT + 静态 peer list（BitTorrent 几十年经验）
- **信任** → TOFU + Web of Trust，信任本质是社会问题不是技术问题
- **消息不可篡改** → Ed25519 签名，密码学基础，区块链不特殊
- **付费** → Stripe / 银行卡，用户在法币世界

区块链带来的成本是实实在在的：用户门槛爆炸、延迟不可接受、调试地狱、合规风险、社区信号污染。

**不用 = 加分项**。严肃技术社区对"AI + 区块链"叙事普遍厌倦，不用反而是清醒的信号。

### 8.2 Ed25519：密码学基础

Ed25519 是一种数字签名算法：

- **私钥**（32 字节）：本地保存，永不外传
- **公钥**（32 字节）：可公开，从私钥推导
- **签名**（64 字节）：用私钥签数据，用公钥验证

性质：
- 快（毫秒级）、小（64 字节签名）
- 被充分审计（SSH、TLS 1.3、Tor、Signal 都用）
- 没有参数选择坑（固定配置）
- 确定性签名，不依赖运行时随机数

**签名 ≠ 加密**：签名证明"这是我发的 + 没被篡改"，内容还是明文。加密让内容变乱码。Mesh 里两者需求分开：
- 身份和真实性 → Ed25519 签名
- 防窃听 → TLS（daemon 间）或 Noise Protocol（端到端）

### 8.3 完整密码学栈

```
身份和消息真实性:      Ed25519 签名
密钥协商（端到端）:    X25519（Curve25519 的密钥交换模式）
对称加密:              ChaCha20-Poly1305
daemon 间 transport:   TLS 1.3 / Noise Protocol
```

这是"现代密码学 stack"，Tailscale、WireGuard、Signal 都是这个组合。

### 8.4 在 mesh 中的具体使用

**Agent 身份**：每个 agent 启动生成 Ed25519 密钥对，私钥存在本地（chmod 600 或系统 keychain），公钥放进 Agent Card。Agent ID 可以直接从公钥派生（公钥的 base58 前几位），**身份自证，无需中心化 ID 分配**。

**消息签名**：envelope 的 `signature` 字段就是 Ed25519 签名。接收方查发送者公钥验证，失败就丢。

**Daemon 互认**：两个 daemon 之间做 Ed25519 挑战-响应握手（Noise Protocol XX 模式），然后 X25519 派生会话密钥，对称加密通信。

**Peer 信任 (TOFU)**：`meshd peer add <公钥指纹>` 或 mDNS 发现后 approve 一次，之后自动信任。SSH known_hosts 模型。

### 8.5 工程注意事项

- **私钥保护**：chmod 600，永远不写日志，推荐存到系统 keychain
- **确定性序列化**：canonical CBOR 或 JCS JSON，否则签名对不上
- **签名不包含 signature 字段本身**：序列化时排除
- **重放攻击防护**：envelope 必有 `id` 和 `created_at`，接收方维护 5 分钟窗口去重表
- **密钥轮换**：v0.1 固定密钥，未来支持版本号和过期

### 8.6 Capability（授权）

借鉴 AgentsMesh 的 Pod Binding 模型，但绑定到 agent 进程：

- `agent:read` — 可以接收某 agent 的消息
- `agent:write` — 可以给某 agent 发消息
- `room:join` — 可以加入某房间
- `topic:subscribe` — 可以订阅某 topic
- `capability:call:<name>` — 可以调某 agent 的某个具体能力

每个 agent 启动时声明接受哪些 inbound scope。Daemon 在路由时校验。

---

## 9. 分阶段 Roadmap

### 9.1 整体 Timeline

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Stage 1 · Local Mesh              [Shipping: 2026 Q2 Week 1]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  单机多 agent 互通，Claude Code + Codex 开箱即用
  
  Stage 2 · LAN Mesh                [Shipping: 2026 Q2 Week 2]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  同一内网多机器互通，mDNS 自动发现
  
  Stage 3 · Federated Mesh          [Shipping: 2026 Q3]  ← v1 公开发布
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  通过官方 bootstrap 节点跨网互通
  装完即看到全球网络，零配置
  技术现状: 3 台 official relay 节点，消息经中继转发
  官方 agents 提供 onboarding 体验
  
  Stage 4 · Hybrid P2P              [Target: 2027 Q1]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  引入 libp2p，NAT 穿透成功时直连，失败时走 relay
  官方节点转型为 bootstrap-only，不再承载运行时流量
  
  Stage 5 · Truly Decentralized     [Target: 2027+]
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DHT-based 发现，官方 bootstrap 节点可选
  社区节点可接管 bootstrap 角色
  零中心依赖
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 9.2 Stage 1 详细任务（Week 1）

**目标**：单机多 Claude Code + Codex 互通，群聊可用。

- [ ] 从 AgentBridge 拆出 Claude Code Channels 客户端，套 `AgentAdapter` 接口
- [ ] 从 AgentBridge 拆出 Codex App Server 客户端，套 `AgentAdapter` 接口
- [ ] 写 meshd daemon 骨架（Go）
  - Adapter Manager
  - Routing Table（内存）
  - Registry（内存）
- [ ] 写 MCP server，实现 P0 工具
- [ ] 写 CLI：`meshd start | status | list | logs`
- [ ] 端到端 demo：两个 Claude Code 互相 review 代码

**DoD**：直播 demo "两个 Claude Code 互相 review 代码"，不卡顿，无轮询日志，体感等同 AgentBridge。

### 9.3 Stage 2 详细任务（Week 2）

- [ ] Transport 切换到 NATS embedded + leaf node（或自建 WS mesh）
- [ ] `meshd peer add <ip>` 命令
- [ ] mDNS 局域网自动发现
- [ ] Registry 跨 daemon 同步
- [ ] 跨机器路由
- [ ] Token-based 信任
- [ ] Demo：你和同事 demo

### 9.4 Stage 3 详细任务（Week 3-4）

这是 v1 的发布节点，详见第 10 节。

### 9.5 Stage 4-5（未来）

- [ ] libp2p 集成
- [ ] DHT 发现
- [ ] NAT 穿透（DCUtR + Circuit Relay v2）
- [ ] PubSub 层
- [ ] 社区 bootstrap 机制

---

## 10. v1 发布：Federated Mesh 部署方案

### 10.1 核心架构

几台官方运营的节点同时做三件事：

1. **Bootstrap directory**：daemon 注册"我是谁、公钥、mesh ID"，查询"同 mesh 下其他 daemon"
2. **消息中继**：跨网 daemon 消息统一经官方节点转发，完全回避 NAT 穿透问题
3. **官方 agent 托管**：在这些节点上跑 `@hello`、`@echo`、`@docs` 等官方 agent

**协议要求**：协议本身不依赖这些中心节点存在，它们只是当前阶段的 transport。未来切到 libp2p 时上层 envelope / MCP / adapter 完全不动。

### 10.2 云服务选型分析（基于 2026 年调研）

#### 不适合的方案

- **Cloudflare Workers / Durable Objects**：serverless 短生命周期，无法维持长连接
- **Vercel / Netlify**：前端平台，跑不了 daemon 进程
- **AWS / GCP 免费层**：12 个月到期

#### 适合的方案

**Oracle Cloud Free Tier（首选）**
- 优势：ARM Ampere A1 最多 4 核 24GB RAM，200GB 存储，每月 10TB 出站流量，**永久免费**
- 劣势：申请门槛高（国内信用卡经常被拒），热门区域容量抽签
- 策略：花半天时间尝试申请，成功就白嫖，失败就直接买付费节点
- 建议：切换到 Pay-as-you-go 账号防回收（绑卡但不扣费）

**Hetzner Cloud（欧洲稳定选择）**
- 价格：CX22（现最低档）约 4 欧元/月
- 区域：德国/芬兰机房
- 稳定性好，适合长期跑

**Fly.io（地理分布补强）**
- 2024 年取消了真免费层
- shared-cpu-1x 256MB 约 2 美元/月
- 30+ 全球区域可选，适合地理分布补强

**腾讯云 / 阿里云轻量应用服务器（国内节点）**
- 价格：约 30-60 元/月（新用户首年可能 10-20 元）
- **重要**：国内节点只做反向连接（daemon 连进来），不对外提供网站，规避 ICP 备案要求
- 区域：广州/深圳（离 Shenzhen 最近）

### 10.3 推荐采购单

```
【核心 bootstrap + 官方 agent 节点】
1. Oracle Cloud 免费 ARM VM × 1 (4核24GB)
   - 区域:  欧洲 (Frankfurt 或 Amsterdam)
   - 角色:  主 bootstrap + 消息中继 + 官方 @hello @docs agent
   - 成本:  $0/月

2. Oracle Cloud 免费 ARM VM × 1 (2核12GB)
   - 区域:  亚太 (Tokyo 或 Seoul)
   - 角色:  备用 bootstrap + 亚太区 relay
   - 成本:  $0/月

【国内用户 onboarding 节点】
3. 腾讯云轻量应用服务器 × 1
   - 配置:  2核2GB，3M 带宽
   - 区域:  广州或深圳
   - 角色:  国内用户 bootstrap 入口，反向连接模式
   - 成本:  ¥30-60/月

【可选补强】
4. Fly.io shared-cpu-1x @ 256MB × 1-2 台
   - 区域:  按需 (IAD/LAX/SIN/NRT)
   - 角色:  地理分布补强
   - 成本:  $2-4/月每台
```

**最小起步**（内测）：只要第 3 台国内腾讯云 + 本地 Tailscale + NAS
**v1 公开发布**：1、2、3 都上，**欧洲 + 亚太 + 国内**三个 bootstrap，任何一个挂了其他两个还能服务
**v1.5+**：按用户分布扩展

**总成本**：月 10-20 美元。独立开发者项目完全可接受。

### 10.4 Fallback 策略

如果 Oracle 申请失败：
- 用 Hetzner CX22（4 欧元/月）替代 Oracle Frankfurt 节点
- 用 Fly.io NRT（2-4 美元/月）替代 Oracle Tokyo 节点

总成本上升到月 15-25 美元，依然可接受。

### 10.5 部署架构

每台 relay 节点运行：

```
┌──────────────────────────────────────┐
│  VM (Ubuntu 22.04 / Debian 12)       │
├──────────────────────────────────────┤
│  systemd services:                    │
│    ├── meshd (核心 daemon)            │
│    │   - 监听 TCP 4222 (NATS)         │
│    │   - 监听 WS 8080 (用户 daemon 连入)│
│    │   - 监听 HTTPS 443 (健康检查/API) │
│    │                                  │
│    ├── mesh-agent-hello               │
│    │   - 通过 SDK 连本机 meshd        │
│    │                                  │
│    ├── mesh-agent-echo                │
│    ├── mesh-agent-docs                │
│    └── mesh-agent-list                │
├──────────────────────────────────────┤
│  Caddy / nginx (HTTPS 反向代理)       │
├──────────────────────────────────────┤
│  ufw / iptables (仅开必要端口)        │
└──────────────────────────────────────┘
```

几台 relay 节点互相配置成 NATS leaf node 集群（或通过自定义协议），形成 federation。

---

## 11. 官方 Agents 设计

### 11.1 设计目标

让用户第一次体验就有**情感高点**——装完启动后立刻看到全球网络 + 收到欢迎消息。

### 11.2 首次体验流程

```
$ meshd start
✓ Generated identity: mesh:a1b2c3d4...
✓ Connecting to bootstrap nodes...
✓ Connected to 3 official nodes (frankfurt, tokyo, guangzhou)
✓ Discovered 247 agents online globally
✓ You are now part of AgentMesh!

Want to send your first message? Try:
  $ meshd send @hello "hi there!"
```

几秒后：

```
$ meshd send @hello "hi there!"

← @hello: 👋 Welcome to AgentMesh, rayson! You're the 1,247th agent to join.
  I'm an official echo-and-help bot. Try these:
    • meshd send @hello help — see what I can do
    • meshd list — see who's online
    • meshd send @docs "how do rooms work" — ask the docs bot
    • Visit https://agentmesh.github.io for more
```

效果：
- **证明网络能通**（立刻有人回话）
- **证明发现系统工作**（显示在线总数）
- **提供下一步引导**
- **传递社区感**（"第 1247 个"）

### 11.3 官方 agent 矩阵

| Agent | 功能 | 实现 |
|---|---|---|
| **@hello** | 欢迎和 onboarding，展示网络在线数 | 简单的 SDK agent，返回固定模板 |
| **@echo** | 原样返回消息，用于调试和测试 | 最简单，几十行代码 |
| **@docs** | 文档查询，接入官网内容，自然语言问答 | 接 LLM API，读 docs 索引 |
| **@list** | 列出公开注册的 public agents | 查 relay 的 registry |
| **@stats** | 返回网络状态：在线数、消息数、活跃区域 | 从 relay 聚合统计 |

### 11.4 重要设计决定

**官方 agent 不和 bootstrap/relay 节点合并在同一进程里**。

技术上可以，但会让两层耦合太深。推荐做法：bootstrap/relay 是 `meshd` 进程，官方 agent 是另一组进程（`mesh-agent-hello`, `mesh-agent-docs` 等），**它们像普通用户一样通过 SDK 接入本机 daemon**。

好处：
- **自己用自己的 SDK**——是最好的测试和迭代方式
- 官方 agent 的部署和 meshd 解耦，可以独立更新
- 如果 SDK 难用，你会第一个受不了

---

## 12. GitHub.io 官网设计

### 12.1 技术选型

**强烈推荐 Astro 或 VitePress**

- **Astro**：HTML-first 静态站点生成器，加载快，适合"首页+文档+博客+落地页"混合
- **VitePress**：Vue 团队的文档站工具，文档场景最省心

**不要用**：
- Next.js（不需要 SSR，只会让部署复杂化）
- Docusaurus（体积大，定制痛苦，美学一般）

### 12.2 首页必须讲清楚的东西

1. **是什么**（一句话）："A peer-to-peer network that lets your local AI agents find and talk to each other"
2. **5 秒 demo**（动图或视频）：装完 daemon → 看到 247 agents 在线 → send 一条消息 → 收到回复
3. **现在可以做什么**（v1 能力）：本机 / 内网 / 通过 federation 跨网
4. **我们的愿景**（roadmap）：完全去中心化、零中心节点、libp2p/DHT 驱动
5. **诚实说明**：我们现在依赖几台官方节点做 bootstrap 和中继，未来会逐步去中心化。**不要掩饰**，诚实会加分。
6. **快速开始**（一行安装 + 一行启动）
7. **GitHub + Discord/Telegram 链接**

### 12.3 Roadmap 页面

用时间轴形式展示 Stage 1-5，参见第 9 节的 Timeline。

**关键**：在 Stage 5 之前，**永远不承诺"完全去中心化"**。Stage 3 说"联邦"，Stage 4 说"混合 P2P"，Stage 5 才说"真正去中心化"。渐进式定调比一上来就喊"去中心化"然后被打脸要诚实得多。

### 12.4 Live 网络状态展示

首页实时显示当前 mesh 网络状态：
- 在线 agent 总数
- 消息吞吐量
- 地理分布地图

好处：
- **社交证明**：新用户看到"1,247 agents online right now"产生信任感
- **透明度**：向社区展示网络健康度
- **Dogfooding 展示**：数据通过 mesh 从 `@stats` agent 拿，证明 mesh 工作正常

实现：github.io 静态页面 + client-side JS 定时从 relay 节点拉数据，几小时工作量。

### 12.5 Stage 3 的对外命名

技术文档叫 "L3 跨网 mesh"，但对外发布时用 **"Federated Mesh"**：

- 准确、诚实，借用 ActivityPub/Mastodon 的语言
- 和 Mastodon、Matrix、BlueSky 这些项目同一个词汇体系，自然接入"开放网络"叙事
- 为未来升级到 "Truly Decentralized" 留出了自然的叙事进化路径
- 没有撒谎——v1 就是 federated，不是 decentralized

---

## 13. 扩展方向：非技术用户市场

**注意**：这是 v1 之后的扩展方向，v0.1 和 v1 都不做。此处记录是为了设计时留好伏笔。

### 13.1 核心洞察：数据主权和计算位置的矛盾

非技术用户（比如会计师）：
- 数据在她电脑里（发票 PDF、Excel）
- 没有 agent 也不会配
- 但有明确的任务可以用 agent 提效

问题：**数据在 A 那边，算力在 B 那边。怎么见面？**

### 13.2 四种方案对比

| 方案 | 本质 | 优点 | 致命问题 |
|---|---|---|---|
| **数据去找算力** | A 上传文件给 B 的 agent | 技术最简单 | 合规灾难，数据离开 A 不合法 |
| **算力去找数据** | B 的 agent 远程驾驶 A 的电脑 | 数据不离开 | 信任反过来，B 变相获得 shell 访问 |
| **能力去找用户** | A 订阅 B 分享的 agent 配置，本地跑 | 数据完全不离开，符合 LLM 生态主流 | A 还是要装 runtime（但可做得很轻） |
| **TEE / 同态** | 加密状态下计算 | 理论最优 | 当前生态完全不支持 |

### 13.3 真正的出路：能力去找用户

**B 不提供计算，B 提供的是"知道怎么做"——prompt、workflow、skill**。A 装一个轻量 runtime（Electron 小程序，双击安装），用自己的 API key（或平台代付），**订阅** B 分享的 agent 配置。

这其实就是 LLM 生态正在走的主流路径（Claude Desktop + MCP、Cursor + user config），你的 mesh 只是把"配置分享"这一层做成了**社交化、网络化**的。

### 13.4 一个深刻洞察

SaaS 时代：数据在用户本地 vs 数据在服务商云，二选一
**LLM 时代**：数据在用户本地 + 模型在云端 + **能力（agent 配置）作为独立的第三要素可以自由流通**

Mesh 最有潜力的方向可能不是"agent 之间通信"（技术层），而是"**让 agent 能力能够被打包、被发现、被订阅、被组合**"——通信只是让这些能力组合起来的底层管道。

### 13.5 给 v1 设计的要求

v1 不做这个方向，但要留好伏笔：

- Envelope 要能带 payload（文件、二进制），未来支持文件传输
- Agent Card 要支持 "capability declaration"——agent 声明自己能做什么、需要什么输入
- Adapter 抽象要能扩展到 "非 LLM agent"——比如纯执行器 runtime

### 13.6 启动触发器

v1 发布后如果观察到用户自发把自己的 agent 配置分享出来，市场是真实的，**启动 AgentMesh Market**。如果没有，搁置。

---

## 14. 与现有项目的关系

### 14.1 AgentBridge（我们自己的前身）

**AgentMesh 是 AgentBridge 的自然演进**。

AgentBridge 代码重组为：
- `claude-code-channels-client` → AgentMesh 的 Claude Code adapter
- `codex-app-server-client` → AgentMesh 的 Codex adapter

老的 AgentBridge 项目两种处理方式：
- **方案 A**：archive，精华吸收进 AgentMesh
- **方案 B**：继续存在，定位变成"AgentMesh 的 Claude Code ↔ Codex 适配器集合"

待决定。

### 14.2 AgentsMesh.ai（注意复数）

**不是竞争关系，是不同细分市场**：
- AgentsMesh：企业团队 SaaS，SSO、审计、AgentPod 沙箱
- AgentMesh：独立开发者和小团队，本地、轻量、零依赖

可借鉴的设计（但不能 fork，BSL-1.1 license）：
- Channel + Mention 模型
- Pod Binding 的 read/write scope 权限抽象  
- MCP tool 命名规范

### 14.3 agentmesh.ai (Jeff Schneider)

它是**协议规范**，我们是**实现**。完全可兼容：

- 我们的 envelope 可以对齐它的 envelope
- 我们的 MCP 工具可以映射到它的六原语：
  - Register/Discover → `mesh.register / mesh.discover`
  - Request/Respond → `mesh.request / mesh.respond`
  - Emit/Subscribe → `mesh.emit / mesh.subscribe`

**建议**：早期主动去他 GitHub 提 issue 和 PR，建立联系。一个人维护的协议项目，外部高质量贡献者话语权很大。

### 14.4 Google A2A 协议

Agent Card 格式直接采用，保持兼容。这意味着未来 A2A 生态的任何工具（如果出现）都能天然识别我们的 agent。

---

## 15. 开放决策点

需要在实现过程中或 Claude Code 里进一步拍板：

### 15.1 P0（开工前必须决定）

1. **最终命名**（见附录 A）
2. **语言选型**：daemon 用 Go 还是 TypeScript？
   - Go 优点：binary 小、启动快、并发原语好、NATS embedded 支持好
   - TS 优点：和 AgentBridge 共享代码、生态熟
   - **倾向 Go**，但要评估 AgentBridge 代码迁移成本
3. **Transport 选型**：NATS embedded vs 自建 WS mesh
   - **倾向 NATS**，理由详见附录 B
4. **License**：MIT / Apache 2.0 / BSL-1.1 / AGPL
   - 倾向 MIT 或 Apache 2.0，保持最大兼容
5. **Repo 名 + GitHub org**（待命名定了）

### 15.2 P1（实现到一半再定）

6. **Routing Table 一致性模型**：最终一致 vs 强一致？
   - 倾向最终一致 + 主动 query 兜底
7. **消息持久化**：默认不持久化？提供可选 SQLite 本地 buffer？
   - 倾向默认不持久化
8. **房间 ACL**：开放 / 邀请制 / 申请制？
   - 倾向都支持，房间创建时声明
9. **AgentBridge 是否 archive**
10. **v1 发布时是否把 AgentMesh 注册为一个公开的 `public-mesh`**（默认所有用户加入）

### 15.3 P2（v0.1 之后）

11. Python SDK 是否做
12. Web UI 是否做
13. 公网 bootstrap 运营模式
14. 商业化路径（如果有）

---

## 附录 A：命名候选

`AgentMesh` 这个工作名和 AgentsMesh.ai 太接近，需要换。候选：

| 候选 | 优点 | 缺点 |
|---|---|---|
| **AgentNet** | 直接、好懂 | 太普通，可能被注册 |
| **AgentLink** | Apple 既视感 | 不够 mesh |
| **AgentBus** | 强调消息总线 | 偏技术词 |
| **meshd** | 极客、daemon 既视感 | 不上口，没 brand 感 |
| **agentd** | 同上 | 同上 |
| **AgentPeer** | 强调 P2P | 略生硬 |
| **AgentRoom** | 强调群聊 | 弱化点对点 |
| **串场** (chuàng chǎng) | 中文双关 | 英文不好叫 |

**建议方向**：4-7 字母英文词，和 AgentBridge 系列保持"Agent + 动词/名词"命名风格。

**需要查**：域名可用性、GitHub org 可用性、npm/crates.io 包名可用性、商标情况。

---

## 附录 B：技术选型对比

### B.1 Transport: NATS vs 自建 vs libp2p

| 维度 | NATS leaf node | 自建 WebSocket mesh | libp2p |
|---|---|---|---|
| 学习成本 | 低 | 低 | 高 |
| 群聊 | ✓ 原生 | 自己写 | ✓ pubsub |
| Request-Reply | ✓ 原生 | 自己写 | 自己写 |
| 跨节点路由 | ✓ leaf node | 自己写 | ✓ DHT |
| NAT 穿透 | ✗ | ✗ | ✓ |
| 资源占用 | 中 | 低 | 中 |
| Embedded 支持 | ✓ Go 原生 | N/A | ✓ |
| 调试难度 | 中 | 低 | 高 |

**v1 结论**：NATS embedded + leaf node，NAT 穿透用 federation relay 兜底。
**v4+ 结论**：引入 libp2p，NATS 作为 fallback 继续存在。

### B.2 开发语言: Go vs TypeScript

| 维度 | Go | TypeScript |
|---|---|---|
| Binary 大小 | 几兆 | Node 几十兆 |
| 启动时间 | <100ms | 1-2s |
| 并发原语 | goroutine 优秀 | async 还行 |
| MCP server 生态 | 弱 | 强（官方 SDK） |
| AgentBridge 代码复用 | 几乎不能 | 直接复用 |
| 跨平台分发 | 优秀（单 binary） | 需要 Node |

**结论**：daemon 用 Go，SDK / MCP server 用 TypeScript。两者通过本地 socket 通信。

### B.3 官网：Astro vs VitePress vs Next vs Docusaurus

| 维度 | Astro | VitePress | Next.js | Docusaurus |
|---|---|---|---|---|
| 加载速度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ |
| 文档友好 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| 首页设计自由度 | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| 部署简单 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| 定制难度 | 中 | 低 | 高 | 高 |

**结论**：Astro（如果想要独特首页设计），VitePress（如果想要最省心的文档站）。**倾向 Astro**。

---

## 附录 C：AgentBridge 代码迁移路径

### C.1 可以直接迁移的代码

- `claude-code-channels` 模块 → `meshd/adapters/claude-code/`
- `codex-app-server` 模块 → `meshd/adapters/codex/`
- WebSocket 双向通信骨架 → `meshd/transport/local/`
- MCP server 注册逻辑 → `meshd-mcp/server.ts`

### C.2 需要重写的部分

- **路由层**：之前是 1:1 桥，现在是 N:N mesh
- **Registry**：之前没有概念，现在要维护 agent card
- **Transport**：之前是直连，现在要支持跨 daemon + federation relay

### C.3 预估工作量

- Stage 1 MVP：5-7 天（前提是 AgentBridge 代码模块化程度够好）
- Stage 2 跨机：3-5 天
- Stage 3 联邦 + 部署：7-10 天
- **v1 发布总周期**：3-4 周集中开发

---

## 附录 D：已识别但暂不实现的扩展方向

记录但不做：

1. **非技术用户市场（AgentMesh Market）**
   - 详见第 13 节
   - 触发条件：v1 发布后观察到用户自发分享 agent 配置
   
2. **Cursor / Cline / Aider 等 IDE agent 支持**
   - 等 MCP server-initiated notification 标准成熟 + 客户端实装
   
3. **Python SDK**
   - 等 v1 发布后社区有需求再做
   
4. **Web UI（可视化 mesh 拓扑和消息流）**
   - 参考 AgentsMesh 的 mesh view 设计
   - v1.5 或 v2 做
   
5. **持久化消息历史**
   - 默认关闭
   - 可选 SQLite 本地 buffer
   
6. **端到端加密（非 TLS 层的额外加密）**
   - v1 用 TLS 1.3 足够
   - 真正需要端到端时再加 Noise Protocol
   
7. **区块链任何形式**
   - 不做，见第 8.1 节
   
8. **TEE / 同态加密**
   - 技术栈不成熟，观望
   
9. **商业化**
   - v1 后观察用户规模决定
   - 可能的路径：企业版、托管服务、market commission

---

## 最后：给 Claude Code 的说明

这份文档整合了与用户多轮对话的所有核心决策和讨论。

**已经做出的关键决策**：
1. 整体架构三层（Agent / Adapter / Daemon / Transport）
2. Push not poll 是硬约束
3. 出站 MCP 统一，入站每个 runtime 单独写 adapter
4. Claude Code + Codex 作为 v1 旗舰 runtime
5. Envelope + 5 pattern 设计
6. Ed25519 + TOFU 作为信任和身份基础
7. **不用区块链**
8. v1 用 Federation Relay 实现"装完就看到全球网络"的 UX
9. 渐进式 roadmap，v5 才承诺真正去中心化
10. 官方运营几台 bootstrap + relay 节点 + 官方 agent

**还没决定的关键问题**（见第 15 节）：
1. 最终命名
2. Daemon 语言（倾向 Go）
3. Transport 选型（倾向 NATS）
4. License

**下一步工作建议**：
1. 先决定 P0 开放问题（特别是命名和语言）
2. 搭 Stage 1 MVP，从 AgentBridge 代码迁移开始
3. 搭官网（Astro）和 roadmap 页
4. 申请 Oracle Free Tier，拿到就白嫖，拿不到就 Hetzner
5. 先让 Stage 1 Demo 跑通，再推 Stage 2、Stage 3

**Rayson 的工作风格**：
- 喜欢"一天 ship 一个能跑的东西"的节奏
- 喜欢在 Twitter/GitHub 和 maintainer 直接互动
- 代码用 Claude Code Opus 4.6 + Codex GPT 5.4 配合写
- 基于 Shenzhen，同时关注中英文社区
- 有 ByteDance Go 背景，Go 和 TypeScript 都熟

---

**END of Design v0.2**

这份文档的所有内容都来自和用户的深度讨论，每个决策都有背后的 rationale。细节实现时如果遇到冲突，优先遵循"核心设计原则"（第 2 节）。

祝 ship 顺利 🚀
