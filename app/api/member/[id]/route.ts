// app/api/member/[id]/route.ts

import { NextResponse } from "next/server"
import { Member } from "@/types/member"

function mapCongressMemberToMember(member: any): Member {
  const terms = member.terms ?? []
  const latestTerm = terms[terms.length - 1]

  const chamber = latestTerm.chamber

  const district =
    chamber === "Senate"
      ? "Senate"
      : `District ${member.district}`

  return {
    id: member.bioguideId,
    name: `${member.firstName} ${member.lastName}`,
    party:
      member.partyName === "Democratic"
        ? "D"
        : member.partyName === "Republican"
        ? "R"
        : "I",
    state: member.state,
    district,
    totalRaised: 0,
    totalSpent: 0,
    topIndustries: [],
    pacDonations: []
  }
}

function formatTradeRange(lowerBound: number): string {
  const ranges = [
    [1, 1000],
    [1001, 15000],
    [15001, 50000],
    [50001, 100000],
    [100001, 250000],
    [250001, 500000],
    [500001, 1000000],
    [1000001, 5000000],
    [5000001, 25000000],
    [25000001, 50000000],
  ]

  for (const [min, max] of ranges) {
    if (lowerBound === min) {
      return `$${min.toLocaleString()} – $${max.toLocaleString()}`
    }
  }

  if (lowerBound >= 50000001) {
    return `$${lowerBound.toLocaleString()}+`
  }

  return `$${lowerBound.toLocaleString()}`
}

async function getCongressTrades(bioguideId: string) {
  const res = await fetch(
    `https://api.quiverquant.com/beta/bulk/congresstrading?bioguide_id=${bioguideId}&page_size=20`,
    {
      headers: {
        Authorization: `Bearer ${process.env.QUIVER_API_KEY!}`,
        Accept: "application/json",
        "User-Agent": "CongressMoneyMan/1.0",
      },
    }
  )

  console.log("Quiver status:", res.status)

  if (!res.ok) {
    console.log(await res.text())
    return []
  }

  const data = await res.json()

  return data.map((trade: any) => ({
    ticker: trade.Ticker,
    transactionType: trade.Transaction,
    transactionDate: trade.Traded,
    amount: formatTradeRange(Number(trade.Trade_Size_USD)),
  }))
}

async function getFecCandidateId(
  firstName: string,
  lastName: string,
  state: string,
  chamber: string
) {
  const office = chamber === "Senate" ? "S" : "H"

  const res = await fetch(
    `https://api.open.fec.gov/v1/candidates/?state=${state}&office=${office}&per_page=100&api_key=${process.env.FEC_API_KEY}`,
    { next: { revalidate: 3600 } }
  )

  if (!res.ok) {
    console.log("Candidate lookup error:", res.status)
    console.log(await res.text())
    return null
  }

  const data = await res.json()

  if (!data.results) {
    console.log("No candidates returned")
    return null
  }

  // Filter manually
  const match = data.results.find((c: any) =>
    c.name.toUpperCase().includes(lastName.toUpperCase())
  )

  if (!match) {
    console.log("No matching candidate found")
    console.log("Returned names:", data.results.map((c: any) => c.name))
    return null
  }

  console.log("Matched:", match.name)
  console.log("Candidate ID:", match.candidate_id)

  return match.candidate_id
}

async function getPacDonations(candidateId: string) {
  const res = await fetch(
    `https://api.open.fec.gov/v1/schedules/schedule_a/?candidate_id=${candidateId}&contributor_type=committee&two_year_transaction_period=2024&sort=-contribution_receipt_amount&per_page=20&api_key=${process.env.FEC_API_KEY}`,
    { next: { revalidate: 300 } }
  )

  if (!res.ok) {
    console.log("FEC error:", res.status)
    console.log(await res.text())
    return []
  }

  const data = await res.json()

  if (!data.results) return []

  return data.results.map((donation: any) => ({
    pacName: donation.committee_name,
    amount: donation.contribution_receipt_amount,
    date: donation.contribution_receipt_date,
  }))
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params 

  const res = await fetch(
    `https://api.congress.gov/v3/member/${id}?format=json`,
    {
      headers: {
        "X-Api-Key": process.env.CONGRESS_API_KEY!,
      },
    }
  )

  if (!res.ok) {
    console.log("Status:", res.status)
    console.log("Status text:", res.statusText)
    return NextResponse.json({ error: "Congress API error" }, { status: 500 })
  }

  const data = await res.json()

  const rawMember = data.member

  if (!rawMember) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const formatted = mapCongressMemberToMember(rawMember)
  const trades = await getCongressTrades(formatted.id)
  const chamber = rawMember.terms?.[rawMember.terms.length - 1]?.chamber

  const candidateId = await getFecCandidateId(
    rawMember.firstName,
    rawMember.lastName,
    rawMember.state,
    chamber
  )

  let pacDonations = []

  if (candidateId) {
    pacDonations = await getPacDonations(candidateId)
  }

  return NextResponse.json({
    ...formatted,
    trades,
    pacDonations,
  })
}