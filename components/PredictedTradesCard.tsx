import PredictedTradesList from "@/components/PredictedTradesList"
import { fetchBackend } from "@/lib/backend"
import type { MemberPredictions } from "@/types/prediction"

const TOP_N = 6
const HORIZON_DAYS = 30

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default async function PredictedTradesCard({ id }: { id: string }) {
  const data = await fetchBackend<MemberPredictions>(
    `/api/predictions/${encodeURIComponent(id)}`
  )
  const predictions = (data?.predictions ?? []).slice(0, TOP_N)
  const asOf = data?.asOf ?? null
  const windowEnd = asOf ? addDays(asOf, HORIZON_DAYS) : null

  return (
    <div className="dashboard-card p-8 h-fit">
      <h2 className="font-display text-2xl leading-tight text-ink">
        Predicted Next Trades
      </h2>
      <div className="ledger-rule mt-4 mb-4" role="presentation" />
      <p className="mb-4 text-sm text-body">
        {asOf
          ? `Tickers this member is most likely to trade within ${HORIZON_DAYS} days of ${asOf}${
              windowEnd ? ` (through ${windowEnd})` : ""
            }, ranked by an experimental model. Click a ticker for details.`
          : `Tickers this member is most likely to trade within ${HORIZON_DAYS} days of each prediction date, ranked by an experimental model.`}
      </p>

      {predictions.length === 0 ? (
        <p className="text-sm text-muted">No prediction available yet.</p>
      ) : (
        <PredictedTradesList bioguideId={id} predictions={predictions} />
      )}

      <p className="mt-6 text-xs text-muted">
        Experimental model prediction from disclosed-trade patterns — not
        financial advice.
      </p>
    </div>
  )
}
