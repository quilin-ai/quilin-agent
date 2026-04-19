# Agent Mesh 工程（Agent Mesh Engineering）

> **实现状态（R-07，2026-04-18）**
> - ✅ **已实现**：无
> - 🚧 **进行中**：无
> - 💭 **未开始**：MeshClient SDK 接入、A2A Protocol 对齐、Agent Card 发布、mDNS/LAN 发现、加密/身份层、gRPC/HTTP SSE bridge。**整领域延期到 Iter D**（核心 loop + 工具 + memory 稳态后才启动），当前不允许任何跨进程 Agent 通信代码落地；06-multi-agent 只能保留进程内 Sub-Agent 编排。

---

## 一、问题定义

### 1.1 为什么需要 mesh 能力？

Agent 生态正在碎片化。Claude Code、Codex、Gemini CLI、Hermes、OpenClaw 等 Agent 各自为战，互不知道对方存在。真实场景中：

- 同时开着 3 个 Claude Code 实例做不同模块，它们之间没法直接交流
- 和同事各自的 Agent 都在改同一个项目，需要协调
- 有一个专门做翻译的小 agent，希望任何在跑的 Agent 都能调它
- 远程团队成员的 Agent 想接进来一起干活

**Quilin 必须天然具备 mesh 通信能力**——启动即加入网络，能发现其他 agent、能被其他 agent 发现、能收发消息。

### 1.2 与第 6 篇（多 Agent 工程）的区别

| 维度 | 06-多 Agent（同构内部） | 11-Agent Mesh（异构外部） |
|------|------------------------|--------------------------|
| Agent 来源 | 同一框架内 spawn | 独立进程 / 独立机器 |
| Agent 类型 | 同一模型家族 | Claude Code、Codex、Gemini CLI 等混合 |
| 状态共享 | 共享内存、共享上下文 | 消息传递，状态隔离 |
| 生命周期 | 随父 Agent 启动/销毁 | 独立生命周期，可长期运行 |
| 部署边界 | 单进程内 | 跨进程、跨局域网、跨互联网 |

---

## 二、定位：内置能力模块

Mesh 是 Quilin 的**内置能力模块之一**，与记忆、工具、规划、上下文等并列。

**Quilin 提供的是能力，不是策略：**

- **提供**：启动即加入 mesh，能发现、能通信、能被发现、能被调用
- **不做**：不设计用户应该怎么利用这个网络。编排、分工、协作模式——这些由用户自己决定

类比：Quilin 给你装了网卡和网线，你上网干什么是你的事。

---

## 三、与 AgentMesh 项目的关系

> AgentMesh 项目总设计文档：[`docs/engineering/11-agent-mesh/AgentMesh-项目总设计.md`](./AgentMesh-项目总设计.md)

### 3.1 AgentMesh 是什么

AgentMesh 是一个独立项目，做的是 **Agent 间的去中心化通信网络**。核心组件是 `meshd` daemon（Go 语言），每台机器跑一个，负责：

- 发现本机 agent，维护到它们的推送通道
- daemon 之间互联形成 mesh 网络
- 提供 MCP 工具供 agent 出站通信（`mesh.send`、`mesh.discover`、`mesh.request` 等）
- 通过 per-runtime adapter 实现入站推送（push, not poll）

AgentMesh 明确**不做 agent 编排框架**——不告诉你怎么写 agent、怎么做 plan-execute、怎么管 memory。

### 3.2 Quilin 在 mesh 中的角色

Quilin 是 mesh 网络中的**一个普通 agent**。它和 Claude Code、Codex、Gemini CLI 一样，通过 meshd 接入网络。Quilin 没有特殊地位——它不是 mesh 的控制面、不是中心协调者、不做路由决策。

区别在于 Quilin 本身的能力很强（记忆、上下文工程、工具使用、自进化等），用户可以选择让 Quilin 去协调其他 agent，但这是用户的决策，不是 mesh 模块的设计。

### 3.3 分工边界

| 职责 | 谁负责 |
|------|-------|
| 消息路由与投递 | AgentMesh (meshd) |
| Agent 发现（本机扫描、mDNS、federation） | AgentMesh (meshd) |
| 入站推送（per-runtime adapter） | AgentMesh (meshd) |
| 出站 MCP 工具（mesh.send/discover/request 等） | AgentMesh (meshd) |
| Envelope 协议、签名、去重 | AgentMesh (meshd) |
| 网络拓扑（L1 本机 / L2 内网 / L3 跨网） | AgentMesh (meshd) |
| 连接 meshd、注册 Agent Card | **Quilin mesh 模块** |
| 处理收到的消息 | **Quilin mesh 模块** |
| 决定怎么利用 mesh（编排、分工、协作） | **用户** |

---

## 四、Quilin 的 mesh 接入方式

### 4.1 启动流程

Quilin 启动时自动执行以下步骤：

```
Quilin 进程启动
    │
    ▼
检测本机 meshd 是否运行
    │
    ├── meshd 运行中 → 通过 SDK 建立连接
    │
    └── meshd 未运行 → 提示用户安装/启动 meshd
                        （mesh 功能不可用，不影响 Quilin 其他能力）
    │
    ▼
注册 Agent Card（声明自己的能力和状态）
    │
    ▼
建立入站推送通道（meshd adapter 向 Quilin 推送消息）
    │
    ▼
mesh 就绪，Quilin 可被发现、可收发消息
```

### 4.2 接入方式：SDK Adapter

