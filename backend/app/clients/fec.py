"""OpenFEC client (port of lib/fec.ts)."""

import asyncio
import datetime
import logging
import random

from ..core.cache import get_cache, set_cache
from ..core.http import shared_client
from ..services.industry_classifier import categorize_industry

logger = logging.getLogger("fec")

FEC_TOTALS_TTL_SECONDS = 6 * 60 * 60
FEC_PAC_TTL_SECONDS = 6 * 60 * 60
FEC_CAND_TTL_SECONDS = 6 * 60 * 60

SCHEDULE_A_URL = "https://api.open.fec.gov/v1/schedules/schedule_a/"

MAX_RETRIES = 3
RETRY_BASE_DELAYS_MS = [1000, 3000, 8000]
MAX_RETRY_AFTER_SECONDS = 60


class FecUnavailable(Exception):
    """FEC refused the request — rate limit, rejected key, or persistent 5xx.

    Raised rather than returned so a throttled run can never be recorded as
    "this member has no FEC record."
    """


def _retry_after_seconds(response) -> float | None:
    raw = response.headers.get("Retry-After")
    if not raw or not raw.strip().isdigit():
        return None
    return min(float(raw.strip()), MAX_RETRY_AFTER_SECONDS)


async def fec_get(url: str, params: dict) -> dict | None:
    """Returns parsed JSON, or None for a 4xx that genuinely means "no data".

    Raises FecUnavailable when the API is refusing us: 429, 403, or a 5xx that
    outlived its retries.
    """
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await shared_client().get(url, params=params)
        except Exception as error:
            if attempt == MAX_RETRIES:
                raise FecUnavailable(f"request failed: {error}") from error
            await asyncio.sleep(RETRY_BASE_DELAYS_MS[attempt] / 1000)
            continue

        if response.status_code < 400:
            return response.json()

        if response.status_code == 403:
            raise FecUnavailable("403 — FEC_API_KEY rejected or out of quota")

        if response.status_code != 429 and response.status_code < 500:
            logger.warning("%s on %s", response.status_code, url)
            return None

        if attempt == MAX_RETRIES:
            raise FecUnavailable(
                f"{response.status_code} after {MAX_RETRIES} retries"
            )

        delay = _retry_after_seconds(response)
        if delay is None:
            delay = (RETRY_BASE_DELAYS_MS[attempt] + random.randint(0, 249)) / 1000
        logger.warning("%s — retrying in %.1fs", response.status_code, delay)
        await asyncio.sleep(delay)

    return None


async def fetch_pac_donations(
    committee_ids: list[str], api_key: str, max_pages: int = 5
) -> dict:
    """Returns {"topDonors": [...], "allDonations": [...]} like the TS original."""
    if not committee_ids or not api_key:
        return {"topDonors": [], "allDonations": []}

    year = datetime.date.today().year
    cycle = year if year % 2 == 0 else year - 1

    cache_key = f"fec-pac:{','.join(sorted(committee_ids))}:{cycle}"
    cached = await get_cache(cache_key)
    if cached:
        return cached

    all_donations: list[dict] = []

    for committee_id in committee_ids:
        last_index: str | None = None
        last_date: str | None = None
        page_count = 0

        while page_count < max_pages:
            params = {
                "api_key": api_key,
                "committee_id": committee_id,
                "two_year_transaction_period": str(cycle),
                "contributor_type": "committee",
                "per_page": "100",
                "sort": "-contribution_receipt_date",
            }
            if last_index:
                params["last_index"] = last_index
            if last_date:
                params["last_contribution_receipt_date"] = last_date

            data = await fec_get(SCHEDULE_A_URL, params)
            if data is None:
                break

            results = data.get("results") or []
            if not results:
                break

            for r in results:
                if not r.get("contributor_name"):
                    continue
                all_donations.append(
                    {
                        "pacName": r["contributor_name"],
                        "amount": r.get("contribution_receipt_amount") or 0,
                    }
                )

            li = (data.get("pagination") or {}).get("last_indexes") or {}
            if not li.get("last_index") or li["last_index"] == last_index:
                break

            last_index = li["last_index"]
            last_date = li.get("last_contribution_receipt_date")
            page_count += 1

    donor_totals: dict[str, float] = {}
    for donation in all_donations:
        donor_totals[donation["pacName"]] = (
            donor_totals.get(donation["pacName"], 0) + donation["amount"]
        )

    top_donors = sorted(
        ({"pacName": name, "amount": amount} for name, amount in donor_totals.items()),
        key=lambda d: d["amount"],
        reverse=True,
    )[:10]

    result = {"topDonors": top_donors, "allDonations": all_donations}
    await set_cache(cache_key, result, FEC_PAC_TTL_SECONDS)
    return result


async def fetch_fec_totals(candidate_id: str, api_key: str) -> dict | None:
    if not candidate_id or not api_key:
        return None

    cache_key = f"fec-totals:{candidate_id}"
    cached = await get_cache(cache_key)
    if cached:
        return cached

    data = await fec_get(
        f"https://api.open.fec.gov/v1/candidate/{candidate_id}/totals/",
        {"api_key": api_key},
    )
    if data is None:
        return None

    results = data.get("results") or []
    totals = results[0] if results else None
    if totals:
        await set_cache(cache_key, totals, FEC_TOTALS_TTL_SECONDS)
    return totals


def compute_top_industries(donations: list[dict]) -> list[dict]:
    totals: dict[str, float] = {}

    for donation in donations:
        industry = categorize_industry(donation["pacName"])
        totals[industry] = totals.get(industry, 0) + donation["amount"]

    return sorted(
        (
            {"name": name, "amount": amount}
            for name, amount in totals.items()
            if name != "Other"
        ),
        key=lambda entry: entry["amount"],
        reverse=True,
    )[:3]
