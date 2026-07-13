"""FastAPI application entrypoint.

Run with:  uvicorn app.main:app --reload  (from the backend/ directory)
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .core.http import close_client
from .routers import (
    cron,
    insights,
    members,
    pacs,
    predictions,
    profiles,
    rankings,
    stocks,
    trades,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await close_client()


app = FastAPI(title="CongressMoneyMan API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(members.router)
app.include_router(rankings.router)
app.include_router(trades.router)
app.include_router(profiles.router)
app.include_router(pacs.router)
app.include_router(predictions.router)
app.include_router(stocks.router)
app.include_router(insights.router)
app.include_router(cron.router)


@app.get("/api/health")
async def health():
    return {"ok": True}
