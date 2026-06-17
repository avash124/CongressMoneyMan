import { NextResponse } from "next/server"
import { syncStockPerformance } from "@/lib/sync"
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
    const result = await syncStockPerformance()
    return NextResponse.json({ ok: true, ...result, refreshedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh stock performance"
    console.error("[cron/refresh-stocks]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
