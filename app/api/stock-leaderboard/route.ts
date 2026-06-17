import { NextResponse } from "next/server"
import { getHoldingsLeaderboard, getStockPerformance } from "@/lib/stockLeaderboard"
export const revalidate = 1800
export const maxDuration = 300

export async function GET() {
  try {
    const [holdings, performance] = await Promise.all([
      getHoldingsLeaderboard(),
      getStockPerformance(),
    ])
    return NextResponse.json({ holdings, performance, generatedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load stock leaderboard"
    console.error("[stock-leaderboard]", message)
    return NextResponse.json({ holdings: [], performance: [], error: message }, { status: 500 })
  }
}
