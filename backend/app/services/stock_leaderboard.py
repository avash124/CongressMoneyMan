"""Stock holdings + performance leaderboards (port of lib/stockLeaderboard.ts)."""

import asyncio
import logging
import math
import re

from ..clients.prices import get_company_profile, get_daily_closes
from ..clients.quiver import classify_transaction, format_trade_range, parse_trade_range
from ..core.cache import get_cache, set_cache
from ..core.db import (
    get_all_trades,
    get_holdings_by_ticker,
    get_holdings_from_db,
    replace_holdings_for_members,
)
from ..core.util import map_with_concurrency, now_ms, parse_ms
from .industry_classifier import categorize_industry
from .sector_map import static_profile

logger = logging.getLogger("stock_leaderboard")

HOLDINGS_KEY = "stock-holdings-v4"
PERFORMANCE_KEY = "stock-performance-v4"
HOLDINGS_TTL_SECONDS = 6 * 60 * 60
PERFORMANCE_TTL_SECONDS = 36 * 60 * 60

HOLDINGS_TOP_N = 120
PERF_UNIVERSE_SIZE = 400
PERF_TOP_N = 400
MAX_BUY_DATES_PER_TICKER = 12
PERF_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000
STALE_PRICE_MS = 14 * 24 * 60 * 60 * 1000
PRICE_CONCURRENCY = 3
PROFILE_CONCURRENCY = 4

_REAL_TICKER_RE = re.compile(r"^[A-Za-z.]{1,6}$")


def _is_senate(chamber: str | None) -> bool:
    return "senate" in (chamber or "").lower()


