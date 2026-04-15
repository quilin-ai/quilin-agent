import os
import sys

import structlog

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
