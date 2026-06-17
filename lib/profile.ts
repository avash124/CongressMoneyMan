import { cache } from "react"
import type {
  AssetAllocation,
  Industry,
  Member,
  PacDonation,
  Trade,
} from "@/types/member"
import { getStateCode } from "./congress"
import {
  classifyTransaction,
  fetchAllCongressTrades,
  formatTradeRange,
  parseTradeRange,
} from "./quiver"
import { fetchPacDonations, fetchFecTotals, computeTopIndustries } from "./fec"
import {
  getFecCandidateFromDb,
  getPacDonationsFromDb,
  getTradesByBioguide,
  upsertFecCandidate,
  replacePacDonations,
  writeBack,
  type DbPacDonation,
  type DbTrade,
} from "./db"

type RawTerm = {
  chamber?: string
  endYear?: number
  stateCode?: string
  stateName?: string
}

type RawCongressMember = {
  bioguideId?: string
  firstName?: string
  lastName?: string
  party?: string
  partyName?: string
  partyHistory?: Array<{ partyAbbreviation?: string }>
  state?: string
  district?: string | number | null
  terms?: RawTerm[]
  depiction?: { imageUrl?: string; attribution?: string }
}

type FecCandidate = {
  candidate_id?: string
  candidate_status?: string
  incumbent_challenge?: string
  principal_committees?: Array<{ committee_id?: string; designation?: string }>
}

export type FecResult = {
  totalRaised: number
  totalSpent: number
  pacDonations: PacDonation[]
  topIndustries: Industry[]
}

export type FecTotalsResult = { totalRaised: number; totalSpent: number }
export type FecDonationsResult = { pacDonations: PacDonation[]; topIndustries: Industry[] }

const EMPTY_TOTALS: FecTotalsResult = { totalRaised: 0, totalSpent: 0 }
const EMPTY_DONATIONS: FecDonationsResult = { pacDonations: [], topIndustries: [] }

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
  if (normalized === "R" || normalized === "REP" || normalized === "REPUBLICAN") {
    return "R"
  }
  return "I"
}

const fetchRawMember = cache(async (id: string): Promise<RawCongressMember | null> => {
  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY
  if (!apiKey) return null

  const res = await fetch(`https://api.congress.gov/v3/member/${id}?format=json`, {
    headers: { "X-Api-Key": apiKey },
    next: { revalidate: 3600 },
  })
  if (!res.ok) return null

  const data = (await res.json()) as { member?: RawCongressMember }
  return data.member ?? null
})

function tradeFromDbRow(row: DbTrade): Trade {
  return {
    id: row.trade_id,
    ticker: row.ticker ?? "Unknown",
    transactionType: row.transaction_type ?? "Unknown",
    transactionDate: row.transaction_date ?? row.traded ?? "Unknown",
    // Bulk-history rows carry only the numeric amount, not a formatted range.
    amount: row.range_text ?? formatTradeRange(Number(row.trade_size_usd ?? 0)),
  }
}
const RECENT_TRADES_LIMIT = 10

const byTradeDateDesc = (a: Trade, b: Trade): number =>
  (Date.parse(b.transactionDate) || 0) - (Date.parse(a.transactionDate) || 0)

export const loadTrades = cache(async (id: string): Promise<Trade[]> => {
  const rows = await getTradesByBioguide(id)
  if (rows.length > 0) {
    return rows
      .map(tradeFromDbRow)
      .sort(byTradeDateDesc)
      .slice(0, RECENT_TRADES_LIMIT)
  }

  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) return []
  try {
    const allTrades = await fetchAllCongressTrades(apiKey)
    return allTrades
      .filter((trade) => trade.Bioguide === id)
      .map((trade) => ({
        id: String(trade.UniqueID ?? ""),
        ticker: trade.Ticker ?? "Unknown",
        transactionType: trade.Transaction ?? "Unknown",
        transactionDate: trade.Date ?? trade.Traded ?? "Unknown",
        amount: trade.Range ?? formatTradeRange(Number(trade.Trade_Size_USD)),
      }))
      .sort(byTradeDateDesc)
      .slice(0, RECENT_TRADES_LIMIT)
  } catch {
    return []
  }
})
// Ordered most-specific first; the first pattern to hit the combined
// asset-type + description text wins. The description is scanned too because the
// Quiver `AssetType`/`TickerType` field is usually just "ST"/empty, so real
// estate, crypto, ETFs, etc. are only recoverable from the asset name. Stocks
// sits below the asset classes that also trade like equities (ETFs/REITs) and
// above Trusts so a bank named "...Trust" stays a stock — a heuristic estimate
// matching the card's "estimated holdings" framing.
const ASSET_CATEGORY_RULES: Array<[category: string, pattern: RegExp]> = [
  ["Real Estate", /real estate|real property|\breit\b|realty|rental propert|land trust/],
  ["Crypto", /crypto|bitcoin|ethereum|\bbtc\b|\beth\b|digital asset|stablecoin/],
  ["Options", /\boption\b|stock option|\bop\b|warrant/],
  ["ETFs", /\betf\b|\betn\b|\betp\b|exchange[- ]traded/],
  ["Municipal Bonds", /muni/],
  ["Bonds", /\bbond\b|debenture|fixed income|promissory note|treasury (bill|note|bond)/],
  ["Mutual Funds", /mutual fund|index fund|\bfund\b/],
  ["Stocks", /\bstock\b|\bst\b|equity|common|\bshares?\b/],
  ["Trusts", /\btrust\b/],
]

