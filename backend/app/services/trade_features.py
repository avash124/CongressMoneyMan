"""Deterministic trading-pattern features for the RAG insight layer (phase 1).

Aggregates the persisted `trades` rows into per-member and per-ticker feature
rows (`trade_features`) plus cross-asset-class stats (`asset_class_stats`).
Every number is computed here in Python — the generation layer built on top
only retrieves and narrates these rows.

Estimated P/L follows the stock-leaderboard methodology: disclosure-range
midpoints as weights, each buy day's close vs. the latest close, with the same
buys priced against SPY as the benchmark. Buy -> sell pairing mirrors the
trade-detail logic (most recent prior buy), consuming each buy once.
"""

import logging
import math
import re
from bisect import bisect_right

from ..clients.prices import get_company_profile, get_daily_closes
from ..clients.quiver import classify_transaction, format_trade_range, parse_trade_range
from ..core.db import get_all_trades, upsert_asset_class_stats, upsert_trade_features
from ..core.util import iso_date, map_with_concurrency, now_ms, parse_ms
from .industry_classifier import categorize_industry
from .sector_map import static_profile

logger = logging.getLogger("trade_features")

BENCHMARK_TICKER = "SPY"
PRICED_UNIVERSE_SIZE = 300
MAX_BUY_DATES_PER_TICKER = 12
DAY_MS = 24 * 60 * 60 * 1000
MONTH_MS = 30.44 * DAY_MS
PL_LOOKBACK_MS = 3 * 365 * DAY_MS
STALE_PRICE_MS = 14 * DAY_MS
PRICE_CONCURRENCY = 3
PRICE_DELAY_MS = 350
PROFILE_CONCURRENCY = 4
TOP_SECTORS = 3
TOP_TICKERS = 10

_REAL_TICKER_RE = re.compile(r"^[A-Za-z.]{1,6}$")

_ASSET_CLASSES = {
    "st": "stock",
    "cs": "stock",
    "ps": "stock",
    "stock": "stock",
    "common stock": "stock",
    "et": "etf",
    "etf": "etf",
    "etn": "etf",
    "ct": "crypto",
    "crypto": "crypto",
    "cryptocurrency": "crypto",
    "op": "option",
    "opt": "option",
    "option": "option",
    "options": "option",
    "stock option": "option",
    "mf": "fund",
    "fund": "fund",
    "mutual fund": "fund",
    "cb": "bond",
    "gs": "bond",
    "ab": "bond",
    "bond": "bond",
    "bonds": "bond",
    "corporate bond": "bond",
}


def normalize_asset_type(value: str | None) -> str:
    """Quiver TickerType (or a human label) -> one of the class keys above.
    Explicit unmapped codes (OT, HN, ...) mean miscellaneous securities and
    land in "other"; a missing type is "unknown" (the bulk feed drops it)."""
    key = (value or "").strip().lower()
    if not key:
        return "unknown"
    return _ASSET_CLASSES.get(key, "other")


def _midpoint_usd(trade: dict) -> float:
    """Disclosure midpoint for a trade row: range text preferred, else the
    numeric lower bound widened to its standard band."""
    text = trade.get("range_text")
    size = trade.get("trade_size_usd")
    if text is None and size is not None:
        try:
            text = format_trade_range(float(size))
        except (TypeError, ValueError):
            text = None
    parsed = parse_trade_range(text)
    if parsed:
        return (parsed["low"] + parsed["high"]) / 2
    try:
        value = float(size)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _is_senate(chamber: str | None) -> bool:
    return "senate" in (chamber or "").lower()


def _party_key(party: str | None) -> str:
    initial = (party or "").strip()[:1].upper()
    return initial if initial in ("D", "R", "I") else "Other"


def _real_ticker(trade: dict) -> str | None:
    ticker = (trade.get("ticker") or "").strip().upper()
    if ticker and ticker != "-" and _REAL_TICKER_RE.match(ticker):
        return ticker
    return None


def _trade_day(trade: dict) -> str:
    return (trade.get("transaction_date") or trade.get("traded") or "")[:10]


def _sector_of(ticker: str, profiles: dict[str, dict]) -> str:
    profile = profiles.get(ticker) or static_profile(ticker)
    return (profile or {}).get("sector") or "Other"


