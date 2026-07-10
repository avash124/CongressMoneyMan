"""Member / senator profile assembly (port of lib/profile.ts).

Responses keep the exact camelCase shape of types/member.ts so the frontend is
unaffected. The React `cache()` per-request memo from the TS code is replaced
by a short in-process TTL memo on the Congress.gov / FEC lookups.
"""

import asyncio
import datetime
import logging
import math
import re

from ..clients.congress import get_state_code
from ..clients.fec import compute_top_industries, fetch_fec_totals, fetch_pac_donations
from ..clients.quiver import (
    classify_transaction,
    fetch_all_congress_trades,
    format_trade_range,
    parse_trade_range,
)
from ..config import fec_api_key, quiver_api_key
from ..core.db import (
    get_fec_candidate_from_db,
    get_pac_donations_from_db,
    get_trades_by_bioguide,
    replace_pac_donations,
    upsert_fec_candidate,
    write_back,
)
from ..core.http import shared_client
from ..core.util import async_ttl_cache, parse_ms

logger = logging.getLogger("profile")

MEMO_TTL_SECONDS = 15 * 60
RECENT_TRADES_LIMIT = 10

EMPTY_TOTALS = {"totalRaised": 0, "totalSpent": 0}
EMPTY_DONATIONS = {"pacDonations": [], "topIndustries": []}


def _get_party_code(party: str | None) -> str:
    normalized = (party or "").strip().upper()
    if normalized in ("D", "DEM", "DEMOCRAT", "DEMOCRATIC", "DFL"):
        return "D"
    if normalized in ("R", "REP", "REPUBLICAN"):
        return "R"
    return "I"


@async_ttl_cache(MEMO_TTL_SECONDS)
async def _fetch_raw_member(member_id: str) -> dict | None:
    from ..config import congress_api_key

    api_key = congress_api_key()
    if not api_key:
        return None

    response = await shared_client().get(
        f"https://api.congress.gov/v3/member/{member_id}",
        params={"format": "json"},
        headers={"X-Api-Key": api_key},
    )
    if response.status_code >= 400:
        return None

    return response.json().get("member")


def _trade_from_db_row(row: dict) -> dict:
    range_text = row.get("range_text")
    if range_text is None:
        # Bulk-history rows carry only the numeric amount, not a formatted range.
        range_text = format_trade_range(float(row.get("trade_size_usd") or 0))
    return {
        "id": row["trade_id"],
        "ticker": row.get("ticker") or "Unknown",
        "transactionType": row.get("transaction_type") or "Unknown",
        "transactionDate": row.get("transaction_date") or row.get("traded") or "Unknown",
        "amount": range_text,
    }


def _trade_date_ms(trade: dict) -> float:
    return parse_ms(trade["transactionDate"]) or 0


async def load_trades(member_id: str) -> list[dict]:
    rows = await get_trades_by_bioguide(member_id)
    if rows:
        trades = [_trade_from_db_row(row) for row in rows]
        trades.sort(key=_trade_date_ms, reverse=True)
        return trades[:RECENT_TRADES_LIMIT]

    api_key = quiver_api_key()
    if not api_key:
        return []
    try:
        all_trades = await fetch_all_congress_trades(api_key)
    except Exception:
        return []

    trades = []
    for trade in all_trades:
        if trade.get("Bioguide") != member_id:
            continue
        amount = trade.get("Range")
        if amount is None:
            size = trade.get("Trade_Size_USD")
            try:
                amount = format_trade_range(float(size))
            except (TypeError, ValueError):
                amount = format_trade_range(0)
        trades.append(
            {
                "id": str(trade.get("UniqueID") or ""),
                "ticker": trade.get("Ticker") or "Unknown",
                "transactionType": trade.get("Transaction") or "Unknown",
                "transactionDate": trade.get("Date") or trade.get("Traded") or "Unknown",
                "amount": amount,
            }
        )
    trades.sort(key=_trade_date_ms, reverse=True)
    return trades[:RECENT_TRADES_LIMIT]


