import LiveTrades from "@/app/components/liveTrades"

export default function TradesPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight">
            Live Trades
          </h1>
        </div>

        <LiveTrades />
      </div>
    </main>
  )
}
