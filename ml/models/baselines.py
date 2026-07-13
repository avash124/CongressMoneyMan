"""The four baselines (plan §1, build order step 3).

All four score purely from the as-of frame handed in by the harness — no DB, no
future knowledge. "Baselines before models" is the plan's core discipline: the
ranker must beat these on macro-MAP AND novel-ticker recall to earn its keep.

  - PersistenceScorer: a member's own recent history of a ticker. Expected to be
    the strong one — members re-trade the same names.
  - HoldingsScorer: tickers the member appears to still hold (net-bought,
    derived from as-of trades — leak-safe, no external holdings feed needed).
  - PopularityScorer: peer herding — trailing trade counts among the member's
    party+chamber peers.
  - BaseRateScorer: global ticker popularity in a trailing window (member-
    agnostic floor).

Recency uses an exponential decay so "traded last week" outranks "traded a year
ago" without a hard cutoff.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from .base import BaseScorer

_BUY_TYPES = {"purchase", "buy"}
_SELL_TYPES = {"sale", "sell", "sale (full)", "sale (partial)"}
_TRAILING_DAYS = 180
_HALFLIFE_DAYS = 90.0


def _as_ts(as_of: date) -> pd.Timestamp:
    ts = pd.Timestamp(as_of)
    return ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")


def _txn_kind(series: pd.Series) -> pd.Series:
    return series.astype("string").str.strip().str.lower()


class PersistenceScorer(BaseScorer):
    """Score a candidate by the member's own decayed trade frequency on it.

    A member who traded NVDA three times in the last month scores it high; a
    ticker they've never touched scores 0. This is the baseline to beat."""

    name = "persistence"

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._as_of = _as_ts(as_of)
        self._frame = as_of_frame

    def score(self, member_id, as_of, candidates):
        mine = self._frame[self._frame["bioguide_id"] == member_id]
        if mine.empty:
            return [0.0] * len(candidates)
        age_days = (self._as_of - mine["transaction_date"]).dt.total_seconds() / 86400.0
        weight = np.exp(-age_days.clip(lower=0) / _HALFLIFE_DAYS)
        by_ticker = (
            pd.Series(weight.to_numpy(), index=mine["ticker"].to_numpy())
            .groupby(level=0)
            .sum()
        )
        return [float(by_ticker.get(t, 0.0)) for t in candidates]


class HoldingsScorer(BaseScorer):
    """Score by apparent current holding: net buys minus sells per ticker,
    derived from the member's as-of trades. Positive net -> likely still held ->
    more likely to be traded again."""

    name = "holdings"

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._frame = as_of_frame

    def score(self, member_id, as_of, candidates):
        mine = self._frame[self._frame["bioguide_id"] == member_id]
        if mine.empty:
            return [0.0] * len(candidates)
        kind = _txn_kind(mine["transaction_type"])
        signed = np.where(kind.isin(_BUY_TYPES), 1.0,
                          np.where(kind.isin(_SELL_TYPES), -1.0, 0.0))
        net = (
            pd.Series(signed, index=mine["ticker"].to_numpy())
            .groupby(level=0)
            .sum()
            .clip(lower=0.0)  
        )
        return [float(net.get(t, 0.0)) for t in candidates]


class PopularityScorer(BaseScorer):
    """Peer herding: trailing-window trade counts among the member's party +
    chamber peers. Captures "everyone in the GOP House caucus is buying X"."""

    name = "popularity"

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._as_of = _as_ts(as_of)
        cutoff = self._as_of - pd.Timedelta(days=_TRAILING_DAYS)
        frame = as_of_frame
        for col in ("party", "chamber"):
            if col not in frame.columns:
                frame = frame.assign(**{col: pd.NA})
        frame = frame.copy()
        frame["party"] = frame["party"].fillna("?")
        frame["chamber"] = frame["chamber"].fillna("?")
        self._recent = frame[frame["transaction_date"] > cutoff]
        self._peer_key = (
            frame.dropna(subset=["bioguide_id"])
            .groupby("bioguide_id")[["party", "chamber"]]
            .first()
        )

    def _counts_for(self, party, chamber) -> pd.Series:
        peers = self._recent[
            (self._recent["party"] == party) & (self._recent["chamber"] == chamber)
        ]
        return peers.groupby("ticker").size()

    def score(self, member_id, as_of, candidates):
        if member_id not in self._peer_key.index:
            return [0.0] * len(candidates)
        party, chamber = self._peer_key.loc[member_id, ["party", "chamber"]]
        counts = self._counts_for(party, chamber)
        return [float(counts.get(t, 0.0)) for t in candidates]


class BaseRateScorer(BaseScorer):
    """Member-agnostic floor: global trailing-window trade counts per ticker.
    The 'most-popular-tickers' prior — every member gets the same ranking."""

    name = "base_rate"

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        cutoff = _as_ts(as_of) - pd.Timedelta(days=_TRAILING_DAYS)
        recent = as_of_frame[as_of_frame["transaction_date"] > cutoff]
        self._counts = recent.groupby("ticker").size()

    def score(self, member_id, as_of, candidates):
        return [float(self._counts.get(t, 0.0)) for t in candidates]


def all_baselines() -> list[BaseScorer]:
    """The standard four, in the order the scorecard reports them."""
    return [
        PersistenceScorer(),
        HoldingsScorer(),
        PopularityScorer(),
        BaseRateScorer(),
    ]
