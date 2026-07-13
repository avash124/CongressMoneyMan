"""Grounded insight endpoints (RAG phase 5).

Thin HTTP layer over services/insights.py. Generation is the expensive step,
so every insight is cached in Redis for a day (features refresh daily, so a
longer TTL would only serve stale numbers). A missing insight — unknown
entity, empty feature layer, or the anthropic SDK/credentials being absent —
is a 404, which the frontend treats as "hide the card".
"""

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..core.cache import get_cache, set_cache
from ..core.util import now_iso
from ..services.insights import (
    asset_class_insight,
    asset_insight,
    compare_insight,
    member_insight,
)
from ..services.trade_features import normalize_asset_type

logger = logging.getLogger("insights_router")

router = APIRouter()

INSIGHT_TTL_SECONDS = 24 * 60 * 60
MAX_COMPARE_ENTITIES = 6


async def _cached_insight(cache_key: str, generate) -> dict | JSONResponse:
    cached = await get_cache(cache_key)
    if cached:
        return cached

    insight = await generate()
    if insight is None:
        return JSONResponse({"error": "No insight available"}, status_code=404)

    payload = {**insight, "generatedAt": now_iso()}
    await set_cache(cache_key, payload, INSIGHT_TTL_SECONDS)
    return payload


@router.get("/api/insights/asset/{ticker}")
async def insight_for_asset(ticker: str):
    symbol = ticker.strip().upper()
    try:
        return await _cached_insight(
            f"insight:asset:{symbol}:v1", lambda: asset_insight(symbol)
        )
    except Exception as error:
        message = str(error) or "Failed to generate asset insight"
        logger.error("asset(%s): %s", symbol, message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/insights/member/{bioguide_id}")
async def insight_for_member(bioguide_id: str):
    key = bioguide_id.strip()
    try:
        return await _cached_insight(
            f"insight:member:{key}:v1", lambda: member_insight(key)
        )
    except Exception as error:
        message = str(error) or "Failed to generate member insight"
        logger.error("member(%s): %s", key, message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/insights/asset-class/{asset_type}")
async def insight_for_asset_class(asset_type: str):
    normalized = normalize_asset_type(asset_type)
    try:
        return await _cached_insight(
            f"insight:asset-class:{normalized}:v1",
            lambda: asset_class_insight(normalized),
        )
    except Exception as error:
        message = str(error) or "Failed to generate asset-class insight"
        logger.error("asset-class(%s): %s", normalized, message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/insights/compare")
async def insight_for_comparison(tickers: str | None = None, assetTypes: str | None = None):
    wanted_tickers = list(
        dict.fromkeys(
            t.strip().upper() for t in (tickers or "").split(",") if t.strip()
        )
    )[:MAX_COMPARE_ENTITIES]
    wanted_types = list(
        dict.fromkeys(
            normalize_asset_type(t) for t in (assetTypes or "").split(",") if t.strip()
        )
    )[:MAX_COMPARE_ENTITIES]
    if not wanted_tickers and not wanted_types:
        return JSONResponse(
            {"error": "Provide tickers and/or assetTypes to compare"}, status_code=400
        )

    cache_key = (
        f"insight:compare:{','.join(wanted_tickers)}|{','.join(wanted_types)}:v1"
    )
    try:
        return await _cached_insight(
            cache_key,
            lambda: compare_insight(
                tickers=wanted_tickers or None, asset_types=wanted_types or None
            ),
        )
    except Exception as error:
        message = str(error) or "Failed to generate comparison insight"
        logger.error("compare(%s): %s", cache_key, message)
        return JSONResponse({"error": message}, status_code=500)
