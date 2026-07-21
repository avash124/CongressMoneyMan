import Link from "next/link"
import { Suspense } from "react"
import { fetchBackend } from "@/lib/backend"
import type { TradeDetail } from "@/types/trade"
import InsightCard from "@/components/InsightCard"
import StockTradeView from "@/components/StockTradeView"

export const revalidate = 900

export async function generateStaticParams() {
  return []
}

export default async function TradePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await fetchBackend<TradeDetail>(
    `/api/trade/${encodeURIComponent(decodeURIComponent(id))}`
  )

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <Link href="/Trades" className="rounded-sm text-sm text-blue-600 hover:underline focus-ring">
          ← Back to trades
        </Link>

        {detail ? (
          <>
            <StockTradeView detail={detail} />
            <Suspense
              fallback={
                <div className="h-48 w-full animate-pulse rounded-xl bg-slate-200" />
              }
            >
              <InsightCard
                path={`/api/insights/asset/${encodeURIComponent(detail.ticker)}`}
                title={`Congressional Trading in ${detail.ticker}`}
              />
            </Suspense>
          </>
        ) : (
          <p className="text-slate-600">Trade not found.</p>
        )}
      </div>
    </main>
  )
}
