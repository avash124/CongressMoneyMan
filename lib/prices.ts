const ALPACA_BASE_URL = "https://data.alpaca.markets"
const FMP_BASE_URL = "https://financialmodelingprep.com/stable"
const MAX_RETRIES = 3
const RETRY_BASE_DELAYS_MS = [800, 2500, 6000]
const DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_REVALIDATE_SECONDS = 24 * 60 * 60
const LATEST_REVALIDATE_SECONDS = 15 * 60

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type PriceBar = {
  t: number 
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type DaySnapshot = {
  date: string 
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  bars: PriceBar[]
  timeframe: "intraday" | "daily"
}
async function fetchJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; revalidate: number; label: string }
): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...opts.headers },
        next: { revalidate: opts.revalidate },
      })

      if (res.ok) return (await res.json()) as T
      const transient = res.status === 429 || res.status >= 500
      if (!transient || attempt === MAX_RETRIES) {
        if (transient) console.warn(`[${opts.label}] ${res.status} after retries`)
        return null
      }

      const retryAfter = Number(res.headers.get("retry-after"))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RETRY_BASE_DELAYS_MS[attempt]
      await sleep(waitMs + Math.floor(Math.random() * 250))
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.error(`[${opts.label}] request failed:`, error)
        return null
      }
      await sleep(RETRY_BASE_DELAYS_MS[attempt])
    }
  }

  return null
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

type AlpacaBar = {
  t: string 
  o: number
  h: number
  l: number
  c: number
  v: number
}

type AlpacaBarsResponse = {
  bars?: AlpacaBar[]
}
async function alpacaBars(
  ticker: string,
  params: Record<string, string>,
  revalidate: number
): Promise<PriceBar[]> {
  const apiKey = process.env.ALPACA_KEY
  const apiSecret = process.env.ALPACA_SECRET
  if (!apiKey || !apiSecret) return []

  const query = new URLSearchParams(params)
  const data = await fetchJson<AlpacaBarsResponse>(
    `${ALPACA_BASE_URL}/v2/stocks/${encodeURIComponent(ticker)}/bars?${query}`,
    {
      headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret },
      revalidate,
      label: "alpaca",
    }
  )

  return (data?.bars ?? []).map((b) => ({
    t: Date.parse(b.t),
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }))
}

type FmpDailyBar = {
  date: string 
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function fmpUrl(path: string, params: Record<string, string>): string | null {
  const apiKey = process.env.FMP_API_KEY
  if (!apiKey) return null
  const query = new URLSearchParams({ ...params, apikey: apiKey })
  return `${FMP_BASE_URL}${path}?${query}`
}
async function fetchFmpDailyWindow(ticker: string, date: string): Promise<PriceBar[]> {
  const from = isoDate(Date.parse(date) - 45 * DAY_MS)
  const url = fmpUrl("/historical-price-eod/full", { symbol: ticker, from, to: date })
  if (!url) return []
  const rows = await fetchJson<FmpDailyBar[]>(url, {
    revalidate: HISTORY_REVALIDATE_SECONDS,
    label: "fmp",
  })
  if (!rows?.length) return []
  // FMP returns newest-first; charts want chronological order.
  return rows
    .filter((b) => b.date <= date)
    .map((b) => ({ t: Date.parse(b.date), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
    .sort((a, b) => a.t - b.t)
}

export async function getDaySnapshot(ticker: string, date: string): Promise<DaySnapshot> {
  const intraday = await alpacaBars(
    ticker,
    {
      timeframe: "5Min",
      start: `${date}T00:00:00Z`,
      end: `${date}T23:59:59Z`,
      adjustment: "all",
      feed: "iex",
      sort: "asc",
      limit: "10000",
    },
    HISTORY_REVALIDATE_SECONDS
  )

  if (intraday.length > 0) {
    return {
      date,
      open: intraday[0].o,
      close: intraday[intraday.length - 1].c,
      high: Math.max(...intraday.map((b) => b.h)),
      low: Math.min(...intraday.map((b) => b.l)),
      bars: intraday,
      timeframe: "intraday",
    }
  }

  const daily = await fetchFmpDailyWindow(ticker, date)
  if (daily.length > 0) {
    const last = daily[daily.length - 1] 
    return {
      date,
      open: last.o,
      close: last.c,
      high: last.h,
      low: last.l,
      bars: daily,
      timeframe: "daily",
    }
  }

  return { date, open: null, close: null, high: null, low: null, bars: [], timeframe: "daily" }
}

export async function getLatestSnapshot(ticker: string): Promise<DaySnapshot | null> {
  const now = Date.now()
  const bars = await alpacaBars(
    ticker,
    {
      timeframe: "1Day",
      start: isoDate(now - 40 * DAY_MS),
      end: isoDate(now),
      adjustment: "all",
      feed: "iex",
      limit: "60",
      sort: "asc",
    },
    LATEST_REVALIDATE_SECONDS
  )
  if (bars.length === 0) return null

  const last = bars[bars.length - 1]
  return {
    date: isoDate(last.t),
    open: last.o,
    close: last.c,
    high: last.h,
    low: last.l,
    bars,
    timeframe: "daily",
  }
}
