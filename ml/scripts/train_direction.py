"""Direction-head gate: head vs per-member modal baseline (plan §2.6, P7 §2.1).

    backend/.venv/Scripts/python -m ml.scripts.train_direction \
        --snapshot ml/snapshots/trades-<hash>.parquet \
        --prices ml/snapshots/prices-<hash>.parquet \
        --profiles ml/snapshots/profiles-<hash>.parquet --seeds 1337,99

Protocol (same honest walk-forward split as train_ranker):
  1. Enumerate mature folds; earliest ``--train-frac`` train, the rest held out.
  2. Fit the direction head (DEFAULT_FAMILIES + aux) AND the modal baseline on
     the train folds' positive events.
  3. On the FULL held-out set, collect every labeled (member, ticker) event's
     buy/sell direction and compare head vs baseline on **balanced accuracy** and
     **ROC AUC**, over ≥2 seeds (never a smoke slice — P5's 8-fold trap).

Gate (plan §2.6 / P7 §6.1 checkpoint 1): keep the head ONLY if it beats the
modal baseline on the held-out set across every seed; else DROP it and serve
rank/score only (``p_buy`` null), documented like P6 dropped member/PAC/committee.

Writes runs/<ts>-direction/{config,metrics}.json + report.md — the artifact the
independent gate-re-derivation agent checks.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import numpy as np

from .. import config, dataset
from ..eval import harness, report
from ..features.build import DEFAULT_FAMILIES, AuxData
from ..models.direction import (
    DirectionHead,
    DirectionParams,
    ModalDirectionBaseline,
    horizon_direction_labels,
)


def _load_aux(args) -> AuxData:
    def load(path):
        return dataset.load_snapshot(path) if path else None

    return AuxData(prices=load(args.prices), profiles=load(args.profiles))


def collect_events(frame, eval_folds, head, baseline, horizon_days):
    """Held-out (y_true, head P(buy), baseline P(buy)) over every labeled event."""
    y_true: list[int] = []
    head_p: list[float] = []
    base_p: list[float] = []
    for as_of in eval_folds:
        as_of_frame = dataset.trades_as_of(frame, as_of)
        if as_of_frame.empty:
            continue
        events = horizon_direction_labels(frame, as_of, horizon_days)
        if not events:
            continue
        head.prepare(as_of_frame, as_of)
        baseline.prepare(as_of_frame, as_of)
        for member_id, tick_labels in events.items():
            tickers = list(tick_labels)
            y_true.extend(tick_labels[t] for t in tickers)
            head_p.extend(head.predict_direction(member_id, as_of, tickers))
            base_p.extend(baseline.predict_direction(member_id, as_of, tickers))
    return np.array(y_true), np.array(head_p), np.array(base_p)


def _scores(y_true, p) -> dict:
    """Balanced accuracy (hard, threshold 0.5) + ROC AUC (soft). AUC is None if
    the held-out set is single-class (undefined)."""
    from sklearn.metrics import balanced_accuracy_score, roc_auc_score

    pred = (p >= 0.5).astype(int)
    bal_acc = float(balanced_accuracy_score(y_true, pred))
    auc = None
    if len(np.unique(y_true)) == 2:
        auc = float(roc_auc_score(y_true, p))
    return {"balanced_accuracy": bal_acc, "auc": auc}


def main() -> int:
    parser = argparse.ArgumentParser(description="Direction head vs modal baseline gate.")
    parser.add_argument("--snapshot", required=True, help="Trades snapshot path.")
    parser.add_argument("--prices", help="prices-<hash>.parquet aux.")
    parser.add_argument("--profiles", help="profiles-<hash>.parquet aux.")
    parser.add_argument("--today", help="Override 'today' (YYYY-MM-DD).")
    parser.add_argument("--train-frac", type=float, default=0.7)
    parser.add_argument("--train-stride", type=int, default=4)
    parser.add_argument("--max-eval-folds", type=int, default=None)
    parser.add_argument("--seeds", default="1337,99", help="Comma-separated seeds (≥2).")
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

    aux = _load_aux(args)
    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]

    per_seed: dict[str, dict] = {}
    verdicts: list[bool] = []
    for seed in seeds:
        print(f"\n=== seed {seed} ===")
        head = DirectionHead(
            DirectionParams(random_state=seed), families=DEFAULT_FAMILIES, aux=aux
        )
        head.fit(frame, train_folds)
        baseline = ModalDirectionBaseline()
        baseline.fit(frame, train_folds)

        y_true, head_p, base_p = collect_events(
            frame, eval_folds, head, baseline, config.HORIZON_DAYS
        )
        if len(y_true) == 0:
            print("No held-out direction events — cannot judge the gate.")
            return 1
        head_m = _scores(y_true, head_p)
        base_m = _scores(y_true, base_p)
        beats = head_m["balanced_accuracy"] > base_m["balanced_accuracy"]
        if head_m["auc"] is not None and base_m["auc"] is not None:
            beats = beats and head_m["auc"] > base_m["auc"]
        verdicts.append(beats)
        per_seed[str(seed)] = {
            "n_events": int(len(y_true)),
            "n_buys": int(y_true.sum()),
            "head": head_m,
            "baseline": base_m,
            "head_beats_baseline": bool(beats),
        }
        print(
            f"  events={len(y_true)} buys={int(y_true.sum())}\n"
            f"  head     bal_acc={head_m['balanced_accuracy']:.4f} auc={head_m['auc']}\n"
            f"  baseline bal_acc={base_m['balanced_accuracy']:.4f} auc={base_m['auc']}\n"
            f"  head beats baseline: {beats}"
        )

    kept = all(verdicts)
    run_config = {
        "label": "direction",
        "snapshot": args.snapshot,
        "n_rows": int(len(frame)),
        "today": today.isoformat(),
        "horizon_days": config.HORIZON_DAYS,
        "train_folds": len(train_folds),
        "eval_folds": len(eval_folds),
        "train_frac": args.train_frac,
        "train_stride": args.train_stride,
        "seeds": seeds,
        "aux": {"prices": args.prices, "profiles": args.profiles},
        "families": list(DEFAULT_FAMILIES),
        "verdict": "KEEP" if kept else "DROP",
    }
    _write_report(run_config, per_seed, kept)
    print(
        f"\nGATE (head beats modal baseline on bal-acc AND auc, all seeds): "
        f"{'KEEP' if kept else 'DROP'}"
    )
    return 0


def _write_report(run_config: dict, per_seed: dict, kept: bool):
    out_dir = report._run_dir("direction")
    (out_dir / "config.json").write_text(
        json.dumps(run_config, indent=2, default=str), encoding="utf-8"
    )
    (out_dir / "metrics.json").write_text(
        json.dumps(per_seed, indent=2, default=str), encoding="utf-8"
    )
    md = ["# Run: direction head vs modal baseline (P7 §2.1)", ""]
    md.append("## Config")
    md.append("```json")
    md.append(json.dumps(run_config, indent=2, default=str))
    md.append("```")
    md.append("")
    md.append("## Head vs modal baseline (held-out events)")
    md.append("")
    md.append("| seed | events | head bal-acc | base bal-acc | head auc | base auc | head wins |")
    md.append("|---|---|---|---|---|---|---|")
    for seed, row in per_seed.items():
        h, b = row["head"], row["baseline"]
        md.append(
            f"| {seed} | {row['n_events']} | {h['balanced_accuracy']:.4f} | "
            f"{b['balanced_accuracy']:.4f} | {h['auc']} | {b['auc']} | "
            f"{'✅' if row['head_beats_baseline'] else '❌'} |"
        )
    md.append("")
    md.append(f"**Verdict: {'KEEP' if kept else 'DROP'}** — "
              + ("the head beats the modal baseline on every seed; serve `p_buy`."
                 if kept else
                 "the head does not beat the modal baseline; drop it and serve "
                 "rank/score only (`p_buy` null), same discipline as P6."))
    md.append("")
    (out_dir / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"Report: {out_dir}")
    return out_dir


if __name__ == "__main__":
    raise SystemExit(main())
