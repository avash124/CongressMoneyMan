"use client"

import { useEffect, useState } from "react"
import type { Trade } from "@/types/member"

export default function CongressTradesCard({
  initialTrades,
  memberId,
}: {
  initialTrades: Trade[]
  memberId: string
}) {

  const [trades,setTrades] = useState<Trade[]>(initialTrades)

  useEffect(()=>{

    let cancelled = false

    async function loadTrades(){

      try{

        const response = await fetch(`/api/member/${memberId}/trades`,{
          cache:"no-store"
        })

        if(!response.ok) return

        const payload = await response.json()

        if(!cancelled){
          setTrades(payload.trades ?? [])
        }

      }catch{}

    }

    loadTrades()

    return()=>{cancelled=true}

  },[memberId])


  return(

<div className="dashboard-card card-hover p-8 mt-8">

<h2 className="text-xl font-semibold text-gray-900 mb-6">
Recent Stock Trades
</h2>

{trades.length === 0 ? (

<p className="text-gray-500">
No trading activity available.
</p>

) : (

<table className="min-w-full text-sm">

<thead className="text-xs uppercase text-gray-500 border-b">

<tr>
<th className="text-left py-3">Ticker</th>
<th className="text-left py-3">Type</th>
<th className="text-right py-3">Amount</th>
<th className="text-right py-3">Date</th>
</tr>

</thead>

<tbody>

{trades.map((trade,index)=>(
<tr
key={index}
className="border-b border-gray-200 hover:bg-gray-50"
>

<td className="py-3 font-semibold">
{trade.ticker}
</td>

<td className="py-3 text-gray-600">
{trade.transactionType}
</td>

<td className="py-3 text-right font-semibold">
{trade.amount}
</td>

<td className="py-3 text-right text-gray-600">
{trade.transactionDate}
</td>

</tr>
))}

</tbody>

</table>

)}

</div>

  )

}