"""Supabase (PostgREST) data access.

Port of lib/db.ts. Rows are plain dicts using the DB column names (snake_case),
identical to the TS Db* types. Every function degrades gracefully — a missing
Supabase config or a failed request logs and returns empty data, never raises.
"""

import asyncio
import logging
import os
from typing import Any

from .http import shared_client
from .util import chunk, now_iso

logger = logging.getLogger("db")

_PAGE_SIZE = 1000

# Keep strong references to fire-and-forget tasks so they aren't GC'd mid-flight.
_write_back_tasks: set[asyncio.Task] = set()


def write_back(coro) -> None:
    """Persist to the DB in the background without blocking the response."""

    async def run() -> None:
        try:
            await coro
        except Exception as error:
            logger.error("write-back failed: %s", error)

    task = asyncio.ensure_future(run())
    _write_back_tasks.add(task)
    task.add_done_callback(_write_back_tasks.discard)


def _credentials() -> tuple[str, str] | None:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    return url.rstrip("/") + "/rest/v1", key


async def _request(
    method: str,
    table: str,
    *,
    params: dict[str, str] | None = None,
    json_body: Any = None,
    prefer: str | None = None,
) -> tuple[Any, str | None]:
    """Returns (data, error_message); error_message is None on success."""
    credentials = _credentials()
    if credentials is None:
        return None, "Supabase not configured"
    base, key = credentials

    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if prefer:
        headers["Prefer"] = prefer

    response = await shared_client().request(
        method,
        f"{base}/{table}",
        params=params,
        json=json_body,
        headers=headers,
    )
    if response.status_code >= 400:
        return None, f"{response.status_code}: {response.text[:200]}"
    if response.status_code == 204 or not response.content:
        return None, None
    return response.json(), None


async def _select(table: str, params: dict[str, str], label: str) -> list[dict]:
    try:
        data, error = await _request("GET", table, params=params)
        if error:
            logger.error("%s: %s", label, error)
            return []
        return data or []
    except Exception as error:
        logger.error("%s threw: %s", label, error)
        return []


