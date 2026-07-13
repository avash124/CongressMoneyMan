"""LightGBM ranker train + walk-forward eval (plan build order step 5).

    backend/.venv/Scripts/python -m ml.scripts.train_ranker --snapshot ml/snapshots/trades-<hash>.parquet

Protocol (honest walk-forward, no leakage):
  1. Enumerate mature folds (``harness._fold_dates`` — every fold whose label
     window has fully disclosed).
  2. Split time-ordered: the earliest ``--train-frac`` of folds train the
     ranker; the later held-out folds are the eval set. Training never sees an
     eval fold, so there is no temporal leak.
  3. Fit the ranker on the train folds, then score the ranker AND the four
     baselines over the SAME eval folds via the walk-forward harness, using the
     real (P4) candidate generator.

Gate (plan §6 step 5): the ranker must beat persistence on macro-MAP AND on
novel-ticker recall. Winning only on pooled/repeat metrics means it memorized
the hyperactive traders — reported as FAIL.

Writes runs/<ts>-ranker/{config,metrics}.json + report.md, including the
feature-importance table (which families carry the model) for the P6 ablation.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from .. import config, dataset
from ..candidates import make_candidate_generator
from ..eval import ablation, harness, report
from ..features.build import AuxData, feature_cols
from ..models import baselines
from ..models.ranker import LGBMRankerScorer, RankerParams

_GATE_SCORER = "persistence"


def main() -> int:
    parser = argparse.ArgumentParser(description="Train + eval the LightGBM ranker.")
    parser.add_argument("--snapshot", required=True, help="Parquet snapshot path.")
    parser.add_argument("--today", help="Override 'today' (YYYY-MM-DD).")
    parser.add_argument(
        "--train-frac", type=float, default=0.7,
        help="Fraction of mature folds (earliest first) used for training; the "
        "rest are held out for eval. Default 0.7.",
    )
    parser.add_argument(
        "--train-stride", type=int, default=4,
        help="Subsample training folds by this stride to cut fit cost (weekly "
        "folds are highly overlapping). Default 4 (~monthly).",
    )
    parser.add_argument(
        "--max-eval-folds", type=int, default=None,
        help="Cap eval folds (quick smoke run).",
    )
    parser.add_argument(
        "--ablate", action="store_true",
        help="Run the P6 family ablation (base, +market, +member, +committee, "
        "+pac, all) on identical folds and write the ablation table.",
    )
    parser.add_argument(
        "--seeds", default="1337",
        help="Comma-separated seeds for the ablation (robustness). Default 1337.",
    )
    parser.add_argument("--prices", help="prices-<hash>.parquet snapshot.")
    parser.add_argument("--profiles", help="profiles-<hash>.parquet snapshot.")
    parser.add_argument("--members", help="members-<hash>.parquet snapshot.")
    parser.add_argument("--committees", help="committees-<hash>.parquet snapshot.")
    parser.add_argument("--pac", help="pac-<hash>.parquet snapshot.")
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

    all_folds = harness._fold_dates(frame, today)
    if len(all_folds) < 4:
        print(f"Only {len(all_folds)} mature folds — too few to split.")
        return 1

    split = int(len(all_folds) * args.train_frac)
    train_folds = all_folds[:split][:: args.train_stride]
    eval_folds = all_folds[split:]
    if args.max_eval_folds is not None:
        eval_folds = eval_folds[: args.max_eval_folds]
    print(
        f"{len(all_folds)} mature folds -> {len(train_folds)} train "
        f"(stride {args.train_stride}), {len(eval_folds)} eval."
    )

    aux, aux_hashes = _load_aux(args)
    if args.ablate:
        return _run_ablation(
            frame, train_folds, eval_folds, aux, aux_hashes, args, today
        )

    ranker = LGBMRankerScorer()
    print("Fitting ranker...")
    ranker.fit(frame, train_folds, candidate_factory=make_candidate_generator)

    scorers = [ranker, *baselines.all_baselines()]
    print(f"Scoring {len(scorers)} scorers over {len(eval_folds)} eval folds...")
    result = harness.run_walk_forward(
        frame,
        scorers,
        today=today,
        candidate_factory=make_candidate_generator,
        eval_folds=eval_folds,
    )

    gate = _check_gate(result)
    run_config = {
        "label": "ranker",
        "snapshot": args.snapshot,
        "n_rows": int(len(frame)),
        "today": today.isoformat(),
        "horizon_days": config.HORIZON_DAYS,
        "k_values": list(config.K_VALUES),
        "train_folds": len(train_folds),
        "eval_folds": len(eval_folds),
        "train_frac": args.train_frac,
        "train_stride": args.train_stride,
        "features": list(feature_cols(("base",))),
        "gate": gate,
    }

    out_dir = report.write_run(result, run_config, label="ranker")
    _append_ranker_sections(out_dir, ranker, gate)

    print(f"\nScored {len(result['folds'])} eval folds, "
          f"{result['n_queries']['all']} queries.")
    _print_comparison(result)
    verdict = "PASS" if gate["passed"] else "FAIL"
    print(f"\nGATE (beat {_GATE_SCORER} on macro-MAP AND novel recall@20): "
          f"{verdict}")
    print(f"  MAP:        ranker {gate['ranker_map']:.4f} vs "
          f"{_GATE_SCORER} {gate['baseline_map']:.4f}")
    print(f"  novel R@20: ranker {gate['ranker_novel_r20']:.4f} vs "
          f"{_GATE_SCORER} {gate['baseline_novel_r20']:.4f}")
    print(f"Report: {out_dir}")
    return 0 if gate["passed"] else 2


def _load_aux(args) -> tuple[AuxData, dict]:
    """Load whichever aux snapshots were passed; record their hashes for the run
    config (a family whose snapshot is omitted degrades to zeros — the ablation
    still runs, and the report notes the frame was absent)."""
    def load(path):
        return dataset.load_snapshot(path) if path else None

    aux = AuxData(
        prices=load(args.prices),
        profiles=load(args.profiles),
        members=load(args.members),
        committees=load(args.committees),
        pac=load(args.pac),
    )
    hashes = {
        "prices": args.prices,
        "profiles": args.profiles,
        "members": args.members,
        "committees": args.committees,
        "pac": args.pac,
    }
    present = [k for k, v in hashes.items() if v]
    print(f"Aux frames loaded: {', '.join(present) if present else '(none)'}")
    return aux, hashes


def _run_ablation(frame, train_folds, eval_folds, aux, aux_hashes, args, today) -> int:
    """Fit + eval each family subset on identical folds across the given seeds,
    write the ablation table, and print it. Returns 0 (the ablation is the gate
    artifact itself — there is no single pass/fail; the TABLE is the deliverable)."""
    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]

    available = {
        fam
        for fam, frame_ in (
            ("market", aux.prices if aux.prices is not None else aux.profiles),
            ("member", aux.members),
            ("committee", aux.committees),
            ("pac", aux.pac),
        )
        if frame_ is not None
    }
    subsets = ablation.subsets_for(available)
    print(f"Ablation subsets: {[name for name, _ in subsets]}")

    def ranker_factory(families, aux_data, seed):
        return LGBMRankerScorer(
            RankerParams(random_state=seed), families=families, aux=aux_data
        )

    per_seed: dict[int, list[dict]] = {}
    for seed in seeds:
        print(f"\n=== Ablation seed {seed} ===")
        rows = ablation.run_ablation(
            frame, train_folds, eval_folds, aux,
            today=today, seed=seed, ranker_factory=ranker_factory,
            subsets=subsets,
        )
        per_seed[seed] = rows

    run_config = {
        "label": "ablation",
        "snapshot": args.snapshot,
        "n_rows": int(len(frame)),
        "today": today.isoformat(),
        "horizon_days": config.HORIZON_DAYS,
        "train_folds": len(train_folds),
        "eval_folds": len(eval_folds),
        "train_frac": args.train_frac,
        "train_stride": args.train_stride,
        "seeds": seeds,
        "aux_snapshots": aux_hashes,
        "available_families": sorted(available),
        "subsets": [name for name, _ in subsets],
    }
    out_dir = _write_ablation_run(run_config, per_seed)
    print(f"\nAblation report: {out_dir}")
    return 0


def _write_ablation_run(run_config: dict, per_seed: dict[int, list[dict]]):
    """Write runs/<ts>-ablation/{config.json, ablation.json, report.md}."""
    import json

    out_dir = report._run_dir("ablation")
    (out_dir / "config.json").write_text(
        json.dumps(run_config, indent=2, default=str), encoding="utf-8"
    )
    (out_dir / "ablation.json").write_text(
        json.dumps({str(s): rows for s, rows in per_seed.items()}, indent=2,
                   default=str),
        encoding="utf-8",
    )
    md = ["# Run: ablation (P6 feature families)", ""]
    md.append("## Config")
    md.append("```json")
    md.append(json.dumps(run_config, indent=2, default=str))
    md.append("```")
    md.append("")
    md.append("## Ablation tables")
    md.append("")
    md.append(
        "Cumulative family subsets on identical train/eval folds. Δ is vs the "
        "P5 **base** row. Tracks MAP, novel R@20, repeat R@20 (a novel win that "
        "craters MAP is the §2 tradeoff wall, not progress)."
    )
    md.append("")
    for seed, rows in per_seed.items():
        md.append(ablation.ablation_markdown(rows, seed))
    last_rows = list(per_seed.values())[-1]
    all_row = last_rows[-1] if last_rows else None
    if all_row and all_row["importances"]:
        md.append(f"## Feature importance — {all_row['name']} model (gain)")
        md.append("")
        md.append("| feature | gain |")
        md.append("|---|---|")
        imps = all_row["importances"]
        total = sum(imps.values()) or 1.0
        for name, val in sorted(imps.items(), key=lambda kv: -kv[1]):
            md.append(f"| {name} | {val / total:.3f} |")
        md.append("")
    (out_dir / "report.md").write_text("\n".join(md), encoding="utf-8")
    return out_dir


def _check_gate(result: dict) -> dict:
    r = result["scorers"]["lgbm_ranker"]
    b = result["scorers"][_GATE_SCORER]
    ranker_map = r["all"].get("ap", 0.0)
    baseline_map = b["all"].get("ap", 0.0)
    ranker_novel = r["novel"].get("r@20", 0.0)
    baseline_novel = b["novel"].get("r@20", 0.0)
    passed = ranker_map > baseline_map and ranker_novel > baseline_novel
    return {
        "passed": bool(passed),
        "ranker_map": ranker_map,
        "baseline_map": baseline_map,
        "ranker_novel_r20": ranker_novel,
        "baseline_novel_r20": baseline_novel,
    }


def _print_comparison(result: dict) -> None:
    print(f"{'scorer':14s} {'MAP':>7s} {'novel R@20':>11s} {'repeat R@20':>12s}")
    for name, segs in result["scorers"].items():
        print(f"{name:14s} {segs['all'].get('ap', 0.0):7.4f} "
              f"{segs['novel'].get('r@20', 0.0):11.4f} "
              f"{segs['repeat'].get('r@20', 0.0):12.4f}")


def _append_ranker_sections(out_dir, ranker: LGBMRankerScorer, gate: dict) -> None:
    """Append the gate verdict and feature-importance table to report.md."""
    imps = ranker.feature_importances or {}
    ordered = sorted(imps.items(), key=lambda kv: -kv[1])
    lines = ["", "## Gate (plan §6 step 5)", ""]
    lines.append(
        f"Beat **{_GATE_SCORER}** on macro-MAP AND novel-ticker recall@20:"
    )
    lines.append("")
    lines.append("| metric | ranker | " + _GATE_SCORER + " | verdict |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| macro-MAP | {gate['ranker_map']:.4f} | {gate['baseline_map']:.4f} | "
        f"{'✅' if gate['ranker_map'] > gate['baseline_map'] else '❌'} |"
    )
    lines.append(
        f"| novel R@20 | {gate['ranker_novel_r20']:.4f} | "
        f"{gate['baseline_novel_r20']:.4f} | "
        f"{'✅' if gate['ranker_novel_r20'] > gate['baseline_novel_r20'] else '❌'} |"
    )
    lines.append("")
    lines.append(f"**{'PASS' if gate['passed'] else 'FAIL'}**")
    lines.append("")
    lines.append("## Feature importance (gain)")
    lines.append("")
    lines.append("| feature | gain |")
    lines.append("|---|---|")
    total = sum(imps.values()) or 1.0
    for name, val in ordered:
        lines.append(f"| {name} | {val / total:.3f} |")
    report_path = out_dir / "report.md"
    report_path.write_text(
        report_path.read_text(encoding="utf-8") + "\n".join(lines),
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
