"""Walk-forward evaluation loop (plan §5, build order step 3).

Expanding-window walk-forward: for each weekly ``as_of``, build the leak-safe
as-of frame, let each scorer prepare on it, then for every active member score
a candidate set and compare the ranking to the horizon labels. Metrics are
macro-averaged over members within a fold, then over folds.

Only MATURE folds are scored (``dataset.is_window_mature``) — a window whose
disclosure period hasn't elapsed has systematically incomplete labels (§2.3).

Candidate generation is pluggable. A minimal default lives here so baselines are
evaluable now; Phase 4 replaces it with the real generator and measures
recall@k. The harness itself never changes.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Callable

import pandas as pd

from .. import config, dataset
from . import metrics

CandidateFn = Callable[[pd.DataFrame, str, date], list[str]]


def make_default_candidates(
    as_of_frame: pd.DataFrame, as_of: date | None = None, *, top_n_popular: int = 100
) -> CandidateFn:
    """Build a per-fold candidate generator with the fold-invariant parts
    precomputed once.

    Minimal P3 candidate set: the member's own traded tickers ∪ the globally
    most-popular tickers in the as-of frame. The popular list and per-member
    history are the same for every member in a fold, so computing them once (not
    once per member) turns the fold's candidate cost from O(members × rows) into
    O(rows). Deliberately simple — Phase 4 owns real recall@k. Never peeks past
    the as-of frame (no label leakage)."""
    tickers = as_of_frame.dropna(subset=["ticker"])
    popular = tickers["ticker"].value_counts().head(top_n_popular).index.tolist()
    history_by_member = {
        member: list(dict.fromkeys(group))  
        for member, group in tickers.groupby("bioguide_id")["ticker"]
    }

    def candidates(_frame: pd.DataFrame, member_id: str, _as_of: date) -> list[str]:
        mine = history_by_member.get(member_id, [])
        return list(dict.fromkeys([*mine, *popular]))

    return candidates


def _fold_dates(frame: pd.DataFrame, today: date) -> list[date]:
    """Weekly as_of dates from the first filing to the maturity cutoff.

    Starts one horizon after the earliest filing (so the first window has some
    history to learn from) and stops at ``maturity_cutoff`` so every fold is
    scorable."""
    filed = frame["filed_at"].dropna()
    if filed.empty:
        return []
    start = (filed.min() + pd.Timedelta(days=config.HORIZON_DAYS)).date()
    end = config.maturity_cutoff(today)
    if start > end:
        return []
    dates: list[date] = []
    cur = pd.Timestamp(start)
    stop = pd.Timestamp(end)
    while cur <= stop:
        dates.append(cur.date())
        cur += pd.Timedelta(days=config.FOLD_STRIDE_DAYS)
    return dates


def _fold_labels(
    frame: pd.DataFrame, as_of: date, horizon_days: int
) -> dict[str, set[str]]:
    """Every active member's label set for one fold, in a single pass.

    ``member -> {tickers transacted in (as_of, as_of + H]}``. Replaces a
    per-member full-frame scan (O(members × rows)) with one groupby — the same
    windowing as ``dataset.label_tickers``, computed once. Members with no
    labeled trade are absent (an empty label set adds only zeros)."""
    lo = dataset._as_timestamp(as_of)
    hi = lo + pd.Timedelta(days=horizon_days)
    tx = frame["transaction_date"]
    in_window = frame[
        (tx > lo) & (tx <= hi) & frame["ticker"].notna() & frame["bioguide_id"].notna()
    ]
    return {
        member: set(group)
        for member, group in in_window.groupby("bioguide_id")["ticker"]
    }


def run_walk_forward(
    frame: pd.DataFrame,
    scorers: list,
    *,
    today: date,
    candidate_factory: Callable[..., CandidateFn] = make_default_candidates,
    k_values=config.K_VALUES,
    horizon_days: int = config.HORIZON_DAYS,
    max_folds: int | None = None,
    eval_folds: list[date] | None = None,
) -> dict:
    """Run every scorer over every mature fold and return an aggregated result.

    ``eval_folds`` restricts scoring to that explicit set of as_of dates (used by
    the ranker eval to hold out later folds from training). When None, all mature
    folds from ``_fold_dates`` are scored (baseline behavior).

    Structure of the return value::

        {
          "folds": [<as_of dates scored>],
          "n_queries": {"all": int, "novel": int, "repeat": int},
          "scorers": {
              scorer_name: {
                  "all":    {metric: macro_mean, ...},
                  "novel":  {"r@k": ..., "ap": ...},   # recall-focused
                  "repeat": {"r@k": ..., "ap": ...},
              }, ...
          },
        }

    "novel"/"repeat" restrict the label set to tickers the member had never /
    had previously traded before ``as_of`` (plan's headline split).
    """
    if eval_folds is not None:
        fold_dates = list(eval_folds)
    else:
        fold_dates = _fold_dates(frame, today)
    if max_folds is not None:
        fold_dates = fold_dates[:max_folds]

    acc: dict = {
        s.name: {seg: defaultdict(list) for seg in ("all", "novel", "repeat")}
        for s in scorers
    }
    n_queries = {"all": 0, "novel": 0, "repeat": 0}
    scored_folds: list[date] = []

    for as_of in fold_dates:
        as_of_frame = dataset.trades_as_of(frame, as_of)
        if as_of_frame.empty:
            continue
        labels_by_member = _fold_labels(frame, as_of, horizon_days)
        if not labels_by_member:
            continue
        for s in scorers:
            s.prepare(as_of_frame, as_of)
        candidate_fn = candidate_factory(as_of_frame, as_of)  

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
            candidates = candidate_fn(as_of_frame, member_id, as_of)
            if not candidates:
                continue
            history = history_by_member.get(member_id, set())
            repeat, novel = metrics.split_novel_repeat(relevant, history)

            fold_had_query = True
            n_queries["all"] += 1
            if novel:
                n_queries["novel"] += 1
            if repeat:
                n_queries["repeat"] += 1

            for s in scorers:
                scores = s.score(member_id, as_of, candidates)
                ranked = _rank(candidates, scores)
                m = metrics.evaluate_query(ranked, relevant, k_values)
                for key, val in m.items():
                    acc[s.name]["all"][key].append(val)
                if novel:
                    _record_segment(acc[s.name]["novel"], ranked, novel, k_values)
                if repeat:
                    _record_segment(acc[s.name]["repeat"], ranked, repeat, k_values)

        if fold_had_query:
            scored_folds.append(as_of)

    return {
        "folds": [d.isoformat() for d in scored_folds],
        "n_queries": n_queries,
        "scorers": {
            name: {seg: _mean_dict(acc[name][seg]) for seg in acc[name]}
            for name in acc
        },
    }


def _rank(candidates: list[str], scores: list[float]) -> list[str]:
    """Sort candidates by score descending; ties broken by original order
    (stable sort) so results are deterministic."""
    order = sorted(range(len(candidates)), key=lambda i: -scores[i])
    return [candidates[i] for i in order]


def _record_segment(bucket, ranked, relevant_subset, k_values) -> None:
    bucket["ap"].append(metrics.average_precision(ranked, relevant_subset))
    for k in k_values:
        bucket[f"r@{k}"].append(metrics.recall_at_k(ranked, relevant_subset, k))


def _mean_dict(d: dict) -> dict:
    return {key: (sum(vals) / len(vals) if vals else 0.0) for key, vals in d.items()}
