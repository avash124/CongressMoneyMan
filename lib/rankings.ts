// Shared rankings computation + cache access.
//
// The expensive part (one Quiver request per member — ~435 for the House) lives
// here so it can be driven from two places:
//   1. The scheduled cron job (`/api/cron/refresh-rankings`) recomputes and
//      writes the result to Redis ahead of any user request.
//   2. The public route handlers read from Redis and only fall back to an inline
//      computation on a cold cache miss.

import { fetchHouseMembers, fetchSenateMembers, type HouseMember, type SenateMember } from "./congress"
import { fetchQuiverWithRetry, QuiverCircuitOpenError } from "./quiver"
import { getCache, setCache } from "./cache"
import { getPortfoliosFromDb, upsertPortfolios, writeBack, type DbPortfolio } from "./db"

export const HOUSE_RANKINGS_KEY = "house-rankings"
export const SENATE_RANKINGS_KEY = "senate-rankings"
export const RANKINGS_TTL_SECONDS = 2 * 60 * 60
const FANOUT_CONCURRENCY = 2
const FANOUT_DELAY_MS = 750
const CIRCUIT_OPEN_PAUSE_MS = 65_000
const MAX_CIRCUIT_WAITS = 3

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type RankingRow<M> = M & {
  netWorth: number | null
  stockHoldings: number | null
}

export type RankingsPayload<M> = {
  byNetWorth: RankingRow<M>[]
  byStockHoldings: RankingRow<M>[]
  generatedAt: string
}

type QuiverTabResponse = {
  holdings_data?: {
    politician_net_worth_live?: string
  }
  live_stock_portfolio?: {
    live_stock_portfolio?: string
  }
}

const QUIVER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "CongressMoneyMan/1.0",
  "X-Requested-With": "XMLHttpRequest",
}

