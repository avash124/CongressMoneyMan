import { NextResponse } from "next/server"
import type { Trade } from "@/types/member"

type QuiverTradeRecord = {
  Amount?: number | string
  BioGuideID?: string
  Filed?: string
  Range?: string
  ReportDate?: string
  Ticker?: string
  Trade_Size_USD?: number | string
  Transaction?: string
  TransactionDate?: string
  Traded?: string
}

function isBioguideId(id: string): boolean {
  return /^[A-Z]\d{6}$/i.test(id)
}

function formatTradeRange(lowerBound: number): string {
  const ranges = [
    [1, 1000],
    [1001, 15000],
    [15001, 50000],
    [50001, 100000],
    [100001, 250000],
    [250001, 500000],
    [500001, 1000000],
    [1000001, 5000000],
    [5000001, 25000000],
    [25000001, 50000000],
  ] as const

  for (const [min, max] of ranges) {
    if (lowerBound === min) {
      return `$${min.toLocaleString()} - $${max.toLocaleString()}`
    }
  }

  if (lowerBound >= 50000001) {
    return `$${lowerBound.toLocaleString()}+`
  }

  return `$${lowerBound.toLocaleString()}`
}

function formatTradeAmount(value?: number | string, range?: string): string {
  if (typeof range === "string" && range.trim()) {
    return range
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return "Unknown"
    if (trimmed.includes("$")) return trimmed

    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? formatTradeRange(numeric) : trimmed
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return formatTradeRange(value)
  }

  return "Unknown"
}

async function fetchQuiverTrades(url: string, apiKey: string): Promise<QuiverTradeRecord[]> {
  const headerVariants: Record<string, string>[] = [
    { Authorization: `Bearer ${apiKey}` },
    { Authorization: `Token ${apiKey}` },
    { "X-Api-Key": apiKey },
    { apikey: apiKey },
  ]

  for (const header of headerVariants) {
    try {
      const response = await fetch(url, {
        headers: {
          ...header,
          Accept: "application/json",
          "User-Agent": "CongressMoneyMan/1.0",
        },
        cache: "no-store",
      })

      if (!response.ok) {
        continue
      }

      const payload = (await response.json()) as unknown

      if (Array.isArray(payload)) {
        return payload as QuiverTradeRecord[]
      }

      if (
        payload &&
        typeof payload === "object" &&
        "data" in payload &&
        Array.isArray(payload.data)
      ) {
        return payload.data as QuiverTradeRecord[]
      }
    } catch {
      continue
    }
  }

  return []
}

function normalizeTrades(trades: QuiverTradeRecord[]): Trade[] {
  return [...trades]
    .sort((left, right) => {
      const rightDate =
        Date.parse(
          right.TransactionDate ?? right.Traded ?? right.Filed ?? right.ReportDate ?? ""
        ) || 0
      const leftDate =
        Date.parse(
          left.TransactionDate ?? left.Traded ?? left.Filed ?? left.ReportDate ?? ""
        ) || 0
      return rightDate - leftDate
    })
    .slice(0, 20)
    .map((trade) => ({
      ticker: trade.Ticker ?? "Unknown",
      transactionType: trade.Transaction ?? "Unknown",
      transactionDate:
        trade.TransactionDate ?? trade.Traded ?? trade.Filed ?? trade.ReportDate ?? "Unknown",
      amount: formatTradeAmount(trade.Trade_Size_USD ?? trade.Amount, trade.Range),
    }))
}

async function getTradesForBioguideId(bioguideId: string, apiKey: string): Promise<Trade[]> {
  const directTrades = await fetchQuiverTrades(
    `https://api.quiverquant.com/beta/bulk/congresstrading?bioguide_id=${bioguideId}&page_size=100&recent=false`,
    apiKey
  )

  if (directTrades.length > 0) {
    return normalizeTrades(directTrades)
  }

  const liveTrades = await fetchQuiverTrades(
    "https://api.quiverquant.com/beta/live/congresstrading?version=V2&page_size=5000&recent=false",
    apiKey
  )

  return normalizeTrades(
    liveTrades.filter(
      (trade) => (trade.BioGuideID ?? "").toUpperCase() === bioguideId.toUpperCase()
    )
  )
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  if (!isBioguideId(id)) {
    return NextResponse.json({ trades: [] })
  }

  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing QUIVER_API_KEY", trades: [] },
      { status: 500 }
    )
  }

  try {
    const trades = await getTradesForBioguideId(id, apiKey)
    return NextResponse.json({ trades })
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch trades", trades: [] },
      { status: 500 }
    )
  }
}
