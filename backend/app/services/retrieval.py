"""Structured retrieval over the precomputed feature layer (RAG phase 2).

Thin, parameterized read functions that return compact, LLM-ready dicts —
this is the source of truth for every numeric claim the generation layer will
make. Everything degrades gracefully: missing data yields None or empty
collections, never an exception. Null fields are dropped so context blocks
stay small.
"""

import asyncio

from ..core.db import (
    get_asset_class_stats_from_db,
    get_priced_ticker_features,
    get_trade_features_by_ids,
)
from ..core.util import iso_date, now_ms
from .trade_features import DAY_MS, normalize_asset_type

_COMMON_FIELDS = [
    ("trade_count", "tradeCount"),
    ("buy_count", "buyCount"),
    ("sell_count", "sellCount"),
    ("buy_sell_ratio", "buySellRatio"),
    ("first_trade_date", "firstTradeDate"),
    ("last_trade_date", "lastTradeDate"),
    ("trades_per_month", "tradesPerMonth"),
    ("matched_pairs", "matchedPairs"),
    ("avg_holding_days", "avgHoldingDays"),
    ("total_bought_usd", "totalBoughtUsd"),
    ("total_sold_usd", "totalSoldUsd"),
    ("priced_buy_usd", "pricedBuyUsd"),
    ("est_pl_pct", "estPlPct"),
    ("est_pl_usd", "estPlUsd"),
    ("spy_pl_pct", "spyPlPct"),
    ("excess_return_pct", "excessReturnPct"),
    ("computed_at", "computedAt"),
]

_MEMBER_FIELDS = [
    ("entity_key", "bioguideId"),
    ("display_name", "name"),
    ("party", "party"),
    ("chamber", "chamber"),
    *_COMMON_FIELDS,
    ("top_sectors", "topSectors"),
    ("asset_types", "assetTypes"),
]

_TICKER_FIELDS = [
    ("entity_key", "ticker"),
    ("display_name", "name"),
    ("sector", "sector"),
    ("asset_type", "assetType"),
    ("member_count", "memberCount"),
    ("house_count", "houseCount"),
    ("senate_count", "senateCount"),
    *_COMMON_FIELDS,
]

_CLASS_FIELDS = [
    ("asset_type", "assetType"),
    ("trade_count", "tradeCount"),
    ("buy_count", "buyCount"),
    ("sell_count", "sellCount"),
    ("member_count", "memberCount"),
    ("total_bought_usd", "totalBoughtUsd"),
    ("total_sold_usd", "totalSoldUsd"),
    ("first_trade_date", "firstTradeDate"),
    ("last_trade_date", "lastTradeDate"),
    ("by_chamber", "byChamber"),
    ("by_party", "byParty"),
    ("top_tickers", "topTickers"),
    ("computed_at", "computedAt"),
]


def _compact(row: dict, fields: list[tuple[str, str]]) -> dict:
    out = {}
    for snake, camel in fields:
        value = row.get(snake)
        if value is not None:
            out[camel] = value
    return out


async def get_features_by_member(bioguide_id: str) -> dict | None:
    key = (bioguide_id or "").strip()
    if not key:
        return None
    rows = await get_trade_features_by_ids([f"member|{key}"])
    return _compact(rows[0], _MEMBER_FIELDS) if rows else None


async def get_features_by_ticker(ticker: str) -> dict | None:
    key = (ticker or "").strip().upper()
    if not key:
        return None
    rows = await get_trade_features_by_ids([f"ticker|{key}"])
    return _compact(rows[0], _TICKER_FIELDS) if rows else None


async def compare_assets(
    tickers: list[str] | None = None, asset_types: list[str] | None = None
) -> dict:
    """Side-by-side feature rows for the requested tickers and/or asset
    classes, in request order. Unknown entities are simply absent."""
    wanted_tickers = list(
        dict.fromkeys(t.strip().upper() for t in (tickers or []) if t and t.strip())
    )
    wanted_types = list(
        dict.fromkeys(normalize_asset_type(t) for t in (asset_types or []))
    )

    async def nothing() -> list[dict]:
        return []

    ticker_rows, class_rows = await asyncio.gather(
        get_trade_features_by_ids([f"ticker|{t}" for t in wanted_tickers])
        if wanted_tickers
        else nothing(),
        get_asset_class_stats_from_db(wanted_types) if wanted_types else nothing(),
    )

    by_ticker = {row.get("entity_key"): row for row in ticker_rows}
    by_type = {row.get("asset_type"): row for row in class_rows}
    return {
        "tickers": [
            _compact(by_ticker[t], _TICKER_FIELDS) for t in wanted_tickers if t in by_ticker
        ],
        "assetClasses": [
            _compact(by_type[t], _CLASS_FIELDS) for t in wanted_types if t in by_type
        ],
    }


async def top_movers(
    asset_type: str | None = None, window_days: int = 90, limit: int = 10
) -> list[dict]:
    """Tickers with the largest estimated P/L moves among those congress
    traded within the window, biggest absolute move first."""
    since = iso_date(now_ms() - window_days * DAY_MS) if window_days else None
    rows = await get_priced_ticker_features(
        normalize_asset_type(asset_type) if asset_type else None, since
    )
    rows.sort(key=lambda row: abs(row.get("est_pl_pct") or 0), reverse=True)
    return [_compact(row, _TICKER_FIELDS) for row in rows[:limit]]
