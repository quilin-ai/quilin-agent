# E2E 验收总览：web tools 三连发 / E2E Acceptance Umbrella: web-tools triad

> 日期 / Date: 2026-05-08
> 范围 / Scope: 三个 Iter J PR（QUI-129 / QUI-130 / QUI-131）的 land-后端到端验收。
> Scope: end-to-end post-land acceptance for three Iter J PRs (QUI-129 / QUI-130 / QUI-131).
> 子报告 / Sub-reports:
> - Phase 1 / [`e2e-2026-05-08-web-fetch.md`](./e2e-2026-05-08-web-fetch.md)
> - Phase 2 / [`e2e-2026-05-08-web-browse.md`](./e2e-2026-05-08-web-browse.md)
> - Phase 3 / [`e2e-2026-05-08-quilin-web.md`](./e2e-2026-05-08-quilin-web.md)

---

## 一、整体结论 / Headline

| Phase | 工具 / Tool | Linear | 验收点 / Cases | PASS | FAIL | SKIP | Defects filed |
|---|---|---|---|---|---|---|---|
| Phase 1 | `web_fetch` (TS) | [QUI-129](https://linear.app/quilin-agent/issue/QUI-129) | 10 | **10** | 0 | 0 | 1 fixed in-session（cache+prompt 短路 bug，TC-06b 翻 PASS）/ 1 fixed in-session (cache+prompt short-circuit bug, TC-06b flipped to PASS) |
| Phase 2 | `web_browse` (TS) | [QUI-130](https://linear.app/quilin-agent/issue/QUI-130) | 9 | **8** | 1 | 0 | [QUI-133](https://linear.app/quilin-agent/issue/QUI-133) — userinfo URL 防御缺失 / userinfo URL guard missing |
| Phase 3 | `quilin-web` (Python MCP) | [QUI-131](https://linear.app/quilin-agent/issue/QUI-131) | 6 | **6** | 0 | 0 | [QUI-134](https://linear.app/quilin-agent/issue/QUI-134) — Crawl4AI stdout 污染 MCP stdio / Crawl4AI stdout pollution into MCP stdio |
| **总计 / Total** | — | — | **25** | **24** | **1** | **0** | 2 active follow-up + 1 in-session fixed |

整体落地状态：三个 PR 的核心契约全部通过；两个真实缺陷被发现并已落 Linear 跟踪（均非阻塞 / non-blocking），一个 bug（cache+prompt 短路）在 session 内已修复并通过 e2e 复验。

Overall: All three PRs' core contracts are upheld; two real defects surfaced and tracked in Linear (both non-blocking), and one bug (cache + prompt short-circuit) was fixed and re-verified in-session.

---

## 二、各 Phase 关键产出 / Per-Phase Key Outputs

### Phase 1 — `web_fetch`

* E2E 脚本 / Script: `packages/agent-core/scripts/e2e-web-fetch.ts`
* 单测覆盖率 / File-level coverage: `99.6 % stmts / 94.11 % branches / 100 % funcs / 99.59 % lines`（49 cases pass）
* In-session fix: cache 命中时 prompt 被静默忽略 → `web-fetch.ts:665-695` 改为 cache hit + prompt + llmClient 时跑 `extractWithLLM`；新增 2 个单测覆盖
* In-session fix: cache hit silently skipped LLM extraction; `web-fetch.ts:665-695` now runs `extractWithLLM` on the cached markdown when prompt + llmClient are present; two new unit tests added.

### Phase 2 — `web_browse`

* E2E 脚本 / Script: `packages/agent-core/scripts/e2e-web-browse.ts`
* Fixture: `packages/agent-core/tests-e2e/fixtures/spa.html` (本地 SPA, served via `Bun.serve()`)
* 测试策略 / Strategy: 因环境无 LLM API key，对 Stagehand 的 AI primitives（`extract` / `observe` / `act`）做 stub，对 Patchright Chromium 启动 + `goto` / `waitForSelector` / `click` 走真实浏览器
* Defect: TC-08 发现 `web_browse` 不拒绝 userinfo URL，凭证会一路带到浏览器 → [QUI-133](https://linear.app/quilin-agent/issue/QUI-133) filed with one-line fix
* Defect: TC-08 found `web_browse` does not reject userinfo URLs; credentials would propagate to the browser → [QUI-133](https://linear.app/quilin-agent/issue/QUI-133) filed with a one-line fix.

### Phase 3 — `quilin-web` (Python MCP)

* TS 集成测试 / TS integration test: `packages/agent-core/tests-e2e/quilin-web-mcp.test.ts` (13 cases pass in 38 s)
* 真实网络脚本 / Real-network script: `providers/web/scripts/e2e-real-network.py` (7 cases pass)
* Python 单测覆盖率 / Python unit coverage: 25/25 tests, **100 %** (above the 95 % project floor)
* Defect: Crawl4AI 0.8.6 把 verbose 进度行写到 stdout，导致 MCP stdio JSON-RPC 解析错误（非致命，但 log 噪音大） → [QUI-134](https://linear.app/quilin-agent/issue/QUI-134) filed with `verbose=False` fix
* Defect: Crawl4AI 0.8.6 writes verbose progress lines to stdout, causing MCP stdio JSON-RPC parse errors (non-fatal but noisy) → [QUI-134](https://linear.app/quilin-agent/issue/QUI-134) filed with the `verbose=False` fix.

---

## 三、Defects / 缺陷一览

| # | Issue | 严重度 / Severity | 影响 / Impact | 修复策略 / Fix Strategy |
|---|---|---|---|---|
| 1 | TC-06b（in-session fixed） | High（contract 违反 / contract violation） | 已被 cache 的 URL 上传 prompt 会被静默忽略，违反"prompt → 子 LLM 抽取"的工具描述契约 | cache hit 分支增加 prompt + llmClient 检测，路由到 `extractWithLLM`；本 session 内已修 + 2 个新单测覆盖 |
| 2 | [QUI-133](https://linear.app/quilin-agent/issue/QUI-133) | Medium（凭证泄漏风险 / credential leak risk） | `web_browse` 接受 `https://user:pass@example.com` 形式的 URL，凭证会带到 Chromium | `parsedUrl.username \|\| parsedUrl.password` 判断 + 拒绝；模仿 `web-fetch.ts` 已有的 `hasUrlUserinfo` 防御 |
| 3 | [QUI-134](https://linear.app/quilin-agent/issue/QUI-134) | Medium（log 噪音 / log noise） | Crawl4AI 进度行污染 MCP stdio 通道，触发 `SyntaxError: Unexpected token '\|'`；tool call 仍成功，但日志可读性差 | `AsyncWebCrawler(verbose=False)` 或重定向 verbose 到 stderr |

---

## 四、连带产出 / Side-Effects

这次 E2E 不仅验证了三个 PR，还从一次"`uv cache clean` 卡死 → 降级到 `rm -rf`"的真实 trajectory 中孵化出了一整套 harness engineering 路线图：

This E2E run not only verified the three PRs — it also incubated a complete harness-engineering roadmap from a real trajectory ("`uv cache clean` hung → fell back to `rm -rf`"):

* [`docs/00-core-loop/intelligence-roadmap.md`](../00-core-loop/intelligence-roadmap.md) — 主索引：10 块拼图 → 组件 → 差距 → iteration / Master index
* [`docs/00-core-loop/reactive-execution.md`](../00-core-loop/reactive-execution.md) — Iter L 完整设计
* [`docs/00-core-loop/eval-driven-development.md`](../00-core-loop/eval-driven-development.md) — Iter L+0 完整设计
* [`docs/05-tool/tool-taste.md`](./tool-taste.md) — Iter L+1 完整设计
* [`docs/02-context/auto-context-curation.md`](../02-context/auto-context-curation.md) — Iter L+2 完整设计

Linear iterations 同期建立 / Linear iterations created in parallel:

* [Iter L：反应式执行 / Reactive Execution](https://linear.app/quilin-agent/project/iter-l反应式执行-reactive-execution-891dc157a8d5) — Medium
* [Iter L+0：评测驱动开发 / Eval-Driven Development](https://linear.app/quilin-agent/project/iter-l0评测驱动开发-eval-driven-development-b5b29b157f46) — **High**（gate）
* [Iter L+1：工具品味 / Tool Taste](https://linear.app/quilin-agent/project/iter-l1工具品味-tool-taste-60e80c4db043) — Medium
* [Iter L+2：上下文自动装配 / Auto-context Curation](https://linear.app/quilin-agent/project/iter-l2上下文自动装配-auto-context-curation-c79d1abf1143) — Medium

跟踪 issue / Tracker issues: QUI-132 / QUI-135 / QUI-136 / QUI-137；cross-cutting issue: QUI-138（PreCommit evidence）/ QUI-139（TaskList persistence）。

---

## 五、关联 / References

- 上游 PR / Upstream PRs: c5a089d (QUI-129), 18621b8 (QUI-130), 1eedf26 (QUI-131)
- 上游 Linear: [QUI-129](https://linear.app/quilin-agent/issue/QUI-129) / [QUI-130](https://linear.app/quilin-agent/issue/QUI-130) / [QUI-131](https://linear.app/quilin-agent/issue/QUI-131)
- Iter J project: [Iter J：生态与连接 / Ecosystem and Connectivity](https://linear.app/quilin-agent/project/iter-j生态与连接-ecosystem-and-connectivity-49ac7dda76b7)
- Tool engineering current-state: [`docs/05-tool/README.md`](./README.md)
