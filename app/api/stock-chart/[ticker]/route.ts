import { NextResponse } from "next/server"
import { getPriceHistory, type ChartRange } from "@/lib/prices"
export const revalidate = 900

const RANGES: ChartRange[] = ["24H", "1W", "1M", "6M", "1Y", "5Y"]

export async function GET(
  request: Request,
  context: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await context.params
    const requested = new URL(request.url).searchParams.get("range")
    const range = RANGES.includes(requested as ChartRange)
      ? (requested as ChartRange)
      : "1M"

    const points = await getPriceHistory(ticker.toUpperCase(), range)
    return NextResponse.json({ ticker: ticker.toUpperCase(), range, points })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load chart"
    console.error("[stock-chart]", message)
    return NextResponse.json({ error: message, points: [] }, { status: 500 })
  }
}
