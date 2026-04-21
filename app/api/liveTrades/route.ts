import { NextResponse } from "next/server"

type QuiverLiveTrade = {
  Date?: string
  Ticker?: string
  Transaction?: string
  Range?: string
  ReportDate?: string
  Representative?: string
  Party?: string
  Chamber?: string
  Bioguide?: string
  UniqueID?: string | number
  AssetDescription?: string
  AssetType?: string
}

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

function mapQuiverTrade(trade: QuiverLiveTrade, index: number): LiveTrade {
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
  try {
    const apiKey = process.env.QUIVER_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { trades: [], error: "Missing QUIVER_API_KEY environment variable" },
        { status: 500 }
      )
    }

    const response = await fetch(
      "https://api.quiverquant.com/beta/live/congresstrading",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "CongressMoneyMan/1.0",
        },
        next: { revalidate: 900 },
      }
    )

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(
        `Quiver API error ${response.status}: ${body.slice(0, 200)}`
      )
    }

    const data = (await response.json()) as QuiverLiveTrade[]

    if (!Array.isArray(data)) {
      throw new Error("Unexpected response format from Quiver API")
    }

    const trades = data
      .filter((trade) => Boolean(trade.Bioguide))
      .map(mapQuiverTrade)
      .sort((left, right) => {
        const filedCompare =
          Date.parse(right.filedAt) - Date.parse(left.filedAt)
        if (filedCompare !== 0) return filedCompare
        return Date.parse(right.tradeDate) - Date.parse(left.tradeDate)
      })

    return NextResponse.json({
      trades,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load live trades"
    console.error("[liveTrades]", message)
    return NextResponse.json(
      { trades: [], error: message },
      { status: 500 }
    )
  }
}
