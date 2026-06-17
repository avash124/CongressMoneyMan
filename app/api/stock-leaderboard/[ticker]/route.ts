import { NextResponse } from "next/server"
import { getTickerHolders } from "@/lib/stockLeaderboard"
export const revalidate = 1800

export async function GET(
  _req: Request,
  context: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await context.params
    const data = await getTickerHolders(ticker)
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load holders"
    console.error("[stock-leaderboard/ticker]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
