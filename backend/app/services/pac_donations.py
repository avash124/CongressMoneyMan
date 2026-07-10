"""PAC donations leaderboard (port of lib/pacDonations.ts)."""

import asyncio
import math

from ..core.cache import get_cache, set_cache
from ..core.db import get_members_from_db, get_top_pac_donations

PAC_DONATIONS_KEY = "pac-donations-v1"
PAC_DONATIONS_TTL_SECONDS = 6 * 60 * 60
TOP_N = 1000


def normalize_party(value: str | None) -> str:
    v = (value or "").strip().upper()
    if v.startswith("D"):
        return "D"
    if v.startswith("R"):
        return "R"
    return "I"


async def get_pac_donation_leaderboard() -> list[dict]:
    cached = await get_cache(PAC_DONATIONS_KEY)
    if cached:
        return cached

    donations, house, senate = await asyncio.gather(
        get_top_pac_donations(TOP_N),
        get_members_from_db("house"),
        get_members_from_db("senate"),
    )
    if not donations:
        return []

    by_id = {m["bioguide_id"]: m for m in [*house, *senate]}

    rows: list[dict] = []
    for d in donations:
        member = by_id.get(d["bioguide_id"])
        if not member:
            continue
        try:
            amount = float(d["amount"])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(amount) or amount <= 0:
            continue
        rows.append(
            {
                "bioguideId": d["bioguide_id"],
                "memberName": member["name"],
                "party": normalize_party(member["party"]),
                "chamber": "senate" if member["chamber"] == "senate" else "house",
                "state": member["state"],
                "pacName": d["pac_name"],
                "amount": round(amount),
            }
        )

    rows.sort(key=lambda row: row["amount"], reverse=True)
    if rows:
        await set_cache(PAC_DONATIONS_KEY, rows, PAC_DONATIONS_TTL_SECONDS)
    return rows
