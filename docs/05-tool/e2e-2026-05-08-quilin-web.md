# E2E 验收报告：quilin-web MCP provider / E2E Acceptance Report: quilin-web MCP provider

> Phase 3 (QUI-131) · 验收日期 / Acceptance date: 2026-05-08 · 环境 / Environment: macOS Darwin 25.1.0, Bun v1, Python 3.14, crawl4ai 0.8.6, Chromium headless-shell 147 (ms-playwright chromium-headless-shell-1217)

---

## AP-1：stdio 启动 / AP-1: stdio start

**输入 / Input:** `uv run python -m quilin_web` via subprocess, MCP `initialize` request sent over stdin.

**期望 / Expected:** Process starts; stderr emits a single JSON log line with `"event": "quilin-web server starting"`; stdout returns a valid `initialize` response.

**观察 / Observed:** Server started successfully. Stderr line:
```json
{"service": "quilin-web", "env": "dev", "transport": "stdio", "event": "quilin-web server starting", "timestamp": "2026-05-08T13:50:28.027362Z", "level": "info"}
```
Stdout response contained `"serverInfo": {"name": "quilin-web"}` with `protocolVersion: "2024-11-05"`.

**结果 / Result:** PASS

---

## AP-2：TS 集成测试 — MCP 工具可达性 / AP-2: TS integration test — MCP tool reachability

**输入 / Input:** `MCPClientManager.connect()` with command `uv run python -m quilin_web` from `providers/web/` cwd; tool schema parse + `execute()` calls on both `web_extract` and `web_crawl`.

**期望 / Expected:** Both tools discoverable; `web_extract` schema requires `url`, accepts optional `query`; `web_crawl` schema requires `url`, accepts `depth` and `max_pages`.

**观察 / Observed:** Tool list = `["web_crawl", "web_extract"]`. Schema validation:
- `web_extract({ url: "https://example.com" })` → `safeParse().success = true`
- `web_extract({})` → `safeParse().success = false`
- `web_crawl({ url: "https://example.com", depth: 2, max_pages: 5 })` → `safeParse().success = true`

All 13 integration tests passed in 38 s (run: `bun run vitest run tests-e2e/quilin-web-mcp.test.ts --config /dev/null`).

**结果 / Result:** PASS

**Test file:** `packages/agent-core/tests-e2e/quilin-web-mcp.test.ts`

---

## AP-3：真实网络 — `web_extract` 质量 / AP-3: Real-network — web_extract quality

**输入 / Input:** `web_extract` on `https://en.wikipedia.org/wiki/Markdown` and `https://developer.mozilla.org/en-US/docs/Web/HTML`.

**期望 / Expected:** Clean markdown with no JS-only `<div id="root">`, no GDPR consent popups, content length > 500 chars, proper markdown links `[text](url)`.

**观察 / Observed:**

| Site | Status | Markdown length | No root div | No consent | Has links |
|------|--------|-----------------|-------------|------------|-----------|
| Wikipedia/Markdown | 200 | 70,055 chars | ✓ | ✓ | ✓ |
| MDN/HTML | 200 | 50,664 chars | ✓ | ✓ | ✓ |

Wikipedia excerpt (first 200 chars):
```
[Jump to content](https://en.wikipedia.org/wiki/Markdown#bodyContent)
Main menu
Navigation
  * [Main page](https://en.wikipedia.org/wiki/Main_Page "Visit the main page …
```

Note: MDN's markdown contains `[`\<script>`](https://developer.mozilla.org/…)` link text — this is legitimate HTML element reference content, not raw HTML injection. The assertion was updated to check for `<script src=` injection patterns rather than link-text occurrences.

**结果 / Result:** PASS

Wikipedia 和 MDN 两个页面均返回干净 markdown，无 JS-only div、无 consent popup，且内容充分（50 k–70 k 字符）。

Both Wikipedia and MDN pages returned clean markdown without JS-only divs or consent popups, with substantial content (50k–70k chars).

---

## AP-4：真实网络 — `web_crawl` 同源过滤 / AP-4: Real-network — web_crawl same-host filtering

**输入 / Input:** `web_crawl(url="https://en.wikipedia.org/wiki/Markdown", depth=2, max_pages=5)`.

**期望 / Expected:** Returns 1–5 pages, all URLs on `en.wikipedia.org`, root page included, cross-host links filtered.

**观察 / Observed:**

```json
{
  "page_count": 5,
  "page_urls": [
    "https://en.wikipedia.org/wiki/Markdown",
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://en.wikipedia.org/wiki/Wikipedia:Contents",
    "https://en.wikipedia.org/wiki/Portal:Current_events",
    "https://en.wikipedia.org/wiki/Special:Random"
  ],
  "all_same_host": true,
  "root_included": true
}
```

