"""Market-data client: Alpaca (intraday/daily bars) with FMP fallback
(port of lib/prices.ts).

Bars, snapshots, and chart points are dicts with the same keys the TS code
emitted (`t`/`o`/`h`/`l`/`c`/`v`, `date`/`open`/`close`/..., `t`/`c`).
"""

import asyncio
import logging
import os
import random
from datetime import datetime, timezone

from ..core.http import shared_client
from ..core.util import iso_date, now_ms, parse_ms

logger = logging.getLogger("prices")

ALPACA_BASE_URL = "https://data.alpaca.markets"
FMP_BASE_URL = "https://financialmodelingprep.com/stable"
MAX_RETRIES = 3
RETRY_BASE_DELAYS_MS = [800, 2500, 6000]
DAY_MS = 24 * 60 * 60 * 1000
FMP_COOLDOWN_MS = 2 * 60 * 1000

CHART_RANGES = ("24H", "1W", "1M", "6M", "1Y", "5Y")

_fmp_cooldown_until = 0.0


def _fmp_rate_limited() -> bool:
    return now_ms() < _fmp_cooldown_until


def _note_fmp_rate_limit() -> None:
    global _fmp_cooldown_until
    _fmp_cooldown_until = now_ms() + FMP_COOLDOWN_MS


async def _fetch_json(
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    label: str,
    on_rate_limit=None,
):
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await shared_client().get(
                url,
                params=params,
                headers={"Accept": "application/json", **(headers or {})},
            )

            if response.status_code < 400:
                return response.json()

            if response.status_code == 429:
                if on_rate_limit:
                    on_rate_limit()
                logger.warning("[%s] 429 rate limited", label)
                return None

            transient = response.status_code >= 500
            if not transient or attempt == MAX_RETRIES:
                if transient:
                    logger.warning("[%s] %s after retries", label, response.status_code)
                return None

            await asyncio.sleep(
                (RETRY_BASE_DELAYS_MS[attempt] + random.randint(0, 249)) / 1000
            )
        except Exception as error:
            if attempt == MAX_RETRIES:
                logger.error("[%s] request failed: %s", label, error)
                return None
            await asyncio.sleep(RETRY_BASE_DELAYS_MS[attempt] / 1000)

    return None


async def _alpaca_bars(ticker: str, params: dict[str, str]) -> list[dict]:
    api_key = os.getenv("ALPACA_KEY")
    api_secret = os.getenv("ALPACA_SECRET")
    if not api_key or not api_secret:
        return []

    data = await _fetch_json(
        f"{ALPACA_BASE_URL}/v2/stocks/{ticker}/bars",
        params=params,
        headers={"APCA-API-KEY-ID": api_key, "APCA-API-SECRET-KEY": api_secret},
        label="alpaca",
    )

    bars = (data or {}).get("bars") or []
    return [
        {
            "t": parse_ms(b["t"]),
            "o": b["o"],
            "h": b["h"],
            "l": b["l"],
            "c": b["c"],
            "v": b["v"],
        }
        for b in bars
    ]


def _fmp_params(params: dict[str, str]) -> dict[str, str] | None:
    api_key = os.getenv("FMP_API_KEY")
    if not api_key or _fmp_rate_limited():
        return None
    return {**params, "apikey": api_key}


async def _fetch_fmp_daily_window(ticker: str, date: str) -> list[dict]:
    date_ms = parse_ms(date)
    if date_ms is None:
        return []
    params = _fmp_params(
        {"symbol": ticker, "from": iso_date(date_ms - 45 * DAY_MS), "to": date}
    )
    if params is None:
        return []
    rows = await _fetch_json(
        f"{FMP_BASE_URL}/historical-price-eod/full",
        params=params,
        label="fmp",
        on_rate_limit=_note_fmp_rate_limit,
    )
    if not rows:
        return []
    bars = [
        {
            "t": parse_ms(b["date"]),
            "o": b["open"],
            "h": b["high"],
            "l": b["low"],
            "c": b["close"],
            "v": b["volume"],
        }
        for b in rows
        if b.get("date") and b["date"] <= date
    ]
    return sorted(bars, key=lambda b: b["t"])


