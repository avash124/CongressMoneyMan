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
}

function getPartyClasses(party: LiveTrade["party"]) {

  if (party === "D")
    return "bg-blue-50 text-blue-700 ring-1 ring-blue-200"

  if (party === "R")
    return "bg-red-50 text-red-700 ring-1 ring-red-200"

  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200"
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

function formatDate(value: string) {
  const parsed = Date.parse(value.replace(" ", "T"))
  if (Number.isNaN(parsed)) return value
  return dateFormatter.format(parsed)
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  Stock: "Stock",
  ST: "Stock",
  OP: "Option",
  CS: "Common Stock",
}

function formatAssetType(value: string) {
  const key = value.trim()
  if (!key) return "—"
  return ASSET_TYPE_LABELS[key] ?? key
}

const REFRESH_INTERVAL_MS = 60_000

export default function LiveTrades() {

  const [trades,setTrades] = useState<LiveTrade[] | null>(null)
  const [error,setError] = useState<string | null>(null)

  useEffect(()=>{

    let active = true
    let loaded = false

    async function loadTrades(){

      try{

        const response = await fetch("/api/liveTrades",{cache:"no-store"})
        const payload = await response.json()

        if(!response.ok) throw new Error(payload.error)

        if(!active) return
        loaded = true
        setTrades(payload.trades)
        setError(null)

      }
      catch(err:any){
        if(active && !loaded) setError(err.message)
      }

    }

    loadTrades()
    const interval = setInterval(loadTrades, REFRESH_INTERVAL_MS)

    return ()=>{
      active = false
      clearInterval(interval)
    }

  },[])

  if(error){
    return(
      <div className="dashboard-card p-6 text-red-600">
        {error}
      </div>
    )
  }

  if(!trades){
    return(
      <div className="dashboard-card p-10 text-slate-500">
        Loading live trades...
      </div>
    )
  }

  return(

<section className="dashboard-card card-hover">

<div className="px-6 py-5 border-b border-slate-200">

<h2 className="text-xl font-semibold text-slate-900">
Recent Congressional Trades
</h2>

</div>

<div className="overflow-auto max-h-[36rem]">

<table className="min-w-full text-sm">

<thead className="sticky top-0 bg-slate-900 text-slate-200 text-xs uppercase">

<tr>

<th className="px-4 py-3">Filed</th>
<th className="px-4 py-3">Trade Date</th>
<th className="px-4 py-3">Member</th>
<th className="px-4 py-3">Party</th>
<th className="px-4 py-3">Ticker</th>
<th className="px-4 py-3">Type</th>
<th className="px-4 py-3">Transaction</th>
<th className="px-4 py-3 text-right">Amount</th>

</tr>

</thead>

<tbody>

{trades.map(trade=>(

<tr
key={trade.id}
className="border-b border-slate-200 hover:bg-slate-50"
>

<td className="px-4 py-3 font-mono tabular-nums text-slate-600">
{formatDate(trade.filedAt)}
</td>

<td className="px-4 py-3 font-mono tabular-nums text-slate-600">
{formatDate(trade.tradeDate)}
</td>

<td className="px-4 py-3">

<Link
href={
  trade.chamber?.toLowerCase().includes("senate")
    ? `/senator/${trade.bioguideId}`
    : `/member/${trade.bioguideId}`
}
className="rounded-sm font-semibold text-slate-900 hover:text-blue-600 focus-ring"
>

{trade.memberName}

</Link>

</td>

<td className="px-4 py-3">

<span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getPartyClasses(trade.party)}`}>
{trade.party}
</span>

</td>

<td className="px-4 py-3 font-mono font-semibold">
{trade.ticker === "-" || !trade.id ? (
  trade.ticker === "-" ? "—" : trade.ticker
) : (
  <Link
    href={`/trade/${encodeURIComponent(trade.id)}`}
    className="rounded-sm text-blue-600 hover:underline focus-ring"
  >
    {trade.ticker}
  </Link>
)}
</td>

<td className="px-4 py-3 text-slate-600">
{formatAssetType(trade.assetType)}
</td>

<td className="px-4 py-3 font-medium">
{trade.transactionType}
</td>

<td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">
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