# Ordered most-specific first; the first pattern to hit the combined
# asset-type + description text wins. The description is scanned too because the
# Quiver `AssetType`/`TickerType` field is usually just "ST"/empty, so real
# estate, crypto, ETFs, etc. are only recoverable from the asset name. Stocks
# sits below the asset classes that also trade like equities (ETFs/REITs) and
# above Trusts so a bank named "...Trust" stays a stock — a heuristic estimate
# matching the card's "estimated holdings" framing.
_ASSET_CATEGORY_RULES: list[tuple[str, re.Pattern]] = [
    ("Real Estate", re.compile(r"real estate|real property|\breit\b|realty|rental propert|land trust")),
    ("Crypto", re.compile(r"crypto|bitcoin|ethereum|\bbtc\b|\beth\b|digital asset|stablecoin")),
    ("Options", re.compile(r"\boption\b|stock option|\bop\b|warrant")),
    ("ETFs", re.compile(r"\betf\b|\betn\b|\betp\b|exchange[- ]traded")),
    ("Municipal Bonds", re.compile(r"muni")),
    ("Bonds", re.compile(r"\bbond\b|debenture|fixed income|promissory note|treasury (bill|note|bond)")),
    ("Mutual Funds", re.compile(r"mutual fund|index fund|\bfund\b")),
    ("Stocks", re.compile(r"\bstock\b|\bst\b|equity|common|\bshares?\b")),
    ("Trusts", re.compile(r"\btrust\b")),
]


def _normalize_asset_category(asset_type: str | None, description: str | None = None) -> str:
    text = f"{asset_type or ''} {description or ''}".lower()
    if not text.strip():
        return "Other"
    for category, pattern in _ASSET_CATEGORY_RULES:
        if pattern.search(text):
            return category
    # Unknown but non-empty type still gets its own labelled slice.
    raw = (asset_type or "").strip()
    if not raw:
        return "Other"
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), raw)


def _disclosure_midpoint(range_text: str | None, lower_bound: float | None) -> float:
    text = range_text
    if text is None and lower_bound is not None:
        text = format_trade_range(lower_bound)
    parsed = parse_trade_range(text)
    if parsed:
        return (parsed["low"] + parsed["high"]) / 2
    try:
        size = float(lower_bound if lower_bound is not None else 0)
    except (TypeError, ValueError):
        return 0
    return size if math.isfinite(size) else 0


def _breakdown_from_positions(positions: list[dict]) -> list[dict]:
    net_by_ticker: dict[str, dict] = {}
    for p in positions:
        if p["direction"] == "other":
            continue
        signed = p["value"] if p["direction"] == "buy" else -p["value"]
        existing = net_by_ticker.get(p["ticker"])
        if existing:
            existing["net"] += signed
        else:
            net_by_ticker[p["ticker"]] = {"category": p["category"], "net": signed}

    by_category: dict[str, float] = {}
    for entry in net_by_ticker.values():
        if entry["net"] <= 0:
            continue
        by_category[entry["category"]] = by_category.get(entry["category"], 0) + entry["net"]

    return sorted(
        (
            {"category": category, "value": round(value)}
            for category, value in by_category.items()
        ),
        key=lambda a: a["value"],
        reverse=True,
    )


async def load_portfolio_breakdown(member_id: str) -> list[dict]:
    rows = await get_trades_by_bioguide(member_id)
    if rows:
        return _breakdown_from_positions(
            [
                {
                    "ticker": r.get("ticker") or r.get("asset_name") or "Unknown",
                    "category": _normalize_asset_category(
                        r.get("asset_type"), r.get("asset_name")
                    ),
                    "direction": classify_transaction(r.get("transaction_type")),
                    "value": _disclosure_midpoint(
                        r.get("range_text"), r.get("trade_size_usd")
                    ),
                }
                for r in rows
            ]
        )

    api_key = quiver_api_key()
    if not api_key:
        return []
    try:
        all_trades = await fetch_all_congress_trades(api_key)
    except Exception:
        return []

    def to_number(value) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    return _breakdown_from_positions(
        [
            {
                "ticker": t.get("Ticker") or t.get("AssetDescription") or "Unknown",
                "category": _normalize_asset_category(
                    t.get("AssetType"), t.get("AssetDescription")
                ),
                "direction": classify_transaction(t.get("Transaction")),
                "value": _disclosure_midpoint(
                    t.get("Range"), to_number(t.get("Trade_Size_USD"))
                ),
            }
            for t in all_trades
            if t.get("Bioguide") == member_id
        ]
    )


def current_cycle() -> int:
    year = datetime.date.today().year
    return year if year % 2 == 0 else year - 1


def aggregate_donors(all_donations: list[dict]) -> list[dict]:
    totals: dict[str, float] = {}
    for donation in all_donations:
        totals[donation["pacName"]] = totals.get(donation["pacName"], 0) + donation["amount"]
    return [{"pacName": name, "amount": amount} for name, amount in totals.items()]


