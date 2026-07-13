"""Net-worth / stock-holdings rankings (port of lib/rankings.ts).

Ranking rows are member dicts extended with `netWorth` and `stockHoldings`;
payloads are {"byNetWorth", "byStockHoldings", "generatedAt"} — identical keys
to the TS code so Redis cache entries stay interchangeable.
"""

import asyncio
import json
import logging
import math

from ..clients.congress import fetch_house_members, fetch_senate_members
from ..clients.quiver import QuiverCircuitOpenError, fetch_quiver_with_retry
from ..config import require_congress_api_key
from ..core.cache import get_cache, set_cache
from ..core.db import get_portfolios_from_db, upsert_portfolios, write_back
from ..core.util import map_with_concurrency, now_iso, single_flight
from .disclosures import get_disclosure_net_worth
from .stock_leaderboard import persist_holdings

logger = logging.getLogger("rankings")

HOUSE_RANKINGS_KEY = "house-rankings"
SENATE_RANKINGS_KEY = "senate-rankings"
RANKINGS_TTL_SECONDS = 2 * 60 * 60
FANOUT_CONCURRENCY = 1
FANOUT_DELAY_MS = 1500
CIRCUIT_OPEN_PAUSE_SECONDS = 65
MAX_CIRCUIT_WAITS = 3

QUIVER_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "CongressMoneyMan/1.0",
    "X-Requested-With": "XMLHttpRequest",
}


def _is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _parse_json_array(value: str | None) -> list:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _get_live_net_worth(payload: dict) -> float | None:
    values = _parse_json_array(
        (payload.get("holdings_data") or {}).get("politician_net_worth_live")
    )
    value = values[0] if values else None
    return value if _is_finite_number(value) else None


def _get_live_stock_holdings(payload: dict) -> float | None:
    positions = _parse_json_array(
        (payload.get("live_stock_portfolio") or {}).get("live_stock_portfolio")
    )
    total = 0.0
    found_position = False
    for position in positions:
        if not isinstance(position, list) or len(position) < 2:
            continue
        value = position[1]
        if not _is_finite_number(value):
            continue
        total += value
        found_position = True
    return total if found_position else None


def _get_live_positions(payload: dict) -> list[dict]:
    positions = _parse_json_array(
        (payload.get("live_stock_portfolio") or {}).get("live_stock_portfolio")
    )
    out: list[dict] = []
    for position in positions:
        if not isinstance(position, list) or len(position) < 2:
            continue
        value = position[1]
        if not _is_finite_number(value) or value <= 0:
            continue
        symbol = position[0].strip().upper() if isinstance(position[0], str) else ""
        if not symbol:
            continue
        out.append({"ticker": symbol, "value": value})
    return out


def _ranking_sort_key(field: str):
    def key(row: dict):
        value = row.get(field)
        return (value is None, -(value or 0), row["name"])

    return key


async def _get_ranking_row(member: dict) -> dict:
    waits = 0
    while True:
        try:
            response = await fetch_quiver_with_retry(
                f"https://www.quiverquant.com/get_politician_page_tab_data/{member['id']}",
                QUIVER_HEADERS,
            )

            if response.status_code >= 400:
                logger.warning(
                    "%s tab-data HTTP %s", member["id"], response.status_code
                )
                return {
                    **member,
                    "netWorth": None,
                    "stockHoldings": None,
                    "positions": [],
                    "ok": False,
                }

            payload = response.json()
            return {
                **member,
                "netWorth": _get_live_net_worth(payload),
                "stockHoldings": _get_live_stock_holdings(payload),
                "positions": _get_live_positions(payload),
                "ok": True,
            }
        except QuiverCircuitOpenError:
            if waits < MAX_CIRCUIT_WAITS:
                waits += 1
                logger.warning(
                    "circuit open — pausing %ss before retrying %s",
                    CIRCUIT_OPEN_PAUSE_SECONDS,
                    member["id"],
                )
                await asyncio.sleep(CIRCUIT_OPEN_PAUSE_SECONDS)
                continue
            logger.warning("%s fan-out failed: circuit open", member["id"])
            return {
                **member,
                "netWorth": None,
                "stockHoldings": None,
                "positions": [],
                "ok": False,
            }
        except Exception as error:
            logger.warning("%s fan-out failed: %s", member["id"], error)
            return {
                **member,
                "netWorth": None,
                "stockHoldings": None,
                "positions": [],
                "ok": False,
            }


