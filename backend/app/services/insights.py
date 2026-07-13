"""Grounded insight generation (RAG phase 4, templated mode).

Each public function assembles a numbered context block from the phase 2
retrieval layer (the only source of truth for numbers), then asks Claude
(claude-opus-4-8, adaptive thinking, streaming) to narrate and compare —
never to compute. The static system prompt + field glossary sits behind a
cache_control breakpoint per the plan; note Opus 4.8 only engages the cache
once the static prefix exceeds ~4096 tokens, so the breakpoint is future-proof
rather than load-bearing at the prompt's current size.

Degrades to None when the anthropic SDK or credentials are missing, matching
the repo-wide convention. The SDK constructs a client even without
credentials (auth resolves per-request), so missing-credential failures are
latched on the first generation attempt rather than at construction.
Free-form Q&A (tool use) is deliberately deferred.
"""

import json
import logging
import ssl

import truststore

from ..core.db import (
    get_recent_trades_by_bioguide,
    get_recent_trades_by_ticker,
)
from .retrieval import (
    compare_assets,
    get_features_by_member,
    get_features_by_ticker,
    top_movers,
)
from .trade_features import normalize_asset_type

logger = logging.getLogger("insights")

MODEL = "claude-opus-4-8"
MAX_TOKENS = 16000

SYSTEM_PROMPT = """You write short, factual insights about U.S. congressional \
stock-trading disclosures for a public transparency site.

You will receive numbered context rows of the form "[n] label: {json}". These \
rows are the ONLY source of truth.

Grounding rules (strict):
- Every numeric claim must come from a context row and cite it as [n] right \
after the claim. Rounding for readability is fine ($4,969,382 -> "about $5.0M").
- Never compute new numbers: no sums, differences, ratios, percentages, or \
per-year figures that are not already present in a row.
- Never use outside knowledge about companies, prices, events, or people, and \
never speculate about motives.
- If the data is thin (few trades, missing P/L, sparse asset-class coverage), \
say so plainly instead of extrapolating.
- Disclosures report value ranges, not exact amounts: every usd figure is a \
midpoint estimate of those ranges — describe them as estimates.

Style: 2-4 short paragraphs of plain prose. No headers, bullet lists, \
investment advice, or boilerplate disclaimers.

Field glossary (feature rows are precomputed nightly from the disclosures):
- tradeCount/buyCount/sellCount: disclosed transactions; buySellRatio = buys \
per sell (absent when there are no sells).
- totalBoughtUsd/totalSoldUsd: all-time sums of disclosure-range midpoints.
- estPlPct/estPlUsd: weighted average price change on buys from the last 3 \
years, weighted by range midpoints, buy-date close vs latest close. \
pricedBuyUsd is the buy value those prices actually cover — compare it to \
totalBoughtUsd before treating estPl as representative.
- spyPlPct: the same buy dates and weights applied to the SPY benchmark; \
excessReturnPct = estPlPct - spyPlPct. When spyPlPct is absent the P/L \
estimate is unbenchmarked — never imply a market comparison for it.
- avgHoldingDays/matchedPairs: each sale paired with the same member's most \
recent prior buy of that ticker.
- tradesPerMonth: trades over the active span (floored at one month).
- topSectors: share of a member's traded value by sector. assetTypes: a \
member's traded value by asset class.
- memberCount/houseCount/senateCount: distinct members who traded a ticker.
- Asset classes: stock, etf, crypto, option, fund, bond, other (explicitly \
miscellaneous securities), unknown (the source feed carried no type). Typed \
etf/crypto coverage is sparse and "unknown" can be a large share — treat \
cross-class comparisons as coverage-limited and say so.
- comparableTicker/topMoverInClass rows: tickers with recent congressional \
activity, ranked by absolute estPlPct. Their estPlPct is return since \
purchase (up to 3 years back), not return over the recent window.
- byChamber/byParty: {trades, boughtUsd} splits for an asset class; \
topTickers: its most-bought tickers.
- recentTrade rows are individual disclosures; amountRange is the disclosed \
value band.
"""

_client = None
_client_unavailable = False


def _anthropic_client():
    """Lazy AsyncAnthropic on the OS trust store (mirrors core/http.py); None
    once the SDK is missing or a credential failure has been latched."""
    global _client, _client_unavailable
    if _client is None and not _client_unavailable:
        try:
            from anthropic import AsyncAnthropic, DefaultAsyncHttpxClient

            _client = AsyncAnthropic(
                http_client=DefaultAsyncHttpxClient(
                    verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                )
            )
        except Exception as error:
            _client_unavailable = True
            logger.warning("insights disabled — anthropic client unavailable: %s", error)
    return _client


def build_context(rows: list[tuple[str, dict]]) -> str:
    """Numbered, deterministic context block — the model may only use these."""
    return "\n".join(
        f"[{i}] {label}: {json.dumps(data, separators=(',', ':'), sort_keys=True)}"
        for i, (label, data) in enumerate(rows, start=1)
    )


def _trade_row(trade: dict) -> dict:
    row = {
        "date": trade.get("transaction_date") or trade.get("traded"),
        "member": trade.get("member_name"),
        "ticker": trade.get("ticker"),
        "type": trade.get("transaction_type"),
        "amountRange": trade.get("range_text"),
    }
    return {key: value for key, value in row.items() if value}


