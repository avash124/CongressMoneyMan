import { NextResponse } from "next/server"
import { fetchHouseMembers } from "@/lib/congress"

export const revalidate = 3600

export async function GET() {
  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY", members: [] },
      { status: 500 }
    )
  }

  try {
    const members = await fetchHouseMembers(apiKey)

    if (members.length === 0) {
      return NextResponse.json(
        { error: "Congress.gov returned no current House district members.", members: [] },
        { status: 502 }
      )
    }

    return NextResponse.json({ members })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch House members"
    return NextResponse.json({ error: message, members: [] }, { status: 500 })
  }
}
