"""Member trading-history features (plan §2.5 family #1 — the highest lift/effort).

Pure functions over the as-of frame handed in by the harness. NO DB imports and,
critically, NO use of the cached ``trade_features`` table — that table is
computed on full history and would leak the future into past folds (plan §2.2,
§6.1). We recompute the same statistics as-of, from ``trades_as_of`` output only.

Two kinds of feature:
  - member-level  : one value per member, shared across all their candidates
                    (total trades, trades/month, buy ratio, distinct tickers,
                    days since the member's last trade of anything).
  - member×ticker : one value per (member, candidate) pair — the ones that
                    actually discriminate between candidates for a member
                    (decayed trade frequency on THIS ticker, days since the
                    member last traded it, buy/sell counts on it, a novelty
                    flag = has the member ever traded it before as_of).

Recency uses the same exponential decay as the persistence baseline so the
ranker starts from a representation at least as expressive as the baseline it
must beat.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

_BUY_TYPES = {"purchase", "buy"}
_SELL_TYPES = {"sale", "sell", "sale (full)", "sale (partial)"}
HALFLIFE_DAYS = 90.0
NEVER_DAYS = 100_000.0
MEMBER_COLS = (
    "m_total_trades",
    "m_distinct_tickers",
    "m_trades_per_month",
    "m_buy_ratio",
    "m_days_since_last_trade",
    "m_active_days",
)

PAIR_COLS = (
    "mt_decayed_freq",
    "mt_trade_count",
    "mt_buy_count",
    "mt_sell_count",
    "mt_days_since_last",
    "mt_is_repeat",
)


def _as_ts(as_of: date) -> pd.Timestamp:
    ts = pd.Timestamp(as_of)
    return ts.tz_localize("UTC") if ts.tz is None else ts.tz_convert("UTC")


def _kind(series: pd.Series) -> pd.Series:
    return series.astype("string").str.strip().str.lower()


def member_features(member_rows: pd.DataFrame, as_of: date) -> dict[str, float]:
    """Member-level aggregates from that member's as-of trades.

    ``member_rows`` is the slice of the as-of frame for one member. Empty slice
    (member with no prior known filings) yields all-zeros / NEVER sentinels so a
    cold-start member is a valid, non-crashing row.
    """
    now = _as_ts(as_of)
    n = len(member_rows)
    if n == 0:
        return {
            "m_total_trades": 0.0,
            "m_distinct_tickers": 0.0,
            "m_trades_per_month": 0.0,
            "m_buy_ratio": 0.0,
            "m_days_since_last_trade": NEVER_DAYS,
            "m_active_days": 0.0,
        }

    tx = member_rows["transaction_date"]
    kind = _kind(member_rows["transaction_type"])
    buys = int(kind.isin(_BUY_TYPES).sum())
    sells = int(kind.isin(_SELL_TYPES).sum())
    typed = buys + sells
    span_days = max((tx.max() - tx.min()).total_seconds() / 86400.0, 1.0)
    trades_per_month = n / span_days * 30.0

    days_since_last = (now - tx.max()).total_seconds() / 86400.0
    return {
        "m_total_trades": float(n),
        "m_distinct_tickers": float(member_rows["ticker"].nunique()),
        "m_trades_per_month": float(trades_per_month),
        "m_buy_ratio": float(buys / typed) if typed else 0.0,
        "m_days_since_last_trade": float(max(days_since_last, 0.0)),
        "m_active_days": float(span_days),
    }


def pair_features(
    member_rows: pd.DataFrame, as_of: date, candidates: list[str]
) -> pd.DataFrame:
    """One row per candidate with the member×ticker history features.

    Vectorized per-ticker groupby over the member's own trades, then reindexed
    onto ``candidates`` (a candidate the member never traded gets the zero/never
    row). Index is ``candidates`` order so the assembler can concat by position.
    """
    now = _as_ts(as_of)
    idx = pd.Index(candidates, name="ticker")

    if member_rows.empty:
        zero = pd.DataFrame(
            {
                "mt_decayed_freq": 0.0,
                "mt_trade_count": 0.0,
                "mt_buy_count": 0.0,
                "mt_sell_count": 0.0,
                "mt_days_since_last": NEVER_DAYS,
                "mt_is_repeat": 0.0,
            },
            index=idx,
        )
        return zero

    tx = member_rows["transaction_date"]
    age_days = (now - tx).dt.total_seconds() / 86400.0
    weight = np.exp(-age_days.clip(lower=0) / HALFLIFE_DAYS)
    kind = _kind(member_rows["transaction_type"])

    work = pd.DataFrame(
        {
            "ticker": member_rows["ticker"].to_numpy(),
            "weight": weight.to_numpy(),
            "age": age_days.to_numpy(),
            "is_buy": kind.isin(_BUY_TYPES).to_numpy().astype(float),
            "is_sell": kind.isin(_SELL_TYPES).to_numpy().astype(float),
        }
    )
    grp = work.groupby("ticker")
    agg = pd.DataFrame(
        {
            "mt_decayed_freq": grp["weight"].sum(),
            "mt_trade_count": grp.size(),
            "mt_buy_count": grp["is_buy"].sum(),
            "mt_sell_count": grp["is_sell"].sum(),
            "mt_days_since_last": grp["age"].min().clip(lower=0.0),
        }
    )
    out = agg.reindex(idx)
    out["mt_is_repeat"] = out["mt_trade_count"].notna().astype(float)
    out["mt_decayed_freq"] = out["mt_decayed_freq"].fillna(0.0)
    out["mt_trade_count"] = out["mt_trade_count"].fillna(0.0)
    out["mt_buy_count"] = out["mt_buy_count"].fillna(0.0)
    out["mt_sell_count"] = out["mt_sell_count"].fillna(0.0)
    out["mt_days_since_last"] = out["mt_days_since_last"].fillna(NEVER_DAYS)
    return out[list(PAIR_COLS)]
