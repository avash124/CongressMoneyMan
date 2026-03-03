import { Member } from "@/types/member"
import { headers } from "next/headers"
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
  const requestHeaders = await headers()
  const host = requestHeaders.get("host")
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http"

  if (!host) {
    return <div>Member not found</div>
  }

  const res = await fetch(
    `${protocol}://${host}/api/member/${id}`,
    { cache: "no-store" }
  )

  if (!res.ok) {
    return <div>Member not found</div>
  }

  const data = await res.json()

  if (!data?.id) {
    return <div>Member not found</div>
  }

  const member = data as Member

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
          borderRadius: "12px",
        }}
      >
        <MemberHeader member={member} />
        <TopIndustriesCard industries={member.topIndustries ?? []} />
      </div>

      <div style={{ marginTop: "2rem" }}>
        <PacDonationsSection donations={member.pacDonations ?? []} />
      </div>

      <div style={{ marginTop: "2rem" }}>
        <CongressTradesCard
          memberId={member.id}
          initialTrades={member.trades ?? []}
        />
      </div>
    </div>
  )
}
