import {
  classifyTransaction,
  fetchAllCongressTrades,
  fetchMemberCongressTrades,
  findMatchingPurchase,
  findMatchingSale,
  parseTradeRange,
  type RawCongressTrade,
} from "./quiver"
import { getDaySnapshot, getLatestSnapshot, type DaySnapshot } from "./prices"

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

function toLeg(trade: RawCongressTrade): TradeLeg {
  return {
    date: trade.Date ?? "",
    range: trade.Range ?? "",
    transactionType: trade.Transaction ?? "",
  }
}

function computeProfitLoss(
  buyPrice: number | null,
  sellSnapshot: DaySnapshot | null,
  todaySnapshot: DaySnapshot | null,
  range: { low: number; high: number } | null
): ProfitLoss | null {
  if (buyPrice == null || buyPrice <= 0 || !range) return null

  let exitPrice: number | null = null
  let exitBasis: ProfitLoss["exitBasis"] = "current"
  if (sellSnapshot?.close != null) {
    exitPrice = sellSnapshot.close
    exitBasis = "sale"
  } else if (todaySnapshot?.close != null) {
    exitPrice = todaySnapshot.close
    exitBasis = "current"
  }
  if (exitPrice == null) return null

  const pctChange = ((exitPrice - buyPrice) / buyPrice) * 100
  return {
    buyPrice,
    exitPrice,
    exitBasis,
    pctChange,
    plLow: range.low * (pctChange / 100),
    plHigh: range.high * (pctChange / 100),
  }
}

export async function loadTradeDetail(id: string): Promise<TradeDetail | null> {
  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) return null
  const bioguide = id.split("|")[0] ?? ""
  let all: RawCongressTrade[]
  try {
    all = bioguide ? await fetchMemberCongressTrades(bioguide, apiKey) : []
    if (!all.some((t) => String(t.UniqueID) === id)) {
      all = await fetchAllCongressTrades(apiKey)
    }
  } catch {
    return null
  }

  const clicked = all.find((t) => String(t.UniqueID) === id)
  if (!clicked) return null
  const kind = classifyTransaction(clicked.Transaction)
  const buyTrade = kind === "sell" ? findMatchingPurchase(all, clicked) : clicked
  const sellTrade = kind === "sell" ? clicked : findMatchingSale(all, clicked)

  const ticker = clicked.Ticker ?? ""
  const hasTicker = Boolean(ticker) && ticker !== "-"

  const [buySnapshot, sellSnapshot, todaySnapshot] = await Promise.all([
    buyTrade?.Date && hasTicker
      ? getDaySnapshot(ticker, buyTrade.Date)
      : Promise.resolve(null),
    sellTrade?.Date && hasTicker
      ? getDaySnapshot(ticker, sellTrade.Date)
      : Promise.resolve(null),
    hasTicker ? getLatestSnapshot(ticker) : Promise.resolve(null),
  ])

  const profitLoss = computeProfitLoss(
    buySnapshot?.close ?? null,
    sellSnapshot,
    todaySnapshot,
    parseTradeRange(buyTrade?.Range)
  )

  return {
    id,
    ticker,
    assetName: clicked.AssetDescription ?? "",
    memberName: clicked.Representative ?? "",
    bioguideId: clicked.Bioguide ?? "",
    chamber: clicked.Chamber ?? "",
    party: clicked.Party ?? "",
    buy: buyTrade ? toLeg(buyTrade) : null,
    sell: sellTrade ? toLeg(sellTrade) : null,
    buySnapshot,
    sellSnapshot,
    todaySnapshot,
    profitLoss,
  }
}
