"""Scheduled ETL jobs (port of lib/sync.ts)."""

import asyncio
import logging

from ..clients.congress import fetch_house_members, fetch_senate_members, get_state_code
from ..clients.fec import fetch_fec_totals, fetch_pac_donations
from ..clients.quiver import (
    fetch_all_congress_trades,
    fetch_bulk_congress_trades,
    trade_to_db_row,
)
from ..config import fec_api_key, quiver_api_key, require_congress_api_key
from ..core.db import (
    replace_pac_donations,
    upsert_fec_candidate,
    upsert_members,
    upsert_trades,
)
from ..core.util import build_bioguide_by_name, map_with_concurrency, name_token_key
from .disclosures import refresh_disclosure_net_worth
from .profile import aggregate_donors, current_cycle, resolve_fec_candidate
from .rankings import refresh_all_rankings
from .entity_cards import refresh_entity_cards
from .stock_leaderboard import refresh_stock_performance
from .trade_features import refresh_trade_features

logger = logging.getLogger("sync")


def _last_name(list_name: str) -> str:
    return list_name.split(",")[0].strip() or list_name


def _attach_missing_bioguides(trades: list[dict], by_name: dict[str, str]) -> int:
    resolved = 0
    for trade in trades:
        if trade.get("Bioguide") or not trade.get("Representative"):
            continue
        bioguide_id = by_name.get(name_token_key(trade["Representative"]))
        if bioguide_id:
            trade["Bioguide"] = bioguide_id
            resolved += 1
    return resolved


async def _resolve_missing_bioguides(trades: list[dict]) -> int:
    """Quiver's congress feed only carries a BioGuideID for House members, so
    every Senate disclosure arrives without one and trade_to_db_row drops it.
    Backfill the id from the synced roster by name so Senate trades persist too.
    Degrades to a no-op if the roster can't be loaded."""
    if not any(not t.get("Bioguide") and t.get("Representative") for t in trades):
        return 0
    try:
        api_key = require_congress_api_key()
        house, senate = await asyncio.gather(
            fetch_house_members(api_key), fetch_senate_members(api_key)
        )
        return _attach_missing_bioguides(
            trades, build_bioguide_by_name([*house, *senate])
        )
    except Exception as error:
        logger.warning("bioguide name-resolution skipped: %s", error)
        return 0


async def sync_members() -> dict:
    """Snapshot the current House + Senate rosters into `members`."""
    api_key = require_congress_api_key()
    house, senate = await asyncio.gather(
        fetch_house_members(api_key), fetch_senate_members(api_key)
    )

    rows = [
        *(
            {
                "bioguide_id": m["id"],
                "name": m["name"],
                "party": m["party"],
                "state": m["state"],
                "district": m["district"],
                "chamber": "house",
                "image_url": m.get("imageUrl"),
            }
            for m in house
        ),
        *(
            {
                "bioguide_id": m["id"],
                "name": m["name"],
                "party": m["party"],
                "state": m["state"],
                "district": None,
                "chamber": "senate",
                "image_url": m.get("imageUrl"),
            }
            for m in senate
        ),
    ]

    await upsert_members(rows)
    return {"house": len(house), "senate": len(senate)}


async def sync_trades() -> dict:
    api_key = quiver_api_key()
    if not api_key:
        raise RuntimeError("Missing QUIVER_API_KEY")

    trades = await fetch_all_congress_trades(api_key, force_refresh=True)
    resolved = await _resolve_missing_bioguides(trades)
    rows = [row for row in (trade_to_db_row(t) for t in trades) if row is not None]

    await upsert_trades(rows)
    logger.info("sync_trades: resolved %s trade(s) to a bioguide by name", resolved)
    return {"fetched": len(trades), "persisted": len(rows)}


