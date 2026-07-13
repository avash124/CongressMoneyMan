"""Candidate generation (plan build order step 4).

Narrows the ~5,000-ticker universe to ~1,000 per member — the recall ceiling for
everything downstream (a ticker not in the candidate set can never be ranked, so
the ranker's recall is capped by this). The union of four cheap sources:

Budget note (deviation from the plan's "~200 / recall@200 ≥ 0.9"): a ceiling
probe on this data showed 200 candidates cover only ~65% of trades (~24% of
NOVEL trades) — congress trades are too dispersed across the ~5,000-ticker
universe to reach 0.9 in 200 slots. ~1,000 candidates reach ~0.87 overall
(~0.73 novel) and are still a >5x cut from the universe and cheap for a GBDT, so
the gate metric is recall@1000. See runs/*-candidate-recall/report.md.

  1. history      — the member's own traded tickers (their history dominates)
  2. holdings     — tickers the member appears to still hold (net-bought)
  3. peer-popular — trailing-window trade counts among party+chamber peers
  4. top-traded   — globally most-traded tickers (standing proxy for the plan's
                    "top-mktcap"; the market-cap source is wired in P6)

LEAK DISCIPLINE: every source reads only the as-of frame handed in
(``dataset.trades_as_of`` output). None peeks at the label window — that is the
§6.1 adversarial check for this phase. Holdings are derived from as-of trades,
NOT the live ``portfolio_holdings`` snapshot, which has no point-in-time column
and would leak future positions into past folds (fine for production "now"
scoring, not for backtesting).

Built as a factory: ``make_candidate_generator(as_of_frame)`` precomputes the
fold-invariant parts once and returns a fast per-member ``CandidateFn`` — the
same shape the eval harness expects, so recall@k is measured with no harness
change.
"""

from __future__ import annotations

from datetime import date
from typing import Callable

import numpy as np
import pandas as pd

CandidateFn = Callable[[pd.DataFrame, str, date], list[str]]

_BUY_TYPES = {"purchase", "buy"}
_SELL_TYPES = {"sale", "sell", "sale (full)", "sale (partial)"}

_PEER_TRAILING_DAYS = 180


def _as_ts(as_of: date) -> pd.Timestamp:
    ts = pd.Timestamp(as_of)
    return ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")


def _member_history(tickers: pd.DataFrame) -> dict[str, list[str]]:
    """member -> unique traded tickers, most-recent-first (recency = relevance)."""
    ordered = tickers.sort_values("transaction_date", ascending=False)
    return {
        member: list(dict.fromkeys(group))
        for member, group in ordered.groupby("bioguide_id")["ticker"]
    }


def _member_holdings(tickers: pd.DataFrame) -> dict[str, list[str]]:
    """member -> tickers with a positive net (buys - sells) as of now — an
    apparent still-held position. Leak-safe: derived from as-of trades only."""
    kind = tickers["transaction_type"].astype("string").str.strip().str.lower()
    signed = np.where(kind.isin(_BUY_TYPES), 1.0,
                      np.where(kind.isin(_SELL_TYPES), -1.0, 0.0))
    net = tickers.assign(_signed=signed).groupby(["bioguide_id", "ticker"])[
        "_signed"
    ].sum()
    held = net[net > 0].reset_index()
    return {
        member: group.tolist()
        for member, group in held.groupby("bioguide_id")["ticker"]
    }


def _peer_popular(
    tickers: pd.DataFrame, as_of: date, top_n: int
) -> dict[tuple, list[str]]:
    """(party, chamber) -> top-N trailing-window tickers among those peers."""
    cutoff = _as_ts(as_of) - pd.Timedelta(days=_PEER_TRAILING_DAYS)
    recent = tickers[tickers["transaction_date"] > cutoff].copy()
    if recent.empty:
        return {}
    recent["party"] = recent["party"].fillna("?")
    recent["chamber"] = recent["chamber"].fillna("?")
    out: dict[tuple, list[str]] = {}
    for (party, chamber), group in recent.groupby(["party", "chamber"]):
        out[(party, chamber)] = (
            group["ticker"].value_counts().head(top_n).index.tolist()
        )
    return out


def make_candidate_generator(
    as_of_frame: pd.DataFrame,
    as_of: date | None = None,
    *,
    n_peer: int = 200,
    n_top: int = 900,
) -> CandidateFn:
    """Precompute the fold-invariant candidate sources once, return a per-member
    generator. The returned list is ordered by expected relevance (history,
    holdings, then peer/global priors) and deduped — callers can truncate to any
    k and the most-relevant survive.

    ``as_of`` windows the peer-popular source; if omitted it is inferred from the
    frame's latest ``filed_at`` (the frame came from ``trades_as_of``, so nothing
    later than the cutoff is present)."""
    tickers = as_of_frame.dropna(subset=["ticker", "bioguide_id"])
    if as_of is None:
        as_of = _infer_as_of(as_of_frame)

    history = _member_history(tickers)
    holdings = _member_holdings(tickers)
    peer_popular = _peer_popular(tickers, as_of, n_peer)
    top_traded = tickers["ticker"].value_counts().head(n_top).index.tolist()

    peer_key = (
        tickers.groupby("bioguide_id")[["party", "chamber"]].first()
        .fillna("?")
    )

    def generate(_frame: pd.DataFrame, member_id: str, _as_of: date) -> list[str]:
        parts: list[str] = []
        parts.extend(history.get(member_id, []))
        parts.extend(holdings.get(member_id, []))
        if member_id in peer_key.index:
            party, chamber = peer_key.loc[member_id, ["party", "chamber"]]
            parts.extend(peer_popular.get((party, chamber), []))
        parts.extend(top_traded)
        return list(dict.fromkeys(parts))

    return generate


def _infer_as_of(as_of_frame: pd.DataFrame) -> date:
    """The as-of date is the max filed_at in the frame (it was built by
    ``trades_as_of``, so nothing later than the cutoff is present). Used only to
    window the peer-popular source; a day of slack is immaterial."""
    filed = as_of_frame["filed_at"].dropna()
    if filed.empty:
        return date(1900, 1, 1)
    return filed.max().date()
