import Image from "next/image"
import { Member } from "@/types/member"
import { isNonVotingHouseSeat } from "@/lib/congress"

interface MemberHeaderProps {
  member: Member
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ""
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ""
  return (first + last).toUpperCase() || "?"
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

  const partyRing =
    member.party === "D"
      ? "ring-blue-500"
      : member.party === "R"
      ? "ring-red-500"
      : "ring-gray-400"

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

<div className="dashboard-card p-10 flex flex-col gap-8">

<div className="flex items-center gap-7">

<div
className={`shrink-0 h-32 w-32 overflow-hidden rounded-2xl bg-gray-100 ring-4 ring-offset-2 ${partyRing}`}
>
{member.imageUrl ? (
<Image
src={member.imageUrl}
alt={member.name}
width={128}
height={128}
className="h-full w-full object-cover object-top"
priority
/>
) : (
<div className="flex h-full w-full items-center justify-center text-3xl font-bold text-gray-400">
{getInitials(member.name)}
</div>
)}
</div>

<div className="flex flex-col gap-3">

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

</div>

</div>

<div className="flex gap-12 pt-6 border-t border-gray-100">

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
