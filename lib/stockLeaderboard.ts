import { getCache, setCache } from "./cache"
import {
  getAllTrades,
  getHoldingsByTicker,
  getHoldingsFromDb,
  replaceHoldingsForMembers,
  type DbHolding,
  type DbTrade,
} from "./db"
import { getCompanyProfile, getDailyCloses, type CompanyProfile } from "./prices"
import { classifyTransaction, formatTradeRange, parseTradeRange } from "./quiver"
import { categorizeIndustry } from "@/app/api/member/[id]/industryClassifier"
import { staticProfile } from "./sectorMap"

// v3: sectors resolved via provider sector -> keyword classifier (no "Unknown").
export const HOLDINGS_KEY = "stock-holdings-v4"
export const PERFORMANCE_KEY = "stock-performance"
const HOLDINGS_TTL_SECONDS = 6 * 60 * 60
const PERFORMANCE_TTL_SECONDS = 36 * 60 * 60

const HOLDINGS_TOP_N = 120
const PERF_UNIVERSE_SIZE = 25
const PERF_TOP_N = 30
const MAX_BUY_DATES_PER_TICKER = 12
const PERF_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000
const PRICE_CONCURRENCY = 3
const PROFILE_CONCURRENCY = 4
export type HoldingPosition = { ticker: string; value: number }

export type MemberHoldings = {
  bioguideId: string
  memberName: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
  positions: HoldingPosition[]
}

export type HoldingsRow = {
  ticker: string
  name: string
  totalValue: number
  sector: string
}

export type TickerHolder = {
  bioguideId: string
  name: string
  party: string
  chamber: "house" | "senate"
  value: number
}

export type TickerHolders = {
  ticker: string
  totalValue: number
  houseCount: number
  senateCount: number
  holders: TickerHolder[]
}

export type PerformanceRow = {
  ticker: string
  gainPct: number
  estGain: number
  boughtValue: number
  memberCount: number
  houseCount: number
  senateCount: number
}

const isSenate = (chamber: string | null | undefined): boolean =>
  (chamber ?? "").toLowerCase().includes("senate")


async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await mapper(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  )
  return results
}
export function buildHoldingsLeaderboard(
  holdings: DbHolding[]
): { ticker: string; totalValue: number }[] {
  const byTicker = new Map<string, number>()

  for (const h of holdings) {
    const ticker = h.ticker?.trim().toUpperCase()
    if (!ticker) continue
    const value = Number(h.value)
    if (!Number.isFinite(value) || value <= 0) continue
    byTicker.set(ticker, (byTicker.get(ticker) ?? 0) + value)
  }

  return [...byTicker.entries()]
    .map(([ticker, totalValue]) => ({ ticker, totalValue: Math.round(totalValue) }))
    .sort((l, r) => r.totalValue - l.totalValue)
    .slice(0, HOLDINGS_TOP_N)
}
// Prefer the data provider's clean sector; otherwise fall back to the keyword
// classifier over the company name + granular industry so nothing lands on
// "Unknown" (worst case is the classifier's "Other").
function resolveSector(profile: CompanyProfile | null): string {
  if (!profile) return "Other"
  if (profile.sector) return profile.sector
  const text = `${profile.name} ${profile.industry}`.trim()
  return text ? categorizeIndustry(text) : "Other"
}

async function enrichHoldings(
  rows: { ticker: string; totalValue: number }[]
): Promise<HoldingsRow[]> {
  return mapWithConcurrency(rows, PROFILE_CONCURRENCY, async (row) => {
    // Curated map first: correct name + sector with no network call, so the
    // common holdings are always classified even if the profile API is down.
    const known = staticProfile(row.ticker)
    if (known) {
      return { ticker: row.ticker, name: known.name, totalValue: row.totalValue, sector: known.sector }
    }

    const profile = await getCompanyProfile(row.ticker).catch(() => null)
    return {
      ticker: row.ticker,
      name: profile?.name || row.ticker,
      totalValue: row.totalValue,
      sector: resolveSector(profile),
    }
  })
}

export async function persistHoldings(members: MemberHoldings[]): Promise<void> {
  if (members.length === 0) return

  const rows: DbHolding[] = []
  for (const m of members) {
    const byTicker = new Map<string, number>()
    for (const p of m.positions) {
      const ticker = p.ticker.trim().toUpperCase()
      if (!ticker || !Number.isFinite(p.value) || p.value <= 0) continue
      byTicker.set(ticker, (byTicker.get(ticker) ?? 0) + p.value)
    }
    for (const [ticker, value] of byTicker) {
      rows.push({
        bioguide_id: m.bioguideId,
        member_name: m.memberName,
        party: m.party,
        chamber: m.chamber,
        ticker,
        value,
      })
    }
  }

  await replaceHoldingsForMembers(
    members.map((m) => m.bioguideId),
    rows
  )

  const all = await getHoldingsFromDb()
  if (all.length > 0) {
    const enriched = await enrichHoldings(buildHoldingsLeaderboard(all))
    await setCache(HOLDINGS_KEY, enriched, HOLDINGS_TTL_SECONDS)
  }
}

