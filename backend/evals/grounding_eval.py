"""Phase 4 golden-set eval with hallucination guard.

Builds up to 30 question/context cases from the live feature tables, generates
each insight, regex-extracts the numeric claims from the output, and asserts
every claim appears in the supplied context (1% relative tolerance for
readability rounding like "$5.0M" for 4,969,382).

    .venv/Scripts/python evals/grounding_eval.py --limit 6      (from backend/)

Generation costs money — --limit bounds the number of cases (default 6; use
--limit 30 for the full set). Needs Anthropic credentials; prints what is
missing otherwise. Also prints cacheReadInputTokens per case so prompt-cache
behavior is observable across consecutive calls.
"""

import argparse
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config

_CITATION_RE = re.compile(r"\[\d+\]")
_DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_NUM_RE = re.compile(
    r"(\$?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"\s*(million|billion|thousand|[MBKmbk])?\b\s*(%?)"
)
_MULTIPLIERS = {"thousand": 1e3, "k": 1e3, "million": 1e6, "m": 1e6, "billion": 1e9, "b": 1e9}


def extract_numeric_claims(text: str) -> list[float]:
    """Numbers the model asserted: $ / % / magnitude-suffixed values and any
    other number, except ISO dates, [n] citations, and bare structural ints
    under 10 ("top 5", "3 paragraphs")."""
    cleaned = _DATE_RE.sub(" ", _CITATION_RE.sub(" ", text))
    claims: list[float] = []
    for match in _NUM_RE.finditer(cleaned):
        dollar, raw, suffix, pct = match.groups()
        value = float(raw.replace(",", ""))
        if suffix:
            value *= _MULTIPLIERS[suffix.lower()]
        marked = bool(dollar) or bool(pct) or bool(suffix)
        if not marked and value < 10 and value == int(value):
            continue
        claims.append(value)
    return claims


def context_numbers(context: str) -> list[float]:
    cleaned = _DATE_RE.sub(" ", context)
    return [
        float(match.group(2).replace(",", ""))
        for match in _NUM_RE.finditer(cleaned)
    ]


def _matches(claim: float, number: float) -> bool:
    if claim == number:
        return True
    return bool(number) and abs(claim - number) / abs(number) <= 0.01


def unsupported_claims(text: str, context: str) -> list[float]:
    """Numeric claims in `text` that no context number supports."""
    numbers = context_numbers(context)
    return [
        claim
        for claim in extract_numeric_claims(text)
        if not any(_matches(claim, number) for number in numbers)
    ]


async def _build_cases() -> list[tuple[str, object]]:
    from app.core.db import get_priced_ticker_features, get_trade_features_by_scope

    members = await get_trade_features_by_scope("member")
    members.sort(key=lambda r: r.get("trade_count") or 0, reverse=True)
    tickers = await get_priced_ticker_features()
    tickers.sort(key=lambda r: abs(r.get("est_pl_pct") or 0), reverse=True)

    by_kind: list[list[tuple[str, object]]] = [
        [("member", row["entity_key"]) for row in members[:10]],
        [("asset", row["entity_key"]) for row in tickers[:10]],
        [
            ("compare", (["NVDA", "MSFT"], None)),
            ("compare", (["AAPL", "TSLA"], None)),
            ("compare", (None, ["stock", "etf"])),
            ("compare", (None, ["stock", "crypto"])),
            ("compare", (["SPY"], ["stock"])),
        ],
        [("class", t) for t in ("stock", "etf", "crypto", "option", "bond")],
    ]
    interleaved: list[tuple[str, object]] = []
    for i in range(max(len(group) for group in by_kind)):
        interleaved += [group[i] for group in by_kind if i < len(group)]
    return interleaved[:30]


async def _run_case(kind: str, arg) -> dict | None:
    from app.services import insights

    if kind == "member":
        return await insights.member_insight(arg)
    if kind == "asset":
        return await insights.asset_insight(arg)
    if kind == "compare":
        tickers, asset_types = arg
        return await insights.compare_insight(tickers=tickers, asset_types=asset_types)
    return await insights.asset_class_insight(arg)


async def main() -> int:
    from app.core.http import close_client
    from app.services.insights import _anthropic_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=6)
    args = parser.parse_args()

    if _anthropic_client() is None:
        print("Anthropic credentials unavailable (set ANTHROPIC_API_KEY in "
              ".env.local, or `ant auth login`). Cannot generate.")
        return 1

    cases = (await _build_cases())[: args.limit]
    if not cases:
        print("No cases — are the trade_features tables populated?")
        return 1

    grounded, failed, skipped = 0, [], 0
    for kind, arg in cases:
        result = await _run_case(kind, arg)
        label = f"{kind}:{arg}"
        if result is None:
            print(f"SKIP  {label} (no data or generation failed)")
            skipped += 1
            continue
        bad = unsupported_claims(result["insight"], result["context"])
        cache_read = result["usage"].get("cacheReadInputTokens")
        if bad:
            failed.append((label, bad))
            print(f"FAIL  {label} — unsupported claims: {bad} "
                  f"(cacheRead={cache_read})")
            print(f"      insight: {result['insight'][:300]}...")
        else:
            grounded += 1
            print(f"PASS  {label} (cacheRead={cache_read})")

    scored = len(cases) - skipped
    print(f"\ngrounded: {grounded}/{scored}" if scored else "\nnothing scored")
    for label, bad in failed:
        print(f"  ungrounded in {label}: {bad}")
    await close_client()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
