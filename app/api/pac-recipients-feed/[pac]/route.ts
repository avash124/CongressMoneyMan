import { NextResponse } from "next/server"
import { getPacContributionFeed } from "@/lib/pacProfile"

export const revalidate = 3600
export const maxDuration = 60

export async function GET(
  _request: Request,
  context: { params: Promise<{ pac: string }> }
) {
  const { pac } = await context.params
  const pacName = decodeURIComponent(pac)
  try {
    const data = await getPacContributionFeed(pacName)
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load PAC contribution feed"
    console.error("[pac-recipients-feed/[pac]]", message)
    return NextResponse.json(
      { committeeId: null, members: [], contributions: [], error: message },
      { status: 500 }
    )
  }
}
