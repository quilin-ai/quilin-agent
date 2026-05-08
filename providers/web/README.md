# quilin-web — Crawl4AI MCP provider

> 中英双语文档,按段落对照 / Bilingual document, paragraphs aligned.

## 概述 / Overview

`quilin-web` 是 Quilin Agent 的 Python provider,通过 MCP stdio 协议暴露 Crawl4AI 的 LLM-friendly markdown 抽取能力。它专攻"URL → 干净 markdown for RAG"这一垂直场景,补 TS 侧 `web_fetch`(静态页 markdown + 子 LLM 抽取)和 `web_browse`(headless SPA 浏览)之外的洞。

`quilin-web` is a Python provider for Quilin Agent that exposes Crawl4AI's LLM-friendly markdown extraction over the MCP stdio protocol. It owns the "URL → clean markdown for RAG" vertical, complementing the TS-side `web_fetch` (static-page markdown + sub-LLM extraction) and `web_browse` (headless SPA navigation).

## 提供的 MCP 工具 / Tools Exposed

### `web_extract(url, query=None)`

抓取单页,返回 Crawl4AI 清理过的 markdown。`query` 可选,作为元数据透传给上层 RAG / extraction 管线,本 provider 不直接调 LLM。

Fetches a single page and returns Crawl4AI's cleaned markdown. The optional `query` is passed through as metadata to the upstream RAG / extraction pipeline; this provider does not invoke an LLM directly.

### `web_crawl(url, depth=1, max_pages=10)`

从 `url` 起做浅层同源爬取(`depth` ≤ 3,`max_pages` ≤ 50),返回每个页面的 URL、状态、标题和 markdown 摘要。跨域链接自动跳过。

Runs a shallow same-host crawl rooted at `url` (`depth` ≤ 3, `max_pages` ≤ 50), returning each page's URL, status, title, and markdown excerpt. Cross-host links are skipped.

## 安装 / Installation

```bash
cd providers/web
uv sync                       # base deps: mcp + structlog + dev tools
uv sync --extra crawler       # adds crawl4ai (pulls Playwright + Chromium ~300MB)
```

不带 `--extra crawler` 时 server 仍能启动,但 `web_extract` / `web_crawl` 会在工具调用时报缺少依赖。这便于 CI 跑 unit test(全部走 mock crawler),又不强制开发者下 Chromium。

Without `--extra crawler` the server still starts, but `web_extract` / `web_crawl` will report a missing dependency at call time. This lets CI run unit tests against a mock crawler without forcing developers to download Chromium.

## 启动 / Run

```bash
just dev-web                  # 开发模式,日志 JSON 到 stderr
uv run python -m quilin_web   # 等价直接调用
```

MCP server 绑定 stdio,由 `packages/agent-core` 通过 MCP client 派生子进程调用。

The MCP server binds to stdio; `packages/agent-core` spawns it as a child process via its MCP client.

## 测试 / Testing

```bash
uv run pytest                 # 全部通过且 coverage ≥ 95%
```

测试 100% mock Crawl4AI(不联网、不下 Chromium),通过 `create_server(crawler_factory=...)` 注入 fake `Crawler`。

Tests fully mock Crawl4AI (no network, no Chromium download) by injecting a fake `Crawler` through `create_server(crawler_factory=...)`.

## 安全 / Safety

- 仅放行 `http` / `https`,其他 scheme 在工具入口返回 `WebOperationError`。
- `depth` / `max_pages` 强制硬上限(3 / 50),避免 sub-agent 失控全站爬。
- SSRF 黑名单复用 `web_fetch`(TS 侧)的策略——本 provider 不重复实现 IP-level 防护,假设上层 sandbox 已经做了 network policy。
- Crawl4AI 的 Playwright 实例只在工具调用周期内打开,不长期驻留。

- Only `http` / `https` URLs are accepted; other schemes raise `WebOperationError` at the tool boundary.
- `depth` / `max_pages` are hard-capped (3 / 50) to prevent runaway crawls from sub-agents.
- The SSRF blocklist is owned by the TS-side `web_fetch`; this provider trusts the upstream sandbox to enforce IP-level policy.
- Crawl4AI's Playwright instance is opened only for the duration of a single tool call and not kept alive.

## 选型记录 / Why Crawl4AI

调研中 Crawl4AI 与 Scrapling 二选一,选 Crawl4AI 是因为它的 markdown 化质量更高(为 RAG 优化、shadow DOM flatten、自动消除 consent popup),而我们的使用模式是按需调用而非长期监控。详见 `docs/05-tool/README.md` 与 Linear `QUI-131`。

We picked Crawl4AI over Scrapling because its markdown quality is RAG-optimized (shadow DOM flattening, automatic consent-popup removal), and our usage pattern is on-demand rather than long-running monitoring. See `docs/05-tool/README.md` and Linear `QUI-131` for details.
