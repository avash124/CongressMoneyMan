import { NextResponse } from "next/server"

type HouseMember = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string
}

type HouseMembersResponse = {
  members?: HouseMember[]
  error?: string
}

type RankingRow = HouseMember & {
  netWorth: number | null
  stockHoldings: number | null
}

type QuiverTabResponse = {
  holdings_data?: {
    politician_net_worth_live?: string
  }
  live_stock_portfolio?: {
    live_stock_portfolio?: string
  }
}

const QUIVER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "CongressMoneyMan/1.0",
  "X-Requested-With": "XMLHttpRequest",
}

function parseJsonArray(value: string | undefined): unknown[] {
  if (!value) return []

  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getLiveNetWorth(payload: QuiverTabResponse): number | null {
  const values = parseJsonArray(payload.holdings_data?.politician_net_worth_live)
  const value = values[0]

  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function getLiveStockHoldings(payload: QuiverTabResponse): number | null {
  const positions = parseJsonArray(payload.live_stock_portfolio?.live_stock_portfolio)
  let total = 0
  let foundPosition = false

  for (const position of positions) {
    if (!Array.isArray(position)) continue

    const value = position[1]
    if (typeof value !== "number" || !Number.isFinite(value)) continue

    total += value
    foundPosition = true
  }

  return foundPosition ? total : null
}

function compareRankingValues(
  left: number | null,
  right: number | null
): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1

  return right - left
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let currentIndex = 0

  async function worker() {
    while (currentIndex < items.length) {
      const nextIndex = currentIndex
      currentIndex += 1
      results[nextIndex] = await mapper(items[nextIndex])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  )

  return results
}

async function getHouseMembers(request: Request): Promise<HouseMember[]> {
  const response = await fetch(new URL("/api/house-members", request.url), {
    headers: {
      Accept: "application/json",
    },
    next: { revalidate: 3600 },
  })

  if (!response.ok) {
    throw new Error("Failed to load House members")
  }

  const payload = (await response.json()) as HouseMembersResponse
  return payload.members ?? []
}

async function getRankingRow(member: HouseMember): Promise<RankingRow> {
  try {
    const response = await fetch(
      `https://www.quiverquant.com/get_politician_page_tab_data/${member.id}`,
      {
        headers: QUIVER_HEADERS,
        next: { revalidate: 3600 },
      }
    )

    if (!response.ok) {
      return {
        ...member,
        netWorth: null,
        stockHoldings: null,
      }
    }

    const payload = (await response.json()) as QuiverTabResponse

    return {
      ...member,
      netWorth: getLiveNetWorth(payload),
      stockHoldings: getLiveStockHoldings(payload),
    }
  } catch {
    return {
      ...member,
      netWorth: null,
      stockHoldings: null,
    }
  }
}

export async function GET(request: Request) {
  try {
    const members = await getHouseMembers(request)
    const rankings = await mapWithConcurrency(members, 12, getRankingRow)

    const byStockHoldings = [...rankings].sort((left, right) => {
      const valueCompare = compareRankingValues(
        left.stockHoldings,
        right.stockHoldings
      )

      if (valueCompare !== 0) return valueCompare
      return left.name.localeCompare(right.name)
    })

    const byNetWorth = [...rankings].sort((left, right) => {
      const valueCompare = compareRankingValues(left.netWorth, right.netWorth)

      if (valueCompare !== 0) return valueCompare
      return left.name.localeCompare(right.name)
    })

    return NextResponse.json({
      byNetWorth,
      byStockHoldings,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to build House rankings"

    return NextResponse.json(
      {
        byNetWorth: [],
        byStockHoldings: [],
        error: message,
      },
      { status: 500 }
    )
  }
}
