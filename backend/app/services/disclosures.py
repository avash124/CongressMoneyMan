"""Financial-disclosure net-worth estimates keyed by bioguide id.

Bridges the FD client (raw filings per chamber) and the rankings service: it
matches each filer to a roster bioguide id by name, computes a gross-net-worth
estimate from the filing, and caches the result so rankings can fall back to it
when Quiver has no live figure for a member.
"""

import asyncio
import logging

from ..clients.congress import fetch_house_members, fetch_senate_members
from ..clients.disclosures import (
    candidate_filing_years,
    house_annual_filings,
    house_net_worth,
    senate_annual_filings,
    senate_net_worth,
)
from ..config import require_congress_api_key
from ..core.cache import get_cache, set_cache
from ..core.util import BioguideMatcher, map_with_concurrency

logger = logging.getLogger("disclosures_service")

DISCLOSURE_NET_WORTH_KEY = "disclosure-net-worth-v1"
DISCLOSURE_TTL_SECONDS = 7 * 24 * 60 * 60

_PDF_CONCURRENCY = 4
_REPORT_CONCURRENCY = 4
_MIN_ASSETS = 1


async def _house_estimates(year: int, matcher: BioguideMatcher) -> dict[str, dict]:
    filings = await house_annual_filings(year)
    logger.info("house FD %s: %s annual filings", year, len(filings))

    async def one(filing: dict) -> tuple[str, dict] | None:
        bioguide_id = matcher.resolve(f"{filing['first']} {filing['last']}")
        if not bioguide_id or not filing["doc_id"]:
            return None
        result = await house_net_worth(filing["doc_id"], year)
        if not result:
            return None
        estimate, count = result
        if count < _MIN_ASSETS:
            return None
        return bioguide_id, {"netWorth": round(estimate), "asOf": year, "source": "fd"}

    resolved = await map_with_concurrency(filings, _PDF_CONCURRENCY, one)
    return {bioguide_id: value for entry in resolved if entry for bioguide_id, value in [entry]}


async def _senate_estimates(year: int, matcher: BioguideMatcher) -> dict[str, dict]:
    filings = await senate_annual_filings(year)
    logger.info("senate FD %s: %s annual filings", year, len(filings))

    async def one(filing: dict) -> tuple[str, dict] | None:
        bioguide_id = matcher.resolve(f"{filing['first']} {filing['last']}")
        if not bioguide_id:
            return None
        result = await senate_net_worth(filing["report_url"])
        if not result:
            return None
        estimate, count = result
        if count < _MIN_ASSETS:
            return None
        return bioguide_id, {"netWorth": round(estimate), "asOf": year, "source": "fd"}

    resolved = await map_with_concurrency(filings, _REPORT_CONCURRENCY, one)
    return {bioguide_id: value for entry in resolved if entry for bioguide_id, value in [entry]}


async def refresh_disclosure_net_worth() -> dict[str, dict]:
    """Rebuild the FD net-worth map from the freshest annual filings for both
    chambers and cache it. Returns {bioguide_id: {netWorth, asOf, source}}."""
    api_key = require_congress_api_key()
    house_members, senate_members = await asyncio.gather(
        fetch_house_members(api_key), fetch_senate_members(api_key)
    )
    house_matcher = BioguideMatcher(house_members)
    senate_matcher = BioguideMatcher(senate_members)

    house_map: dict[str, dict] = {}
    senate_map: dict[str, dict] = {}
    for year in candidate_filing_years():
        year_house, year_senate = await asyncio.gather(
            _house_estimates(year, house_matcher),
            _senate_estimates(year, senate_matcher),
        )
        for bioguide_id, value in year_house.items():
            house_map.setdefault(bioguide_id, value)
        for bioguide_id, value in year_senate.items():
            senate_map.setdefault(bioguide_id, value)

    combined = {**house_map, **senate_map}
    logger.info(
        "disclosure net worth: %s house + %s senate = %s members",
        len(house_map),
        len(senate_map),
        len(combined),
    )
    if combined:
        await set_cache(DISCLOSURE_NET_WORTH_KEY, combined, DISCLOSURE_TTL_SECONDS)
    return combined


async def get_disclosure_net_worth() -> dict[str, dict]:
    """FD net-worth map, from cache if warm. Never triggers a live rebuild on a
    user request — that is the sync job's responsibility — so a cold cache
    simply yields no fallback rather than blocking a page for minutes."""
    cached = await get_cache(DISCLOSURE_NET_WORTH_KEY)
    return cached or {}
