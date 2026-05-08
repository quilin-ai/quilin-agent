"""Unit tests for the quilin-web MCP server.

Crawl4AI is *not* exercised here — every test injects a fake
:class:`Crawler` so the suite stays fast and never touches Playwright or
the network.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import replace

import pytest

from quilin_web.server import (
    DEFAULT_TIMEOUT_MS,
    DEFAULT_WORD_COUNT_THRESHOLD,
    MAX_DEPTH,
    MAX_PAGES,
    MAX_QUERY_LENGTH,
    Crawler,
    CrawlResult,
    WebOperationError,
    _normalize_link,
    _same_host,
    _summarize_markdown,
    _validate_depth,
    _validate_max_pages,
    _validate_query,
    _validate_url,
    _web_crawl,
    _web_extract,
    create_server,
)


class FakeCrawler:
    """Records every fetch call and returns canned results."""

    def __init__(
        self,
        responses: dict[str, CrawlResult] | None = None,
        *,
        default: CrawlResult | None = None,
        raise_for: dict[str, Exception] | None = None,
    ) -> None:
        self._responses = responses or {}
        self._default = default
        self._raise_for = raise_for or {}
        self.calls: list[tuple[str, int, int]] = []

    async def fetch(
        self,
        url: str,
        *,
        word_count_threshold: int = DEFAULT_WORD_COUNT_THRESHOLD,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
    ) -> CrawlResult:
        self.calls.append((url, word_count_threshold, timeout_ms))
        if url in self._raise_for:
            raise self._raise_for[url]
        if url in self._responses:
            return self._responses[url]
        if self._default is not None:
            return replace(self._default, url=url)
        return CrawlResult(url=url, status=200, markdown="", title=None, links=())


def make_factory(crawler: Crawler) -> Callable[[], object]:
    async def _factory() -> Crawler:
        return crawler

    return _factory


@pytest.mark.asyncio
async def test_web_extract_returns_cleaned_markdown_payload() -> None:
    crawler = FakeCrawler(
        {
            "https://example.com/article": CrawlResult(
                url="https://example.com/article",
                status=200,
                markdown="# Hello\n\nbody.",
                title="Hello",
                links=(),
            ),
        }
    )

    raw = await _web_extract(
        crawler,
        "https://example.com/article",
        "what is hello?",
        timeout_ms=30_000,
        word_count_threshold=5,
    )
    payload = json.loads(raw)

    assert payload["url"] == "https://example.com/article"
    assert payload["status"] == 200
    assert payload["markdown"] == "# Hello\n\nbody."
    assert payload["title"] == "Hello"
    assert payload["query"] == "what is hello?"
    assert crawler.calls == [("https://example.com/article", 5, 30_000)]


@pytest.mark.asyncio
async def test_web_extract_treats_blank_query_as_absent() -> None:
    crawler = FakeCrawler(default=CrawlResult(url="x", status=200, markdown="md", title=None))

    raw = await _web_extract(
        crawler,
        "https://example.com/",
        "   ",
        timeout_ms=DEFAULT_TIMEOUT_MS,
        word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
    )
    payload = json.loads(raw)

    assert "query" not in payload


@pytest.mark.asyncio
async def test_web_extract_rejects_non_http_url() -> None:
    crawler = FakeCrawler()

    with pytest.raises(WebOperationError, match="http/https"):
        await _web_extract(
            crawler,
            "file:///etc/passwd",
            None,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )


@pytest.mark.asyncio
async def test_web_extract_wraps_crawler_exception() -> None:
    crawler = FakeCrawler(
        raise_for={"https://example.com/x": RuntimeError("boom")},
    )

    with pytest.raises(WebOperationError, match="boom"):
        await _web_extract(
            crawler,
            "https://example.com/x",
            None,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )


@pytest.mark.asyncio
async def test_web_extract_rejects_oversized_query() -> None:
    crawler = FakeCrawler()

    with pytest.raises(WebOperationError, match="characters"):
        await _web_extract(
            crawler,
            "https://example.com/",
            "x" * (MAX_QUERY_LENGTH + 1),
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )


@pytest.mark.asyncio
async def test_web_crawl_follows_same_host_links_up_to_depth() -> None:
    root = CrawlResult(
        url="https://example.com/",
        status=200,
        markdown="root",
        title="Root",
        links=(
            "https://example.com/a",
            "https://example.com/b",
            "https://other.example/skip",
        ),
    )
    page_a = CrawlResult(
        url="https://example.com/a",
        status=200,
        markdown="a",
        title="A",
        links=("/c",),
    )
    page_b = CrawlResult(
        url="https://example.com/b",
        status=200,
        markdown="b",
        title="B",
        links=(),
    )
    crawler = FakeCrawler(
        {
            "https://example.com/": root,
            "https://example.com/a": page_a,
            "https://example.com/b": page_b,
        }
    )

    raw = await _web_crawl(
        crawler,
        "https://example.com/",
        depth=2,
        max_pages=10,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
    )
    payload = json.loads(raw)

    assert payload["page_count"] == 3
    urls = [p["url"] for p in payload["pages"]]
    assert "https://example.com/" in urls
    assert "https://example.com/a" in urls
    assert "https://example.com/b" in urls
    # Cross-host link must be skipped
    assert "https://other.example/skip" not in urls


@pytest.mark.asyncio
async def test_web_crawl_stops_at_max_pages() -> None:
    crawler = FakeCrawler(
        default=CrawlResult(
            url="x",
            status=200,
            markdown="md",
            title=None,
            links=("https://example.com/next",),
        )
    )

    raw = await _web_crawl(
        crawler,
        "https://example.com/",
        depth=3,
        max_pages=2,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
    )
    payload = json.loads(raw)

    assert payload["page_count"] == 2


@pytest.mark.asyncio
async def test_web_crawl_skips_pages_that_raise_and_keeps_going() -> None:
    root = CrawlResult(
        url="https://example.com/",
        status=200,
        markdown="root",
        title="Root",
        links=("https://example.com/broken", "https://example.com/ok"),
    )
    crawler = FakeCrawler(
        {
            "https://example.com/": root,
            "https://example.com/ok": CrawlResult(
                url="https://example.com/ok",
                status=200,
                markdown="ok",
                title="OK",
            ),
        },
        raise_for={"https://example.com/broken": RuntimeError("broken")},
    )

    raw = await _web_crawl(
        crawler,
        "https://example.com/",
        depth=2,
        max_pages=10,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
    )
    payload = json.loads(raw)
    urls = [p["url"] for p in payload["pages"]]
    assert "https://example.com/ok" in urls
    assert "https://example.com/broken" not in urls


@pytest.mark.asyncio
async def test_web_crawl_excerpts_long_markdown() -> None:
    long_md = "x" * 2_000
    crawler = FakeCrawler(default=CrawlResult(url="x", status=200, markdown=long_md, title=None))

    raw = await _web_crawl(
        crawler,
        "https://example.com/",
        depth=1,
        max_pages=1,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
    )
    payload = json.loads(raw)

    excerpt = payload["pages"][0]["markdown_excerpt"]
    assert excerpt.endswith("...")
    assert len(excerpt) <= 800


@pytest.mark.asyncio
async def test_web_crawl_rejects_invalid_depth_and_pages() -> None:
    crawler = FakeCrawler()

    with pytest.raises(WebOperationError):
        await _web_crawl(
            crawler,
            "https://example.com/",
            depth=0,
            max_pages=1,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )

    with pytest.raises(WebOperationError):
        await _web_crawl(
            crawler,
            "https://example.com/",
            depth=MAX_DEPTH + 1,
            max_pages=1,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )

    with pytest.raises(WebOperationError):
        await _web_crawl(
            crawler,
            "https://example.com/",
            depth=1,
            max_pages=0,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )

    with pytest.raises(WebOperationError):
        await _web_crawl(
            crawler,
            "https://example.com/",
            depth=1,
            max_pages=MAX_PAGES + 1,
            timeout_ms=DEFAULT_TIMEOUT_MS,
            word_count_threshold=DEFAULT_WORD_COUNT_THRESHOLD,
        )


def test_validate_url_rejects_missing_host() -> None:
    with pytest.raises(WebOperationError, match="missing a host"):
        _validate_url("https://")


def test_validate_url_accepts_https() -> None:
    assert _validate_url("https://example.com/x") == "https://example.com/x"


def test_validate_query_returns_none_for_blank() -> None:
    assert _validate_query(None) is None
    assert _validate_query("") is None
    assert _validate_query("   ") is None


def test_validate_query_strips_whitespace() -> None:
    assert _validate_query("  hi  ") == "hi"


def test_validate_depth_and_max_pages_round_trip() -> None:
    assert _validate_depth(1) == 1
    assert _validate_depth(MAX_DEPTH) == MAX_DEPTH
    assert _validate_max_pages(1) == 1
    assert _validate_max_pages(MAX_PAGES) == MAX_PAGES


def test_normalize_link_resolves_relative_links_and_drops_fragments() -> None:
    assert _normalize_link("https://example.com/a/", "b") == "https://example.com/a/b"
    assert _normalize_link("https://example.com/", "/x#section") == "https://example.com/x"


def test_normalize_link_rejects_non_http_targets() -> None:
    assert _normalize_link("https://example.com/", "javascript:alert(1)") is None
    assert _normalize_link("https://example.com/", "mailto:x@y") is None


def test_same_host_treats_case_insensitively() -> None:
    assert _same_host("https://Example.com/a", "https://EXAMPLE.com/b")


def test_same_host_rejects_other_host() -> None:
    assert not _same_host("https://example.com/", "https://other.example/")


def test_summarize_markdown_returns_full_text_when_below_cap() -> None:
    assert _summarize_markdown("hi", max_chars=80) == "hi"


def test_create_server_registers_two_tools() -> None:
    crawler = FakeCrawler(default=CrawlResult(url="x", status=200, markdown="md", title=None))
    server = create_server(make_factory(crawler))
    # FastMCP exposes registered tools through its tool manager.
    tool_names = sorted(t.name for t in server._tool_manager.list_tools())
    assert tool_names == ["web_crawl", "web_extract"]


@pytest.mark.asyncio
async def test_create_server_extract_tool_uses_factory() -> None:
    crawler = FakeCrawler(
        {
            "https://example.com/p": CrawlResult(
                url="https://example.com/p",
                status=200,
                markdown="page",
                title=None,
            ),
        }
    )
    server = create_server(make_factory(crawler))

    handler = server._tool_manager.get_tool("web_extract")
    assert handler is not None
    raw = await handler.run({"url": "https://example.com/p"})
    payload = json.loads(_extract_text(raw))

    assert payload["markdown"] == "page"
    assert crawler.calls == [
        ("https://example.com/p", DEFAULT_WORD_COUNT_THRESHOLD, DEFAULT_TIMEOUT_MS)
    ]


@pytest.mark.asyncio
async def test_create_server_crawl_tool_uses_factory() -> None:
    root = CrawlResult(
        url="https://example.com/",
        status=200,
        markdown="root",
        title=None,
        links=(),
    )
    crawler = FakeCrawler({"https://example.com/": root})
    server = create_server(make_factory(crawler))

    handler = server._tool_manager.get_tool("web_crawl")
    assert handler is not None
    raw = await handler.run({"url": "https://example.com/", "depth": 1, "max_pages": 5})
    payload = json.loads(_extract_text(raw))

    assert payload["page_count"] == 1
    assert payload["pages"][0]["url"] == "https://example.com/"


def _extract_text(raw: object) -> str:
    """Pull the JSON string out of a FastMCP tool result payload.

    FastMCP returns either a string, a list of content blocks, or a tuple.
    """

    if isinstance(raw, str):
        return raw
    if isinstance(raw, list | tuple):
        for item in raw:
            if isinstance(item, str):
                return item
            text = getattr(item, "text", None)
            if isinstance(text, str):
                return text
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                return item["text"]
    text_attr = getattr(raw, "text", None)
    if isinstance(text_attr, str):
        return text_attr
    raise AssertionError(f"could not extract text from {raw!r}")
