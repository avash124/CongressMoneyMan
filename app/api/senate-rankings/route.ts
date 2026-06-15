import { NextResponse } from "next/server"
import { getSenateRankings } from "@/lib/rankings"

export const revalidate = 3600

export async function GET() {
  try {
    const data = await getSenateRankings()
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build Senate rankings"
    return NextResponse.json(
      { byNetWorth: [], byStockHoldings: [], error: message },
      { status: 500 }
    )
  }
}
