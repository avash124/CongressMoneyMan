import { fetchHouseMembers, fetchSenateMembers, getStateCode } from "./congress"
import {
  fetchAllCongressTrades,
  fetchBulkCongressTrades,
  tradeToDbRow,
  type RawCongressTrade,
} from "./quiver"
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

function lastName(listName: string): string {
  return listName.split(",")[0]?.trim() || listName
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"])

// Order-independent, accent-insensitive name key so the roster's "Last, First"
// and Quiver's "First Last" collapse to the same value (e.g. "Van Hollen, Chris"
// and "Chris Van Hollen" both -> "chris hollen van").
function nameTokenKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token && !NAME_SUFFIXES.has(token))
    .sort()
    .join(" ")
}

function buildBioguideByName(
  members: { id: string; name: string }[]
): Map<string, string> {
  const byKey = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const member of members) {
    const key = nameTokenKey(member.name)
    if (!key) continue
    const existing = byKey.get(key)
    if (existing && existing !== member.id) ambiguous.add(key)
    else byKey.set(key, member.id)
  }
  // Drop names shared by two members rather than risk attributing a trade to the
  // wrong person; those stay unresolved (and are dropped on insert, as before).
  for (const key of ambiguous) byKey.delete(key)
  return byKey
}

function attachMissingBioguides(
  trades: RawCongressTrade[],
  byName: Map<string, string>
): number {
  let resolved = 0
  for (const trade of trades) {
    if (trade.Bioguide || !trade.Representative) continue
    const id = byName.get(nameTokenKey(trade.Representative))
    if (id) {
      trade.Bioguide = id
      resolved += 1
    }
  }
  return resolved
}

// Quiver's congress feed only carries a BioGuideID for House members, so every
// Senate disclosure arrives without one and tradeToDbRow drops it — which is why
// senator profiles showed no trades. Backfill the id from the synced roster by
// name so Senate trades persist too. Degrades to a no-op if the roster can't be
// loaded, leaving the prior (House-only) behavior untouched.
async function resolveMissingBioguides(trades: RawCongressTrade[]): Promise<number> {
  if (!trades.some((trade) => !trade.Bioguide && trade.Representative)) return 0
  try {
    const apiKey = resolveCongressApiKey()
    const [house, senate] = await Promise.all([
      fetchHouseMembers(apiKey),
      fetchSenateMembers(apiKey),
    ])
    return attachMissingBioguides(trades, buildBioguideByName([...house, ...senate]))
  } catch (error) {
    console.warn("[sync] bioguide name-resolution skipped:", error)
    return 0
  }
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
      image_url: m.imageUrl ?? null,
    })),
    ...senate.map((m) => ({
      bioguide_id: m.id,
      name: m.name,
      party: m.party,
      state: m.state,
      district: null,
      chamber: "senate" as const,
      image_url: m.imageUrl ?? null,
    })),
  ]

  await upsertMembers(rows)
  return { house: house.length, senate: senate.length }
}

export async function syncTrades(): Promise<{ fetched: number; persisted: number }> {
  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) throw new Error("Missing QUIVER_API_KEY")

  const trades = await fetchAllCongressTrades(apiKey, { forceRefresh: true })
  const resolved = await resolveMissingBioguides(trades)
  const rows = trades
    .map(tradeToDbRow)
    .filter((row): row is DbTrade => row !== null)

  await upsertTrades(rows)
  console.log(`[sync] syncTrades: resolved ${resolved} trade(s) to a bioguide by name`)
  return { fetched: trades.length, persisted: rows.length }
}

// Full multi-year history (Quiver's bulk endpoint, ~2020→present). Upsert-only
// and idempotent — unified trade ids mean these rows merge with the 15-minute
// live sync instead of duplicating. Run on a slow cadence (daily); the live
// `syncTrades` keeps the most-recent disclosures fresh between runs.
export async function backfillTrades(): Promise<{
  fetched: number
  persisted: number
}> {
  const apiKey = process.env.QUIVER_API_KEY
  if (!apiKey) throw new Error("Missing QUIVER_API_KEY")

  const trades = await fetchBulkCongressTrades(apiKey)
  const resolved = await resolveMissingBioguides(trades)
  const rows = trades
    .map(tradeToDbRow)
    .filter((row): row is DbTrade => row !== null)

  await upsertTrades(rows)
  console.log(`[sync] backfillTrades: resolved ${resolved} trade(s) to a bioguide by name`)
  return { fetched: trades.length, persisted: rows.length }
}

export async function syncRankings(): Promise<{ house: number; senate: number }> {
  const apiKey = resolveCongressApiKey()
  const { house, senate } = await refreshAllRankings(apiKey)
  return { house: house.byNetWorth.length, senate: senate.byNetWorth.length }
}
const FEC_CONCURRENCY = 4
const FEC_DELAY_MS = 150
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