def _donations_from_rows(rows: list[dict]) -> dict:
    donations = [{"pacName": r["pac_name"], "amount": r["amount"]} for r in rows]
    pac_donations = sorted(donations, key=lambda d: d["amount"], reverse=True)[:10]
    return {
        "pacDonations": pac_donations,
        "topIndustries": compute_top_industries(donations),
    }


async def _totals_from_candidate(ref: dict | None, api_key: str | None) -> dict:
    if not api_key or not ref:
        return EMPTY_TOTALS
    totals = await fetch_fec_totals(ref["candidateId"], api_key)
    return {
        "totalRaised": (totals or {}).get("receipts") or 0,
        "totalSpent": (totals or {}).get("disbursements") or 0,
    }


async def _load_fec_totals(member_id: str, resolve_ref) -> dict:
    stored = await get_fec_candidate_from_db(member_id)
    if stored:
        return {
            "totalRaised": stored["total_raised"],
            "totalSpent": stored["total_spent"],
        }

    ref = await resolve_ref()
    totals = await _totals_from_candidate(ref, fec_api_key())
    if ref:
        write_back(
            upsert_fec_candidate(
                {
                    "bioguide_id": member_id,
                    "candidate_id": ref["candidateId"],
                    "committee_ids": ref["committeeIds"],
                    "total_raised": totals["totalRaised"],
                    "total_spent": totals["totalSpent"],
                    "cycle": current_cycle(),
                }
            )
        )
    return totals


async def _load_fec_donations(member_id: str, resolve_ref) -> dict:
    stored = await get_pac_donations_from_db(member_id)
    if stored:
        return _donations_from_rows(stored)

    api_key = fec_api_key()
    if not api_key:
        return EMPTY_DONATIONS

    # A failed FEC lookup must degrade to "no donations" rather than throw — an
    # uncaught error here blanks the cards instead of rendering their empty
    # state (members usually hit the DB branch above; senators fall through to
    # the live API, so the failure surfaced on senator profiles).
    try:
        ref = await resolve_ref()
        if not ref:
            return EMPTY_DONATIONS

        donations = await fetch_pac_donations(ref["committeeIds"], api_key)
        cycle = current_cycle()
        rows = [
            {
                "bioguide_id": member_id,
                "pac_name": d["pacName"],
                "amount": d["amount"],
                "cycle": cycle,
            }
            for d in aggregate_donors(donations["allDonations"])
        ]
        write_back(replace_pac_donations(member_id, rows))

        return {
            "pacDonations": donations["topDonors"],
            "topIndustries": compute_top_industries(donations["allDonations"]),
        }
    except Exception as error:
        logger.warning("load_fec_donations(%s) failed: %s", member_id, error)
        return EMPTY_DONATIONS


def _principal_committees(candidate: dict) -> list[str]:
    return [
        c["committee_id"]
        for c in candidate.get("principal_committees") or []
        if c.get("designation") == "P" and c.get("committee_id")
    ]


async def load_member_base(member_id: str) -> dict | None:
    member = await _fetch_raw_member(member_id)
    if not member or not member.get("bioguideId"):
        return None

    terms = member.get("terms") or []
    latest_term = terms[-1] if terms else None
    district = (
        "Senate"
        if latest_term and latest_term.get("chamber") == "Senate"
        else f"District {member.get('district')}"
    )

    party_history = member.get("partyHistory") or []
    return {
        "id": member["bioguideId"],
        "name": " ".join(
            part for part in (member.get("firstName"), member.get("lastName")) if part
        ),
        "party": _get_party_code(
            party_history[0].get("partyAbbreviation") if party_history else None
        ),
        "state": member.get("state") or "",
        "district": district,
        "imageUrl": (member.get("depiction") or {}).get("imageUrl"),
        "totalRaised": 0,
        "totalSpent": 0,
        "topIndustries": [],
        "pacDonations": [],
        "trades": [],
    }


async def resolve_fec_candidate(
    *,
    name: str,
    state_code: str,
    office: str,
    prefer_incumbent: bool,
    per_page: int,
) -> dict | None:
    """Returns {"candidateId", "committeeIds"} or None."""
    api_key = fec_api_key()
    if not api_key or not state_code:
        return None

    response = await shared_client().get(
        "https://api.open.fec.gov/v1/candidates/search/",
        params={
            "api_key": api_key,
            "name": name,
            "state": state_code,
            "office": office,
            "cycle": str(current_cycle()),
            "per_page": str(per_page),
        },
    )
    if response.status_code >= 400:
        return None

    results = response.json().get("results") or []
    candidate = None
    if prefer_incumbent:
        candidate = (
            next(
                (
                    c
                    for c in results
                    if c.get("incumbent_challenge") == "I"
                    and c.get("candidate_status") == "C"
                ),
                None,
            )
            or next((c for c in results if c.get("incumbent_challenge") == "I"), None)
            or next((c for c in results if c.get("candidate_status") == "C"), None)
        )
    else:
        candidate = results[0] if results else None

    if not candidate or not candidate.get("candidate_id"):
        return None
    return {
        "candidateId": candidate["candidate_id"],
        "committeeIds": _principal_committees(candidate),
    }