def _strip_fanout_extras(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in ("positions", "ok")}


def _build_payload(rows: list[dict]) -> dict:
    return {
        "byNetWorth": sorted(rows, key=_ranking_sort_key("netWorth")),
        "byStockHoldings": sorted(rows, key=_ranking_sort_key("stockHoldings")),
        "generatedAt": now_iso(),
    }


async def _apply_disclosure_fallback(payload: dict) -> dict:
    """Fill net-worth gaps from annual financial-disclosure estimates.

    Quiver's live figure stays authoritative — the FD estimate only fills rows
    where Quiver has none. Filled rows carry `netWorthSource: "fd"` and an
    `netWorthAsOf` year so the UI can flag them as annual-disclosure estimates
    rather than live figures. Members with a live figure get
    `netWorthSource: "quiver"`. Stock holdings are untouched: an FD lists assets
    in coarse ranges without live market values, so it can't produce the
    per-ticker live portfolio the holdings column shows."""
    fd_map = await get_disclosure_net_worth()
    if not fd_map:
        return payload

    rows = payload["byNetWorth"]
    filled = 0
    updated: list[dict] = []
    for row in rows:
        if row.get("netWorth") is not None:
            updated.append({**row, "netWorthSource": "quiver"})
            continue
        estimate = fd_map.get(row["id"])
        if not estimate:
            updated.append(row)
            continue
        filled += 1
        updated.append(
            {
                **row,
                "netWorth": estimate["netWorth"],
                "netWorthSource": "fd",
                "netWorthAsOf": estimate.get("asOf"),
            }
        )

    if filled == 0:
        return _build_payload(updated)

    logger.info("disclosure fallback filled %s net-worth gaps", filled)
    return _build_payload(updated)


def _count_populated(rows: list[dict]) -> int:
    return sum(
        1
        for row in rows
        if row.get("netWorth") is not None or row.get("stockHoldings") is not None
    )


def _members_to_empty_payload(members: list[dict]) -> dict:
    return _build_payload(
        [{**member, "netWorth": None, "stockHoldings": None} for member in members]
    )


def _merge_with_previous(fresh: dict, previous: dict | None) -> dict:
    if not previous:
        return fresh

    previous_by_id = {row["id"]: row for row in previous["byNetWorth"]}
    merged_rows = []
    for row in fresh["byNetWorth"]:
        prior = previous_by_id.get(row["id"])
        if not prior:
            merged_rows.append(row)
            continue
        merged_rows.append(
            {
                **row,
                "netWorth": row["netWorth"] if row["netWorth"] is not None else prior.get("netWorth"),
                "stockHoldings": row["stockHoldings"]
                if row["stockHoldings"] is not None
                else prior.get("stockHoldings"),
            }
        )

    return _build_payload(merged_rows)


async def _persist_rankings(key: str, fresh: dict) -> dict:
    previous = await get_cache(key)
    merged = _merge_with_previous(fresh, previous)

    await set_cache(key, merged, RANKINGS_TTL_SECONDS)
    logger.info(
        "cached %s: %s/%s members populated",
        key,
        _count_populated(merged["byNetWorth"]),
        len(merged["byNetWorth"]),
    )
    portfolio_rows = [
        {
            "bioguide_id": row["id"],
            "net_worth": row["netWorth"],
            "stock_holdings": row["stockHoldings"],
        }
        for row in merged["byNetWorth"]
        if row.get("netWorth") is not None or row.get("stockHoldings") is not None
    ]
    write_back(upsert_portfolios(portfolio_rows))

    return merged


async def _rankings_from_db(members: list[dict]) -> dict | None:
    portfolios = await get_portfolios_from_db()
    if not portfolios:
        return None

    by_id = {p["bioguide_id"]: p for p in portfolios}
    rows = []
    for member in members:
        portfolio = by_id.get(member["id"]) or {}
        rows.append(
            {
                **member,
                "netWorth": portfolio.get("net_worth"),
                "stockHoldings": portfolio.get("stock_holdings"),
            }
        )
    return _build_payload(rows)


async def compute_house_rankings(api_key: str | None = None) -> dict:
    api_key = api_key or require_congress_api_key()
    members = await fetch_house_members(api_key)
    rows = await map_with_concurrency(
        members, FANOUT_CONCURRENCY, _get_ranking_row, FANOUT_DELAY_MS
    )
    return _build_payload([_strip_fanout_extras(row) for row in rows])


