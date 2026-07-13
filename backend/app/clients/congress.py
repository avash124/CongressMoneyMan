"""Congress.gov roster client (port of lib/congress.ts).

Members are plain dicts with the same camelCase keys the TS code emitted
(`id`, `name`, `party`, `state`, `district`, `imageUrl`) so cached values and
API responses stay byte-compatible with the Next.js backend.
"""

import asyncio
import logging

from ..core.cache import get_cache, set_cache
from ..core.http import shared_client

logger = logging.getLogger("congress")

STATE_NAME_TO_CODE: dict[str, str] = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "District of Columbia": "DC",
    "Florida": "FL",
    "Georgia": "GA",
    "Hawaii": "HI",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY",
    "American Samoa": "AS",
    "Guam": "GU",
    "Northern Mariana Islands": "MP",
    "Puerto Rico": "PR",
    "Virgin Islands": "VI",
}

AT_LARGE_STATE_CODES = {
    "AK", "AS", "DC", "DE", "GU", "MP", "ND", "PR", "SD", "VI", "VT", "WY",
}

NON_VOTING_HOUSE_STATES = {"AS", "DC", "GU", "MP", "PR", "VI"}

CONGRESS_API_BASE = "https://api.congress.gov/v3/member"
PAGE_SIZE = 250

HOUSE_MEMBERS_KEY = "house-members"
SENATE_MEMBERS_KEY = "senate-members"
MEMBERS_TTL_SECONDS = 60 * 60

COMMITTEE_REQUEST_DELAY_S = 0.2


def get_state_code(state: str | None) -> str:
    if not state:
        return ""
    normalized = state.strip()
    if not normalized:
        return ""
    if len(normalized) == 2:
        return normalized.upper()
    return STATE_NAME_TO_CODE.get(normalized, "")


def is_non_voting_house_seat(state: str | None) -> bool:
    return get_state_code(state) in NON_VOTING_HOUSE_STATES


def get_party_code(party: str | None) -> str | None:
    normalized = (party or "").strip().upper()
    if not normalized:
        return None
    if normalized in ("D", "DEM", "DEMOCRAT", "DEMOCRATIC", "DFL"):
        return "D"
    if normalized in ("R", "REP", "REPUBLICAN"):
        return "R"
    if normalized in ("I", "IND", "INDEPENDENT"):
        return "I"
    return None


def normalize_district(value) -> str:
    if value is None:
        return ""
    raw = str(value).strip().upper()
    if not raw:
        return ""
    if raw in ("AL", "AT LARGE", "AT-LARGE"):
        return "AL"
    try:
        numeric = int(raw, 10)
    except ValueError:
        return raw
    if numeric == 0:
        return "AL"
    return str(numeric)


def _current_house_term(member: dict) -> dict | None:
    for term in (member.get("terms") or {}).get("item") or []:
        chamber = term.get("chamber")
        if (
            not term.get("endYear")
            and isinstance(chamber, str)
            and ("House" in chamber or "Representative" in chamber)
        ):
            return term
    return None


def _current_senate_term(member: dict) -> dict | None:
    for term in (member.get("terms") or {}).get("item") or []:
        chamber = term.get("chamber")
        if not term.get("endYear") and isinstance(chamber, str) and "Senate" in chamber:
            return term
    return None


async def _fetch_congress_page(api_key: str, offset: int) -> tuple[list[dict], int]:
    """Fetch one page of members plus the total ``pagination.count``.

    The v3 API can return fewer rows than ``limit`` even when more members
    exist, so callers must page on the reported total rather than assuming a
    short page means the last page."""
    response = await shared_client().get(
        CONGRESS_API_BASE,
        params={
            "format": "json",
            "currentMember": "true",
            "limit": str(PAGE_SIZE),
            "offset": str(offset),
            "api_key": api_key,
        },
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Congress.gov request failed with status {response.status_code}"
        )
    body = response.json()
    members = body.get("members") or []
    total = (body.get("pagination") or {}).get("count") or 0
    return members, total


async def _fetch_all_raw_members(api_key: str) -> list[dict]:
    first_page, total = await _fetch_congress_page(api_key, 0)
    members = list(first_page)
    offset = PAGE_SIZE
    while len(members) < total:
        page, _ = await _fetch_congress_page(api_key, offset)
        if not page:
            break
        members.extend(page)
        offset += PAGE_SIZE
    return members


