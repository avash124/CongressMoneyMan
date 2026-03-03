import { NextResponse } from "next/server"
import type { Member, PacDonation, Trade } from "@/types/member"

type MemberApiResponse = Member & {
  trades: Trade[]
}

type CongressPartyHistoryEntry = {
  partyAbbreviation?: string
  partyName?: string
}

type CongressTerm = {
  chamber?: string
  district?: string | number | null
  endYear?: number
  memberType?: string
  startYear?: number
  stateCode?: string
  stateName?: string
}

type CongressMemberDetail = {
  bioguideId?: string
  directOrderName?: string
  invertedOrderName?: string
  firstName?: string
  lastName?: string
  party?: string
  partyName?: string
  state?: string
  district?: string | number | null
  partyHistory?:
    | CongressPartyHistoryEntry[]
    | {
        item?: CongressPartyHistoryEntry[]
      }
  terms?: CongressTerm[]
}

type CongressMemberDetailResponse = {
  member?: CongressMemberDetail
  message?: string
  error?: string
}

type CongressMemberListResponse = {
  members?: Array<CongressMemberDetail | { member?: CongressMemberDetail }>
  message?: string
  error?: string
}

type FecCommittee = {
  committee_id?: string
  designation?: string
}

type FecCandidate = {
  candidate_id?: string
  candidate_status?: string
  election_years?: number[]
  incumbent_challenge?: string
  name?: string
  office?: string
  party?: string
  principal_committees?: FecCommittee[]
  state?: string
}

type FecCandidateSearchResponse = {
  results?: FecCandidate[]
  message?: string
  error?: string
}

type FecCandidateTotals = {
  receipts?: number
  disbursements?: number
}

type FecTotalsResponse = {
  results?: FecCandidateTotals[]
  message?: string
  error?: string
}

type FecScheduleARecord = {
  contribution_receipt_amount?: number
  contribution_receipt_date?: string
  contributor_name?: string
}

type FecScheduleAPagination = {
  last_indexes?: {
    last_contribution_receipt_date?: string
    last_index?: string
  }
}

type FecScheduleAResponse = {
  results?: FecScheduleARecord[]
  pagination?: FecScheduleAPagination
  message?: string
  error?: string
}

type QuiverTradeRecord = {
  Amount?: number | string
  BioGuideID?: string
  Filed?: string
  Name?: string
  Range?: string
  ReportDate?: string
  Representative?: string
  Ticker?: string
  Trade_Size_USD?: number | string
  TransactionDate?: string
  Traded?: string
  Transaction?: string
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

function getCurrentTerm(member: CongressMemberDetail): CongressTerm | undefined {
  return (member.terms ?? []).find((term) => !term.endYear)
}

function getDisplayDistrict(member: CongressMemberDetail): string {
  const currentTerm = getCurrentTerm(member)

  if (currentTerm?.chamber?.includes("Senate")) {
    return "Senate"
  }

  const state = getStateCode(
    currentTerm?.stateCode ??
    member.state ??
    currentTerm?.stateName
  )
  const district =
    normalizeDistrict(member.district ?? currentTerm?.district) ||
    (AT_LARGE_STATE_CODES.has(state) ? "AL" : "")

  return district
}

function getMemberName(member: CongressMemberDetail): string {
  return (
    member.directOrderName ??
    member.invertedOrderName ??
    [member.firstName, member.lastName].filter(Boolean).join(" ")
  )
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

function formatTradeAmount(value?: number | string): string {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return "Unknown"
    if (trimmed.includes("$")) return trimmed

    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? formatTradeRange(numeric) : trimmed
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return formatTradeRange(value)
  }

  return "Unknown"
}

async function fetchCongressMember(memberId: string, apiKey: string): Promise<CongressMemberDetail | null> {
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
    }

    throw new Error(detail)
  }

  const data = (await response.json()) as CongressMemberDetailResponse
  return data.member ?? null
}

