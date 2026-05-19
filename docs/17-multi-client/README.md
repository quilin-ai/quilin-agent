# 多端口客户端工程（Multi Client Engineering）

> **实现状态（2026-05-20 校准 / 2026-05-20 calibration）**
>
> Quilin Agent 通过 4 个独立的"壳"（客户端）连接到同一个 agent server。各壳完成度差异较大，本章节聚焦于现状快照、跨端口共享契约和后续工作清单。
>
> Quilin Agent connects to a single agent server through 4 independent "shells" (clients). Their completion levels differ significantly. This section focuses on a current-state snapshot, cross-surface shared contracts, and the follow-up backlog.
>
> Plane 跟踪 / Plane tracking: [QUI-181](https://plane.so/quilin-agent/projects)（本章节 + 现状快照 / this section + state snapshot），按 client 拆分的实现工作仍由各自 Issue 跟踪（QUI-21 / QUI-84 / QUI-85 / QUI-101 / QUI-105 / QUI-115 / QUI-179）。

> 本文档是 Quilin Agent 工程规格系列的第 17 篇，定义多端口客户端的交付面维度。本章节与 [09 Deployment Runtime](../09-deployment-runtime/README.md) 并列：09 关注打包 / 热更新 / 沙箱生命周期，本章节关注 **agent server 如何被多个独立壳消费**。

---

## 一、问题定义 / Problem Statement

### 1.1 为什么需要多端口 / Why Multiple Clients

Quilin Agent 的核心 Agent Loop 跑在 agent server（Bun + Python MCP）。终端用户在不同场景下需要不同的交互界面：开发者在终端里调试，深度用户开图形化 Web 浏览器，Mac 用户期望原生 app 体验。我们的核心设计是**让 4 个壳共享同一个 agent server**，而不是为每个端口写一份独立 agent。

Quilin Agent's core Agent Loop runs on the agent server (Bun + Python MCP). End users need different interaction surfaces in different contexts: developers debug in a terminal, power users want a graphical web browser, Mac users expect a native app experience. Our core design is to have **4 shells share a single agent server** rather than rewriting the agent per surface.

### 1.2 壳模型 / Shell Model

每个客户端都遵循**壳模型**：
- **壳**只负责 UI、用户输入、显示渲染
- **agent server** 跑核心 loop、工具调用、记忆、规划
- 壳与 server 之间通过明确的协议（stdio / HTTP / WebSocket / UniFFI FFI）通信

Every client follows the **shell model**:
- **Shell** is only responsible for UI, user input, and display rendering
- **agent server** runs the core loop, tool calls, memory, and planning
- Shell-to-server communication uses an explicit protocol (stdio / HTTP / WebSocket / UniFFI FFI)

这避免了功能漂移（每个端口"自己"实现一遍 agent loop 必然产生不一致），也简化了升级（升级 agent server 一处，所有壳同步生效）。

This prevents capability drift (every surface "reimplementing" the agent loop inevitably produces inconsistencies) and simplifies upgrades (upgrade agent server once, all shells benefit).

### 1.3 4 个客户端速览 / 4-Client Overview

| 端口 / Surface | 完成度 / Done | 主要技术栈 / Stack | 进程模型 / Process |
|---|---:|---|---|
| **CLI**（`quilin` 命令） | ~85% | Bun + TypeScript | 单次进程，做完就退 |
| **REPL TUI**（终端交互） | ~80% | Bun + TypeScript + readline | 长驻进程 + slash 命令 |
| **Web**（Next.js 控制台） | ~80% | Next.js + React + Playwright | HTTP/SSE，浏览器壳 |
| **Mac App**（原生客户端） | ~15% | SwiftUI + AppKit + Rust(UniFFI) | 原生进程 + 子进程 supervisor |

| Surface | % Done | Main Stack | Process Model |
|---|---:|---|---|
| **CLI**（`quilin` command） | ~85% | Bun + TypeScript | One-shot, exits after task |
| **REPL TUI**（interactive terminal） | ~80% | Bun + TypeScript + readline | Long-running with slash commands |
| **Web**（Next.js console） | ~80% | Next.js + React + Playwright | HTTP/SSE, browser shell |
| **Mac App**（native client） | ~15% | SwiftUI + AppKit + Rust(UniFFI) | Native process + subprocess supervisor |

---

## 二、CLI（`quilin` 命令） / CLI

### 2.1 现状 / Current State（~85%）

CLI 入口位于 `packages/agent-core/src/index.ts`（package.json `bin: { "quilin": "src/index.ts" }`，使用 Bun shebang 直接可执行）。`packages/agent-core/src/cli/` 子目录提供各 CLI 子命令的实现：
- `cli/config-cmd.ts` —— `quilin config show / set` 配置查询与修改
- `cli/service-cmd.ts` —— `quilin service install / uninstall / start / stop` 系统服务管理（systemd / launchd）
- `cli/first-run-welcome.ts` —— 首次启动欢迎语 + 引导提示

CLI entry: `packages/agent-core/src/index.ts` (package.json `bin: { "quilin": "src/index.ts" }`, Bun shebang makes it directly executable). `packages/agent-core/src/cli/` subdirectory implements CLI subcommands:
- `cli/config-cmd.ts` — `quilin config show / set` for config query and mutation
- `cli/service-cmd.ts` — `quilin service install / uninstall / start / stop` for system service management (systemd / launchd)
- `cli/first-run-welcome.ts` — first-launch welcome banner + onboarding hints

### 2.2 已实现 / Shipped

- ✅ `quilin config show` / `quilin config set <key> <value>` —— 配置级联读写（CLI > ENV > YAML > 默认）
- ✅ `quilin service install / uninstall` —— systemd（Linux）和 launchd（macOS）开机自启服务安装
- ✅ 首次运行欢迎语 + 引导提示（welcome banner + onboarding plan）
- ✅ MCP 服务自动 spawn（quilin-mem / quilin-web），通过 StdioClientTransport 启动
- ✅ Capabilities 热更新四触发器（manual / watch / webhook HMAC-SHA256 / SIGHUP）
- ✅ LocalSandbox 生产模式硬拦截（启动时检查 NODE_ENV，prod 下拒启 LocalSandbox）

Shipped:
- ✅ Config cascade (CLI > ENV > YAML > defaults) via `quilin config show / set <key> <value>`
- ✅ Auto-start service install for systemd (Linux) and launchd (macOS) via `quilin service install / uninstall`
- ✅ First-run welcome banner + onboarding plan
- ✅ Auto-spawn of MCP servers (quilin-mem / quilin-web) via StdioClientTransport
- ✅ Four-trigger capabilities hot reload (manual / watch / webhook HMAC-SHA256 / SIGHUP)
- ✅ LocalSandbox prod-mode hard refusal (boot-time NODE_ENV check)

### 2.3 未实现 / Not Yet

- ❌ `quilin <prompt>` 单次任务模式（`-p` / `--print` 非交互式 prompt 执行）—— 当前未实装
- ❌ `quilin --interactive` 显式进入 REPL（目前 REPL 是默认入口，但应有显式 flag）
- ❌ `quilin agents` / `quilin sessions` / `quilin memory` 等管理子命令 —— Web/REPL 有，CLI 没有

Not yet:
- ❌ `quilin <prompt>` one-shot mode (`-p` / `--print` non-interactive prompt execution) — not yet implemented
- ❌ Explicit `quilin --interactive` flag (REPL is the current default but should have an explicit flag)
- ❌ Management subcommands like `quilin agents` / `quilin sessions` / `quilin memory` — exposed in Web/REPL but not CLI

### 2.4 阻塞 Issue / Blockers

- [QUI-21](https://plane.so/quilin-agent/projects)（09 Runtime：打包、热更新、devcontainer/CD、sandbox 生命周期）
- [QUI-85](https://plane.so/quilin-agent/projects)（补齐 `quilin` CLI 二进制入口与 `config show/set` 可执行命令）

---

## 三、REPL TUI（终端交互） / REPL TUI

### 3.1 现状 / Current State（~80%）

REPL（Read-Eval-Print Loop，读取-求值-打印循环，即"交互式命令行"）TUI（Text User Interface，文本用户界面）实现位于 `packages/agent-core/src/repl.ts`（主文件）+ `packages/agent-core/src/repl/` 子目录（slash 命令处理、agent service bridge、TUI 渲染层）。

REPL (Read-Eval-Print Loop, i.e. "interactive command line") TUI (Text User Interface) is implemented at `packages/agent-core/src/repl.ts` (main file) + `packages/agent-core/src/repl/` subdirectory (slash command handlers, agent service bridge, TUI render layer).

### 3.2 已实现 / Shipped

- ✅ 长驻 REPL 进程，readline 集成
- ✅ Slash 命令：`/resume`（恢复最近会话）、`/resume latest`、`/resume <session-id>`、`/agents`（子 agent 状态）、`/mcp`（MCP 服务管理）、`/reload`（capabilities 热更新触发）
- ✅ 实时追加输入 + 运行中重定向（用户可在 agent 执行过程中插入新指令）
- ✅ Auto-checkpoint 会话恢复（崩溃后自动恢复到最近 checkpoint）
- ✅ 交互 primitives 原生 readline 集成（`ask_user_question`、`request_approval` Path A、`narrate_aside`）—— 2026-05-15 ship
- ✅ TUI 渲染 Iter F 交互 primitives 事件（QUI-101 slash command 筛选 + 测试）

Shipped:
- ✅ Long-running REPL process with readline integration
- ✅ Slash commands: `/resume` (resume most recent session), `/resume latest`, `/resume <session-id>`, `/agents` (sub-agent status), `/mcp` (MCP service management), `/reload` (capabilities hot-reload trigger)
- ✅ Real-time input append + in-flight redirection (user can interject during agent execution)
- ✅ Auto-checkpoint session recovery (auto-resume to most recent checkpoint after crash)
- ✅ Native readline integration for interaction primitives (`ask_user_question`, `request_approval` Path A, `narrate_aside`) — shipped 2026-05-15
- ✅ TUI rendering of Iter F interaction primitives events (QUI-101 slash command filter + tests)

### 3.3 未实现 / Not Yet

- ❌ 富 TUI 重写（基于 Ink / blessed 等组件库）—— 当前是基础 readline，没有面板布局 / 多视图（[QUI-172](https://plane.so/quilin-agent/projects)，Iter G P3）
- ❌ Mouse 支持 / 横幅 / 分屏布局
- ❌ 完整 `/sessions` 列表 + 任意会话切换（[QUI-84](https://plane.so/quilin-agent/projects)）

Not yet:
- ❌ Rich TUI rewrite (Ink / blessed) — current is bare readline, no panel layout / multi-view ([QUI-172](https://plane.so/quilin-agent/projects), Iter G P3)
- ❌ Mouse support / banner / split-screen layout
- ❌ Full `/sessions` list + arbitrary session switching ([QUI-84](https://plane.so/quilin-agent/projects))

### 3.4 阻塞 Issue / Blockers

- [QUI-84](https://plane.so/quilin-agent/projects)（TUI `/resume` 会话列表与任意切换）
- [QUI-101](https://plane.so/quilin-agent/projects)（TUI slash command 筛选与测试，已 ship）
- [QUI-172](https://plane.so/quilin-agent/projects)（Ink TUI 重写 + Cline 风格 VSCode 扩展，Iter G P3）

---

## 四、Web（Next.js 控制台） / Web

### 4.1 现状 / Current State（~80%）

Web 客户端位于 `apps/web/`（独立 Next.js 项目，pnpm workspace member）。这是 4 个客户端中**最完整的一个**，2026-05-15 Iter F web 收尾 + 2026-05-18 Iter J 把它推到了相当完整的状态。

The web client lives at `apps/web/` (standalone Next.js project, pnpm workspace member). It is the **most complete** of the 4 clients; Iter F web close-out (2026-05-15) + Iter J (2026-05-18) pushed it to a substantially complete state.

### 4.2 路由 / Routes

8 个 API 路由（API endpoints）：
- `/api/agents` —— 子 agent 列表 + 生命周期
- `/api/chat` —— 流式聊天（SSE）+ 工具调用透传
- `/api/config` —— 配置查询/修改（与 CLI `quilin config` 对等）
- `/api/mcp` —— MCP 服务列表 + 状态
- `/api/memory` —— 记忆查询 + 知识图谱 dump
- `/api/profile-files` —— `~/.quilin/user.md` / `soul.md` / `QUILIN.md` 查看器
- `/api/sessions` —— SQLite chat 会话 CRUD
- `/api/skills` —— Skills catalog + 操作
- `/api/tools` —— 工具列表 + 状态

7 个页面（pages）：
- `/`（首页 = 聊天界面，带流式输出、per-block streaming state）
- `/config`、`/mcp`、`/memory`（含知识图谱 reactflow viz + consolidation timeline）、`/sessions`、`/skills`、`/tools`

Plus Playwright E2E 测试集（`apps/web/tests/`）+ `playwright.config.ts`。

### 4.3 已实现 / Shipped

- ✅ SQLite chat sessions 持久化（4 slice 完整：schema / read+write / 重启恢复 / DELETE + 原子 seq 分配 + localStorage 迁移）
- ✅ 交互 primitives（`ask_user_question` / `request_approval` Path A + `wrapToolWithApproval` Path B server-side gate，已 wrap `shell_exec`）
- ✅ UX-4 KG 知识图谱重做 4 slice（LLM 三元组抽取 + 反幻觉 + 反注入 + reactflow viz + consolidation timeline）
- ✅ Per-block streaming state（只有 trailing block 显示"正在输出"）
- ✅ 移动端 nav rail + composer safe-area
- ✅ Skills 热更新（SKILL.md 编辑自动 invalidate tool catalog）
- ✅ MCP 服务 `.py` 源码热更新（dev mode 下 fs.watch）
- ✅ Profile 文件查看器（user.md / soul.md / QUILIN.md）
- ✅ Stable 3008 后端（`QUILIN_STABLE_BUILD=1` 触发 `.next-stable-3008/` distDir，避免和 dev `.next/` 冲突，给 Mac App 测试用）

Shipped:
- ✅ SQLite chat session persistence (4 slices: schema / read+write / restart recovery / DELETE + atomic seq alloc + localStorage migration)
- ✅ Interaction primitives (`ask_user_question` / `request_approval` Path A + `wrapToolWithApproval` Path B server-side gate, already wrapping `shell_exec`)
- ✅ UX-4 Knowledge Graph rebuild — 4 slices (LLM triple extraction + anti-hallucination + injection guard + reactflow viz + consolidation timeline)
- ✅ Per-block streaming state (only trailing block shows "streaming" indicator)
- ✅ Mobile nav rail + composer safe-area
- ✅ Skills hot reload (SKILL.md edits auto-invalidate tool catalog)
- ✅ MCP server source hot reload (dev mode fs.watch)
- ✅ Profile file viewer (user.md / soul.md / QUILIN.md)
- ✅ Stable 3008 backend (`QUILIN_STABLE_BUILD=1` triggers `.next-stable-3008/` distDir to avoid conflict with dev `.next/`; serves Mac App testing)

### 4.4 未实现 / Not Yet

- ❌ 生产级 admin 面板（QUI-105 仍 backlog；当前 `/config`、`/mcp`、`/skills`、`/tools` 是开发者视图，不是 end-user 友好面板）
- ❌ 首次使用配置引导（QUI-106 仅 API 骨架，缺前端引导 wizard）
- ❌ Provider live matrix UI（API key / OAuth 凭证状态可视化，仍 candidate）
- ❌ 用户多账户 / 多 workspace 切换

Not yet:
- ❌ Production-grade admin panel (QUI-105 still backlog; current `/config` / `/mcp` / `/skills` / `/tools` are dev views, not end-user friendly panels)
- ❌ First-run config wizard (QUI-106 has API skeleton only, frontend wizard missing)
- ❌ Provider live matrix UI (visualization of API key / OAuth credential status, still candidate)
- ❌ Multi-account / multi-workspace switching

### 4.5 阻塞 Issue / Blockers

- [QUI-105](https://plane.so/quilin-agent/projects)（生产级 TUI 与 Web 控制台：会话、Skill、MCP、配置与 Provider 管理）
- [QUI-106](https://plane.so/quilin-agent/projects)（首次使用配置引导）
- [QUI-115](https://plane.so/quilin-agent/projects)（Web 控制台前端框架选型与路由设计 —— 已基本确定 Next.js + React + reactflow）

---

## 五、Mac App（原生客户端） / Mac App

### 5.1 现状 / Current State（~15%）

Mac App 是 4 个客户端中**最不完整、最新启动**的一个。代码在**独立仓库** `~/repo/quilin-agent-mac-app/`，目录结构：

```
~/repo/quilin-agent-mac-app/
├── QuilinAgent/                # SwiftUI 项目源码（views / models / Bridge bindings）
├── QuilinAgent.xcodeproj/      # Xcode 项目（已初始化）
├── QuilinAgentTests/           # 单元测试
├── QuilinAgentUITests/         # UI 测试
└── README.md                   # 双语架构文档（5/14 ship，4671 字节）
```

Mac App is the **least complete and most recently started** of the 4 clients. Code is in a **separate repo** `~/repo/quilin-agent-mac-app/` (structure above).

最近 commit / Last commit: `be41381 docs: create bilingual README for native mac app architecture`（2026-05-15）。

### 5.2 架构 / Architecture

Mac App 采用 **"Native Shell + Rust Supervisor + Multi-Language Core"** 三层混合架构：

Mac App uses a **"Native Shell + Rust Supervisor + Multi-Language Core"** three-tier hybrid architecture:

1. **Native Shell**（本仓库 `~/repo/quilin-agent-mac-app/`）：SwiftUI + AppKit，负责 120Hz 流畅动画、侧边栏渲染、内置原生浏览器（WKWebView）、全局热键唤起。通过 UniFFI 零开销同步调用 Rust Bridge。
2. **Rust Supervisor & Bridge**（quilin-agent 本仓库 `crates/quilin-bridge/`）：作为守护进程和通信枢纽。通过 UniFFI 暴露 C-ABI 接口给 Swift，同时管理 TypeScript (Bun) 和 Python 进程的生命周期。将 macOS 原生能力（ScreenCaptureKit 截图、CGEvent 鼠标注入）包装成 MCP Server 接口供 agent core 消费。
3. **Logic Engine**（quilin-agent 本仓库 `packages/agent-core/` + `providers/memory/`）：核心 Agent Loop 跑在 Bun，记忆服务跑在 Python。与 UI 完全解耦。

1. **Native Shell** (this repo): SwiftUI + AppKit, responsible for 120Hz smooth animations, sidebar rendering, in-app WKWebView, and global hotkey invocation. Calls Rust Bridge via zero-overhead synchronous UniFFI.
2. **Rust Supervisor & Bridge** (in quilin-agent's `crates/quilin-bridge/`): daemon + communication hub. Exposes C-ABI to Swift via UniFFI, manages TS (Bun) and Python process lifecycles, wraps macOS-native capabilities (ScreenCaptureKit screen capture, CGEvent mouse injection) as MCP Server interfaces for agent core.
3. **Logic Engine** (in quilin-agent's `packages/agent-core/` + `providers/memory/`): core Agent Loop in Bun, memory service in Python. Fully decoupled from UI.

### 5.3 已实现 / Shipped

- ✅ Xcode 项目 init（QuilinAgent.xcodeproj 已生成）
- ✅ 双语架构 README（4671 字节，2026-05-15 commit `be41381`）
- ✅ `crates/quilin-bridge/`（本仓库）—— Rust 桥骨架 ship（QUI-179，commit `10769af`），包含 `lib.rs` + `supervisor.rs`（192 LOC）+ `build-mac.sh` + UniFFI 0.28
  - `start_agent(workspace_root)` —— spawn Bun agent-core 子进程
  - `stop_agent()` —— 终止子进程
  - `get_status()` —— `AgentStatus { is_running, current_task }`
  - `get_dashboard_port()` —— 解析 agent-core stdout 拿到的 dashboard 端口

Shipped:
- ✅ Xcode project init (QuilinAgent.xcodeproj generated)
- ✅ Bilingual architecture README (4,671 bytes, commit `be41381` on 2026-05-15)
- ✅ `crates/quilin-bridge/` (this repo) — Rust bridge skeleton shipped (QUI-179, commit `10769af`), containing `lib.rs` + `supervisor.rs` (192 LOC) + `build-mac.sh` + UniFFI 0.28
  - `start_agent(workspace_root)` — spawn Bun agent-core subprocess
  - `stop_agent()` — terminate subprocess
  - `get_status()` — `AgentStatus { is_running, current_task }`
  - `get_dashboard_port()` — port parsed from agent-core stdout

### 5.4 未实现 / Not Yet

- ❌ SwiftUI views（侧边栏、聊天界面、设置面板）—— 仅有 placeholder
- ❌ Bridge 实际集成测试（README 提到的 "Quick Start" 脚本未写）
- ❌ ScreenCaptureKit 截图 / CGEvent 鼠标注入的 MCP 包装
- ❌ 全局热键唤起（Cmd+Shift+Q 之类）
- ❌ 内置 WKWebView 浏览器
- ❌ 跨架构 universal binary（当前 `build-mac.sh` 只构建当前 Mac 架构，未 `lipo` 合 x86_64 + aarch64）
- ❌ App Store 签名 / Notarization
- ❌ 自动更新机制

Not yet:
- ❌ SwiftUI views (sidebar, chat surface, settings panel) — placeholder only
- ❌ Bridge real integration tests (the README's "Quick Start" script not written)
- ❌ MCP wrappers for ScreenCaptureKit screenshots / CGEvent mouse injection
- ❌ Global hotkey invocation (e.g., Cmd+Shift+Q)
- ❌ In-app WKWebView browser
- ❌ Universal binary across architectures (current `build-mac.sh` only builds the host arch, no `lipo` for x86_64 + aarch64)
- ❌ App Store signing / Notarization
- ❌ Auto-update mechanism

### 5.5 阻塞 Issue / Blockers

- [QUI-179](https://plane.so/quilin-agent/projects)（Mac 客户端 Rust 桥骨架现状追踪 + commit 时机 + 09 Deployment 子段安排）

---

## 六、跨端口共享契约 / Cross-Surface Shared Contracts

4 个客户端共享以下契约（这些是"壳模型"成立的前提）：

The 4 clients share the following contracts (these are the foundation of the "shell model"):

| 契约 / Contract | 当前实现 / Implementation | 备注 / Notes |
|---|---|---|
| **配置级联** Config cascade | `packages/agent-core/src/config/loader.ts` | CLI > ENV > YAML > 默认。CLI / REPL / Web 都用同一个 loader |
| **记忆 MCP 协议** Memory MCP protocol | `providers/memory/src/quilin_mem/server.py`（stdio） | 4 端口全部通过 stdio MCP 连接 quilin-mem |
| **工具协议** Tool protocol | `packages/agent-core/src/tools/router.ts` | 10 内置工具 + MCP bridge,所有壳消费同一个 ToolRouter |
| **会话存储** Session storage | `apps/web/lib/sessions-db/`（SQLite）+ TUI auto-checkpoint | Web 持久化用 SQLite,TUI 用 checkpoint;**未完全统一**(后续工作) |
| **交互 primitives** | `ask_user_question` / `request_approval` / `narrate_aside` | TUI(readline)+ Web(SSE)都已 ship;Mac App 未实现 |
| **热更新** Hot reload | 四触发器(manual / watch / webhook HMAC / SIGHUP) | CLI / Web 已通,TUI 通过 `/reload` 命令,Mac App 未实现 |
| **观测** Observability | JSON spans + Control Plane API(`/snapshot` / `/sessions` / `/traces`) | Web 有 Dashboard 接通;CLI / REPL 输出日志到 stdout;Mac App 未实现 |

---

## 七、后续工作 / Follow-up

### 7.1 短期 / Short-term

- **Mac App SwiftUI views 实装** —— 把 `~/repo/quilin-agent-mac-app/QuilinAgent/Views/` 从 placeholder 推到能跑 chat 的最小可用版本(MVP)
- **Bridge 集成测试** —— `crates/quilin-bridge/` 当前缺集成测试,需要补 Swift 端 + Rust 端的 round-trip 测试
- **统一会话存储** —— TUI auto-checkpoint 和 Web SQLite 之间的数据迁移路径(目前用户在 TUI 开的会话在 Web 里看不到)

- Implement Mac App SwiftUI views — move `~/repo/quilin-agent-mac-app/QuilinAgent/Views/` from placeholder to MVP that can run chat
- Bridge integration tests — `crates/quilin-bridge/` lacks integration tests; need Swift-side + Rust-side round-trip
- Unify session storage — migration path between TUI auto-checkpoint and Web SQLite (TUI-opened sessions are invisible in Web)

### 7.2 中期 / Mid-term

- **TUI Ink 重写**(QUI-172,Iter G P3)—— 富 TUI 组件库 + 面板布局 + mouse 支持
- **Web 生产级 admin 面板**(QUI-105)—— end-user 友好的会话 / Skill / MCP / Provider 管理
- **Mac App macOS 原生能力包装**(MCP)—— ScreenCaptureKit 截图 + CGEvent 鼠标注入,作为 MCP 服务暴露给 agent core,让 Mac 用户的 agent 可以"看屏幕 + 控制鼠标"

- TUI Ink rewrite (QUI-172, Iter G P3) — rich TUI components + panel layout + mouse support
- Web production-grade admin panel (QUI-105) — end-user-friendly session / Skill / MCP / Provider management
- Mac App macOS-native capability wrappers (MCP) — ScreenCaptureKit screen capture + CGEvent mouse injection, exposed as MCP services so the Mac user's agent can "see the screen + control the mouse"

### 7.3 长期 / Long-term

- **Windows / Linux 原生客户端** —— Mac App 架构文档里明确提到 Bridge 是平台无关的,可复用于 Windows (WinUI) 或 Linux (Qt / GTK) 客户端
- **移动端**(iOS / Android)—— Bridge 同样可复用;UI 层重写

- Windows / Linux native clients — the Mac App architecture explicitly notes the Bridge is platform-independent and reusable for Windows (WinUI) or Linux (Qt / GTK) clients
- Mobile (iOS / Android) — Bridge is reusable; UI layer rewrite

---

## 八、相关文档 / Related Docs

- [09 Deployment Runtime](../09-deployment-runtime/README.md) —— 打包 / 热更新 / 沙箱生命周期(本章节的工程基础)
- [00 Core Loop](../00-core-loop/README.md) —— agent server 的核心 loop(所有壳消费的对象)
- [05 Tool](../05-tool/README.md) —— 工具协议(壳 ↔ ToolRouter 接口)
- [08 Observability](../08-observability/README.md) —— Web Dashboard 7 面板(Web 客户端的观测部分)
- `~/repo/quilin-agent-mac-app/QuilinAgent/README.md` —— Mac App 仓库的双语架构文档(本章节 §五 的来源)
