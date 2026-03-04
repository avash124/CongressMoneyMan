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

  return "bg-gray-100 text-gray-700 ring-1 ring-gray-200"
}

function formatDate(value: string) {

  const parsed = Date.parse(value.replace(" ", "T"))

  if (Number.isNaN(parsed)) return value

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(parsed)
}

export default function LiveTrades() {

  const [trades,setTrades] = useState<LiveTrade[] | null>(null)
  const [error,setError] = useState<string | null>(null)

  useEffect(()=>{

    async function loadTrades(){

      try{

        const response = await fetch("/api/liveTrades",{cache:"no-store"})
        const payload = await response.json()

        if(!response.ok) throw new Error(payload.error)

        setTrades(payload.trades)

      }
      catch(err:any){
        setError(err.message)
      }

    }

    loadTrades()

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
      <div className="dashboard-card p-10 text-gray-500">
        Loading live trades...
      </div>
    )
  }

  return(

<section className="dashboard-card card-hover">

<div className="px-6 py-5 border-b border-gray-200">

<h2 className="text-xl font-semibold text-gray-900">
Recent Congressional Trades
</h2>

</div>

<div className="overflow-auto max-h-[36rem]">

<table className="min-w-full text-sm">

<thead className="sticky top-0 bg-gray-900 text-gray-200 text-xs uppercase">

<tr>

<th className="px-4 py-3">Filed</th>
<th className="px-4 py-3">Trade Date</th>
<th className="px-4 py-3">Member</th>
<th className="px-4 py-3">Party</th>
<th className="px-4 py-3">Ticker</th>
<th className="px-4 py-3">Asset</th>
<th className="px-4 py-3">Transaction</th>
<th className="px-4 py-3 text-right">Amount</th>

</tr>

</thead>

<tbody>

{trades.map(trade=>(

<tr
key={trade.id}
className="border-b border-gray-200 hover:bg-gray-50"
>

<td className="px-4 py-3 text-gray-600">
{formatDate(trade.filedAt)}
</td>

<td className="px-4 py-3 text-gray-600">
{formatDate(trade.tradeDate)}
</td>

<td className="px-4 py-3">

<Link
href={`/member/${trade.bioguideId}`}
className="font-semibold text-gray-900 hover:text-blue-600"
>

{trade.memberName}

</Link>

</td>

<td className="px-4 py-3">

<span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getPartyClasses(trade.party)}`}>
{trade.party}
</span>

</td>

<td className="px-4 py-3 font-semibold">
{trade.ticker === "-" ? "—" : trade.ticker}
</td>

<td className="px-4 py-3 text-gray-600">
{trade.assetName}
</td>

<td className="px-4 py-3 font-medium">
{trade.transactionType}
</td>

<td className="px-4 py-3 text-right font-semibold">
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