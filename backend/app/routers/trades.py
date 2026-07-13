"""Trade feed + trade detail endpoints (port of app/api/liveTrades; the trade
detail endpoint exposes lib/trades.ts's loadTradeDetail over HTTP)."""

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..clients.quiver import QuiverCircuitOpenError, fetch_all_congress_trades
from ..config import quiver_api_key
from ..core.util import now_iso, parse_ms
from ..services.trades import load_trade_detail

logger = logging.getLogger("live_trades")

router = APIRouter()

LIVE_TRADES_LIMIT = 1000


def _normalize_party(value: str | None) -> str:
    v = (value or "").strip().upper()
    if v == "D" or v.startswith("DEM"):
        return "D"
    if v == "R" or v.startswith("REP"):
        return "R"
    return "I"


def _map_quiver_trade(trade: dict, index: int) -> dict:
    return {
        "amount": trade.get("Range") or "",
        "assetName": trade.get("AssetDescription") or "",
        "assetType": trade.get("AssetType") or "",
        "bioguideId": trade.get("Bioguide") or "",
        "chamber": trade.get("Chamber") or "",
        "filedAt": trade.get("ReportDate") or "",
        "id": str(trade["UniqueID"]) if trade.get("UniqueID") is not None else str(index),
        "memberName": trade.get("Representative") or "",
        "party": _normalize_party(trade.get("Party")),
        "ticker": trade.get("Ticker") or "-",
        "tradeDate": trade.get("Date") or "",
        "transactionType": trade.get("Transaction") or "",
    }


@router.get("/api/liveTrades")
async def live_trades():
    api_key = quiver_api_key()
    if not api_key:
        return JSONResponse(
            {"trades": [], "error": "Missing QUIVER_API_KEY environment variable"},
            status_code=500,
        )

    try:
        data = await fetch_all_congress_trades(api_key)

        trades = [
            _map_quiver_trade(trade, index)
            for index, trade in enumerate(data)
            if trade.get("Bioguide")
        ]
        trades.sort(
            key=lambda t: (parse_ms(t["filedAt"]) or 0, parse_ms(t["tradeDate"]) or 0),
            reverse=True,
        )

        return {"trades": trades[:LIVE_TRADES_LIMIT], "generatedAt": now_iso()}
    except QuiverCircuitOpenError:
        logger.warning("circuit breaker open — serving empty trades")
        return {"trades": [], "unavailable": True}
    except Exception as error:
        message = str(error) or "Failed to load live trades"
        logger.error("%s", message)
        return JSONResponse({"trades": [], "error": message}, status_code=500)


@router.get("/api/trade/{trade_id:path}")
async def trade_detail(trade_id: str):
    try:
        detail = await load_trade_detail(trade_id)
        if not detail:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return detail
    except Exception as error:
        logger.error("trade detail error: %s", error)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