def _series_index(series: list[dict]) -> tuple[list[float], list[float]] | None:
    """Ascending {"date", "close"} bars -> parallel (times_ms, closes) lists."""
    times: list[float] = []
    closes: list[float] = []
    for bar in series:
        t = parse_ms(bar.get("date"))
        close = bar.get("close")
        if t is None or not isinstance(close, (int, float)) or close <= 0:
            continue
        times.append(t)
        closes.append(close)
    return (times, closes) if times else None


def _price_on(index: tuple[list[float], list[float]], day_ms: float) -> float | None:
    times, closes = index
    i = bisect_right(times, day_ms)
    return closes[i - 1] if i else None


def _infer_ticker_classes(trades: list[dict]) -> dict[str, str]:
    """Majority typed class per ticker. Backfills rows whose feed carried no
    asset type (the bulk feed drops TickerType) from the same ticker's typed
    rows; ties break alphabetically so the result is deterministic."""
    counts: dict[str, dict[str, int]] = {}
    for trade in trades:
        ticker = _real_ticker(trade)
        if not ticker:
            continue
        asset_class = normalize_asset_type(trade.get("asset_type"))
        if asset_class == "unknown":
            continue
        by_class = counts.setdefault(ticker, {})
        by_class[asset_class] = by_class.get(asset_class, 0) + 1
    return {
        ticker: max(sorted(by_class.items()), key=lambda kv: kv[1])[0]
        for ticker, by_class in counts.items()
    }


def _new_agg() -> dict:
    return {
        "trade_count": 0,
        "buy_count": 0,
        "sell_count": 0,
        "first_ts": None,
        "last_ts": None,
        "bought_usd": 0.0,
        "sold_usd": 0.0,
        "hold_days": 0.0,
        "pairs": 0,
        "est_gain": 0.0,
        "est_base": 0.0,
        "spy_gain": 0.0,
        "spy_base": 0.0,
    }


def _bump(agg: dict, kind: str, ts: float | None, usd: float) -> None:
    agg["trade_count"] += 1
    if kind == "buy":
        agg["buy_count"] += 1
        agg["bought_usd"] += usd
    elif kind == "sell":
        agg["sell_count"] += 1
        agg["sold_usd"] += usd
    if ts is not None:
        if agg["first_ts"] is None or ts < agg["first_ts"]:
            agg["first_ts"] = ts
        if agg["last_ts"] is None or ts > agg["last_ts"]:
            agg["last_ts"] = ts


def _date(ts: float | None) -> str | None:
    return iso_date(ts) if ts is not None else None


def _pct(gain: float, base: float) -> float | None:
    return round(gain / base * 100, 2) if base > 0 else None


def _common_fields(agg: dict) -> dict:
    first, last = agg["first_ts"], agg["last_ts"]
    trades_per_month = None
    if first is not None and last is not None:
        trades_per_month = round(
            agg["trade_count"] / max((last - first) / MONTH_MS, 1.0), 2
        )
    est_pct = _pct(agg["est_gain"], agg["est_base"])
    spy_pct = _pct(agg["spy_gain"], agg["spy_base"])
    return {
        "trade_count": agg["trade_count"],
        "buy_count": agg["buy_count"],
        "sell_count": agg["sell_count"],
        "buy_sell_ratio": round(agg["buy_count"] / agg["sell_count"], 2)
        if agg["sell_count"]
        else None,
        "first_trade_date": _date(first),
        "last_trade_date": _date(last),
        "trades_per_month": trades_per_month,
        "matched_pairs": agg["pairs"],
        "avg_holding_days": round(agg["hold_days"] / agg["pairs"], 1)
        if agg["pairs"]
        else None,
        "total_bought_usd": round(agg["bought_usd"]),
        "total_sold_usd": round(agg["sold_usd"]),
        "priced_buy_usd": round(agg["est_base"]) if agg["est_base"] > 0 else None,
        "est_pl_pct": est_pct,
        "est_pl_usd": round(agg["est_gain"]) if agg["est_base"] > 0 else None,
        "spy_pl_pct": spy_pct,
        "excess_return_pct": round(est_pct - spy_pct, 2)
        if est_pct is not None and spy_pct is not None
        else None,
    }


