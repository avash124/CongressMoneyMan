"""FastAPI application entrypoint.

Run with:  uvicorn app.main:app --reload  (from the backend/ directory)
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config  # noqa: F401  (loads .env.local before anything reads env vars)
from .core.http import close_client
from .routers import cron, members, pacs, profiles, rankings, stocks, trades

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await close_client()


app = FastAPI(title="CongressMoneyMan API", lifespan=lifespan)

# The Next.js frontend either proxies /api/* here (same-origin, via rewrite) or
# calls this server directly during development — allow both.
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
app.include_router(stocks.router)
app.include_router(cron.router)


@app.get("/api/health")
async def health():
    return {"ok": True}