async def _generate(question: str, context: str) -> dict | None:
    client = _anthropic_client()
    if client is None:
        return None
    try:
        async with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            thinking={"type": "adaptive"},
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[
                {"role": "user", "content": f"{question}\n\nContext rows:\n{context}"}
            ],
        ) as stream:
            message = await stream.get_final_message()
    except TypeError as error:
        if "authentication" in str(error).lower():
            global _client_unavailable
            _client_unavailable = True
            logger.warning("insights disabled — no Anthropic credentials found")
            return None
        logger.error("insight generation failed: %s", error)
        return None
    except Exception as error:
        logger.error("insight generation failed: %s", error)
        return None

    text = "".join(
        block.text for block in message.content if block.type == "text"
    ).strip()
    if not text:
        return None
    usage = message.usage
    return {
        "text": text,
        "model": message.model,
        "usage": {
            "inputTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "cacheReadInputTokens": getattr(usage, "cache_read_input_tokens", None),
            "cacheCreationInputTokens": getattr(usage, "cache_creation_input_tokens", None),
        },
    }


async def _insight(
    kind: str, entity: str, question: str, rows: list[tuple[str, dict]]
) -> dict | None:
    if not rows:
        return None
    context = build_context(rows)
    generated = await _generate(question, context)
    if generated is None:
        return None
    return {
        "kind": kind,
        "entity": entity,
        "insight": generated["text"],
        "model": generated["model"],
        "usage": generated["usage"],
        "context": context,
    }


async def asset_insight(ticker: str) -> dict | None:
    """Templated insight for one ticker: its features, its asset class, a few
    comparable movers, and recent disclosures."""
    features = await get_features_by_ticker(ticker)
    if not features:
        return None
    symbol = features["ticker"]
    rows: list[tuple[str, dict]] = [("tickerFeatures", features)]

    asset_type = features.get("assetType")
    if asset_type:
        comparison = await compare_assets(asset_types=[asset_type])
        rows += [("assetClassStats", c) for c in comparison["assetClasses"]]
        movers = await top_movers(asset_type=asset_type, window_days=180, limit=5)
        rows += [("comparableTicker", m) for m in movers if m.get("ticker") != symbol][:4]

    rows += [
        ("recentTrade", _trade_row(t))
        for t in await get_recent_trades_by_ticker(symbol, 5)
    ]
    question = (
        f"Write a comparative insight about congressional trading in {symbol} "
        f"({features.get('name', symbol)}): how members trade it, its estimated "
        "performance vs the SPY benchmark, and how it sits within its asset "
        "class and against the comparable tickers provided."
    )
    return await _insight("asset", symbol, question, rows)


async def member_insight(bioguide_id: str) -> dict | None:
    """Templated insight for one member's trading pattern."""
    features = await get_features_by_member(bioguide_id)
    if not features:
        return None
    key = features["bioguideId"]
    rows: list[tuple[str, dict]] = [("memberFeatures", features)]

    classes = list(features.get("assetTypes") or {})[:2]
    if classes:
        comparison = await compare_assets(asset_types=classes)
        rows += [("assetClassStats", c) for c in comparison["assetClasses"]]

    rows += [
        ("recentTrade", _trade_row(t))
        for t in await get_recent_trades_by_bioguide(key, 8)
    ]
    question = (
        f"Write an insight about the congressional trading pattern of "
        f"{features.get('name', key)}: trading frequency, buy/sell balance, "
        "holding periods, sector concentration, estimated P/L vs SPY, and how "
        "their asset-class exposure compares to Congress overall."
    )
    return await _insight("member", key, question, rows)


async def compare_insight(
    tickers: list[str] | None = None, asset_types: list[str] | None = None
) -> dict | None:
    """Templated side-by-side insight across tickers and/or asset classes."""
    comparison = await compare_assets(tickers=tickers, asset_types=asset_types)
    rows: list[tuple[str, dict]] = [
        *(("tickerFeatures", t) for t in comparison["tickers"]),
        *(("assetClassStats", c) for c in comparison["assetClasses"]),
    ]
    if not rows:
        return None
    entity = " vs ".join(
        [t["ticker"] for t in comparison["tickers"]]
        + [c["assetType"] for c in comparison["assetClasses"]]
    )
    question = (
        f"Compare congressional trading across {entity}: activity and "
        "participation, estimated performance vs SPY where available, and the "
        "most notable differences."
    )
    return await _insight("compare", entity, question, rows)


async def asset_class_insight(asset_type: str) -> dict | None:
    """Templated insight for one asset class, benchmarked against equities."""
    normalized = normalize_asset_type(asset_type)
    wanted = [normalized] if normalized == "stock" else [normalized, "stock"]
    comparison = await compare_assets(asset_types=wanted)
    classes = comparison["assetClasses"]
    if not classes or classes[0]["assetType"] != normalized:
        return None
    rows: list[tuple[str, dict]] = [("assetClassStats", c) for c in classes]
    rows += [
        ("topMoverInClass", m)
        for m in await top_movers(asset_type=normalized, window_days=365, limit=5)
    ]
    question = (
        f"Write an insight about congressional {normalized} trading as an asset "
        "class: its scale and participation, chamber and party split, notable "
        "tickers, and how it compares to the stock baseline where provided. "
        "Call out thin coverage explicitly if the class is sparsely traded."
    )
    return await _insight("asset-class", normalized, question, rows)
