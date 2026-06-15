const MASSIVE_BASE_URL = "https://api.massive.com"
const REVALIDATE_SECONDS = 60 * 60
const MAX_RETRIES = 3
const RETRY_BASE_DELAYS_MS = [800, 2500, 6000]
const DAY_MS = 24 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type PriceBar = {
  t: number // epoch ms
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type DaySnapshot = {
  date: string // YYYY-MM-DD
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  bars: PriceBar[]
  timeframe: "intraday" | "daily"
}

type AggregatesResponse = {
  results?: PriceBar[]
  status?: string
}

async function massiveGet<T>(path: string): Promise<T | null> {
  const apiKey = process.env.MASSIVE_FINANCE_STOCKS_API_KEY
  if (!apiKey) return null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${MASSIVE_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        next: { revalidate: REVALIDATE_SECONDS },
      })

      if (res.ok) return (await res.json()) as T
      const transient = res.status === 429 || res.status >= 500
      if (!transient || attempt === MAX_RETRIES) {
        if (transient) console.warn(`[massive] ${res.status} after retries: ${path}`)
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
        console.error(`[massive] ${path} failed:`, error)
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

async function fetchIntradayBars(ticker: string, date: string): Promise<PriceBar[]> {
  const data = await massiveGet<AggregatesResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/5/minute/${date}/${date}?adjusted=true&sort=asc&limit=500`
  )
  return data?.results ?? []
}

async function fetchDailyBars(
  ticker: string,
  from: string,
  to: string,
  limit: number
): Promise<PriceBar[]> {
  const data = await massiveGet<AggregatesResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=${limit}`
  )
  return data?.results ?? []
}
async function fetchNearestClose(ticker: string, date: string): Promise<number | null> {
  const from = isoDate(Date.parse(date) - 10 * DAY_MS)
  const bars = await fetchDailyBars(ticker, from, date, 20)
  return bars.length > 0 ? bars[bars.length - 1].c : null
}
export async function getDaySnapshot(ticker: string, date: string): Promise<DaySnapshot> {
  const bars = await fetchIntradayBars(ticker, date)

  if (bars.length > 0) {
    return {
      date,
      open: bars[0].o,
      close: bars[bars.length - 1].c,
      high: Math.max(...bars.map((b) => b.h)),
      low: Math.min(...bars.map((b) => b.l)),
      bars,
      timeframe: "intraday",
    }
  }

  return {
    date,
    open: null,
    close: await fetchNearestClose(ticker, date),
    high: null,
    low: null,
    bars: [],
    timeframe: "intraday",
  }
}
function aggregateBars(date: string, bars: PriceBar[]): PriceBar | null {
  if (bars.length === 0) return null
  return {
    t: Date.parse(date),
    o: bars[0].o,
    h: Math.max(...bars.map((b) => b.h)),
    l: Math.min(...bars.map((b) => b.l)),
    c: bars[bars.length - 1].c,
    v: bars.reduce((sum, b) => sum + (b.v ?? 0), 0),
  }
}

// The daily-aggregate feed lags the latest session by up to a day: a session's
// daily bar only publishes a few hours after its close, so right after the
// market closes the newest daily bar is still the *prior* day. Intraday data for
// the just-closed session is available immediately, so scan back from today for
// the newest session that postdates the last daily bar and return it as a
// daily-style bar. Returns null when the daily series is already current (the
// common case — usually zero extra requests).
async function findSessionAfterLastDaily(
  ticker: string,
  afterDate: string,
  now: number
): Promise<PriceBar | null> {
  for (let back = 0; back < 5; back++) {
    const date = isoDate(now - back * DAY_MS)
    if (afterDate && date <= afterDate) break // daily already covers this day
    const agg = aggregateBars(date, await fetchIntradayBars(ticker, date))
    if (agg) return agg
  }
  return null
}

export async function getLatestSnapshot(ticker: string): Promise<DaySnapshot | null> {
  const now = Date.now()
  const daily = await fetchDailyBars(ticker, isoDate(now - 40 * DAY_MS), isoDate(now), 60)

  const lastDailyDate = daily.length > 0 ? isoDate(daily[daily.length - 1].t) : ""
  const fresh = await findSessionAfterLastDaily(ticker, lastDailyDate, now)
  const bars = fresh ? [...daily, fresh] : daily
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
