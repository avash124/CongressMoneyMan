import { categorizeIndustry } from "@/app/api/member/[id]/industryClassifier"
import type { PacDonation } from "@/types/member"
import { getCache, setCache } from "./cache"

const FEC_TOTALS_TTL_SECONDS = 6 * 60 * 60
const FEC_PAC_TTL_SECONDS = 6 * 60 * 60

export type FecDonations = {
  topDonors: PacDonation[]
  allDonations: { pacName: string; amount: number }[]
}

export async function fetchPacDonations(
  committeeIds: string[],
  apiKey: string,
  maxPages = 15
): Promise<FecDonations> {
  if (committeeIds.length === 0 || !apiKey) {
    return { topDonors: [], allDonations: [] }
  }

  const year = new Date().getFullYear()
  const cycle = year % 2 === 0 ? year : year - 1

  const cacheKey = `fec-pac:${[...committeeIds].sort().join(",")}:${cycle}`
  const cached = await getCache<FecDonations>(cacheKey)
  if (cached) return cached

  const allDonations: { pacName: string; amount: number }[] = []

  for (const committeeId of committeeIds) {
    let lastIndex: string | undefined
    let lastDate: string | undefined
    let pageCount = 0

    while (pageCount < maxPages) {
      const url = new URL("https://api.open.fec.gov/v1/schedules/schedule_a/")
      url.searchParams.set("api_key", apiKey)
      url.searchParams.set("committee_id", committeeId)
      url.searchParams.set("two_year_transaction_period", String(cycle))
      url.searchParams.set("contributor_type", "committee")
      url.searchParams.set("per_page", "100")
      url.searchParams.set("sort", "-contribution_receipt_date")

      if (lastIndex) url.searchParams.set("last_index", lastIndex)
      if (lastDate) url.searchParams.set("last_contribution_receipt_date", lastDate)

      const res = await fetch(url.toString(), { next: { revalidate: 3600 } })
      if (!res.ok) break

      const data = await res.json()
      const results = data.results ?? []
      if (results.length === 0) break

      for (const r of results) {
        if (!r.contributor_name) continue
        allDonations.push({
          pacName: r.contributor_name,
          amount: r.contribution_receipt_amount ?? 0,
        })
      }

      const li = data.pagination?.last_indexes
      if (!li?.last_index || li.last_index === lastIndex) break

      lastIndex = li.last_index
      lastDate = li.last_contribution_receipt_date
      pageCount++
    }
  }
  const donorTotals: Record<string, number> = {}
  for (const { pacName, amount } of allDonations) {
    donorTotals[pacName] = (donorTotals[pacName] ?? 0) + amount
  }

  const topDonors = Object.entries(donorTotals)
    .map(([pacName, amount]) => ({ pacName, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)

  const result: FecDonations = { topDonors, allDonations }
  await setCache(cacheKey, result, FEC_PAC_TTL_SECONDS)
  return result
}

export async function fetchFecTotals(
  candidateId: string,
  apiKey: string
): Promise<{ receipts?: number; disbursements?: number } | null> {
  if (!candidateId || !apiKey) return null

  const cacheKey = `fec-totals:${candidateId}`
  const cached = await getCache<{ receipts?: number; disbursements?: number }>(cacheKey)
  if (cached) return cached

  const res = await fetch(
    `https://api.open.fec.gov/v1/candidate/${candidateId}/totals/?api_key=${apiKey}`,
    { next: { revalidate: 3600 } }
  )

  if (!res.ok) return null

  const data = await res.json()
  const totals = data.results?.[0] ?? null
  if (totals) await setCache(cacheKey, totals, FEC_TOTALS_TTL_SECONDS)
  return totals
}

export function computeTopIndustries(
  donations: { pacName: string; amount: number }[]
): { name: string; amount: number }[] {
  const totals: Record<string, number> = {}

  for (const { pacName, amount } of donations) {
    const industry = categorizeIndustry(pacName)
    totals[industry] = (totals[industry] ?? 0) + amount
  }

  return Object.entries(totals)
    .filter(([name]) => name !== "Other")
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)
}
