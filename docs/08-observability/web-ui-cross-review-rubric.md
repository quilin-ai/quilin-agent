# Web UI Cross-Review Rubric / Web UI 交叉评审清单

> Linear: [QUI-154](https://linear.app/quilin-agent/issue/QUI-154)
> Companion to: [web-ui-rebuild-plan.md](./web-ui-rebuild-plan.md) · [web-ui-migration-guide.md](./web-ui-migration-guide.md)
> Audience: cross-review subagents dispatched after Phase 1 code lands

## 概述 / Overview

English: This rubric is the briefing material handed to each cross-review subagent invoked after new Web UI code lands in `apps/web/` or `packages/agent-core/src/control-plane/v2/`. Per CLAUDE.md hard rule, two fresh reviewers run in parallel each round; iterate until both report **0 real issues** (false positives do not count, RECOMMEND items do not block).

中文：本清单是 `apps/web/` 或 `packages/agent-core/src/control-plane/v2/` 新代码落地后，发派给每个 cross-review subagent 的简报材料。按 CLAUDE.md 硬规则，每轮两个新 reviewer 并行；循环到两人都报 **0 真实 issue**（false positive 不算，RECOMMEND 不阻塞）。

## Reviewer A 视角 / Reviewer A perspective

English: Reviewer A focuses on **type correctness, logic, algorithmic soundness, and test coverage**. Treat the code as if the user has never seen it — challenge every type assertion, branch, and missing test.

中文：Reviewer A 关注**类型正确性、逻辑、算法正确性、测试覆盖**。把代码当作用户从未见过——质疑每一个类型断言、每一条分支、每一处缺失的测试。

- TypeScript strict 通过且无 `any` 漏出 / TS strict passes with no `any` leakage
- zod schema 覆盖所有 API 输入输出 / zod schemas cover every API input and output
- 错误路径有显式处理（404 / 400 / 403 / 500） / Error paths handled explicitly (404 / 400 / 403 / 500)
- 边界值（空数组、null、最大长度）有测试 / Boundary values (empty arrays, null, max length) are tested
- 异步并发顺序正确（SSE 重连、useChat 状态） / Async concurrency ordering correct (SSE reconnect, useChat state)
- 覆盖率 ≥ 95% lines/branches/funcs/stmts / Coverage ≥ 95%
- 没有重复测试相同 happy path 而漏掉错误路径 / No tests redundantly covering happy path while missing error paths

## Reviewer B 视角 / Reviewer B perspective

English: Reviewer B focuses on **integration drift, security, API compatibility, regression risk**. The new code lives next to legacy code; anything that silently breaks the legacy surface is a real issue, not a SUSPECT.

中文：Reviewer B 关注**集成漂移、安全、API 兼容、回归风险**。新代码与旧代码并存；任何静默打破旧版面的改动都是真实 issue，不是 SUSPECT。

- `/api/dashboard/*` 旧路由 happy-path 仍通过 / Legacy `/api/dashboard/*` happy path still passes
- 旧 dashboard 文件未被删除（Phase 1 内）/ Legacy dashboard files not deleted in Phase 1
- agent-core 仍只绑 127.0.0.1，未引入新监听器 / agent-core still binds 127.0.0.1 only, no new listener
- 跨域被拒绝（CORS 默认 deny） / Cross-origin rejected (CORS default deny)
- 输入未在路由内拼字符串到 shell / SQL（红队思路） / No string concatenation from input to shell/SQL (red-team mindset)
- redaction policy 应用到所有响应（不仅 SSE） / Redaction policy applied to all responses (not only SSE)
- Authority gate 路径未绕过 WriteAuthority / Authority gate path does not bypass WriteAuthority
- 文档（README、迁移指南、本 rubric）与代码同步 / Docs (README, migration guide, this rubric) stay in sync with code

## 必查项 / Mandatory checks

English: Each numbered item below has a check command. Run them locally before declaring 0 issues. Paste the actual output (or summarized exit code + key counts) into your review reply so the next-round reviewer can verify your claims.

中文：下面每条编号项都有一个检查命令。在宣布 0 issue 前本地跑一遍。把实际输出（或摘要的 exit code + 关键数字）粘进 review 回复，方便下一轮 reviewer 验证你的声明。

1. **Backend tests still green** / 后端测试仍通过
   - `pnpm --dir packages/agent-core test`
   - Expected: 1711+ tests pass, 0 failures (current baseline from QUI-152 commits)
2. **Web build succeeds** / web 构建通过
   - `pnpm --filter @quilin/web build`
   - Expected: build completes, no TypeScript errors, no missing module errors
3. **TypeScript clean on both packages** / 两个 package 的 TypeScript 都干净
   - `pnpm --dir packages/agent-core exec tsc --noEmit`
   - `pnpm --filter @quilin/web exec tsc --noEmit`
   - Expected: exit 0 from both, 0 errors
4. **Biome clean on both packages** / 两个 package 的 Biome 都干净
   - `pnpm --dir packages/agent-core exec biome check src/`
   - `pnpm --filter @quilin/web exec biome check`
   - Expected: exit 0 from both, 0 errors, 0 warnings
5. **Coverage ≥ 95% on new code** / 新代码覆盖率 ≥ 95%
   - `pnpm --filter @quilin/web exec vitest run --coverage`
   - Expected: lines / branches / funcs / stmts all ≥ 95%; report which file (if any) sits at the floor
6. **No `any` types without an excuse comment** / 没有 `any` 类型且无注释豁免
   - `grep -rn ": any" apps/web/ packages/agent-core/src/control-plane/v2/ | grep -v "// biome-ignore" | grep -v "// reason:"`
   - Expected: empty output, or each hit has an adjacent `// reason: <why>` comment
7. **No `console.log` outside dev helpers** / 非 dev helper 区域无 `console.log`
   - `grep -rn "console.log" apps/web/ packages/agent-core/src/control-plane/v2/ | grep -v ".test." | grep -v "/dev/"`
   - Expected: empty output (production code uses structured logger)
8. **zod schemas parse-able from both ends** / zod schema 两端都能 parse
   - From backend: `pnpm --dir packages/agent-core test -- v2/schemas`
   - From frontend: `pnpm --filter @quilin/web test -- lib/schemas`
   - Expected: both pass, schemas import without circular dependency errors
9. **SSE heartbeat works** / SSE 心跳工作
   - Manual: `curl -N http://127.0.0.1:<agent-core-port>/api/v2/events?session=<sid>` and observe `event: heartbeat` line every 15s (±2s)
   - Expected: heartbeat arrives at expected cadence, connection stays open
10. **Legacy `/api/dashboard/*` routes still respond** / 旧 `/api/dashboard/*` 路由仍响应
    - `curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<agent-core-port>/api/dashboard/snapshot`
    - Expected: 200 (or whatever the pre-QUI-154 baseline returned for the same route)

## 真实 issue vs SUSPECT vs RECOMMEND 区分 / Distinguishing real issue vs SUSPECT vs RECOMMEND

English: Use these labels exactly. Per CLAUDE.md, false positives (SUSPECTs not validated) and recommendations (RECOMMENDs) do not block landing — only real issues do.

中文：严格使用这些标签。按 CLAUDE.md，未实证的 SUSPECT 和建议性的 RECOMMEND 不阻塞落地——只有真实 issue 才阻塞。

- **REAL** — Reviewer has reproduced the bug, captured evidence (failing test, grep result, broken curl output, file:line citation), and labels the finding. Writing-agent must fix. Cycle re-runs with 2 fresh reviewers after fix.
- **REAL** — 评审者已复现 bug，捕获实证（失败测试、grep 结果、curl 异常输出、file:line 引用），并打上该标签。写代码 agent 必须修。修完后 2 个新 reviewer 重启循环。
- **SUSPECT** — Reviewer suspects an issue but is not 100% certain. The **main agent** (not the reviewer) must validate with `grep` / `Read` / test run before deciding. A SUSPECT that is dismissed without main-agent evidence is itself a process violation.
- **SUSPECT** — 评审者怀疑有问题但不 100% 确定。**主 agent**（不是评审者）必须用 `grep` / `Read` / 跑测试来判决。未经主 agent 实证就驳回 SUSPECT 本身就是流程违规。
- **RECOMMEND** — Optional improvement (extract helper, rename for clarity, add doc comment). Does not block. Log to Linear backlog if substantial; ignore if cosmetic.
- **RECOMMEND** — 可选优化（抽取 helper、改名、加注释）。不阻塞。若实质性则记入 Linear backlog；若纯外观则忽略。

## 收敛判定 / Convergence

English: A review round is converged only when **two fresh reviewers** (never reusing prior round's reviewers) **both** report **0 REAL issues**. SUSPECTs must be validated to REAL or dismissed with main-agent evidence before the round closes. RECOMMENDs do not affect convergence.

中文：评审轮的收敛条件是**两个新 reviewer**（不复用上一轮的 reviewer）**都**报 **0 个 REAL issue**。SUSPECT 必须在轮结束前被判为 REAL 或由主 agent 实证驳回。RECOMMEND 不影响收敛。

English: Until convergence, no `git commit` / `git push` is permitted, and no Linear status transition (especially `In Progress` → `Done`) is permitted. The cherry-pick from the QUI-154 worktree into master is gated on convergence as well — the writing-agent in the worktree must wait for the green signal before pushing.

中文：未收敛前，禁止 `git commit` / `git push`，禁止 Linear 状态变更（特别是 `In Progress` → `Done`）。从 QUI-154 worktree cherry-pick 进 master 同样以收敛为门槛——worktree 里的写代码 agent 必须等到绿灯才能推。

English: Each round's reply should end with a one-line headline summarizing the verdict: e.g. `result: 0 REAL, 2 RECOMMEND (logged), 1 SUSPECT (dismissed with evidence at handler-v2.ts:48)`. This headline is the only signal the orchestrating main agent reads to decide whether to dispatch round N+1 or proceed to commit.

中文：每轮回复要以一行 headline 收尾：例如 `result: 0 REAL, 2 RECOMMEND (logged), 1 SUSPECT (dismissed with evidence at handler-v2.ts:48)`。这一行是编排的主 agent 唯一读取的信号，用来决定是发派第 N+1 轮还是进入 commit。
