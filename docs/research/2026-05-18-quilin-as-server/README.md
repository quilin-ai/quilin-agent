# Quilin-as-server — 设计草案 / Design Note (2026-05-18)

> Linear: [QUI-171 — Iter J P3 MCP server mode](https://linear.app/quilin-agent/issue/QUI-171)
> Iter: J（生态与连接 / Ecosystem and Connectivity）
> Stage covered by this note: **Stage 3 skeleton only**
> Status: research note + Stage 3 skeleton landed in `packages/agent-core/src/mcp/server/`

---

## 1. 背景 / Background

Quilin currently runs **MCP client-only**: it spawns `quilin-mem` (Python) via `StdioClientTransport`, and may attach to other servers (exa, tavily, plane, ...) declared in `mcp.config.toml`. The agent consumes other people's MCP tools, but nothing outside Quilin can reach **into** Quilin — there is no Claude Desktop / Cursor / Goose / Zed entry point to call `memory_recall`, browse, or planner.

Quilin 现在是 **MCP client-only**：通过 `StdioClientTransport` 拉起 `quilin-mem`（Python），并可在 `mcp.config.toml` 中挂上 exa / tavily / plane 等外部 server。Agent 只消费别人的 MCP 工具，**外部却没有任何入口能反向调用 Quilin 自己的 `memory_recall`、浏览或 planner** —— 也就是 Claude Desktop / Cursor / Goose / Zed 这些客户端无法消费 Quilin 的能力。

Iter J P3 (this issue) closes that gap by introducing a **server side** to Quilin. The work spans three stages with sharply different complexity profiles; this note only locks in Stage 3 (stdio + localhost). Stage 4 (HTTP transport) and Stage 5 (registry) remain TBD; Google **A2A** (Agent-to-Agent) federation is parked behind both.

Iter J P3（本 issue）通过给 Quilin 增加 **server 侧** 来填补这个缺口。整个工作分三个阶段，复杂度差异很大；本 note 只锁定 Stage 3（stdio + 仅本机）；Stage 4（HTTP transport）和 Stage 5（注册表）后续再做；Google **A2A**（Agent-to-Agent，跨厂商 agent 互通协议）跨厂商互通在两者之后。

---

## 2. 暴露面 / Exposed Surface (MVP for Stage 3)

The exposed surface is intentionally narrow. Anything that can mutate the user's machine outside Quilin's process tree, or that costs paid LLM calls, is excluded from the MVP whitelist. Tools sit behind an explicit `exposed-tools.ts` whitelist; resources sit behind `exposed-resources.ts`. Anything not in those modules is invisible to the MCP client — `list_tools` and `list_resources` will not return it, and direct `call_tool` / `read_resource` with that name returns `unknown_tool` / `unknown_resource` error.

暴露面刻意做窄。任何会在 Quilin 进程树之外改动用户机器的能力，或会触发付费 LLM 调用的能力，都不进入 MVP 白名单。工具由 `exposed-tools.ts` 显式白名单；资源由 `exposed-resources.ts` 显式白名单。这两个模块没列出来的东西对 MCP client 完全不可见 —— `list_tools` 和 `list_resources` 不会返回它，直接 `call_tool` / `read_resource` 也会回 `unknown_tool` / `unknown_resource` 错误。

### 2.1 Tools whitelist / 工具白名单

| Tool | Description | Why exposed | Risk |
|------|-------------|-------------|------|
| `memory_recall` | Read-only semantic / KG recall over `quilin-mem` (4-tier memory store). | Other clients need long-term context Quilin already built up. | Low — read-only. |
| `memory_save` | Append a single typed observation to `quilin-mem`. | Lets external clients log a useful note into Quilin. | Low — additive, bounded. |
| `skill_search` | Search the local SKILL.md catalog (Skills engineering, domain 13). | Cross-client discoverability of Quilin skills. | Low — read-only catalog. |
| `web_fetch` | Fetch a single URL → markdown via Turndown (already implemented as a tool). | Useful for client agents that lack a fetch tool. | Medium — outbound network; rate-limited. |

| 工具 | 说明 | 暴露原因 | 风险 |
|------|------|---------|------|
| `memory_recall` | 只读：对 `quilin-mem`（四层记忆）做语义 / 知识图谱召回 | 别的客户端要复用 Quilin 已经积累的长期上下文 | 低，纯读 |
| `memory_save` | 追加单条带类型的 observation 到 `quilin-mem` | 让外部 client 把有用笔记写回 Quilin | 低，仅追加、有上限 |
| `skill_search` | 搜本地 SKILL.md 目录（Skills 工程，第 13 领域） | 让所有 client 都能发现 Quilin 的 skill | 低，只读目录 |
| `web_fetch` | 拉单个 URL → Turndown 转 markdown（已实现的工具） | 给没有 fetch 工具的 client agent 用 | 中：出站网络；要限流 |

**Explicitly NOT exposed in MVP** / **MVP 明确不暴露**:

- `shell_exec` — arbitrary shell execution; CRITICAL by `WriteAuthority`. Exposing over MCP would let any peer client get RCE on the host.
- `file_write` — file write outside the project root is CRITICAL by safety gate. Same RCE-class risk surface.
- `web_browse` — full Patchright browser session is heavy, stateful, and can interact with logged-in sessions; not safe to hand to a peer client without per-call confirmation, which MCP stdio cannot model cleanly.
- `planner_*` — planner is internal control plane; exposing it would let peers steer Quilin's main loop. Planner exposure is deferred to a later stage with explicit auth.
- `memory_observe` — internal-only (already in `INTERNAL_MCP_TOOL_NAMES`); never exposed in either direction.

- `shell_exec` —— 任意 shell；按 `WriteAuthority` 是 CRITICAL。通过 MCP 暴露相当于对任何 peer client 开 RCE（远程代码执行）口子
- `file_write` —— 项目根外的写文件是 CRITICAL；同样属于 RCE 级风险
- `web_browse` —— Patchright 完整浏览器会话又重又有状态，可能访问已登录站点；交给 peer client 不安全，而 MCP stdio 又难以模型化"每次调用单独确认"
- `planner_*` —— planner 是内部控制面；暴露相当于让 peer 操纵 Quilin 主循环；planner 的暴露推迟到后续阶段并配显式 auth
- `memory_observe` —— 仅内部（已在 `INTERNAL_MCP_TOOL_NAMES` 列表）；两个方向都不暴露

### 2.2 Resources whitelist / 资源白名单

Resources in MCP are read-only addressable blobs. We expose three for Stage 3:

MCP 的 resource 是只读的可寻址内容。Stage 3 暴露三个：

- `quilin://profile` — the user profile store (`~/.quilin/user.md` body, redacted), so peer clients can read who the user is.
- `quilin://skills` — markdown index of installed skills (name + description + path).
- `quilin://recent-sessions` — last N session summaries (count bounded by env var `QUILIN_MCP_SERVER_RECENT_SESSIONS`, default 5).

- `quilin://profile` —— 用户档案（`~/.quilin/user.md` 正文，脱敏后），让 peer client 能读"用户是谁"
- `quilin://skills` —— 已安装 skill 的 markdown 索引（name + description + path）
- `quilin://recent-sessions` —— 最近 N 次 session 摘要（上限由环境变量 `QUILIN_MCP_SERVER_RECENT_SESSIONS` 控制，默认 5）

### 2.3 Prompts / Prompt 模板（optional, parked）

The MCP `prompts/*` family lets a server expose canned prompt templates a client can render. Stage 3 ships **no prompts** to keep the skeleton small. A `prompts/` module can be added later (see Iter J WT-Claude-1's separate prompts work; this server module will then register them).

MCP 的 `prompts/*` 系列允许 server 暴露给 client 使用的预设 prompt 模板。Stage 3 **不出 prompt**，先把骨架做小。后续可以加（Iter J WT-Claude-1 在做 prompts 模块；本 server 模块到时再注册）。

---

## 3. 认证 / Authentication

Stage 3 ships **localhost + stdio only**. The transport is a spawned child process: parent (peer MCP client like Claude Desktop) launches `quilin mcp-serve` as a subprocess and talks over stdio pipes. There is no network listener, so the only attacker model is "another process on this user account spawning Quilin", which is the same trust boundary the user's shell already has. No bearer token is required for Stage 3.

Stage 3 只跑 **localhost + stdio**。transport 走子进程：父进程（Claude Desktop 这种 peer MCP client）把 `quilin mcp-serve` 拉起为子进程，走 stdio 管道通信。**没有网络监听端口**，所以唯一的攻击者模型是"这个用户账号下另一个进程能 spawn Quilin"，跟用户 shell 已有的信任边界一致。Stage 3 不需要 bearer token。

Stage 4 (HTTP) will require a token. The plan is: server reads a single-use token from `~/.quilin/server-token` (mode 0600), or accepts a bearer in `Authorization: Bearer ...`. Every HTTP request that is not `OPTIONS` will be checked + audit-logged to `~/.quilin/audit/mcp-server.jsonl`. The cap "remote = token required + audit log" is a hard constraint, not a config.

Stage 4 (HTTP) 必须带 token。计划：server 从 `~/.quilin/server-token`（权限 0600）读单次 token，或接受 `Authorization: Bearer ...` 头。除 `OPTIONS` 外的 HTTP 请求全部检查 + 审计日志写到 `~/.quilin/audit/mcp-server.jsonl`。"远程 = token + 审计" 是硬约束，不是配置项。

Stage 5 (registry) will additionally need workspace-level scoping (which workspace's tokens are allowed in), but that is out of scope here.

Stage 5（注册表）还要加 workspace 层面的限定（哪个 workspace 的 token 才允许进来），但本 note 范围之外。

---

## 4. Stage 划分 / Stage Breakdown

| Stage | Transport | Auth | Scope | This skeleton |
|-------|-----------|------|-------|---------------|
| **Stage 3** | stdio (subprocess) | none (localhost trust) | tools (4) + resources (3) whitelist | ✅ shipped |
| Stage 4 | Streamable HTTP | bearer token + audit log | same whitelist; add network bind controls | 🔜 future |
| Stage 5 | n/a (registry) | per-workspace scoped tokens | publish Quilin as a discoverable MCP entry | 🔜 future |

The skeleton in `packages/agent-core/src/mcp/server/` deliberately uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk`, because it makes the whitelist enforcement explicit (we hold the request-handler functions ourselves) and it makes the test surface narrow (we can swap stdio for `InMemoryTransport` in tests without rewriting any handler).

`packages/agent-core/src/mcp/server/` 里的骨架特意用 `@modelcontextprotocol/sdk` 的低级 `Server` 类（不是 `McpServer`），原因有二：白名单强制可以显式控制（请求 handler 在我们自己手里），测试面也变窄（在测试里把 stdio 换成 `InMemoryTransport` 不用改任何 handler）。

The skeleton accepts an injectable `ToolBridge` and `ResourceBridge`, which are the seams where the real `quilin-mem` / browser / skill catalog plug in later. Stage 3 tests use mock bridges (the doc you are reading lives in `docs/research/...`, not in product docs, because mock-backed code is not a shippable feature on its own).

骨架接收可注入的 `ToolBridge` 和 `ResourceBridge`，这两个就是未来 `quilin-mem` / 浏览器 / skill 目录接入的缝。Stage 3 测试用 mock bridge（这篇 doc 放在 `docs/research/...` 而不是产品文档里，因为基于 mock 的代码本身还不是可发布的功能）。

---

## 5. A2A federation 关系 / A2A Federation Touchpoint

Google's **A2A** (Agent-to-Agent) protocol uses an **Agent Card** — a JSON document at `/.well-known/agent.json` — to declare an agent's identity, capabilities, and endpoints to other agents in a cross-vendor mesh. Quilin's MCP-server effort and A2A converge at one point: **the whitelist that gates MCP tool exposure is the same whitelist that should populate the A2A Agent Card's `capabilities` field**.

Google 的 **A2A**（Agent-to-Agent）协议用 **Agent Card** —— `/.well-known/agent.json` 的 JSON 文档 —— 声明 agent 的身份、能力和接入点，给跨厂商 mesh 里别的 agent 看。Quilin 的 MCP-server 和 A2A 有一个汇合点：**MCP 工具暴露用的白名单，正好也是 A2A Agent Card `capabilities` 字段要列的东西**。

Implication: `exposed-tools.ts` and `exposed-resources.ts` are the single source of truth — Stage 4 will read from them to render `/.well-known/agent.json`, and Stage 5 (registry) will publish the resulting card. No A2A code is written in this skeleton, but the data shape is already aligned (each whitelist entry has `name` + `description` + `schema`, which maps cleanly to A2A's capability descriptor).

含义：`exposed-tools.ts` 和 `exposed-resources.ts` 是单一真相源 —— Stage 4 会从这里渲染 `/.well-known/agent.json`，Stage 5（注册表）会发布生成的 card。这个骨架不写任何 A2A 代码，但数据结构已经对齐（每条白名单都有 `name` + `description` + `schema`，正好映射到 A2A 的 capability descriptor）。

---

## 6. 非目标 / Non-Goals (Stage 3 skeleton)

- **No real `quilin-mem` wiring.** Bridges are pluggable; the test suite drives them with mocks. The skeleton intentionally does not import the Python `quilin-mem` provider — that integration ships with Stage 3.1.
- **No HTTP listener.** No `streamableHttp` import in this skeleton.
- **No registry, no `/.well-known/agent.json`.** Stage 5.
- **No prompts.** Domain 02 / WT-Claude-1 owns prompts; this server module will register them once they exist.
- **No cross-process tracing.** OTel context propagation across the MCP stdio boundary is filed as a follow-up under domain 08.

- **不真正接 `quilin-mem`**：bridge 可插，测试用 mock 驱动；骨架不 import Python `quilin-mem` provider —— 该集成留给 Stage 3.1
- **没有 HTTP 监听**：骨架不 import `streamableHttp`
- **没有注册表，没有 `/.well-known/agent.json`**：Stage 5 做
- **没有 prompts**：领域 02 / WT-Claude-1 在做 prompts；这里只在以后注册
- **没有跨进程 trace**：跨 MCP stdio 的 OTel context 传播作为后续 issue 挂在领域 08 下

---

## 7. 实现地图 / Code Map

```
packages/agent-core/src/mcp/server/
├── quilin-mcp-server.ts        # Server class + stdio entrypoint + handler wiring
├── exposed-tools.ts            # tool whitelist + ToolBridge interface + mock factory
├── exposed-resources.ts        # resource whitelist + ResourceBridge interface + mock factory
├── quilin-mcp-server.test.ts   # ≥6 tests via InMemoryTransport
└── index.ts                    # barrel
```

Re-exported from `packages/agent-core/src/mcp/index.ts` so callers say `from "../mcp/server"`.

通过 `packages/agent-core/src/mcp/index.ts` re-export，调用方写 `from "../mcp/server"`。

---

## 8. 后续 / Follow-ups

| Linear (proposed) | Stage | Description |
|-------------------|-------|-------------|
| (new sub-issue) | 3.1 | Wire real `quilin-mem` MCP client into `ToolBridge.memory_recall` / `memory_save`; add CLI command `quilin mcp-serve`. |
| (new sub-issue) | 4 | Add `StreamableHTTPServerTransport`, token auth, audit log. |
| (new sub-issue) | 5 | `/.well-known/agent.json` renderer + registry publish. |
| (new sub-issue) | A2A | Agent Card spec compliance + cross-vendor handshake tests with Goose / Claude Desktop. |

| Linear（待开） | 阶段 | 说明 |
|----------------|------|------|
| (新子 issue) | 3.1 | 把真的 `quilin-mem` MCP client 接到 `ToolBridge.memory_recall` / `memory_save`；加 CLI 子命令 `quilin mcp-serve` |
| (新子 issue) | 4 | 加 `StreamableHTTPServerTransport`、token 鉴权、审计日志 |
| (新子 issue) | 5 | `/.well-known/agent.json` 渲染器 + 注册表发布 |
| (新子 issue) | A2A | Agent Card 协议合规 + 与 Goose / Claude Desktop 跨厂商握手测试 |

Sub-issues should be opened only when work starts — keep Linear free-plan budget headroom (see CLAUDE.md "Linear 免费额度纪律").

子 issue 等真开工时再建 —— 留 Linear 免费额度（见 CLAUDE.md 的 Linear 免费额度纪律）。
