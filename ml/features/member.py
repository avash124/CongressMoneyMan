"""Member attributes + geography features (plan §2.5 #5 — P6 family 2).

Party / chamber from the members roster (member-level, broadcast across the
member's candidates) plus the one feature that actually discriminates between
candidates: member-state ↔ company-HQ-state match (a local-company bias).

Reads the ``members`` roster (``dataset.members_frame``) and company profiles
(``dataset.profiles_frame``) — both handed in, never fetched (leakage scan
applies). Party is already normalized to D/R/I in ``members_frame``; peer
grouping elsewhere still uses the RAW trades party, unchanged (P6 handoff §2 #2).

A member absent from the roster (or a roster that is None) flows through as all
zeros — a valid cold row, same convention as the P5 builders.
"""

from __future__ import annotations

import pandas as pd
MEMBER_COLS = (
    "mem_is_house",
    "mem_is_senate",
    "mem_party_d",
    "mem_party_r",
)

PAIR_COLS = (
    "mem_hq_state_match",  
)


class MemberFeatures:
    """Fold-level member/geography features. The roster and HQ-state lookup are
    fold-invariant, so build them once and serve per (member, candidates)."""

    def __init__(
        self,
        members: pd.DataFrame | None,
        profiles: pd.DataFrame | None,
    ):
        self._attrs = self._member_attrs(members)
        self._member_state = self._member_state_lookup(members)
        self._hq_state = self._hq_state_lookup(profiles)

    def _member_attrs(
        self, members: pd.DataFrame | None
    ) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        if members is None or members.empty:
            return out
        for _, row in members.iterrows():
            bid = row.get("bioguide_id")
            if not isinstance(bid, str) or not bid:
                continue
            chamber = (row.get("chamber") or "")
            party = (row.get("party") or "")
            out[bid] = {
                "mem_is_house": 1.0 if chamber == "house" else 0.0,
                "mem_is_senate": 1.0 if chamber == "senate" else 0.0,
                "mem_party_d": 1.0 if party == "D" else 0.0,
                "mem_party_r": 1.0 if party == "R" else 0.0,
            }
        return out

    def _member_state_lookup(
        self, members: pd.DataFrame | None
    ) -> dict[str, str]:
        if members is None or members.empty:
            return {}
        out: dict[str, str] = {}
        for bid, state in zip(members["bioguide_id"], members["state"]):
            if isinstance(bid, str) and isinstance(state, str) and state:
                out[bid] = state
        return out

    def _hq_state_lookup(self, profiles: pd.DataFrame | None) -> dict[str, str]:
        if profiles is None or profiles.empty:
            return {}
        out: dict[str, str] = {}
        for ticker, hq in zip(profiles["ticker"], profiles["hq_state"]):
            if isinstance(hq, str) and hq:
                out[str(ticker).strip().upper()] = hq
        return out

    def features_for(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        idx = pd.Index(candidates, name="ticker")
        attrs = self._attrs.get(
            str(member_id),
            {c: 0.0 for c in MEMBER_COLS},
        )
        member_state = self._member_state.get(str(member_id))

        out = pd.DataFrame(index=idx)
        for col in MEMBER_COLS:
            out[col] = attrs[col]
        if member_state:
            out["mem_hq_state_match"] = [
                1.0 if self._hq_state.get(str(c).strip().upper()) == member_state
                else 0.0
                for c in candidates
            ]
        else:
            out["mem_hq_state_match"] = 0.0
        return out[list(MEMBER_COLS) + list(PAIR_COLS)]
