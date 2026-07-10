"""OpenFEC client (port of lib/fec.ts)."""

import datetime

from ..core.cache import get_cache, set_cache
from ..core.http import shared_client
from ..services.industry_classifier import categorize_industry

FEC_TOTALS_TTL_SECONDS = 6 * 60 * 60
FEC_PAC_TTL_SECONDS = 6 * 60 * 60

SCHEDULE_A_URL = "https://api.open.fec.gov/v1/schedules/schedule_a/"


async def fetch_pac_donations(
    committee_ids: list[str], api_key: str, max_pages: int = 15
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

            response = await shared_client().get(SCHEDULE_A_URL, params=params)
            if response.status_code >= 400:
                break

            data = response.json()
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

    response = await shared_client().get(
        f"https://api.open.fec.gov/v1/candidate/{candidate_id}/totals/",
        params={"api_key": api_key},
    )
    if response.status_code >= 400:
        return None

    results = response.json().get("results") or []
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