@async_ttl_cache(MEMO_TTL_SECONDS)
async def _resolve_member_candidate(member_id: str) -> dict | None:
    member = await _fetch_raw_member(member_id)
    if not member:
        return None

    terms = member.get("terms") or []
    latest_term = terms[-1] if terms else None
    return await resolve_fec_candidate(
        name=member.get("lastName") or "",
        state_code=get_state_code(member.get("state")),
        office="S" if latest_term and latest_term.get("chamber") == "Senate" else "H",
        prefer_incumbent=False,
        per_page=10,
    )


async def load_member_fec_totals(member_id: str) -> dict:
    return await _load_fec_totals(
        member_id, lambda: _resolve_member_candidate(member_id)
    )


async def load_member_fec_donations(member_id: str) -> dict:
    return await _load_fec_donations(
        member_id, lambda: _resolve_member_candidate(member_id)
    )


async def load_member_fec(member_id: str) -> dict:
    totals, donations = await asyncio.gather(
        load_member_fec_totals(member_id), load_member_fec_donations(member_id)
    )
    return {**totals, **donations}


def _current_senate_term(member: dict) -> dict | None:
    for term in member.get("terms") or []:
        if not term.get("endYear") and "Senate" in (term.get("chamber") or ""):
            return term
    return None


async def load_senator_base(senator_id: str) -> dict | None:
    senator = await _fetch_raw_member(senator_id)
    if not senator or not senator.get("bioguideId") or not _current_senate_term(senator):
        return None

    current_term = _current_senate_term(senator) or {}
    party_history = senator.get("partyHistory") or []
    return {
        "id": senator["bioguideId"],
        "name": " ".join(
            part for part in (senator.get("firstName"), senator.get("lastName")) if part
        ),
        "party": _get_party_code(
            (party_history[0].get("partyAbbreviation") if party_history else None)
            or senator.get("party")
            or senator.get("partyName")
        ),
        "state": get_state_code(
            senator.get("state")
            or current_term.get("stateCode")
            or current_term.get("stateName")
        ),
        "district": "Senate",
        "imageUrl": (senator.get("depiction") or {}).get("imageUrl"),
        "totalRaised": 0,
        "totalSpent": 0,
        "topIndustries": [],
        "pacDonations": [],
        "trades": [],
    }


@async_ttl_cache(MEMO_TTL_SECONDS)
async def _resolve_senator_candidate(senator_id: str) -> dict | None:
    senator = await _fetch_raw_member(senator_id)
    if not senator:
        return None

    current_term = _current_senate_term(senator) or {}
    name = (
        f"{senator.get('firstName') or ''} {senator.get('lastName') or ''}".strip()
        or senator.get("lastName")
        or ""
    )
    return await resolve_fec_candidate(
        name=name,
        state_code=get_state_code(
            senator.get("state")
            or current_term.get("stateCode")
            or current_term.get("stateName")
        ),
        office="S",
        prefer_incumbent=True,
        per_page=20,
    )


async def load_senator_fec_totals(senator_id: str) -> dict:
    return await _load_fec_totals(
        senator_id, lambda: _resolve_senator_candidate(senator_id)
    )


async def load_senator_fec_donations(senator_id: str) -> dict:
    return await _load_fec_donations(
        senator_id, lambda: _resolve_senator_candidate(senator_id)
    )


async def load_senator_fec(senator_id: str) -> dict:
    totals, donations = await asyncio.gather(
        load_senator_fec_totals(senator_id), load_senator_fec_donations(senator_id)
    )
    return {**totals, **donations}


async def load_member_profile(member_id: str) -> dict | None:
    base, fec, trades = await asyncio.gather(
        load_member_base(member_id),
        load_member_fec(member_id),
        load_trades(member_id),
    )
    if not base:
        return None
    return {**base, **fec, "trades": trades}


async def load_senator_profile(senator_id: str) -> dict | None:
    base, fec, trades = await asyncio.gather(
        load_senator_base(senator_id),
        load_senator_fec(senator_id),
        load_trades(senator_id),
    )
    if not base:
        return None
    return {**base, **fec, "trades": trades}
