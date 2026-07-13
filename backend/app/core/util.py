"""Small shared helpers (date parsing, concurrency, in-process memoization)."""

import asyncio
import functools
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar

T = TypeVar("T")
R = TypeVar("R")

_NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def name_token_key(name: str) -> str:
    """Order-independent, accent-insensitive name key so different renderings
    of a name collapse to one value (e.g. "Van Hollen, Chris" and
    "Chris Van Hollen" both -> "chris hollen van"). Used to match roster ids
    against Quiver trade names and FD filer names."""
    ascii_name = (
        unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode("ascii")
    )
    tokens = [
        token
        for token in re.split(r"[^a-z]+", ascii_name.lower())
        if token and token not in _NAME_SUFFIXES
    ]
    return " ".join(sorted(tokens))


def _dedupe_by_key(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Build key -> id, dropping keys shared by two different ids so an
    ambiguous key is left unresolved rather than misattributed."""
    by_key: dict[str, str] = {}
    ambiguous: set[str] = set()
    for key, id_ in pairs:
        if not key:
            continue
        existing = by_key.get(key)
        if existing and existing != id_:
            ambiguous.add(key)
        else:
            by_key[key] = id_
    for key in ambiguous:
        by_key.pop(key, None)
    return by_key


def build_bioguide_by_name(members: list[dict]) -> dict[str, str]:
    """Map name_token_key -> bioguide id (exact token-set match)."""
    return _dedupe_by_key([(name_token_key(m["name"]), m["id"]) for m in members])


def _last_initial_key(name: str) -> str:
    """Loose key: last name + first-name initial, order-insensitive on the last
    name so "Adams, Alma S." and "Alma Shealey Adams" collapse. Handles both
    roster "Last, First" and filing "First Last" forms."""
    ascii_name = (
        unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode("ascii")
    )
    if "," in ascii_name:
        last_part, _, first_part = ascii_name.partition(",")
    else:
        tokens = re.split(r"[^A-Za-z]+", ascii_name)
        tokens = [t for t in tokens if t and t.lower() not in _NAME_SUFFIXES]
        if not tokens:
            return ""
        last_part, first_part = tokens[-1], (tokens[0] if len(tokens) > 1 else "")
    last = re.sub(r"[^a-z]", "", last_part.lower())
    first_initial = re.sub(r"[^a-z]", "", first_part.lower())[:1]
    return f"{last}|{first_initial}" if last and first_initial else ""


class BioguideMatcher:
    """Two-tier name -> bioguide resolver. Tries an exact token-set match first
    (safe), then a last-name + first-initial match (broader, still guarded
    against ambiguity). Built once from the roster, reused across all filers."""

    def __init__(self, members: list[dict]) -> None:
        self._exact = build_bioguide_by_name(members)
        self._loose = _dedupe_by_key(
            [(_last_initial_key(m["name"]), m["id"]) for m in members]
        )

    def resolve(self, name: str) -> str | None:
        return self._exact.get(name_token_key(name)) or self._loose.get(
            _last_initial_key(name)
        )


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