async def get_daily_closes(ticker: str, from_date: str) -> list[dict]:
    params = _fmp_params(
        {"symbol": ticker, "from": from_date, "to": iso_date(now_ms())}
    )
    if params is not None:
        rows = await _fetch_json(
            f"{FMP_BASE_URL}/historical-price-eod/full",
            params=params,
            label="fmp",
            on_rate_limit=_note_fmp_rate_limit,
        )
        if rows:
            closes = [
                {"date": b["date"], "close": b["close"]}
                for b in rows
                if isinstance(b.get("close"), (int, float))
            ]
            return sorted(closes, key=lambda b: parse_ms(b["date"]) or 0)

    bars = await _alpaca_bars(
        ticker,
        {
            "timeframe": "1Day",
            "start": from_date,
            "end": iso_date(now_ms()),
            "adjustment": "all",
            "feed": "iex",
            "sort": "asc",
            "limit": "10000",
        },
    )
    return [
        {"date": iso_date(b["t"]), "close": b["c"]}
        for b in bars
        if isinstance(b.get("c"), (int, float))
    ]


async def get_day_snapshot(ticker: str, date: str) -> dict:
    intraday = await _alpaca_bars(
        ticker,
        {
            "timeframe": "5Min",
            "start": f"{date}T00:00:00Z",
            "end": f"{date}T23:59:59Z",
            "adjustment": "all",
            "feed": "iex",
            "sort": "asc",
            "limit": "10000",
        },
    )

    if intraday:
        return {
            "date": date,
            "open": intraday[0]["o"],
            "close": intraday[-1]["c"],
            "high": max(b["h"] for b in intraday),
            "low": min(b["l"] for b in intraday),
            "bars": intraday,
            "timeframe": "intraday",
        }

    daily = await _fetch_fmp_daily_window(ticker, date)
    if daily:
        last = daily[-1]
        return {
            "date": date,
            "open": last["o"],
            "close": last["c"],
            "high": last["h"],
            "low": last["l"],
            "bars": daily,
            "timeframe": "daily",
        }

    return {
        "date": date,
        "open": None,
        "close": None,
        "high": None,
        "low": None,
        "bars": [],
        "timeframe": "daily",
    }


async def get_company_profile(ticker: str) -> dict | None:
    """Returns {"name", "sector", "industry"} or None."""
    params = _fmp_params({"symbol": ticker})
    if params is None:
        return None
    rows = await _fetch_json(
        f"{FMP_BASE_URL}/profile",
        params=params,
        label="fmp-profile",
        on_rate_limit=_note_fmp_rate_limit,
    )
    profile = rows[0] if rows else None
    if not profile:
        return None
    return {
        "name": (profile.get("companyName") or "").strip() or ticker,
        "sector": (profile.get("sector") or "").strip(),
        "industry": (profile.get("industry") or "").strip(),
    }


def _daily_from_ms(chart_range: str, now: float) -> float:
    days = {"24H": 5, "1W": 8, "1M": 31, "6M": 183, "1Y": 366, "5Y": 5 * 366}[chart_range]
    return now - days * DAY_MS


async def get_price_history(ticker: str, chart_range: str) -> list[dict]:
    now = now_ms()

    if chart_range == "24H":
        bars = await _alpaca_bars(
            ticker,
            {
                "timeframe": "5Min",
                "start": f"{iso_date(now - 5 * DAY_MS)}T00:00:00Z",
                "end": datetime.now(timezone.utc).isoformat(),
                "adjustment": "all",
                "feed": "iex",
                "sort": "asc",
                "limit": "10000",
            },
        )
        if bars:
            last_day = iso_date(bars[-1]["t"])
            return [
                {"t": b["t"], "c": b["c"]} for b in bars if iso_date(b["t"]) == last_day
            ]
    elif chart_range == "1W":
        bars = await _alpaca_bars(
            ticker,
            {
                "timeframe": "1Hour",
                "start": f"{iso_date(now - 8 * DAY_MS)}T00:00:00Z",
                "end": datetime.now(timezone.utc).isoformat(),
                "adjustment": "all",
                "feed": "iex",
                "sort": "asc",
                "limit": "10000",
            },
        )
        if bars:
            return [{"t": b["t"], "c": b["c"]} for b in bars]

    closes = await get_daily_closes(ticker, iso_date(_daily_from_ms(chart_range, now)))
    return [{"t": parse_ms(b["date"]), "c": b["close"]} for b in closes]


async def get_latest_snapshot(ticker: str) -> dict | None:
    now = now_ms()
    bars = await _alpaca_bars(
        ticker,
        {
            "timeframe": "1Day",
            "start": iso_date(now - 40 * DAY_MS),
            "end": iso_date(now),
            "adjustment": "all",
            "feed": "iex",
            "limit": "60",
            "sort": "asc",
        },
    )
    if not bars:
        return None

    last = bars[-1]
    return {
        "date": iso_date(last["t"]),
        "open": last["o"],
        "close": last["c"],
        "high": last["h"],
        "low": last["l"],
        "bars": bars,
        "timeframe": "daily",
    }
