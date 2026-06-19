import { NextResponse } from "next/server"
import { getPacDonationLeaderboard } from "@/lib/pacDonations"

export const revalidate = 1800
export const maxDuration = 60

export async function GET() {
  try {
    const donations = await getPacDonationLeaderboard()
    return NextResponse.json({ donations, generatedAt: new Date().toISOString() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load PAC donations"
    console.error("[pac-donations]", message)
    return NextResponse.json({ donations: [], error: message }, { status: 500 })
  }
}
