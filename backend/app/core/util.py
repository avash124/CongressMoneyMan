"""Small shared helpers (date parsing, concurrency, in-process memoization)."""

import asyncio
import functools
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar

T = TypeVar("T")
R = TypeVar("R")


def parse_ms(value: str | None) -> float | None:
    """Equivalent of JS Date.parse: ISO date/datetime string -> epoch ms, else None."""
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


def now_ms() -> float:
    return time.time() * 1000


def iso_date(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def chunk(items: list[T], size: int) -> list[list[T]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


async def map_with_concurrency(
    items: list[T],
    limit: int,
    mapper: Callable[[T], Awaitable[R]],
    delay_ms: float = 0,
) -> list[R]:
    """Run `mapper` over `items` with at most `limit` in flight, pausing
    `delay_ms` between picks like the TS original."""
    results: list[Any] = [None] * len(items)
    index = 0

    async def worker() -> None:
        nonlocal index
        while index < len(items):
            i = index
            index += 1
            results[i] = await mapper(items[i])
            if delay_ms > 0 and index < len(items):
                await asyncio.sleep(delay_ms / 1000)

    workers = min(limit, len(items))
    if workers > 0:
        await asyncio.gather(*(worker() for _ in range(workers)))
    return results


def async_ttl_cache(ttl_seconds: float) -> Callable:
    """Memoize an async function's result per args for `ttl_seconds`.

    Replaces React's per-request `cache()` from the TS code: profile pages call
    the same Congress.gov lookup several times while rendering one response.
    """

    def decorator(fn: Callable[..., Awaitable[R]]) -> Callable[..., Awaitable[R]]:
        entries: dict[tuple, tuple[float, Any]] = {}

        @functools.wraps(fn)
        async def wrapper(*args: Any) -> R:
            now = time.monotonic()
            hit = entries.get(args)
            if hit is not None and now - hit[0] < ttl_seconds:
                return hit[1]
            value = await fn(*args)
            if len(entries) > 4096:
                for key in [k for k, (t, _) in entries.items() if now - t >= ttl_seconds]:
                    entries.pop(key, None)
            entries[args] = (now, value)
            return value

        return wrapper

    return decorator


_in_flight: dict[str, asyncio.Task] = {}


async def single_flight(key: str, run: Callable[[], Awaitable[R]]) -> R:
    """Deduplicate concurrent invocations that share `key` onto one task."""
    existing = _in_flight.get(key)
    if existing is not None:
        return await asyncio.shield(existing)

    task = asyncio.ensure_future(run())
    _in_flight[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if _in_flight.get(key) is task:
            _in_flight.pop(key, None)