async function getCongressTrades(bioguideId?: string): Promise<Trade[]> {
  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey || !bioguideId) return []

  const headers = {
    Accept: "application/json",
    "User-Agent": "CongressMoneyMan/1.0",
  }
  const headerVariants: Record<string, string>[] = [
    { Authorization: `Bearer ${apiKey}` },
    { Authorization: `Token ${apiKey}` },
    { "X-Api-Key": apiKey },
    { apikey: apiKey },
  ]
  const normalizeTrade = (trade: QuiverTradeRecord): Trade => ({
    ticker: trade.Ticker ?? "Unknown",
    transactionType: trade.Transaction ?? "Unknown",
    transactionDate:
      trade.TransactionDate ??
      trade.Traded ??
      trade.Filed ??
      trade.ReportDate ??
      "Unknown",
    amount:
      trade.Range ??
      formatTradeAmount(trade.Trade_Size_USD ?? trade.Amount),
  })

  const fetchJsonArray = async (url: string): Promise<QuiverTradeRecord[]> => {
    for (const hdr of headerVariants) {
      try {
        const res = await fetch(url, {
          headers: {
            ...headers,
            ...hdr,
          },
          next: { revalidate: 3600 },
        })

        if (!res.ok) {
          continue
        }

        const payload = (await res.json()) as unknown
        if (Array.isArray(payload)) {
          return payload as QuiverTradeRecord[]
        }
        if (
          payload &&
          typeof payload === "object" &&
          "data" in payload &&
          Array.isArray(payload.data)
        ) {
          return payload.data as QuiverTradeRecord[]
        }
        if (
          payload &&
          typeof payload === "object" &&
          "results" in payload &&
          Array.isArray(payload.results)
        ) {
          return payload.results as QuiverTradeRecord[]
        }
        if (
          payload &&
          typeof payload === "object" &&
          "trades" in payload &&
          Array.isArray(payload.trades)
        ) {
          return payload.trades as QuiverTradeRecord[]
        }
      } catch {
        continue
      }
    }

    return []
  }

  const directTrades = await fetchJsonArray(
    `https://api.quiverquant.com/beta/bulk/congresstrading?bioguide_id=${bioguideId}&page_size=100&recent=false`
  )

  if (directTrades.length > 0) {
    return [...directTrades]
      .sort((a, b) => {
        const bDate =
          Date.parse(
            b.TransactionDate ?? b.Traded ?? b.Filed ?? b.ReportDate ?? ""
          ) || 0
        const aDate =
          Date.parse(
            a.TransactionDate ?? a.Traded ?? a.Filed ?? a.ReportDate ?? ""
          ) || 0
        return bDate - aDate
      })
      .slice(0, 20)
      .map(normalizeTrade)
  }

  const liveTrades = await fetchJsonArray(
    "https://api.quiverquant.com/beta/live/congresstrading?version=V2&page_size=5000&recent=false"
  )
  const memberTrades = liveTrades.filter(
    (trade) => (trade.BioGuideID ?? "").toUpperCase() === bioguideId.toUpperCase()
  )

  return memberTrades
    .sort((a, b) => {
      const bDate =
        Date.parse(
          b.TransactionDate ?? b.Traded ?? b.Filed ?? b.ReportDate ?? ""
        ) || 0
      const aDate =
        Date.parse(
          a.TransactionDate ?? a.Traded ?? a.Filed ?? a.ReportDate ?? ""
        ) || 0
      return bDate - aDate
    })
    .slice(0, 20)
    .map(normalizeTrade)
}

function getElectionCycleYear(): number {
  const currentYear = new Date().getFullYear()
  return currentYear % 2 === 0 ? currentYear : currentYear - 1
}

function chooseBestFecCandidate(
  candidates: FecCandidate[],
  targetLastName: string,
  targetStateCode: string,
  office: "H" | "S"
): FecCandidate | null {
  const normalizedLastName = targetLastName.trim().toUpperCase()

  const scoredCandidates = candidates.map((candidate) => {
    let score = 0

    if (candidate.office === office) score += 4
    if (candidate.state?.toUpperCase() === targetStateCode) score += 3
    if (candidate.name?.toUpperCase().includes(normalizedLastName)) score += 2
    if (candidate.candidate_status === "C") score += 1
    if (candidate.incumbent_challenge === "I") score += 1

    return { candidate, score }
  })

  scoredCandidates.sort((left, right) => right.score - left.score)
  return scoredCandidates[0]?.candidate ?? null
}

