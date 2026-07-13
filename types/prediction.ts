export type Prediction = {
  ticker: string
  rank: number
  score: number
  pBuy: number | null
}

export type MemberPredictions = {
  bioguideId: string
  asOf: string | null
  modelVersion: string | null
  predictions: Prediction[]
}

export type PredictionContext = {
  bioguideId: string
  ticker: string
  memberHistory: {
    hasHistory: boolean
    tradeCount: number
    buyCount: number
    sellCount: number
    lastTraded: string | null
    firstTraded: string | null
    appearsHeld: boolean
  } | null
  tickerContext: {
    sector: string | null
    assetType: string | null
    memberCount: number | null
    houseCount: number | null
    senateCount: number | null
    estPlPct: number | null
    excessReturnPct: number | null
    avgHoldingDays: number | null
  } | null
  error?: string
}
