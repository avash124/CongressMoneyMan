"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

type RankingRow = {
  id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  stockHoldings: number | null
  netWorth: number | null
}

type SenateRankingsResponse = {
  byNetWorth: RankingRow[]
  byStockHoldings: RankingRow[]
  error?: string
  generatedAt?: string
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatCurrency(value: number | null) {
  return value === null ? "-" : currencyFormatter.format(value)
}

function getPartyClasses(party: RankingRow["party"]) {
  if (party === "D") {
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
  }

  if (party === "R") {
    return "bg-red-50 text-red-700 ring-1 ring-red-200"
  }

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200"
}

function RankingTable({
  rows,
  title,
  description,
  valueKey,
}: {
  rows: RankingRow[]
  title: string
  description: string
  valueKey: "netWorth" | "stockHoldings"
}) {
  return (
    <section className="dashboard-card card-hover">
      <div className="border-b border-slate-200 px-6 py-5">
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </div>

      <div className="max-h-[30rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-[0.18em] text-slate-200">
            <tr>
              <th className="px-4 py-3 font-medium">Rank</th>
              <th className="px-4 py-3 font-medium">Member</th>
              <th className="px-4 py-3 font-medium">Party</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${valueKey}-${row.id}`}
                className="border-b border-slate-200 text-sm text-slate-700 odd:bg-slate-50/70"
              >
                <td className="px-4 py-3 font-medium text-slate-500">
                  {index + 1}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/senator/${row.id}`}
                    className="font-semibold text-gray-900 transition hover:text-slate-600"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getPartyClasses(row.party)}`}
                  >
                    {row.party}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-600">{row.state}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">
                  {formatCurrency(row[valueKey])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function SenateMembersRankingsNetWorth() {
  const [rankings, setRankings] = useState<SenateRankingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false

    async function loadRankings() {
      try {
        const response = await fetch("/api/senate-rankings", {
          cache: "no-store",
        })
        const payload = (await response.json()) as SenateRankingsResponse

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load Senate rankings")
        }

        if (!ignore) {
          setRankings(payload)
          setError(null)
        }
      } catch (loadError) {
        if (!ignore) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load Senate rankings"
          )
        }
      }
    }

    loadRankings()

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

  if (!rankings) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-sm text-slate-600 shadow-sm">
        Loading Senate rankings...
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <RankingTable
        rows={rankings.byStockHoldings}
        title="Senate Members By Stock Holdings"
        description="Estimated live stock portfolio values"
        valueKey="stockHoldings"
      />

      <RankingTable
        rows={rankings.byNetWorth}
        title="Senate Members By Net Worth"
        description="Estimated live net worths"
        valueKey="netWorth"
      />
    </div>
  )
}