async def fetch_house_members(api_key: str) -> list[dict]:
    cached = await get_cache(HOUSE_MEMBERS_KEY)
    if cached:
        return cached

    raw = await _fetch_all_raw_members(api_key)
    seen: dict[str, dict] = {}

    for member in raw:
        term = _current_house_term(member)
        if not term:
            continue

        party = get_party_code(member.get("party") or member.get("partyName"))
        state = get_state_code(
            term.get("stateCode") or member.get("state") or term.get("stateName")
        )
        if state in NON_VOTING_HOUSE_STATES:
            continue
        district = normalize_district(
            member.get("district") if member.get("district") is not None else term.get("district")
        )
        final_district = district or ("AL" if state in AT_LARGE_STATE_CODES else "")

        if not (member.get("bioguideId") and member.get("name") and party and state and final_district):
            continue

        seen[f"{state}-{final_district}"] = {
            "id": member["bioguideId"],
            "name": member["name"],
            "party": party,
            "state": state,
            "district": final_district,
            "imageUrl": (member.get("depiction") or {}).get("imageUrl"),
        }

    def district_order(member: dict) -> int:
        return 0 if member["district"] == "AL" else int(member["district"])

    members = sorted(seen.values(), key=lambda m: (m["state"], district_order(m)))

    await set_cache(HOUSE_MEMBERS_KEY, members, MEMBERS_TTL_SECONDS)
    return members


async def fetch_senate_members(api_key: str) -> list[dict]:
    cached = await get_cache(SENATE_MEMBERS_KEY)
    if cached:
        return cached

    raw = await _fetch_all_raw_members(api_key)
    seen: dict[str, dict] = {}

    for member in raw:
        term = _current_senate_term(member)
        if not term:
            continue

        party = get_party_code(member.get("party") or member.get("partyName"))
        state = get_state_code(
            term.get("stateCode") or member.get("state") or term.get("stateName")
        )

        if not (member.get("bioguideId") and member.get("name") and party and state):
            continue

        seen[member["bioguideId"]] = {
            "id": member["bioguideId"],
            "name": member["name"],
            "party": party,
            "state": state,
            "imageUrl": (member.get("depiction") or {}).get("imageUrl"),
        }

    members = sorted(seen.values(), key=lambda m: (m["state"], m["name"]))

    await set_cache(SENATE_MEMBERS_KEY, members, MEMBERS_TTL_SECONDS)
    return members


def _extract_committee_names(member_detail: dict) -> list[str]:
    """Pull current committee names out of a /member/{id} detail payload.

    The v3 schema nests assignments as ``member.committeeAssignments.item`` (a
    list of {name, ...}); some responses use a flat ``committees`` list. Read
    both defensively and de-dupe, since the offline snapshot only needs the set
    of committee names per member (the ML committee->sector map keys on names)."""
    member = member_detail.get("member") or member_detail
    names: list[str] = []
    containers = [
        (member.get("committeeAssignments") or {}).get("item"),
        member.get("committees"),
        (member.get("committees") or {}).get("item")
        if isinstance(member.get("committees"), dict)
        else None,
    ]
    for container in containers:
        if not isinstance(container, list):
            continue
        for entry in container:
            name = entry.get("name") if isinstance(entry, dict) else None
            if isinstance(name, str) and name.strip():
                names.append(name.strip())
    return list(dict.fromkeys(names))


async def fetch_committee_assignments(
    api_key: str, bioguide_ids: list[str]
) -> list[dict]:
    """Current committee assignments per member, as ``{bioguide_id, committee}``
    rows (one row per membership) — the shape the ML committee family snapshots.

    One serial detail request per member (paced ``COMMITTEE_REQUEST_DELAY_S``).
    A failed lookup is skipped, not fatal — a partial roster still yields a
    usable jurisdiction map. Only CURRENT assignments are exposed by the API;
    the ML layer documents applying them to historical folds as an approximation
    (plan §2.5 #6).

    KNOWN LIMITATION (as of 2026-07): the congress.gov v3 API does NOT expose
    committee↔member membership on either the /member/{id} or /committee/{code}
    detail endpoints, so this returns an empty list against the live API today.
    ``_extract_committee_names`` reads the (documented-but-unpopulated) schema
    fields defensively, so the moment v3 ships membership — or a caller points it
    at a compatible source — this activates with no further change. Until then
    the ML committee family is implemented + unit-tested but not run on live data
    (see ml/runs/p6-verify.md)."""
    rows: list[dict] = []
    for bioguide_id in bioguide_ids:
        try:
            response = await shared_client().get(
                f"{CONGRESS_API_BASE}/{bioguide_id}",
                params={"format": "json", "api_key": api_key},
            )
            if response.status_code >= 400:
                logger.warning(
                    "committee detail %s -> %s", bioguide_id, response.status_code
                )
                continue
            for name in _extract_committee_names(response.json() or {}):
                rows.append({"bioguide_id": bioguide_id, "committee": name})
        except Exception as error:
            logger.warning("committee detail %s failed: %s", bioguide_id, error)
        await asyncio.sleep(COMMITTEE_REQUEST_DELAY_S)
    return rows
