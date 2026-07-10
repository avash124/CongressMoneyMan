"""Rankings endpoints (port of app/api/house-rankings and senate-rankings)."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..services.rankings import get_house_rankings, get_senate_rankings

router = APIRouter()


@router.get("/api/house-rankings")
async def house_rankings():
    try:
        return await get_house_rankings()
    except Exception as error:
        return JSONResponse(
            {
                "byNetWorth": [],
                "byStockHoldings": [],
                "error": str(error) or "Failed to build House rankings",
            },
            status_code=500,
        )


@router.get("/api/senate-rankings")
async def senate_rankings():
    try:
        return await get_senate_rankings()
    except Exception as error:
        return JSONResponse(
            {
                "byNetWorth": [],
                "byStockHoldings": [],
                "error": str(error) or "Failed to build Senate rankings",
            },
            status_code=500,
        )
