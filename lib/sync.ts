// Shared ETL sync routines: fetch from the upstream APIs and write to Postgres.
//
// These are plain async functions with no Next.js / React dependencies, so the
// same code runs from two drivers:
//   1. The `/api/cron/*` route handlers (Vercel Cron, in production).
//   2. The standalone background worker (`npm run worker`) — a long-running
//      process that runs them on a timer, locally or on any always-on host.
//
// The upstream APIs (Congress.gov, Quiver, FEC) do not push events, so freshness
// is bounded by how often these poll. Each is idempotent (upsert/replace), so
// re-running only ever refreshes rows.

import { fetchHouseMembers, fetchSenateMembers, getStateCode } from "./congress"
import { fetchAllCongressTrades, tradeToDbRow } from "./quiver"
import { fetchFecTotals, fetchPacDonations } from "./fec"
import { resolveFecCandidate, currentCycle, aggregateDonors } from "./profile"
import { refreshAllRankings, mapWithConcurrency } from "./rankings"
import {
  upsertMembers,
  upsertTrades,
  upsertFecCandidate,
  replacePacDonations,
  type DbMember,
  type DbTrade,
  type DbPacDonation,
} from "./db"

function resolveCongressApiKey(): string {
  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY
  if (!apiKey) throw new Error("Missing CONGRESS_API_KEY")
  return apiKey
}

// fetchHouseMembers / fetchSenateMembers expose the Congress list-format name
// ("Last, First"); FEC search keys mostly on last name + state + office.
function lastName(listName: string): string {
  return listName.split(",")[0]?.trim() || listName
}

// Snapshot the current House + Senate rosters into `members`.
export async function syncMembers(): Promise<{ house: number; senate: number }> {
  const apiKey = resolveCongressApiKey()
  const [house, senate] = await Promise.all([
    fetchHouseMembers(apiKey),
    fetchSenateMembers(apiKey),
  ])

  const rows: DbMember[] = [
    ...house.map((m) => ({
      bioguide_id: m.id,
      name: m.name,
      party: m.party,
      state: m.state,
      district: m.district,
      chamber: "house" as const,
    })),
    ...senate.map((m) => ({
      bioguide_id: m.id,
      name: m.name,
      party: m.party,
      state: m.state,
      district: null,
      chamber: "senate" as const,
    })),
  ]

  await upsertMembers(rows)
  return { house: house.length, senate: senate.length }
}

// Pull a fresh live-trades feed straight from Quiver and persist it.
export async function syncTrades(): Promise<{ fetched: number; persisted: number }> {
  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) throw new Error("Missing QUIVER_API_KEY")

  const trades = await fetchAllCongressTrades(apiKey, { forceRefresh: true })
  const rows = trades
    .map(tradeToDbRow)
    .filter((row): row is DbTrade => row !== null)

  await upsertTrades(rows)
  return { fetched: trades.length, persisted: rows.length }
}

// Run the net-worth / stock-holdings fan-out. refreshHouseRankings /
// refreshSenateRankings already warm Redis and write `portfolio_data`
// (persistRankings -> upsertPortfolios), so this one job feeds both.
export async function syncRankings(): Promise<{ house: number; senate: number }> {
  const apiKey = resolveCongressApiKey()
  const { house, senate } = await refreshAllRankings(apiKey)
  return { house: house.byNetWorth.length, senate: senate.byNetWorth.length }
}

const FEC_CONCURRENCY = 4
const FEC_DELAY_MS = 150

// For every member: resolve their FEC candidate, then persist headline totals
// (fec_candidates) and per-donor PAC aggregates (pac_donations).
export async function syncFec(): Promise<{ members: number; resolved: number }> {
  const apiKey = resolveCongressApiKey()
  const fecKey = process.env.FEC_API_KEY
  if (!fecKey) throw new Error("Missing FEC_API_KEY")

  const [house, senate] = await Promise.all([
    fetchHouseMembers(apiKey),
    fetchSenateMembers(apiKey),
  ])

  const targets = [
    ...house.map((m) => ({
      id: m.id,
      name: lastName(m.name),
      state: m.state,
      office: "H" as const,
      preferIncumbent: false,
      perPage: 10,
    })),
    ...senate.map((m) => ({
      id: m.id,
      name: lastName(m.name),
      state: m.state,
      office: "S" as const,
      preferIncumbent: true,
      perPage: 20,
    })),
  ]

  const cycle = currentCycle()
  let resolved = 0

  await mapWithConcurrency(
    targets,
    FEC_CONCURRENCY,
    async (target) => {
      const ref = await resolveFecCandidate({
        name: target.name,
        stateCode: getStateCode(target.state),
        office: target.office,
        preferIncumbent: target.preferIncumbent,
        perPage: target.perPage,
      })
      if (!ref) return
      resolved += 1

      const totals = await fetchFecTotals(ref.candidateId, fecKey)
      await upsertFecCandidate({
        bioguide_id: target.id,
        candidate_id: ref.candidateId,
        committee_ids: ref.committeeIds,
        total_raised: totals?.receipts ?? 0,
        total_spent: totals?.disbursements ?? 0,
        cycle,
      })

      const { allDonations } = await fetchPacDonations(ref.committeeIds, fecKey)
      const rows: DbPacDonation[] = aggregateDonors(allDonations).map((d) => ({
        bioguide_id: target.id,
        pac_name: d.pacName,
        amount: d.amount,
        cycle,
      }))
      await replacePacDonations(target.id, rows)
    },
    FEC_DELAY_MS
  )

  return { members: targets.length, resolved }
}
