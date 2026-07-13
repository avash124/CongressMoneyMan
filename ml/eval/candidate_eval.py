"""Candidate-set recall measurement (plan build order step 4 gate).

Recall@k here is NOT a ranking metric — it asks only whether the candidate SET
contains each labeled ticker (a ticker outside the set can never be ranked, so
this is the hard ceiling on every downstream model's recall). The gate:
recall@1000 ≥ 0.85 on held-out folds (widened from the plan's infeasible
recall@200 ≥ 0.9 — see candidates.py budget note).

Walk-forward over the same mature folds as the ranking harness. Reported overall
and split novel-vs-repeat — novel-ticker candidate recall is what actually
matters (repeat tickers are trivially recalled via the member's own history).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

import pandas as pd

from .. import config, dataset
from ..candidates import make_candidate_generator
from . import harness, metrics


def measure_recall(
    frame: pd.DataFrame,
    *,
    today: date,
    k_values=(100, 200, 500, 1000),
    candidate_factory=make_candidate_generator,
    horizon_days: int = config.HORIZON_DAYS,
    max_folds: int | None = None,
) -> dict:
    """Macro-averaged candidate recall@k over mature folds.

    Returns::

        {
          "folds": int, "n_queries": {"all","novel","repeat"},
          "recall": {"all": {"r@k": ...}, "novel": {...}, "repeat": {...}},
          "avg_candidates": float,
        }
    """
    fold_dates = harness._fold_dates(frame, today)
    if max_folds is not None:
        fold_dates = fold_dates[:max_folds]

    acc = {seg: defaultdict(list) for seg in ("all", "novel", "repeat")}
    n_queries = {"all": 0, "novel": 0, "repeat": 0}
    cand_sizes: list[int] = []
    scored_folds = 0

    for as_of in fold_dates:
        as_of_frame = dataset.trades_as_of(frame, as_of)
        if as_of_frame.empty:
            continue
        labels_by_member = harness._fold_labels(frame, as_of, horizon_days)
        if not labels_by_member:
            continue
        generate = candidate_factory(as_of_frame, as_of)
        history_by_member = {
            member: set(group)
            for member, group in as_of_frame.dropna(subset=["ticker"]).groupby(
                "bioguide_id"
            )["ticker"]
        }

        fold_had_query = False
        for member_id, relevant in labels_by_member.items():
            if not relevant:
                continue
            candidates = generate(as_of_frame, member_id, as_of)
            if not candidates:
                continue
            cand_sizes.append(len(candidates))
            history = history_by_member.get(member_id, set())
            repeat, novel = metrics.split_novel_repeat(relevant, history)

            fold_had_query = True
            n_queries["all"] += 1
            _record(acc["all"], candidates, relevant, k_values)
            if novel:
                n_queries["novel"] += 1
                _record(acc["novel"], candidates, novel, k_values)
            if repeat:
                n_queries["repeat"] += 1
                _record(acc["repeat"], candidates, repeat, k_values)

        if fold_had_query:
            scored_folds += 1

    return {
        "folds": scored_folds,
        "n_queries": n_queries,
        "recall": {seg: _mean(acc[seg]) for seg in acc},
        "avg_candidates": round(sum(cand_sizes) / len(cand_sizes), 1)
        if cand_sizes
        else 0.0,
        "k_values": list(k_values),
    }


def _record(bucket, candidates, relevant_subset, k_values) -> None:
    for k in k_values:
        bucket[f"r@{k}"].append(metrics.recall_at_k(candidates, relevant_subset, k))


def _mean(d: dict) -> dict:
    return {key: (sum(v) / len(v) if v else 0.0) for key, v in d.items()}
