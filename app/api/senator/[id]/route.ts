import { NextResponse } from "next/server"
import type { Member, PacDonation, Trade } from "@/types/member"

type CongressTerm = {
  chamber?: string
  endYear?: number
  stateCode?: string
  stateName?: string
}

type CongressMember = {
  bioguideId?: string
  firstName?: string
  lastName?: string
  party?: string
  partyName?: string
  state?: string
  terms?: CongressTerm[]
}

type FecCandidate = {
  candidate_status?: string
  incumbent_challenge?: string
  principal_committees?: Array<{
    committee_id?: string
    designation?: string
  }>
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
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
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
}

function getStateCode(state?: string): string {
  if (!state) return ""

  const normalized = state.trim()
  if (!normalized) return ""
  if (normalized.length === 2) return normalized.toUpperCase()

  return STATE_NAME_TO_CODE[normalized] ?? ""
}

function getPartyCode(party?: string): "D" | "R" | "I" {
  const normalized = party?.trim().toUpperCase()

  if (
    normalized === "D" ||
    normalized === "DEM" ||
    normalized === "DEMOCRAT" ||
    normalized === "DEMOCRATIC" ||
    normalized === "DFL"
  ) {
    return "D"
  }

  if (
    normalized === "R" ||
    normalized === "REP" ||
    normalized === "REPUBLICAN"
  ) {
    return "R"
  }

  return "I"
}

function getCurrentSenateTerm(member: CongressMember): CongressTerm | null {
  return (
    (member.terms ?? []).find(
      (term) => !term.endYear && term.chamber?.includes("Senate")
    ) ?? null
  )
}

function mapCongressMemberToResponse(
  member: CongressMember,
  pacDonations: PacDonation[],
  trades: Trade[]
): Member {
  const currentTerm = getCurrentSenateTerm(member)

  return {
    id: member.bioguideId ?? "",
    name: [member.firstName, member.lastName].filter(Boolean).join(" "),
    party: getPartyCode(member.party ?? member.partyName),
    state: getStateCode(
      member.state ?? currentTerm?.stateCode ?? currentTerm?.stateName
    ),
    district: "Senate",
    totalRaised: 0,
    totalSpent: 0,
    topIndustries: [],
    pacDonations,
    trades,
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
  ] as const

  for (const [min, max] of ranges) {
    if (lowerBound === min) {
      return `$${min.toLocaleString()} - $${max.toLocaleString()}`
    }
  }

  if (lowerBound >= 50000001) {
    return `$${lowerBound.toLocaleString()}+`
  }

  return `$${lowerBound.toLocaleString()}`
}

async function getCongressTrades(bioguideId: string): Promise<Trade[]> {
  const response = await fetch(
    `https://api.quiverquant.com/beta/bulk/congresstrading?bioguide_id=${bioguideId}&page_size=20`,
    {
      headers: {
        Authorization: `Bearer ${process.env.QUIVER_API_KEY ?? ""}`,
        Accept: "application/json",
        "User-Agent": "CongressMoneyMan/1.0",
      },
      cache: "no-store",
    }
  )

  if (!response.ok) {
    return []
  }

  const payload = (await response.json()) as Array<{
    Ticker?: string
    Trade_Size_USD?: number | string
    Traded?: string
    Transaction?: string
  }>

  return payload.map((trade) => ({
    ticker: trade.Ticker ?? "Unknown",
    transactionType: trade.Transaction ?? "Unknown",
    transactionDate: trade.Traded ?? "Unknown",
    amount: formatTradeRange(Number(trade.Trade_Size_USD)),
  }))
}

