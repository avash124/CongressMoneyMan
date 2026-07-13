"""Peer/popularity (herding) features (plan §2.5 family #3).

Per-candidate trailing-window trade counts among the member's peers, plus a
global base-rate count. These are the same signals as the Popularity/BaseRate
baselines, exposed as features so the ranker can combine them with history.

Fold-level precomputation (mirrors ``candidates.make_candidate_generator``): the
peer-group and global counts are identical for every member in a fold, so a
``PopularityFeatures`` object computes them once in ``__init__`` and serves fast
per-member lookups. Leak-safe: only the as-of frame is read, windowed to a
trailing period ending at as_of.
"""

from __future__ import annotations
from datetime import date
import pandas as pd

TRAILING_DAYS = 180
RECENT_DAYS = 21

PAIR_COLS = (
    "pop_peer_count",         
    "pop_chamber_count",      
    "pop_global_count",       
    "pop_peer_recent_count",  
    "pop_global_recent_count",
)


def _as_ts(as_of: date) -> pd.Timestamp:
    ts = pd.Timestamp(as_of)
    return ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")


def _peer_count_dict(rows: pd.DataFrame) -> dict[tuple, pd.Series]:
    """{(party, chamber) -> Series(ticker -> count)} for fast per-member lookup
    (a dict.get + reindex instead of MultiIndex slicing at score time)."""
    return {
        key: grp.groupby("ticker").size()
        for key, grp in rows.groupby(["party", "chamber"])
    }


class PopularityFeatures:
    """Fold-level herding counts, precomputed once, served per member.

    Built from the as-of frame; all counts are over trades in
    ``(as_of - TRAILING_DAYS, as_of]``. ``as_of`` is inferred from the frame's
    latest ``filed_at`` if not given (the frame came from ``trades_as_of``).
    """

    def __init__(self, as_of_frame: pd.DataFrame, as_of: date | None = None):
        if as_of is None:
            filed = as_of_frame["filed_at"].dropna()
            as_of = filed.max().date() if not filed.empty else date(1900, 1, 1)
        as_of_ts = _as_ts(as_of)
        cutoff = as_of_ts - pd.Timedelta(days=TRAILING_DAYS)
        recent_cutoff = as_of_ts - pd.Timedelta(days=RECENT_DAYS)

        frame = as_of_frame.dropna(subset=["ticker"]).copy()
        for col in ("party", "chamber"):
            if col not in frame.columns:
                frame[col] = pd.NA
        frame["party"] = frame["party"].fillna("?")
        frame["chamber"] = frame["chamber"].fillna("?")
        recent = frame[frame["transaction_date"] > cutoff]
        fresh = recent[recent["transaction_date"] > recent_cutoff]
        self._peer_counts = _peer_count_dict(recent)
        self._peer_recent_counts = _peer_count_dict(fresh)
        self._chamber_counts: dict[str, pd.Series] = {
            key: grp.groupby("ticker").size()
            for key, grp in recent.groupby("chamber")
        }
        self._global_counts = recent.groupby("ticker").size()
        self._global_recent_counts = fresh.groupby("ticker").size()
        self._peer_key = (
            frame.dropna(subset=["bioguide_id"])
            .groupby("bioguide_id")[["party", "chamber"]]
            .first()
        )

    def pair_features(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        idx = pd.Index(candidates, name="ticker")
        empty = pd.Series(dtype="int64")

        if member_id in self._peer_key.index:
            party, chamber = self._peer_key.loc[member_id, ["party", "chamber"]]
            peer = self._peer_counts.get((party, chamber), empty)
            peer_recent = self._peer_recent_counts.get((party, chamber), empty)
            cham = self._chamber_counts.get(chamber, empty)
        else:
            peer = peer_recent = cham = empty

        out = pd.DataFrame(index=idx)
        out["pop_peer_count"] = peer.reindex(idx).fillna(0.0).astype(float)
        out["pop_chamber_count"] = cham.reindex(idx).fillna(0.0).astype(float)
        out["pop_global_count"] = (
            self._global_counts.reindex(idx).fillna(0.0).astype(float)
        )
        out["pop_peer_recent_count"] = (
            peer_recent.reindex(idx).fillna(0.0).astype(float)
        )
        out["pop_global_recent_count"] = (
            self._global_recent_counts.reindex(idx).fillna(0.0).astype(float)
        )
        return out[list(PAIR_COLS)]
