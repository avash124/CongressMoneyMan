import { getCache, setCache } from "./cache"

export type HouseMember = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string
}

export type SenateMember = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
}

type RawTerm = {
  chamber?: string
  district?: string | number | null
  endYear?: number
  stateCode?: string
  stateName?: string
}

type RawMember = {
  bioguideId?: string
  name?: string
  party?: string
  partyName?: string
  state?: string
  district?: string | number | null
  terms?: { item?: RawTerm[] }
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
  "AK", "AS", "DC", "DE", "GU", "MP", "ND", "PR", "SD", "VI", "VT", "WY",
])

const NON_VOTING_HOUSE_STATES = new Set(["AS", "DC", "GU", "MP", "PR", "VI"])

const CONGRESS_API_BASE = "https://api.congress.gov/v3/member"
const PAGE_SIZE = 250

const HOUSE_MEMBERS_KEY = "house-members"
const SENATE_MEMBERS_KEY = "senate-members"
const MEMBERS_TTL_SECONDS = 60 * 60

export function getStateCode(state?: string): string {
  if (!state) return ""
  const normalized = state.trim()
  if (!normalized) return ""
  if (normalized.length === 2) return normalized.toUpperCase()
  return STATE_NAME_TO_CODE[normalized] ?? ""
}
export function isNonVotingHouseSeat(state?: string): boolean {
  return NON_VOTING_HOUSE_STATES.has(getStateCode(state))
}

function getPartyCode(party?: string): "D" | "R" | "I" | null {
  const normalized = party?.trim().toUpperCase()
  if (!normalized) return null
  if (normalized === "D" || normalized === "DEM" || normalized === "DEMOCRAT" || normalized === "DEMOCRATIC" || normalized === "DFL") return "D"
  if (normalized === "R" || normalized === "REP" || normalized === "REPUBLICAN") return "R"
  if (normalized === "I" || normalized === "IND" || normalized === "INDEPENDENT") return "I"
  return null
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

function getCurrentHouseTerm(member: RawMember): RawTerm | undefined {
  return (member.terms?.item ?? []).find(
    (term) =>
      !term.endYear &&
      typeof term.chamber === "string" &&
      (term.chamber.includes("House") || term.chamber.includes("Representative"))
  )
}

function getCurrentSenateTerm(member: RawMember): RawTerm | undefined {
  return (member.terms?.item ?? []).find(
    (term) =>
      !term.endYear &&
      typeof term.chamber === "string" &&
      term.chamber.includes("Senate")
  )
}

async function fetchCongressPage(apiKey: string, offset: number): Promise<RawMember[]> {
  const response = await fetch(
    `${CONGRESS_API_BASE}?format=json&currentMember=true&limit=${PAGE_SIZE}&offset=${offset}&api_key=${apiKey}`,
    { next: { revalidate: 3600 } }
  )
  if (!response.ok) {
    throw new Error(`Congress.gov request failed with status ${response.status}`)
  }
  const data = await response.json()
  return (data.members as RawMember[]) ?? []
}

async function fetchAllRawMembers(apiKey: string): Promise<RawMember[]> {
  const firstPage = await fetchCongressPage(apiKey, 0)

  if (firstPage.length < PAGE_SIZE) return firstPage

  const [page2, page3] = await Promise.all([
    fetchCongressPage(apiKey, PAGE_SIZE),
    fetchCongressPage(apiKey, PAGE_SIZE * 2),
  ])

  return [...firstPage, ...page2, ...page3]
}

export async function fetchHouseMembers(apiKey: string): Promise<HouseMember[]> {
  const cached = await getCache<HouseMember[]>(HOUSE_MEMBERS_KEY)
  if (cached) return cached

  const raw = await fetchAllRawMembers(apiKey)
  const seen = new Map<string, HouseMember>()

  for (const member of raw) {
    const term = getCurrentHouseTerm(member)
    if (!term) continue

    const party = getPartyCode(member.party ?? member.partyName)
    const state = getStateCode(term.stateCode ?? member.state ?? term.stateName)
    if (NON_VOTING_HOUSE_STATES.has(state)) continue
    const district = normalizeDistrict(member.district ?? term.district)
    const finalDistrict = district || (AT_LARGE_STATE_CODES.has(state) ? "AL" : "")

    if (!member.bioguideId || !member.name || !party || !state || !finalDistrict) continue

    seen.set(`${state}-${finalDistrict}`, {
      id: member.bioguideId,
      name: member.name,
      party,
      state,
      district: finalDistrict,
    })
  }

  const members = [...seen.values()].sort((a, b) => {
    const s = a.state.localeCompare(b.state)
    if (s !== 0) return s
    const ad = a.district === "AL" ? 0 : Number(a.district)
    const bd = b.district === "AL" ? 0 : Number(b.district)
    return ad - bd
  })

  await setCache(HOUSE_MEMBERS_KEY, members, MEMBERS_TTL_SECONDS)
  return members
}

export async function fetchSenateMembers(apiKey: string): Promise<SenateMember[]> {
  const cached = await getCache<SenateMember[]>(SENATE_MEMBERS_KEY)
  if (cached) return cached

  const raw = await fetchAllRawMembers(apiKey)
  const seen = new Map<string, SenateMember>()

  for (const member of raw) {
    const term = getCurrentSenateTerm(member)
    if (!term) continue

    const party = getPartyCode(member.party ?? member.partyName)
    const state = getStateCode(term.stateCode ?? member.state ?? term.stateName)

    if (!member.bioguideId || !member.name || !party || !state) continue

    seen.set(member.bioguideId, {
      id: member.bioguideId,
      name: member.name,
      party,
      state,
    })
  }

  const members = [...seen.values()].sort((a, b) => {
    const s = a.state.localeCompare(b.state)
    if (s !== 0) return s
    return a.name.localeCompare(b.name)
  })

  await setCache(SENATE_MEMBERS_KEY, members, MEMBERS_TTL_SECONDS)
  return members
}
