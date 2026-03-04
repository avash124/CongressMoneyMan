import { headers } from "next/headers"
import type { Member } from "@/types/member"
import MemberHeader from "@/components/MemberHeader"
import TopIndustriesCard from "@/components/TopIndustriesCard"
import PacDonationsSection from "@/components/PACDonationsCard"
import CongressTradesCard from "@/components/CongressTradesCard"

export default async function SenatorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const requestHeaders = await headers()
  const host = requestHeaders.get("host")
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http"

  if (!host) {
    return <div>Senator not found</div>
  }

  const response = await fetch(`${protocol}://${host}/api/senator/${id}`, {
    cache: "no-store",
  })

  if (!response.ok) {
    return <div>Senator not found</div>
  }

  const payload = await response.json()

  if (!payload?.id) {
    return <div>Senator not found</div>
  }

  const senator = payload as Member

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
        <MemberHeader member={senator} />
        <TopIndustriesCard industries={senator.topIndustries ?? []} />
      </div>

      <PacDonationsSection donations={senator.pacDonations ?? []} />
      <CongressTradesCard
        memberId={senator.id}
        initialTrades={senator.trades ?? []}
      />
    </div>
  )
}
