import { NextResponse } from "next/server"
import { syncMembers } from "@/lib/sync"

// Daily ETL: snapshot the current House + Senate rosters into the `members` table.
// Cheap (3 Congress.gov pages, no fan-out). Members change rarely.
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
    const result = await syncMembers()
    return NextResponse.json({ ok: true, ...result, syncedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync members"
    console.error("[cron/sync-members]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
