import { getCache, setCache } from "./cache"
import {
  getAllFecCandidates,
  getMembersFromDb,
  getPacDonationsByName,
  type DbMember,
} from "./db"

export type PacRecipient = {
  bioguideId: string
  name: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
  amount: number
}

export type PacRecipients = {
  pacName: string
  totalAmount: number
  houseCount: number
  senateCount: number
  recipients: PacRecipient[]
}

export type SpendingPoint = { t: number; c: number }

const RECIPIENTS_TTL_SECONDS = 6 * 60 * 60
const COMMITTEE_ID_TTL_SECONDS = 30 * 24 * 60 * 60
const COMMITTEE_MISS_TTL_SECONDS = 6 * 60 * 60
const SPENDING_TTL_SECONDS = 12 * 60 * 60
const REPORT_MAX_PAGES = 3

function normalizeParty(value: string | null | undefined): "D" | "R" | "I" {
  const v = (value ?? "").trim().toUpperCase()
  if (v.startsWith("D")) return "D"
  if (v.startsWith("R")) return "R"
  return "I"
}


export async function getPacRecipients(pacName: string): Promise<PacRecipients> {
  const cacheKey = `pac-recipients:${pacName.toLowerCase()}`
  const cached = await getCache<PacRecipients>(cacheKey)
  if (cached) return cached

  const [rows, house, senate] = await Promise.all([
    getPacDonationsByName(pacName),
    getMembersFromDb("house"),
    getMembersFromDb("senate"),
  ])

  const byId = new Map<string, DbMember>()
  for (const m of [...house, ...senate]) byId.set(m.bioguide_id, m)

  const byMember = new Map<string, PacRecipient>()
  for (const r of rows) {
    const member = byId.get(r.bioguide_id)
    if (!member) continue
    const amount = Number(r.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const existing = byMember.get(r.bioguide_id)
    if (existing) {
      existing.amount += amount
    } else {
      byMember.set(r.bioguide_id, {
        bioguideId: r.bioguide_id,
        name: member.name,
        party: normalizeParty(member.party),
        chamber: member.chamber === "senate" ? "senate" : "house",
        amount,
      })
    }
  }

  const recipients = [...byMember.values()]
    .map((r) => ({ ...r, amount: Math.round(r.amount) }))
    .sort((a, b) => b.amount - a.amount)

  const result: PacRecipients = {
    pacName,
    totalAmount: recipients.reduce((sum, r) => sum + r.amount, 0),
    houseCount: recipients.filter((r) => r.chamber === "house").length,
    senateCount: recipients.filter((r) => r.chamber === "senate").length,
    recipients,
  }

  if (recipients.length > 0) await setCache(cacheKey, result, RECIPIENTS_TTL_SECONDS)
  return result
}

type FecCommittee = { committee_id?: string; committee_type?: string; name?: string }
const PAC_TYPE_PRIORITY = ["Q", "N", "O", "V", "W", "U", "D"]
const NAME_STOPWORDS = new Set([
  "POLITICAL", "ACTION", "COMMITTEE", "FUND", "NATIONAL", "AMERICAN",
  "ASSOCIATION", "FEDERAL", "INC", "CORP", "CORPORATION", "COMPANY", "THE",
])

function typeRank(type: string | undefined): number {
  const i = type ? PAC_TYPE_PRIORITY.indexOf(type) : -1
  return i === -1 ? PAC_TYPE_PRIORITY.length : i
}

function significantTokens(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t))
}
function pickCommittee(results: FecCommittee[], tokens: string[]): string | null {
  const named = results.filter((c) => c.committee_id && c.name)
  const matches =
    tokens.length === 0
      ? named
      : named.filter((c) => {
          const upper = c.name!.toUpperCase()
          return tokens.some((t) => upper.includes(t))
        })
  if (matches.length === 0) return null
  matches.sort((a, b) => typeRank(a.committee_type) - typeRank(b.committee_type))
  return matches[0].committee_id ?? null
}

async function searchCommittees(query: string, apiKey: string): Promise<FecCommittee[]> {
  const url = new URL("https://api.open.fec.gov/v1/committees/")
  url.searchParams.set("api_key", apiKey)
  url.searchParams.set("q", query)
  url.searchParams.set("per_page", "20")
  const res = await fetch(url.toString(), { next: { revalidate: 86400 } })
  if (!res.ok) return []
  const data = await res.json()
  return (data.results ?? []) as FecCommittee[]
}

