"""Direction (buy/sell) head — plan §2.6, P7.

A second LightGBM, binary buy/sell, trained ONLY on positive events (the labeled
``(member, ticker, as_of)`` rows the ranker already forms) on the SAME features
(``FeatureBuilder`` with the production families). It attaches a P(buy) to each
ranked ticker at serve time. Cheap; the plan says keep it — *if* it beats the
per-member modal-direction baseline (``ModalDirectionBaseline`` below).

Point-in-time discipline is identical to the ranker:
  - Features come exclusively from ``features.build.FeatureBuilder``, which reads
    only the as-of frame (``dataset.trades_as_of`` output). No DB, no cached
    ``trade_features`` table.
  - The LABEL reads the ``transaction_type`` of the labeled HORIZON trade — the
    trade transacted in ``(as_of, as_of + H]``. Using the target's own direction
    is legitimate post-hoc knowledge, exactly like ``dataset.label_tickers``
    reads a future ``transaction_date`` (§2.6, P7 handoff §2.1). Training folds
    must be MATURE, else their horizon trades are not fully disclosed (§2.3).

This is a MODEL: it must pass ``tests/test_leakage.py`` (no DB/HTTP imports; the
as-of frame is handed in). Only the batch scorer (a SCRIPT) touches the DB.

It deliberately does NOT implement the full ``Scorer`` protocol — it exposes
``prepare(as_of_frame, as_of)`` + ``predict_direction(member, as_of, candidates)
-> list[float]`` (P(buy) per candidate) so the batch scorer can attach a
direction to each ranked ticker.

The SIZE head is deferred (plan §2.6): the bottom disclosure bracket dominates
so a per-member modal-bracket baseline is likely unbeatable — not built here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date 
import lightgbm as lgb

import numpy as np
import pandas as pd

from .. import config, dataset
from ..features.build import (
    DEFAULT_FAMILIES,
    AuxData,
    FeatureBuilder,
    feature_cols,
)
from ..features.history import _BUY_TYPES, _SELL_TYPES

logger = logging.getLogger("ml.direction")

def horizon_direction_labels(
    frame: pd.DataFrame, as_of: date, horizon_days: int = config.HORIZON_DAYS
) -> dict[str, dict[str, int]]:
    """``{member_id: {ticker: 1|0}}`` for trades transacted in ``(as_of, as_of+H]``.

    ``1`` = buy-dominant, ``0`` = sell-dominant for that ``(member, ticker)``.
    Ties (equal buys/sells, including a ticker whose horizon trades are neither
    buy nor sell → 0/0) are DROPPED — the head only trains on unambiguous
    positives (P7 handoff §2.1: "drop rows whose type is neither").

    Windowing mirrors ``dataset.label_tickers`` (left-open / right-closed); the
    only addition is reading ``transaction_type`` — the target's own direction,
    legitimate post-hoc knowledge, never a feature input.
    """
    lo = dataset._as_timestamp(as_of)
    hi = lo + pd.Timedelta(days=horizon_days)
    tx = frame["transaction_date"]
    win = frame[
        (tx > lo)
        & (tx <= hi)
        & frame["ticker"].notna()
        & frame["bioguide_id"].notna()
    ]
    if win.empty:
        return {}

    kind = win["transaction_type"].astype("string").str.strip().str.lower()
    work = pd.DataFrame(
        {
            "bioguide_id": win["bioguide_id"].to_numpy(),
            "ticker": win["ticker"].to_numpy(),
            "buy": kind.isin(_BUY_TYPES).to_numpy().astype(int),
            "sell": kind.isin(_SELL_TYPES).to_numpy().astype(int),
        }
    )
    agg = work.groupby(["bioguide_id", "ticker"])[["buy", "sell"]].sum()
    out: dict[str, dict[str, int]] = {}
    for (member_id, ticker), row in agg.iterrows():
        buys, sells = int(row["buy"]), int(row["sell"])
        if buys > sells:
            label = 1
        elif sells > buys:
            label = 0
        else:
            continue  
        out.setdefault(member_id, {})[ticker] = label
    return out


@dataclass
class DirectionParams:
    """LightGBM binary-classifier hyperparameters. Same modest, small-data
    defaults as the ranker — the positive-event set is small and noisy."""

    n_estimators: int = 300
    learning_rate: float = 0.05
    num_leaves: int = 31
    min_child_samples: int = 30
    subsample: float = 0.8
    colsample_bytree: float = 0.8
    reg_lambda: float = 1.0
    random_state: int = config.RANDOM_SEED
    extra: dict = field(default_factory=dict)


class DirectionHead:
    """A fitted binary buy/sell LightGBM over the ranker's features.

    Lifecycle mirrors the ranker::

        h = DirectionHead(families=DEFAULT_FAMILIES, aux=aux)
        h.fit(frame, train_folds)                 # once, on past (mature) folds
        h.prepare(as_of_frame, as_of)             # per fold / per serve week
        h.predict_direction(member, as_of, cands) # P(buy) per candidate
    """

    name = "direction_head"

    def __init__(
        self,
        params: DirectionParams | None = None,
        *,
        families=DEFAULT_FAMILIES,
        aux: AuxData | None = None,
    ):
        self.params = params or DirectionParams()
        self.families = tuple(families)
        self.aux = aux or AuxData()
        self._model = None
        self._constant: float | None = None
        self._builder: FeatureBuilder | None = None
        self._cols: tuple[str, ...] = feature_cols(self.families)

    def _make_builder(self, as_of_frame: pd.DataFrame, as_of: date) -> FeatureBuilder:
        return FeatureBuilder(as_of_frame, as_of, aux=self.aux, families=self.families)

    def fit(
        self,
        frame: pd.DataFrame,
        train_folds: list[date],
        *,
        horizon_days: int = config.HORIZON_DAYS,
    ) -> "DirectionHead":
        """Train on the buy/sell direction of every labeled horizon trade in
        ``train_folds``. Rows = one per ``(member, ticker, as_of)`` positive
        event; features from that as_of's frame; label = the trade's direction."""
        cols = self._cols
        X_parts: list[pd.DataFrame] = []
        y_parts: list[int] = []

        for as_of in train_folds:
            as_of_frame = dataset.trades_as_of(frame, as_of)
            if as_of_frame.empty:
                continue
            events = horizon_direction_labels(frame, as_of, horizon_days)
            if not events:
                continue
            builder = self._make_builder(as_of_frame, as_of)
            for member_id, tick_labels in events.items():
                tickers = list(tick_labels)
                feats = builder.features_for(member_id, tickers)
                X_parts.append(feats)
                y_parts.extend(tick_labels[t] for t in tickers)

        if not X_parts:
            raise RuntimeError(
                "No direction training events produced — check train_folds "
                "maturity and that the snapshot has labeled buy/sell trades."
            )

        X = pd.concat(X_parts, ignore_index=True)[list(cols)]
        y = np.array(y_parts, dtype=int)

        if len(np.unique(y)) < 2:
            self._constant = float(y.mean())
            logger.info(
                "DirectionHead: single-class training set (%d rows, all=%d) — "
                "serving constant P(buy)=%.3f", len(y), int(y[0]), self._constant,
            )
            return self

        p = self.params
        self._model = lgb.LGBMClassifier(
            objective="binary",
            n_estimators=p.n_estimators,
            learning_rate=p.learning_rate,
            num_leaves=p.num_leaves,
            min_child_samples=p.min_child_samples,
            subsample=p.subsample,
            colsample_bytree=p.colsample_bytree,
            reg_lambda=p.reg_lambda,
            random_state=p.random_state,
            n_jobs=-1,
            verbose=-1,
            **p.extra,
        )
        self._model.fit(X, y)
        logger.info(
            "Trained direction_head (families=%s) on %d events (%d buys, %d sells)",
            ",".join(self.families), len(y), int(y.sum()), int((1 - y).sum()),
        )
        return self

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._builder = self._make_builder(as_of_frame, as_of)

    def predict_direction(
        self, member_id: str, as_of: date, candidates: list[str]
    ) -> list[float]:
        """P(buy) for each candidate, in ``candidates`` order."""
        if self._model is None and self._constant is None:
            raise RuntimeError("DirectionHead.predict_direction called before fit().")
        if self._builder is None:
            raise RuntimeError("DirectionHead.predict_direction called before prepare().")
        if not candidates:
            return []
        if self._constant is not None:
            return [self._constant] * len(candidates)
        X = self._builder.features_for(member_id, candidates)[list(self._cols)]
        proba = self._model.predict_proba(X)[:, 1]
        return [float(v) for v in proba]

    @property
    def is_fitted(self) -> bool:
        return self._model is not None or self._constant is not None


class ModalDirectionBaseline:
    """Per-member modal-direction baseline (plan §2.6): "this member buys X% of
    the time." X is the member's historical (as-of, leak-free) buy fraction; a
    member with no prior typed trades falls back to the global buy rate learned
    on the training events. This is the bar the head must clear to earn its keep.

    Same ``prepare`` / ``predict_direction`` surface as the head so the eval and
    the batch scorer treat them interchangeably.
    """

    name = "modal_direction"

    def __init__(self, global_rate: float = 0.5):
        self._global = global_rate
        self._rate: dict[str, float] = {}

    def fit(
        self,
        frame: pd.DataFrame,
        train_folds: list[date],
        *,
        horizon_days: int = config.HORIZON_DAYS,
    ) -> "ModalDirectionBaseline":
        """Learn only the global fallback buy rate from the training events (the
        per-member rate is recomputed as-of at ``prepare`` time, so the baseline
        stays point-in-time)."""
        buys = sells = 0
        for as_of in train_folds:
            for tick_labels in horizon_direction_labels(
                frame, as_of, horizon_days
            ).values():
                for label in tick_labels.values():
                    if label == 1:
                        buys += 1
                    else:
                        sells += 1
        total = buys + sells
        self._global = float(buys / total) if total else 0.5
        return self

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        """Per-member historical buy fraction from the as-of frame only."""
        clean = as_of_frame.dropna(subset=["bioguide_id", "transaction_type"])
        if clean.empty:
            self._rate = {}
            return
        kind = clean["transaction_type"].astype("string").str.strip().str.lower()
        work = pd.DataFrame(
            {
                "bioguide_id": clean["bioguide_id"].to_numpy(),
                "buy": kind.isin(_BUY_TYPES).to_numpy().astype(float),
                "sell": kind.isin(_SELL_TYPES).to_numpy().astype(float),
            }
        )
        agg = work.groupby("bioguide_id")[["buy", "sell"]].sum()
        typed = agg["buy"] + agg["sell"]
        self._rate = {
            member: float(agg.loc[member, "buy"] / typed.loc[member])
            for member in agg.index
            if typed.loc[member] > 0
        }

    def predict_direction(
        self, member_id: str, as_of: date, candidates: list[str]
    ) -> list[float]:
        rate = self._rate.get(member_id, self._global)
        return [rate] * len(candidates)
