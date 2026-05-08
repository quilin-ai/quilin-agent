# E2E 验收报告：web_browse（Phase 2）/ E2E Acceptance Report: web_browse (Phase 2)

> 日期 / Date: 2026-05-08
> 关联 issue / Related issue: [QUI-130](https://linear.app/quilin-agent/issue/QUI-130) — Phase 2: web_browse via Stagehand + Patchright
> 脚本 / Script: `packages/agent-core/scripts/e2e-web-browse.ts`
> 日志 / Log: `/tmp/quilin-e2e-web-browse.log`

---

## 测试策略 / Test Strategy

因环境中无 LLM API Key（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 均未配置），无法让 Stagehand 真正调用大模型。验收采用"混合存根"策略：

Since no LLM API key is present in the environment (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` both absent), real Stagehand AI calls cannot be made. The acceptance suite uses a "hybrid stub" strategy:

- `extract` / `observe` / `act` 方法返回预制的结构化数据，验证工具→Stagehand 的接线、参数透传和返回值形状。
- `extract` / `observe` / `act` return canned structured data, verifying tool→Stagehand wiring, argument pass-through, and response shape.

- 凡需要真实浏览器的用例（TC-01、TC-02、TC-06、TC-09），通过 `stagehandFactory` 注入点直接使用 Patchright Chromium 启动真实页面，`goto()` / `waitForSelector()` / `click()` 均走真实浏览器 API。
- Cases requiring a real browser (TC-01, TC-02, TC-06, TC-09) inject a real Patchright Chromium page via the `stagehandFactory` hook; `goto()` / `waitForSelector()` / `click()` all execute against the real browser.

- 测试夹具（HTML 页面）通过 `Bun.serve()` 在随机端口以 `http://127.0.0.1` 提供，避免工具的 `file://` 拦截。
- The HTML fixture is served over `http://127.0.0.1` on a random port via `Bun.serve()` so the tool's `file://` guard does not block it.

---

## 测试结果 / Test Results

**总计 / Total**: 9 用例，8 通过，1 失败，0 跳过
**Total**: 9 cases, 8 pass, 1 fail, 0 skip

---

### TC-01 — extract 模式返回结构化数据 / extract mode returns structured data

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `http://127.0.0.1:<port>/spa.html`, instruction: "extract title and description", mode: "extract" |
| **预期 / Expected** | `isError=false`, `mode="extract"`, `result` 包含预制 `{title, description}` |
| **观测 / Observed** | `{"url":"http://127.0.0.1:57946/spa.html","mode":"extract","result":{"title":"Test Page","description":"A minimal SPA fixture..."}}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — mode=extract, structured payload returned, browser closed cleanly` |

---

### TC-02 — observe 模式列出可交互元素 / observe mode lists interactive elements

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: fixture, instruction: "list all interactive elements", mode: "observe" |
| **预期 / Expected** | `isError=false`, `mode="observe"`, `result` 为非空数组 |
| **观测 / Observed** | `result` 为 3 个元素的数组（`#load`, `#search`, `.item`） |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — mode=observe, 3 elements listed` |

---

### TC-03 — act 模式：ask 模式 WriteAuthority 触发 confirm 回调 / ask-mode WriteAuthority fires confirm callback

| 字段 | 内容 |
|------|------|
| **输入 / Input** | mode: "act", WriteAuthority mode: "ask"，注入记录回调 |
| **预期 / Expected** | confirm 回调被调用 1 次，`riskLevel="medium"`, `tool="web_browse"` |
| **观测 / Observed** | `confirmCalls=[{tool:"web_browse",riskLevel:"medium",origin:"agent"}]` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — confirm callback fired once, riskLevel=medium, tool=web_browse` |

---

### TC-04 — act 模式：auto-medium 直接放行，不触发 confirm / auto-medium lets action through without confirm

| 字段 | 内容 |
|------|------|
| **输入 / Input** | mode: "act", WriteAuthority mode: "auto-medium" |
| **预期 / Expected** | confirm 回调 0 次，`isError=false` |
| **观测 / Observed** | `confirmCallCount=0`, `payload.mode="act"`, `result={autoClicked:true}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — auto-medium allowed act without calling confirm hook` |

---

### TC-05 — act 模式：deny-all 拒绝且不启动浏览器 / deny-all rejects without launching browser

| 字段 | 内容 |
|------|------|
| **输入 / Input** | mode: "act", WriteAuthority mode: "deny-all" |
| **预期 / Expected** | `isError=true`, error 含 "denied"，`stagehandFactory` 调用次数为 0 |
| **观测 / Observed** | `error:"Browser action denied by WriteAuthority: write authority disabled"`, `factoryCallCount=0` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — denied before browser launch; factoryCallCount=0` |

---

### TC-06 — wait_for 阻塞直到 #price 元素出现（500ms 延迟）/ wait_for blocks until #price appears

| 字段 | 内容 |
|------|------|
| **输入 / Input** | mode: "extract", `wait_for: "#price"`, fixture 页面在点击 `#load` 后 500ms 注入 `<div id="price">$42</div>` |
| **预期 / Expected** | `waitForSelector` 阻塞至元素出现；extract 读到 `price="$42"`；总耗时 ≥ 400ms |
| **观测 / Observed** | `price="$42"`, `elapsedMs=1014` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — wait_for resolved after 1014ms, price="$42"` |

---

### TC-07 — file:// URL 被拒绝 / file:// URL is rejected

| 字段 | 内容 |
|------|------|
| **输入 / Input** | `url: "file:///etc/passwd"` |
| **预期 / Expected** | `isError=true`, error 含 "http" |
| **观测 / Observed** | `error:"Only http and https URLs are allowed: file:///etc/passwd"` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — correctly rejected: Only http and https URLs are allowed: file:///etc/passwd` |

---

### TC-08 — 含凭据 URL（user:pass@host）被拒绝 / URL with userinfo is rejected

| 字段 | 内容 |
|------|------|
| **输入 / Input** | `url: "https://user:pass@example.com/"` |
| **预期 / Expected** | `isError=true`, error 提及 userinfo / credentials |
| **观测 / Observed** | `isError=false`, `url:"https://user:pass@example.com/"`, 凭据被转发至 stub 工厂 |
| **结论 / Result** | **FAIL — 已确认缺陷** |
| **日志行 / Log line** | `> FAIL — DEFECT: userinfo URL was not rejected; actual URL used: https://user:pass@example.com/` |

`web-browse.ts` 当前仅检查 `parsedUrl.protocol`，未检查 `parsedUrl.username` / `parsedUrl.password`。修复方法：在协议校验之后添加：

`web-browse.ts` currently only checks `parsedUrl.protocol`, not `parsedUrl.username` / `parsedUrl.password`. Fix: add a guard after the protocol check:

```typescript
if (parsedUrl.username || parsedUrl.password) {
  return createErrorResult("builtin-web-browse", {
    error: `URLs with userinfo (embedded credentials) are not allowed: ${url}`,
  });
}
```

跟进 issue / Follow-up issue: 见下方 / See below.

---

### TC-09 — 工具关闭后无 Chromium 进程泄漏 / no Chromium process leak after tool closes

| 字段 | 内容 |
|------|------|
| **输入 / Input** | 通过工具完整启动并关闭一个 Patchright Chromium 浏览器 |
| **预期 / Expected** | 关闭后进程数增量 ≤ 0 |
| **观测 / Observed** | `beforeCount=0, afterCount=0, delta=0` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — no leak: before=0, after=0, delta=0` |

---

## 已知缺陷 / Known Defects

### D-01: web_browse 未拒绝含凭据 URL / web_browse does not reject userinfo URLs

`web-browse.ts` 的 URL 校验只检查协议（`http:` / `https:`），未拦截嵌入凭据的 URL（如 `https://user:pass@host/`）。此类 URL 会将用户名和密码透传至底层 Chromium，存在凭据泄露风险。

`web-browse.ts` URL validation only checks the protocol (`http:` / `https:`) but does not block URLs with embedded credentials such as `https://user:pass@host/`. Such URLs forward the username and password to Chromium, creating a credential-leakage risk.

修复优先级：中（Medium）/ 跟进 / Follow-up: Linear issue opened (blockedBy QUI-130).

---

## 附件 / Artifacts

| 文件 / File | 路径 / Path |
|------------|-------------|
| E2E 脚本 | `packages/agent-core/scripts/e2e-web-browse.ts` |
| 测试夹具 | `packages/agent-core/tests-e2e/fixtures/spa.html` |
| 运行日志 | `/tmp/quilin-e2e-web-browse.log` |
| 单元测试（无回归）| `packages/agent-core/src/tools/builtin/web-browse.test.ts` — 18 passed |
