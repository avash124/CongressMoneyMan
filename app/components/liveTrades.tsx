"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

type LiveTrade = {
  amount: string
  assetName: string
  assetType: string
  bioguideId: string
  chamber: string
  filedAt: string
  id: string
  memberName: string
  party: "D" | "R" | "I"
  ticker: string
  tradeDate: string
  transactionType: string
}

type LiveTradesResponse = {
  trades: LiveTrade[]
  error?: string
  generatedAt?: string
}

function getPartyClasses(party: LiveTrade["party"]) {
  if (party === "D") {
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
  }

  if (party === "R") {
    return "bg-red-50 text-red-700 ring-1 ring-red-200"
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200"
}

function formatDate(value: string) {
  const parsed = Date.parse(value.replace(" ", "T"))
  if (Number.isNaN(parsed)) {
    return value
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed)
}

function formatTicker(ticker: string) {
  return ticker === "-" ? "—" : ticker
}

export default function LiveTrades() {
  const [trades, setTrades] = useState<LiveTrade[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false

    async function loadTrades() {
      try {
        const response = await fetch("/api/liveTrades", {
          cache: "no-store",
        })
        const payload = (await response.json()) as LiveTradesResponse

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load live trades")
        }

        if (!ignore) {
          setTrades(payload.trades)
          setError(null)
        }
      } catch (loadError) {
        if (!ignore) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load live trades"
          )
        }
      }
    }

    loadTrades()

    return () => {
      ignore = true
    }
  }, [])

  if (error) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-700">
        {error}
      </div>
    )
  }

  if (!trades) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-sm text-slate-600 shadow-sm">
        Loading live trades...
      </div>
    )
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-6 py-5">
        <h2 className="text-xl font-semibold text-slate-950">
          Most Recent Congressional Trades
        </h2>
      </div>

      <div className="max-h-[36rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-[0.18em] text-slate-200">
            <tr>
              <th className="px-4 py-3 font-medium">Filed</th>
              <th className="px-4 py-3 font-medium">Trade Date</th>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Chamber</th>
              <th className="px-4 py-3 font-medium">Party</th>
              <th className="px-4 py-3 font-medium">Ticker</th>
              <th className="px-4 py-3 font-medium">Asset</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Transaction</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr
                key={trade.id}
                className="border-b border-slate-200 text-sm text-slate-700 odd:bg-slate-50/70"
              >
                <td className="px-4 py-3 text-slate-600">
                  {formatDate(trade.filedAt)}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {formatDate(trade.tradeDate)}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/member/${trade.bioguideId}`}
                    className="font-semibold text-slate-950 transition hover:text-slate-600"
                  >
                    {trade.memberName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">{trade.chamber}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getPartyClasses(trade.party)}`}
                  >
                    {trade.party}
                  </span>
                </td>
                <td className="px-4 py-3 font-semibold text-slate-950">
                  {formatTicker(trade.ticker)}
                </td>
                <td className="px-4 py-3 text-slate-600">{trade.assetName}</td>
                <td className="px-4 py-3 text-slate-600">{trade.assetType}</td>
                <td className="px-4 py-3 font-medium text-slate-950">
                  {trade.transactionType}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-slate-950">
                  {trade.amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
