import Link from "next/link"
import type { Trade } from "@/types/member"

export default function CongressTradesCard({
  initialTrades: trades,
}: {
  initialTrades: Trade[]
  memberId: string
}) {

  return(

<div className="dashboard-card card-hover p-8 mt-8">

<h2 className="text-xl font-semibold text-slate-900 mb-6">
Recent Stock Trades
</h2>

{trades.length === 0 ? (

<p className="text-slate-500">
No trading activity available.
</p>

) : (

<table className="min-w-full text-sm">

<thead className="text-xs uppercase text-slate-500 border-b">

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
className="border-b border-slate-200 hover:bg-slate-50"
>

<td className="py-3 font-mono font-semibold">
{trade.id ? (
  <Link
    href={`/trade/${encodeURIComponent(trade.id)}`}
    className="rounded-sm text-blue-600 hover:underline focus-ring"
  >
    {trade.ticker}
  </Link>
) : (
  trade.ticker
)}
</td>

<td className="py-3 text-slate-600">
{trade.transactionType}
</td>

<td className="py-3 text-right font-mono font-semibold tabular-nums">
{trade.amount}
</td>

<td className="py-3 text-right font-mono tabular-nums text-slate-600">
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