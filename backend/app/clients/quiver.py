"""Quiver Quantitative client (port of lib/quiver.ts).

Trades are plain dicts with Quiver's raw keys (`Bioguide`, `Ticker`,
`Transaction`, `UniqueID`, ...) so cached values stay interchangeable with the
Next.js backend.
"""

import asyncio
import logging
import random
import re

from ..core.cache import get_cache, increment_cache, set_cache
from ..core.db import get_recent_trades_from_db, get_trades_by_bioguide, upsert_trades, write_back
from ..core.http import shared_client
from ..core.util import parse_ms

logger = logging.getLogger("quiver")

QUIVER_API_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "CongressMoneyMan/1.0",
}

CIRCUIT_BREAKER_KEY = "quiver:circuit-breaker"
CIRCUIT_BREAKER_WINDOW_SECONDS = 60
CIRCUIT_BREAKER_THRESHOLD = 10
MAX_RETRIES = 3
RETRY_BASE_DELAYS_MS = [500, 1500, 4500]

CONGRESS_TRADES_KEY = "congress-trades"
CONGRESS_TRADES_TTL_SECONDS = 15 * 60


class QuiverCircuitOpenError(Exception):
    def __init__(self) -> None:
        super().__init__(
            "Quiver circuit breaker is open — too many recent upstream failures"
        )


async def _record_quiver_failure() -> None:
    count = await increment_cache(CIRCUIT_BREAKER_KEY, CIRCUIT_BREAKER_WINDOW_SECONDS)
    if count is not None and count > CIRCUIT_BREAKER_THRESHOLD:
        logger.error(
            "circuit breaker tripped: %s failures in %ss",
            count,
            CIRCUIT_BREAKER_WINDOW_SECONDS,
        )


async def _is_circuit_open() -> bool:
    count = await get_cache(CIRCUIT_BREAKER_KEY)
    return isinstance(count, (int, float)) and count > CIRCUIT_BREAKER_THRESHOLD


async def fetch_quiver_with_retry(url: str, headers: dict[str, str]):
    if await _is_circuit_open():
        raise QuiverCircuitOpenError()

    last_error: Exception | None = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await shared_client().get(url, headers=headers)

            if response.status_code < 400:
                return response

            # Retry only on rate-limiting / transient server errors.
            if response.status_code == 429 or response.status_code >= 500:
                await _record_quiver_failure()
                last_error = RuntimeError(f"Quiver responded {response.status_code}")
                logger.warning(
                    "%s on %s (attempt %s/%s)",
                    response.status_code,
                    url,
                    attempt + 1,
                    MAX_RETRIES + 1,
                )
            else:
                return response
        except Exception as error:
            await _record_quiver_failure()
            last_error = error
            logger.warning(
                "network error on %s (attempt %s/%s): %s",
                url,
                attempt + 1,
                MAX_RETRIES + 1,
                error,
            )

        if attempt < MAX_RETRIES:
            base = RETRY_BASE_DELAYS_MS[attempt]
            await asyncio.sleep((base + random.randint(0, 249)) / 1000)

    raise last_error or RuntimeError("Quiver request failed after retries")


def trade_to_db_row(trade: dict) -> dict | None:
    trade_id = js_str(trade["UniqueID"]) if trade.get("UniqueID") is not None else None
    if not trade_id or not trade.get("Bioguide"):
        return None

    raw_size = trade.get("Trade_Size_USD")
    size: float | None = None
    if isinstance(raw_size, (int, float)):
        size = float(raw_size)
    elif raw_size not in (None, ""):
        try:
            size = float(raw_size)
        except (TypeError, ValueError):
            size = None

    return {
        "trade_id": trade_id,
        "bioguide_id": trade["Bioguide"],
        "member_name": trade.get("Representative"),
        "party": trade.get("Party"),
        "chamber": trade.get("Chamber"),
        "ticker": trade.get("Ticker"),
        "asset_name": trade.get("AssetDescription"),
        "asset_type": trade.get("AssetType"),
        "transaction_type": trade.get("Transaction"),
        "transaction_date": trade.get("Date"),
        "traded": trade.get("Traded"),
        "range_text": trade.get("Range"),
        "trade_size_usd": size,
        "filed_at": trade.get("ReportDate"),
    }


