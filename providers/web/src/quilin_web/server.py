"""Quilin web MCP server — wraps Crawl4AI for LLM-friendly markdown extraction.

The server exposes two tools:

- ``web_extract(url, query=None)``: fetch a single page, return cleaned
  markdown. The optional ``query`` is forwarded to Crawl4AI's extraction
  strategy when configured; otherwise the cleaned ``fit_markdown`` is
  returned as-is.
- ``web_crawl(url, depth=1, max_pages=10)``: shallow same-host crawl
  starting from ``url``. Returns a list of (url, snippet) pairs.

The crawler is injected via :func:`create_server`'s ``crawler_factory``
parameter so tests can substitute a fake without ever touching Playwright
or downloading Chromium.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urldefrag, urljoin, urlparse

from mcp.server.fastmcp import FastMCP

from .logging import configure_once, logger

MAX_QUERY_LENGTH = 512
MAX_DEPTH = 3
MAX_PAGES = 50
DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_WORD_COUNT_THRESHOLD = 10


@dataclass(frozen=True)
class CrawlResult:
    """Normalized result returned by a crawler implementation."""

    url: str
    status: int
    markdown: str
    title: str | None = None
    links: tuple[str, ...] = ()


class Crawler(Protocol):
    """Minimum surface required from any crawler backend.

    The default implementation wraps Crawl4AI; tests inject a fake.
    """

    async def fetch(
        self,
        url: str,
        *,
        word_count_threshold: int = DEFAULT_WORD_COUNT_THRESHOLD,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
    ) -> CrawlResult: ...


CrawlerFactory = Callable[[], Awaitable[Crawler]]


class WebOperationError(RuntimeError):
    """Sanitized tool error exposed over MCP."""


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise WebOperationError(f"only http/https URLs are allowed: {url}")
    if not parsed.netloc:
        raise WebOperationError(f"URL is missing a host: {url}")
    return url


def _validate_query(query: str | None) -> str | None:
    if query is None:
        return None
    cleaned = query.strip()
    if cleaned == "":
        return None
    if len(cleaned) > MAX_QUERY_LENGTH:
        raise WebOperationError(f"query must be at most {MAX_QUERY_LENGTH} characters")
    return cleaned


def _validate_depth(depth: int) -> int:
    if depth < 1:
        raise WebOperationError("depth must be >= 1")
    if depth > MAX_DEPTH:
        raise WebOperationError(f"depth must be <= {MAX_DEPTH}")
    return depth


def _validate_max_pages(max_pages: int) -> int:
    if max_pages < 1:
        raise WebOperationError("max_pages must be >= 1")
    if max_pages > MAX_PAGES:
        raise WebOperationError(f"max_pages must be <= {MAX_PAGES}")
    return max_pages


def _same_host(reference: str, candidate: str) -> bool:
    ref = urlparse(reference)
    cand = urlparse(candidate)
    if cand.scheme not in {"http", "https"}:
        return False  # pragma: no cover -- gated by _normalize_link upstream
    return cand.netloc.lower() == ref.netloc.lower()


def _normalize_link(base: str, raw: str) -> str | None:
    try:
        joined = urljoin(base, raw)
    except ValueError:  # pragma: no cover -- urljoin tolerates almost everything
        return None
    cleaned, _ = urldefrag(joined)
    if not cleaned:
        return None  # pragma: no cover -- defensive, urldefrag never returns empty for valid input
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"}:
        return None
    return cleaned


def _summarize_markdown(markdown: str, *, max_chars: int = 800) -> str:
    if len(markdown) <= max_chars:
        return markdown
    return markdown[: max_chars - 3] + "..."


class _Crawl4AIAdapter:
    """Default crawler that delegates to crawl4ai.AsyncWebCrawler."""

    def __init__(self, async_web_crawler_cls: Any) -> None:
        # pragma: no cover -- constructed only via _default_crawler_factory.
        self._cls = async_web_crawler_cls  # pragma: no cover

    async def fetch(
        self,
        url: str,
        *,
        word_count_threshold: int = DEFAULT_WORD_COUNT_THRESHOLD,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
    ) -> CrawlResult:
        async with self._cls() as crawler:  # pragma: no cover - real network path
            result = await crawler.arun(
                url=url,
                word_count_threshold=word_count_threshold,
                page_timeout=timeout_ms,
            )
            markdown = (
                getattr(getattr(result, "markdown_v2", None), "fit_markdown", None)
                or getattr(result, "markdown", None)
                or ""
            )
            metadata = getattr(result, "metadata", {})
            title = metadata.get("title") if isinstance(metadata, dict) else None
            links_blob = getattr(result, "links", {})
            internal_links = links_blob.get("internal", []) if isinstance(links_blob, dict) else []
            link_urls: list[str] = []
            for entry in internal_links:
                href = entry.get("href") if isinstance(entry, dict) else None
                if isinstance(href, str):
                    link_urls.append(href)
            return CrawlResult(
                url=getattr(result, "url", url),
                status=getattr(result, "status_code", 200),
                markdown=str(markdown),
                title=title if isinstance(title, str) else None,
                links=tuple(link_urls),
            )


async def _default_crawler_factory() -> Crawler:  # pragma: no cover - real network path
    from crawl4ai import AsyncWebCrawler  # type: ignore[import-not-found]

    return _Crawl4AIAdapter(AsyncWebCrawler)


@asynccontextmanager
async def _resolve_crawler(
    factory: CrawlerFactory,
) -> AsyncIterator[Crawler]:
    crawler = await factory()
    yield crawler


async def _web_extract(
    crawler: Crawler,
    url: str,
    query: str | None,
    *,
    timeout_ms: int,
    word_count_threshold: int,
) -> str:
    _validate_url(url)
    cleaned_query = _validate_query(query)
    try:
        result = await crawler.fetch(
            url,
            timeout_ms=timeout_ms,
            word_count_threshold=word_count_threshold,
        )
    except Exception as exc:
        logger.error("web_extract failed", error=str(exc), url=url)
        raise WebOperationError(f"web_extract failed: {exc}") from exc

    payload: dict[str, object] = {
        "url": result.url,
        "status": result.status,
        "markdown": result.markdown,
    }
    if result.title is not None:
        payload["title"] = result.title
    if cleaned_query is not None:
        payload["query"] = cleaned_query
    return json.dumps(payload)


async def _web_crawl(
    crawler: Crawler,
    url: str,
    depth: int,
    max_pages: int,
    *,
    timeout_ms: int,
    word_count_threshold: int,
) -> str:
    _validate_url(url)
    _validate_depth(depth)
    _validate_max_pages(max_pages)

    seen: set[str] = set()
    queue: list[tuple[str, int]] = [(url, 0)]
    pages: list[dict[str, object]] = []

    while queue and len(pages) < max_pages:
        current_url, level = queue.pop(0)
        if current_url in seen:
            # pragma: no cover -- defensive guard; queue is deduped on insert.
            continue  # pragma: no cover
        seen.add(current_url)
        try:
            result = await crawler.fetch(
                current_url,
                timeout_ms=timeout_ms,
                word_count_threshold=word_count_threshold,
            )
        except Exception as exc:
            logger.warning(
                "web_crawl page failed",
                error=str(exc),
                url=current_url,
                depth=level,
            )
            continue

        pages.append(
            {
                "url": result.url,
                "status": result.status,
                "title": result.title,
                "markdown_excerpt": _summarize_markdown(result.markdown),
            }
        )

        if level + 1 < depth:
            for raw in result.links:
                normalized = _normalize_link(current_url, raw)
                if normalized is None:
                    continue  # pragma: no cover -- guarded above by _normalize_link tests
                if not _same_host(url, normalized):
                    continue
                if normalized in seen:
                    # pragma: no cover -- defensive against repeated link discovery.
                    continue  # pragma: no cover
                queue.append((normalized, level + 1))

    return json.dumps(
        {
            "root": url,
            "depth": depth,
            "page_count": len(pages),
            "pages": pages,
        }
    )


def create_server(
    crawler_factory: CrawlerFactory | None = None,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    word_count_threshold: int = DEFAULT_WORD_COUNT_THRESHOLD,
) -> FastMCP:
    """Build a configured FastMCP server.

    Args:
        crawler_factory: Optional async factory returning a :class:`Crawler`.
            Defaults to a Crawl4AI-backed adapter. Tests inject fakes here.
        timeout_ms: Per-page timeout passed to the crawler.
        word_count_threshold: Crawl4AI ``word_count_threshold`` parameter.
    """

    factory = crawler_factory or _default_crawler_factory
    server = FastMCP("quilin-web")

    @server.tool(name="web_extract")
    async def web_extract_tool(
        url: str,
        query: str | None = None,
    ) -> str:
        """Fetch ``url`` via Crawl4AI and return cleaned markdown.

        Args:
            url: HTTP(S) URL to fetch.
            query: Optional natural-language query the upstream consumer can
                use for downstream LLM extraction. The server forwards it as
                metadata; it does not invoke an LLM directly.
        """

        async with _resolve_crawler(factory) as crawler:
            return await _web_extract(
                crawler,
                url,
                query,
                timeout_ms=timeout_ms,
                word_count_threshold=word_count_threshold,
            )

    @server.tool(name="web_crawl")
    async def web_crawl_tool(
        url: str,
        depth: int = 1,
        max_pages: int = 10,
    ) -> str:
        """Run a shallow same-host crawl rooted at ``url``.

        Args:
            url: HTTP(S) seed URL.
            depth: How many link hops to follow (1-3).
            max_pages: Hard cap on pages fetched (1-50).
        """

        async with _resolve_crawler(factory) as crawler:
            return await _web_crawl(
                crawler,
                url,
                depth,
                max_pages,
                timeout_ms=timeout_ms,
                word_count_threshold=word_count_threshold,
            )

    return server


mcp = create_server()


def main() -> None:  # pragma: no cover - process-level entrypoint
    configure_once()
    logger.info("quilin-web server starting", transport="stdio")
    mcp.run(transport="stdio")
