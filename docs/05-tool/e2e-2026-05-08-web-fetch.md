# E2E 验收报告：web_fetch（Phase 1）/ E2E Acceptance Report: web_fetch (Phase 1)

> 日期 / Date: 2026-05-08
> 关联 issue / Related issue: [QUI-129](https://linear.app/quilin-agent/issue/QUI-129) — Phase 1: web_fetch 升级到 Claude Code 水位
> 脚本 / Script: `packages/agent-core/scripts/e2e-web-fetch.ts`
> 日志 / Log: `/tmp/quilin-e2e-web-fetch.log`
> 单测 / Unit tests: `packages/agent-core/src/tools/builtin/web-fetch.test.ts` — 49 cases pass; 文件级覆盖率 / file-level coverage `99.6 % stmts / 94.11 % branches / 100 % funcs / 99.59 % lines`.

---

## 测试策略 / Test Strategy

Phase 1 的 web_fetch 不渲染 JS、不需要外置浏览器，因此 e2e 直接对真实外网发请求，验证 mocks 不可能覆盖的行为：真实 DNS / SSRF guard、真实 Turndown HTML→Markdown 在生产页面上的转换质量、真实 LRU 缓存行为、真实 redirect 处理、wire 层 content-type 校验。LLM 抽取部分通过 stub `LLMClient` 注入（环境无 API key），单测已 mock-verify 过 `LLMClient` 契约——e2e 在这里的增量价值是"用真实 markdown 跑通 prompt 路径的端到端"。

Phase 1 web_fetch does not render JS and needs no external browser, so the e2e suite hits real external endpoints to verify behaviors mocks cannot cover: real DNS / SSRF guard, real Turndown HTML→Markdown conversion on production pages, real LRU cache behavior, real redirect handling, wire-level content-type validation. The LLM-extraction path injects a stub `LLMClient` (no API key in env); unit tests already mock-verify the `LLMClient` contract — the e2e value-add here is "real markdown round-trips through the prompt path end-to-end".

---

## 测试结果 / Test Results

**总计 / Total**: 10 用例，10 通过，0 失败，0 跳过
**Total**: 10 cases, 10 pass, 0 fail, 0 skip

---

### TC-01 — 静态站 example.com 返回干净 markdown / static site example.com returns clean markdown

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://example.com` |
| **预期 / Expected** | `isError=false`, `status=200`, body 包含 "Example Domain" 和正确 markdown 标记，`fromCache!==true` |
| **观测 / Observed** | `{"url":"https://example.com/","status":200,"contentType":"text/html","body":"… # Example Domain …","truncated":false}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — 200 OK, markdown contains 'Example Domain', not from cache` |

---

### TC-02 — 同 URL 二次请求命中缓存 / cache hit on repeat fetch

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://example.com`（与 TC-01 同一 URL） |
| **预期 / Expected** | `fromCache=true`，body 与 TC-01 完全一致 |
| **观测 / Observed** | `{"url":"https://example.com/","status":200,"body":"… # Example Domain …","fromCache":true}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — fromCache=true on second call to same URL` |

---

### TC-03 — 长文章 wikipedia/Markdown 100KB cap 生效 / 100KB cap respected on long article

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://en.wikipedia.org/wiki/Markdown` |
| **预期 / Expected** | `5_000 < body.length ≤ 100_000`，markdown 主体内容存在 |
| **观测 / Observed** | body length=75 526，`truncated=false`（未触发上限），首屏含 "Markdown - Wikipedia" |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — body length=75526, truncated=false; cap=100000` |

---

### TC-04 — 同源 redirect 自动跟随 / same-host redirect auto-follows

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://httpbin.org/redirect/1`（302 → `/get`） |
| **预期 / Expected** | 自动跟到 `/get`，最终 URL 为 `https://httpbin.org/get`，`status=200` |
| **观测 / Observed** | `{"url":"https://httpbin.org/get","status":200}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — same-host /redirect/1 → https://httpbin.org/get` |

---

### TC-05 — 跨域 redirect 返回结构化 redirect（不自动跟） / cross-host redirect returns structured response

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F` |
| **预期 / Expected** | `type="redirect"`，`redirectUrl` 指向 `https://example.com/` |
| **观测 / Observed** | `{"type":"redirect","originalUrl":"https://httpbin.org/redirect-to?…","redirectUrl":"https://example.com/","status":302}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — type=redirect, redirectUrl=https://example.com/` |

---

### TC-06 — prompt 参数（uncached URL）通过 stub LLMClient 抽取 / prompt parameter routes through stub LLMClient

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://www.iana.org/help/example-domains`，prompt: "What is this page about?" |
| **预期 / Expected** | `extracted=true`，body 为 stub LLM 输出，`rawMarkdownLength` 保留原长度 |
| **观测 / Observed** | `{"body":"[STUB LLM EXTRACTION] focused answer derived from markdown","truncated":false,"rawMarkdownLength":1835,"extracted":true}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — extracted=true, body is stub LLM output, rawMarkdownLength preserved` |

---

### TC-06b — cache 命中时 prompt 仍走 LLM（bug fix 验证）/ cache hit + prompt still routes through LLM (bug fix verified)

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://example.com`（已被 TC-01/02 缓存），prompt: "What is the page about?" |
| **预期 / Expected** | `fromCache=true` 且 `extracted=true`，body 为 stub LLM 输出（不是 cached raw markdown） |
| **观测 / Observed** | `{"body":"[STUB LLM EXTRACTION] focused answer derived from markdown","truncated":false,"rawMarkdownLength":328,"extracted":true,"fromCache":true}` |
| **结论 / Result** | PASS（bug 修复后翻转为 PASS / flipped to PASS after fix） |
| **日志行 / Log line** | `> PASS — prompt now routes through LLM even when cached — bug fixed?` |
| **修复 / Fix** | `web-fetch.ts:665-695`：cache 命中时若 `prompt && options.llmClient`，对 cached markdown 跑 `extractWithLLM`，返回 `{extracted:true, fromCache:true}`；否则按原路径返回 cached markdown。新增 2 个单测覆盖（cache+prompt+llmClient → 抽取；cache+prompt 无 llmClient → 原 markdown），文件级覆盖率维持 99.6 %。/ When cache hits and `prompt && options.llmClient`, run `extractWithLLM` on cached markdown and return `{extracted:true, fromCache:true}`; otherwise fall back to the original cached path. Two new unit tests cover the new branches; file-level coverage stays at 99.6 %. |

---

### TC-07 — file:// URL 被拒 / file:// URL blocked

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `file:///etc/passwd` |
| **预期 / Expected** | `isError=true`，error 含 "http" |
| **观测 / Observed** | `{"error":"Only http and https URLs are allowed: file:///etc/passwd"}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — rejected with "Only http and https URLs are allowed: file:///etc/passwd"` |

---

### TC-08 — URL with userinfo 被拒 / URL with userinfo blocked

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://user:pass@example.com` |
| **预期 / Expected** | `isError=true`，error 含 "userinfo" |
| **观测 / Observed** | `{"error":"URL userinfo credentials are not supported; pass credentials through approved headers instead."}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — rejected with "URL userinfo credentials are not supported; …"` |

---

### TC-09 — 不支持的 content type（PDF） / unsupported content type (PDF) error

| 字段 | 内容 |
|------|------|
| **输入 / Input** | URL: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` |
| **预期 / Expected** | `isError=true`，error 含 "Unsupported content type" |
| **观测 / Observed** | `{"error":"Unsupported content type: application/pdf; qs=0.001"}` |
| **结论 / Result** | PASS |
| **日志行 / Log line** | `> PASS — rejected with "Unsupported content type: application/pdf; qs=0.001"` |

---

## 关联 / References

- **上游 issue**: [QUI-129](https://linear.app/quilin-agent/issue/QUI-129) — Phase 1: web_fetch 升级到 Claude Code 水位（已 Done）
- **Umbrella e2e 报告**: [`e2e-2026-05-08-web-tools.md`](./e2e-2026-05-08-web-tools.md) — Phase 1 + 2 + 3 总览
- **同期产物**: [`e2e-2026-05-08-web-browse.md`](./e2e-2026-05-08-web-browse.md)（Phase 2）、[`e2e-2026-05-08-quilin-web.md`](./e2e-2026-05-08-quilin-web.md)（Phase 3）
- **bug fix 反响**: TC-06b 揭示的 cache + prompt 短路 bug 已在本 session 内修复并验证；这条 trajectory 同时催生了 [`reactive-execution.md`](../00-core-loop/reactive-execution.md)、[`intelligence-roadmap.md`](../00-core-loop/intelligence-roadmap.md) 以及 Iter L / L+0 / L+1 / L+2 的 Linear iterations。
- **Bug fix ripple**: The cache + prompt short-circuit bug TC-06b uncovered was fixed and verified within this session; the same trajectory also produced [`reactive-execution.md`](../00-core-loop/reactive-execution.md), [`intelligence-roadmap.md`](../00-core-loop/intelligence-roadmap.md), and the Iter L / L+0 / L+1 / L+2 Linear iterations.
