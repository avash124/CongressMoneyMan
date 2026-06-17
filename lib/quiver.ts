import { getCache, setCache, incrementCache } from "./cache"
import {
  getRecentTradesFromDb,
  getTradesByBioguide,
  upsertTrades,
  writeBack,
  type DbTrade,
} from "./db"

export type RawCongressTrade = {
  Bioguide?: string
  Ticker?: string
  Transaction?: string
  Range?: string
  ReportDate?: string
  Representative?: string
  Party?: string
  Chamber?: string
  UniqueID?: string | number
  AssetDescription?: string
  AssetType?: string
  Date?: string
  Traded?: string
  Trade_Size_USD?: number | string
}

const QUIVER_API_HEADERS = {
  Accept: "application/json",
  "User-Agent": "CongressMoneyMan/1.0",
}

const CIRCUIT_BREAKER_KEY = "quiver:circuit-breaker"
const CIRCUIT_BREAKER_WINDOW_SECONDS = 60
const CIRCUIT_BREAKER_THRESHOLD = 10
const MAX_RETRIES = 3
const RETRY_BASE_DELAYS_MS = [500, 1500, 4500]

export class QuiverCircuitOpenError extends Error {
  constructor() {
    super("Quiver circuit breaker is open — too many recent upstream failures")
    this.name = "QuiverCircuitOpenError"
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function recordQuiverFailure(): Promise<void> {
  const count = await incrementCache(
    CIRCUIT_BREAKER_KEY,
    CIRCUIT_BREAKER_WINDOW_SECONDS
  )
  if (count !== null && count > CIRCUIT_BREAKER_THRESHOLD) {
    console.error(
      `[quiver] circuit breaker tripped: ${count} failures in ${CIRCUIT_BREAKER_WINDOW_SECONDS}s`
    )
  }
}

async function isCircuitOpen(): Promise<boolean> {
  const count = await getCache<number>(CIRCUIT_BREAKER_KEY)
  return typeof count === "number" && count > CIRCUIT_BREAKER_THRESHOLD
}

export async function fetchQuiverWithRetry(
  url: string,
  init: RequestInit & { next?: { revalidate?: number } }
): Promise<Response> {
  if (await isCircuitOpen()) {
    throw new QuiverCircuitOpenError()
  }

  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init)

      if (response.ok) return response

      // Retry only on rate-limiting / transient server errors.
      if (response.status === 429 || response.status >= 500) {
        await recordQuiverFailure()
        lastError = new Error(`Quiver responded ${response.status}`)
        console.warn(
          `[quiver] ${response.status} on ${url} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        )
      } else {
        return response
      }
    } catch (error) {
      await recordQuiverFailure()
      lastError = error
      console.warn(
        `[quiver] network error on ${url} (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
        error
      )
    }

    if (attempt < MAX_RETRIES) {
      const base = RETRY_BASE_DELAYS_MS[attempt]
      const jitter = Math.floor(Math.random() * 250)
      await sleep(base + jitter)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Quiver request failed after retries")
}

const CONGRESS_TRADES_KEY = "congress-trades"
const CONGRESS_TRADES_TTL_SECONDS = 15 * 60

export function tradeToDbRow(trade: RawCongressTrade): DbTrade | null {
  const tradeId = trade.UniqueID != null ? String(trade.UniqueID) : null
  if (!tradeId || !trade.Bioguide) return null

  const rawSize = trade.Trade_Size_USD
  const size =
    typeof rawSize === "number"
      ? rawSize
      : rawSize != null && rawSize !== ""
      ? Number(rawSize)
      : null

  return {
    trade_id: tradeId,
    bioguide_id: trade.Bioguide,
    member_name: trade.Representative ?? null,
    party: trade.Party ?? null,
    chamber: trade.Chamber ?? null,
    ticker: trade.Ticker ?? null,
    asset_name: trade.AssetDescription ?? null,
    asset_type: trade.AssetType ?? null,
    transaction_type: trade.Transaction ?? null,
    transaction_date: trade.Date ?? null,
    traded: trade.Traded ?? null,
    range_text: trade.Range ?? null,
    trade_size_usd: size != null && Number.isFinite(size) ? size : null,
    filed_at: trade.ReportDate ?? null,
  }
}

function dbRowToTrade(row: DbTrade): RawCongressTrade {
  return {
    Bioguide: row.bioguide_id,
    Ticker: row.ticker ?? undefined,
    Transaction: row.transaction_type ?? undefined,
    Range: row.range_text ?? undefined,
    ReportDate: row.filed_at ?? undefined,
    Representative: row.member_name ?? undefined,
    Party: row.party ?? undefined,
    Chamber: row.chamber ?? undefined,
    UniqueID: row.trade_id,
    AssetDescription: row.asset_name ?? undefined,
    AssetType: row.asset_type ?? undefined,
    Date: row.transaction_date ?? undefined,
    Traded: row.traded ?? undefined,
    Trade_Size_USD: row.trade_size_usd ?? undefined,
  }
}

type RawQuiverApiTrade = {
  Representative?: string
  BioGuideID?: string
  ReportDate?: string
  TransactionDate?: string
  Ticker?: string
  Transaction?: string
  Range?: string
  House?: string
  Amount?: string | number
  Party?: string
  TickerType?: string
  Description?: string | null
}

function syntheticTradeId(raw: RawQuiverApiTrade): string {
  return [
    raw.BioGuideID ?? "",
    raw.TransactionDate ?? "",
    raw.Ticker ?? "",
    raw.Transaction ?? "",
    raw.Amount ?? "",
    raw.ReportDate ?? "",
  ].join("|")
}

function normalizeQuiverTrade(raw: RawQuiverApiTrade): RawCongressTrade {
  return {
    UniqueID: syntheticTradeId(raw),
    Bioguide: raw.BioGuideID,
    Representative: raw.Representative,
    Party: raw.Party,
    Chamber: raw.House,
    Ticker: raw.Ticker,
    AssetDescription: raw.Description ?? undefined,
    AssetType: raw.TickerType,
    Transaction: raw.Transaction,
    Date: raw.TransactionDate,
    Range: raw.Range,
    Trade_Size_USD: raw.Amount,
    ReportDate: raw.ReportDate,
  }
}

export async function fetchAllCongressTrades(
  apiKey: string,
  opts?: { forceRefresh?: boolean }
): Promise<RawCongressTrade[]> {
  const force = opts?.forceRefresh ?? false

  if (!force) {
    const cached = await getCache<RawCongressTrade[]>(CONGRESS_TRADES_KEY)
    if (cached) return cached
    const stored = await getRecentTradesFromDb()
    if (stored.length > 0) {
      const trades = stored.map(dbRowToTrade)
      await setCache(CONGRESS_TRADES_KEY, trades, CONGRESS_TRADES_TTL_SECONDS)
      return trades
    }
  }

  const response = await fetchQuiverWithRetry(
    "https://api.quiverquant.com/beta/live/congresstrading",
    {
      headers: {
        ...QUIVER_API_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      next: { revalidate: 900 },
    }
  )

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Quiver API error ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = await response.json()
  if (!Array.isArray(data)) throw new Error("Unexpected Quiver response format")

  const normalized = (data as RawQuiverApiTrade[]).map(normalizeQuiverTrade)
  const trades = [...new Map(normalized.map((t) => [t.UniqueID, t])).values()]

  await setCache(CONGRESS_TRADES_KEY, trades, CONGRESS_TRADES_TTL_SECONDS)

  if (!force) {
    const rows = trades
      .map(tradeToDbRow)
      .filter((row): row is DbTrade => row !== null)
    writeBack(() => upsertTrades(rows))
  }

  return trades
}

type RawQuiverBulkTrade = {
  Ticker?: string
  TickerType?: string
  Company?: string | null
  Traded?: string
  Transaction?: string
  Trade_Size_USD?: string | number
  Description?: string | null
  Name?: string
  BioGuideID?: string
  Filed?: string
  Party?: string
  Chamber?: string
}

function normalizeBulkTrade(raw: RawQuiverBulkTrade): RawCongressTrade {
  // Reuse the live-feed id logic so the same disclosure dedupes across feeds.
  const id = syntheticTradeId({
    BioGuideID: raw.BioGuideID,
    TransactionDate: raw.Traded,
    Ticker: raw.Ticker,
    Transaction: raw.Transaction,
    Amount: raw.Trade_Size_USD,
    ReportDate: raw.Filed,
  })
  return {
    UniqueID: id,
    Bioguide: raw.BioGuideID,
    Representative: raw.Name,
    Party: raw.Party,
    Chamber: raw.Chamber,
    Ticker: raw.Ticker,
    AssetDescription: raw.Description ?? raw.Company ?? undefined,
    AssetType: raw.TickerType,
    Transaction: raw.Transaction,
    Date: raw.Traded,
    Traded: raw.Traded,
    Range: undefined,
    Trade_Size_USD: raw.Trade_Size_USD,
    ReportDate: raw.Filed,
  }
}
const BULK_PAGE_SIZE = 1000
const BULK_MAX_PAGES = 200

async function fetchBulkPage(
  apiKey: string,
  page: number
): Promise<RawQuiverBulkTrade[] | null> {
  const url = `https://api.quiverquant.com/beta/bulk/congresstrading?page=${page}&page_size=${BULK_PAGE_SIZE}`
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { ...QUIVER_API_HEADERS, Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      const data = await res.json()
      return Array.isArray(data) ? (data as RawQuiverBulkTrade[]) : null
    }
    const transient = res.status === 429 || res.status >= 500
    if (transient && attempt < MAX_RETRIES) {
      console.warn(`[quiver] bulk page ${page} -> ${res.status}, retry ${attempt + 1}`)
      await sleep(RETRY_BASE_DELAYS_MS[attempt] + Math.floor(Math.random() * 250))
      continue
    }
    return null
  }
  return null
}

export async function fetchBulkCongressTrades(
  apiKey: string
): Promise<RawCongressTrade[]> {
  const all: RawCongressTrade[] = []
  for (let page = 1; page <= BULK_MAX_PAGES; page++) {
    const data = await fetchBulkPage(apiKey, page)
    if (!data || data.length === 0) break
    for (const raw of data) all.push(normalizeBulkTrade(raw))
    if (data.length < BULK_PAGE_SIZE) break
  }
  return [...new Map(all.map((t) => [t.UniqueID, t])).values()]
}

export async function fetchMemberCongressTrades(
  bioguideId: string,
  apiKey: string
): Promise<RawCongressTrade[]> {
  const rows = await getTradesByBioguide(bioguideId)
  if (rows.length > 0) return rows.map(dbRowToTrade)
  const all = await fetchAllCongressTrades(apiKey)
  return all.filter((t) => t.Bioguide === bioguideId)
}

export function classifyTransaction(value?: string): "buy" | "sell" | "other" {
  const v = value?.toLowerCase() ?? ""
  if (v.includes("purchase") || v.includes("buy")) return "buy"
  if (v.includes("sale") || v.includes("sell") || v.includes("sold")) return "sell"
  return "other"
}

function tradeTime(trade: RawCongressTrade): number {
  return Date.parse(trade.Date ?? "")
}
export function findMatchingSale(
  all: RawCongressTrade[],
  purchase: RawCongressTrade
): RawCongressTrade | null {
  const boughtAt = tradeTime(purchase)
  if (!Number.isFinite(boughtAt)) return null

  return (
    all
      .filter(
        (t) =>
          t.Bioguide === purchase.Bioguide &&
          t.Ticker === purchase.Ticker &&
          classifyTransaction(t.Transaction) === "sell" &&
          Number.isFinite(tradeTime(t)) &&
          tradeTime(t) >= boughtAt
      )
      .sort((a, b) => tradeTime(a) - tradeTime(b))[0] ?? null
  )
}

export function findMatchingPurchase(
  all: RawCongressTrade[],
  sale: RawCongressTrade
): RawCongressTrade | null {
  const soldAt = tradeTime(sale)
  if (!Number.isFinite(soldAt)) return null

  return (
    all
      .filter(
        (t) =>
          t.Bioguide === sale.Bioguide &&
          t.Ticker === sale.Ticker &&
          classifyTransaction(t.Transaction) === "buy" &&
          Number.isFinite(tradeTime(t)) &&
          tradeTime(t) <= soldAt
      )
      .sort((a, b) => tradeTime(b) - tradeTime(a))[0] ?? null
  )
}

export function parseTradeRange(range?: string): { low: number; high: number } | null {
  if (!range) return null
  const nums = range.replace(/,/g, "").match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length === 0) return null
  const low = Number(nums[0])
  const high = nums.length > 1 ? Number(nums[1]) : low
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  return { low, high }
}

export function formatTradeRange(lowerBound: number): string {
  const ranges: [number, number][] = [
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
  ]

  for (const [min, max] of ranges) {
    if (lowerBound === min) return `$${min.toLocaleString()} – $${max.toLocaleString()}`
  }

  if (lowerBound >= 50000001) return `$${lowerBound.toLocaleString()}+`
  return `$${lowerBound.toLocaleString()}`
}
