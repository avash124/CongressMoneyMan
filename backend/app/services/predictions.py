"""Trade-prediction reader (P7).

Read-only access to the ``trade_predictions`` table the offline cron scorer
writes (ml/scripts/score_batch.py). Mirrors the rankings read path: the API
never computes predictions, it only serves the latest batch — same cron-writes /
API-reads separation. Degrades gracefully (missing config / failed request →
empty list), like the rest of ``core.db``.
"""

import logging

from ..core.db import _select, _select_all_pages

logger = logging.getLogger("predictions")

_BUY_TYPES = {"purchase", "buy"}
_SELL_TYPES = {"sale", "sell", "sale (full)", "sale (partial)"}


async def get_latest_predictions(bioguide_id: str) -> dict:
    """The member's most-recent prediction week: ranked ``(ticker, rank, score,
    p_buy)`` for the max ``as_of`` present. Empty list if the member has none.

    Ordered ``as_of.desc, rank.asc`` so the newest week is first and already
    rank-ordered; we then keep only the rows whose ``as_of`` equals that newest
    week (a single batch)."""
    rows = await _select_all_pages(
        "trade_predictions",
        {
            "select": "*",
            "bioguide_id": f"eq.{bioguide_id}",
            "order": "as_of.desc,rank.asc",
        },
        f"get_latest_predictions({bioguide_id})",
    )
    if not rows:
        return {
            "bioguideId": bioguide_id,
            "asOf": None,
            "modelVersion": None,
            "predictions": [],
        }

    latest = rows[0]["as_of"]
    predictions = [
        {
            "ticker": row["ticker"],
            "rank": row["rank"],
            "score": row["score"],
            "pBuy": row.get("p_buy"),
        }
        for row in rows
        if row["as_of"] == latest
    ]
    return {
        "bioguideId": bioguide_id,
        "asOf": latest,
        "modelVersion": rows[0].get("model_version"),
        "predictions": predictions,
    }


async def get_prediction_context(bioguide_id: str, ticker: str) -> dict:
    """Extra statistics for one predicted ``(member, ticker)`` — powers the card's
    detail popup. All figures are REAL, from disclosed data; none simulate the
    outcome of the (hypothetical, not-yet-made) predicted trade:

    - ``memberHistory``: the member's own disclosed trades of this ticker (counts,
      buy/sell split, last/first traded, and whether net buys imply they still
      appear to hold it) — the portfolio-relevance context.
    - ``tickerContext``: the ticker across Congress from the cached
      ``trade_features`` (sector, how many members/chambers trade it, and — where
      the ticker is priced — the estimated HISTORICAL P/L and excess-vs-SPY). This
      is past performance context, explicitly not a forecast of this trade.
    """
    ticker = (ticker or "").strip().upper()

    trades = await _select(
        "trades",
        {
            "select": "transaction_type,transaction_date,trade_size_usd",
            "bioguide_id": f"eq.{bioguide_id}",
            "ticker": f"eq.{ticker}",
            "order": "transaction_date.desc.nullslast",
        },
        f"get_prediction_context trades({bioguide_id}/{ticker})",
    )
    buys = sells = 0
    dates: list[str] = []
    for trade in trades:
        kind = (trade.get("transaction_type") or "").strip().lower()
        if kind in _BUY_TYPES:
            buys += 1
        elif kind in _SELL_TYPES:
            sells += 1
        when = trade.get("transaction_date")
        if when:
            dates.append(when)
    member_history = {
        "hasHistory": len(trades) > 0,
        "tradeCount": len(trades),
        "buyCount": buys,
        "sellCount": sells,
        "lastTraded": max(dates) if dates else None,
        "firstTraded": min(dates) if dates else None,
        "appearsHeld": buys > sells,
    }

    feature_rows = await _select(
        "trade_features",
        {
            "select": "sector,asset_type,member_count,house_count,senate_count,"
            "est_pl_pct,excess_return_pct,avg_holding_days",
            "feature_id": f"eq.ticker|{ticker}",
        },
        f"get_prediction_context features({ticker})",
    )
    feature = feature_rows[0] if feature_rows else None
    ticker_context = (
        {
            "sector": feature.get("sector"),
            "assetType": feature.get("asset_type"),
            "memberCount": feature.get("member_count"),
            "houseCount": feature.get("house_count"),
            "senateCount": feature.get("senate_count"),
            "estPlPct": feature.get("est_pl_pct"),
            "excessReturnPct": feature.get("excess_return_pct"),
            "avgHoldingDays": feature.get("avg_holding_days"),
        }
        if feature
        else None
    )

    return {
        "bioguideId": bioguide_id,
        "ticker": ticker,
        "memberHistory": member_history,
        "tickerContext": ticker_context,
    }