function parseJsonArray(value: string | undefined): unknown[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getLiveNetWorth(payload: QuiverTabResponse): number | null {
  const values = parseJsonArray(payload.holdings_data?.politician_net_worth_live)
  const value = values[0]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function getLiveStockHoldings(payload: QuiverTabResponse): number | null {
  const positions = parseJsonArray(payload.live_stock_portfolio?.live_stock_portfolio)
  let total = 0
  let foundPosition = false
  for (const position of positions) {
    if (!Array.isArray(position)) continue
    const value = position[1]
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    total += value
    foundPosition = true
  }
  return foundPosition ? total : null
}

function compareRankingValues(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
  delayMs = 0
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let currentIndex = 0

  async function worker() {
    while (currentIndex < items.length) {
      const nextIndex = currentIndex
      currentIndex += 1
      results[nextIndex] = await mapper(items[nextIndex])
      // Space out requests so the whole fan-out stays under Quiver's rate limit.
      if (delayMs > 0 && currentIndex < items.length) await sleep(delayMs)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}
const inFlight = new Map<string, Promise<unknown>>()

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) return existing

  const promise = run().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function getRankingRow<M extends { id: string; name: string }>(
  member: M
): Promise<RankingRow<M>> {
  for (let waits = 0; ; waits++) {
    try {
      const response = await fetchQuiverWithRetry(
        `https://www.quiverquant.com/get_politician_page_tab_data/${member.id}`,
        { headers: QUIVER_HEADERS, next: { revalidate: 3600 } }
      )

      if (!response.ok) {
        console.warn(`[rankings] ${member.id} tab-data HTTP ${response.status}`)
        return { ...member, netWorth: null, stockHoldings: null }
      }

      const payload = (await response.json()) as QuiverTabResponse
      return {
        ...member,
        netWorth: getLiveNetWorth(payload),
        stockHoldings: getLiveStockHoldings(payload),
      }
    } catch (error) {
      if (error instanceof QuiverCircuitOpenError && waits < MAX_CIRCUIT_WAITS) {
        console.warn(
          `[rankings] circuit open — pausing ${CIRCUIT_OPEN_PAUSE_MS / 1000}s before retrying ${member.id}`
        )
        await sleep(CIRCUIT_OPEN_PAUSE_MS)
        continue
      }
      console.warn(
        `[rankings] ${member.id} fan-out failed:`,
        error instanceof Error ? error.message : error
      )
      return { ...member, netWorth: null, stockHoldings: null }
    }
  }
}

function buildPayload<M extends { name: string }>(
  rows: RankingRow<M>[]
): RankingsPayload<M> {
  const byStockHoldings = [...rows].sort((l, r) => {
    const v = compareRankingValues(l.stockHoldings, r.stockHoldings)
    return v !== 0 ? v : l.name.localeCompare(r.name)
  })

  const byNetWorth = [...rows].sort((l, r) => {
    const v = compareRankingValues(l.netWorth, r.netWorth)
    return v !== 0 ? v : l.name.localeCompare(r.name)
  })

  return { byNetWorth, byStockHoldings, generatedAt: new Date().toISOString() }
}

function countPopulated<M>(rows: RankingRow<M>[]): number {
  return rows.filter(
    (row) => row.netWorth !== null || row.stockHoldings !== null
  ).length
}

// Build a rankings payload from the Congress.gov member list alone, with null
// financials. Lets the public read path return names/parties/districts instantly
// on a cold cache without launching the ~435-request Quiver fan-out (which
// rate-limits and trips the shared circuit breaker). The cron job fills in the
// financial columns in the background.
function membersToEmptyPayload<M extends { id: string; name: string }>(
  members: M[]
): RankingsPayload<M> {
  return buildPayload(
    members.map((member) => ({ ...member, netWorth: null, stockHoldings: null }))
  )
}

// Carry forward the last known non-null value for any member that came back null
// this run, so a partial upstream failure degrades gracefully instead of wiping
// the column. A member Quiver permanently stops reporting keeps its last value —
// an acceptable staleness trade-off for net-worth/holdings data.
function mergeWithPrevious<M extends { id: string; name: string }>(
  fresh: RankingsPayload<M>,
  previous: RankingsPayload<M> | null
): RankingsPayload<M> {
  if (!previous) return fresh

  const previousById = new Map(previous.byNetWorth.map((row) => [row.id, row]))
  const mergedRows = fresh.byNetWorth.map((row) => {
    const prior = previousById.get(row.id)
    if (!prior) return row
    return {
      ...row,
      netWorth: row.netWorth ?? prior.netWorth,
      stockHoldings: row.stockHoldings ?? prior.stockHoldings,
    }
  })

  return buildPayload(mergedRows)
}

// Merge a fresh compute over the cached payload and cache the result. The merge
// is monotonic (a member's value only ever goes null -> value, never the reverse),
// so caching every run is safe and lets partial refreshes accumulate toward a full
// table across cron runs instead of demanding one perfect, un-rate-limited run.
async function persistRankings<M extends { id: string; name: string }>(
  key: string,
  fresh: RankingsPayload<M>
): Promise<RankingsPayload<M>> {
  const previous = await getCache<RankingsPayload<M>>(key)
  const merged = mergeWithPrevious(fresh, previous)

  await setCache(key, merged, RANKINGS_TTL_SECONDS)
  console.log(
    `[rankings] cached ${key}: ${countPopulated(merged.byNetWorth)}/${merged.byNetWorth.length} members populated`
  )

  // The one fan-out fills both Redis (the payload above) and Postgres
  // (portfolio_data) — so the DB never needs its own redundant fan-out. Only
  // persist members that actually have a value.
  const portfolioRows: DbPortfolio[] = merged.byNetWorth
    .filter((row) => row.netWorth !== null || row.stockHoldings !== null)
    .map((row) => ({
      bioguide_id: row.id,
      net_worth: row.netWorth,
      stock_holdings: row.stockHoldings,
    }))
  writeBack(() => upsertPortfolios(portfolioRows))

  return merged
}

// Build a populated rankings payload by joining the member list with the
// persisted portfolio_data table. Returns null when the DB holds no portfolios
// yet, so the caller can fall back to an empty payload.
async function rankingsFromDb<M extends { id: string; name: string }>(
  members: M[]
): Promise<RankingsPayload<M> | null> {
  const portfolios = await getPortfoliosFromDb()
  if (portfolios.length === 0) return null

  const byId = new Map(portfolios.map((p) => [p.bioguide_id, p]))
  const rows = members.map((member) => {
    const portfolio = byId.get(member.id)
    return {
      ...member,
      netWorth: portfolio?.net_worth ?? null,
      stockHoldings: portfolio?.stock_holdings ?? null,
    }
  })
  return buildPayload(rows)
}

function resolveCongressApiKey(): string {
  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY
  if (!apiKey) throw new Error("Missing CONGRESS_API_KEY")
  return apiKey
}

export async function computeHouseRankings(
  apiKey = resolveCongressApiKey()
): Promise<RankingsPayload<HouseMember>> {
  const members = await fetchHouseMembers(apiKey)
  const rows = await mapWithConcurrency(members, FANOUT_CONCURRENCY, getRankingRow, FANOUT_DELAY_MS)
  return buildPayload(rows)
}

export async function computeSenateRankings(
  apiKey = resolveCongressApiKey()
): Promise<RankingsPayload<SenateMember>> {
  const members = await fetchSenateMembers(apiKey)
  const rows = await mapWithConcurrency(members, FANOUT_CONCURRENCY, getRankingRow, FANOUT_DELAY_MS)
  return buildPayload(rows)
}

// Recompute + cache. Used by the cron job to pre-warm Redis and by the public
// route handlers on a cold cache miss. Single-flighted so concurrent callers
// share one fan-out instead of each launching their own (see singleFlight).
export async function refreshHouseRankings(
  apiKey = resolveCongressApiKey()
): Promise<RankingsPayload<HouseMember>> {
  return singleFlight(HOUSE_RANKINGS_KEY, async () =>
    persistRankings(HOUSE_RANKINGS_KEY, await computeHouseRankings(apiKey))
  )
}

export async function refreshSenateRankings(
  apiKey = resolveCongressApiKey()
): Promise<RankingsPayload<SenateMember>> {
  return singleFlight(SENATE_RANKINGS_KEY, async () =>
    persistRankings(SENATE_RANKINGS_KEY, await computeSenateRankings(apiKey))
  )
}

type TaggedMember =
  | { chamber: "house"; member: HouseMember }
  | { chamber: "senate"; member: SenateMember }

// Alternate House/Senate members so the shared Quiver rate budget is spread across
// both chambers instead of being spent entirely on House first.
function interleave(house: HouseMember[], senate: SenateMember[]): TaggedMember[] {
  const out: TaggedMember[] = []
  const max = Math.max(house.length, senate.length)
  for (let i = 0; i < max; i++) {
    if (i < house.length) out.push({ chamber: "house", member: house[i] })
    if (i < senate.length) out.push({ chamber: "senate", member: senate[i] })
  }
  return out
}

// Refresh both chambers in ONE interleaved fan-out so neither starves the shared
// Quiver rate budget. Running House (~435) then Senate (~100) sequentially left the
// Senate pass hitting 429s after House had spent the budget, so Senate came back
// all-null. Results are partitioned back per chamber and persisted to each key +
// portfolio_data. Used by the worker / cron in place of the two separate refreshers.
export async function refreshAllRankings(
  apiKey = resolveCongressApiKey()
): Promise<{ house: RankingsPayload<HouseMember>; senate: RankingsPayload<SenateMember> }> {
  return singleFlight("all-rankings", async () => {
    const [houseMembers, senateMembers] = await Promise.all([
      fetchHouseMembers(apiKey),
      fetchSenateMembers(apiKey),
    ])

    const results = await mapWithConcurrency(
      interleave(houseMembers, senateMembers),
      FANOUT_CONCURRENCY,
      async (tagged) => {
        if (tagged.chamber === "house") {
          return { chamber: "house" as const, row: await getRankingRow(tagged.member) }
        }
        return { chamber: "senate" as const, row: await getRankingRow(tagged.member) }
      },
      FANOUT_DELAY_MS
    )

    const houseRows = results
      .filter(
        (r): r is { chamber: "house"; row: RankingRow<HouseMember> } => r.chamber === "house"
      )
      .map((r) => r.row)
    const senateRows = results
      .filter(
        (r): r is { chamber: "senate"; row: RankingRow<SenateMember> } => r.chamber === "senate"
      )
      .map((r) => r.row)

    const [house, senate] = await Promise.all([
      persistRankings(HOUSE_RANKINGS_KEY, buildPayload(houseRows)),
      persistRankings(SENATE_RANKINGS_KEY, buildPayload(senateRows)),
    ])
    return { house, senate }
  })
}

// Cache-first read used by the public route handlers: serve Redis on a hit.
// On a cold cache, return the member list with null financials instead of
// running the Quiver fan-out inline — that fan-out (one request per ~435 House
// members) rate-limits, trips the shared circuit breaker, and cascades into
// "upstream failures" on the trades endpoints. The scheduled cron job
// (`/api/cron/refresh-rankings`) owns the fan-out and backfills the financials.
export async function getHouseRankings(): Promise<RankingsPayload<HouseMember>> {
  const cached = await getCache<RankingsPayload<HouseMember>>(HOUSE_RANKINGS_KEY)
  if (cached && countPopulated(cached.byNetWorth) > 0) return cached

  const members = await fetchHouseMembers(resolveCongressApiKey())

  // On a cold Redis cache, rebuild from persisted portfolio_data instead of an
  // empty payload — so the table shows financials without the request triggering
  // the fan-out. Re-warm Redis with the result.
  const fromDb = await rankingsFromDb(members)
  if (fromDb && countPopulated(fromDb.byNetWorth) > 0) {
    await setCache(HOUSE_RANKINGS_KEY, fromDb, RANKINGS_TTL_SECONDS)
    return fromDb
  }
  return membersToEmptyPayload(members)
}

export async function getSenateRankings(): Promise<RankingsPayload<SenateMember>> {
  const cached = await getCache<RankingsPayload<SenateMember>>(SENATE_RANKINGS_KEY)
  if (cached && countPopulated(cached.byNetWorth) > 0) return cached

  const members = await fetchSenateMembers(resolveCongressApiKey())

  const fromDb = await rankingsFromDb(members)
  if (fromDb && countPopulated(fromDb.byNetWorth) > 0) {
    await setCache(SENATE_RANKINGS_KEY, fromDb, RANKINGS_TTL_SECONDS)
    return fromDb
  }
  return membersToEmptyPayload(members)
}
