import { NextResponse } from "next/server"
import { getPacSpending } from "@/lib/pacProfile"

export const revalidate = 3600
export const maxDuration = 60

export async function GET(
  _request: Request,
  context: { params: Promise<{ pac: string }> }
) {
  const { pac } = await context.params
  const pacName = decodeURIComponent(pac)
  try {
    const { committeeId, points } = await getPacSpending(pacName)
    return NextResponse.json({ committeeId, points })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load PAC spending"
    console.error("[pac-chart/[pac]]", message)
    return NextResponse.json({ committeeId: null, points: [], error: message }, { status: 500 })
  }
}
