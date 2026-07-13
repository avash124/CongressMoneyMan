"""Feature-family ablation (plan §6 step 6 — the P6 gate).

Fits the ranker on a fixed set of family subsets over IDENTICAL train/eval folds
and returns a table of held-out metrics (MAP / novel R@20 / repeat R@20) plus
deltas vs the P5 base. The point is NOT that every family helps — success is a
trustworthy table showing which do; families that don't move the metrics get
dropped and that is reported honestly.

The subsets are cumulative in build-order (base, +market, +member, +committee,
+pac, all) so each row isolates the marginal effect of adding one family on top
of P5. All rows use the same folds, the same candidate generator, and the same
aux frames — only the enabled ``families`` differ, so a metric delta is
attributable to the family, not the split.
"""

from __future__ import annotations

import logging
import time
from datetime import date

from ..candidates import make_candidate_generator
from ..features.build import AuxData
from . import harness

logger = logging.getLogger("ml.ablation")

ALL_ABLATION_SUBSETS: list[tuple[str, tuple[str, ...]]] = [
    ("base", ("base",)),
    ("+market", ("base", "market")),
    ("+member", ("base", "market", "member")),
    ("+committee", ("base", "market", "member", "committee")),
    ("+pac", ("base", "market", "member", "committee", "pac")),
    ("all", ("base", "market", "member", "committee", "pac")),
]

ABLATION_SUBSETS = ALL_ABLATION_SUBSETS


def subsets_for(available: set[str]) -> list[tuple[str, tuple[str, ...]]]:
    """Cumulative subsets restricted to families whose aux data is present.

    ``available`` is the set of P6 family names with a loaded aux frame (e.g.
    ``{"market", "member", "pac"}``). Families are added in build-order; a
    missing family is skipped so no row duplicates its predecessor. Always
    includes ``base``; the final ``all`` row = base + every available family."""
    order = ["market", "member", "committee", "pac"]
    active = [f for f in order if f in available]
    subsets: list[tuple[str, tuple[str, ...]]] = [("base", ("base",))]
    acc: list[str] = ["base"]
    for fam in active:
        acc = acc + [fam]
        subsets.append((f"+{fam}", tuple(acc)))
    return subsets


def _headline(result: dict) -> dict[str, float]:
    """Pull the three tracked numbers from a single-scorer walk-forward result."""
    r = result["scorers"]["lgbm_ranker"]
    return {
        "map": r["all"].get("ap", 0.0),
        "novel_r20": r["novel"].get("r@20", 0.0),
        "repeat_r20": r["repeat"].get("r@20", 0.0),
    }


def run_ablation(
    frame,
    train_folds: list[date],
    eval_folds: list[date],
    aux: AuxData,
    *,
    today: date,
    seed: int,
    ranker_factory,
    subsets: list[tuple[str, tuple[str, ...]]] | None = None,
) -> list[dict]:
    """Fit + eval each family subset on identical folds. Returns one dict per
    subset: ``{name, families, map, novel_r20, repeat_r20}`` plus ``d_*`` deltas
    vs the base row. ``ranker_factory(families, aux, seed)`` builds a fresh
    ranker (injected so tests can stub it). ``subsets`` defaults to the full
    catalogue; pass ``subsets_for(available)`` to skip data-less families."""
    rows: list[dict] = []
    base_metrics: dict[str, float] | None = None

    for name, families in (subsets or ABLATION_SUBSETS):
        t0 = time.time()
        ranker = ranker_factory(families, aux, seed)
        ranker.fit(frame, train_folds, candidate_factory=make_candidate_generator)
        result = harness.run_walk_forward(
            frame,
            [ranker],
            today=today,
            candidate_factory=make_candidate_generator,
            eval_folds=eval_folds,
        )
        metrics = _headline(result)
        if base_metrics is None:
            base_metrics = metrics
        logger.info(
            "[seed %s] %-11s MAP %.4f (%+.4f)  novelR@20 %.4f (%+.4f)  "
            "repeatR@20 %.4f (%+.4f)  [%.0fs]",
            seed, name, metrics["map"], metrics["map"] - base_metrics["map"],
            metrics["novel_r20"], metrics["novel_r20"] - base_metrics["novel_r20"],
            metrics["repeat_r20"], metrics["repeat_r20"] - base_metrics["repeat_r20"],
            time.time() - t0,
        )
        print(
            f"  [seed {seed}] {name:11s} "
            f"MAP {metrics['map']:.4f} ({metrics['map']-base_metrics['map']:+.4f})  "
            f"novelR@20 {metrics['novel_r20']:.4f} "
            f"({metrics['novel_r20']-base_metrics['novel_r20']:+.4f})  "
            f"repeatR@20 {metrics['repeat_r20']:.4f} "
            f"({metrics['repeat_r20']-base_metrics['repeat_r20']:+.4f})  "
            f"[{time.time()-t0:.0f}s]",
            flush=True,
        )
        rows.append(
            {
                "name": name,
                "families": list(families),
                "importances": ranker.feature_importances or {},
                **metrics,
                "d_map": metrics["map"] - base_metrics["map"],
                "d_novel_r20": metrics["novel_r20"] - base_metrics["novel_r20"],
                "d_repeat_r20": metrics["repeat_r20"] - base_metrics["repeat_r20"],
            }
        )
    return rows


def ablation_markdown(rows: list[dict], seed: int) -> str:
    """Render the ablation rows as a markdown table (deltas vs base)."""
    lines = [
        f"### Ablation (seed {seed}) — Δ vs P5 base",
        "",
        "| subset | MAP | ΔMAP | novel R@20 | Δnovel | repeat R@20 | Δrepeat |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['name']} | {r['map']:.4f} | {r['d_map']:+.4f} | "
            f"{r['novel_r20']:.4f} | {r['d_novel_r20']:+.4f} | "
            f"{r['repeat_r20']:.4f} | {r['d_repeat_r20']:+.4f} |"
        )
    lines.append("")
    return "\n".join(lines)
