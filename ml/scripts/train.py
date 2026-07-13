"""Baseline eval entrypoint (plan build order step 3).

    backend/.venv/Scripts/python -m ml.scripts.train
    backend/.venv/Scripts/python -m ml.scripts.train --snapshot ml/snapshots/trades-<hash>.parquet

Pins a snapshot (from Supabase, or a passed parquet), runs the four baselines
through the walk-forward harness, and writes runs/<ts>-baselines/. The snapshot
hash lands in config.json so the run is reproducible (§5 addition 2).
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone

from .. import config, dataset
from ..eval import harness, report
from ..models import baselines


def main() -> int:
    parser = argparse.ArgumentParser(description="Run baseline walk-forward eval.")
    parser.add_argument(
        "--snapshot",
        help="Path to an existing parquet snapshot. If omitted, fetches from "
        "Supabase and pins a new one.",
    )
    parser.add_argument(
        "--today",
        help="Override 'today' (YYYY-MM-DD) for the maturity gate. Defaults to "
        "the real current date.",
    )
    parser.add_argument(
        "--max-folds", type=int, default=None,
        help="Cap the number of folds (for a quick smoke run).",
    )
    args = parser.parse_args()

    if args.snapshot:
        frame = dataset.load_snapshot(args.snapshot)
        snap_hash = args.snapshot
    else:
        path, snap_hash = dataset.build_snapshot_from_db()
        frame = dataset.load_snapshot(path)
        print(f"Pinned snapshot {path.name} (hash {snap_hash})")

    if frame.empty:
        print("No trades in snapshot — nothing to evaluate. Check Supabase/DNS.")
        return 1

    today = (
        datetime.strptime(args.today, "%Y-%m-%d").date()
        if args.today
        else datetime.now(timezone.utc).date()
    )

    result = harness.run_walk_forward(
        frame, baselines.all_baselines(), today=today, max_folds=args.max_folds
    )

    run_config = {
        "label": "baselines",
        "snapshot": str(snap_hash),
        "n_rows": int(len(frame)),
        "today": today.isoformat(),
        "horizon_days": config.HORIZON_DAYS,
        "k_values": list(config.K_VALUES),
        "maturity_cutoff": config.maturity_cutoff(today).isoformat(),
    }
    out_dir = report.write_run(result, run_config, label="baselines")

    print(f"\nScored {len(result['folds'])} folds, "
          f"{result['n_queries']['all']} queries.")
    print("Overall MAP by scorer:")
    for name, segs in result["scorers"].items():
        print(f"  {name:12s} MAP={segs['all'].get('ap', 0.0):.3f}  "
              f"novel R@20={segs['novel'].get('r@20', 0.0):.3f}")
    print(f"\nReport written to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
