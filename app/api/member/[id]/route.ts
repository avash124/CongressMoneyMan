import { NextResponse } from "next/server"
import { loadMemberProfile } from "@/lib/profile"

export const revalidate = 900

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const member = await loadMemberProfile(id)

    if (!member) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    return NextResponse.json(member)
  } catch (error) {
    console.error("Route error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
