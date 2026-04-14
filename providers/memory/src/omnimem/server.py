from __future__ import annotations

import asyncio

from .logging import logger


async def serve() -> None:
    logger.info(msg="omnimem placeholder started")
    await asyncio.Event().wait()


def main() -> None:
    asyncio.run(serve())
