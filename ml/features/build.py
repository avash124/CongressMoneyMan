"""Feature assembler: as-of frame + (member, candidates) -> feature matrix.

One row per candidate ticker. The P5 base is history ∪ holdings ∪ popularity ∪
cross features; P6 adds four optional families (market, member, committee, pac)
behind an ablation switch. Pure — no DB, no ``trade_features`` table, no label
window. Inputs are the as-of frame (``dataset.trades_as_of`` output), the
candidate list, and optional AUX FRAMES (prices/profiles/members/committees/pac)
handed in via ``AuxData``; that is what makes the leakage scan a sufficient
defense (§2.2). No aux -> P5 behavior exactly (the no-aux default), so the
existing tests keep passing unchanged.

Built as a per-fold factory (``FeatureBuilder(as_of_frame, as_of, aux, families)``)
so the fold-invariant work — grouping trades by member, popularity counts,
per-ticker momentum, committee jurisdiction — happens once, then
``features_for(member_id, candidates)`` is a fast per-member slice. Both the
ranker's ``fit`` and its ``score`` go through this same builder, so train and
serve see identical features.

Ablation: the column LAYOUT is a function of the enabled families
(``feature_cols(families)``), not a module constant, so the ranker can fit and
score any family subset on identical folds and the run report can diff them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from . import committee, history, holdings, market, member, popularity
from . import pac as pac_family

CROSS_COLS = (
    "pop_global_novel",   
    "pop_peer_novel",     
    "cand_recip_rank",    
)

BASE_COLS: tuple[str, ...] = (
    *history.MEMBER_COLS,
    *history.PAIR_COLS,
    *holdings.PAIR_COLS,
    *popularity.PAIR_COLS,
    *CROSS_COLS,
)

FAMILY_COLS: dict[str, tuple[str, ...]] = {
    "market": market.PAIR_COLS,
    "member": member.MEMBER_COLS + member.PAIR_COLS,
    "committee": committee.PAIR_COLS,
    "pac": pac_family.PAIR_COLS,
}

P6_FAMILIES: tuple[str, ...] = ("market", "member", "committee", "pac")
ALL_FAMILIES: tuple[str, ...] = ("base", *P6_FAMILIES)
DEFAULT_FAMILIES: tuple[str, ...] = ("base", "market")
FEATURE_COLS: tuple[str, ...] = BASE_COLS
MONOTONE_SIGNS: dict[str, int] = {
    "pop_global_novel": 1,
    "pop_peer_novel": 1,
    "cand_recip_rank": 1,
    "mkt_sector_match": 1,
    "mkt_sector_affinity": 1,
    "mem_hq_state_match": 1,
    "com_jurisdiction_match": 1,
    "pac_company_linked": 1,
    "pac_sector_affinity": 1,
}


@dataclass
class AuxData:
    """Auxiliary frames for the P6 families. Every field optional: None ->
    that family is disabled / contributes zeros, so the no-aux default is exactly
    P5 behavior (P6 handoff §3). Frames come from ``dataset.*_frame`` and are
    pinned snapshots — feature builders receive them, never fetch."""

    prices: pd.DataFrame | None = None
    profiles: pd.DataFrame | None = None
    members: pd.DataFrame | None = None
    committees: pd.DataFrame | None = None
    pac: pd.DataFrame | None = None


def feature_cols(families=ALL_FAMILIES) -> tuple[str, ...]:
    """Ordered feature layout for the enabled ``families``. 'base' is always
    included (P5 layout); each P6 family appends its block in build-order. This
    is what the ranker pins at fit time and the ablation mode varies."""
    cols: list[str] = list(BASE_COLS)
    for fam in P6_FAMILIES:
        if fam in families:
            cols.extend(FAMILY_COLS[fam])
    return tuple(cols)


class FeatureBuilder:
    """Fold-level feature factory. Precompute once per as-of frame, reuse for
    every member in the fold. ``families`` selects which P6 blocks to assemble;
    ``aux`` supplies their frames (a family enabled without its aux frame just
    yields zeros, so ablation and missing-data degrade the same safe way)."""

    def __init__(
        self,
        as_of_frame: pd.DataFrame,
        as_of: date,
        aux: AuxData | None = None,
        families=("base",),
    ):
        self._as_of = as_of
        self._families = tuple(families)
        self._cols = feature_cols(self._families)
        aux = aux or AuxData()
        clean = as_of_frame.dropna(subset=["ticker"])
        self._by_member: dict[str, pd.DataFrame] = {
            m: g for m, g in clean.groupby("bioguide_id")
        }
        self._popularity = popularity.PopularityFeatures(as_of_frame, as_of)
        self._market = (
            market.MarketFeatures(as_of_frame, as_of, aux.prices, aux.profiles)
            if "market" in self._families else None
        )
        self._member = (
            member.MemberFeatures(aux.members, aux.profiles)
            if "member" in self._families else None
        )
        self._committee = (
            committee.CommitteeFeatures(aux.committees, aux.profiles)
            if "committee" in self._families else None
        )
        self._pac = (
            pac_family.PacFeatures(aux.pac, aux.profiles, as_of)
            if "pac" in self._families else None
        )

    @property
    def feature_columns(self) -> tuple[str, ...]:
        return self._cols

    def features_for(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        """Feature matrix for one member over ``candidates`` (rows aligned to
        ``candidates`` order, columns == ``feature_cols(families)``)."""
        member_rows = self._by_member.get(member_id)
        if member_rows is None:
            member_rows = _EMPTY_MEMBER_ROWS

        mem = history.member_features(member_rows, self._as_of)
        pair = history.pair_features(member_rows, self._as_of, candidates)
        hold = holdings.pair_features(member_rows, self._as_of, candidates)
        pop = self._popularity.pair_features(member_id, candidates)
        out = pd.DataFrame(index=pd.Index(candidates, name="ticker"))
        for col in history.MEMBER_COLS:
            out[col] = mem[col]
        for frag in (pair, hold, pop):
            for col in frag.columns:
                out[col] = frag[col].to_numpy()
        is_novel = 1.0 - out["mt_is_repeat"].to_numpy()
        out["pop_global_novel"] = out["pop_global_count"].to_numpy() * is_novel
        out["pop_peer_novel"] = out["pop_peer_count"].to_numpy() * is_novel
        ranks = np.arange(len(candidates), dtype=float)
        out["cand_recip_rank"] = 1.0 / (ranks + 1.0)
        if self._market is not None:
            _attach(out, self._market.pair_features(member_id, candidates))
        if self._member is not None:
            _attach(out, self._member.features_for(member_id, candidates))
        if self._committee is not None:
            _attach(out, self._committee.pair_features(member_id, candidates))
        if self._pac is not None:
            _attach(out, self._pac.pair_features(member_id, candidates))

        return out[list(self._cols)]


def _attach(out: pd.DataFrame, frag: pd.DataFrame) -> None:
    """Copy a family fragment's columns onto the assembled matrix by position
    (fragments are indexed by candidates order, same as ``out``)."""
    for col in frag.columns:
        out[col] = frag[col].to_numpy()

_EMPTY_MEMBER_ROWS = pd.DataFrame(
    {
        "ticker": pd.Series(dtype="string"),
        "transaction_type": pd.Series(dtype="string"),
        "transaction_date": pd.Series(dtype="datetime64[ns, UTC]"),
    }
)