async function resolvePacCommitteeId(
  pacName: string,
  apiKey: string
): Promise<string | null> {
  const cacheKey = `pac-committee-id:${pacName.toLowerCase()}`
  const cached = await getCache<{ id: string | null }>(cacheKey)
  if (cached) return cached.id
  const cleaned = pacName
    .replace(/\bPOLITICAL ACTION COMMITTEE\b/i, "")
    .replace(/\bPAC\b/i, "")
    .replace(/\s+/g, " ")
    .trim()
  const queries =
    cleaned && cleaned.toUpperCase() !== pacName.toUpperCase()
      ? [pacName, cleaned]
      : [pacName]
  const tokens = significantTokens(pacName)

  let id: string | null = null
  try {
    for (const query of queries) {
      const results = await searchCommittees(query, apiKey)
      id = pickCommittee(results, tokens)
      if (id) break
    }
  } catch (error) {
    console.warn(`[pac] resolvePacCommitteeId(${pacName}) failed:`, error)
  }

  await setCache(cacheKey, { id }, id ? COMMITTEE_ID_TTL_SECONDS : COMMITTEE_MISS_TTL_SECONDS)
  return id
}

type FecReport = {
  coverage_end_date?: string
  total_disbursements_period?: number | string
  most_recent?: boolean
  receipt_date?: string
}

