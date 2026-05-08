#!/usr/bin/env python3
"""E2E real-network acceptance script for quilin-web (QUI-131 / Phase 3).

This script exercises the live Crawl4AI backend against real URLs and records
structured results to both stdout (JSON) and /tmp/quilin-e2e-quilin-web.log.

Run with:
    cd providers/web
    uv run python scripts/e2e-real-network.py

Requires: uv sync --extra crawler  (crawl4ai + Playwright Chromium)
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

LOG_FILE = Path("/tmp/quilin-e2e-quilin-web.log")

# ---------------------------------------------------------------------------
# Minimal logging setup — JSON lines to LOG_FILE, human-readable to stderr
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
log = logging.getLogger("e2e-real-network")

_log_fh = LOG_FILE.open("a", encoding="utf-8")


def _log_json(**kwargs: object) -> None:
    entry = {"ts": datetime.now(UTC).isoformat(), **kwargs}
    _log_fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    _log_fh.flush()


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------


@dataclass
class AcceptanceResult:
    point: int
    label: str
    url: str
    passed: bool
    observed: str
    expected: str
    detail: dict = field(default_factory=dict)
    error: str | None = None


# ---------------------------------------------------------------------------
# Import server internals — factory + core functions
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from quilin_web.server import (  # noqa: E402
    MAX_DEPTH,
    MAX_PAGES,
    WebOperationError,
    _default_crawler_factory,
    _resolve_crawler,
    _web_crawl,
    _web_extract,
)


async def _get_crawler():  # type: ignore[return]
    async with _resolve_crawler(_default_crawler_factory) as crawler:
        return crawler  # pragma: no cover — real network path


# ---------------------------------------------------------------------------
# Individual acceptance checks
# ---------------------------------------------------------------------------


async def check_web_extract_wikipedia() -> AcceptanceResult:
    """AP-3a: web_extract on Wikipedia/Markdown returns clean markdown."""
    url = "https://en.wikipedia.org/wiki/Markdown"
    log.info("AP-3a: web_extract Wikipedia Markdown")
    _log_json(point=3, sub="a", action="start", url=url)

    try:
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            raw = await _web_extract(
                crawler, url, "What is Markdown?", timeout_ms=90_000, word_count_threshold=10
            )
        payload = json.loads(raw)
        md: str = payload.get("markdown", "")

        has_content = len(md) > 500
        mentions_markdown = "markdown" in md.lower()
        no_js_root_div = '<div id="root">' not in md and "<div id='root'>" not in md
        no_consent_popup = not any(
            kw in md.lower() for kw in ("gdpr", "cookie consent", "accept cookies")
        )

        passed = has_content and mentions_markdown and no_js_root_div and no_consent_popup
        observed = (
            f"len={len(md)} mentions_markdown={mentions_markdown} "
            f"no_root_div={no_js_root_div} no_consent={no_consent_popup}"
        )
        detail = {
            "status": payload.get("status"),
            "markdown_length": len(md),
            "first_200_chars": md[:200],
            "mentions_markdown": mentions_markdown,
            "no_js_root_div": no_js_root_div,
            "no_consent_popup": no_consent_popup,
        }
        _log_json(point=3, sub="a", passed=passed, markdown_length=len(md))
        return AcceptanceResult(
            point=3,
            label="web_extract Wikipedia/Markdown",
            url=url,
            passed=passed,
            observed=observed,
            expected="len>500, mentions 'markdown', no JS root div, no consent popup",
            detail=detail,
        )
    except Exception as exc:
        log.error("AP-3a failed: %s", exc)
        _log_json(point=3, sub="a", passed=False, error=str(exc))
        return AcceptanceResult(
            point=3,
            label="web_extract Wikipedia/Markdown",
            url=url,
            passed=False,
            observed="exception",
            expected="clean markdown payload",
            error=str(exc),
        )


async def check_web_extract_mdn() -> AcceptanceResult:
    """AP-3b: web_extract on MDN HTML page returns structured markdown."""
    url = "https://developer.mozilla.org/en-US/docs/Web/HTML"
    log.info("AP-3b: web_extract MDN HTML")
    _log_json(point=3, sub="b", action="start", url=url)

    try:
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            raw = await _web_extract(
                crawler, url, None, timeout_ms=90_000, word_count_threshold=10
            )
        payload = json.loads(raw)
        md: str = payload.get("markdown", "")

        has_content = len(md) > 200
        mentions_html = "html" in md.lower()
        has_markdown_links = "[" in md and "](http" in md

        passed = has_content and mentions_html and has_markdown_links
        observed = (
            f"len={len(md)} mentions_html={mentions_html} "
            f"has_links={has_markdown_links}"
        )
        detail = {
            "status": payload.get("status"),
            "markdown_length": len(md),
            "first_200_chars": md[:200],
            "mentions_html": mentions_html,
            "has_markdown_links": has_markdown_links,
        }
        _log_json(point=3, sub="b", passed=passed, markdown_length=len(md))
        return AcceptanceResult(
            point=3,
            label="web_extract MDN/HTML",
            url=url,
            passed=passed,
            observed=observed,
            expected="len>200, mentions 'html', contains markdown links",
            detail=detail,
        )
    except Exception as exc:
        log.error("AP-3b failed: %s", exc)
        _log_json(point=3, sub="b", passed=False, error=str(exc))
        return AcceptanceResult(
            point=3,
            label="web_extract MDN/HTML",
            url=url,
            passed=False,
            observed="exception",
            expected="clean markdown payload",
            error=str(exc),
        )


async def check_web_crawl_same_host() -> AcceptanceResult:
    """AP-4: web_crawl Wikipedia depth=2, max_pages=5 — same-host only."""
    url = "https://en.wikipedia.org/wiki/Markdown"
    log.info("AP-4: web_crawl Wikipedia same-host")
    _log_json(point=4, action="start", url=url, depth=2, max_pages=5)

    try:
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            raw = await _web_crawl(
                crawler,
                url,
                depth=2,
                max_pages=5,
                timeout_ms=90_000,
                word_count_threshold=10,
            )
        payload = json.loads(raw)
        pages: list[dict] = payload.get("pages", [])
        page_urls = [p.get("url", "") for p in pages]

        at_least_one = len(pages) >= 1
        within_cap = len(pages) <= 5
        all_same_host = all("en.wikipedia.org" in u for u in page_urls)
        root_included = any("wiki/Markdown" in u for u in page_urls)

        passed = at_least_one and within_cap and all_same_host and root_included
        observed = (
            f"page_count={len(pages)} all_same_host={all_same_host} "
            f"root_included={root_included}"
        )
        detail = {
            "page_count": len(pages),
            "page_urls": page_urls,
            "all_same_host": all_same_host,
            "root_included": root_included,
        }
        _log_json(point=4, passed=passed, page_count=len(pages), all_same_host=all_same_host)
        return AcceptanceResult(
            point=4,
            label="web_crawl Wikipedia same-host depth=2 max_pages=5",
            url=url,
            passed=passed,
            observed=observed,
            expected="1-5 pages, all en.wikipedia.org, root page included",
            detail=detail,
        )
    except Exception as exc:
        log.error("AP-4 failed: %s", exc)
        _log_json(point=4, passed=False, error=str(exc))
        return AcceptanceResult(
            point=4,
            label="web_crawl Wikipedia same-host",
            url=url,
            passed=False,
            observed="exception",
            expected="same-host only pages",
            error=str(exc),
        )


async def check_bounds_depth_exceeded() -> AcceptanceResult:
    """AP-5a: depth > 3 raises WebOperationError."""
    url = "https://en.wikipedia.org/wiki/Markdown"
    log.info("AP-5a: bounds — depth > MAX_DEPTH")

    try:
        # We need a crawler but it won't be called — error is raised before fetch.
        # Use _default_crawler_factory to get a real crawler but the validation
        # short-circuits before any network call.
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            try:
                await _web_crawl(
                    crawler,
                    url,
                    depth=MAX_DEPTH + 1,
                    max_pages=1,
                    timeout_ms=5_000,
                    word_count_threshold=10,
                )
                passed = False
                observed = "no exception raised"
            except WebOperationError as exc:
                passed = True
                observed = f"WebOperationError: {exc}"
    except Exception as exc:
        passed = False
        observed = f"unexpected exception: {exc}"

    _log_json(point=5, sub="a", passed=passed, observed=observed)
    return AcceptanceResult(
        point=5,
        label=f"bounds: depth > {MAX_DEPTH} raises WebOperationError",
        url=url,
        passed=passed,
        observed=observed,
        expected=f"WebOperationError when depth > {MAX_DEPTH}",
    )


async def check_bounds_max_pages_exceeded() -> AcceptanceResult:
    """AP-5b: max_pages > 50 raises WebOperationError."""
    url = "https://en.wikipedia.org/wiki/Markdown"
    log.info("AP-5b: bounds — max_pages > MAX_PAGES")

    try:
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            try:
                await _web_crawl(
                    crawler,
                    url,
                    depth=1,
                    max_pages=MAX_PAGES + 1,
                    timeout_ms=5_000,
                    word_count_threshold=10,
                )
                passed = False
                observed = "no exception raised"
            except WebOperationError as exc:
                passed = True
                observed = f"WebOperationError: {exc}"
    except Exception as exc:
        passed = False
        observed = f"unexpected exception: {exc}"

    _log_json(point=5, sub="b", passed=passed, observed=observed)
    return AcceptanceResult(
        point=5,
        label=f"bounds: max_pages > {MAX_PAGES} raises WebOperationError",
        url=url,
        passed=passed,
        observed=observed,
        expected=f"WebOperationError when max_pages > {MAX_PAGES}",
    )


async def check_bounds_non_http_url() -> AcceptanceResult:
    """AP-5c: non-http URL raises WebOperationError."""
    url = "file:///etc/passwd"
    log.info("AP-5c: bounds — non-http URL")

    try:
        async with _resolve_crawler(_default_crawler_factory) as crawler:
            try:
                await _web_extract(
                    crawler, url, None, timeout_ms=5_000, word_count_threshold=10
                )
                passed = False
                observed = "no exception raised"
            except WebOperationError as exc:
                passed = True
                observed = f"WebOperationError: {exc}"
    except Exception as exc:
        passed = False
        observed = f"unexpected exception: {exc}"

    _log_json(point=5, sub="c", passed=passed, observed=observed)
    return AcceptanceResult(
        point=5,
        label="bounds: non-http URL raises WebOperationError",
        url=url,
        passed=passed,
        observed=observed,
        expected="WebOperationError for file:// URL",
    )


async def check_graceful_degradation() -> AcceptanceResult:
    """AP-6: server starts without crawl4ai; tools report error at call time.

    We simulate this by patching the import inside _default_crawler_factory.
    The real test is done last (the task says accept cost of re-syncing) but
    here we verify the contract by checking the server module only lazily
    imports crawl4ai (not at import time).
    """
    log.info("AP-6: graceful degradation — lazy crawl4ai import")

    try:
        import importlib
        import unittest.mock

        # Verify that quilin_web.server itself does NOT import crawl4ai at
        # module load time (the import is inside _default_crawler_factory).
        import sys as _sys

        # Remove crawl4ai from sys.modules temporarily and re-import server.
        crawl4ai_keys = [k for k in _sys.modules if k.startswith("crawl4ai")]
        backed_up = {k: _sys.modules.pop(k) for k in crawl4ai_keys}

        try:
            # Force re-import of server module without crawl4ai in sys.modules
            server_mod_key = "quilin_web.server"
            backed_server = _sys.modules.pop(server_mod_key, None)

            with unittest.mock.patch.dict(_sys.modules, {"crawl4ai": None}):
                import importlib

                try:
                    import quilin_web.server  # noqa: F401 — just checking it imports

                    passed = True
                    observed = "quilin_web.server imported without crawl4ai in sys.modules"
                except ImportError as exc:
                    passed = False
                    observed = f"ImportError at import time: {exc}"
        finally:
            # Restore
            _sys.modules.update(backed_up)
            if backed_server is not None:
                _sys.modules[server_mod_key] = backed_server

    except Exception as exc:
        passed = False
        observed = f"unexpected error: {exc}"

    _log_json(point=6, passed=passed, observed=observed)
    return AcceptanceResult(
        point=6,
        label="graceful degradation: server imports without crawl4ai",
        url="n/a",
        passed=passed,
        observed=observed,
        expected="quilin_web.server importable without crawl4ai at module level",
    )


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


async def main() -> None:
    log.info("=== quilin-web E2E real-network acceptance ===")
    _log_json(action="run_start")

    checks = [
        check_web_extract_wikipedia(),
        check_web_extract_mdn(),
        check_web_crawl_same_host(),
        check_bounds_depth_exceeded(),
        check_bounds_max_pages_exceeded(),
        check_bounds_non_http_url(),
        check_graceful_degradation(),
    ]

    # Run sequentially — Chromium instance management is simpler this way.
    results: list[AcceptanceResult] = []
    for coro in checks:
        result = await coro
        results.append(result)
        status = "PASS" if result.passed else "FAIL"
        log.info("[%s] AP-%d — %s", status, result.point, result.label)

    # Summary
    passed_count = sum(1 for r in results if r.passed)
    total = len(results)
    log.info("=== Results: %d/%d passed ===", passed_count, total)

    output = {
        "run_at": datetime.now(UTC).isoformat(),
        "passed": passed_count,
        "total": total,
        "all_passed": passed_count == total,
        "results": [
            {
                "point": r.point,
                "label": r.label,
                "url": r.url,
                "passed": r.passed,
                "expected": r.expected,
                "observed": r.observed,
                "error": r.error,
                "detail": r.detail,
            }
            for r in results
        ],
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))
    _log_json(action="run_complete", passed=passed_count, total=total)
    _log_fh.close()

    sys.exit(0 if passed_count == total else 1)


if __name__ == "__main__":
    asyncio.run(main())
