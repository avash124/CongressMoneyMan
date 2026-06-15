import { NextResponse } from "next/server"
import { backfillTrades } from "@/lib/sync"

// Daily: pull Quiver's full multi-year bulk history and persist it so member
// profiles show every disclosed trade, not just the recent live-feed window.
// Heavier than the 15-min live sync (dozens of paginated requests), so it runs
// once a day and needs a longer execution budget.
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  try {
    const result = await backfillTrades()
    return NextResponse.json({ ok: true, ...result, syncedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to backfill trades"
    console.error("[cron/backfill-trades]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
