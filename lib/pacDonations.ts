import { getCache, setCache } from "./cache"
import { getMembersFromDb, getTopPacDonations, type DbMember } from "./db"

export const PAC_DONATIONS_KEY = "pac-donations-v1"
const PAC_DONATIONS_TTL_SECONDS = 6 * 60 * 60
const TOP_N = 1000

export type PacDonationRow = {
  bioguideId: string
  memberName: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
  state: string
  pacName: string
  amount: number
}

function normalizeParty(value: string | null | undefined): "D" | "R" | "I" {
  const v = (value ?? "").trim().toUpperCase()
  if (v.startsWith("D")) return "D"
  if (v.startsWith("R")) return "R"
  return "I"
}

export async function getPacDonationLeaderboard(): Promise<PacDonationRow[]> {
  const cached = await getCache<PacDonationRow[]>(PAC_DONATIONS_KEY)
  if (cached && cached.length > 0) return cached

  const [donations, house, senate] = await Promise.all([
    getTopPacDonations(TOP_N),
    getMembersFromDb("house"),
    getMembersFromDb("senate"),
  ])
  if (donations.length === 0) return []

  const byId = new Map<string, DbMember>()
  for (const m of [...house, ...senate]) byId.set(m.bioguide_id, m)

  const rows: PacDonationRow[] = []
  for (const d of donations) {
    const member = byId.get(d.bioguide_id)
    if (!member) continue
    const amount = Number(d.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    rows.push({
      bioguideId: d.bioguide_id,
      memberName: member.name,
      party: normalizeParty(member.party),
      chamber: member.chamber === "senate" ? "senate" : "house",
      state: member.state,
      pacName: d.pac_name,
      amount: Math.round(amount),
    })
  }

  rows.sort((a, b) => b.amount - a.amount)
  if (rows.length > 0) await setCache(PAC_DONATIONS_KEY, rows, PAC_DONATIONS_TTL_SECONDS)
  return rows
}
