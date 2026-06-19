import { NextResponse } from "next/server"
import { getPacRecipients } from "@/lib/pacProfile"

export const revalidate = 1800
export const maxDuration = 60

export async function GET(
  _request: Request,
  context: { params: Promise<{ pac: string }> }
) {
  const { pac } = await context.params
  const pacName = decodeURIComponent(pac)
  try {
    const data = await getPacRecipients(pacName)
    return NextResponse.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load PAC recipients"
    console.error("[pac-donations/[pac]]", message)
    return NextResponse.json(
      { pacName, totalAmount: 0, houseCount: 0, senateCount: 0, recipients: [], error: message },
      { status: 500 }
    )
  }
}
