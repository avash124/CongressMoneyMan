import Link from "next/link"
import { loadTradeDetail } from "@/lib/trades"
import StockTradeView from "@/components/StockTradeView"

// Price snapshots are immutable history; cache the rendered page and refresh in
// the background every 15 min like the member/senator routes. Empty
// generateStaticParams opts this dynamic [id] route into ISR so repeat visits
// serve from cache instead of re-hitting Massive + Quiver each request.
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
  const detail = await loadTradeDetail(decodeURIComponent(id))

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <Link href="/Trades" className="text-sm text-blue-600 hover:underline">
          ← Back to trades
        </Link>

        {detail ? (
          <StockTradeView detail={detail} />
        ) : (
          <p className="text-gray-600">Trade not found.</p>
        )}
      </div>
    </main>
  )
}