def _member_row(bioguide_id: str, agg: dict) -> dict:
    sector_total = sum(agg["sector_usd"].values())
    top_sectors = (
        [
            {"sector": sector, "pct": round(usd / sector_total * 100, 1)}
            for sector, usd in sorted(
                agg["sector_usd"].items(), key=lambda kv: kv[1], reverse=True
            )[:TOP_SECTORS]
        ]
        if sector_total > 0
        else None
    )
    asset_types = {
        klass: round(usd)
        for klass, usd in sorted(
            agg["class_usd"].items(), key=lambda kv: kv[1], reverse=True
        )
    }
    return {
        "feature_id": f"member|{bioguide_id}",
        "scope": "member",
        "entity_key": bioguide_id,
        "display_name": agg["name"] or bioguide_id,
        "party": agg["party"],
        "chamber": "senate" if _is_senate(agg["chamber"]) else "house",
        "sector": None,
        "asset_type": None,
        **_common_fields(agg),
        "top_sectors": top_sectors,
        "asset_types": asset_types or None,
        "member_count": None,
        "house_count": None,
        "senate_count": None,
    }


def _ticker_row(ticker: str, agg: dict, profiles: dict[str, dict]) -> dict:
    profile = profiles.get(ticker) or static_profile(ticker)
    dominant = (
        max(sorted(agg["class_counts"].items()), key=lambda kv: kv[1])[0]
        if agg["class_counts"]
        else "unknown"
    )
    return {
        "feature_id": f"ticker|{ticker}",
        "scope": "ticker",
        "entity_key": ticker,
        "display_name": (profile or {}).get("name") or ticker,
        "party": None,
        "chamber": None,
        "sector": (profile or {}).get("sector") or "Other",
        "asset_type": dominant,
        **_common_fields(agg),
        "top_sectors": None,
        "asset_types": None,
        "member_count": len(agg["members"]),
        "house_count": len(agg["house"]),
        "senate_count": len(agg["senate"]),
    }


def _asset_row(asset_type: str, agg: dict) -> dict:
    top = sorted(agg["ticker_usd"].items(), key=lambda kv: kv[1], reverse=True)
    return {
        "asset_type": asset_type,
        "trade_count": agg["trade_count"],
        "buy_count": agg["buy_count"],
        "sell_count": agg["sell_count"],
        "member_count": len(agg["members"]),
        "total_bought_usd": round(agg["bought_usd"]),
        "total_sold_usd": round(agg["sold_usd"]),
        "first_trade_date": _date(agg["first_ts"]),
        "last_trade_date": _date(agg["last_ts"]),
        "by_chamber": {
            chamber: {
                "trades": agg["chamber_trades"].get(chamber, 0),
                "boughtUsd": round(agg["chamber_usd"].get(chamber, 0)),
            }
            for chamber in ("house", "senate")
        },
        "by_party": {
            party: {
                "trades": trades,
                "boughtUsd": round(agg["party_usd"].get(party, 0)),
            }
            for party, trades in sorted(agg["party_trades"].items())
        },
        "top_tickers": [
            {
                "ticker": ticker,
                "boughtUsd": round(usd),
                "members": len(agg["ticker_members"].get(ticker, ())),
            }
            for ticker, usd in top[:TOP_TICKERS]
        ],
    }


