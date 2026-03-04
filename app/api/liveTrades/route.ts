import { NextResponse } from "next/server"

type MemberSummary = {
  id: string
}

type MembersResponse = {
  members?: MemberSummary[]
}

type LiveTradeRow = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number | string,
  string,
  string,
  string,
]

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

async function getIncumbentIds(request: Request): Promise<Set<string>> {
  const [houseResponse, senateResponse] = await Promise.all([
    fetch(new URL("/api/house-members", request.url), {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    }),
    fetch(new URL("/api/senate-members", request.url), {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    }),
  ])

  if (!houseResponse.ok || !senateResponse.ok) {
    throw new Error("Failed to load incumbent member lists")
  }

  const [housePayload, senatePayload] = (await Promise.all([
    houseResponse.json(),
    senateResponse.json(),
  ])) as [MembersResponse, MembersResponse]

  return new Set(
    [...(housePayload.members ?? []), ...(senatePayload.members ?? [])].map(
      (member) => member.id
    )
  )
}

function parseRecentTradesData(html: string): LiveTradeRow[] {
  const match = html.match(/let recentTradesData = (\[[\s\S]*?\]);/)
  if (!match?.[1]) {
    return []
  }

  try {
    return Function(`"use strict"; return (${match[1]});`)() as LiveTradeRow[]
  } catch {
    return []
  }
}

function normalizeParty(value: string): "D" | "R" | "I" {
  if (value === "D" || value === "R") {
    return value
  }

  return "I"
}

function normalizeLiveTrade(row: LiveTradeRow): LiveTrade {
  return {
    amount: row[4],
    assetName: row[1],
    assetType: row[2],
    bioguideId: row[15],
    chamber: row[6],
    filedAt: row[8],
    id: row[11],
    memberName: row[5],
    party: normalizeParty(row[7]),
    ticker: row[0],
    tradeDate: row[9],
    transactionType: row[3],
  }
}

export async function GET(request: Request) {
  try {
    const incumbentIds = await getIncumbentIds(request)
    const response = await fetch("https://www.quiverquant.com/congresstrading/", {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      next: { revalidate: 900 },
    })

    if (!response.ok) {
      throw new Error("Failed to load live trade data")
    }

    const html = await response.text()
    const trades = parseRecentTradesData(html)
      .filter((row) => incumbentIds.has(row[15]))
      .map(normalizeLiveTrade)
      .sort((left, right) => {
        const filedCompare =
          Date.parse(right.filedAt.replace(" ", "T")) -
          Date.parse(left.filedAt.replace(" ", "T"))

        if (filedCompare !== 0) {
          return filedCompare
        }

        return (
          Date.parse(right.tradeDate.replace(" ", "T")) -
          Date.parse(left.tradeDate.replace(" ", "T"))
        )
      })

    return NextResponse.json({
      trades,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load live trades"

    return NextResponse.json(
      {
        trades: [],
        error: message,
      },
      { status: 500 }
    )
  }
}
