# Web UI 迁移指南 / Web UI Migration Guide

> Linear: [QUI-154](https://linear.app/quilin-agent/issue/QUI-154) · supersedes [QUI-105](https://linear.app/quilin-agent/issue/QUI-105)
> Companion to: [web-ui-rebuild-plan.md](./web-ui-rebuild-plan.md)
> Status: living document · updated each phase

## 概述 / Overview

English: This guide documents how the new Next.js-based Web UI (`apps/web/`, package `@quilin/web`) replaces the legacy vanilla-JS dashboard (`packages/agent-core/src/observability/dashboard-ui/`, served at `/dashboard`) over the course of QUI-154 Phase 1 → Phase 7. The two stacks coexist on disk and at runtime until functional parity is reached; this document captures the coexistence rules, the per-panel mapping from old to new, environment changes, the switchover procedure, and the rollback plan.

中文：本指南记录新版 Next.js Web UI（`apps/web/`、package `@quilin/web`）如何在 QUI-154 Phase 1 → Phase 7 过程中替换旧版 vanilla-JS dashboard（`packages/agent-core/src/observability/dashboard-ui/`，挂在 `/dashboard`）。两套栈在磁盘和运行时同时存在，直到功能对等；本文档涵盖共存规则、旧 panel → 新 panel 映射、环境变量变化、切换流程、回滚方案。

English: The migration is intentionally conservative — the legacy code is **never** deleted in Phase 1. Removal happens in a single deliberate commit after the user confirms parity.

中文：迁移有意保守——旧代码在 Phase 1 阶段**永不**删除。功能对等后由用户确认，再用一次明确的 commit 移除。

## 并存阶段 / Coexistence phase

English: During Phase 1 and beyond, the agent-core runtime exposes both UIs from the same HTTP listener bound to `127.0.0.1:<port>` (port allocated at startup). On `quilin` start, the boot log prints both URLs in JSON to stdout so the user and any observing agents can pick which to open.

中文：从 Phase 1 起，agent-core 运行时把两套 UI 都挂在同一个绑定 `127.0.0.1:<port>` 的 HTTP listener 上（端口启动时分配）。`quilin` 启动时，boot log 以 JSON 形式向 stdout 打印两个 URL，用户和观察的 agent 都能选择打开哪个。

```text
http://127.0.0.1:53217/dashboard       ← legacy 7-panel UI (read-only, kept for parity)
http://127.0.0.1:3000/                 ← new Next.js Web UI (apps/web dev server)
```

English: Operationally, the legacy dashboard is **embedded** in agent-core and starts automatically; the new Next.js app is a **separate process** started via `just dev-web` (or `pnpm --filter @quilin/web dev`). The Next.js app proxies all API calls to agent-core through `apps/web/app/api/proxy/[...path]/route.ts`, so the user only ever points the browser at the Next.js port.

中文：运行上，旧版 dashboard **嵌入**在 agent-core 中，自动启动；新版 Next.js 应用是**独立进程**，通过 `just dev-web`（或 `pnpm --filter @quilin/web dev`）启动。Next.js 应用通过 `apps/web/app/api/proxy/[...path]/route.ts` 代理所有 API 调用到 agent-core，所以用户只需把浏览器指向 Next.js 端口。

English: The two UIs **share the same agent-core process** — they read the same in-memory state through different HTTP endpoints (`/api/dashboard/*` for legacy, `/api/v2/*` for new). There is no double-counting, no replication, no separate database.

中文：两套 UI **共享同一个 agent-core 进程**——通过不同的 HTTP endpoint 读同一份内存状态（旧版用 `/api/dashboard/*`，新版用 `/api/v2/*`）。没有重复计数、没有复制、没有独立数据库。

## 旧 → 新对照表 / Old → New mapping

English: Each row maps a legacy 7-panel dashboard surface to its new home in the Next.js app. The legacy panel is the source of truth for **functionality** that the new app must reach before removal; the locked demo at `apps/web-demo/` is the source of truth for **visual design**.

中文：每一行把旧版 7-panel 的一个面映射到新版 Next.js 应用的对应位置。旧 panel 是**功能**真相源，新版在移除前必须功能对等；锁定的 demo（`apps/web-demo/`）是**视觉**真相源。

| Legacy panel (旧版 panel) | Legacy URL / 路径 | New page / 新页 | New component / 新组件 | Phase | Status |
|---|---|---|---|---|---|
| Sessions list | `/dashboard#sessions` | `/sessions` | `components/rails/SessionsList.tsx` | 1a | scaffold |
| Single session detail | `/dashboard#session/:id` | `/sessions/[id]` | `components/conversation/*` | 1b | pending |
| Live event stream | `/dashboard#events` | `/sessions/[id]` (embedded) | `useEventStream` hook + `Process` | 1b | pending |
| Memory tiers | `/dashboard#memory` | `/memory` | `components/rails/MemoryPanel.tsx` | 1b | pending |
| Skills catalog | `/dashboard#skills` | `/skills` | `app/skills/page.tsx` | 1b | pending |
| Tools / MCP registry | `/dashboard#tools`, `/dashboard#mcp` | `/tools`, `/mcp` | `app/tools/page.tsx`, `app/mcp/page.tsx` | 1b | pending |
| Config viewer | `/dashboard#config` | `/config` | `app/config/page.tsx` | 1c | pending |
| Authority gate (CRITICAL approval) | inline modal | floating drawer | `components/shell/AuthorityDrawer.tsx` | 1b | pending |
| Self-evolution proposals | not in legacy | `/evolution` | TBD | 2 | not started |
| Planning trace | not in legacy | `/planning` | TBD | 3 | not started |

English: The "Phase" column tracks when the new surface reaches parity with the legacy one. The "Status" column is updated as work lands; cross-review subagents verify Status transitions against actual commits (per CLAUDE.md status-evidence discipline).

中文："Phase" 列追踪新版面达到旧版功能对等的时间。"Status" 列随工作落地更新；cross-review subagent 按 CLAUDE.md 的状态声明实证纪律对照实际 commit 验证 Status 转换。

## 配置变化 / Config changes

English: The new web app introduces two environment variables consumed by `apps/web/`. The legacy dashboard requires no env changes — it continues to read its config from the agent-core in-process state.

中文：新版 web 应用引入两个由 `apps/web/` 消费的环境变量。旧版 dashboard 不需要任何环境变量变化——它继续从 agent-core 的进程内状态读配置。

| Variable / 变量 | Where read / 读取位置 | Purpose / 用途 | Default / 默认 |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE` | `apps/web/lib/api.ts` | Browser-side base URL for `/api/v2/*` calls (proxied) | `http://127.0.0.1:0` (must override per-session) |
| `QUILIN_CONTROL_PLANE_URL` | `apps/web/app/api/proxy/[...path]/route.ts` | Server-side (Next.js route handler) target for proxy | inherits `NEXT_PUBLIC_API_BASE` if unset |
| `QUILIN_DASHBOARD_PORT` | `packages/agent-core/src/control-plane/handler.ts` (existing) | Legacy dashboard port hint (still respected) | dynamic (0 = OS-assigned) |
| `QUILIN_WEB_PORT` | `apps/web/package.json` `dev` script (new) | New Next.js dev server port | `3000` |

English: agent-core continues to expose `/api/dashboard/*` (legacy) and `/api/v2/*` (new) on the **same** port. There is no second listener; the port is the same one agent-core has always used. The legacy `QUILIN_DASHBOARD_PORT` is retained as a hint variable for the agent-core port, not a separate process port.

中文：agent-core 在**同一**端口上继续暴露 `/api/dashboard/*`（旧）和 `/api/v2/*`（新）。没有第二个 listener；端口仍是 agent-core 一直用的那个。旧的 `QUILIN_DASHBOARD_PORT` 作为 agent-core 端口的提示变量保留，不是独立进程端口。

English: For local development, place a `.env.local` in `apps/web/` (gitignored) with at minimum `NEXT_PUBLIC_API_BASE` set to whatever URL agent-core prints at startup.

中文：本地开发时，在 `apps/web/` 放一个 `.env.local`（已被 gitignore），至少设置 `NEXT_PUBLIC_API_BASE` 为 agent-core 启动时打印的 URL。

## 切换步骤 / Switchover steps

English: The switchover from legacy to new is **gated on functional parity**, not a calendar date. Switchover may happen only after Phase 1c lands (write paths) and at least one full review cycle confirms the new app covers every legacy panel listed above. The steps below are executed in a single PR by the user (or by an agent under explicit user instruction).

中文：从旧版切到新版**以功能对等为门槛**，不按日历日期。切换只能在 Phase 1c（写入路径）落地、并且至少一次完整 review 循环确认新版覆盖了上表所有旧 panel 后才发生。下面的步骤由用户（或在用户明确指示下的 agent）在一个 PR 内执行。

1. **Verify parity** / 验证对等
   - For each row in the mapping table, run the legacy URL and the new URL side by side. Capture screenshots into the PR description.
   - 对照表每一行，并排访问旧 URL 和新 URL。把截图放进 PR 描述。
2. **Run the full test matrix** / 跑全量测试矩阵
   - `just test-all` (agent-core + web + Python + Rust)
   - `pnpm --filter @quilin/web exec vitest run --coverage` ≥ 95%
   - `pnpm --filter @quilin/web exec playwright test`
3. **Cross-review** / 交叉评审
   - Dispatch 2 fresh subagents (Reviewer A: type/logic/coverage; Reviewer B: integration/security/regression). Iterate until both report 0 real issues. See [`web-ui-cross-review-rubric.md`](./web-ui-cross-review-rubric.md).
   - 派 2 个新 subagent（Reviewer A: 类型/逻辑/覆盖；Reviewer B: 集成/安全/回归）。循环到两人都报 0 真实 issue。见 [`web-ui-cross-review-rubric.md`](./web-ui-cross-review-rubric.md)。
4. **Remove legacy code** / 移除旧代码
   - Delete `packages/agent-core/src/observability/dashboard-ui/` (entire directory).
   - Delete `packages/agent-core/src/observability/dashboard-page.ts`.
   - Remove `/api/dashboard/*` route registrations from `packages/agent-core/src/control-plane/handler.ts`. The `handler.ts` file itself stays — only the legacy routes are stripped.
   - Re-run `pnpm --filter @quilin/agent-core test` to confirm no test depended on the legacy surface.
   - 删除 `packages/agent-core/src/observability/dashboard-ui/`（整个目录）。
   - 删除 `packages/agent-core/src/observability/dashboard-page.ts`。
   - 从 `packages/agent-core/src/control-plane/handler.ts` 移除 `/api/dashboard/*` 路由注册。`handler.ts` 文件本身保留——只剥离旧路由。
   - 重跑 `pnpm --filter @quilin/agent-core test` 确认没有测试依赖旧面。
5. **Update boot log** / 更新启动日志
   - Stop printing the legacy `/dashboard` URL on `quilin` start.
   - 停止在 `quilin` 启动时打印旧版 `/dashboard` URL。
6. **Commit and update Linear** / commit 并更新 Linear
   - Single commit: `feat(web): retire legacy dashboard (QUI-154 Phase 1 parity)`.
   - Mark QUI-105 as superseded-and-archived in Linear.
   - 单 commit：`feat(web): retire legacy dashboard (QUI-154 Phase 1 parity)`。
   - 在 Linear 中把 QUI-105 标记为 superseded-and-archived。

## 回滚方案 / Rollback plan

English: If the new Web UI is removed-too-early or shows a regression in production-shadow use, the rollback is straightforward because the legacy code is preserved in git history at the pre-removal commit.

中文：如果新版 Web UI 被过早移除或在生产-影子使用中出现回归，回滚很直接——旧代码在移除前的 commit 完整保留在 git 历史中。

**Option A — Soft rollback (new app still scaffolded, just point users back to legacy)**

**方案 A — 软回滚（新版仍在脚手架中，只是把用户指回旧版）**

English: If switchover hasn't happened yet and Phase 1 is still coexisting:

中文：如果切换尚未发生且 Phase 1 仍在并存阶段：

1. Stop the Next.js dev server (`pkill -f "next dev"` or Ctrl+C in the terminal running `just web-dev`).
2. Continue using `http://127.0.0.1:<agent-core-port>/dashboard` — it has never been touched.
3. File a Linear comment under QUI-154 with the symptom + repro steps so cross-review can lock the gap before the next Phase advance.

1. 停掉 Next.js 开发服务器（`pkill -f "next dev"` 或在跑 `just web-dev` 的终端 Ctrl+C）。
2. 继续用 `http://127.0.0.1:<agent-core-port>/dashboard`——它一直没动过。
3. 在 QUI-154 下写一条 Linear comment，记录症状 + 复现步骤，让 cross-review 在下一轮 Phase 推进前锁住差距。

**Option B — Hard rollback (after legacy removal commit landed and a regression appeared)**

**方案 B — 硬回滚（旧版移除 commit 已落库且出现回归）**

1. Identify the removal commit: `git log --grep "retire legacy dashboard"`.
2. Revert it: `git revert <commit-sha>` — this is a non-destructive forward commit that restores legacy files and route registrations.
3. Confirm both UIs come back online: `just start` then visit `/dashboard` and `:3000/`.
4. Re-run `pnpm --filter @quilin/agent-core test` to confirm test green.
5. File a Linear issue under QUI-154 documenting the regression that triggered the rollback so cross-review can address it before re-attempting the removal.

1. 找到移除 commit：`git log --grep "retire legacy dashboard"`。
2. revert 之：`git revert <commit-sha>`——这是一个非破坏性的前向 commit，恢复旧版文件和路由注册。
3. 确认两套 UI 都回来：`just start` 然后访问 `/dashboard` 和 `:3000/`。
4. 重跑 `pnpm --filter @quilin/agent-core test` 确认测试通过。
5. 在 QUI-154 下开 Linear issue 记录触发回滚的回归，让 cross-review 在重新尝试移除前解决。

English: Both options preserve the cross-review hard rule — the revert commit itself is a pure code-restoration and counts as a "lint/format-style change" exempt from the 2-reviewer cycle, but the **next** Phase-advance commit toward re-removal must go through the full cross-review loop again.

中文：两个方案都保留 cross-review 硬规则——revert commit 本身是纯粹的代码恢复，算作 "lint/format 级"，豁免 2-reviewer 循环；但**下一次**朝重新移除推进的 Phase 推进 commit，必须再走一遍完整的 cross-review 循环。

## 风险与缓解 / Risks and mitigations

English: A short list of known migration risks that cross-review must verify each round.

中文：一份已知迁移风险清单，cross-review 每轮都要核对。

| 风险 / Risk | 缓解 / Mitigation |
|---|---|
| `/api/dashboard/*` 路由意外回归 / Legacy routes accidentally regressed | Phase 1 测试覆盖旧路由 happy-path / Phase 1 tests cover legacy route happy paths |
| 新旧 UI 同时读同一数据导致不一致 / Both UIs read same data inconsistently | 后端单源（snapshot.ts 复用） / Backend single source (reuse snapshot.ts) |
| SSE 心跳丢失被误判为离线 / Missed SSE heartbeat misread as offline | 15s 心跳 + Last-Event-ID 重连 / 15s heartbeat + Last-Event-ID reconnect |
| 跨域请求绕过 localhost 限制 / Cross-origin requests bypass localhost guard | Next.js proxy 同源 + agent-core 拒绝非 127.0.0.1 / Next.js proxy keeps same-origin + agent-core rejects non-127.0.0.1 |
| 覆盖率回退到 < 95% / Coverage drops below 95% | CI gate 阻塞 PR / CI gate blocks PR |
| 配置写入触发 CRITICAL 但 UI 未提示 / Config write triggers CRITICAL without UI prompt | Authority drawer (Phase 1b) + `forbidden_critical_write` 错误码 / Authority drawer + `forbidden_critical_write` error code |