def build_feature_rows(
    trades: list[dict],
    closes_by_ticker: dict[str, list[dict]],
    profiles: dict[str, dict],
    now: float | None = None,
) -> tuple[list[dict], list[dict], list[dict]]:
    """Pure aggregation of DB trade rows into upsert-ready feature rows:
    (member rows, ticker rows, asset-class rows).

    `closes_by_ticker` holds ascending {"date", "close"} series for the priced
    universe plus BENCHMARK_TICKER; tickers absent from it get no P/L fields.
    `profiles` maps tickers to {"name", "sector"}.
    """
    now = now_ms() if now is None else now
    lookback_cutoff = now - PL_LOOKBACK_MS
    inferred_classes = _infer_ticker_classes(trades)

    members: dict[str, dict] = {}
    tickers: dict[str, dict] = {}
    classes: dict[str, dict] = {}
    legs: dict[tuple[str, str], list[tuple[float, str]]] = {}
    buy_events: dict[str, list[dict]] = {}

    for trade in trades:
        bioguide_id = trade.get("bioguide_id")
        if not bioguide_id:
            continue
        kind = classify_transaction(trade.get("transaction_type"))
        day = _trade_day(trade)
        ts = parse_ms(day)
        usd = _midpoint_usd(trade)
        ticker = _real_ticker(trade)
        asset_class = normalize_asset_type(trade.get("asset_type"))
        if asset_class == "unknown" and ticker:
            asset_class = inferred_classes.get(ticker, "unknown")
        chamber = "senate" if _is_senate(trade.get("chamber")) else "house"

        member = members.get(bioguide_id)
        if member is None:
            member = {
                **_new_agg(),
                "name": None,
                "party": None,
                "chamber": None,
                "id_ts": float("-inf"),
                "sector_usd": {},
                "class_usd": {},
            }
            members[bioguide_id] = member
        _bump(member, kind, ts, usd)
        stamp = ts if ts is not None else float("-inf")
        if trade.get("member_name") and stamp >= member["id_ts"]:
            member["id_ts"] = stamp
            member["name"] = trade["member_name"]
            member["party"] = trade.get("party") or member["party"]
            member["chamber"] = trade.get("chamber") or member["chamber"]
        if usd > 0:
            member["class_usd"][asset_class] = (
                member["class_usd"].get(asset_class, 0.0) + usd
            )
            if ticker:
                sector = _sector_of(ticker, profiles)
                member["sector_usd"][sector] = (
                    member["sector_usd"].get(sector, 0.0) + usd
                )

        if ticker:
            ticker_agg = tickers.get(ticker)
            if ticker_agg is None:
                ticker_agg = {
                    **_new_agg(),
                    "members": set(),
                    "house": set(),
                    "senate": set(),
                    "class_counts": {},
                }
                tickers[ticker] = ticker_agg
            _bump(ticker_agg, kind, ts, usd)
            ticker_agg["members"].add(bioguide_id)
            ticker_agg[chamber].add(bioguide_id)
            ticker_agg["class_counts"][asset_class] = (
                ticker_agg["class_counts"].get(asset_class, 0) + 1
            )
            if ts is not None:
                legs.setdefault((bioguide_id, ticker), []).append((ts, kind))
            if kind == "buy" and ts is not None and ts >= lookback_cutoff and usd > 0:
                buy_events.setdefault(ticker, []).append(
                    {"ts": ts, "usd": usd, "bioguide_id": bioguide_id}
                )

        class_agg = classes.get(asset_class)
        if class_agg is None:
            class_agg = {
                **_new_agg(),
                "members": set(),
                "chamber_trades": {},
                "chamber_usd": {},
                "party_trades": {},
                "party_usd": {},
                "ticker_usd": {},
                "ticker_members": {},
            }
            classes[asset_class] = class_agg
        _bump(class_agg, kind, ts, usd)
        class_agg["members"].add(bioguide_id)
        party = _party_key(trade.get("party"))
        class_agg["chamber_trades"][chamber] = (
            class_agg["chamber_trades"].get(chamber, 0) + 1
        )
        class_agg["party_trades"][party] = class_agg["party_trades"].get(party, 0) + 1
        if kind == "buy" and usd > 0:
            class_agg["chamber_usd"][chamber] = (
                class_agg["chamber_usd"].get(chamber, 0.0) + usd
            )
            class_agg["party_usd"][party] = class_agg["party_usd"].get(party, 0.0) + usd
            if ticker:
                class_agg["ticker_usd"][ticker] = (
                    class_agg["ticker_usd"].get(ticker, 0.0) + usd
                )
                class_agg["ticker_members"].setdefault(ticker, set()).add(bioguide_id)

    for (bioguide_id, ticker), events in legs.items():
        events.sort(key=lambda event: event[0])
        open_buys: list[float] = []
        for ts, kind in events:
            if kind == "buy":
                open_buys.append(ts)
            elif kind == "sell" and open_buys:
                days = (ts - open_buys.pop()) / DAY_MS
                for agg in (members[bioguide_id], tickers[ticker]):
                    agg["hold_days"] += days
                    agg["pairs"] += 1

    spy_index = _series_index(closes_by_ticker.get(BENCHMARK_TICKER) or [])
    spy_current = None
    if spy_index and now - spy_index[0][-1] <= STALE_PRICE_MS:
        spy_current = spy_index[1][-1]
    elif buy_events:
        logger.warning(
            "benchmark %s series missing or stale — spy_pl_pct/excess_return_pct "
            "will be null for every entity this refresh", BENCHMARK_TICKER
        )

    for ticker, events in buy_events.items():
        index = _series_index(closes_by_ticker.get(ticker) or [])
        if not index or now - index[0][-1] > STALE_PRICE_MS:
            continue
        current = index[1][-1]
        for event in events:
            price = _price_on(index, event["ts"])
            if price is None:
                continue
            pct = (current - price) / price
            targets = (tickers[ticker], members[event["bioguide_id"]])
            for agg in targets:
                agg["est_gain"] += event["usd"] * pct
                agg["est_base"] += event["usd"]
            if spy_current is not None:
                spy_price = _price_on(spy_index, event["ts"])
                if spy_price is not None:
                    spy_pct = (spy_current - spy_price) / spy_price
                    for agg in targets:
                        agg["spy_gain"] += event["usd"] * spy_pct
                        agg["spy_base"] += event["usd"]

    member_rows = [
        _member_row(bioguide_id, agg) for bioguide_id, agg in sorted(members.items())
    ]
    ticker_rows = [
        _ticker_row(ticker, agg, profiles) for ticker, agg in sorted(tickers.items())
    ]
    asset_rows = [_asset_row(klass, agg) for klass, agg in sorted(classes.items())]
    return member_rows, ticker_rows, asset_rows


