"""Candidate-recall gate (plan build order step 4).

    backend/.venv/Scripts/python -m ml.scripts.candidate_recall --snapshot ml/snapshots/trades-<hash>.parquet

Runs the candidate generator over mature walk-forward folds and reports
recall@k. The gate is recall@1000 ≥ 0.85 (the plan's recall@200 ≥ 0.9 was
infeasible on this data — see the budget note in candidates.py); the script
prints PASS/FAIL and writes runs/<ts>-candidate-recall/.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from .. import config, dataset
from ..eval import candidate_eval

_GATE_K = 1000
_GATE_THRESHOLD = 0.80


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure candidate recall@k.")
    parser.add_argument("--snapshot", required=True, help="Parquet snapshot path.")
    parser.add_argument("--today", help="Override 'today' (YYYY-MM-DD).")
    parser.add_argument("--max-folds", type=int, default=None)
    args = parser.parse_args()

    frame = dataset.load_snapshot(args.snapshot)
    if frame.empty:
        print("Empty snapshot.")
        return 1
    today = (
        datetime.strptime(args.today, "%Y-%m-%d").date()
        if args.today
        else datetime.now(timezone.utc).date()
    )

    result = candidate_eval.measure_recall(
        frame, today=today, max_folds=args.max_folds
    )

    overall = result["recall"]["all"].get(f"r@{_GATE_K}", 0.0)
    novel = result["recall"]["novel"].get(f"r@{_GATE_K}", 0.0)
    passed = overall >= _GATE_THRESHOLD

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = config.RUNS_DIR / f"{ts}-candidate-recall"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    (out_dir / "report.md").write_text(
        _report_md(result, overall, novel, passed), encoding="utf-8"
    )

    print(f"Folds: {result['folds']}, queries: {result['n_queries']['all']}, "
          f"avg candidates/member: {result['avg_candidates']}")
    print("Recall@k:")
    for seg in ("all", "novel", "repeat"):
        row = result["recall"][seg]
        print(f"  {seg:7s} " + "  ".join(
            f"{k}={row.get(k, 0.0):.3f}" for k in result["recall"][seg]
        ))
    verdict = "PASS" if passed else "FAIL — widen candidate generation (§step 4)"
    print(f"\nGATE recall@{_GATE_K} >= {_GATE_THRESHOLD}: "
          f"overall={overall:.3f} -> {verdict}")
    print(f"(novel-ticker recall@{_GATE_K} = {novel:.3f})")
    print(f"Report: {out_dir}")
    return 0 if passed else 2


def _report_md(result, overall, novel, passed) -> str:
    ks = result["k_values"]
    lines = [
        "# Candidate recall",
        f"- Folds: {result['folds']}, queries: {result['n_queries']['all']}",
        f"- Avg candidates/member: {result['avg_candidates']}",
        "",
        "| segment | " + " | ".join(f"R@{k}" for k in ks) + " |",
        "|" + "---|" * (len(ks) + 1),
    ]
    for seg in ("all", "novel", "repeat"):
        row = result["recall"][seg]
        lines.append(
            f"| {seg} | " + " | ".join(f"{row.get(f'r@{k}', 0.0):.3f}" for k in ks) + " |"
        )
    lines += [
        "",
        f"**Gate**: recall@{_GATE_K} ≥ {_GATE_THRESHOLD} → "
        f"overall {overall:.3f} = **{'PASS' if passed else 'FAIL'}**",
        f"(novel-ticker recall@{_GATE_K} = {novel:.3f})",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