function normalizeAssetCategory(
  type: string | null | undefined,
  description?: string | null
): string {
  const text = `${type ?? ""} ${description ?? ""}`.toLowerCase()
  if (!text.trim()) return "Other"
  for (const [category, pattern] of ASSET_CATEGORY_RULES) {
    if (pattern.test(text)) return category
  }
  // Unknown but non-empty type still gets its own labelled slice.
  const raw = (type ?? "").trim()
  return raw ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : "Other"
}

function disclosureMidpoint(
  rangeText: string | null,
  lowerBound: number | null
): number {
  const text = rangeText ?? (lowerBound != null ? formatTradeRange(lowerBound) : null)
  const parsed = parseTradeRange(text ?? undefined)
  if (parsed) return (parsed.low + parsed.high) / 2
  const size = Number(lowerBound ?? 0)
  return Number.isFinite(size) ? size : 0
}

type RawPosition = {
  ticker: string
  category: string
  direction: "buy" | "sell" | "other"
  value: number
}

function breakdownFromPositions(positions: RawPosition[]): AssetAllocation[] {
  const netByTicker = new Map<string, { category: string; net: number }>()
  for (const p of positions) {
    if (p.direction === "other") continue
    const signed = p.direction === "buy" ? p.value : -p.value
    const existing = netByTicker.get(p.ticker)
    if (existing) existing.net += signed
    else netByTicker.set(p.ticker, { category: p.category, net: signed })
  }

  const byCategory = new Map<string, number>()
  for (const { category, net } of netByTicker.values()) {
    if (net <= 0) continue
    byCategory.set(category, (byCategory.get(category) ?? 0) + net)
  }

  return [...byCategory.entries()]
    .map(([category, value]) => ({ category, value: Math.round(value) }))
    .sort((a, b) => b.value - a.value)
}
export const loadPortfolioBreakdown = cache(
  async (id: string): Promise<AssetAllocation[]> => {
    const rows = await getTradesByBioguide(id)
    if (rows.length > 0) {
      return breakdownFromPositions(
        rows.map((r) => ({
          ticker: r.ticker || r.asset_name || "Unknown",
          category: normalizeAssetCategory(r.asset_type, r.asset_name),
          direction: classifyTransaction(r.transaction_type ?? undefined),
          value: disclosureMidpoint(r.range_text, r.trade_size_usd),
        }))
      )
    }

    const apiKey = process.env.QUIVER_API_KEY
    if (!apiKey) return []
    try {
      const all = await fetchAllCongressTrades(apiKey)
      return breakdownFromPositions(
        all
          .filter((t) => t.Bioguide === id)
          .map((t) => ({
            ticker: t.Ticker || t.AssetDescription || "Unknown",
            category: normalizeAssetCategory(t.AssetType, t.AssetDescription),
            direction: classifyTransaction(t.Transaction),
            value: disclosureMidpoint(
              t.Range ?? null,
              t.Trade_Size_USD != null ? Number(t.Trade_Size_USD) : null
            ),
          }))
      )
    } catch {
      return []
    }
  }
)

type FecCandidateRef = { candidateId: string; committeeIds: string[] }

async function totalsFromCandidate(
  ref: FecCandidateRef | null,
  apiKey: string | undefined
): Promise<FecTotalsResult> {
  if (!apiKey || !ref) return EMPTY_TOTALS
  const totals = await fetchFecTotals(ref.candidateId, apiKey)
  return {
    totalRaised: totals?.receipts ?? 0,
    totalSpent: totals?.disbursements ?? 0,
  }
}

