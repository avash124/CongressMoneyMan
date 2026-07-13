"""Member / senator profile endpoints (port of app/api/member/[id] and
app/api/senator/[id]).

Besides the full-profile endpoints, each slow-loading piece (base identity,
FEC totals, FEC donations, trades, portfolio breakdown) is exposed separately
so the Next.js profile pages can stream sections independently, exactly like
they did when they imported lib/profile.ts directly.
"""

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..core.util import single_flight
from ..services.profile import (
    load_member_base,
    load_member_fec_donations,
    load_member_fec_totals,
    load_member_profile,
    load_portfolio_breakdown,
    load_senator_base,
    load_senator_fec_donations,
    load_senator_fec_totals,
    load_senator_profile,
    load_trades,
)

logger = logging.getLogger("profiles")

router = APIRouter()


def _server_error(error: Exception) -> JSONResponse:
    logger.error("route error: %s", error)
    return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/api/member/{member_id}")
async def member_profile(member_id: str):
    try:
        member = await load_member_profile(member_id)
        if not member:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return member
    except Exception as error:
        return _server_error(error)


@router.get("/api/member/{member_id}/base")
async def member_base(member_id: str):
    try:
        base = await load_member_base(member_id)
        if not base:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return base
    except Exception as error:
        return _server_error(error)


@router.get("/api/member/{member_id}/fec-totals")
async def member_fec_totals(member_id: str):
    try:
        return await load_member_fec_totals(member_id)
    except Exception as error:
        return _server_error(error)


@router.get("/api/member/{member_id}/fec-donations")
async def member_fec_donations(member_id: str):
    try:
        return await single_flight(
            f"member-fec-donations:{member_id}",
            lambda: load_member_fec_donations(member_id),
        )
    except Exception as error:
        return _server_error(error)


@router.get("/api/member/{member_id}/trades")
async def member_trades(member_id: str):
    try:
        return {"trades": await load_trades(member_id)}
    except Exception as error:
        return _server_error(error)


@router.get("/api/member/{member_id}/portfolio")
async def member_portfolio(member_id: str):
    try:
        return {"allocations": await load_portfolio_breakdown(member_id)}
    except Exception as error:
        return _server_error(error)


@router.get("/api/senator/{senator_id}")
async def senator_profile(senator_id: str):
    try:
        senator = await load_senator_profile(senator_id)
        if not senator:
            return JSONResponse({"error": "Senator not found"}, status_code=404)
        return senator
    except Exception:
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/api/senator/{senator_id}/base")
async def senator_base(senator_id: str):
    try:
        base = await load_senator_base(senator_id)
        if not base:
            return JSONResponse({"error": "Senator not found"}, status_code=404)
        return base
    except Exception as error:
        return _server_error(error)


@router.get("/api/senator/{senator_id}/fec-totals")
async def senator_fec_totals(senator_id: str):
    try:
        return await load_senator_fec_totals(senator_id)
    except Exception as error:
        return _server_error(error)


@router.get("/api/senator/{senator_id}/fec-donations")
async def senator_fec_donations(senator_id: str):
    try:
        return await single_flight(
            f"senator-fec-donations:{senator_id}",
            lambda: load_senator_fec_donations(senator_id),
        )
    except Exception as error:
        return _server_error(error)
