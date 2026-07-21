import { Industry } from "@/types/member"

interface TopIndustriesCardProps {
  industries: Industry[]
}

export default function TopIndustriesCard({ industries }: TopIndustriesCardProps){

const topThree = [...industries]
.sort((a,b)=>b.amount-a.amount)
.slice(0,3)

return(

<div className="dashboard-card p-8 min-w-[320px] h-fit">

<h2 className="text-xl font-semibold text-slate-900 mb-6">
Top Supporting Industries
</h2>

{topThree.length === 0 ? (

<p className="text-slate-500">
No industry data available.
</p>

) : (

<div className="space-y-4">

{topThree.map((industry,index)=>(
<div
key={industry.name}
className="flex justify-between items-center border-b border-slate-200 pb-3"
>

<span className="text-slate-700">
{index+1}. {industry.name}
</span>

<span className="font-mono font-semibold tabular-nums">
${industry.amount.toLocaleString()}
</span>

</div>
))}

</div>

)}

</div>

)

}