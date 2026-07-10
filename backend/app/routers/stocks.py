"""Stock endpoints (port of app/api/stock-leaderboard and stock-chart)."""

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..clients.prices import CHART_RANGES, get_price_history
from ..core.util import now_iso
from ..services.stock_leaderboard import (
    get_holdings_leaderboard,
    get_stock_performance,
    get_ticker_holders,
)

logger = logging.getLogger("stocks")

router = APIRouter()


@router.get("/api/stock-leaderboard")
async def stock_leaderboard():
    try:
        holdings, performance = await asyncio.gather(
            get_holdings_leaderboard(), get_stock_performance()
        )
        return {
            "holdings": holdings,
            "performance": performance,
            "generatedAt": now_iso(),
        }
    except Exception as error:
        message = str(error) or "Failed to load stock leaderboard"
        logger.error("%s", message)
        return JSONResponse(
            {"holdings": [], "performance": [], "error": message}, status_code=500
        )


@router.get("/api/stock-leaderboard/{ticker}")
async def stock_holders(ticker: str):
    try:
        return await get_ticker_holders(ticker)
    except Exception as error:
        message = str(error) or "Failed to load holders"
        logger.error("%s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/stock-chart/{ticker}")
async def stock_chart(ticker: str, range: str | None = None):
    try:
        chart_range = range if range in CHART_RANGES else "1M"
        points = await get_price_history(ticker.upper(), chart_range)
        return {"ticker": ticker.upper(), "range": chart_range, "points": points}
    except Exception as error:
        message = str(error) or "Failed to load chart"
        logger.error("%s", message)
        return JSONResponse({"error": message, "points": []}, status_code=500)
