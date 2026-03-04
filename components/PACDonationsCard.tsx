import { PacDonation } from "@/types/member"

interface PacDonationsCardProps {
  donations: PacDonation[]
}

export default function PACDonationsCard({ donations }: PacDonationsCardProps){

return(

<div className="dashboard-card card-hover p-8 mt-8">

<h2 className="text-xl font-semibold text-gray-900 mb-6">
Recent PAC Donations
</h2>

{donations.length === 0 ? (

<p className="text-gray-500">
No PAC donation data available.
</p>

) : (

<table className="min-w-full text-sm">

<thead className="text-xs uppercase text-gray-500 border-b">

<tr>
<th className="text-left py-3">PAC</th>
<th className="text-right py-3">Amount</th>
</tr>

</thead>

<tbody>

{donations.map((donation,index)=>(
<tr
key={index}
className="border-b border-gray-200 hover:bg-gray-50"
>

<td className="py-3">
{donation.pacName}
</td>

<td className="py-3 text-right font-semibold">
${donation.amount.toLocaleString()}
</td>

</tr>
))}

</tbody>

</table>

)}

</div>

)

}