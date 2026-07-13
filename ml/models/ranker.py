"""LightGBM lambdarank ranker (plan build order step 5).

Trained on history + popularity features only (the P5 families; market /
committee / PAC come in P6). Must beat persistence on macro-MAP AND novel-ticker
recall to earn its keep — winning only on pooled metrics would mean it merely
memorized the hyperactive traders (plan §6 step 5 gate).

Point-in-time discipline, restated for the ranker specifically:
  - Features come exclusively from ``features.build.FeatureBuilder``, which reads
    only the as-of frame. No DB, no cached ``trade_features`` table.
  - Labels for TRAINING use ``dataset.label_tickers`` (post-hoc knowledge is
    legitimate for the target). Training folds must be MATURE, else their labels
    are incomplete (§2.3).
  - Walk-forward: the harness only ever calls ``score`` on folds strictly after
    the training folds. ``fit`` never sees an evaluation fold.

Implements the ``Scorer`` protocol so the existing walk-forward harness scores
it with no change: ``prepare(as_of_frame, as_of)`` builds the fold's
FeatureBuilder, ``score`` predicts per candidate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

import numpy as np
import pandas as pd

from .. import config, dataset
from ..features.build import (
    MONOTONE_SIGNS,
    AuxData,
    FeatureBuilder,
    feature_cols,
)
from .base import BaseScorer

logger = logging.getLogger("ml.ranker")

from ..candidates import make_candidate_generator


@dataclass
class RankerParams:
    """LightGBM lambdarank hyperparameters. Modest defaults for a small, noisy
    dataset — deep trees would overfit the hyperactive traders."""

    n_estimators: int = 300
    learning_rate: float = 0.05
    num_leaves: int = 31
    min_child_samples: int = 50
    subsample: float = 0.8
    colsample_bytree: float = 0.8
    reg_lambda: float = 1.0
    random_state: int = config.RANDOM_SEED
    extra: dict = field(default_factory=dict)


class LGBMRankerScorer(BaseScorer):
    """A fitted LightGBM ranker exposed as a ``Scorer``.

    Lifecycle:
        r = LGBMRankerScorer()
        r.fit(frame, train_folds, candidate_factory)   # once, on past folds
        # then the harness drives it per evaluation fold:
        r.prepare(as_of_frame, as_of); r.score(member, as_of, candidates)
    """

    name = "lgbm_ranker"

    def __init__(
        self,
        params: RankerParams | None = None,
        *,
        families=("base",),
        aux: AuxData | None = None,
    ):
        self.params = params or RankerParams()
        self.families = tuple(families)
        self.aux = aux or AuxData()
        self._model = None
        self._builder: FeatureBuilder | None = None
        self._cols: tuple[str, ...] = feature_cols(self.families)

    def _make_builder(self, as_of_frame: pd.DataFrame, as_of: date) -> FeatureBuilder:
        return FeatureBuilder(as_of_frame, as_of, aux=self.aux, families=self.families)


    def fit(
        self,
        frame: pd.DataFrame,
        train_folds: list[date],
        *,
        candidate_factory=make_candidate_generator,
        horizon_days: int = config.HORIZON_DAYS,
    ) -> "LGBMRankerScorer":
        """Train on the given ``train_folds`` (each a query-group source).

        For every (member, as_of) with at least one labeled ticker we form a
        query group: rows = the member's candidate set, label = 1 if the ticker
        is in the horizon label window else 0. LightGBM lambdarank consumes the
        row-groups via ``group`` sizes.
        """
        import lightgbm as lgb

        cols = self._cols
        X_parts: list[pd.DataFrame] = []
        y_parts: list[np.ndarray] = []
        groups: list[int] = []

        for as_of in train_folds:
            as_of_frame = dataset.trades_as_of(frame, as_of)
            if as_of_frame.empty:
                continue
            builder = self._make_builder(as_of_frame, as_of)
            generate = candidate_factory(as_of_frame, as_of)
            for member_id in _members_with_labels(frame, as_of, horizon_days):
                candidates = generate(as_of_frame, member_id, as_of)
                if not candidates:
                    continue
                relevant = dataset.label_tickers(
                    frame, member_id, as_of, horizon_days=horizon_days
                )
                y = np.array(
                    [1 if t in relevant else 0 for t in candidates], dtype=int
                )
                if y.sum() == 0:
                    continue
                feats = builder.features_for(member_id, candidates)
                X_parts.append(feats)
                y_parts.append(y)
                groups.append(len(candidates))

        if not X_parts:
            raise RuntimeError(
                "No training groups produced — check train_folds maturity and "
                "that the snapshot has labeled trades in those windows."
            )

        X = pd.concat(X_parts, ignore_index=True)[list(cols)]
        y = np.concatenate(y_parts)
        p = self.params
        self._model = lgb.LGBMRanker(
            objective="lambdarank",
            n_estimators=p.n_estimators,
            learning_rate=p.learning_rate,
            num_leaves=p.num_leaves,
            min_child_samples=p.min_child_samples,
            subsample=p.subsample,
            colsample_bytree=p.colsample_bytree,
            reg_lambda=p.reg_lambda,
            random_state=p.random_state,
            n_jobs=-1,
            label_gain=[0, 1],  
            monotone_constraints=_monotone_constraints(cols),
            verbose=-1,
            **p.extra,
        )
        self._model.fit(X, y, group=groups)
        logger.info(
            "Trained lgbm_ranker (families=%s) on %d groups (%d rows, %d positives)",
            ",".join(self.families), len(groups), len(y), int(y.sum()),
        )
        return self
    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._builder = self._make_builder(as_of_frame, as_of)

    def score(self, member_id, as_of, candidates):
        if self._model is None:
            raise RuntimeError("LGBMRankerScorer.score called before fit().")
        if self._builder is None:
            raise RuntimeError("LGBMRankerScorer.score called before prepare().")
        if not candidates:
            return []
        X = self._builder.features_for(member_id, candidates)[list(self._cols)]
        preds = self._model.predict(X)
        return [float(v) for v in preds]

    @property
    def feature_importances(self) -> dict[str, float] | None:
        """Gain-importance per feature, or None if unfitted. For the run report /
        error analysis (which families actually carry the model)."""
        if self._model is None:
            return None
        imps = self._model.booster_.feature_importance(importance_type="gain")
        return dict(zip(self._cols, (float(v) for v in imps)))


def _monotone_constraints(cols: tuple[str, ...]) -> list[int]:
    """Per-feature monotonicity for LightGBM, aligned to the fitted ``cols``.

    Constrain the signals whose direction we know, so the tree can only USE them
    the right way and never fit non-monotone noise that pushes a novel hit out of
    the top-k (which cost the novel-recall gate before). Everything else is left
    unconstrained (0). The signs live in ``features.build.MONOTONE_SIGNS`` so the
    feature layout and its constraints stay in one place across families.
    """
    return [MONOTONE_SIGNS.get(col, 0) for col in cols]


def _members_with_labels(
    frame: pd.DataFrame, as_of: date, horizon_days: int
) -> list[str]:
    """Members with ≥1 trade transacted in (as_of, as_of + H] — the only
    members that yield a usable training group. Single groupby, mirrors
    ``harness._fold_labels`` windowing."""
    lo = dataset._as_timestamp(as_of)
    hi = lo + pd.Timedelta(days=horizon_days)
    tx = frame["transaction_date"]
    in_window = frame[
        (tx > lo) & (tx <= hi) & frame["ticker"].notna()
        & frame["bioguide_id"].notna()
    ]
    return in_window["bioguide_id"].unique().tolist()