async function getFecCandidateForCongressMember(member: CongressMemberDetail): Promise<FecCandidate | null> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return null

  const currentTerm = getCurrentTerm(member)
  const office: "H" | "S" =
    currentTerm?.chamber?.includes("Senate") ? "S" : "H"
  const stateCode = getStateCode(
    currentTerm?.stateCode ??
    member.state ??
    currentTerm?.stateName
  )
  const lastName = member.lastName?.trim()

  if (!stateCode || !lastName) {
    return null
  }

  const url = new URL("https://api.open.fec.gov/v1/candidates/search/")
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("name", lastName)
  url.searchParams.set("state", stateCode)
  url.searchParams.set("office", office)
  url.searchParams.set("cycle", String(getElectionCycleYear()))
  url.searchParams.set("per_page", "20")

  const res = await fetch(url.toString(), { cache: "no-store" })
  if (!res.ok) {
    return null
  }

  const data = (await res.json()) as FecCandidateSearchResponse
  const candidates = data.results ?? []
  return chooseBestFecCandidate(candidates, lastName, stateCode, office)
}

async function getFecCandidateById(candidateId: string): Promise<FecCandidate | null> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return null

  const response = await fetch(
    `https://api.open.fec.gov/v1/candidates/search/?candidate_id=${candidateId}&api_key=${apiKey}`,
    { cache: "no-store" }
  )

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as FecCandidateSearchResponse
  return data.results?.[0] ?? null
}

async function getFecTotals(candidateId: string): Promise<FecCandidateTotals | null> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return null

  const response = await fetch(
    `https://api.open.fec.gov/v1/candidate/${candidateId}/totals/?api_key=${apiKey}`,
    { cache: "no-store" }
  )

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as FecTotalsResponse
  return data.results?.[0] ?? null
}

async function getTopPacDonors(committeeIds: string[]): Promise<PacDonation[]> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey || committeeIds.length === 0) return []

  const donations: PacDonation[] = []
  const seenDonations = new Set<string>()
  const cycle = getElectionCycleYear()

  for (const committeeId of committeeIds) {
    let lastIndex: string | undefined
    let lastDate: string | undefined
    let pageCount = 0

    while (pageCount < 5) {
      const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
      url.searchParams.set("api_key", apiKey)
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

      const data = (await response.json()) as FecScheduleAResponse
      const results = data.results ?? []
      if (results.length === 0) {
        break
      }

      for (const result of results) {
        if (!result.contributor_name || !result.contribution_receipt_date) {
          continue
        }

        const donationKey = [
          result.contributor_name,
          result.contribution_receipt_amount ?? 0,
          result.contribution_receipt_date,
        ].join("|")

        if (seenDonations.has(donationKey)) {
          continue
        }

        seenDonations.add(donationKey)
        donations.push({
          pacName: result.contributor_name,
          amount: result.contribution_receipt_amount ?? 0,
          date: result.contribution_receipt_date,
        })
      }

      const pagination = data.pagination?.last_indexes
      if (!pagination?.last_index || pagination.last_index === lastIndex) {
        break
      }

      lastIndex = pagination.last_index
      lastDate = pagination.last_contribution_receipt_date
      pageCount += 1
    }
  }

  return donations
    .sort((left, right) => {
      const dateCompare = Date.parse(right.date) - Date.parse(left.date)
      if (dateCompare !== 0) return dateCompare

      return right.amount - left.amount
    })
    .slice(0, 20)
}

function mapCongressMemberToResponse(
  member: CongressMemberDetail,
  totals: FecCandidateTotals | null,
  pacDonations: PacDonation[],
  trades: Trade[]
): MemberApiResponse {
  const currentTerm = getCurrentTerm(member)
  const state = getStateCode(
    currentTerm?.stateCode ??
    member.state ??
    currentTerm?.stateName
  )

  return {
    id: member.bioguideId ?? "",
    name: getMemberName(member),
    party: getPartyCode(getCongressParty(member)),
    state,
    district: getDisplayDistrict(member),
    totalRaised: totals?.receipts ?? 0,
    totalSpent: totals?.disbursements ?? 0,
    topIndustries: [],
    pacDonations,
    trades,
  }
}

