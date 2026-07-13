"""Run-report writer (plan §3): runs/<timestamp>/{config.json, metrics.json,
report.md}. No MLflow — a directory of small text artifacts is the tracking
layer, and it is what the independent verification agent reads.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .. import config


def _run_dir(label: str) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    d = config.RUNS_DIR / f"{ts}-{label}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _scorecard_markdown(result: dict, k_values) -> str:
    """A markdown table: one row per scorer, columns MAP + p/r/ndcg@k, plus a
    second table for novel-vs-repeat recall (the headline split)."""
    lines: list[str] = []
    lines.append(f"- Folds scored: **{len(result['folds'])}**")
    nq = result["n_queries"]
    lines.append(
        f"- Queries: **{nq['all']}** (novel-bearing {nq['novel']}, "
        f"repeat-bearing {nq['repeat']})"
    )
    lines.append("")

    cols = ["MAP"] + [f"P@{k}" for k in k_values] + [f"R@{k}" for k in k_values] + [
        f"NDCG@{k}" for k in k_values
    ]
    lines.append("### Overall (all tickers)")
    lines.append("| scorer | " + " | ".join(cols) + " |")
    lines.append("|" + "---|" * (len(cols) + 1))
    for name, segs in result["scorers"].items():
        a = segs["all"]
        row = [f"{a.get('ap', 0.0):.3f}"]
        row += [f"{a.get(f'p@{k}', 0.0):.3f}" for k in k_values]
        row += [f"{a.get(f'r@{k}', 0.0):.3f}" for k in k_values]
        row += [f"{a.get(f'ndcg@{k}', 0.0):.3f}" for k in k_values]
        lines.append(f"| {name} | " + " | ".join(row) + " |")
    lines.append("")

    lines.append("### Novel vs. repeat recall (headline)")
    ncols = [f"novel R@{k}" for k in k_values] + [f"repeat R@{k}" for k in k_values]
    lines.append("| scorer | novel MAP | repeat MAP | " + " | ".join(ncols) + " |")
    lines.append("|" + "---|" * (len(ncols) + 3))
    for name, segs in result["scorers"].items():
        nov, rep = segs["novel"], segs["repeat"]
        row = [f"{nov.get('ap', 0.0):.3f}", f"{rep.get('ap', 0.0):.3f}"]
        row += [f"{nov.get(f'r@{k}', 0.0):.3f}" for k in k_values]
        row += [f"{rep.get(f'r@{k}', 0.0):.3f}" for k in k_values]
        lines.append(f"| {name} | " + " | ".join(row) + " |")
    lines.append("")
    return "\n".join(lines)


def write_run(
    result: dict,
    run_config: dict,
    label: str = "baselines",
    k_values=config.K_VALUES,
) -> Path:
    """Persist a run and return its directory. ``run_config`` should carry the
    snapshot hash so the run is reproducible (§3, §5 addition 2)."""
    d = _run_dir(label)
    (d / "config.json").write_text(
        json.dumps(run_config, indent=2, default=str), encoding="utf-8"
    )
    (d / "metrics.json").write_text(
        json.dumps(result, indent=2, default=str), encoding="utf-8"
    )

    md = [f"# Run: {label}", ""]
    md.append("## Config")
    md.append("```json")
    md.append(json.dumps(run_config, indent=2, default=str))
    md.append("```")
    md.append("")
    md.append("## Scorecard")
    md.append(_scorecard_markdown(result, k_values))
    (d / "report.md").write_text("\n".join(md), encoding="utf-8")
    return d