Quilin 是 TS 实现的自定义 Agent（见 [ADR-001](../../adr/adr-001-core-loop-and-language.md)），通过 AgentMesh 的 **SDK adapter** 接入。SDK 内部维护到本机 meshd 的 WebSocket 长连接，meshd 通过这条连接把消息推过来直接触发回调。

这是 AgentMesh 设计中最干净的接入路径：无需 hack 进程、无需特殊协议，直接用官方 SDK。

### 4.3 meshd 不可用时的降级

Mesh 是可选能力。如果本机没有 meshd：

- Quilin 正常启动，所有非 mesh 功能正常工作
- mesh 相关操作返回明确的错误信息（"meshd 未运行"）
- 不会因为 meshd 不可用而影响 Quilin 的其他能力（记忆、工具、规划等）

---

## 五、Quilin 的 Agent Card

Quilin 注册到 mesh 时声明的 Agent Card，遵循 AgentMesh 的 Card 格式（基于 Google A2A 协议）：

```yaml
agent:
  id: "{hostname}/quilin-{project}"    # 如 rayson-laptop/quilin-agora
  name: "Quilin Agent ({project})"
  runtime: quilin
  runtime_version: "0.1.0"

  description: |
    Quilin Agent，运行在 {project} 项目目录下。
    具备完整的记忆系统、上下文工程、工具使用、自进化能力。
  skills:                               # 根据实际加载的能力动态生成
    - code_generation
    - code_review
    - file_editing
    - bash_execution
    - memory_management
    - context_engineering
    - self_evolution

  capabilities: []                      # 可暴露的结构化能力，后续扩展

  visibility: local                     # 默认 local，用户可配置

  pubkey: ed25519:...                   # meshd 分配

  host: "{hostname}"
  pid: "{process_id}"
  cwd: "{working_directory}"
  created_at: "{timestamp}"
```

关键点：
- `skills` 字段根据 Quilin 实际加载的模块动态生成，不是硬编码
- `visibility` 默认 `local`（仅本机可见），用户可配置为 `lan` / `federated`
- Agent Card 在 Quilin 能力变化时（如加载新插件）自动更新

---

## 六、消息处理

### 6.1 出站

Quilin 通过 meshd 提供的 MCP 工具发送消息，包括但不限于：

- `mesh.discover()` — 查看网络中有哪些 agent
- `mesh.send()` / `mesh.request()` — 点对点通信
- `mesh.broadcast()` — 房间广播
- `mesh.whoami()` — 查看自己的身份和状态

这些工具由 meshd 实现和提供，Quilin 作为调用方使用它们。完整工具列表见 AgentMesh 设计文档第 6 节。

### 6.2 入站

meshd 通过 SDK adapter 的推送通道将消息投递给 Quilin。Quilin 收到消息后：

1. 将消息内容注入当前上下文（如果有活跃会话）
2. 如果没有活跃会话，缓存消息等待下次交互时呈现
3. 消息来源、时间戳等 metadata 一并保留

消息的具体处理逻辑（是否回复、如何回复、是否委托给其他 agent）由用户决定或由用户配置的策略决定，不是 mesh 模块的职责。

---

## 七、与其他工程领域的关系

| 工程领域 | 与 mesh 的交叉点 |
|---------|----------------|
| 01-LLM 接入 | mesh 消息作为 LLM 输入上下文的一部分 |
| 02-上下文工程 | 收到的 mesh 消息需要纳入 context budget 管理 |
| 03-记忆 | 可以选择将 mesh 交互记录存入记忆系统 |
| 05-工具 | meshd 的 MCP 工具作为 Quilin 可用工具的一部分 |
| 06-多 Agent | 同构 agent 在进程内协作；异构 agent 通过 mesh 协作 |
| 08-可观测性 | mesh 消息的收发应纳入全链路追踪 |
| 09-部署运行时 | Quilin 部署时需确保 meshd 可达（或优雅降级） |

---

## 八、验证标准

### 8.1 连通性验证

| 场景 | 验证点 |
|------|-------|
| Quilin 启动，meshd 运行中 | 自动连接成功，Agent Card 注册成功 |
| Quilin 启动，meshd 未运行 | 优雅降级，其他功能正常 |
| meshd 运行中途崩溃 | Quilin 检测到断连，mesh 功能不可用，其他功能不受影响 |
| meshd 重启 | Quilin 自动重连，重新注册 Agent Card |

### 8.2 通信验证

| 场景 | 验证点 |
|------|-------|
| Quilin 调用 mesh.discover() | 正确返回网络中的 agent 列表 |
| Quilin 调用 mesh.send() | 消息正确投递到目标 agent |
| 其他 agent 向 Quilin 发消息 | Quilin 通过推送通道正确收到消息 |
| Quilin 调用 mesh.request() | 正确收到响应或超时错误 |

### 8.3 Agent Card 验证

| 场景 | 验证点 |
|------|-------|
| 初次注册 | Card 格式合法，skills 反映实际加载的模块 |
| 能力变化 | Card 自动更新（如加载新插件后 skills 列表变化） |
| 多实例 | 同一机器多个 Quilin 实例的 agent_id 不冲突 |

### 8.4 性能指标

| 指标 | 目标值 |
|------|-------|
| Quilin 启动到 mesh 就绪 | < 2 秒（meshd 已运行时） |
| 出站消息延迟（本机 agent 间） | < 50ms |
| 入站消息从 meshd 到 Quilin 回调触发 | < 20ms |
| meshd 断连检测 | < 5 秒 |
| meshd 重连（meshd 重启后） | < 3 秒 |
