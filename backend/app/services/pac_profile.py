"""PAC profile data: recipients, spending history, contribution feed
(port of lib/pacProfile.ts)."""

import asyncio
import logging
import math
import re

from ..config import fec_api_key
from ..core.cache import get_cache, set_cache
from ..core.db import (
    get_all_fec_candidates,
    get_members_from_db,
    get_pac_donations_by_name,
)
from ..core.http import shared_client
from ..core.util import iso_date, now_ms, parse_ms
from .pac_donations import normalize_party

logger = logging.getLogger("pac_profile")

RECIPIENTS_TTL_SECONDS = 6 * 60 * 60
COMMITTEE_ID_TTL_SECONDS = 30 * 24 * 60 * 60
COMMITTEE_MISS_TTL_SECONDS = 6 * 60 * 60
SPENDING_TTL_SECONDS = 12 * 60 * 60
REPORT_MAX_PAGES = 3

FEED_TTL_SECONDS = 12 * 60 * 60
FEED_MAX_PAGES = 15
FEED_LOOKBACK_MS = 5 * 365 * 24 * 60 * 60 * 1000


async def get_pac_recipients(pac_name: str) -> dict:
    cache_key = f"pac-recipients:{pac_name.lower()}"
    cached = await get_cache(cache_key)
    if cached:
        return cached

    rows, house, senate = await asyncio.gather(
        get_pac_donations_by_name(pac_name),
        get_members_from_db("house"),
        get_members_from_db("senate"),
    )

    by_id = {m["bioguide_id"]: m for m in [*house, *senate]}

    by_member: dict[str, dict] = {}
    for r in rows:
        member = by_id.get(r["bioguide_id"])
        if not member:
            continue
        try:
            amount = float(r["amount"])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(amount) or amount <= 0:
            continue
        existing = by_member.get(r["bioguide_id"])
        if existing:
            existing["amount"] += amount
        else:
            by_member[r["bioguide_id"]] = {
                "bioguideId": r["bioguide_id"],
                "name": member["name"],
                "party": normalize_party(member["party"]),
                "chamber": "senate" if member["chamber"] == "senate" else "house",
                "amount": amount,
            }

    recipients = sorted(
        ({**r, "amount": round(r["amount"])} for r in by_member.values()),
        key=lambda r: r["amount"],
        reverse=True,
    )

    result = {
        "pacName": pac_name,
        "totalAmount": sum(r["amount"] for r in recipients),
        "houseCount": sum(1 for r in recipients if r["chamber"] == "house"),
        "senateCount": sum(1 for r in recipients if r["chamber"] == "senate"),
        "recipients": recipients,
    }

    if recipients:
        await set_cache(cache_key, result, RECIPIENTS_TTL_SECONDS)
    return result


_PAC_TYPE_PRIORITY = ["Q", "N", "O", "V", "W", "U", "D"]
_NAME_STOPWORDS = {
    "POLITICAL", "ACTION", "COMMITTEE", "FUND", "NATIONAL", "AMERICAN",
    "ASSOCIATION", "FEDERAL", "INC", "CORP", "CORPORATION", "COMPANY", "THE",
}


def _type_rank(committee_type: str | None) -> int:
    try:
        return _PAC_TYPE_PRIORITY.index(committee_type)
    except ValueError:
        return len(_PAC_TYPE_PRIORITY)


def _significant_tokens(name: str) -> list[str]:
    return [
        t
        for t in re.split(r"[^A-Z0-9]+", name.upper())
        if len(t) >= 4 and t not in _NAME_STOPWORDS
    ]


def _pick_committee(results: list[dict], tokens: list[str]) -> str | None:
    named = [c for c in results if c.get("committee_id") and c.get("name")]
    if tokens:
        matches = [
            c for c in named if any(t in c["name"].upper() for t in tokens)
        ]
    else:
        matches = named
    if not matches:
        return None
    matches.sort(key=lambda c: _type_rank(c.get("committee_type")))
    return matches[0].get("committee_id")


async def _search_committees(query: str, api_key: str) -> list[dict]:
    response = await shared_client().get(
        "https://api.open.fec.gov/v1/committees/",
        params={"api_key": api_key, "q": query, "per_page": "20"},
    )
    if response.status_code >= 400:
        return []
    return response.json().get("results") or []


