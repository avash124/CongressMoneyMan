// Per-section profile loaders for member / senator pages.
//
// Each loader is wrapped in React `cache()` so that, within a single request,
// the shared Congress.gov fetch and FEC lookup run exactly once even though
// multiple streamed <Suspense> sections await them independently. This replaces
// the previous intra-server HTTP self-call (`fetch(.../api/member/${id})`) and
// lets the fast Congress.gov header stream ahead of the slow FEC/Quiver data.

import { cache } from "react"
import type { Industry, Member, PacDonation, Trade } from "@/types/member"
import { getStateCode } from "./congress"
import { fetchAllCongressTrades, formatTradeRange } from "./quiver"
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

// The header only needs totals (one cheap FEC request); the industries / PAC
// cards need the donations (up to 15 sequential FEC pages). Loading them
// separately lets the header stream ahead instead of blocking on pagination.
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

// Member profiles show each member's ten most-recent disclosed trades, newest
// first. The backfilled `trades` table (Quiver's bulk endpoint) is the source,
// indexed per member; the live feed — capped at ~1000 recent disclosures across
// all of Congress — is only a fallback for before the first backfill has run.
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

// Collapse the raw per-contribution list into per-donor totals — the shape stored
// in `pac_donations` and read back to derive top donors + industries.
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

// DB-first totals: serve the persisted candidate row on a hit; on a miss resolve
// the candidate, return live FEC totals, and write the row back for next time.
// `resolveRef` is a thunk so the candidate search only runs on a DB miss.
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

// DB-first donations: serve persisted per-donor rows on a hit; on a miss fetch the
// FEC donations, return top donors + industries, and write the aggregates back.
async function loadFecDonations(
  id: string,
  resolveRef: () => Promise<FecCandidateRef | null>
): Promise<FecDonationsResult> {
  const stored = await getPacDonationsFromDb(id)
  if (stored.length > 0) return donationsFromRows(stored)

  const apiKey = process.env.FEC_API_KEY
  const ref = await resolveRef()
  if (!apiKey || !ref) return EMPTY_DONATIONS

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
}

function principalCommittees(candidate: FecCandidate): string[] {
  return (
    candidate.principal_committees
      ?.filter((c) => c.designation === "P")
      .map((c) => c.committee_id)
      .filter((cid): cid is string => Boolean(cid)) ?? []
  )
}

// ---------------------------------------------------------------------------
// House member
// ---------------------------------------------------------------------------

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

// Search FEC for a candidate + principal committees. Extracted from the per-request
// resolvers below so the `sync-fec` ETL cron can resolve candidates straight from a
// member list without the request-scoped Congress.gov detail fetch / React cache.
// `preferIncumbent` selects the incumbent-then-active candidate (senators); otherwise
// the first result is taken (House).
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
