// Trade-detail response shapes served by the Python backend's /api/trade/{id}
// (formerly the return types of lib/trades.ts and lib/prices.ts).
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

export type TradeLeg = { date: string; range: string; transactionType: string }

export type ProfitLoss = {
  buyPrice: number
  exitPrice: number
  exitBasis: "sale" | "current"
  pctChange: number
  plLow: number
  plHigh: number
}

export type TradeDetail = {
  id: string
  ticker: string
  assetName: string
  memberName: string
  bioguideId: string
  chamber: string
  party: string
  buy: TradeLeg | null
  sell: TradeLeg | null
  buySnapshot: DaySnapshot | null
  sellSnapshot: DaySnapshot | null
  todaySnapshot: DaySnapshot | null
  profitLoss: ProfitLoss | null
}
