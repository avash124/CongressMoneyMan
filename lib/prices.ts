const ALPACA_BASE_URL = "https://data.alpaca.markets"
const FMP_BASE_URL = "https://financialmodelingprep.com/stable"
const MAX_RETRIES = 3
const RETRY_BASE_DELAYS_MS = [800, 2500, 6000]
const DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_REVALIDATE_SECONDS = 24 * 60 * 60
const LATEST_REVALIDATE_SECONDS = 15 * 60
const FMP_COOLDOWN_MS = 2 * 60 * 1000
let fmpCooldownUntil = 0
const fmpRateLimited = () => Date.now() < fmpCooldownUntil
const noteFmpRateLimit = () => {
  fmpCooldownUntil = Date.now() + FMP_COOLDOWN_MS
}

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
  opts: {
    headers?: Record<string, string>
    revalidate: number
    label: string
    onRateLimit?: () => void
  }
): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", ...opts.headers },
        next: { revalidate: opts.revalidate },
      })

      if (res.ok) return (await res.json()) as T

      if (res.status === 429) {
        opts.onRateLimit?.()
        console.warn(`[${opts.label}] 429 rate limited`)
        return null
      }

      const transient = res.status >= 500
      if (!transient || attempt === MAX_RETRIES) {
        if (transient) console.warn(`[${opts.label}] ${res.status} after retries`)
        return null
      }

      await sleep(RETRY_BASE_DELAYS_MS[attempt] + Math.floor(Math.random() * 250))
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
  if (!apiKey || fmpRateLimited()) return null
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
    onRateLimit: noteFmpRateLimit,
  })
  if (!rows?.length) return []
  return rows
    .filter((b) => b.date <= date)
    .map((b) => ({ t: Date.parse(b.date), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
    .sort((a, b) => a.t - b.t)
}

export async function getDailyCloses(
  ticker: string,
  fromDate: string
): Promise<{ date: string; close: number }[]> {
  const url = fmpUrl("/historical-price-eod/full", {
    symbol: ticker,
    from: fromDate,
    to: isoDate(Date.now()),
  })
  if (url) {
    const rows = await fetchJson<FmpDailyBar[]>(url, {
      revalidate: HISTORY_REVALIDATE_SECONDS,
      label: "fmp",
      onRateLimit: noteFmpRateLimit,
    })
    if (rows?.length) {
      return rows
        .map((b) => ({ date: b.date, close: b.close }))
        .filter((b) => Number.isFinite(b.close))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    }
  }

  // FMP missing or rate-limited — fall back to Alpaca's daily bars, which draw
  // on a separate quota, so a maxed-out FMP key can't blank the leaderboard.
  const bars = await alpacaBars(
    ticker,
    {
      timeframe: "1Day",
      start: fromDate,
      end: isoDate(Date.now()),
      adjustment: "all",
      feed: "iex",
      sort: "asc",
      limit: "10000",
    },
    HISTORY_REVALIDATE_SECONDS
  )
  return bars
    .map((b) => ({ date: isoDate(b.t), close: b.c }))
    .filter((b) => Number.isFinite(b.close))
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

type FmpProfile = {
  symbol: string
  companyName?: string
  sector?: string
  industry?: string
}

export type CompanyProfile = { name: string; sector: string; industry: string }
export async function getCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const url = fmpUrl("/profile", { symbol: ticker })
  if (!url) return null
  const rows = await fetchJson<FmpProfile[]>(url, {
    revalidate: HISTORY_REVALIDATE_SECONDS,
    label: "fmp-profile",
    onRateLimit: noteFmpRateLimit,
  })
  const p = rows?.[0]
  if (!p) return null
  return {
    name: p.companyName?.trim() || ticker,
    sector: p.sector?.trim() || "",
    industry: p.industry?.trim() || "",
  }
}

export type ChartRange = "24H" | "1W" | "1M" | "6M" | "1Y" | "5Y"
export type ChartPoint = { t: number; c: number }

function dailyFromMs(range: ChartRange, now: number): number {
  switch (range) {
    case "24H":
      return now - 5 * DAY_MS
    case "1W":
      return now - 8 * DAY_MS
    case "1M":
      return now - 31 * DAY_MS
    case "6M":
      return now - 183 * DAY_MS
    case "1Y":
      return now - 366 * DAY_MS
    case "5Y":
      return now - 5 * 366 * DAY_MS
  }
}
export async function getPriceHistory(
  ticker: string,
  range: ChartRange
): Promise<ChartPoint[]> {
  const now = Date.now()

  if (range === "24H") {
    const bars = await alpacaBars(
      ticker,
      {
        timeframe: "5Min",
        start: `${isoDate(now - 5 * DAY_MS)}T00:00:00Z`,
        end: new Date(now).toISOString(),
        adjustment: "all",
        feed: "iex",
        sort: "asc",
        limit: "10000",
      },
      LATEST_REVALIDATE_SECONDS
    )
    if (bars.length > 0) {
      const lastDay = isoDate(bars[bars.length - 1].t)
      return bars.filter((b) => isoDate(b.t) === lastDay).map((b) => ({ t: b.t, c: b.c }))
    }
  } else if (range === "1W") {
    const bars = await alpacaBars(
      ticker,
      {
        timeframe: "1Hour",
        start: `${isoDate(now - 8 * DAY_MS)}T00:00:00Z`,
        end: new Date(now).toISOString(),
        adjustment: "all",
        feed: "iex",
        sort: "asc",
        limit: "10000",
      },
      LATEST_REVALIDATE_SECONDS
    )
    if (bars.length > 0) return bars.map((b) => ({ t: b.t, c: b.c }))
  }

  const closes = await getDailyCloses(ticker, isoDate(dailyFromMs(range, now)))
  return closes.map((b) => ({ t: Date.parse(b.date), c: b.close }))
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
