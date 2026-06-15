import { NextResponse } from "next/server"
import { syncFec } from "@/lib/sync"

// Daily ETL: for every member resolve their FEC candidate, then persist headline
// totals (fec_candidates) and per-donor PAC aggregates (pac_donations). One FEC
// search + totals + donation pagination per member, so it fans out like the
// rankings job — kept slow + bounded to stay under FEC rate limits.
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
    const result = await syncFec()
    return NextResponse.json({ ok: true, ...result, syncedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync FEC data"
    console.error("[cron/sync-fec]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