async def _select_all_pages(table: str, params: dict[str, str], label: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        page = await _select(
            table,
            {**params, "limit": str(_PAGE_SIZE), "offset": str(offset)},
            label,
        )
        rows.extend(page)
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
    return rows


# --- members ---------------------------------------------------------------


async def get_members_from_db(chamber: str) -> list[dict]:
    return await _select(
        "members",
        {"select": "*", "chamber": f"eq.{chamber}"},
        f"get_members_from_db({chamber})",
    )


async def upsert_members(rows: list[dict]) -> None:
    if not rows:
        return
    stamped = [{**row, "last_updated": now_iso()} for row in rows]
    try:
        _, error = await _request(
            "POST",
            "members",
            params={"on_conflict": "bioguide_id"},
            json_body=stamped,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        if error:
            logger.error("upsert_members: %s", error)
            return

        current_ids = {row["bioguide_id"] for row in rows}
        existing = await _select(
            "members", {"select": "bioguide_id"}, "upsert_members prune select"
        )
        stale = [
            row["bioguide_id"]
            for row in existing
            if row["bioguide_id"] not in current_ids
        ]
        if stale:
            _, del_error = await _request(
                "DELETE",
                "members",
                params={"bioguide_id": f"in.({','.join(stale)})"},
            )
            if del_error:
                logger.error("upsert_members prune delete: %s", del_error)
    except Exception as error:
        logger.error("upsert_members threw: %s", error)


# --- trades ----------------------------------------------------------------


async def get_recent_trades_from_db(limit: int = 1000) -> list[dict]:
    return await _select(
        "trades",
        {"select": "*", "order": "filed_at.desc.nullslast", "limit": str(limit)},
        "get_recent_trades_from_db",
    )


async def get_trades_by_bioguide(bioguide_id: str) -> list[dict]:
    return await _select_all_pages(
        "trades",
        {"select": "*", "bioguide_id": f"eq.{bioguide_id}"},
        f"get_trades_by_bioguide({bioguide_id})",
    )


async def upsert_trades(rows: list[dict]) -> None:
    if not rows:
        return
    deduped = list({row["trade_id"]: row for row in rows}.values())
    try:
        # Chunk so a large live feed stays under the request payload limit.
        for batch in chunk(deduped, 500):
            _, error = await _request(
                "POST",
                "trades",
                params={"on_conflict": "trade_id"},
                json_body=batch,
                prefer="resolution=merge-duplicates,return=minimal",
            )
            if error:
                logger.error("upsert_trades: %s", error)
                return
    except Exception as error:
        logger.error("upsert_trades threw: %s", error)


async def get_all_trades() -> list[dict]:
    return await _select_all_pages("trades", {"select": "*"}, "get_all_trades")


# --- portfolios ------------------------------------------------------------


async def get_portfolios_from_db() -> list[dict]:
    return await _select("portfolio_data", {"select": "*"}, "get_portfolios_from_db")


async def upsert_portfolios(rows: list[dict]) -> None:
    if not rows:
        return
    stamped = [{**row, "fetched_at": now_iso()} for row in rows]
    try:
        _, error = await _request(
            "POST",
            "portfolio_data",
            params={"on_conflict": "bioguide_id"},
            json_body=stamped,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        if error:
            logger.error("upsert_portfolios: %s", error)
    except Exception as error:
        logger.error("upsert_portfolios threw: %s", error)


# --- holdings ----------------------------------------------------------------


async def get_holdings_from_db() -> list[dict]:
    return await _select_all_pages(
        "portfolio_holdings", {"select": "*"}, "get_holdings_from_db"
    )


async def get_holdings_by_ticker(ticker: str) -> list[dict]:
    return await _select(
        "portfolio_holdings",
        {"select": "*", "ticker": f"eq.{ticker}"},
        f"get_holdings_by_ticker({ticker})",
    )


async def replace_holdings_for_members(
    member_ids: list[str], rows: list[dict]
) -> None:
    if not member_ids:
        return
    deduped = {f"{row['bioguide_id']}|{row['ticker']}": row for row in rows}
    stamped = [{**row, "fetched_at": now_iso()} for row in deduped.values()]
    try:
        for id_batch in chunk(member_ids, 200):
            _, error = await _request(
                "DELETE",
                "portfolio_holdings",
                params={"bioguide_id": f"in.({','.join(id_batch)})"},
            )
            if error:
                logger.error("replace_holdings_for_members delete: %s", error)
                return
        for batch in chunk(stamped, 500):
            _, error = await _request(
                "POST",
                "portfolio_holdings",
                json_body=batch,
                prefer="return=minimal",
            )
            if error:
                logger.error("replace_holdings_for_members insert: %s", error)
                return
    except Exception as error:
        logger.error("replace_holdings_for_members threw: %s", error)


# --- FEC candidates ----------------------------------------------------------


async def get_fec_candidate_from_db(bioguide_id: str) -> dict | None:
    rows = await _select(
        "fec_candidates",
        {"select": "*", "bioguide_id": f"eq.{bioguide_id}"},
        f"get_fec_candidate_from_db({bioguide_id})",
    )
    return rows[0] if rows else None


async def get_all_fec_candidates() -> list[dict]:
    return await _select_all_pages(
        "fec_candidates", {"select": "*"}, "get_all_fec_candidates"
    )


async def upsert_fec_candidate(row: dict) -> None:
    stamped = {**row, "fetched_at": now_iso()}
    try:
        _, error = await _request(
            "POST",
            "fec_candidates",
            params={"on_conflict": "bioguide_id"},
            json_body=stamped,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        if error:
            logger.error("upsert_fec_candidate: %s", error)
    except Exception as error:
        logger.error("upsert_fec_candidate threw: %s", error)


# --- PAC donations -----------------------------------------------------------


async def get_pac_donations_from_db(bioguide_id: str) -> list[dict]:
    return await _select(
        "pac_donations",
        {"select": "*", "bioguide_id": f"eq.{bioguide_id}"},
        f"get_pac_donations_from_db({bioguide_id})",
    )


async def get_top_pac_donations(limit: int = 1000) -> list[dict]:
    return await _select(
        "pac_donations",
        {"select": "*", "order": "amount.desc", "limit": str(limit)},
        "get_top_pac_donations",
    )


async def get_pac_donations_by_name(pac_name: str) -> list[dict]:
    return await _select_all_pages(
        "pac_donations",
        {"select": "*", "pac_name": f"eq.{pac_name}"},
        f"get_pac_donations_by_name({pac_name})",
    )


async def replace_pac_donations(bioguide_id: str, rows: list[dict]) -> None:
    try:
        _, del_error = await _request(
            "DELETE",
            "pac_donations",
            params={"bioguide_id": f"eq.{bioguide_id}"},
        )
        if del_error:
            logger.error("replace_pac_donations delete(%s): %s", bioguide_id, del_error)
            return
        if not rows:
            return
        _, ins_error = await _request(
            "POST", "pac_donations", json_body=rows, prefer="return=minimal"
        )
        if ins_error:
            logger.error("replace_pac_donations insert(%s): %s", bioguide_id, ins_error)
    except Exception as error:
        logger.error("replace_pac_donations(%s) threw: %s", bioguide_id, error)