export async function getHoldingsLeaderboard(): Promise<HoldingsRow[]> {
  const cached = await getCache<HoldingsRow[]>(HOLDINGS_KEY)
  if (cached && cached.length > 0) return cached

  const all = await getHoldingsFromDb()
  if (all.length === 0) return []

  const enriched = await enrichHoldings(buildHoldingsLeaderboard(all))
  await setCache(HOLDINGS_KEY, enriched, HOLDINGS_TTL_SECONDS)
  return enriched
}
export async function getTickerHolders(ticker: string): Promise<TickerHolders> {
  const normalized = ticker.trim().toUpperCase()
  const rows = await getHoldingsByTicker(normalized)

  const byMember = new Map<string, TickerHolder>()
  for (const h of rows) {
    const value = Number(h.value)
    if (!Number.isFinite(value) || value <= 0) continue
    const existing = byMember.get(h.bioguide_id)
    if (existing) {
      existing.value += value
    } else {
      byMember.set(h.bioguide_id, {
        bioguideId: h.bioguide_id,
        name: h.member_name ?? h.bioguide_id,
        party: h.party ?? "",
        chamber: isSenate(h.chamber) ? "senate" : "house",
        value,
      })
    }
  }

  const holders = [...byMember.values()]
    .map((h) => ({ ...h, value: Math.round(h.value) }))
    .sort((a, b) => b.value - a.value)

  return {
    ticker: normalized,
    totalValue: holders.reduce((sum, h) => sum + h.value, 0),
    houseCount: holders.filter((h) => h.chamber === "house").length,
    senateCount: holders.filter((h) => h.chamber === "senate").length,
    holders,
  }
}

function isRealTicker(ticker: string | null | undefined): ticker is string {
  return Boolean(ticker) && ticker !== "-" && /^[A-Za-z.]{1,6}$/.test(ticker!)
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

type TickerBuys = {
  ticker: string
  boughtValue: number
  members: Set<string>
  house: Set<string>
  senate: Set<string>
  weightByDate: Map<string, number>
}

function aggregateBuys(trades: DbTrade[]): TickerBuys[] {
  const cutoff = Date.now() - PERF_LOOKBACK_MS
  const byTicker = new Map<string, TickerBuys>()

  for (const t of trades) {
    if (classifyTransaction(t.transaction_type ?? undefined) !== "buy") continue
    if (!isRealTicker(t.ticker)) continue
    const ticker = t.ticker.toUpperCase()

    let agg = byTicker.get(ticker)
    if (!agg) {
      agg = {
        ticker,
        boughtValue: 0,
        members: new Set(),
        house: new Set(),
        senate: new Set(),
        weightByDate: new Map(),
      }
      byTicker.set(ticker, agg)
    }

    const weight = disclosureMidpoint(t.range_text, t.trade_size_usd)
    agg.boughtValue += weight
    agg.members.add(t.bioguide_id)
    if (isSenate(t.chamber)) agg.senate.add(t.bioguide_id)
    else agg.house.add(t.bioguide_id)

    const date = t.transaction_date ?? t.traded ?? ""
    const parsed = Date.parse(date)
    if (Number.isFinite(parsed) && parsed >= cutoff && weight > 0) {
      const day = date.slice(0, 10)
      agg.weightByDate.set(day, (agg.weightByDate.get(day) ?? 0) + weight)
    }
  }

  return [...byTicker.values()].filter((a) => a.weightByDate.size > 0)
}

async function performanceForTicker(buys: TickerBuys): Promise<PerformanceRow | null> {
  const dates = [...buys.weightByDate.entries()]
    .sort((a, b) => Date.parse(b[0]) - Date.parse(a[0]))
    .slice(0, MAX_BUY_DATES_PER_TICKER)
  if (dates.length === 0) return null
  const earliest = dates.reduce(
    (min, [day]) => (Date.parse(day) < Date.parse(min) ? day : min),
    dates[0][0]
  )
  const series = await getDailyCloses(buys.ticker, earliest)
  if (series.length === 0) return null

  const currentPrice = series[series.length - 1].close
  if (!(currentPrice > 0)) return null

  const priceOn = (day: string): number | null => {
    const t = Date.parse(day)
    let chosen: number | null = null
    for (const bar of series) {
      if (Date.parse(bar.date) <= t) chosen = bar.close
      else break
    }
    return chosen
  }

  let estGain = 0
  let base = 0
  for (const [day, weight] of dates) {
    const buyPrice = priceOn(day)
    if (buyPrice == null || buyPrice <= 0) continue
    estGain += weight * ((currentPrice - buyPrice) / buyPrice)
    base += weight
  }
  if (base <= 0) return null

  return {
    ticker: buys.ticker,
    gainPct: (estGain / base) * 100,
    estGain: Math.round(estGain),
    boughtValue: Math.round(base),
    memberCount: buys.members.size,
    houseCount: buys.house.size,
    senateCount: buys.senate.size,
  }
}

export async function refreshStockPerformance(): Promise<PerformanceRow[]> {
  const trades = await getAllTrades()
  const universe = aggregateBuys(trades)
    .sort((l, r) => r.boughtValue - l.boughtValue)
    .slice(0, PERF_UNIVERSE_SIZE)

  const rows = (await mapWithConcurrency(universe, PRICE_CONCURRENCY, performanceForTicker))
    .filter((row): row is PerformanceRow => row !== null)
    .sort((l, r) => r.gainPct - l.gainPct)
    .slice(0, PERF_TOP_N)

  // An empty result means every price lookup failed (rate limits), not that
  // nothing performed — don't overwrite the last good board with a blank one.
  if (rows.length > 0) {
    await setCache(PERFORMANCE_KEY, rows, PERFORMANCE_TTL_SECONDS)
  }
  return rows
}

export async function getStockPerformance(): Promise<PerformanceRow[]> {
  return (await getCache<PerformanceRow[]>(PERFORMANCE_KEY)) ?? []
}