function mapFecCandidateToResponse(
  candidate: FecCandidate,
  totals: FecCandidateTotals | null,
  pacDonations: PacDonation[],
  trades: Trade[]
): MemberApiResponse {
  return {
    id: candidate.candidate_id ?? "",
    name: candidate.name ?? "Unknown member",
    party: getPartyCode(candidate.party),
    state: candidate.state ?? "",
    district: candidate.office === "S" ? "Senate" : normalizeDistrict("AL"),
    totalRaised: totals?.receipts ?? 0,
    totalSpent: totals?.disbursements ?? 0,
    topIndustries: [],
    pacDonations,
    trades,
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params

  try {
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

      const congressMember = await fetchCongressMember(id, congressApiKey)
      if (!congressMember) {
        return NextResponse.json(
          { error: "Member not found" },
          { status: 404 }
        )
      }

      const [trades, fecCandidate] = await Promise.all([
        getCongressTrades(id),
        getFecCandidateForCongressMember(congressMember),
      ])

      const fecCandidateId = fecCandidate?.candidate_id
      const [totals, pacDonations] = fecCandidateId
        ? await Promise.all([
            getFecTotals(fecCandidateId),
            getTopPacDonors(
              (fecCandidate.principal_committees ?? [])
                .filter((committee) => committee.designation === "P")
                .map((committee) => committee.committee_id)
                .filter((committeeId): committeeId is string => Boolean(committeeId))
            ),
          ])
        : [null, []]

      return NextResponse.json(
        mapCongressMemberToResponse(congressMember, totals, pacDonations, trades)
      )
    }

    const fecCandidate = await getFecCandidateById(id)
    if (!fecCandidate?.candidate_id) {
      return NextResponse.json(
        { error: "Member not found" },
        { status: 404 }
      )
    }

    const [totals, pacDonations] = await Promise.all([
      getFecTotals(fecCandidate.candidate_id),
      getTopPacDonors(
        (fecCandidate.principal_committees ?? [])
          .filter((committee) => committee.designation === "P")
          .map((committee) => committee.committee_id)
          .filter((committeeId): committeeId is string => Boolean(committeeId))
      ),
    ])

    // If we only have a FEC candidate id, the trades endpoint `/api/member/:id/trades`
    // will return nothing because Quiver requires a Bioguide ID.
    // Attempt to resolve the matching Congress (Bioguide) member by name + state,
    // then pull trades for that bioguide id.
    let trades: Trade[] = []

    try {
      const congressApiKey =
        process.env.CONGRESS_API_KEY ??
        process.env.CONGRESS_GOV_API_KEY

      if (congressApiKey && fecCandidate.name && fecCandidate.state) {
        const url = new URL("https://api.congress.gov/v3/member")
        url.searchParams.set("format", "json")
        url.searchParams.set("api_key", congressApiKey)
        url.searchParams.set("limit", "250")

        // Congress.gov supports `name=` (partial match) on the list endpoint.
        // We use it to reduce the list, then pick the closest match.
        const lastName = fecCandidate.name.split(",")[0]?.trim()
        if (lastName) {
          url.searchParams.set("name", lastName)
        }

        const res = await fetch(url.toString(), { cache: "no-store" })
        if (res.ok) {
          const payload = (await res.json()) as CongressMemberListResponse

          const members: CongressMemberDetail[] = (payload.members ?? [])
            .map((member) => ("member" in member ? member.member ?? null : member))
            .filter((member): member is CongressMemberDetail => Boolean(member))

          const targetState = fecCandidate.state.toUpperCase()
          const targetName = fecCandidate.name.toUpperCase()

          const match =
            members.find(
              (m) =>
                (m.state ?? "").toUpperCase() === targetState &&
                getMemberName(m).toUpperCase().includes(targetName.split(",")[0] ?? "")
            ) ??
            members.find((m) => (m.state ?? "").toUpperCase() === targetState)

          const bioguideId = match?.bioguideId
          if (bioguideId) {
            trades = await getCongressTrades(bioguideId)
          }
        }
      }
    } catch {
      trades = []
    }

    return NextResponse.json(
      mapFecCandidateToResponse(fecCandidate, totals, pacDonations, trades)
    )
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
