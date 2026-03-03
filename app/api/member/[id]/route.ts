import { NextResponse } from "next/server"

type CongressMemberDetail = {
  bioguideId?: string
  name?: string
  party?: string
  partyName?: string
  state?: string
  district?: string | number | null
  partyHistory?:
    | Array<{
        partyAbbreviation?: string
        partyName?: string
      }>
    | {
        item?: Array<{
          partyAbbreviation?: string
          partyName?: string
        }>
      }
  terms?: Array<{
    chamber?: string
    district?: string | number | null
    endYear?: number
    memberType?: string
    startYear?: number
    stateCode?: string
    stateName?: string
  }>
}

type CongressMemberDetailResponse = {
  member?: CongressMemberDetail
  message?: string
  error?: string
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
  "American Samoa": "AS",
  Guam: "GU",
  "Northern Mariana Islands": "MP",
  "Puerto Rico": "PR",
  "Virgin Islands": "VI",
}
const AT_LARGE_STATE_CODES = new Set([
  "AK",
  "AS",
  "DC",
  "DE",
  "GU",
  "MP",
  "ND",
  "PR",
  "SD",
  "VI",
  "VT",
  "WY",
])

function normalizeDistrict(value?: string | number | null): string {
  if (value === undefined || value === null) return ""

  const raw = String(value).trim().toUpperCase()
  if (!raw) return ""
  if (raw === "AL" || raw === "AT LARGE" || raw === "AT-LARGE") return "AL"

  const numeric = Number.parseInt(raw, 10)
  if (Number.isNaN(numeric)) return raw
  if (numeric === 0) return "AL"

  return String(numeric)
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

function isBioguideId(id: string): boolean {
  return /^[A-Z]\d{6}$/i.test(id)
}

function getCongressParty(member: CongressMemberDetail): string | undefined {
  if (member.party || member.partyName) {
    return member.party ?? member.partyName
  }

  const partyHistory = Array.isArray(member.partyHistory)
    ? member.partyHistory
    : member.partyHistory?.item ?? []

  return (
    partyHistory[0]?.partyAbbreviation ??
    partyHistory[0]?.partyName ??
    partyHistory.at(-1)?.partyAbbreviation ??
    partyHistory.at(-1)?.partyName
  )
}

function getCurrentHouseTerm(member: CongressMemberDetail) {
  return (member.terms ?? []).find(
    (term) =>
      !term.endYear &&
      typeof term.chamber === "string" &&
      (term.chamber.includes("House") || term.chamber.includes("Representative"))
  )
}

async function fetchCongressMember(memberId: string, apiKey: string) {
  const response = await fetch(
    `https://api.congress.gov/v3/member/${memberId}?format=json&api_key=${apiKey}`,
    { cache: "no-store" }
  )

  if (!response.ok) {
    let detail = `Congress.gov request failed with status ${response.status}`

    try {
      const errorBody = (await response.json()) as CongressMemberDetailResponse
      const apiMessage = errorBody.message ?? errorBody.error
      if (apiMessage) {
        detail = `${detail}: ${apiMessage}`
      }
    } catch {
      // Ignore parse errors and keep the status-based message.
    }

    throw new Error(detail)
  }

  const data = (await response.json()) as CongressMemberDetailResponse
  const member = data.member

  const name =
    member?.directOrderName ??
    member?.invertedOrderName

  if (!member || !name) {
    return null
  }

  const currentHouseTerm = getCurrentHouseTerm(member)
  const state = getStateCode(
    currentHouseTerm?.stateCode ??
    member.state ??
    currentHouseTerm?.stateName
  )
  const district =
    normalizeDistrict(member.district ?? currentHouseTerm?.district) ||
    (AT_LARGE_STATE_CODES.has(state) ? "AL" : "")

  return {
    candidate: {
      id: member.bioguideId ?? memberId,
      name,
      party: getPartyCode(getCongressParty(member)),
      state,
      district,
    },
    totals: null,
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (isBioguideId(id)) {
    const congressApiKey =
      process.env.CONGRESS_API_KEY ??
      process.env.CONGRESS_GOV_API_KEY

    if (!congressApiKey) {
      return NextResponse.json(
        { error: "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY" },
        { status: 500 }
      )
    }

    try {
      const member = await fetchCongressMember(id, congressApiKey)

      if (!member?.candidate) {
        return NextResponse.json(
          { error: "Member not found" },
          { status: 404 }
        )
      }

      return NextResponse.json(member)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch from Congress.gov"

      return NextResponse.json(
        { error: message },
        { status: 500 }
      )
    }
  }

  const apiKey = process.env.FEC_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key" },
      { status: 500 }
    )
  }

  try {
    const candidateRes = await fetch(
      `https://api.open.fec.gov/v1/candidates/search/?candidate_id=${id}&api_key=${apiKey}`
    )

    const candidateData = await candidateRes.json()

    const totalsRes = await fetch(
      `https://api.open.fec.gov/v1/candidate/${id}/totals/?api_key=${apiKey}`
    )

    const totalsData = await totalsRes.json()

    return NextResponse.json({
      candidate: candidateData.results?.[0] ?? null,
      totals: totalsData.results?.[0] ?? null,
    })
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch from FEC" },
      { status: 500 }
    )
  }
}
