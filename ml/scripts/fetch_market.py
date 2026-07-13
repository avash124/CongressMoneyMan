"""Fetch + pin the P6 market aux snapshots (prices + company profiles).

    backend/.venv/Scripts/python -m ml.scripts.fetch_market \
        --snapshot ml/snapshots/trades-<hash>.parquet

Derives the candidate ticker universe from a trades snapshot (the tickers the
candidate generator can ever propose), fetches adjusted daily closes (Alpaca)
and company profiles (FMP) for them, and pins ``prices-<hash>.parquet`` and
``profiles-<hash>.parquet`` under ``ml/snapshots/``. Politely paced
(``PRICE_DELAY_MS``) to respect Alpaca's ~200 req/min window.

Point-in-time note: this pull is a *superset* over calendar time — it fetches
the full close history from ``--from`` to today. The as-of windowing
(``close_date <= as_of``) happens in ``features/market.py`` at feature-build
time, NOT here, so one price snapshot serves every fold. Requires ALPACA_KEY /
ALPACA_SECRET / FMP_API_KEY in the environment (loaded by ``ml.config``).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone

from .. import dataset


def _universe(frame, top_n: int | None) -> list[str]:
    """The candidate ticker universe = most-traded tickers in the snapshot.
    Ordered by trade frequency so a ``--top-n`` cap keeps the tickers that
    actually appear as candidates. None -> the full distinct universe."""
    counts = (
        frame.dropna(subset=["ticker"])["ticker"].value_counts()
    )
    tickers = counts.index.tolist()
    return tickers[:top_n] if top_n else tickers


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch + pin market aux snapshots.")
    parser.add_argument("--snapshot", required=True, help="Trades parquet snapshot.")
    parser.add_argument(
        "--from", dest="from_date", default="2022-01-01",
        help="Earliest close date to fetch (ISO). Default 2022-01-01.",
    )
    parser.add_argument(
        "--top-n", type=int, default=None,
        help="Cap the ticker universe to the N most-traded (cheaper pull).",
    )
    parser.add_argument(
        "--profiles-only", action="store_true",
        help="Fetch + pin only company profiles (skip the price pull). Use to "
        "re-pin profiles after an FMP quota reset without re-pulling closes.",
    )
    args = parser.parse_args()

    frame = dataset.load_snapshot(args.snapshot)
    if frame.empty:
        print("Empty trades snapshot.")
        return 1

    tickers = _universe(frame, args.top_n)
    end = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if args.profiles_only:
        print(f"Fetching profiles only for {len(tickers)} tickers "
              f"(paced {dataset.PRICE_DELAY_MS} ms/req)...")
        path, h = dataset.fetch_profiles_snapshot(tickers)
        print(f"  profiles  -> {path.name}  (hash {h})")
        return 0

    print(
        f"Fetching closes + profiles for {len(tickers)} tickers "
        f"[{args.from_date} .. {end}] (paced {dataset.PRICE_DELAY_MS} ms/req)..."
    )

    pinned = dataset.fetch_market_snapshots(tickers, args.from_date, end)
    for kind, (path, h) in pinned.items():
        print(f"  {kind:9s} -> {path.name}  (hash {h})")
    print("Done. Pass these hashes to train_ranker --ablate for reproducibility.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
