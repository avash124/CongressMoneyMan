import { NextResponse } from "next/server"
import {
  fetchAllCongressTrades,
  QuiverCircuitOpenError,
  type RawCongressTrade,
} from "@/lib/quiver"

export const revalidate = 900

// The page surfaces the most-recent disclosures across all of Congress. Both
// sources of the feed (Quiver's live endpoint and the DB-backed recent slice)
// hold ~1000 rows; cap here so the page renders exactly the 1000 newest
// regardless of source.
const LIVE_TRADES_LIMIT = 1000

type LiveTrade = {
  amount: string
  assetName: string
  assetType: string
  bioguideId: string
  chamber: string
  filedAt: string
  id: string
  memberName: string
  party: "D" | "R" | "I"
  ticker: string
  tradeDate: string
  transactionType: string
}

function normalizeParty(value?: string): "D" | "R" | "I" {
  const v = value?.trim().toUpperCase() ?? ""
  if (v === "D" || v.startsWith("DEM")) return "D"
  if (v === "R" || v.startsWith("REP")) return "R"
  return "I"
}

function mapQuiverTrade(trade: RawCongressTrade, index: number): LiveTrade {
  return {
    amount: trade.Range ?? "",
    assetName: trade.AssetDescription ?? "",
    assetType: trade.AssetType ?? "",
    bioguideId: trade.Bioguide ?? "",
    chamber: trade.Chamber ?? "",
    filedAt: trade.ReportDate ?? "",
    id: String(trade.UniqueID ?? index),
    memberName: trade.Representative ?? "",
    party: normalizeParty(trade.Party),
    ticker: trade.Ticker ?? "-",
    tradeDate: trade.Date ?? "",
    transactionType: trade.Transaction ?? "",
  }
}

export async function GET() {
  const apiKey = process.env.QUIVER_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { trades: [], error: "Missing QUIVER_API_KEY environment variable" },
      { status: 500 }
    )
  }

  try {
    const data = await fetchAllCongressTrades(apiKey)

    const trades = data
      .filter((trade) => Boolean(trade.Bioguide))
      .map(mapQuiverTrade)
      .sort((left, right) => {
        const filedCompare = Date.parse(right.filedAt) - Date.parse(left.filedAt)
        if (filedCompare !== 0) return filedCompare
        return Date.parse(right.tradeDate) - Date.parse(left.tradeDate)
      })
      .slice(0, LIVE_TRADES_LIMIT)

    return NextResponse.json({
      trades,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    // An open circuit breaker is a transient upstream condition (Quiver is
    // rate-limiting or down), not a client error — degrade to an empty,
    // non-error response so the UI shows "temporarily unavailable" instead of a
    // scary failure banner, and retries naturally on the next load.
    if (error instanceof QuiverCircuitOpenError) {
      console.warn("[liveTrades] circuit breaker open — serving empty trades")
      return NextResponse.json({ trades: [], unavailable: true })
    }
    const message = error instanceof Error ? error.message : "Failed to load live trades"
    console.error("[liveTrades]", message)
    return NextResponse.json({ trades: [], error: message }, { status: 500 })
  }
}
