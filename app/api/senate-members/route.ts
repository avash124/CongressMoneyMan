import { NextResponse } from "next/server"

type SenateMember = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
}

type CongressMemberSummary = {
  bioguideId?: string
  name?: string
  party?: string
  partyName?: string
  state?: string
  terms?: {
    item?: Array<{
      chamber?: string
      endYear?: number
      stateCode?: string
      stateName?: string
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

function getCurrentSenateTerm(member: CongressMemberSummary) {
  return (member.terms?.item ?? []).find(
    (term) =>
      !term.endYear &&
      typeof term.chamber === "string" &&
      term.chamber.includes("Senate")
  )
}

async function fetchCongressPage(
  apiKey: string,
  offset: number
): Promise<CongressMemberListResponse> {
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

async function fetchCurrentCongressMembers(
  apiKey: string
): Promise<CongressMemberSummary[]> {
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

function buildSenateMembers(members: CongressMemberSummary[]): SenateMember[] {
  const senateMembers = new Map<string, SenateMember>()

  for (const member of members) {
    const currentSenateTerm = getCurrentSenateTerm(member)
    if (!currentSenateTerm) {
      continue
    }

    const party = getPartyCode(member.party ?? member.partyName)
    const state = getStateCode(
      currentSenateTerm.stateCode ??
        member.state ??
        currentSenateTerm.stateName
    )

    if (!member.bioguideId || !member.name || !party || !state) {
      continue
    }

    senateMembers.set(member.bioguideId, {
      id: member.bioguideId,
      name: member.name,
      party,
      state,
    })
  }

  return [...senateMembers.values()].sort((left, right) => {
    const stateCompare = left.state.localeCompare(right.state)
    if (stateCompare !== 0) return stateCompare

    return left.name.localeCompare(right.name)
  })
}

export async function GET() {
  const apiKey =
    process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing CONGRESS_API_KEY or CONGRESS_GOV_API_KEY", members: [] },
      { status: 500 }
    )
  }

  try {
    const members = buildSenateMembers(await fetchCurrentCongressMembers(apiKey))

    if (members.length === 0) {
      return NextResponse.json(
        {
          error: "Congress.gov returned no current Senate members.",
          members: [],
        },
        { status: 502 }
      )
    }

    return NextResponse.json({ members })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch Senate members"

    return NextResponse.json(
      { error: message, members: [] },
      { status: 500 }
    )
  }
}
