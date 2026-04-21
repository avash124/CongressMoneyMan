// app/api/member/[id]/route.ts
import { categorizeIndustry } from "./industryClassifier"
import { NextResponse } from "next/server"
import { Member, PacDonation} from "@/types/member"


function mapCongressMemberToMember(member: any): Member {
  const terms = member.terms ?? []
  const latestTerm = terms[terms.length - 1]
  const chamber = latestTerm?.chamber

  const district =
    chamber === "Senate"
      ? "Senate"
      : `District ${member.district}`

  const partyAbbrev =
    member.partyHistory?.[0]?.partyAbbreviation ?? ""

  const party =
    partyAbbrev === "D"
      ? "D"
      : partyAbbrev === "R"
      ? "R"
      : "I"

  return {
    id: member.bioguideId,
    name: `${member.firstName} ${member.lastName}`,
    party,
    state: member.state,
    district,
    totalRaised: 0,
    totalSpent: 0,
    topIndustries: [],
    pacDonations: [],
    trades: [],
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
  try {
    const apiKey = process.env.QUIVER_API_KEY
    if (!apiKey) {
      console.error("[getCongressTrades] QUIVER_API_KEY is not set")
      return []
    }

    const res = await fetch(
      "https://api.quiverquant.com/beta/live/congresstrading",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "CongressMoneyMan/1.0",
        },
        next: { revalidate: 900 },
      }
    )

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(
        `[getCongressTrades] Quiver API error ${res.status} for ${bioguideId}: ${body.slice(0, 200)}`
      )
      return []
    }

    const data = await res.json()

    if (!Array.isArray(data)) {
      console.error("[getCongressTrades] Unexpected response format:", typeof data)
      return []
    }

    return data
      .filter((trade: any) => trade.Bioguide === bioguideId)
      .map((trade: any) => ({
        ticker: trade.Ticker ?? "Unknown",
        transactionType: trade.Transaction ?? "Unknown",
        transactionDate: trade.Date ?? trade.Traded ?? "Unknown",
        amount: trade.Range ?? formatTradeRange(Number(trade.Trade_Size_USD)),
      }))
  } catch (err) {
    console.error("[getCongressTrades] Exception:", err)
    return []
  }
}

function getStateAbbreviation(stateName: string): string {
  const states: Record<string, string> = {
    Alabama: "AL",
    Alaska: "AK",
    Arizona: "AZ",
    Arkansas: "AR",
    California: "CA",
    Colorado: "CO",
    Connecticut: "CT",
    Delaware: "DE",
    Florida: "FL",
    Georgia: "GA",
    Hawaii: "HI",
    Idaho: "ID",
    Illinois: "IL",
    Indiana: "IN",
    Iowa: "IA",
    Kansas: "KS",
    Kentucky: "KY",
    Louisiana: "LA",
    Maine: "ME",
    Maryland: "MD",
    Massachusetts: "MA",
    Michigan: "MI",
    Minnesota: "MN",
    Mississippi: "MS",
    Missouri: "MO",
    Montana: "MT",
    Nebraska: "NE",
    Nevada: "NV",
    NewHampshire: "NH",
    NewJersey: "NJ",
    NewMexico: "NM",
    NewYork: "NY",
    NorthCarolina: "NC",
    NorthDakota: "ND",
    Ohio: "OH",
    Oklahoma: "OK",
    Oregon: "OR",
    Pennsylvania: "PA",
    RhodeIsland: "RI",
    SouthCarolina: "SC",
    SouthDakota: "SD",
    Tennessee: "TN",
    Texas: "TX",
    Utah: "UT",
    Vermont: "VT",
    Virginia: "VA",
    Washington: "WA",
    WestVirginia: "WV",
    Wisconsin: "WI",
    Wyoming: "WY",
  }

  return states[stateName.replace(/\s/g, "")] ?? stateName
}

async function getFecCandidateId(
  firstName: string,
  lastName: string,
  state: string,
  chamber: string
) {
  if (!process.env.FEC_API_KEY) return null

  const office = chamber === "Senate" ? "S" : "H"

  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1

  const stateCode = getStateAbbreviation(state)
  if (!stateCode) return null

  const url = new URL("https://api.open.fec.gov/v1/candidates/search/")
  url.searchParams.set("api_key", process.env.FEC_API_KEY)
  url.searchParams.set("name", lastName)
  url.searchParams.set("state", stateCode)
  url.searchParams.set("office", office)
  url.searchParams.set("cycle", String(cycle))
  url.searchParams.set("per_page", "10")

  const res = await fetch(url.toString())

  if (!res.ok) return null

  const data = await res.json()

  return data.results?.[0] ?? null
}

