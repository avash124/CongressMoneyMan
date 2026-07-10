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


async def _fetch_congress_page(api_key: str, offset: int) -> list[dict]:
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
    return response.json().get("members") or []


async def _fetch_all_raw_members(api_key: str) -> list[dict]:
    first_page = await _fetch_congress_page(api_key, 0)
    if len(first_page) < PAGE_SIZE:
        return first_page

    page2, page3 = await asyncio.gather(
        _fetch_congress_page(api_key, PAGE_SIZE),
        _fetch_congress_page(api_key, PAGE_SIZE * 2),
    )
    return [*first_page, *page2, *page3]


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
