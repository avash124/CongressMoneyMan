import StockLeaderboard from "@/app/components/stockLeaderboard"

export default function StocksPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight">Stocks</h1>
          <p className="mt-2 text-slate-600">
            Most traded stocks owned by Congress based on total value and performance gain
          </p>
        </div>

        <StockLeaderboard />
      </div>
    </main>
  )
}