async def compute_senate_rankings(api_key: str | None = None) -> dict:
    api_key = api_key or require_congress_api_key()
    members = await fetch_senate_members(api_key)
    rows = await map_with_concurrency(
        members, FANOUT_CONCURRENCY, _get_ranking_row, FANOUT_DELAY_MS
    )
    return _build_payload([_strip_fanout_extras(row) for row in rows])


async def refresh_house_rankings(api_key: str | None = None) -> dict:
    api_key = api_key or require_congress_api_key()

    async def run() -> dict:
        return await _persist_rankings(
            HOUSE_RANKINGS_KEY, await compute_house_rankings(api_key)
        )

    return await single_flight(HOUSE_RANKINGS_KEY, run)


async def refresh_senate_rankings(api_key: str | None = None) -> dict:
    api_key = api_key or require_congress_api_key()

    async def run() -> dict:
        return await _persist_rankings(
            SENATE_RANKINGS_KEY, await compute_senate_rankings(api_key)
        )

    return await single_flight(SENATE_RANKINGS_KEY, run)


def _interleave(house: list[dict], senate: list[dict]) -> list[dict]:
    out: list[dict] = []
    for i in range(max(len(house), len(senate))):
        if i < len(house):
            out.append({"chamber": "house", "member": house[i]})
        if i < len(senate):
            out.append({"chamber": "senate", "member": senate[i]})
    return out


async def refresh_all_rankings(api_key: str | None = None) -> dict:
    api_key = api_key or require_congress_api_key()

    async def run() -> dict:
        house_members, senate_members = await asyncio.gather(
            fetch_house_members(api_key), fetch_senate_members(api_key)
        )

        async def fan_out(tagged: dict) -> dict:
            return {
                "chamber": tagged["chamber"],
                "row": await _get_ranking_row(tagged["member"]),
            }

        results = await map_with_concurrency(
            _interleave(house_members, senate_members),
            FANOUT_CONCURRENCY,
            fan_out,
            FANOUT_DELAY_MS,
        )

        house_rows = [r["row"] for r in results if r["chamber"] == "house"]
        senate_rows = [r["row"] for r in results if r["chamber"] == "senate"]

        member_holdings = [
            {
                "bioguideId": row["id"],
                "memberName": row["name"],
                "party": row["party"],
                "chamber": chamber,
                "positions": row["positions"],
            }
            for rows, chamber in ((house_rows, "house"), (senate_rows, "senate"))
            for row in rows
            if row["ok"]
        ]
        write_back(persist_holdings(member_holdings))

        house, senate = await asyncio.gather(
            _persist_rankings(
                HOUSE_RANKINGS_KEY,
                _build_payload([_strip_fanout_extras(r) for r in house_rows]),
            ),
            _persist_rankings(
                SENATE_RANKINGS_KEY,
                _build_payload([_strip_fanout_extras(r) for r in senate_rows]),
            ),
        )
        return {"house": house, "senate": senate}

    return await single_flight("all-rankings", run)


async def get_house_rankings() -> dict:
    cached = await get_cache(HOUSE_RANKINGS_KEY)
    if cached and _count_populated(cached["byNetWorth"]) > 0:
        return await _apply_disclosure_fallback(cached)
    members = await fetch_house_members(require_congress_api_key())
    from_db = await _rankings_from_db(members)
    if from_db and _count_populated(from_db["byNetWorth"]) > 0:
        await set_cache(HOUSE_RANKINGS_KEY, from_db, RANKINGS_TTL_SECONDS)
        return await _apply_disclosure_fallback(from_db)
    return await _apply_disclosure_fallback(_members_to_empty_payload(members))


async def get_senate_rankings() -> dict:
    cached = await get_cache(SENATE_RANKINGS_KEY)
    if cached and _count_populated(cached["byNetWorth"]) > 0:
        return await _apply_disclosure_fallback(cached)

    members = await fetch_senate_members(require_congress_api_key())

    from_db = await _rankings_from_db(members)
    if from_db and _count_populated(from_db["byNetWorth"]) > 0:
        await set_cache(SENATE_RANKINGS_KEY, from_db, RANKINGS_TTL_SECONDS)
        return await _apply_disclosure_fallback(from_db)
    return await _apply_disclosure_fallback(_members_to_empty_payload(members))
