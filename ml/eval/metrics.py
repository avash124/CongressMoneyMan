"""Ranking metrics for the walk-forward eval (plan §5).

All functions operate on a single ranked prediction for one (member, as_of):
``ranked`` is the candidate tickers sorted best-first, ``relevant`` is the set
of tickers the member actually traded in the horizon (the labels). The harness
macro-averages these over members and folds.

Pure functions, no pandas — hand-checkable against tiny worked examples
(``ml/tests/test_metrics.py``), which is why this module is test-first.
"""

from __future__ import annotations

import math
from collections.abc import Sequence


def precision_at_k(ranked: Sequence[str], relevant: set[str], k: int) -> float:
    """Fraction of the top-k that are relevant. If fewer than k candidates
    exist, the denominator is still k (you had k slots to fill)."""
    if k <= 0:
        return 0.0
    top = ranked[:k]
    hits = sum(1 for t in top if t in relevant)
    return hits / k


def recall_at_k(ranked: Sequence[str], relevant: set[str], k: int) -> float:
    """Fraction of relevant items captured in the top-k. Undefined (returns
    0.0) when there is nothing to recall."""
    if not relevant:
        return 0.0
    top = set(ranked[:k])
    hits = sum(1 for t in relevant if t in top)
    return hits / len(relevant)


def average_precision(ranked: Sequence[str], relevant: set[str]) -> float:
    """AP: mean of precision@i taken at each rank i where a relevant item is
    hit, normalized by the number of relevant items. The per-query term of MAP.
    """
    if not relevant:
        return 0.0
    hits = 0
    running = 0.0
    for i, t in enumerate(ranked, start=1):
        if t in relevant:
            hits += 1
            running += hits / i
    return running / len(relevant)


def dcg_at_k(ranked: Sequence[str], relevant: set[str], k: int) -> float:
    """Binary-gain DCG with the standard ``1 / log2(rank + 1)`` discount."""
    total = 0.0
    for i, t in enumerate(ranked[:k], start=1):
        if t in relevant:
            total += 1.0 / math.log2(i + 1)
    return total


def ndcg_at_k(ranked: Sequence[str], relevant: set[str], k: int) -> float:
    """DCG@k normalized by the ideal DCG (all relevant items ranked first).
    1.0 iff every relevant item that fits in k is at the top."""
    if not relevant:
        return 0.0
    ideal_hits = min(len(relevant), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, ideal_hits + 1))
    if idcg == 0.0:
        return 0.0
    return dcg_at_k(ranked, relevant, k) / idcg


def evaluate_query(
    ranked: Sequence[str],
    relevant: set[str],
    k_values: Sequence[int],
) -> dict[str, float]:
    """All metrics for one ranked prediction. Keys: ``ap``, ``p@k``, ``r@k``,
    ``ndcg@k`` for each k."""
    out: dict[str, float] = {"ap": average_precision(ranked, relevant)}
    for k in k_values:
        out[f"p@{k}"] = precision_at_k(ranked, relevant, k)
        out[f"r@{k}"] = recall_at_k(ranked, relevant, k)
        out[f"ndcg@{k}"] = ndcg_at_k(ranked, relevant, k)
    return out


def split_novel_repeat(
    relevant: set[str], member_history: set[str]
) -> tuple[set[str], set[str]]:
    """Partition relevant tickers into (repeat, novel): repeat = ever traded by
    this member before as_of; novel = never traded before. Novel-ticker recall
    is the plan's headline number — it is what proves the model isn't just
    memorizing each member's usual names."""
    repeat = relevant & member_history
    novel = relevant - member_history
    return repeat, novel
