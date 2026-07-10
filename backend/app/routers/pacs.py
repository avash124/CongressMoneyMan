"""PAC endpoints (port of app/api/pac-donations, pac-chart, pac-recipients-feed)."""

import logging
from urllib.parse import unquote

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..core.util import now_iso
from ..services.pac_donations import get_pac_donation_leaderboard
from ..services.pac_profile import (
    get_pac_contribution_feed,
    get_pac_recipients,
    get_pac_spending,
)

logger = logging.getLogger("pacs")

router = APIRouter()


@router.get("/api/pac-donations")
async def pac_donations():
    try:
        donations = await get_pac_donation_leaderboard()
        return {"donations": donations, "generatedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to load PAC donations"
        logger.error("%s", message)
        return JSONResponse({"donations": [], "error": message}, status_code=500)


@router.get("/api/pac-donations/{pac}")
async def pac_recipients(pac: str):
    pac_name = unquote(pac)
    try:
        return await get_pac_recipients(pac_name)
    except Exception as error:
        message = str(error) or "Failed to load PAC recipients"
        logger.error("%s", message)
        return JSONResponse(
            {
                "pacName": pac_name,
                "totalAmount": 0,
                "houseCount": 0,
                "senateCount": 0,
                "recipients": [],
                "error": message,
            },
            status_code=500,
        )


@router.get("/api/pac-chart/{pac}")
async def pac_chart(pac: str):
    pac_name = unquote(pac)
    try:
        return await get_pac_spending(pac_name)
    except Exception as error:
        message = str(error) or "Failed to load PAC spending"
        logger.error("%s", message)
        return JSONResponse(
            {"committeeId": None, "points": [], "error": message}, status_code=500
        )


@router.get("/api/pac-recipients-feed/{pac}")
async def pac_recipients_feed(pac: str):
    pac_name = unquote(pac)
    try:
        return await get_pac_contribution_feed(pac_name)
    except Exception as error:
        message = str(error) or "Failed to load PAC contribution feed"
        logger.error("%s", message)
        return JSONResponse(
            {"committeeId": None, "members": [], "contributions": [], "error": message},
            status_code=500,
        )
