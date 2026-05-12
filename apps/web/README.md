# Quilin Web — Next.js 控制台 / Next.js Console

> Linear: [QUI-154](https://linear.app/quilin-agent/issue/QUI-154) · supersedes legacy dashboard ([QUI-105](https://linear.app/quilin-agent/issue/QUI-105))
> Spec: [docs/08-observability/web-ui-rebuild-plan.md](../../docs/08-observability/web-ui-rebuild-plan.md)

## 概述 / Overview

English: `@quilin/web` is the production-grade Web UI for Quilin Agent. It is a Next.js 15 + React 19 + AI Elements + shadcn/ui application that talks to the local `agent-core` runtime over the typed `/api/v2/*` control-plane API. It replaces the legacy 7-panel vanilla-JS dashboard (`packages/agent-core/src/observability/dashboard-ui/`, served at `/dashboard`), which stays in tree for parity comparison until functional parity is reached.

中文：`@quilin/web` 是 Quilin Agent 的生产级 Web UI。它是一个 Next.js 15 + React 19 + AI Elements + shadcn/ui 应用，通过类型化的 `/api/v2/*` control-plane API（控制面 API）与本地 `agent-core` 运行时通信。它替代旧版 7-panel vanilla-JS dashboard（`packages/agent-core/src/observability/dashboard-ui/`，挂在 `/dashboard` 路径下）；旧版在功能对等前继续保留在仓库中作为对照。

English: The visual design has been locked in `apps/web-demo/` (static HTML preview) and is the single source of truth for layout, typography, color, and motion. This Next.js app ports that design into a live, data-bound implementation.

中文：视觉设计已在 `apps/web-demo/` 中以静态 HTML 形式锁定，是布局、字体、颜色、动效的唯一真相源。本 Next.js 应用把该设计移植为活的、数据绑定的实现。

## 开发 / Development

English: From the repo root, install workspace dependencies once, then start both the agent-core runtime and the web dev server in parallel.

中文：在仓库根目录先安装一次 workspace 依赖，然后并行启动 agent-core 运行时和 web 开发服务器。

```bash
# 一次性安装 / one-time install
pnpm install

# 终端 1 / terminal 1 — agent-core runtime（监听 control-plane API）
just dev          # 或 just dev-once（无 watch）

# 终端 2 / terminal 2 — web dev server
just web-dev      # → http://localhost:3000
```

English: The web app reads `QUILIN_CONTROL_PLANE_URL` (or `NEXT_PUBLIC_API_BASE`) to locate the agent-core API. agent-core binds to `127.0.0.1:<port>` where the port is allocated dynamically and printed at startup; copy that URL into `.env.local` before starting the web dev server.

中文：web 应用从 `QUILIN_CONTROL_PLANE_URL`（或 `NEXT_PUBLIC_API_BASE`）读取 agent-core API 地址。agent-core 绑定 `127.0.0.1:<port>`，端口在启动时动态分配并打印；把该 URL 复制到 `.env.local` 后再启动 web 开发服务器。

```bash
# apps/web/.env.local
NEXT_PUBLIC_API_BASE=http://127.0.0.1:53217   # 用 agent-core 启动时打印的端口
```

English: Cross-origin requests are denied by agent-core (`127.0.0.1` only). The Next.js dev server proxies API calls through `app/api/proxy/[...path]/route.ts` to keep all traffic same-origin from the browser's perspective.

中文：跨域请求被 agent-core 拒绝（仅 `127.0.0.1`）。Next.js 开发服务器通过 `app/api/proxy/[...path]/route.ts` 代理 API 调用，从浏览器视角保持同源。

## 构建 / Build

English: Run the production build locally to validate output before pushing.

中文：本地跑一次生产构建以验证产物，然后再推。

```bash
just web-build              # Next.js production build
just web-typecheck          # tsc --noEmit
just web-lint               # biome check
```

English: The build emits to `apps/web/.next/`. CI caches `.next/cache` keyed on source file hashes; locally you may clear it with `rm -rf apps/web/.next` if you suspect stale state.

中文：构建产物落在 `apps/web/.next/`。CI 以源码哈希为 key 缓存 `.next/cache`；本地若怀疑有陈旧状态，可用 `rm -rf apps/web/.next` 清掉。

## 测试 / Testing

English: Hard rule per CLAUDE.md: coverage threshold is **95%** lines/branches/funcs/stmts (not the common 80%). Cross-review subagents will reject changes that drop coverage below the bar.

中文：硬规则（按 CLAUDE.md）：覆盖率门槛 **95%** lines/branches/funcs/stmts（不是 common 的 80%）。cross-review subagent 会拒绝把覆盖率拉低于门槛的改动。

```bash
just web-test               # vitest run (unit + component)
just web-test-coverage      # vitest run --coverage (95% gate)
just web-e2e                # playwright (启动 dev server + mock agent-core)
```

English: Unit tests live in `tests/unit/` (Vitest + Testing Library). End-to-end tests live in `tests/e2e/` (Playwright). Visual regression snapshots compare key pages against the locked demo. Run `just test-all` from the repo root to execute the entire matrix (agent-core + web + Python + Rust).

中文：单元测试在 `tests/unit/`（Vitest + Testing Library）。端到端测试在 `tests/e2e/`（Playwright）。视觉回归 snapshot 把关键页与锁定的 demo 对比。在仓库根目录跑 `just test-all` 执行完整矩阵（agent-core + web + Python + Rust）。

## 设计参考 / Design reference

English: Two pieces of documentation are the design source of truth:

中文：以下两份是设计真相源：

- **`apps/web-demo/index.html`** — static visual demo (locked layout, typography, color tokens, motion patterns). Do not modify this file from inside `apps/web/` work; visual changes go through a separate demo iteration.
- **`docs/08-observability/web-ui-rebuild-plan.md`** — full spec including file structure (§3), backend API contract (§4), phased delivery (§6), migration strategy (§7), test strategy (§8), and cross-review plan (§9).

- **`apps/web-demo/index.html`** — 静态视觉 demo（锁定的布局、字体、颜色 token、动效模式）。不要在 `apps/web/` 工作中改动这个文件；视觉变更走单独的 demo 迭代。
- **`docs/08-observability/web-ui-rebuild-plan.md`** — 完整 spec，包含文件结构（§3）、后端 API 契约（§4）、分阶段交付（§6）、迁移策略（§7）、测试策略（§8）、cross-review 计划（§9）。

English: Strict design bans (from the locked demo): no Inter / Roboto / Space Grotesk fonts; no purple-violet gradients; no glassmorphism on gradient backgrounds; no emoji as structural icons. The chosen typeface stack is Cormorant Garamond + Noto Serif SC + Noto Sans SC + JetBrains Mono.

中文：严格的设计禁用项（来自锁定的 demo）：禁 Inter / Roboto / Space Grotesk 字体；禁蓝紫渐变；禁玻璃拟态叠渐变背景；禁用 emoji 作结构性图标。字体栈：Cormorant Garamond + Noto Serif SC + Noto Sans SC + JetBrains Mono。

## 已知限制 / Known limitations

English: Phase 1 scope is intentionally narrow. The following are explicitly **not** wired in Phase 1a (foundation):

中文：Phase 1 的范围有意收得很窄。以下功能在 Phase 1a（地基）阶段**没有**接入：

- **Live event streaming** — SSE (`/api/v2/events`) lands in Phase 1b. Phase 1a renders static snapshots only.
- **Authority gate UI** — the real-time approve/deny flow for CRITICAL operations lands in Phase 1b.
- **Config writes** — POST `/api/v2/config` and other write paths land in Phase 1c.
- **Self-evolution governance, planning intelligence, multi-agent lifecycle, safety surfaces, memory depth, multimodal tools** — these are Phase 2–7 and tracked under separate Linear issues.

- **直播事件流** — SSE（`/api/v2/events`）在 Phase 1b 落。Phase 1a 只渲染静态快照。
- **Authority gate UI** — CRITICAL 操作的实时批准/拒绝流程在 Phase 1b 落。
- **Config 写入** — POST `/api/v2/config` 等写入路径在 Phase 1c 落。
- **自演化治理、规划智能、多代理生命周期、安全面、记忆深度、多模态工具** — 属于 Phase 2–7，由独立 Linear issue 跟踪。

English: The legacy 7-panel dashboard remains accessible at `http://127.0.0.1:<agent-core-port>/dashboard` and continues to serve until functional parity is reached. See [`docs/08-observability/web-ui-migration-guide.md`](../../docs/08-observability/web-ui-migration-guide.md) for the coexistence and switchover policy.

中文：旧版 7-panel dashboard 仍可在 `http://127.0.0.1:<agent-core-port>/dashboard` 访问，并继续 serve，直到功能对等。共存与切换策略见 [`docs/08-observability/web-ui-migration-guide.md`](../../docs/08-observability/web-ui-migration-guide.md)。
