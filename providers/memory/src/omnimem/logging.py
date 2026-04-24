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
    service="omnimem",
    env=os.environ.get("QUILIN_ENV", "dev"),
)


__all__ = ["configure_once", "logger"]
