import { Suspense } from "react"
import MemberHeader from "@/components/MemberHeader"
import TopIndustriesCard from "@/components/TopIndustriesCard"
import PacDonationsSection from "@/components/PACDonationsCard"
import CongressTradesCard from "@/components/CongressTradesCard"
import PortfolioBreakdownCard from "@/components/PortfolioBreakdownCard"
import {
  loadMemberBase,
  loadMemberFecTotals,
  loadMemberFecDonations,
  loadPortfolioBreakdown,
  loadTrades,
} from "@/lib/profile"

// Serve the fully-rendered profile from the route cache (milliseconds) and
// regenerate in the background every 15 min. Without this the page re-renders
// per request, awaiting ~1s of sequential Congress.gov + FEC calls every time.
// `generateStaticParams` (empty) opts the dynamic `[id]` route into ISR: the
// first visit to a member renders on demand and is cached; everyone after is
// served statically until the next revalidation.
export const revalidate = 900

export async function generateStaticParams() {
  return []
}

// Header needs Congress.gov (fast) + FEC totals (one cheap request), so it
// streams ahead of the slow PAC-donation pagination that the industries and
// donations cards need. Trades stream independently from Quiver.
async function HeaderSection({ id }: { id: string }) {
  const [base, totals] = await Promise.all([
    loadMemberBase(id),
    loadMemberFecTotals(id),
  ])
  if (!base) return <div>Member not found</div>
  return <MemberHeader member={{ ...base, ...totals }} />
}

async function IndustriesSection({ id }: { id: string }) {
  const { topIndustries } = await loadMemberFecDonations(id)
  return <TopIndustriesCard industries={topIndustries} />
}

async function PortfolioSection({ id }: { id: string }) {
  const allocations = await loadPortfolioBreakdown(id)
  return <PortfolioBreakdownCard allocations={allocations} />
}

async function DonationsSection({ id }: { id: string }) {
  const { pacDonations } = await loadMemberFecDonations(id)
  return <PacDonationsSection donations={pacDonations} />
}

async function TradesSection({ id }: { id: string }) {
  const trades = await loadTrades(id)
  return <CongressTradesCard memberId={id} initialTrades={trades} />
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="h-8 w-64 animate-pulse rounded bg-slate-200" />
      <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
      <div className="mt-2 h-5 w-56 animate-pulse rounded bg-slate-200" />
    </div>
  )
}

function CardSkeleton() {
  return <div className="h-48 w-full animate-pulse rounded-xl bg-slate-200" />
}

export default async function MemberPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // Fast existence check on the cheap Congress.gov lookup (cache()-deduped, so
  // HeaderSection reuses it). Avoids streaming empty cards for an unknown id.
  if (!(await loadMemberBase(id))) {
    return <div style={{ padding: "2rem" }}>Member not found</div>
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "2rem",
          padding: "3rem",
        }}
      >
        <Suspense fallback={<HeaderSkeleton />}>
          <HeaderSection id={id} />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <IndustriesSection id={id} />
        </Suspense>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <Suspense fallback={<CardSkeleton />}>
          <PortfolioSection id={id} />
        </Suspense>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <Suspense fallback={<CardSkeleton />}>
          <DonationsSection id={id} />
        </Suspense>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <Suspense fallback={<CardSkeleton />}>
          <TradesSection id={id} />
        </Suspense>
      </div>
    </div>
  )
}
