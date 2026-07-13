"""Current-position (holdings) features (plan §2.5 family #2).

Derived from the member's as-of trades, NOT the live ``portfolio_holdings``
snapshot — that table has no point-in-time column and would leak future
positions into past folds (same reasoning as ``candidates.py``). Net position =
signed sum of buys(+1)/sells(-1) per ticker up to as_of.

One row per candidate, indexed by ``candidates`` order to concat by position in
the assembler. A candidate the member never traded gets zeros.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

_BUY_TYPES = {"purchase", "buy"}
_SELL_TYPES = {"sale", "sell", "sale (full)", "sale (partial)"}

PAIR_COLS = (
    "h_net_position",
    "h_is_held",
)


def pair_features(
    member_rows: pd.DataFrame, as_of: date, candidates: list[str]
) -> pd.DataFrame:
    """Net-position features per candidate for one member.

    ``h_net_position`` is the clipped-at-zero signed trade sum (a net-sold-out
    name is not "held", matching HoldingsScorer). ``h_is_held`` is its indicator.
    """
    idx = pd.Index(candidates, name="ticker")
    if member_rows.empty:
        return pd.DataFrame(
            {"h_net_position": 0.0, "h_is_held": 0.0}, index=idx
        )[list(PAIR_COLS)]

    kind = member_rows["transaction_type"].astype("string").str.strip().str.lower()
    signed = np.where(
        kind.isin(_BUY_TYPES), 1.0, np.where(kind.isin(_SELL_TYPES), -1.0, 0.0)
    )
    net = (
        pd.Series(signed, index=member_rows["ticker"].to_numpy())
        .groupby(level=0)
        .sum()
        .clip(lower=0.0)
    )
    out = pd.DataFrame(index=idx)
    out["h_net_position"] = net.reindex(idx).fillna(0.0)
    out["h_is_held"] = (out["h_net_position"] > 0).astype(float)
    return out[list(PAIR_COLS)]
