import { NextResponse } from "next/server"
import { syncTrades } from "@/lib/sync"

// Every 15 min: pull a fresh live-trades feed straight from Quiver and persist it.
// This is the only place the feed is fetched on a schedule — user reads serve
// from Redis -> DB.
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  try {
    const result = await syncTrades()
    return NextResponse.json({ ok: true, ...result, syncedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync trades"
    console.error("[cron/sync-trades]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
