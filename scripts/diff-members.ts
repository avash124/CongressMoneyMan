import "./load-env"
import { fetchHouseMembers, fetchSenateMembers } from "../lib/congress"
import { getMembersFromDb } from "../lib/db"

function resolveCongressApiKey(): string {
  const apiKey = process.env.CONGRESS_API_KEY ?? process.env.CONGRESS_GOV_API_KEY
  if (!apiKey) throw new Error("Missing CONGRESS_API_KEY")
  return apiKey
}

async function main(): Promise<void> {
  const apiKey = resolveCongressApiKey()

  const [house, senate, dbHouse, dbSenate] = await Promise.all([
    fetchHouseMembers(apiKey),
    fetchSenateMembers(apiKey),
    getMembersFromDb("house"),
    getMembersFromDb("senate"),
  ])

  const dbMembers = [...dbHouse, ...dbSenate]
  if (dbMembers.length === 0) {
    console.log("DB returned no members — Supabase env vars unset, or the table is empty.")
    return
  }

  console.log(
    `Live roster:  house=${house.length} senate=${senate.length} total=${house.length + senate.length}`
  )
  console.log(
    `DB roster:    house=${dbHouse.length} senate=${dbSenate.length} total=${dbMembers.length}`
  )
  console.log("")

  const liveIds = new Set([...house, ...senate].map((m) => m.id))
  const stale = dbMembers.filter((m) => !liveIds.has(m.bioguide_id))

  if (stale.length === 0) {
    console.log("No stale rows — every DB member is in the live roster. Nothing would be pruned.")
  } else {
    console.log(`Would prune ${stale.length} stale member(s):`)
    for (const m of stale) {
      const seat = m.chamber === "house" ? `${m.state}-${m.district ?? "?"}` : m.state
      console.log(`  ${m.bioguide_id}  ${m.name}  (${m.party} ${seat}, ${m.chamber})`)
    }
  }

  const dbIds = new Set(dbMembers.map((m) => m.bioguide_id))
  const missing = [...house, ...senate].filter((m) => !dbIds.has(m.id))
  if (missing.length > 0) {
    console.log("")
    console.log(`Note: ${missing.length} live member(s) not yet in the DB (would be inserted):`)
    for (const m of missing) {
      console.log(`  ${m.id}  ${m.name}  (${m.party} ${m.state})`)
    }
  }
}
main().then(
  () => {
    process.exitCode = 0
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
)