def _to_number(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return math.nan
    return number


def build_holdings_leaderboard(holdings: list[dict]) -> list[dict]:
    by_ticker: dict[str, float] = {}

    for h in holdings:
        ticker = (h.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        value = _to_number(h.get("value"))
        if not math.isfinite(value) or value <= 0:
            continue
        by_ticker[ticker] = by_ticker.get(ticker, 0) + value

    rows = [
        {"ticker": ticker, "totalValue": round(total)}
        for ticker, total in by_ticker.items()
    ]
    rows.sort(key=lambda row: row["totalValue"], reverse=True)
    return rows[:HOLDINGS_TOP_N]


def _resolve_sector(profile: dict | None) -> str:
    if not profile:
        return "Other"
    if profile["sector"]:
        return profile["sector"]
    text = f"{profile['name']} {profile['industry']}".strip()
    return categorize_industry(text) if text else "Other"


async def _resolve_profile(ticker: str) -> dict:
    known = static_profile(ticker)
    if known:
        return known
    try:
        profile = await get_company_profile(ticker)
    except Exception:
        profile = None
    return {
        "name": (profile or {}).get("name") or ticker,
        "sector": _resolve_sector(profile),
    }


async def _enrich_holdings(rows: list[dict]) -> list[dict]:
    async def enrich(row: dict) -> dict:
        profile = await _resolve_profile(row["ticker"])
        return {
            "ticker": row["ticker"],
            "name": profile["name"],
            "totalValue": row["totalValue"],
            "sector": profile["sector"],
        }

    return await map_with_concurrency(rows, PROFILE_CONCURRENCY, enrich)


async def persist_holdings(members: list[dict]) -> None:
    if not members:
        return

    rows: list[dict] = []
    for m in members:
        by_ticker: dict[str, float] = {}
        for p in m["positions"]:
            ticker = p["ticker"].strip().upper()
            value = p["value"]
            if not ticker or not math.isfinite(value) or value <= 0:
                continue
            by_ticker[ticker] = by_ticker.get(ticker, 0) + value
        for ticker, value in by_ticker.items():
            rows.append(
                {
                    "bioguide_id": m["bioguideId"],
                    "member_name": m["memberName"],
                    "party": m["party"],
                    "chamber": m["chamber"],
                    "ticker": ticker,
                    "value": value,
                }
            )

    await replace_holdings_for_members([m["bioguideId"] for m in members], rows)

    all_holdings = await get_holdings_from_db()
    if all_holdings:
        enriched = await _enrich_holdings(build_holdings_leaderboard(all_holdings))
        await set_cache(HOLDINGS_KEY, enriched, HOLDINGS_TTL_SECONDS)


async def get_holdings_leaderboard() -> list[dict]:
    cached = await get_cache(HOLDINGS_KEY)
    if cached:
        return cached

    all_holdings = await get_holdings_from_db()
    if not all_holdings:
        return []

    enriched = await _enrich_holdings(build_holdings_leaderboard(all_holdings))
    await set_cache(HOLDINGS_KEY, enriched, HOLDINGS_TTL_SECONDS)
    return enriched


async def get_ticker_holders(ticker: str) -> dict:
    normalized = ticker.strip().upper()
    rows = await get_holdings_by_ticker(normalized)

    by_member: dict[str, dict] = {}
    for h in rows:
        value = _to_number(h.get("value"))
        if not math.isfinite(value) or value <= 0:
            continue
        existing = by_member.get(h["bioguide_id"])
        if existing:
            existing["value"] += value
        else:
            by_member[h["bioguide_id"]] = {
                "bioguideId": h["bioguide_id"],
                "name": h.get("member_name") or h["bioguide_id"],
                "party": h.get("party") or "",
                "chamber": "senate" if _is_senate(h.get("chamber")) else "house",
                "value": value,
            }

    holders = sorted(
        ({**h, "value": round(h["value"])} for h in by_member.values()),
        key=lambda h: h["value"],
        reverse=True,
    )

    return {
        "ticker": normalized,
        "totalValue": sum(h["value"] for h in holders),
        "houseCount": sum(1 for h in holders if h["chamber"] == "house"),
        "senateCount": sum(1 for h in holders if h["chamber"] == "senate"),
        "holders": holders,
    }


def _is_real_ticker(ticker: str | None) -> bool:
    return bool(ticker) and ticker != "-" and bool(_REAL_TICKER_RE.match(ticker))


def _disclosure_midpoint(range_text: str | None, lower_bound: float | None) -> float:
    text = range_text
    if text is None and lower_bound is not None:
        text = format_trade_range(lower_bound)
    parsed = parse_trade_range(text)
    if parsed:
        return (parsed["low"] + parsed["high"]) / 2
    size = _to_number(lower_bound if lower_bound is not None else 0)
    return size if math.isfinite(size) else 0


def _aggregate_buys(trades: list[dict]) -> list[dict]:
    cutoff = now_ms() - PERF_LOOKBACK_MS
    by_ticker: dict[str, dict] = {}

    for t in trades:
        if classify_transaction(t.get("transaction_type")) != "buy":
            continue
        if not _is_real_ticker(t.get("ticker")):
            continue
        ticker = t["ticker"].upper()

        agg = by_ticker.get(ticker)
        if agg is None:
            agg = {
                "ticker": ticker,
                "boughtValue": 0.0,
                "members": set(),
                "house": set(),
                "senate": set(),
                "weightByDate": {},
            }
            by_ticker[ticker] = agg

        weight = _disclosure_midpoint(t.get("range_text"), t.get("trade_size_usd"))
        agg["boughtValue"] += weight
        agg["members"].add(t["bioguide_id"])
        if _is_senate(t.get("chamber")):
            agg["senate"].add(t["bioguide_id"])
        else:
            agg["house"].add(t["bioguide_id"])

        date = t.get("transaction_date") or t.get("traded") or ""
        parsed = parse_ms(date)
        if parsed is not None and parsed >= cutoff and weight > 0:
            day = date[:10]
            agg["weightByDate"][day] = agg["weightByDate"].get(day, 0) + weight

    return [a for a in by_ticker.values() if a["weightByDate"]]


async def _performance_for_ticker(buys: dict) -> dict | None:
    dates = sorted(
        buys["weightByDate"].items(),
        key=lambda entry: parse_ms(entry[0]) or 0,
        reverse=True,
    )[:MAX_BUY_DATES_PER_TICKER]
    if not dates:
        return None
    earliest = min((day for day, _ in dates), key=lambda day: parse_ms(day) or 0)
    series = await get_daily_closes(buys["ticker"], earliest)
    if not series:
        return None

    last_bar = series[-1]
    if now_ms() - (parse_ms(last_bar["date"]) or 0) > STALE_PRICE_MS:
        return None

    current_price = last_bar["close"]
    if not current_price > 0:
        return None

    def price_on(day: str) -> float | None:
        t = parse_ms(day) or 0
        chosen: float | None = None
        for bar in series:
            if (parse_ms(bar["date"]) or 0) <= t:
                chosen = bar["close"]
            else:
                break
        return chosen

    est_gain = 0.0
    base = 0.0
    for day, weight in dates:
        buy_price = price_on(day)
        if buy_price is None or buy_price <= 0:
            continue
        est_gain += weight * ((current_price - buy_price) / buy_price)
        base += weight
    if base <= 0:
        return None

    return {
        "ticker": buys["ticker"],
        "gainPct": (est_gain / base) * 100,
        "estGain": round(est_gain),
        "boughtValue": round(base),
        "memberCount": len(buys["members"]),
        "houseCount": len(buys["house"]),
        "senateCount": len(buys["senate"]),
    }


async def refresh_stock_performance() -> list[dict]:
    trades, holdings = await asyncio.gather(get_all_trades(), get_holdings_from_db())

    # Only rank stocks members currently hold — a bought-then-sold ticker has no
    # holders, so its ownership view would be empty. Skip the filter if holdings
    # haven't synced yet, so a missing table can't blank the whole board.
    held_tickers = {
        (h.get("ticker") or "").strip().upper()
        for h in holdings
        if (h.get("ticker") or "").strip() and _to_number(h.get("value")) > 0
    }

    universe = sorted(
        (
            b
            for b in _aggregate_buys(trades)
            if not held_tickers or b["ticker"] in held_tickers
        ),
        key=lambda b: b["boughtValue"],
        reverse=True,
    )[:PERF_UNIVERSE_SIZE]

    computed = sorted(
        (
            row
            for row in await map_with_concurrency(
                universe, PRICE_CONCURRENCY, _performance_for_ticker
            )
            if row is not None
        ),
        key=lambda row: row["gainPct"],
        reverse=True,
    )[:PERF_TOP_N]

    async def enrich(row: dict) -> dict:
        profile = await _resolve_profile(row["ticker"])
        return {**row, "name": profile["name"], "sector": profile["sector"]}

    rows = await map_with_concurrency(computed, PROFILE_CONCURRENCY, enrich)

    if rows:
        await set_cache(PERFORMANCE_KEY, rows, PERFORMANCE_TTL_SECONDS)
    return rows


async def get_stock_performance() -> list[dict]:
    cached = await get_cache(PERFORMANCE_KEY)
    if cached:
        return cached
    return await refresh_stock_performance()
