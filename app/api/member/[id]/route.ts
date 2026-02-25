import { NextResponse } from "next/server"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: candidateId } = await params
  const apiKey = process.env.FEC_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key" },
      { status: 500 }
    )
  }

  try {
    // 1️⃣ Candidate info (correct endpoint)
    const candidateRes = await fetch(
      `https://api.open.fec.gov/v1/candidates/search/?candidate_id=${candidateId}&api_key=${apiKey}`
    )

    const candidateData = await candidateRes.json()

    // 2️⃣ Totals
    const totalsRes = await fetch(
      `https://api.open.fec.gov/v1/candidate/${candidateId}/totals/?api_key=${apiKey}`
    )

    const totalsData = await totalsRes.json()

    return NextResponse.json({
      candidate: candidateData.results?.[0] ?? null,
      totals: totalsData.results?.[0] ?? null,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch from FEC" },
      { status: 500 }
    )
  }
}