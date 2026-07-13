"""Trade-prediction endpoints (P7 — read-only, mirrors rankings.py).

Serves the ranked predictions the offline cron scorer wrote to
``trade_predictions``. No write path lives here — writes are the cron's job
(``ml/scripts/score_batch.py`` / ``/api/cron/refresh-predictions``), the exact
same separation as rankings.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..services.predictions import get_latest_predictions, get_prediction_context

router = APIRouter()


@router.get("/api/predictions/{bioguide_id}")
async def member_predictions(bioguide_id: str):
    try:
        return await get_latest_predictions(bioguide_id)
    except Exception as error:
        return JSONResponse(
            {
                "bioguideId": bioguide_id,
                "asOf": None,
                "modelVersion": None,
                "predictions": [],
                "error": str(error) or "Failed to load predictions",
            },
            status_code=500,
        )


@router.get("/api/predictions/{bioguide_id}/{ticker}")
async def prediction_context(bioguide_id: str, ticker: str):
    try:
        return await get_prediction_context(bioguide_id, ticker)
    except Exception as error:
        return JSONResponse(
            {
                "bioguideId": bioguide_id,
                "ticker": ticker,
                "memberHistory": None,
                "tickerContext": None,
                "error": str(error) or "Failed to load prediction context",
            },
            status_code=500,
        )