def db_row_to_trade(row: dict) -> dict:
    return {
        "Bioguide": row.get("bioguide_id"),
        "Ticker": row.get("ticker"),
        "Transaction": row.get("transaction_type"),
        "Range": row.get("range_text"),
        "ReportDate": row.get("filed_at"),
        "Representative": row.get("member_name"),
        "Party": row.get("party"),
        "Chamber": row.get("chamber"),
        "UniqueID": row.get("trade_id"),
        "AssetDescription": row.get("asset_name"),
        "AssetType": row.get("asset_type"),
        "Date": row.get("transaction_date"),
        "Traded": row.get("traded"),
        "Trade_Size_USD": row.get("trade_size_usd"),
    }


def js_str(value) -> str:
    """Stringify like JS String(): integral floats have no decimal point, so
    synthetic ids match the ones the TS backend already persisted."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _synthetic_trade_id(raw: dict) -> str:
    return "|".join(
        js_str(raw.get(key))
        for key in (
            "BioGuideID",
            "TransactionDate",
            "Ticker",
            "Transaction",
            "Amount",
            "ReportDate",
        )
    )


def _normalize_quiver_trade(raw: dict) -> dict:
    return {
        "UniqueID": _synthetic_trade_id(raw),
        "Bioguide": raw.get("BioGuideID"),
        "Representative": raw.get("Representative"),
        "Party": raw.get("Party"),
        "Chamber": raw.get("House"),
        "Ticker": raw.get("Ticker"),
        "AssetDescription": raw.get("Description"),
        "AssetType": raw.get("TickerType"),
        "Transaction": raw.get("Transaction"),
        "Date": raw.get("TransactionDate"),
        "Range": raw.get("Range"),
        "Trade_Size_USD": raw.get("Amount"),
        "ReportDate": raw.get("ReportDate"),
    }


async def fetch_all_congress_trades(
    api_key: str, force_refresh: bool = False
) -> list[dict]:
    if not force_refresh:
        cached = await get_cache(CONGRESS_TRADES_KEY)
        if cached:
            return cached
        stored = await get_recent_trades_from_db()
        if stored:
            trades = [db_row_to_trade(row) for row in stored]
            await set_cache(CONGRESS_TRADES_KEY, trades, CONGRESS_TRADES_TTL_SECONDS)
            return trades

    response = await fetch_quiver_with_retry(
        "https://api.quiverquant.com/beta/live/congresstrading",
        {**QUIVER_API_HEADERS, "Authorization": f"Bearer {api_key}"},
    )

    if response.status_code >= 400:
        raise RuntimeError(
            f"Quiver API error {response.status_code}: {response.text[:200]}"
        )

    data = response.json()
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Quiver response format")

    normalized = [_normalize_quiver_trade(raw) for raw in data]
    trades = list({t["UniqueID"]: t for t in normalized}.values())

    await set_cache(CONGRESS_TRADES_KEY, trades, CONGRESS_TRADES_TTL_SECONDS)

    if not force_refresh:
        rows = [row for row in (trade_to_db_row(t) for t in trades) if row is not None]
        write_back(upsert_trades(rows))

    return trades


def _normalize_bulk_trade(raw: dict) -> dict:
    # Reuse the live-feed id logic so the same disclosure dedupes across feeds.
    trade_id = _synthetic_trade_id(
        {
            "BioGuideID": raw.get("BioGuideID"),
            "TransactionDate": raw.get("Traded"),
            "Ticker": raw.get("Ticker"),
            "Transaction": raw.get("Transaction"),
            "Amount": raw.get("Trade_Size_USD"),
            "ReportDate": raw.get("Filed"),
        }
    )
    description = raw.get("Description")
    if description is None:
        description = raw.get("Company")
    return {
        "UniqueID": trade_id,
        "Bioguide": raw.get("BioGuideID"),
        "Representative": raw.get("Name"),
        "Party": raw.get("Party"),
        "Chamber": raw.get("Chamber"),
        "Ticker": raw.get("Ticker"),
        "AssetDescription": description,
        "AssetType": raw.get("TickerType"),
        "Transaction": raw.get("Transaction"),
        "Date": raw.get("Traded"),
        "Traded": raw.get("Traded"),
        "Range": None,
        "Trade_Size_USD": raw.get("Trade_Size_USD"),
        "ReportDate": raw.get("Filed"),
    }


BULK_PAGE_SIZE = 1000
BULK_MAX_PAGES = 200


async def _fetch_bulk_page(api_key: str, page: int) -> list[dict] | None:
    url = (
        "https://api.quiverquant.com/beta/bulk/congresstrading"
        f"?page={page}&page_size={BULK_PAGE_SIZE}"
    )
    for attempt in range(MAX_RETRIES + 1):
        response = await shared_client().get(
            url, headers={**QUIVER_API_HEADERS, "Authorization": f"Bearer {api_key}"}
        )
        if response.status_code < 400:
            data = response.json()
            return data if isinstance(data, list) else None
        transient = response.status_code == 429 or response.status_code >= 500
        if transient and attempt < MAX_RETRIES:
            logger.warning(
                "bulk page %s -> %s, retry %s", page, response.status_code, attempt + 1
            )
            await asyncio.sleep(
                (RETRY_BASE_DELAYS_MS[attempt] + random.randint(0, 249)) / 1000
            )
            continue
        return None
    return None


async def fetch_bulk_congress_trades(api_key: str) -> list[dict]:
    all_trades: list[dict] = []
    for page in range(1, BULK_MAX_PAGES + 1):
        data = await _fetch_bulk_page(api_key, page)
        if not data:
            break
        all_trades.extend(_normalize_bulk_trade(raw) for raw in data)
        if len(data) < BULK_PAGE_SIZE:
            break
    return list({t["UniqueID"]: t for t in all_trades}.values())


async def fetch_member_congress_trades(bioguide_id: str, api_key: str) -> list[dict]:
    rows = await get_trades_by_bioguide(bioguide_id)
    if rows:
        return [db_row_to_trade(row) for row in rows]
    all_trades = await fetch_all_congress_trades(api_key)
    return [t for t in all_trades if t.get("Bioguide") == bioguide_id]


def classify_transaction(value: str | None) -> str:
    v = (value or "").lower()
    if "purchase" in v or "buy" in v:
        return "buy"
    if "sale" in v or "sell" in v or "sold" in v:
        return "sell"
    return "other"


def _trade_time(trade: dict) -> float | None:
    return parse_ms(trade.get("Date"))


def find_matching_sale(all_trades: list[dict], purchase: dict) -> dict | None:
    bought_at = _trade_time(purchase)
    if bought_at is None:
        return None

    candidates = [
        t
        for t in all_trades
        if t.get("Bioguide") == purchase.get("Bioguide")
        and t.get("Ticker") == purchase.get("Ticker")
        and classify_transaction(t.get("Transaction")) == "sell"
        and _trade_time(t) is not None
        and _trade_time(t) >= bought_at
    ]
    candidates.sort(key=_trade_time)
    return candidates[0] if candidates else None


def find_matching_purchase(all_trades: list[dict], sale: dict) -> dict | None:
    sold_at = _trade_time(sale)
    if sold_at is None:
        return None

    candidates = [
        t
        for t in all_trades
        if t.get("Bioguide") == sale.get("Bioguide")
        and t.get("Ticker") == sale.get("Ticker")
        and classify_transaction(t.get("Transaction")) == "buy"
        and _trade_time(t) is not None
        and _trade_time(t) <= sold_at
    ]
    candidates.sort(key=_trade_time, reverse=True)
    return candidates[0] if candidates else None


def parse_trade_range(range_text: str | None) -> dict | None:
    if not range_text:
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", range_text.replace(",", ""))
    if not nums:
        return None
    low = float(nums[0])
    high = float(nums[1]) if len(nums) > 1 else low
    return {"low": low, "high": high}


def format_trade_range(lower_bound: float) -> str:
    ranges = [
        (1, 1000),
        (1001, 15000),
        (15001, 50000),
        (50001, 100000),
        (100001, 250000),
        (250001, 500000),
        (500001, 1000000),
        (1000001, 5000000),
        (5000001, 25000000),
        (25000001, 50000000),
    ]

    for minimum, maximum in ranges:
        if lower_bound == minimum:
            return f"${minimum:,} – ${maximum:,}"

    if lower_bound >= 50000001:
        return f"${lower_bound:,.0f}+"
    return f"${lower_bound:,.0f}"