async function fetchPacSpendingHistory(
  committeeId: string,
  apiKey: string
): Promise<SpendingPoint[]> {
  const cacheKey = `pac-spending:${committeeId}`
  const cached = await getCache<SpendingPoint[]>(cacheKey)
  if (cached) return cached

  const reports: FecReport[] = []
  for (let page = 1; page <= REPORT_MAX_PAGES; page++) {
    const url = new URL(
      `https://api.open.fec.gov/v1/committee/${committeeId}/reports/`
    )
    url.searchParams.set("api_key", apiKey)
    url.searchParams.set("per_page", "100")
    url.searchParams.set("page", String(page))
    url.searchParams.set("sort", "-coverage_end_date")

    const res = await fetch(url.toString(), { next: { revalidate: 3600 } })
    if (!res.ok) break
    const data = await res.json()
    const results: FecReport[] = data.results ?? []
    if (results.length === 0) break
    reports.push(...results)
    const pages = data.pagination?.pages ?? 1
    if (page >= pages) break
  }

  const byPeriod = new Map<string, FecReport>()
  for (const r of reports) {
    if (!r.coverage_end_date || r.most_recent === false) continue
    const day = r.coverage_end_date.slice(0, 10)
    const existing = byPeriod.get(day)
    if (!existing || (r.receipt_date ?? "") > (existing.receipt_date ?? "")) {
      byPeriod.set(day, r)
    }
  }

  const points = [...byPeriod.entries()]
    .map(([day, r]) => ({
      t: Date.parse(day),
      c: Math.max(0, Number(r.total_disbursements_period ?? 0)),
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)

  if (points.length > 0) await setCache(cacheKey, points, SPENDING_TTL_SECONDS)
  return points
}

export async function getPacSpending(
  pacName: string
): Promise<{ committeeId: string | null; points: SpendingPoint[] }> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return { committeeId: null, points: [] }

  const committeeId = await resolvePacCommitteeId(pacName, apiKey)
  if (!committeeId) return { committeeId: null, points: [] }

  const points = await fetchPacSpendingHistory(committeeId, apiKey)
  return { committeeId, points }
}
export type FeedMember = {
  bioguideId: string
  name: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
}

export type WindowContribution = { bioguideId: string; amount: number; date: number }

export type PacContributionFeed = {
  committeeId: string | null
  members: FeedMember[]
  contributions: WindowContribution[]
}

const FEED_TTL_SECONDS = 12 * 60 * 60
const FEED_MAX_PAGES = 15
const FEED_LOOKBACK_MS = 5 * 365 * 24 * 60 * 60 * 1000

type FecScheduleA = {
  committee_id?: string
  contribution_receipt_date?: string
  contribution_receipt_amount?: number | string
  committee?: { candidate_ids?: string[] }
}

type RawContribution = {
  recipientCommitteeId: string | null
  candidateIds: string[]
  date: string
  amount: number
}
async function fetchPacContributions(
  committeeId: string,
  apiKey: string
): Promise<RawContribution[]> {
  const minDate = new Date(Date.now() - FEED_LOOKBACK_MS).toISOString().slice(0, 10)
  const out: RawContribution[] = []
  let lastIndex: string | undefined
  let lastDate: string | undefined

  for (let page = 0; page < FEED_MAX_PAGES; page++) {
    const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
    url.searchParams.set("api_key", apiKey)
    url.searchParams.set("contributor_id", committeeId)
    url.searchParams.set("min_date", minDate)
    url.searchParams.set("per_page", "100")
    url.searchParams.set("sort", "-contribution_receipt_date")
    if (lastIndex) url.searchParams.set("last_index", lastIndex)
    if (lastDate) url.searchParams.set("last_contribution_receipt_date", lastDate)

    const res = await fetch(url.toString(), { next: { revalidate: 3600 } })
    if (!res.ok) break
    const data = await res.json()
    const results: FecScheduleA[] = data.results ?? []
    if (results.length === 0) break

    for (const r of results) {
      const amount = Number(r.contribution_receipt_amount ?? 0)
      if (!Number.isFinite(amount) || amount <= 0) continue
      out.push({
        recipientCommitteeId: r.committee_id ?? null,
        candidateIds: r.committee?.candidate_ids ?? [],
        date: r.contribution_receipt_date ?? "",
        amount,
      })
    }

    const li = data.pagination?.last_indexes
    if (!li?.last_index || li.last_index === lastIndex) break
    lastIndex = li.last_index
    lastDate = li.last_contribution_receipt_date
  }

  return out
}
export async function getPacContributionFeed(
  pacName: string
): Promise<PacContributionFeed> {
  const apiKey = process.env.FEC_API_KEY
  if (!apiKey) return { committeeId: null, members: [], contributions: [] }

  const committeeId = await resolvePacCommitteeId(pacName, apiKey)
  if (!committeeId) return { committeeId: null, members: [], contributions: [] }

  const cacheKey = `pac-feed:${committeeId}`
  const cached = await getCache<PacContributionFeed>(cacheKey)
  if (cached) return cached

  const [raw, candidates, house, senate] = await Promise.all([
    fetchPacContributions(committeeId, apiKey),
    getAllFecCandidates(),
    getMembersFromDb("house"),
    getMembersFromDb("senate"),
  ])

  const committeeToBioguide = new Map<string, string>()
  const candidateToBioguide = new Map<string, string>()
  for (const c of candidates) {
    for (const cid of c.committee_ids ?? []) committeeToBioguide.set(cid, c.bioguide_id)
    if (c.candidate_id) candidateToBioguide.set(c.candidate_id, c.bioguide_id)
  }

  const memberById = new Map<string, DbMember>()
  for (const m of [...house, ...senate]) memberById.set(m.bioguide_id, m)

  const contributions: WindowContribution[] = []
  const present = new Map<string, FeedMember>()
  for (const r of raw) {
    let bioguide = r.recipientCommitteeId
      ? committeeToBioguide.get(r.recipientCommitteeId)
      : undefined
    if (!bioguide) {
      for (const cand of r.candidateIds) {
        const b = candidateToBioguide.get(cand)
        if (b) {
          bioguide = b
          break
        }
      }
    }
    if (!bioguide) continue
    const member = memberById.get(bioguide)
    if (!member) continue
    const date = Date.parse(r.date)
    if (!Number.isFinite(date)) continue

    contributions.push({ bioguideId: bioguide, amount: Math.round(r.amount), date })
    if (!present.has(bioguide)) {
      present.set(bioguide, {
        bioguideId: bioguide,
        name: member.name,
        party: normalizeParty(member.party),
        chamber: member.chamber === "senate" ? "senate" : "house",
      })
    }
  }

  const result: PacContributionFeed = {
    committeeId,
    members: [...present.values()],
    contributions,
  }
  if (contributions.length > 0) await setCache(cacheKey, result, FEED_TTL_SECONDS)
  return result
}
