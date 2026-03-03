import { NextResponse } from "next/server"

type DistrictMember = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string
}

type CongressMemberSummary = {
  bioguideId?: string
  name?: string
  party?: string
  partyName?: string
  state?: string
  district?: string | number | null
  currentMember?: boolean
  served?: Record<string, unknown>
  terms?: {
    item?: Array<{
      chamber?: string
      district?: string | number | null
      endYear?: number
      stateCode?: string
      stateName?: string
      startYear?: number
    }>
  }
}

type CongressMemberListResponse = {
  members?: CongressMemberSummary[]
  pagination?: {
    next?: string
  }
  message?: string
  error?: string
}

const CONGRESS_API_BASE = "https://api.congress.gov/v3/member"
const PAGE_SIZE = 250
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

function getPartyCode(party?: string): "D" | "R" | "I" | null {
  const normalized = party?.trim().toUpperCase()
  if (!normalized) return null

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

  if (
    normalized === "I" ||
    normalized === "IND" ||
    normalized === "INDEPENDENT"
  ) {
    return "I"
  }

  return null
}

function getCurrentHouseTerm(member: CongressMemberSummary) {
  return (member.terms?.item ?? []).find(
    (term) =>
      !term.endYear &&
      typeof term.chamber === "string" &&
      (term.chamber.includes("House") || term.chamber.includes("Representative"))
  )
}

function getDistrictValue(member: CongressMemberSummary): string {
  const currentHouseTerm = getCurrentHouseTerm(member)
  const stateCode = getStateCode(
    currentHouseTerm?.stateCode ??
    member.state ??
    currentHouseTerm?.stateName
  )
  const district = normalizeDistrict(member.district ?? currentHouseTerm?.district)

  if (district) {
    return district
  }

  return AT_LARGE_STATE_CODES.has(stateCode) ? "AL" : ""
}

async function fetchCongressPage(apiKey: string, offset: number): Promise<CongressMemberListResponse> {
  const response = await fetch(
    `${CONGRESS_API_BASE}?format=json&currentMember=true&limit=${PAGE_SIZE}&offset=${offset}&api_key=${apiKey}`,
    { cache: "no-store" }
  )

  if (!response.ok) {
    let detail = `Congress.gov request failed with status ${response.status}`

    try {
      const errorBody = (await response.json()) as CongressMemberListResponse
      const apiMessage = errorBody.message ?? errorBody.error
      if (apiMessage) {
        detail = `${detail}: ${apiMessage}`
      }
    } catch {
    }

    throw new Error(detail)
  }

  return (await response.json()) as CongressMemberListResponse
}

async function fetchCurrentCongressMembers(apiKey: string): Promise<CongressMemberSummary[]> {
  const members: CongressMemberSummary[] = []
  let offset = 0

  while (true) {
    const data = await fetchCongressPage(apiKey, offset)
    const pageMembers = data.members ?? []
    members.push(...pageMembers)

    if (!data.pagination?.next || pageMembers.length < PAGE_SIZE) {
      break
    }

    offset += PAGE_SIZE
  }

  return members
}

function buildDistrictMembers(members: CongressMemberSummary[]): DistrictMember[] {
  const districtMembers = new Map<string, DistrictMember>()

  for (const member of members) {
    const currentHouseTerm = getCurrentHouseTerm(member)

    if (!currentHouseTerm) {
      continue
    }

    const party = getPartyCode(member.party ?? member.partyName)
    const state = getStateCode(
      currentHouseTerm.stateCode ??
      member.state ??
      currentHouseTerm.stateName
    )
    const district = getDistrictValue(member)

    if (!member.bioguideId || !member.name || !party || !state || !district) {
      continue
    }

    districtMembers.set(`${state}-${district}`, {
      id: member.bioguideId,
      name: member.name,
      party,
      state,
      district,
    })
  }

  return [...districtMembers.values()]
    .sort((left, right) => {
      const stateCompare = left.state.localeCompare(right.state)
      if (stateCompare !== 0) return stateCompare

      const leftDistrict = left.district === "AL" ? 0 : Number(left.district)
      const rightDistrict = right.district === "AL" ? 0 : Number(right.district)
      return leftDistrict - rightDistrict
    })
}

export async function GET() {
  const apiKey =
    process.env.CONGRESS_API_KEY ??
    process.env.CONGRESS_GOV_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY", members: [] },
      { status: 500 }
    )
  }

  try {
    const members = buildDistrictMembers(await fetchCurrentCongressMembers(apiKey))

    if (members.length === 0) {
      return NextResponse.json(
        { error: "Congress.gov returned no current House district members.", members: [] },
        { status: 502 }
      )
    }

    return NextResponse.json({ members })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch House members"

    return NextResponse.json(
      { error: message, members: [] },
      { status: 500 }
    )
  }
}
