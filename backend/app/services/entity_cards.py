"""Semantic entity cards (RAG phase 3).

Builds one short identity card per member and per notable ticker from the
precomputed feature rows, embeds them with Voyage, and persists to the
pgvector-backed `entity_cards` table. `resolve_entities` turns a fuzzy
free-form reference ("the AI chip maker senators bought") into concrete
bioguide ids / tickers — the numbers behind any insight still come from the
phase 2 retrieval functions.

Card text carries only stable identity fields (name, party, state, sectors,
asset classes), never trade counts or P/L — so nightly refreshes only re-embed
cards whose identity actually changed. Degrades to a no-op without
VOYAGE_API_KEY or the 0005 migration.
"""

import asyncio
import logging

from ..clients.congress import STATE_NAME_TO_CODE
from ..clients.voyage import embed_texts
from ..core.db import (
    get_entity_cards_from_db,
    get_members_from_db,
    get_trade_features_by_scope,
    match_entity_cards,
    upsert_entity_cards,
)

logger = logging.getLogger("entity_cards")

NOTABLE_MIN_MEMBERS = 2
MOST_ACTIVE_QUANTILE = 0.9

_PARTY_LABELS = {"D": "Democratic", "R": "Republican", "I": "Independent"}
_STATE_NAMES = {code: name for name, code in STATE_NAME_TO_CODE.items()}

_KNOWN_ETFS = {
    "SPY": "SPDR S&P 500 ETF Trust, an S&P 500 index fund",
    "VOO": "Vanguard S&P 500 ETF, an S&P 500 index fund",
    "IVV": "iShares Core S&P 500 ETF, an S&P 500 index fund",
    "QQQ": "Invesco QQQ Trust, a Nasdaq-100 index fund",
    "DIA": "SPDR Dow Jones Industrial Average ETF",
    "IWM": "iShares Russell 2000 small-cap ETF",
}


def _party_label(party: str | None) -> str:
    initial = (party or "").strip()[:1].upper()
    return _PARTY_LABELS.get(initial, (party or "").strip())


def build_member_card(
    row: dict, state: str | None = None, most_active: bool = False
) -> dict:
    """Stable identity text for a member feature row. `state` may be a code
    ("CA") or a full name; cards always carry the full name so fuzzy queries
    ("California Democrat") can match."""
    name = row.get("display_name") or row.get("entity_key") or ""
    party = _party_label(row.get("party"))
    role = "senator" if row.get("chamber") == "senate" else "House member"
    text = " ".join(part for part in (party, role) if part)
    if state:
        text += f" from {_STATE_NAMES.get(state, state)}"

    sectors = [
        s["sector"]
        for s in (row.get("top_sectors") or [])
        if s.get("sector") and s["sector"] != "Other"
    ][:3]
    if sectors:
        text += f". Trades mostly in {', '.join(sectors)}"
    classes = [
        klass
        for klass, _ in sorted(
            (row.get("asset_types") or {}).items(), key=lambda kv: kv[1], reverse=True
        )
        if klass != "unknown"
    ][:3]
    if classes:
        text += f". Disclosed asset classes: {', '.join(classes)}"
    if most_active:
        text += ". Among the most active and frequent traders in Congress"

    return {
        "card_id": f"member|{row.get('entity_key')}",
        "kind": "member",
        "entity_key": row.get("entity_key"),
        "card_text": f"{name} — {text}.",
    }


def build_ticker_card(row: dict) -> dict:
    """Stable identity text for a ticker feature row."""
    ticker = row.get("entity_key") or ""
    if ticker in _KNOWN_ETFS:
        description = f"{_KNOWN_ETFS[ticker]} (etf)"
    else:
        name = row.get("display_name") or ticker
        sector = row.get("sector") or "Other"
        asset_type = row.get("asset_type") or "asset"
        description = f"{name}, {sector} sector {asset_type}"
    return {
        "card_id": f"ticker|{ticker}",
        "kind": "ticker",
        "entity_key": ticker,
        "card_text": f"{ticker} — {description} disclosed in congressional trades.",
    }


def _vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in embedding) + "]"


async def refresh_entity_cards() -> dict:
    """Rebuild cards from feature rows; embed and upsert only changed texts."""
    member_rows, ticker_rows = await asyncio.gather(
        get_trade_features_by_scope("member"),
        get_trade_features_by_scope("ticker", min_members=NOTABLE_MIN_MEMBERS),
    )
    if not member_rows and not ticker_rows:
        return {"cards": 0, "embedded": 0}

    house, senate = await asyncio.gather(
        get_members_from_db("house"), get_members_from_db("senate")
    )
    states = {m["bioguide_id"]: m.get("state") for m in [*house, *senate]}

    counts = sorted((row.get("trade_count") or 0) for row in member_rows)
    active_cutoff = (
        counts[int(len(counts) * MOST_ACTIVE_QUANTILE)] if counts else 0
    )
    cards = [
        *(
            build_member_card(
                row,
                states.get(row.get("entity_key")),
                most_active=(row.get("trade_count") or 0) >= active_cutoff > 0,
            )
            for row in member_rows
        ),
        *(build_ticker_card(row) for row in ticker_rows),
    ]

    existing = {
        row.get("card_id"): row.get("card_text")
        for row in await get_entity_cards_from_db()
    }
    changed = [c for c in cards if existing.get(c["card_id"]) != c["card_text"]]
    if not changed:
        return {"cards": len(cards), "embedded": 0}

    embeddings = await embed_texts([c["card_text"] for c in changed], "document")
    if embeddings is None:
        logger.warning(
            "entity cards: embeddings unavailable (VOYAGE_API_KEY missing or "
            "Voyage failed) — %s changed card(s) not embedded", len(changed)
        )
        return {"cards": len(cards), "embedded": 0}

    await upsert_entity_cards(
        [
            {**card, "embedding": _vector_literal(vector)}
            for card, vector in zip(changed, embeddings)
        ]
    )
    return {"cards": len(cards), "embedded": len(changed)}


async def resolve_entities(query: str, top_k: int = 5) -> list[dict]:
    """Fuzzy reference -> the top_k closest entities, best first. Each hit is
    {"kind", "key", "card", "similarity"}; empty when semantic search is
    unavailable — callers must treat this layer as optional."""
    text = (query or "").strip()
    if not text:
        return []
    embeddings = await embed_texts([text], "query")
    if not embeddings:
        return []
    rows = await match_entity_cards(_vector_literal(embeddings[0]), top_k)
    return [
        {
            "kind": row.get("kind"),
            "key": row.get("entity_key"),
            "card": row.get("card_text"),
            "similarity": round(row["similarity"], 3)
            if isinstance(row.get("similarity"), (int, float))
            else None,
        }
        for row in rows
    ]
