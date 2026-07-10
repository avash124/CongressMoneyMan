"""Single-trade detail with price snapshots and P/L (port of lib/trades.ts)."""

import asyncio

from ..clients.prices import get_day_snapshot, get_latest_snapshot
from ..clients.quiver import (
    classify_transaction,
    fetch_all_congress_trades,
    fetch_member_congress_trades,
    find_matching_purchase,
    find_matching_sale,
    parse_trade_range,
)
from ..config import quiver_api_key


def _to_leg(trade: dict) -> dict:
    return {
        "date": trade.get("Date") or "",
        "range": trade.get("Range") or "",
        "transactionType": trade.get("Transaction") or "",
    }


def _compute_profit_loss(
    buy_price: float | None,
    sell_snapshot: dict | None,
    today_snapshot: dict | None,
    trade_range: dict | None,
) -> dict | None:
    if buy_price is None or buy_price <= 0 or not trade_range:
        return None

    exit_price: float | None = None
    exit_basis = "current"
    if sell_snapshot and sell_snapshot.get("close") is not None:
        exit_price = sell_snapshot["close"]
        exit_basis = "sale"
    elif today_snapshot and today_snapshot.get("close") is not None:
        exit_price = today_snapshot["close"]
        exit_basis = "current"
    if exit_price is None:
        return None

    pct_change = ((exit_price - buy_price) / buy_price) * 100
    return {
        "buyPrice": buy_price,
        "exitPrice": exit_price,
        "exitBasis": exit_basis,
        "pctChange": pct_change,
        "plLow": trade_range["low"] * (pct_change / 100),
        "plHigh": trade_range["high"] * (pct_change / 100),
    }


async def load_trade_detail(trade_id: str) -> dict | None:
    api_key = quiver_api_key()
    if not api_key:
        return None
    bioguide = trade_id.split("|")[0] if trade_id else ""
    try:
        all_trades = (
            await fetch_member_congress_trades(bioguide, api_key) if bioguide else []
        )
        if not any(str(t.get("UniqueID")) == trade_id for t in all_trades):
            all_trades = await fetch_all_congress_trades(api_key)
    except Exception:
        return None

    clicked = next(
        (t for t in all_trades if str(t.get("UniqueID")) == trade_id), None
    )
    if not clicked:
        return None
    kind = classify_transaction(clicked.get("Transaction"))
    buy_trade = find_matching_purchase(all_trades, clicked) if kind == "sell" else clicked
    sell_trade = clicked if kind == "sell" else find_matching_sale(all_trades, clicked)

    ticker = clicked.get("Ticker") or ""
    has_ticker = bool(ticker) and ticker != "-"

    async def none() -> None:
        return None

    buy_snapshot, sell_snapshot, today_snapshot = await asyncio.gather(
        get_day_snapshot(ticker, buy_trade["Date"])
        if buy_trade and buy_trade.get("Date") and has_ticker
        else none(),
        get_day_snapshot(ticker, sell_trade["Date"])
        if sell_trade and sell_trade.get("Date") and has_ticker
        else none(),
        get_latest_snapshot(ticker) if has_ticker else none(),
    )

    profit_loss = _compute_profit_loss(
        (buy_snapshot or {}).get("close"),
        sell_snapshot,
        today_snapshot,
        parse_trade_range(buy_trade.get("Range") if buy_trade else None),
    )

    return {
        "id": trade_id,
        "ticker": ticker,
        "assetName": clicked.get("AssetDescription") or "",
        "memberName": clicked.get("Representative") or "",
        "bioguideId": clicked.get("Bioguide") or "",
        "chamber": clicked.get("Chamber") or "",
        "party": clicked.get("Party") or "",
        "buy": _to_leg(buy_trade) if buy_trade else None,
        "sell": _to_leg(sell_trade) if sell_trade else None,
        "buySnapshot": buy_snapshot,
        "sellSnapshot": sell_snapshot,
        "todaySnapshot": today_snapshot,
        "profitLoss": profit_loss,
    }
