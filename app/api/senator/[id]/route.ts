import { NextResponse } from "next/server"
import { loadSenatorProfile } from "@/lib/profile"

export const revalidate = 900

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const senator = await loadSenatorProfile(id)

    if (!senator) {
      return NextResponse.json({ error: "Senator not found" }, { status: 404 })
    }

    return NextResponse.json(senator)
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
