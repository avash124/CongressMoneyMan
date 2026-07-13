"""Data-quality audit (plan build order step 1 / Phase 0).

    backend/.venv/Scripts/python -m ml.scripts.audit
    backend/.venv/Scripts/python -m ml.scripts.audit --snapshot ml/snapshots/trades-<hash>.parquet

Dumps the coverage numbers the plan's go/no-go depends on:
  - rows per year
  - filed_at null-rate  (rows with a null filed_at can't be used point-in-time)
  - filed-vs-traded lag distribution (drives the disclosure maturity gate)
  - owner-field coverage (self vs spouse/dependent — schema may lack it)
  - per-member trade counts (how few effective traders?)
  - ticker cardinality (candidate-generation universe size)

Writes ml/runs/audit/audit-<snapshot>.{json,md}. This is descriptive only — no
model, no leakage surface — so it reads transaction_date freely.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .. import config, dataset

_LATENCY_PCTILES = (50, 75, 90, 95, 99)
_STOCK_ACT_DEADLINE_DAYS = 45


def _rows_per_year(frame: pd.DataFrame) -> dict[str, int]:
    filed = frame["filed_at"].dropna()
    if filed.empty:
        return {}
    counts = filed.dt.year.value_counts().sort_index()
    return {str(int(y)): int(n) for y, n in counts.items()}


def _lag_stats(frame: pd.DataFrame) -> dict:
    """filed_at - transaction_date in days, over rows that have both."""
    both = frame.dropna(subset=["filed_at", "transaction_date"])
    if both.empty:
        return {"n": 0}
    lag_days = (both["filed_at"] - both["transaction_date"]).dt.total_seconds() / 86400.0
    lag_days = lag_days[lag_days >= 0]
    pctiles = {
        f"p{p}": round(float(np.percentile(lag_days, p)), 1) for p in _LATENCY_PCTILES
    }
    return {
        "n": int(len(lag_days)),
        "mean": round(float(lag_days.mean()), 1),
        "min": round(float(lag_days.min()), 1),
        "max": round(float(lag_days.max()), 1),
        **pctiles,
        "pct_over_45d": round(float((lag_days > _STOCK_ACT_DEADLINE_DAYS).mean() * 100), 1),
    }


def _owner_coverage(frame: pd.DataFrame) -> dict:
    """The trades schema (migration 0001) has no explicit owner column. Report
    whether one exists and its coverage — a null result IS the finding the plan
    asks for (self vs spouse/dependent split may be impossible)."""
    candidates = [c for c in ("owner", "owner_type", "filer_type") if c in frame.columns]
    if not candidates:
        return {"has_owner_field": False, "note": "no owner column in schema"}
    col = candidates[0]
    non_null = int(frame[col].notna().sum())
    return {
        "has_owner_field": True,
        "column": col,
        "coverage_pct": round(non_null / len(frame) * 100, 1),
        "values": {str(k): int(v) for k, v in frame[col].value_counts().head(10).items()},
    }


def _member_trade_counts(frame: pd.DataFrame) -> dict:
    counts = frame["bioguide_id"].dropna().value_counts()
    if counts.empty:
        return {"n_members": 0}
    return {
        "n_members": int(len(counts)),
        "median": int(counts.median()),
        "p90": int(np.percentile(counts.to_numpy(), 90)),
        "max": int(counts.max()),
        "n_with_1_trade": int((counts == 1).sum()),
        "n_with_10plus": int((counts >= 10).sum()),
        "top_10": {str(m): int(n) for m, n in counts.head(10).items()},
    }


def audit(frame: pd.DataFrame) -> dict:
    n = int(len(frame))
    filed_null = int(frame["filed_at"].isna().sum())
    txn_null = int(frame["transaction_date"].isna().sum())
    tickers = frame["ticker"].dropna()
    return {
        "n_rows": n,
        "rows_per_year": _rows_per_year(frame),
        "filed_at_null": {
            "count": filed_null,
            "pct": round(filed_null / n * 100, 2) if n else 0.0,
        },
        "transaction_date_null": {
            "count": txn_null,
            "pct": round(txn_null / n * 100, 2) if n else 0.0,
        },
        "asset_type_null_pct": (
            round(int(frame["asset_type"].isna().sum()) / n * 100, 2) if n else 0.0
        ),
        "filed_vs_traded_lag_days": _lag_stats(frame),
        "owner_coverage": _owner_coverage(frame),
        "member_trade_counts": _member_trade_counts(frame),
        "ticker_cardinality": {
            "distinct": int(tickers.nunique()),
            "null_pct": round((n - len(tickers)) / n * 100, 2) if n else 0.0,
        },
    }


def _to_markdown(report: dict, snap_hash: str) -> str:
    lag = report["filed_vs_traded_lag_days"]
    mtc = report["member_trade_counts"]
    lines = [
        f"# Data audit — snapshot `{snap_hash}`",
        f"_generated {datetime.now(timezone.utc).isoformat()}_",
        "",
        f"- **Rows**: {report['n_rows']:,}",
        f"- **filed_at null**: {report['filed_at_null']['count']:,} "
        f"({report['filed_at_null']['pct']}%) — these cannot be used point-in-time",
        f"- **transaction_date null**: {report['transaction_date_null']['pct']}%",
        f"- **asset_type null**: {report['asset_type_null_pct']}% (bulk-feed rows)",
        f"- **Distinct tickers**: {report['ticker_cardinality']['distinct']:,}",
        "",
        "## Filed-vs-traded lag (days)",
        f"- n={lag.get('n', 0):,}, mean={lag.get('mean', 'n/a')}, "
        f"p50={lag.get('p50', 'n/a')}, p90={lag.get('p90', 'n/a')}, "
        f"p95={lag.get('p95', 'n/a')}, max={lag.get('max', 'n/a')}",
        f"- **% filed >45d late**: {lag.get('pct_over_45d', 'n/a')}% "
        "(informs the late-filer slack in the maturity gate)",
        "",
        "## Member trade counts",
        f"- {mtc.get('n_members', 0)} members; median={mtc.get('median', 'n/a')}, "
        f"p90={mtc.get('p90', 'n/a')}, max={mtc.get('max', 'n/a')}",
        f"- single-trade members: {mtc.get('n_with_1_trade', 'n/a')}; "
        f"10+-trade members: {mtc.get('n_with_10plus', 'n/a')}",
        "",
        "## Owner field",
        f"- {json.dumps(report['owner_coverage'])}",
        "",
        "## Rows per year",
        "```json",
        json.dumps(report["rows_per_year"], indent=2),
        "```",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Data-quality audit.")
    parser.add_argument("--snapshot", help="Existing parquet; else fetch from DB.")
    args = parser.parse_args()

    if args.snapshot:
        frame = dataset.load_snapshot(args.snapshot)
        snap_hash = args.snapshot.split("trades-")[-1].replace(".parquet", "")
    else:
        path, snap_hash = dataset.build_snapshot_from_db()
        frame = dataset.load_snapshot(path)
        print(f"Pinned snapshot {path.name}")

    if frame.empty:
        print("No trades — check Supabase config / DNS (see project memory).")
        return 1

    report = audit(frame)
    out_dir = config.RUNS_DIR / "audit"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"audit-{snap_hash}.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    (out_dir / f"audit-{snap_hash}.md").write_text(
        _to_markdown(report, snap_hash), encoding="utf-8"
    )

    print(json.dumps(report, indent=2))
    print(f"\nAudit written to {out_dir}/audit-{snap_hash}.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
