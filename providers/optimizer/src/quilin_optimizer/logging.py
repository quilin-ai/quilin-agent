"""Structlog configuration for the quilin-optimizer MCP server.

JSON logs are written to stderr — stdout is reserved for the MCP stdio
transport so any non-JSON byte on stdout corrupts the protocol.

structlog 的 JSON 日志写入 stderr — stdout 留给 MCP stdio 传输，
任何写到 stdout 的非 JSON 字节都会损坏协议。
"""

import os
import sys

import structlog


def configure_once() -> None:
    if structlog.is_configured():
        return

    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        wrapper_class=structlog.BoundLogger,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
    )


logger = structlog.get_logger(
    service="quilin-optimizer",
    env=os.environ.get("QUILIN_ENV", "dev"),
)


__all__ = ["configure_once", "logger"]
