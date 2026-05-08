"""Smoke test for logging configuration."""

from __future__ import annotations

import structlog

from quilin_web.logging import configure_once, logger


def test_configure_once_is_idempotent() -> None:
    configure_once()
    assert structlog.is_configured()
    configure_once()  # second call must be a no-op
    assert structlog.is_configured()


def test_logger_is_a_bound_logger() -> None:
    assert hasattr(logger, "info")
    assert hasattr(logger, "warning")
    assert hasattr(logger, "error")
