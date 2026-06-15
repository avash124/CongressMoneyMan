import { NextResponse } from "next/server"
import { refreshAllRankings } from "@/lib/rankings"
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

  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: "Missing CONGRESS_API_KEY" }, { status: 500 })
  }

  try {
    // One interleaved fan-out across both chambers so neither starves the shared
    // Quiver rate budget (see refreshAllRankings).
    const { house, senate } = await refreshAllRankings(apiKey)

    return NextResponse.json({
      ok: true,
      house: house.byNetWorth.length,
      senate: senate.byNetWorth.length,
      refreshedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh rankings"
    console.error("[cron/refresh-rankings]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
