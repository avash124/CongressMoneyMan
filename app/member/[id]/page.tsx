import { Member } from "@/types/member"
import MemberHeader from "@/components/MemberHeader"
import TopIndustriesCard from "@/components/TopIndustriesCard"
import PacDonationsSection from "@/components/PACDonationsCard"
import CongressTradesCard from "@/components/CongressTradesCard"

export default async function MemberPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const res = await fetch(
    `http://localhost:3000/api/member/${id}`,
    { cache: "no-store" }
  )

  if (!res.ok) {
    return <div>Member not found</div>
  }

  const member: Member = await res.json()

  return (
    <div style={{ padding: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "2rem",
          padding: "3rem",
          background: "#f3f4f6",
          minHeight: "100vh",
        }}
      >
        <MemberHeader member={member} />
        <TopIndustriesCard industries={member.topIndustries ?? []} />
      </div>

      <PacDonationsSection donations={member.pacDonations ?? []} />
      <CongressTradesCard trades={member.trades ?? []} />
    </div>
  )
}