async def backfill_trades() -> dict:
    api_key = quiver_api_key()
    if not api_key:
        raise RuntimeError("Missing QUIVER_API_KEY")

    trades = await fetch_bulk_congress_trades(api_key)
    resolved = await _resolve_missing_bioguides(trades)
    rows = [row for row in (trade_to_db_row(t) for t in trades) if row is not None]

    await upsert_trades(rows)
    logger.info("backfill_trades: resolved %s trade(s) to a bioguide by name", resolved)
    return {"fetched": len(trades), "persisted": len(rows)}


async def sync_rankings() -> dict:
    api_key = require_congress_api_key()
    result = await refresh_all_rankings(api_key)
    return {
        "house": len(result["house"]["byNetWorth"]),
        "senate": len(result["senate"]["byNetWorth"]),
    }


async def sync_stock_performance() -> dict:
    """Best-performing-stocks leaderboard (Congress P/L on disclosed buys).
    Reads the persisted trades + price history, so it has no Quiver fan-out of
    its own and runs on a slow cadence. The holdings leaderboard has no job
    here — it is filled as a side effect of refresh_all_rankings."""
    rows = await refresh_stock_performance()
    return {"stocks": len(rows)}


async def sync_trade_features() -> dict:
    """Rebuild the RAG feature layer (trade_features + asset_class_stats) from
    the persisted trades, then refresh the semantic entity cards built on top
    of it. Reads the DB plus price history for the priced universe, so it has
    no Quiver fan-out and runs daily."""
    features = await refresh_trade_features()
    cards = await refresh_entity_cards()
    return {**features, **cards}


async def sync_disclosures() -> dict:
    """Rebuild the annual financial-disclosure net-worth estimates that fill
    the rankings' net-worth gaps for members Quiver has no live figure for.
    Downloads/parses ~500 filings, so it runs on a weekly cadence — annual
    filings barely change between runs."""
    estimates = await refresh_disclosure_net_worth()
    return {"members": len(estimates)}


FEC_CONCURRENCY = 4
FEC_DELAY_MS = 150


async def sync_fec() -> dict:
    api_key = require_congress_api_key()
    fec_key = fec_api_key()
    if not fec_key:
        raise RuntimeError("Missing FEC_API_KEY")

    house, senate = await asyncio.gather(
        fetch_house_members(api_key), fetch_senate_members(api_key)
    )

    targets = [
        *(
            {
                "id": m["id"],
                "name": _last_name(m["name"]),
                "state": m["state"],
                "office": "H",
                "preferIncumbent": False,
                "perPage": 10,
            }
            for m in house
        ),
        *(
            {
                "id": m["id"],
                "name": _last_name(m["name"]),
                "state": m["state"],
                "office": "S",
                "preferIncumbent": True,
                "perPage": 20,
            }
            for m in senate
        ),
    ]

    cycle = current_cycle()
    resolved = 0

    async def process(target: dict) -> None:
        nonlocal resolved
        ref = await resolve_fec_candidate(
            name=target["name"],
            state_code=get_state_code(target["state"]),
            office=target["office"],
            prefer_incumbent=target["preferIncumbent"],
            per_page=target["perPage"],
        )
        if not ref:
            return
        resolved += 1

        totals = await fetch_fec_totals(ref["candidateId"], fec_key)
        await upsert_fec_candidate(
            {
                "bioguide_id": target["id"],
                "candidate_id": ref["candidateId"],
                "committee_ids": ref["committeeIds"],
                "total_raised": (totals or {}).get("receipts") or 0,
                "total_spent": (totals or {}).get("disbursements") or 0,
                "cycle": cycle,
            }
        )

        donations = await fetch_pac_donations(ref["committeeIds"], fec_key)
        rows = [
            {
                "bioguide_id": target["id"],
                "pac_name": d["pacName"],
                "amount": d["amount"],
                "cycle": cycle,
            }
            for d in aggregate_donors(donations["allDonations"])
        ]
        await replace_pac_donations(target["id"], rows)

    await map_with_concurrency(targets, FEC_CONCURRENCY, process, FEC_DELAY_MS)

    return {"members": len(targets), "resolved": resolved}
