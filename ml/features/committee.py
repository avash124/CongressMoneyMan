"""Committee jurisdiction features (plan §2.5 #6 — P6 family 3, the marquee one).

Thesis: a member on a committee whose jurisdiction covers a sector has an
information edge on that sector's companies. So the feature is:

    candidate's sector ∈ (union of sectors in the member's committees' jurisdiction)

Two inputs, both handed in (no DB import — leakage scan applies):
  - the committee-assignments frame (``dataset.committees_frame``:
    bioguide_id, committee) — fetched from congress.gov and pinned;
  - a hand-written static committee -> {sectors} dict below (~30 committees).

DOCUMENTED APPROXIMATION (P6 handoff §2 #3): congress.gov exposes only CURRENT
committee assignments, applied here to historical folds. That is mild future
information (a member's 2026 committee seat used to score a 2024 fold). The plan
accepts this rather than dropping the family — it is stated in the run report,
not hidden. Committee turnover is low term-to-term, so the approximation is
mild; if the ablation shows committee lift, the verify report flags it as
approximate-not-strict-PIT.
"""

from __future__ import annotations

import pandas as pd

from . import sectors
_COMMITTEE_SECTORS: dict[str, set[str]] = {
    "financial services": {"Financials", "Real Estate"},
    "banking housing and urban affairs": {"Financials", "Real Estate"},
    "energy and commerce": {
        "Energy", "Utilities", "Health Care", "Communication Services",
        "Technology", "Consumer Discretionary",
    },
    "energy and natural resources": {"Energy", "Utilities", "Materials"},
    "armed services": {"Industrials"},
    "homeland security": {"Industrials", "Technology"},
    "health education labor and pensions": {"Health Care"},
    "agriculture": {"Consumer Staples", "Materials"},
    "agriculture nutrition and forestry": {"Consumer Staples", "Materials"},
    "commerce science and transportation": {
        "Industrials", "Communication Services", "Technology",
        "Consumer Discretionary",
    },
    "transportation and infrastructure": {"Industrials", "Materials"},
    "science space and technology": {"Technology", "Industrials"},
    "natural resources": {"Energy", "Materials", "Utilities"},
    "ways and means": {"Financials", "Health Care"},
    "finance": {"Financials", "Health Care"},
    "small business": {"Consumer Discretionary", "Consumer Staples"},
    "small business and entrepreneurship": {
        "Consumer Discretionary", "Consumer Staples",
    },
    "veterans affairs": {"Health Care"},
    "foreign affairs": {"Industrials"},
    "foreign relations": {"Industrials"},
    "judiciary": {"Technology", "Communication Services"},
    "intelligence": {"Technology", "Industrials"},
    "appropriations": set(),
    "budget": set(),
    "oversight and accountability": set(),
    "rules": set(),
    "ethics": set(),
    "administration": set(),
}

PAIR_COLS = (
    "com_jurisdiction_match",
)


def _normalize_committee(name: str) -> str:
    """Lower-case, strip a leading chamber word and punctuation, so 'House
    Committee on Financial Services' and 'Financial Services' both key the
    dict. Deliberately simple string hygiene, not a parser."""
    s = str(name).strip().lower()
    for prefix in ("house ", "senate ", "joint "):
        if s.startswith(prefix):
            s = s[len(prefix):]
    for token in ("committee on ", "committee ", "select ", "permanent "):
        s = s.replace(token, "")
    s = s.replace(",", " ").replace("&", "and").replace("  ", " ")
    return s.strip()


class CommitteeFeatures:
    """Fold-level committee jurisdiction. The member -> jurisdiction-sectors map
    is fold-invariant (current assignments, §-approximation above), so build it
    once and serve per (member, candidates)."""

    def __init__(
        self,
        committees: pd.DataFrame | None,
        profiles: pd.DataFrame | None,
    ):
        self._sector_of = sectors.build_sector_lookup(profiles)
        self._member_sectors = self._member_jurisdiction(committees)

    def _member_jurisdiction(
        self, committees: pd.DataFrame | None
    ) -> dict[str, set[str]]:
        """{member -> union of sectors across their committees' jurisdictions}."""
        out: dict[str, set[str]] = {}
        if committees is None or committees.empty:
            return out
        for bid, com in zip(committees["bioguide_id"], committees["committee"]):
            if not isinstance(bid, str) or not isinstance(com, str):
                continue
            secs = _COMMITTEE_SECTORS.get(_normalize_committee(com))
            if secs:
                out.setdefault(bid, set()).update(secs)
        return out

    def pair_features(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        idx = pd.Index(candidates, name="ticker")
        member_secs = self._member_sectors.get(str(member_id), set())
        if member_secs:
            match = [
                1.0
                if self._sector_of.get(str(c).strip().upper()) in member_secs
                else 0.0
                for c in candidates
            ]
        else:
            match = [0.0] * len(candidates)
        out = pd.DataFrame(index=idx)
        out["com_jurisdiction_match"] = match
        return out[list(PAIR_COLS)]