export function currentCycle(): number {
  const year = new Date().getFullYear()
  return year % 2 === 0 ? year : year - 1
}

export function aggregateDonors(
  allDonations: { pacName: string; amount: number }[]
): { pacName: string; amount: number }[] {
  const totals: Record<string, number> = {}
  for (const { pacName, amount } of allDonations) {
    totals[pacName] = (totals[pacName] ?? 0) + amount
  }
  return Object.entries(totals).map(([pacName, amount]) => ({ pacName, amount }))
}

function donationsFromRows(rows: DbPacDonation[]): FecDonationsResult {
  const donations = rows.map((r) => ({ pacName: r.pac_name, amount: r.amount }))
  const pacDonations = [...donations].sort((a, b) => b.amount - a.amount).slice(0, 10)
  return { pacDonations, topIndustries: computeTopIndustries(donations) }
}
async function loadFecTotals(
  id: string,
  resolveRef: () => Promise<FecCandidateRef | null>
): Promise<FecTotalsResult> {
  const stored = await getFecCandidateFromDb(id)
  if (stored) return { totalRaised: stored.total_raised, totalSpent: stored.total_spent }

  const ref = await resolveRef()
  const totals = await totalsFromCandidate(ref, process.env.FEC_API_KEY)
  if (ref) {
    writeBack(() =>
      upsertFecCandidate({
        bioguide_id: id,
        candidate_id: ref.candidateId,
        committee_ids: ref.committeeIds,
        total_raised: totals.totalRaised,
        total_spent: totals.totalSpent,
        cycle: currentCycle(),
      })
    )
  }
  return totals
}
async function loadFecDonations(
  id: string,
  resolveRef: () => Promise<FecCandidateRef | null>
): Promise<FecDonationsResult> {
  const stored = await getPacDonationsFromDb(id)
  if (stored.length > 0) return donationsFromRows(stored)

  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return EMPTY_DONATIONS

  // A failed FEC lookup must degrade to "no donations" rather than throw — an
  // uncaught rejection here blanks the cards instead of rendering their empty
  // state (members usually hit the DB branch above; senators fall through to the
  // live API, so the failure surfaced on senator profiles).
  try {
    const ref = await resolveRef()
    if (!ref) return EMPTY_DONATIONS

    const { topDonors, allDonations } = await fetchPacDonations(ref.committeeIds, apiKey)
    const cycle = currentCycle()
    const rows: DbPacDonation[] = aggregateDonors(allDonations).map((d) => ({
      bioguide_id: id,
      pac_name: d.pacName,
      amount: d.amount,
      cycle,
    }))
    writeBack(() => replacePacDonations(id, rows))

    return { pacDonations: topDonors, topIndustries: computeTopIndustries(allDonations) }
  } catch (error) {
    console.warn(`[profile] loadFecDonations(${id}) failed:`, error)
    return EMPTY_DONATIONS
  }
}

function principalCommittees(candidate: FecCandidate): string[] {
  return (
    candidate.principal_committees
      ?.filter((c) => c.designation === "P")
      .map((c) => c.committee_id)
      .filter((cid): cid is string => Boolean(cid)) ?? []
  )
}
export const loadMemberBase = cache(async (id: string): Promise<Member | null> => {
  const member = await fetchRawMember(id)
  if (!member?.bioguideId) return null

  const latestTerm = (member.terms ?? []).at(-1)
  const district =
    latestTerm?.chamber === "Senate" ? "Senate" : `District ${member.district}`

  return {
    id: member.bioguideId,
    name: [member.firstName, member.lastName].filter(Boolean).join(" "),
    party: getPartyCode(member.partyHistory?.[0]?.partyAbbreviation),
    state: member.state ?? "",
    district,
    imageUrl: member.depiction?.imageUrl,
    totalRaised: 0,
    totalSpent: 0,
    topIndustries: [],
    pacDonations: [],
    trades: [],
  }
})
export type FecSearchParams = {
  name: string
  stateCode: string
  office: "H" | "S"
  preferIncumbent: boolean
  perPage: number
}

