"""Roster endpoints (port of app/api/house-members and senate-members)."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..clients.congress import fetch_house_members, fetch_senate_members
from ..config import congress_api_key

router = APIRouter()


@router.get("/api/house-members")
async def house_members():
    api_key = congress_api_key()
    if not api_key:
        return JSONResponse(
            {"error": "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY", "members": []},
            status_code=500,
        )

    try:
        members = await fetch_house_members(api_key)
        if not members:
            return JSONResponse(
                {
                    "error": "Congress.gov returned no current House district members.",
                    "members": [],
                },
                status_code=502,
            )
        return {"members": members}
    except Exception as error:
        return JSONResponse(
            {"error": str(error) or "Failed to fetch House members", "members": []},
            status_code=500,
        )


@router.get("/api/senate-members")
async def senate_members():
    api_key = congress_api_key()
    if not api_key:
        return JSONResponse(
            {"error": "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY", "members": []},
            status_code=500,
        )

    try:
        members = await fetch_senate_members(api_key)
        if not members:
            return JSONResponse(
                {
                    "error": "Congress.gov returned no current Senate members.",
                    "members": [],
                },
                status_code=502,
            )
        return {"members": members}
    except Exception as error:
        return JSONResponse(
            {"error": str(error) or "Failed to fetch Senate members", "members": []},
            status_code=500,
        )
