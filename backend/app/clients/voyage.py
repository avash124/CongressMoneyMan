"""Voyage AI embeddings client (RAG phase 3).

Anthropic doesn't ship embeddings; Voyage is their recommended partner. Thin
REST client on the shared httpx client — no SDK dependency. Degrades to None
when VOYAGE_API_KEY is missing or the request fails, so the semantic layer is
strictly optional.
"""

import asyncio
import logging
import os

from ..core.http import shared_client
from ..core.util import chunk

logger = logging.getLogger("voyage")

VOYAGE_BASE_URL = "https://api.voyageai.com/v1"
EMBED_MODEL = "voyage-3.5-lite"
EMBED_DIMENSIONS = 1024
EMBED_BATCH_SIZE = 128
MAX_RETRIES = 2
RETRY_DELAYS_S = [1.5, 5.0]


async def _embed_batch(batch: list[str], input_type: str, api_key: str) -> list | None:
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await shared_client().post(
                f"{VOYAGE_BASE_URL}/embeddings",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": EMBED_MODEL,
                    "input": batch,
                    "input_type": input_type,
                    "output_dimension": EMBED_DIMENSIONS,
                },
            )
            if response.status_code < 400:
                data = (response.json() or {}).get("data") or []
                if len(data) != len(batch):
                    logger.error("embeddings: got %s for %s texts", len(data), len(batch))
                    return None
                return [row["embedding"] for row in sorted(data, key=lambda r: r["index"])]
            transient = response.status_code == 429 or response.status_code >= 500
            if not transient or attempt == MAX_RETRIES:
                logger.error("embeddings: %s %s", response.status_code, response.text[:200])
                return None
        except Exception as error:
            if attempt == MAX_RETRIES:
                logger.error("embeddings request failed: %s", error)
                return None
        await asyncio.sleep(RETRY_DELAYS_S[attempt])
    return None


async def embed_texts(texts: list[str], input_type: str) -> list[list[float]] | None:
    """Embed texts with `input_type` "document" (indexing) or "query" (search).

    Returns one vector per text, or None when unconfigured or any batch fails.
    """
    api_key = os.getenv("VOYAGE_API_KEY")
    if not api_key:
        return None
    if not texts:
        return []

    embeddings: list[list[float]] = []
    for batch in chunk(texts, EMBED_BATCH_SIZE):
        vectors = await _embed_batch(batch, input_type, api_key)
        if vectors is None:
            return None
        embeddings.extend(vectors)
    return embeddings
