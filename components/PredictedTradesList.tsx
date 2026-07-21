"use client"

import { useEffect, useState } from "react"
import { formatPct, predictionLean } from "@/lib/predictions"
import type { Prediction, PredictionContext } from "@/types/prediction"
export default function PredictedTradesList({
  bioguideId,
  predictions,
}: {
  bioguideId: string
  predictions: Prediction[]
}) {
  const [selected, setSelected] = useState<Prediction | null>(null)

  return (
    <>
      <ul className="divide-y divide-slate-100">
        {predictions.map((p) => {
          const lean = predictionLean(p.pBuy)
          return (
            <li key={p.ticker}>
              <button
                type="button"
                onClick={() => setSelected(p)}
                className="-mx-2 flex w-full items-center justify-between rounded-lg px-2 py-2.5 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
              >
                <div className="flex items-center gap-3">
                  <span className="w-6 text-sm font-mono font-medium tabular-nums text-slate-500">
                    #{p.rank}
                  </span>
                  <span className="font-mono font-semibold text-slate-900">{p.ticker}</span>
                </div>
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${lean.classes}`}
                  >
                    {lean.label}
                    {p.pBuy !== null && (
                      <span className="font-mono font-normal tabular-nums opacity-70">
                        {formatPct(p.pBuy)}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-slate-500">Details ›</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {selected && (
        <PredictionDetailModal
          key={selected.ticker}
          bioguideId={bioguideId}
          prediction={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

function PredictionDetailModal({
  bioguideId,
  prediction,
  onClose,
}: {
  bioguideId: string
  prediction: Prediction
  onClose: () => void
}) {
  const [ctx, setCtx] = useState<PredictionContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    fetch(
      `/api/predictions/${encodeURIComponent(bioguideId)}/${encodeURIComponent(
        prediction.ticker
      )}`,
      { cache: "no-store" }
    )
      .then(async (res) => {
        const data = (await res.json()) as PredictionContext
        if (!res.ok) throw new Error(data.error ?? "Failed to load details")
        if (!ignore) setCtx(data)
      })
      .catch((e) => {
        if (!ignore)
          setError(e instanceof Error ? e.message : "Failed to load details")
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [bioguideId, prediction.ticker])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const lean = predictionLean(prediction.pBuy)
  const mh = ctx?.memberHistory
  const tc = ctx?.tickerContext

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-mono font-bold text-slate-900">
                {prediction.ticker}
              </h3>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${lean.classes}`}
              >
                {lean.label}
                {prediction.pBuy !== null && (
                  <span className="font-mono font-normal tabular-nums opacity-70">
                    {formatPct(prediction.pBuy)}
                  </span>
                )}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              Predicted rank #{prediction.rank} for this member
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 focus-ring"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {loading && (
          <p className="mt-6 text-sm text-slate-500">Loading details…</p>
        )}
        {error && <p className="mt-6 text-sm text-red-600">{error}</p>}

        {ctx && !loading && (
          <div className="mt-5 space-y-5 text-sm">
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                This member &amp; {prediction.ticker}
              </h4>
              {mh?.hasHistory ? (
                <ul className="mt-2 space-y-1">
                  <Stat
                    label="Disclosed trades"
                    value={`${mh.tradeCount} (${mh.buyCount} buys · ${mh.sellCount} sells)`}
                  />
                  <Stat label="Last traded" value={mh.lastTraded ?? "—"} />
                  <Stat
                    label="Current position"
                    value={mh.appearsHeld ? "Appears to hold" : "No net long position"}
                  />
                </ul>
              ) : (
                <p className="mt-2 text-slate-600">
                  No prior disclosed trades of {prediction.ticker} — this would be
                  a new position for the member.
                </p>
              )}
            </section>

            {tc && (
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {prediction.ticker} across Congress
                </h4>
                <ul className="mt-2 space-y-1">
                  {tc.sector && <Stat label="Sector" value={tc.sector} />}
                  {tc.memberCount != null && (
                    <Stat
                      label="Members trading it"
                      value={`${tc.memberCount} (${tc.houseCount ?? 0} House · ${
                        tc.senateCount ?? 0
                      } Senate)`}
                    />
                  )}
                  {tc.avgHoldingDays != null && (
                    <Stat
                      label="Avg holding period"
                      value={`${Math.round(tc.avgHoldingDays)} days`}
                    />
                  )}
                  {tc.estPlPct != null && (
                    <Stat
                      label="Est. historical P/L"
                      value={`${tc.estPlPct > 0 ? "+" : ""}${tc.estPlPct.toFixed(1)}%`}
                      accent={tc.estPlPct >= 0 ? "pos" : "neg"}
                    />
                  )}
                  {tc.excessReturnPct != null && (
                    <Stat
                      label="Excess vs S&P 500"
                      value={`${tc.excessReturnPct > 0 ? "+" : ""}${tc.excessReturnPct.toFixed(
                        1
                      )}%`}
                      accent={tc.excessReturnPct >= 0 ? "pos" : "neg"}
                    />
                  )}
                </ul>
                <p className="mt-2 text-xs text-slate-600">
                  Congress-wide historical estimates from disclosed trades — past
                  performance, not a forecast of this trade.
                </p>
              </section>
            )}
          </div>
        )}

        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-600">
          This is a predicted, not-yet-made trade from an experimental model.
          Figures are positional and historical context only — not financial
          advice.
        </p>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "pos" | "neg"
}) {
  const color =
    accent === "pos"
      ? "text-green-700"
      : accent === "neg"
      ? "text-red-700"
      : "text-slate-900"
  return (
    <li className="flex items-center justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono font-medium tabular-nums ${color}`}>{value}</span>
    </li>
  )
}