async function getSenateCandidate(
  firstName: string,
  lastName: string,
  stateCode: string
): Promise<FecCandidate | null> {
  if (!process.env.FEC_API_KEY || !stateCode) {
    return null
  }

  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1
  const url = new URL("https://api.open.fec.gov/v1/candidates/search/")
  url.searchParams.set("api_key", process.env.FEC_API_KEY)
  url.searchParams.set("name", `${firstName} ${lastName}`.trim() || lastName)
  url.searchParams.set("state", stateCode)
  url.searchParams.set("office", "S")
  url.searchParams.set("cycle", String(cycle))
  url.searchParams.set("per_page", "20")

  const response = await fetch(url.toString(), { cache: "no-store" })
  if (!response.ok) {
    return null
  }

  const payload = (await response.json()) as { results?: FecCandidate[] }
  const results = payload.results ?? []

  return (
    results.find(
      (candidate) =>
        candidate.incumbent_challenge === "I" &&
        candidate.candidate_status === "C"
    ) ??
    results.find((candidate) => candidate.incumbent_challenge === "I") ??
    results.find((candidate) => candidate.candidate_status === "C") ??
    null
  )
}

async function getTopPacDonors(committeeIds: string[]): Promise<PacDonation[]> {
  if (!process.env.FEC_API_KEY || committeeIds.length === 0) {
    return []
  }

  const donors: Record<string, number> = {}
  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1

  for (const committeeId of committeeIds) {
    let lastIndex: string | undefined
    let lastDate: string | undefined
    let pageCount = 0

    while (pageCount < 5) {
      const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
      url.searchParams.set("api_key", process.env.FEC_API_KEY)
      url.searchParams.set("committee_id", committeeId)
      url.searchParams.set("two_year_transaction_period", String(cycle))
      url.searchParams.set("contributor_type", "committee")
      url.searchParams.set("per_page", "100")
      url.searchParams.set("sort", "-contribution_receipt_date")

      if (lastIndex) {
        url.searchParams.set("last_index", lastIndex)
      }

      if (lastDate) {
        url.searchParams.set("last_contribution_receipt_date", lastDate)
      }

      const response = await fetch(url.toString(), { cache: "no-store" })
      if (!response.ok) {
        break
      }

      const payload = (await response.json()) as {
        pagination?: {
          last_indexes?: {
            last_contribution_receipt_date?: string
            last_index?: string
          }
        }
        results?: Array<{
          contribution_receipt_amount?: number
          contributor_name?: string
        }>
      }

      const results = payload.results ?? []
      if (results.length === 0) {
        break
      }

      for (const result of results) {
        if (!result.contributor_name) continue

        donors[result.contributor_name] =
          (donors[result.contributor_name] ?? 0) +
          (result.contribution_receipt_amount ?? 0)
      }

      const pagination = payload.pagination?.last_indexes
      if (!pagination?.last_index || pagination.last_index === lastIndex) {
        break
      }

      lastIndex = pagination.last_index
      lastDate = pagination.last_contribution_receipt_date
      pageCount += 1
    }
  }

  return Object.entries(donors)
    .map(([pacName, amount]) => ({ pacName, amount, date: "" }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 10)
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const response = await fetch(
      `https://api.congress.gov/v3/member/${id}?format=json`,
      {
        headers: {
          "X-Api-Key": process.env.CONGRESS_API_KEY ?? "",
        },
        cache: "no-store",
      }
    )

    if (!response.ok) {
      return NextResponse.json(
        { error: "Congress API error" },
        { status: 500 }
      )
    }

    const payload = (await response.json()) as { member?: CongressMember }
    const senator = payload.member

    if (!senator?.bioguideId || !getCurrentSenateTerm(senator)) {
      return NextResponse.json({ error: "Senator not found" }, { status: 404 })
    }

    const trades = await getCongressTrades(senator.bioguideId)
    const stateCode = getStateCode(
      senator.state ??
        getCurrentSenateTerm(senator)?.stateCode ??
        getCurrentSenateTerm(senator)?.stateName
    )
    const candidate = await getSenateCandidate(
      senator.firstName ?? "",
      senator.lastName ?? "",
      stateCode
    )

    const committeeIds =
      candidate?.principal_committees
        ?.filter((committee) => committee.designation === "P")
        .map((committee) => committee.committee_id)
        .filter((committeeId): committeeId is string => Boolean(committeeId)) ??
      []

    const pacDonations = await getTopPacDonors(committeeIds)

    return NextResponse.json(
      mapCongressMemberToResponse(senator, pacDonations, trades)
    )
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
