"""Scheduled-job endpoints (port of app/api/cron/*).

Each endpoint is idempotent and guarded by CRON_SECRET when set, exactly like
the Next.js originals, so an external scheduler (Vercel cron, GitHub Actions,
curl in crontab) can drive them.
"""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..config import congress_api_key, cron_secret
from ..core.util import now_iso
from ..services.predictions_job import spawn_batch_scorer
from ..services.rankings import refresh_all_rankings
from ..services.sync import (
    backfill_trades,
    sync_disclosures,
    sync_fec,
    sync_members,
    sync_stock_performance,
    sync_trade_features,
    sync_trades,
)

logger = logging.getLogger("cron")

router = APIRouter()


def _unauthorized(request: Request) -> JSONResponse | None:
    secret = cron_secret()
    if secret and request.headers.get("authorization") != f"Bearer {secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    return None


@router.get("/api/cron/refresh-rankings")
async def cron_refresh_rankings(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    if not congress_api_key():
        return JSONResponse({"error": "Missing CONGRESS_API_KEY"}, status_code=500)

    try:
        result = await refresh_all_rankings(congress_api_key())
        return {
            "ok": True,
            "house": len(result["house"]["byNetWorth"]),
            "senate": len(result["senate"]["byNetWorth"]),
            "refreshedAt": now_iso(),
        }
    except Exception as error:
        message = str(error) or "Failed to refresh rankings"
        logger.error("refresh-rankings: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/refresh-stocks")
async def cron_refresh_stocks(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_stock_performance()
        return {"ok": True, **result, "refreshedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to refresh stock performance"
        logger.error("refresh-stocks: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/sync-trades")
async def cron_sync_trades(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_trades()
        return {"ok": True, **result, "syncedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to sync trades"
        logger.error("sync-trades: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/backfill-trades")
async def cron_backfill_trades(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await backfill_trades()
        return {"ok": True, **result, "syncedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to backfill trades"
        logger.error("backfill-trades: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/refresh-features")
async def cron_refresh_features(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_trade_features()
        return {"ok": True, **result, "refreshedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to refresh trade features"
        logger.error("refresh-features: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/sync-members")
async def cron_sync_members(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_members()
        return {"ok": True, **result, "syncedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to sync members"
        logger.error("sync-members: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/sync-fec")
async def cron_sync_fec(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_fec()
        return {"ok": True, **result, "syncedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to sync FEC data"
        logger.error("sync-fec: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/refresh-predictions")
async def cron_refresh_predictions(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        spawn_batch_scorer()
        return {"ok": True, "started": True, "startedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to start prediction scorer"
        logger.error("refresh-predictions: %s", message)
        return JSONResponse({"error": message}, status_code=500)


@router.get("/api/cron/sync-disclosures")
async def cron_sync_disclosures(request: Request):
    denied = _unauthorized(request)
    if denied:
        return denied

    try:
        result = await sync_disclosures()
        return {"ok": True, **result, "syncedAt": now_iso()}
    except Exception as error:
        message = str(error) or "Failed to sync disclosures"
        logger.error("sync-disclosures: %s", message)
        return JSONResponse({"error": message}, status_code=500)
