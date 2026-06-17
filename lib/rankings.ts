import { fetchHouseMembers, fetchSenateMembers, type HouseMember, type SenateMember } from "./congress"
import { fetchQuiverWithRetry, QuiverCircuitOpenError } from "./quiver"
import { getCache, setCache } from "./cache"
import { getPortfoliosFromDb, upsertPortfolios, writeBack, type DbPortfolio } from "./db"
import { persistHoldings, type HoldingPosition, type MemberHoldings } from "./stockLeaderboard"

export const HOUSE_RANKINGS_KEY = "house-rankings"
export const SENATE_RANKINGS_KEY = "senate-rankings"
export const RANKINGS_TTL_SECONDS = 2 * 60 * 60
const FANOUT_CONCURRENCY = 1
const FANOUT_DELAY_MS = 1500
const CIRCUIT_OPEN_PAUSE_MS = 65_000
const MAX_CIRCUIT_WAITS = 3

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type RankingRow<M> = M & {
  netWorth: number | null
  stockHoldings: number | null
}
type FanoutRow<M> = RankingRow<M> & { positions: HoldingPosition[]; ok: boolean }

function stripFanoutExtras<M>(row: FanoutRow<M>): RankingRow<M> {
  const { positions, ok, ...rest } = row
  void positions
  void ok
  return rest as RankingRow<M>
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

function getLivePositions(payload: QuiverTabResponse): HoldingPosition[] {
  const positions = parseJsonArray(payload.live_stock_portfolio?.live_stock_portfolio)
  const out: HoldingPosition[] = []
  for (const position of positions) {
    if (!Array.isArray(position)) continue
    const value = position[1]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    const symbol = typeof position[0] === "string" ? position[0].trim().toUpperCase() : ""
    if (!symbol) continue
    out.push({ ticker: symbol, value })
  }
  return out
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
): Promise<FanoutRow<M>> {
  for (let waits = 0; ; waits++) {
    try {
      const response = await fetchQuiverWithRetry(
        `https://www.quiverquant.com/get_politician_page_tab_data/${member.id}`,
        { headers: QUIVER_HEADERS, next: { revalidate: 3600 } }
      )

      if (!response.ok) {
        console.warn(`[rankings] ${member.id} tab-data HTTP ${response.status}`)
        return { ...member, netWorth: null, stockHoldings: null, positions: [], ok: false }
      }

      const payload = (await response.json()) as QuiverTabResponse
      return {
        ...member,
        netWorth: getLiveNetWorth(payload),
        stockHoldings: getLiveStockHoldings(payload),
        positions: getLivePositions(payload),
        ok: true,
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
      return { ...member, netWorth: null, stockHoldings: null, positions: [], ok: false }
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
function membersToEmptyPayload<M extends { id: string; name: string }>(
  members: M[]
): RankingsPayload<M> {
  return buildPayload(
    members.map((member) => ({ ...member, netWorth: null, stockHoldings: null }))
  )
}

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
  return buildPayload(rows.map(stripFanoutExtras))
}

export async function computeSenateRankings(
  apiKey = resolveCongressApiKey()
): Promise<RankingsPayload<SenateMember>> {
  const members = await fetchSenateMembers(apiKey)
  const rows = await mapWithConcurrency(members, FANOUT_CONCURRENCY, getRankingRow, FANOUT_DELAY_MS)
  return buildPayload(rows.map(stripFanoutExtras))
}
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

function interleave(house: HouseMember[], senate: SenateMember[]): TaggedMember[] {
  const out: TaggedMember[] = []
  const max = Math.max(house.length, senate.length)
  for (let i = 0; i < max; i++) {
    if (i < house.length) out.push({ chamber: "house", member: house[i] })
    if (i < senate.length) out.push({ chamber: "senate", member: senate[i] })
  }
  return out
}
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
        (r): r is { chamber: "house"; row: FanoutRow<HouseMember> } => r.chamber === "house"
      )
      .map((r) => r.row)
    const senateRows = results
      .filter(
        (r): r is { chamber: "senate"; row: FanoutRow<SenateMember> } => r.chamber === "senate"
      )
      .map((r) => r.row)
    const memberHoldings: MemberHoldings[] = [
      ...houseRows.map((row) => ({ row, chamber: "house" as const })),
      ...senateRows.map((row) => ({ row, chamber: "senate" as const })),
    ]
      .filter(({ row }) => row.ok)
      .map(({ row, chamber }) => ({
        bioguideId: row.id,
        memberName: row.name,
        party: row.party,
        chamber,
        positions: row.positions,
      }))
    writeBack(() => persistHoldings(memberHoldings))

    const [house, senate] = await Promise.all([
      persistRankings(HOUSE_RANKINGS_KEY, buildPayload(houseRows.map(stripFanoutExtras))),
      persistRankings(SENATE_RANKINGS_KEY, buildPayload(senateRows.map(stripFanoutExtras))),
    ])
    return { house, senate }
  })
}

export async function getHouseRankings(): Promise<RankingsPayload<HouseMember>> {
  const cached = await getCache<RankingsPayload<HouseMember>>(HOUSE_RANKINGS_KEY)
  if (cached && countPopulated(cached.byNetWorth) > 0) return cached
  const members = await fetchHouseMembers(resolveCongressApiKey())
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
