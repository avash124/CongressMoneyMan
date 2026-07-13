"""PAC / donor-affinity features (plan §2.4 / §2.5 #7 — P6 family 4).

``pac_donations(bioguide_id, pac_name, amount, cycle)`` has NO event dates —
cycle granularity only — and is a live snapshot (like portfolio_holdings). Strict
point-in-time is therefore impossible for this family; the honest choice made
here (P6 handoff §2 #4) is CYCLE-LEVEL GATING: at ``as_of``, a member's usable
donations are those from cycles STRICTLY BEFORE the as_of cycle. A 2026-fold
sees 2024-and-earlier money, never 2026 money — so a donation that arrived after
the as_of cannot leak, at cycle resolution.

Two features, kept deliberately simple (handoff: "fuzzy — keep it simple first"):
  - ``pac_company_linked``: the candidate's company appears among the member's
    donor PAC names (company-name/ticker fuzzy match). "This company's PAC gave
    to this member" is a direct member↔ticker link.
  - ``pac_sector_affinity``: the member's donor money, mapped to sectors via the
    company links, concentrated in the candidate's sector (graded 0..1).

Inputs handed in (no DB import — leakage scan applies): the pac frame
(``dataset.pac_frame``) and the profiles frame (``dataset.profiles_frame``, for
company_name -> ticker -> sector). Both may be None -> features are 0.
"""

from __future__ import annotations

import re
from datetime import date

import pandas as pd

from . import sectors

PAIR_COLS = (
    "pac_company_linked",   
    "pac_sector_affinity",  
)

_STOP_TOKENS = {
    "inc", "incorporated", "corp", "corporation", "co", "company", "plc",
    "ltd", "llc", "lp", "holdings", "group", "the", "and", "of",
    "political", "action", "committee", "pac", "employees", "employee",
    "fund", "for", "good", "government", "federal", "citizens", "citizen",
}


def cycle_for(as_of: date) -> int:
    """The 2-year FEC cycle an ``as_of`` date falls in (even-year end): 2025 and
    2026 both -> 2026. Donations gate on cycles strictly < this value."""
    y = pd.Timestamp(as_of).year
    return y if y % 2 == 0 else y + 1


def _tokens(name: str) -> set[str]:
    """Content tokens of a name (lower, alnum), minus corporate/PAC filler."""
    raw = re.findall(r"[a-z0-9]+", str(name).lower())
    return {t for t in raw if t and t not in _STOP_TOKENS and len(t) > 1}


class PacFeatures:
    """Fold-level PAC affinity. The member -> {linked tickers} and member ->
    {sector -> money-share} maps are fold-invariant given the as_of cycle, so
    build them once (cycle-gated) and serve per (member, candidates)."""

    def __init__(
        self,
        pac: pd.DataFrame | None,
        profiles: pd.DataFrame | None,
        as_of: date,
    ):
        self._sector_of = sectors.build_sector_lookup(profiles)
        self._company_tokens = self._company_token_index(profiles)
        cutoff_cycle = cycle_for(as_of)
        self._member_links, self._member_sector_share = self._build(
            pac, cutoff_cycle
        )

    def _company_token_index(
        self, profiles: pd.DataFrame | None
    ) -> dict[str, set[str]]:
        """{ticker -> content tokens of its company name}. Used to match a PAC
        name against a company. Falls back to the ticker symbol itself when no
        profile name is present, so tests without profiles still link."""
        out: dict[str, set[str]] = {}
        if profiles is None or profiles.empty:
            return out
        for ticker, name in zip(profiles["ticker"], profiles["company_name"]):
            t = str(ticker).strip().upper()
            toks = _tokens(name) if isinstance(name, str) and name else set()
            if not toks:
                toks = {t.lower()}
            out[t] = toks
        return out

    def _match_ticker(self, pac_name: str) -> str | None:
        """Return the ticker whose company tokens are all present in this PAC
        name (simple containment — the 'keep it simple' fuzzy match). First
        matching ticker wins; None if nothing matches."""
        pac_toks = _tokens(pac_name)
        if not pac_toks:
            return None
        for ticker, company_toks in self._company_tokens.items():
            if company_toks and company_toks <= pac_toks:
                return ticker
        return None

    def _build(
        self, pac: pd.DataFrame | None, cutoff_cycle: int
    ) -> tuple[dict[str, set[str]], dict[str, dict[str, float]]]:
        links: dict[str, set[str]] = {}
        sector_money: dict[str, dict[str, float]] = {}
        if pac is None or pac.empty:
            return links, sector_money
        gated = pac[pac["cycle"].notna() & (pac["cycle"] < cutoff_cycle)]
        for bid, grp in gated.groupby("bioguide_id"):
            member = str(bid)
            member_links: set[str] = set()
            by_sector: dict[str, float] = {}
            total = 0.0
            for pac_name, amount in zip(grp["pac_name"], grp["amount"]):
                amt = float(amount) if pd.notna(amount) else 0.0
                total += amt
                ticker = self._match_ticker(pac_name)
                if ticker is None:
                    continue
                member_links.add(ticker)
                sec = self._sector_of.get(ticker)
                if sec:
                    by_sector[sec] = by_sector.get(sec, 0.0) + amt
            if member_links:
                links[member] = member_links
            if total > 0 and by_sector:
                sector_money[member] = {
                    s: m / total for s, m in by_sector.items()
                }
        return links, sector_money

    def pair_features(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        idx = pd.Index(candidates, name="ticker")
        links = self._member_links.get(str(member_id), set())
        share = self._member_sector_share.get(str(member_id), {})

        linked = [
            1.0 if str(c).strip().upper() in links else 0.0 for c in candidates
        ]
        affinity = [
            share.get(self._sector_of.get(str(c).strip().upper()), 0.0)
            for c in candidates
        ]
        out = pd.DataFrame(index=idx)
        out["pac_company_linked"] = linked
        out["pac_sector_affinity"] = affinity
        return out[list(PAIR_COLS)]
