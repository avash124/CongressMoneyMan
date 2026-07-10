"""Standalone background worker (port of scripts/worker.ts).

Runs every sync job once at startup, then repeats each on its own interval.

    python worker.py
"""

import asyncio
import logging
import time

from app import config  # noqa: F401  (loads .env.local)
from app.services.sync import (
    backfill_trades,
    sync_fec,
    sync_members,
    sync_rankings,
    sync_stock_performance,
    sync_trades,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)
logger = logging.getLogger("worker")

MINUTE = 60
HOUR = 60 * MINUTE

JOBS = [
    {"name": "members", "interval": 24 * HOUR, "run": sync_members},
    {"name": "trades", "interval": 5 * MINUTE, "run": sync_trades},
    {"name": "trades-backfill", "interval": 24 * HOUR, "run": backfill_trades},
    {"name": "rankings", "interval": 60 * MINUTE, "run": sync_rankings},
    {"name": "stock-performance", "interval": 24 * HOUR, "run": sync_stock_performance},
    {"name": "fec", "interval": 24 * HOUR, "run": sync_fec},
]

_in_progress: set[str] = set()


async def run_job(job: dict) -> None:
    if job["name"] in _in_progress:
        logger.info("%s: still running, skipping this tick", job["name"])
        return
    _in_progress.add(job["name"])
    started_at = time.monotonic()
    try:
        result = await job["run"]()
        logger.info(
            "%s: ok (%.1fs) %s", job["name"], time.monotonic() - started_at, result
        )
    except Exception as error:
        logger.error("%s: failed: %s", job["name"], error)
    finally:
        _in_progress.discard(job["name"])


async def schedule(job: dict) -> None:
    while True:
        await asyncio.sleep(job["interval"])
        await run_job(job)


async def main() -> None:
    logger.info("starting — seeding once, then polling on interval")

    for job in JOBS:
        await run_job(job)

    logger.info(
        "scheduled: %s",
        ", ".join(f"{job['name']} every {job['interval'] // MINUTE}min" for job in JOBS),
    )
    await asyncio.gather(*(schedule(job) for job in JOBS))


if __name__ == "__main__":
    asyncio.run(main())
