"""Market / sector features (plan §2.5 #4 — P6 family 1).

Momentum, volatility, market cap, and sector affinity between a candidate and
the member's own sector mix. The marquee leakage surface of this phase, so the
one rule is stated first:

    Every price-derived feature windows on ``close_date <= as_of``.

Price data is NOT in Supabase — it is fetched (Alpaca/FMP) and pinned as the
``prices`` / ``profiles`` aux snapshots (``scripts/fetch_market.py``); this
module only ever receives those frames (no DB import — leakage scan applies).
A ticker with no price rows on/before ``as_of`` gets neutral (zero) momentum
and volatility, exactly as if the company had no history yet — never a peek at
a later close.

The member's sector mix is recomputed from that member's AS-OF trades (the
sectors they have traded before ``as_of``), so the sector-affinity feature is
itself point-in-time and needs no separate windowing.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from . import sectors
MOMENTUM_DAYS = 90

PAIR_COLS = (
    "mkt_momentum",        
    "mkt_volatility",      
    "mkt_log_mktcap",      
    "mkt_sector_match",    
    "mkt_sector_affinity", 
)


def _as_ts(as_of: date) -> pd.Timestamp:
    """As-of value -> tz-aware UTC end-of-day cutoff, matching the trades
    chokepoint (``dataset._as_timestamp``): a bare date means the END of that
    calendar day, so a close dated on the as_of day is visible (a close dated
    AFTER it never is). Replicated here — not imported — because market features
    must not import the DB-touching ``dataset`` module (leakage scan)."""
    ts = pd.Timestamp(as_of)
    ts = ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")
    if ts.normalize() == ts:  
        ts = ts + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
    return ts


class MarketFeatures:
    """Fold-level market features. Precompute per-ticker momentum/volatility and
    the sector lookup once per as_of, then serve per (member, candidates).

    ``prices`` = ``dataset.prices_frame`` output (ticker, close_date, close);
    ``profiles`` = ``dataset.profiles_frame`` output (ticker, sector, hq_state,
    market_cap). Either may be None/empty -> the corresponding feature is 0.
    """

    def __init__(
        self,
        as_of_frame: pd.DataFrame,
        as_of: date,
        prices: pd.DataFrame | None,
        profiles: pd.DataFrame | None,
    ):
        self._sector_of = sectors.build_sector_lookup(profiles)
        self._momentum, self._volatility = self._price_stats(prices, as_of)
        self._log_mktcap = self._mktcap_lookup(profiles)
        self._member_sector_mix = self._sector_mix(as_of_frame)

    def _price_stats(
        self, prices: pd.DataFrame | None, as_of: date
    ) -> tuple[dict[str, float], dict[str, float]]:
        """{ticker -> momentum}, {ticker -> volatility} over the trailing window,
        using ONLY closes dated on/before as_of (the #1 leakage rule)."""
        momentum: dict[str, float] = {}
        volatility: dict[str, float] = {}
        if prices is None or prices.empty:
            return momentum, volatility

        cutoff = _as_ts(as_of)
        window_start = cutoff - pd.Timedelta(days=MOMENTUM_DAYS)
        recent = prices[
            prices["close_date"].notna()
            & (prices["close_date"] <= cutoff)
            & (prices["close_date"] > window_start)
            & prices["close"].notna()
        ]
        for ticker, grp in recent.groupby("ticker"):
            g = grp.sort_values("close_date")
            closes = g["close"].to_numpy(dtype=float)
            if len(closes) < 2 or closes[0] <= 0:
                continue
            momentum[str(ticker)] = float(closes[-1] / closes[0] - 1.0)
            rets = np.diff(closes) / closes[:-1]
            volatility[str(ticker)] = float(np.std(rets)) if len(rets) else 0.0
        return momentum, volatility

    def _mktcap_lookup(self, profiles: pd.DataFrame | None) -> dict[str, float]:
        if profiles is None or profiles.empty:
            return {}
        out: dict[str, float] = {}
        for ticker, cap in zip(profiles["ticker"], profiles["market_cap"]):
            if pd.notna(cap) and cap > 0:
                out[str(ticker).strip().upper()] = float(np.log1p(cap))
        return out

    def _sector_mix(self, as_of_frame: pd.DataFrame) -> dict[str, dict[str, float]]:
        """{member -> {sector -> fraction of their as-of trades in it}}."""
        clean = as_of_frame.dropna(subset=["ticker", "bioguide_id"])
        mix: dict[str, dict[str, float]] = {}
        for member, grp in clean.groupby("bioguide_id"):
            counts: dict[str, int] = {}
            for tkr in grp["ticker"]:
                sec = self._sector_of.get(str(tkr).strip().upper())
                if sec:
                    counts[sec] = counts.get(sec, 0) + 1
            total = sum(counts.values())
            if total:
                mix[str(member)] = {s: c / total for s, c in counts.items()}
        return mix

    def pair_features(
        self, member_id: str, candidates: list[str]
    ) -> pd.DataFrame:
        idx = pd.Index(candidates, name="ticker")
        member_mix = self._member_sector_mix.get(str(member_id), {})

        momentum = np.zeros(len(candidates), dtype=float)
        volatility = np.zeros(len(candidates), dtype=float)
        log_cap = np.zeros(len(candidates), dtype=float)
        match = np.zeros(len(candidates), dtype=float)
        affinity = np.zeros(len(candidates), dtype=float)

        for i, cand in enumerate(candidates):
            t = str(cand).strip().upper()
            momentum[i] = self._momentum.get(t, 0.0)
            volatility[i] = self._volatility.get(t, 0.0)
            log_cap[i] = self._log_mktcap.get(t, 0.0)
            sec = self._sector_of.get(t)
            if sec and sec in member_mix:
                match[i] = 1.0
                affinity[i] = member_mix[sec]

        out = pd.DataFrame(index=idx)
        out["mkt_momentum"] = momentum
        out["mkt_volatility"] = volatility
        out["mkt_log_mktcap"] = log_cap
        out["mkt_sector_match"] = match
        out["mkt_sector_affinity"] = affinity
        return out[list(PAIR_COLS)]
