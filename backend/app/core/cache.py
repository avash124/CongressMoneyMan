"""Upstash Redis REST cache.

Values are stored as JSON strings, matching what the `@upstash/redis` JS client
writes, so cache keys remain interchangeable with the Next.js backend. All
failures degrade to cache misses, never errors.
"""

import json
import logging
import os
from typing import Any
from urllib.parse import quote

from .http import shared_client

logger = logging.getLogger("cache")


def _credentials() -> tuple[str, str] | None:
    url = os.getenv("UPSTASH_REDIS_REST_URL")
    token = os.getenv("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return None
    return url.rstrip("/"), token


async def _command(path: str, body: str | None = None) -> Any:
    credentials = _credentials()
    if credentials is None:
        return None
    base, token = credentials
    response = await shared_client().post(
        f"{base}/{path}",
        headers={"Authorization": f"Bearer {token}"},
        content=body,
    )
    response.raise_for_status()
    return response.json().get("result")


async def get_cache(key: str) -> Any:
    try:
        raw = await _command(f"get/{quote(key, safe='')}")
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return raw
    except Exception as error:
        logger.error('get failed for "%s": %s', key, error)
        return None


async def set_cache(key: str, value: Any, ttl_seconds: int) -> None:
    try:
        await _command(
            f"set/{quote(key, safe='')}?EX={ttl_seconds}",
            body=json.dumps(value),
        )
    except Exception as error:
        logger.error('set failed for "%s": %s', key, error)


async def increment_cache(key: str, ttl_seconds: int) -> int | None:
    try:
        count = await _command(f"incr/{quote(key, safe='')}")
        if count == 1:
            await _command(f"expire/{quote(key, safe='')}/{ttl_seconds}")
        return int(count) if count is not None else None
    except Exception as error:
        logger.error('incr failed for "%s": %s', key, error)
        return None
