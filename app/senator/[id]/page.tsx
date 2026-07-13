import { Suspense } from "react"
import MemberHeader from "@/components/MemberHeader"
import TopIndustriesCard from "@/components/TopIndustriesCard"
import PacDonationsSection from "@/components/PACDonationsCard"
import CongressTradesCard from "@/components/CongressTradesCard"
import InsightCard from "@/components/InsightCard"
import PredictedTradesCard from "@/components/PredictedTradesCard"
import PortfolioBreakdownCard from "@/components/PortfolioBreakdownCard"
import { fetchBackend } from "@/lib/backend"
import type { AssetAllocation, Industry, Member, PacDonation, Trade } from "@/types/member"

type FecTotals = { totalRaised: number; totalSpent: number }
type FecDonations = { pacDonations: PacDonation[]; topIndustries: Industry[] }

const loadSenatorBase = (id: string) =>
  fetchBackend<Member>(`/api/senator/${encodeURIComponent(id)}/base`)
const loadSenatorFecTotals = (id: string) =>
  fetchBackend<FecTotals>(`/api/senator/${encodeURIComponent(id)}/fec-totals`)
const loadSenatorFecDonations = (id: string) =>
  fetchBackend<FecDonations>(`/api/senator/${encodeURIComponent(id)}/fec-donations`)
const loadPortfolioBreakdown = (id: string) =>
  fetchBackend<{ allocations: AssetAllocation[] }>(
    `/api/member/${encodeURIComponent(id)}/portfolio`
  )
const loadTrades = (id: string) =>
  fetchBackend<{ trades: Trade[] }>(`/api/member/${encodeURIComponent(id)}/trades`)

export const revalidate = 900

export async function generateStaticParams() {
  return []
}

async function HeaderSection({ id }: { id: string }) {
  const [base, totals] = await Promise.all([
    loadSenatorBase(id),
    loadSenatorFecTotals(id),
  ])
  if (!base) return <div>Senator not found</div>
  return <MemberHeader member={{ ...base, ...(totals ?? {}) }} />
}

async function IndustriesSection({ id }: { id: string }) {
  const donations = await loadSenatorFecDonations(id)
  return <TopIndustriesCard industries={donations?.topIndustries ?? []} />
}

async function PortfolioSection({ id }: { id: string }) {
  const breakdown = await loadPortfolioBreakdown(id)
  return <PortfolioBreakdownCard allocations={breakdown?.allocations ?? []} />
}

async function DonationsSection({ id }: { id: string }) {
  const donations = await loadSenatorFecDonations(id)
  return <PacDonationsSection donations={donations?.pacDonations ?? []} />
}

async function TradesSection({ id }: { id: string }) {
  const data = await loadTrades(id)
  return <CongressTradesCard memberId={id} initialTrades={data?.trades ?? []} />
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

export default async function SenatorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  if (!(await loadSenatorBase(id))) {
    return <div style={{ padding: "2rem" }}>Senator not found</div>
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
          <InsightCard
            path={`/api/insights/member/${encodeURIComponent(id)}`}
            title="Trading Pattern Insight"
          />
        </Suspense>
      </div>

      <div style={{ marginTop: "2rem" }}>
        <Suspense fallback={<CardSkeleton />}>
          <PredictedTradesCard id={id} />
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
