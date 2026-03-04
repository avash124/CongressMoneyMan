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

<h2 className="text-xl font-semibold text-gray-900 mb-6">
Top Supporting Industries
</h2>

{topThree.length === 0 ? (

<p className="text-gray-500">
No industry data available.
</p>

) : (

<div className="space-y-4">

{topThree.map((industry,index)=>(
<div
key={industry.name}
className="flex justify-between items-center border-b border-gray-200 pb-3"
>

<span className="text-gray-700">
{index+1}. {industry.name}
</span>

<span className="font-semibold">
${industry.amount.toLocaleString()}
</span>

</div>
))}

</div>

)}

</div>

)

}