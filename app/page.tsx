"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

function parseSearch(raw: string): Record<string, string> {
  const s = raw.trim()

  if (/^\d{5}(-\d{4})?$/.test(s)) {
    return { zip: s }
  }

  const districtMatch = s.match(/^([A-Za-z]{2})\s*-?\s*(\d{1,2})$/)

  if (districtMatch) {
    return { state: districtMatch[1].toUpperCase(), district: districtMatch[2] }
  }

  return { name: s }
}

export default function Home() {

  const router = useRouter()

  const [query,setQuery] = useState("")
  const [chamber,setChamber] = useState("House")
  const [stockQuery,setStockQuery] = useState("")

  function onSubmit(e:React.FormEvent<HTMLFormElement>){

    e.preventDefault()

    const cleaned = query.trim()

    if(!cleaned) return

    let filters:Record<string,string>

    if(chamber==="Senate"){
      filters = { name:cleaned }
    }
    else{
      filters = parseSearch(cleaned)
    }

    filters.chamber = chamber

    const params = new URLSearchParams(filters)

    router.push(`/search?${params.toString()}`)
  }

  function StockSubmit(e:React.FormEvent<HTMLFormElement>){

    e.preventDefault()

    const cleaned = stockQuery.trim()

    if(!cleaned) return

    const isTicker = /^[A-Z]{1,5}$/.test(cleaned)

    const params = new URLSearchParams({
      [isTicker?'ticker':'company']:cleaned
    })

    router.push(`/search?${params.toString()}`)
  }

  return (

<main className="space-y-10">

<div className="dashboard-card p-10 text-center">

<h1 className="text-4xl font-bold mb-3">
Congress Financial Intelligence
</h1>

<p className="text-gray-600 mb-8">
Search representatives, financial disclosures, and congressional stock trades
</p>

<form onSubmit={onSubmit} className="max-w-xl mx-auto">

<div className="flex gap-3">

<select
value={chamber}
onChange={(e)=>setChamber(e.target.value)}
className="border border-gray-300 rounded-xl px-4 py-3 bg-white"
>
<option value="House">House</option>
<option value="Senate">Senate</option>
</select>

<input
value={query}
onChange={(e)=>setQuery(e.target.value)}
placeholder="Search name, district (CA-47), or zipcode"
className="flex-1 border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none"
/>

<button
className="bg-blue-600 text-white px-6 rounded-xl hover:bg-blue-700 transition"
>
Search
</button>

</div>

</form>

</div>


<div className="dashboard-card p-8">

<h2 className="text-2xl font-semibold mb-4">
Stock Search
</h2>

<p className="text-gray-600 mb-6">
Search congressional trades by ticker or company
</p>

<form onSubmit={StockSubmit} className="flex gap-3 max-w-xl">

<input
value={stockQuery}
onChange={(e)=>setStockQuery(e.target.value)}
placeholder="AAPL or Apple"
className="flex-1 border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 outline-none"
/>

<button
className="bg-blue-600 text-white px-6 rounded-xl hover:bg-blue-700 transition"
>
Search
</button>

</form>

</div>

</main>

  )
}