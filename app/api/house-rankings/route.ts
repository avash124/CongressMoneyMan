import { NextResponse } from "next/server"
import { getHouseRankings } from "@/lib/rankings"

export const revalidate = 3600

export async function GET() {
  try {
    const data = await getHouseRankings()
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build House rankings"
    return NextResponse.json(
      { byNetWorth: [], byStockHoldings: [], error: message },
      { status: 500 }
    )
  }
}
