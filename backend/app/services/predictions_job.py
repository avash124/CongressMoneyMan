"""Launch the offline P7 batch scorer (worker + cron wiring).

The scorer (``ml/scripts/score_batch.py``) is a heavy, synchronous, offline job
— it fits the ranker (~10–15 min) before writing ``trade_predictions``. It runs
in its OWN process so the backend never imports the ``ml`` package and the fit
never blocks the event loop. Same interpreter (``sys.executable``), launched
from the repo root so ``-m ml.scripts.score_batch`` resolves.
"""

import asyncio
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("predictions-job")

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _command(extra_args: list[str] | None) -> list[str]:
    return [sys.executable, "-m", "ml.scripts.score_batch", *(extra_args or [])]


async def run_batch_scorer(extra_args: list[str] | None = None) -> dict:
    """Run the scorer to completion (worker use — a background process, so
    blocking on it is fine). Returns ``{ok, returncode}``."""
    proc = await asyncio.create_subprocess_exec(*_command(extra_args), cwd=str(_REPO_ROOT))
    returncode = await proc.wait()
    if returncode != 0:
        logger.error("score_batch exited with code %s", returncode)
    return {"ok": returncode == 0, "returncode": returncode}


def spawn_batch_scorer(extra_args: list[str] | None = None) -> None:
    """Fire-and-forget launch (cron-endpoint use): return immediately while the
    scorer keeps running detached — an HTTP request cannot wait out a 15-min
    fit, and the other cron endpoints are likewise just triggers."""
    subprocess.Popen(_command(extra_args), cwd=str(_REPO_ROOT))
