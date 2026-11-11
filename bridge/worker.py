import asyncio
import logging

from .queue import Queue

logger = logging.getLogger(__name__)


async def recover_queue(queue: Queue):
    while True:
        try:
            await asyncio.to_thread(queue.recover)
        except Exception:
            logger.error("Queue maintenance failed")
        await asyncio.sleep(1)
