import { Member } from "@/types/member"
import { isNonVotingHouseSeat } from "@/lib/congress"

interface MemberHeaderProps {
  member: Member
}

export default function MemberHeader({ member }: MemberHeaderProps) {

  const isNonVoting =
    member.district !== "Senate" && isNonVotingHouseSeat(member.state)

  const partyColor =
    member.party === "D"
      ? "bg-blue-600"
      : member.party === "R"
      ? "bg-red-600"
      : "bg-gray-500"

  const partyLabel =
    member.party === "D"
      ? "Democrat"
      : member.party === "R"
      ? "Republican"
      : "Independent"

  const location =
    member.district === "Senate"
      ? `${member.state} • Senate`
      : `${member.state} • ${member.district}`

  return(

<div className="dashboard-card p-10 flex flex-col gap-6">

<h1 className="text-4xl font-bold text-gray-900">
{member.name}
</h1>

<div
className={`inline-flex w-fit px-4 py-1.5 rounded-full text-white text-sm font-semibold ${partyColor}`}
>
{partyLabel} • {location}
</div>

{isNonVoting && (
<div className="inline-flex w-fit items-center rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600">
Non-voting member of the House
</div>
)}

<div className="flex gap-12 pt-4">

<div>

<div className="text-sm text-gray-500 mb-1">
Total Raised
</div>

<div className="text-3xl font-bold">
${member.totalRaised.toLocaleString()}
</div>

</div>


<div>

<div className="text-sm text-gray-500 mb-1">
Total Spent
</div>

<div className="text-3xl font-bold">
${member.totalSpent.toLocaleString()}
</div>

</div>

</div>

</div>

  )
}