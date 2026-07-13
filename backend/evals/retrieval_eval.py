"""Phase 3 retrieval eval: 20 hand-written queries, hit@3 on entity_cards.

    .venv/Scripts/python evals/retrieval_eval.py     (from backend/)

Needs VOYAGE_API_KEY and the 0005_entity_cards migration applied; prints what
is missing otherwise. Queries whose expected entity has no card in the DB are
skipped (reported), so the eval stays honest across differently-populated DBs.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config
from app.core.db import get_entity_cards_from_db
from app.core.http import close_client
from app.services.entity_cards import resolve_entities

QUERIES = [
    ("Nvidia", "ticker|NVDA"),
    ("the AI chip maker congress keeps buying", "ticker|NVDA"),
    ("Microsoft", "ticker|MSFT"),
    ("Apple, the iPhone company", "ticker|AAPL"),
    ("S&P 500 index fund", "ticker|SPY"),
    ("Tesla, the electric vehicle maker", "ticker|TSLA"),
    ("Google search giant", "ticker|GOOGL"),
    ("Amazon e-commerce", "ticker|AMZN"),
    ("JPMorgan, the big bank", "ticker|JPM"),
    ("Meta, Facebook's parent company", "ticker|META"),
    ("Exxon oil company", "ticker|XOM"),
    ("Boeing airplane manufacturer", "ticker|BA"),
    ("Ro Khanna", "member|K000389"),
    ("California Democrat who trades tech stocks constantly", "member|K000389"),
    ("Michael McCaul", "member|M001157"),
    ("Texas Republican with huge trading volume", "member|M001157"),
    ("Josh Gottheimer", "member|G000583"),
    ("New Jersey Democrat known for frequent trading", "member|G000583"),
    ("Nancy Pelosi", "member|P000197"),
    ("Pelosi, the California congresswoman", "member|P000197"),
]

TOP_K = 3


async def main() -> int:
    if not os.getenv("VOYAGE_API_KEY"):
        print("VOYAGE_API_KEY is not set — semantic retrieval is disabled. "
              "Add it to .env.local to run this eval.")
        await close_client()
        return 1

    cards = await get_entity_cards_from_db()
    if not cards:
        print("entity_cards is empty or missing. Apply "
              "supabase/migrations/0005_entity_cards.sql, then run "
              "/api/cron/refresh-features (or refresh_entity_cards()) to populate.")
        await close_client()
        return 1
    known = {card["card_id"] for card in cards}

    hits, misses, skipped = 0, [], 0
    for query, expected in QUERIES:
        if expected not in known:
            print(f"SKIP  (no card for {expected}): {query!r}")
            skipped += 1
            continue
        results = await resolve_entities(query, top_k=TOP_K)
        got = [f"{r['kind']}|{r['key']}" for r in results]
        if expected in got:
            hits += 1
            print(f"HIT   {query!r} -> {got}")
        else:
            misses.append((query, expected, got))
            print(f"MISS  {query!r} expected {expected}, got {got}")

    scored = len(QUERIES) - skipped
    print(f"\nhit@{TOP_K}: {hits}/{scored} ({hits / scored:.0%})"
          if scored else "\nnothing scored")
    for query, expected, got in misses:
        print(f"  miss: {query!r} wanted {expected} got {got}")
    await close_client()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