export async function resolveFecCandidate(
  params: FecSearchParams
): Promise<FecCandidateRef | null> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey || !params.stateCode) return null

  const url = new URL("https://api.open.fec.gov/v1/candidates/search/")
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("name", params.name)
  url.searchParams.set("state", params.stateCode)
  url.searchParams.set("office", params.office)
  url.searchParams.set("cycle", String(currentCycle()))
  url.searchParams.set("per_page", String(params.perPage))

  const res = await fetch(url.toString(), { next: { revalidate: 3600 } })
  if (!res.ok) return null

  const data = (await res.json()) as { results?: FecCandidate[] }
  const results = data.results ?? []
  const candidate = params.preferIncumbent
    ? results.find((c) => c.incumbent_challenge === "I" && c.candidate_status === "C") ??
      results.find((c) => c.incumbent_challenge === "I") ??
      results.find((c) => c.candidate_status === "C") ??
      null
    : results[0] ?? null

  if (!candidate?.candidate_id) return null
  return { candidateId: candidate.candidate_id, committeeIds: principalCommittees(candidate) }
}

const resolveMemberCandidate = cache(async (id: string): Promise<FecCandidateRef | null> => {
  const member = await fetchRawMember(id)
  if (!member) return null

  const latestTerm = (member.terms ?? []).at(-1)
  return resolveFecCandidate({
    name: member.lastName ?? "",
    stateCode: getStateCode(member.state),
    office: latestTerm?.chamber === "Senate" ? "S" : "H",
    preferIncumbent: false,
    perPage: 10,
  })
})

export const loadMemberFecTotals = cache((id: string): Promise<FecTotalsResult> =>
  loadFecTotals(id, () => resolveMemberCandidate(id))
)

export const loadMemberFecDonations = cache((id: string): Promise<FecDonationsResult> =>
  loadFecDonations(id, () => resolveMemberCandidate(id))
)

export const loadMemberFec = cache(async (id: string): Promise<FecResult> => {
  const [totals, donations] = await Promise.all([
    loadMemberFecTotals(id),
    loadMemberFecDonations(id),
  ])
  return { ...totals, ...donations }
})

function getCurrentSenateTerm(member: RawCongressMember): RawTerm | null {
  return (
    (member.terms ?? []).find(
      (term) => !term.endYear && term.chamber?.includes("Senate")
    ) ?? null
  )
}

export const loadSenatorBase = cache(async (id: string): Promise<Member | null> => {
  const senator = await fetchRawMember(id)
  if (!senator?.bioguideId || !getCurrentSenateTerm(senator)) return null

  const currentTerm = getCurrentSenateTerm(senator)
  return {
    id: senator.bioguideId,
    name: [senator.firstName, senator.lastName].filter(Boolean).join(" "),
    party: getPartyCode(
      senator.partyHistory?.[0]?.partyAbbreviation ?? senator.party ?? senator.partyName
    ),
    state: getStateCode(
      senator.state ?? currentTerm?.stateCode ?? currentTerm?.stateName
    ),
    district: "Senate",
    imageUrl: senator.depiction?.imageUrl,
    totalRaised: 0,
    totalSpent: 0,
    topIndustries: [],
    pacDonations: [],
    trades: [],
  }
})

const resolveSenatorCandidate = cache(async (id: string): Promise<FecCandidateRef | null> => {
  const senator = await fetchRawMember(id)
  if (!senator) return null

  const currentTerm = getCurrentSenateTerm(senator)
  const name =
    `${senator.firstName ?? ""} ${senator.lastName ?? ""}`.trim() || (senator.lastName ?? "")
  return resolveFecCandidate({
    name,
    stateCode: getStateCode(senator.state ?? currentTerm?.stateCode ?? currentTerm?.stateName),
    office: "S",
    preferIncumbent: true,
    perPage: 20,
  })
})

export const loadSenatorFecTotals = cache((id: string): Promise<FecTotalsResult> =>
  loadFecTotals(id, () => resolveSenatorCandidate(id))
)

export const loadSenatorFecDonations = cache((id: string): Promise<FecDonationsResult> =>
  loadFecDonations(id, () => resolveSenatorCandidate(id))
)

export const loadSenatorFec = cache(async (id: string): Promise<FecResult> => {
  const [totals, donations] = await Promise.all([
    loadSenatorFecTotals(id),
    loadSenatorFecDonations(id),
  ])
  return { ...totals, ...donations }
})


export async function loadMemberProfile(id: string): Promise<Member | null> {
  const [base, fec, trades] = await Promise.all([
    loadMemberBase(id),
    loadMemberFec(id),
    loadTrades(id),
  ])
  if (!base) return null
  return { ...base, ...fec, trades }
}

export async function loadSenatorProfile(id: string): Promise<Member | null> {
  const [base, fec, trades] = await Promise.all([
    loadSenatorBase(id),
    loadSenatorFec(id),
    loadTrades(id),
  ])
  if (!base) return null
  return { ...base, ...fec, trades }
}