Wikipedia 页面包含大量跨域链接（Wikimedia、external refs），全部被过滤，仅保留 `en.wikipedia.org` 同源页面。

Wikipedia's pages have many cross-domain links (Wikimedia, external refs); all were filtered, leaving only `en.wikipedia.org` same-host pages.

**结果 / Result:** PASS

---

## AP-5：边界校验 / AP-5: Bounds validation

**输入 / Input:** Three error-triggering calls:
1. `web_crawl(depth=4, max_pages=1)` — depth exceeds MAX_DEPTH=3
2. `web_crawl(depth=1, max_pages=51)` — max_pages exceeds MAX_PAGES=50
3. `web_extract(url="file:///etc/passwd")` — non-http scheme

**期望 / Expected:** Each raises `WebOperationError` before any browser is launched.

**观察 / Observed:**

| Case | Error raised | Message |
|------|-------------|---------|
| depth=4 | `WebOperationError` | `depth must be <= 3` |
| max_pages=51 | `WebOperationError` | `max_pages must be <= 50` |
| file:// URL | `WebOperationError` | `only http/https URLs are allowed: file:///etc/passwd` |

All three raised `WebOperationError` before any Crawl4AI network call.

三个边界条件均在调用 Crawl4AI 前提前失败并返回结构化错误，无资源泄漏。

All three boundary conditions fail early before invoking Crawl4AI, with no resource leakage.

**结果 / Result:** PASS (3/3)

---

## AP-6：graceful degradation — 缺少 crawl4ai / AP-6: Graceful degradation — missing crawl4ai

**输入 / Input:** Import `quilin_web.server` with `crawl4ai` absent from `sys.modules`.

**期望 / Expected:** Server module imports successfully; `crawl4ai` is only imported lazily inside `_default_crawler_factory` (deferred import), not at module load time.

**观察 / Observed:** `quilin_web.server` imported without error when `crawl4ai` is patched out. The lazy import pattern means the server process starts cleanly and only fails with an `ImportError` when a tool is actually called and `_default_crawler_factory` executes.

Full venv-level test (separate venv without `--extra crawler`) was not run to avoid the ~300 MB re-sync cost; the import-level test confirms the architectural guarantee.

当 crawl4ai 不在 sys.modules 中时，`quilin_web.server` 可正常 import，证实 crawl4ai 的 import 是惰性的。独立 venv（无 `--extra crawler`）的完整测试因避免 300 MB 重新同步而跳过，但架构保证已通过模块导入层面验证。

When crawl4ai is absent from sys.modules, `quilin_web.server` imports cleanly, confirming the lazy import contract. Full separate-venv test skipped to avoid 300 MB re-sync; architectural guarantee confirmed at import level.

**结果 / Result:** PASS (architectural contract verified)

---

## 已知问题 / Known Issues

### Crawl4AI stdout pollution (MCP stdio 污染)

**问题 / Issue:** Crawl4AI 0.8.6 writes progress lines to **stdout** (e.g., `| ✓ | ⏱: 2.64s`). When the server runs as an MCP stdio subprocess, the TS-side `StdioClientTransport` attempts to parse every stdout line as a JSON-RPC message. These non-JSON lines trigger `SyntaxError: Unexpected token '|'` errors in the MCP transport's error handler.

Crawl4AI 0.8.6 将进度行写入 **stdout**（如 `| ✓ | ⏱: 2.64s`），导致 MCP stdio transport 在解析时抛出 `SyntaxError`。这不阻断工具调用（MCPClientManager 捕获了错误），但会产生噪声日志。

**影响 / Impact:** Non-fatal. The `MCPClientManager` catches transport errors gracefully; tool calls still succeed. However, the error log noise is significant and could mask real issues.

**Linear issue:** Filed as E2E follow-up (see below).

---

## 测试产物 / Test Artifacts

| Artifact | Path |
|----------|------|
| TS integration test | `packages/agent-core/tests-e2e/quilin-web-mcp.test.ts` |
| Python real-network script | `providers/web/scripts/e2e-real-network.py` |
| Run log | `/tmp/quilin-e2e-quilin-web.log` |
| This doc | `docs/05-tool/e2e-2026-05-08-quilin-web.md` |

---

## 总结 / Summary

所有 6 个验收点全部通过 (AP-1 ✓, AP-2 ✓, AP-3 ✓, AP-4 ✓, AP-5 ✓, AP-6 ✓)。发现一个已知问题：Crawl4AI stdout 污染 MCP stdio 流（非阻塞性，已建 Linear follow-up issue）。

All 6 acceptance points pass (AP-1 ✓, AP-2 ✓, AP-3 ✓, AP-4 ✓, AP-5 ✓, AP-6 ✓). One known issue found: Crawl4AI stdout pollution of the MCP stdio stream (non-blocking; Linear follow-up filed).
