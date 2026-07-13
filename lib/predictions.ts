export type Lean = { label: string; classes: string }

export function predictionLean(pBuy: number | null): Lean {
  if (pBuy === null) {
    return { label: "—", classes: "bg-slate-100 text-slate-600 ring-1 ring-slate-200" }
  }
  if (pBuy >= 0.55) {
    return { label: "Buy lean", classes: "bg-green-50 text-green-700 ring-1 ring-green-200" }
  }
  if (pBuy <= 0.45) {
    return { label: "Sell lean", classes: "bg-red-50 text-red-700 ring-1 ring-red-200" }
  }
  return { label: "Mixed", classes: "bg-slate-100 text-slate-700 ring-1 ring-slate-200" }
}

export function formatPct(p: number | null): string {
  return p === null ? "" : `${Math.round(p * 100)}%`
}