async function getTopPacDonors(
  committeeIds: string[]
): Promise<PacDonation[]> {
  if (!process.env.FEC_API_KEY || committeeIds.length === 0) return []

  const donors: Record<string, number> = {}

  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1

  for (const committeeId of committeeIds) {
    let last_index: string | undefined
    let last_date: string | undefined

    let pageCount = 0

    while (pageCount < 5) {
      const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
      url.searchParams.set("api_key", process.env.FEC_API_KEY)
      url.searchParams.set("committee_id", committeeId)
      url.searchParams.set("two_year_transaction_period", String(cycle))
      url.searchParams.set("contributor_type", "committee")
      url.searchParams.set("per_page", "100")
      url.searchParams.set("sort", "-contribution_receipt_date")

      if (last_index)
        url.searchParams.set("last_index", last_index)

      if (last_date)
        url.searchParams.set("last_contribution_receipt_date", last_date)

      const res = await fetch(url.toString())
      if (!res.ok) {
        console.log("Schedule A fetch failed")
        break
      }

      const data = await res.json()
      const results = data.results ?? []

      if (results.length === 0) break

      for (const r of results) {
        const name = r.contributor_name
        const amount = r.contribution_receipt_amount ?? 0

        if (!name) continue

        donors[name] = (donors[name] || 0) + amount
      }

      const li = data.pagination?.last_indexes
      if (!li?.last_index || li.last_index === last_index) break

      last_index = li.last_index
      last_date = li.last_contribution_receipt_date
      pageCount++
    }
  }

  const top = Object.entries(donors)
    .map(([pacName, amount]) => ({ pacName, amount, date: ""}))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)

  return top
}

async function getFecTotals(candidateId: string) {
  const res = await fetch(
    `https://api.open.fec.gov/v1/candidate/${candidateId}/totals/?api_key=${process.env.FEC_API_KEY}`,
    { cache: "no-store" }
  )

  console.log("FEC totals status:", res.status)

  if (!res.ok) {
    const text = await res.text()
    console.log("FEC totals error:", text)
    return null
  }

  const data = await res.json()
  return data.results?.[0] ?? null
}

async function getAllPacDonationsForIndustry(
  committeeIds: string[]
) {
  if (!process.env.FEC_API_KEY || committeeIds.length === 0) return []

  const donors: { pacName: string; amount: number }[] = []

  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1

  for (const committeeId of committeeIds) {
    let last_index: string | undefined
    let last_date: string | undefined
    let pageCount = 0

    while (pageCount < 15) {
      const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
      url.searchParams.set("api_key", process.env.FEC_API_KEY)
      url.searchParams.set("committee_id", committeeId)
      url.searchParams.set("two_year_transaction_period", String(cycle))
      url.searchParams.set("contributor_type", "committee")
      url.searchParams.set("per_page", "100")
      url.searchParams.set("sort", "-contribution_receipt_date")

      if (last_index)
        url.searchParams.set("last_index", last_index)

      if (last_date)
        url.searchParams.set("last_contribution_receipt_date", last_date)

      const res = await fetch(url.toString())
      if (!res.ok) break

      const data = await res.json()
      const results = data.results ?? []
      if (results.length === 0) break

      for (const r of results) {
        if (!r.contributor_name) continue
        donors.push({
          pacName: r.contributor_name,
          amount: r.contribution_receipt_amount ?? 0,
        })
      }

      const li = data.pagination?.last_indexes
      if (!li?.last_index || li.last_index === last_index) break

      last_index = li.last_index
      last_date = li.last_contribution_receipt_date
      pageCount++
    }
  }

  return donors
}

function computeTopIndustries(
  donations: { pacName: string; amount: number }[]
) {
  const totals: Record<string, number> = {}

  for (const donation of donations) {
    const industry = categorizeIndustry(donation.pacName)
    totals[industry] = (totals[industry] || 0) + donation.amount
  }

  return Object.entries(totals)
    .filter(([name]) => name !== "Other")
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params

    const congressApiKey =
      process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY

    if (!congressApiKey) {
      return NextResponse.json(
        { error: "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY" },
        { status: 500 }
      )
    }

    const res = await fetch(
      `https://api.congress.gov/v3/member/${id}?format=json`,
      {
        headers: {
          "X-Api-Key": congressApiKey,
        },
        cache: "no-store",
      }
    )

    if (!res.ok) {
      return NextResponse.json(
        { error: "Congress API error" },
        { status: 500 }
      )
    }

    const data = await res.json()
    const rawMember = data.member

    if (!rawMember) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404 }
      )
    }

    const formatted = mapCongressMemberToMember(rawMember)

    const [trades, candidate] = await Promise.all([
      getCongressTrades(formatted.id),
      getFecCandidateId(
        rawMember.firstName,
        rawMember.lastName,
        rawMember.state,
        rawMember.terms?.[rawMember.terms.length - 1]?.chamber
      )
    ])

    let totals = null
    let pacDonations: PacDonation[] = []
    let allDonations: { pacName: string; amount: number }[] = []
    let committees: string[] = []
    let topIndustries: { name: string; amount: number }[] = []

    if (candidate?.candidate_id) {
      totals = await getFecTotals(candidate.candidate_id)

      committees =
        candidate.principal_committees
          ?.filter((c: any) => c.designation === "P")
          .map((c: any) => c.committee_id) ?? []

      pacDonations = await getTopPacDonors(committees)

      allDonations = await getAllPacDonationsForIndustry(committees)
      topIndustries = computeTopIndustries(allDonations)
    }

    return NextResponse.json({
      ...formatted,
      totalRaised: totals?.receipts ?? 0,
      totalSpent: totals?.disbursements ?? 0,
      trades,
      pacDonations,
      topIndustries,
    })
  } catch (error) {
    console.log("Route error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}