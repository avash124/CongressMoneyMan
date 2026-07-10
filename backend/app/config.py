"""Environment configuration.

The Next.js app keeps its secrets in `.env.local` at the repo root; the Python
backend reads the same file so both share one set of credentials.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env")


def congress_api_key() -> str | None:
    return os.getenv("CONGRESS_API_KEY") or os.getenv("CONGRESS_GOV_API_KEY")


def require_congress_api_key() -> str:
    api_key = congress_api_key()
    if not api_key:
        raise RuntimeError("Missing CONGRESS_API_KEY")
    return api_key


def quiver_api_key() -> str | None:
    return os.getenv("QUIVER_API_KEY")


def fec_api_key() -> str | None:
    return os.getenv("FEC_API_KEY")


def cron_secret() -> str | None:
    return os.getenv("CRON_SECRET")