def _pick_priced_universe(trades: list[dict], now: float) -> dict[str, str]:
    """Top tickers by in-lookback disclosed buy value -> earliest date to fetch
    closes from (bounded to the MAX_BUY_DATES_PER_TICKER most recent buy days)."""
    cutoff = now - PL_LOOKBACK_MS
    weights: dict[str, float] = {}
    days: dict[str, set[str]] = {}
    for trade in trades:
        if classify_transaction(trade.get("transaction_type")) != "buy":
            continue
        ticker = _real_ticker(trade)
        if not ticker:
            continue
        day = _trade_day(trade)
        ts = parse_ms(day)
        usd = _midpoint_usd(trade)
        if ts is None or ts < cutoff or usd <= 0:
            continue
        weights[ticker] = weights.get(ticker, 0.0) + usd
        days.setdefault(ticker, set()).add(day)
    top = sorted(weights, key=lambda t: weights[t], reverse=True)[:PRICED_UNIVERSE_SIZE]
    return {
        ticker: min(sorted(days[ticker], reverse=True)[:MAX_BUY_DATES_PER_TICKER])
        for ticker in top
    }


async def _fetch_closes(fetch_from: dict[str, str]) -> dict[str, list[dict]]:
    async def fetch(ticker: str) -> tuple[str, list[dict]]:
        return ticker, await get_daily_closes(ticker, fetch_from[ticker])

    tickers = sorted(fetch_from, key=lambda t: (t != BENCHMARK_TICKER, t))
    pairs = await map_with_concurrency(
        tickers, PRICE_CONCURRENCY, fetch, PRICE_DELAY_MS
    )
    return {ticker: series for ticker, series in pairs if series}


async def _resolve_profiles(tickers: list[str]) -> dict[str, dict]:
    async def resolve(ticker: str) -> tuple[str, dict]:
        known = static_profile(ticker)
        if known:
            return ticker, known
        try:
            profile = await get_company_profile(ticker)
        except Exception:
            profile = None
        if not profile:
            return ticker, {"name": ticker, "sector": "Other"}
        sector = profile["sector"]
        if not sector:
            text = f"{profile['name']} {profile['industry']}".strip()
            sector = categorize_industry(text) if text else "Other"
        return ticker, {"name": profile["name"] or ticker, "sector": sector}

    pairs = await map_with_concurrency(tickers, PROFILE_CONCURRENCY, resolve)
    return dict(pairs)


async def refresh_trade_features() -> dict:
    """Rebuild trade_features + asset_class_stats from the persisted trades."""
    trades = await get_all_trades()
    if not trades:
        logger.warning("refresh_trade_features: no trades in DB, nothing to compute")
        return {"members": 0, "tickers": 0, "assetClasses": 0}

    now = now_ms()
    fetch_from = _pick_priced_universe(trades, now)
    if fetch_from:
        earliest = min(fetch_from.values())
        fetch_from[BENCHMARK_TICKER] = min(
            fetch_from.get(BENCHMARK_TICKER, earliest), earliest
        )
    closes = await _fetch_closes(fetch_from)
    profiles = await _resolve_profiles(sorted(fetch_from))

    member_rows, ticker_rows, asset_rows = build_feature_rows(
        trades, closes, profiles, now
    )
    await upsert_trade_features([*member_rows, *ticker_rows])
    await upsert_asset_class_stats(asset_rows)
    return {
        "members": len(member_rows),
        "tickers": len(ticker_rows),
        "assetClasses": len(asset_rows),
    }