async def _resolve_pac_committee_id(pac_name: str, api_key: str) -> str | None:
    cache_key = f"pac-committee-id:{pac_name.lower()}"
    cached = await get_cache(cache_key)
    if cached:
        return cached.get("id")

    cleaned = re.sub(r"\bPOLITICAL ACTION COMMITTEE\b", "", pac_name, flags=re.I)
    cleaned = re.sub(r"\bPAC\b", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    queries = (
        [pac_name, cleaned]
        if cleaned and cleaned.upper() != pac_name.upper()
        else [pac_name]
    )
    tokens = _significant_tokens(pac_name)

    committee_id: str | None = None
    try:
        for query in queries:
            results = await _search_committees(query, api_key)
            committee_id = _pick_committee(results, tokens)
            if committee_id:
                break
    except Exception as error:
        logger.warning("resolve_pac_committee_id(%s) failed: %s", pac_name, error)

    await set_cache(
        cache_key,
        {"id": committee_id},
        COMMITTEE_ID_TTL_SECONDS if committee_id else COMMITTEE_MISS_TTL_SECONDS,
    )
    return committee_id


async def _fetch_pac_spending_history(committee_id: str, api_key: str) -> list[dict]:
    cache_key = f"pac-spending:{committee_id}"
    cached = await get_cache(cache_key)
    if cached:
        return cached

    reports: list[dict] = []
    for page in range(1, REPORT_MAX_PAGES + 1):
        response = await shared_client().get(
            f"https://api.open.fec.gov/v1/committee/{committee_id}/reports/",
            params={
                "api_key": api_key,
                "per_page": "100",
                "page": str(page),
                "sort": "-coverage_end_date",
            },
        )
        if response.status_code >= 400:
            break
        data = response.json()
        results = data.get("results") or []
        if not results:
            break
        reports.extend(results)
        pages = (data.get("pagination") or {}).get("pages") or 1
        if page >= pages:
            break

    by_period: dict[str, dict] = {}
    for r in reports:
        if not r.get("coverage_end_date") or r.get("most_recent") is False:
            continue
        day = r["coverage_end_date"][:10]
        existing = by_period.get(day)
        if not existing or (r.get("receipt_date") or "") > (existing.get("receipt_date") or ""):
            by_period[day] = r

    points = []
    for day, r in by_period.items():
        t = parse_ms(day)
        if t is None:
            continue
        try:
            disbursements = float(r.get("total_disbursements_period") or 0)
        except (TypeError, ValueError):
            disbursements = 0
        points.append({"t": t, "c": max(0, disbursements)})
    points.sort(key=lambda p: p["t"])

    if points:
        await set_cache(cache_key, points, SPENDING_TTL_SECONDS)
    return points


async def get_pac_spending(pac_name: str) -> dict:
    api_key = fec_api_key()
    if not api_key:
        return {"committeeId": None, "points": []}

    committee_id = await _resolve_pac_committee_id(pac_name, api_key)
    if not committee_id:
        return {"committeeId": None, "points": []}

    points = await _fetch_pac_spending_history(committee_id, api_key)
    return {"committeeId": committee_id, "points": points}


async def _fetch_pac_contributions(committee_id: str, api_key: str) -> list[dict]:
    min_date = iso_date(now_ms() - FEED_LOOKBACK_MS)
    out: list[dict] = []
    last_index: str | None = None
    last_date: str | None = None

    for _ in range(FEED_MAX_PAGES):
        params = {
            "api_key": api_key,
            "contributor_id": committee_id,
            "min_date": min_date,
            "per_page": "100",
            "sort": "-contribution_receipt_date",
        }
        if last_index:
            params["last_index"] = last_index
        if last_date:
            params["last_contribution_receipt_date"] = last_date

        response = await shared_client().get(
            "https://api.open.fec.gov/v1/schedules/schedule_a/", params=params
        )
        if response.status_code >= 400:
            break
        data = response.json()
        results = data.get("results") or []
        if not results:
            break

        for r in results:
            try:
                amount = float(r.get("contribution_receipt_amount") or 0)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(amount) or amount <= 0:
                continue
            out.append(
                {
                    "recipientCommitteeId": r.get("committee_id"),
                    "candidateIds": (r.get("committee") or {}).get("candidate_ids") or [],
                    "date": r.get("contribution_receipt_date") or "",
                    "amount": amount,
                }
            )

        li = (data.get("pagination") or {}).get("last_indexes") or {}
        if not li.get("last_index") or li["last_index"] == last_index:
            break
        last_index = li["last_index"]
        last_date = li.get("last_contribution_receipt_date")

    return out


async def get_pac_contribution_feed(pac_name: str) -> dict:
    api_key = fec_api_key()
    if not api_key:
        return {"committeeId": None, "members": [], "contributions": []}

    committee_id = await _resolve_pac_committee_id(pac_name, api_key)
    if not committee_id:
        return {"committeeId": None, "members": [], "contributions": []}

    cache_key = f"pac-feed:{committee_id}"
    cached = await get_cache(cache_key)
    if cached:
        return cached

    raw, candidates, house, senate = await asyncio.gather(
        _fetch_pac_contributions(committee_id, api_key),
        get_all_fec_candidates(),
        get_members_from_db("house"),
        get_members_from_db("senate"),
    )

    committee_to_bioguide: dict[str, str] = {}
    candidate_to_bioguide: dict[str, str] = {}
    for c in candidates:
        for cid in c.get("committee_ids") or []:
            committee_to_bioguide[cid] = c["bioguide_id"]
        if c.get("candidate_id"):
            candidate_to_bioguide[c["candidate_id"]] = c["bioguide_id"]

    member_by_id = {m["bioguide_id"]: m for m in [*house, *senate]}

    contributions: list[dict] = []
    present: dict[str, dict] = {}
    for r in raw:
        bioguide = (
            committee_to_bioguide.get(r["recipientCommitteeId"])
            if r["recipientCommitteeId"]
            else None
        )
        if not bioguide:
            for cand in r["candidateIds"]:
                b = candidate_to_bioguide.get(cand)
                if b:
                    bioguide = b
                    break
        if not bioguide:
            continue
        member = member_by_id.get(bioguide)
        if not member:
            continue
        date = parse_ms(r["date"])
        if date is None:
            continue

        contributions.append(
            {"bioguideId": bioguide, "amount": round(r["amount"]), "date": date}
        )
        if bioguide not in present:
            present[bioguide] = {
                "bioguideId": bioguide,
                "name": member["name"],
                "party": normalize_party(member["party"]),
                "chamber": "senate" if member["chamber"] == "senate" else "house",
            }

    result = {
        "committeeId": committee_id,
        "members": list(present.values()),
        "contributions": contributions,
    }
    if contributions:
        await set_cache(cache_key, result, FEED_TTL_SECONDS)
    return result
