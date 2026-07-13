"""Experiment configuration: horizon, k values, fold dates, seeds, paths.

Single source of truth for the constants the dataset, eval, and model code
share. Kept as plain module-level values (not a class) — there is one
configuration and nothing benefits from instancing it.
"""

from __future__ import annotations

import os
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv

ML_ROOT = Path(__file__).resolve().parent
RUNS_DIR = ML_ROOT / "runs"
SNAPSHOTS_DIR = ML_ROOT / "snapshots"

_REPO_ROOT = ML_ROOT.parent
load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env")

HORIZON_DAYS = 30

DISCLOSURE_LAG_DAYS = 45
LATE_FILER_SLACK_DAYS = 30

K_VALUES = (5, 10, 20)
CANDIDATE_K = 200

FOLD_STRIDE_DAYS = 7

RANDOM_SEED = 1337


def maturity_cutoff(today: date) -> date:
    """Latest as_of whose horizon has fully matured for labeling as of ``today``.

    A fold at ``as_of`` may only be scored once
    ``today >= as_of + HORIZON_DAYS + DISCLOSURE_LAG_DAYS + LATE_FILER_SLACK_DAYS``.
    Returns the newest as_of that satisfies that inequality.
    """
    return today - timedelta(
        days=HORIZON_DAYS + DISCLOSURE_LAG_DAYS + LATE_FILER_SLACK_DAYS
    )


def supabase_credentials() -> tuple[str, str] | None:
    """(rest_base_url, service_role_key) or None if unconfigured.

    Mirrors ``backend/app/core/db.py`` but lives here so ``ml`` never imports
    the FastAPI app. Note the known ``.env.local`` typo fallback
    (``SUPABASE_sERVICE_ROLE_KEY``) recorded in project memory.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv(
        "SUPABASE_sERVICE_ROLE_KEY"
    )
    if not url or not key:
        return None
    return url.rstrip("/") + "/rest/v1", key
