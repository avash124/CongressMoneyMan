export type DbMember = {
  bioguide_id: string
  name: string
  party: "D" | "R" | "I"
  state: string
  district: string | null
  chamber: "house" | "senate"
  image_url: string | null
}

export type DbTrade = {
  trade_id: string
  bioguide_id: string
  member_name: string | null
  party: string | null
  chamber: string | null
  ticker: string | null
  asset_name: string | null
  asset_type: string | null
  transaction_type: string | null
  transaction_date: string | null
  traded: string | null
  range_text: string | null
  trade_size_usd: number | null
  filed_at: string | null
}

export type DbPortfolio = {
  bioguide_id: string
  net_worth: number | null
  stock_holdings: number | null
}

export type DbHolding = {
  bioguide_id: string
  member_name: string | null
  party: string | null
  chamber: string | null
  ticker: string
  value: number
}

export type DbFecCandidate = {
  bioguide_id: string
  candidate_id: string | null
  committee_ids: string[]
  total_raised: number
  total_spent: number
  cycle: number | null
}

export type DbPacDonation = {
  bioguide_id: string
  pac_name: string
  amount: number
  cycle: number | null
}

type PgResult = { data: unknown; error: { message: string } | null }

interface QueryBuilder extends PromiseLike<PgResult> {
  select(columns?: string): QueryBuilder
  eq(column: string, value: string | number): QueryBuilder
  neq(column: string, value: string | number): QueryBuilder
  range(from: number, to: number): QueryBuilder
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean }
  ): QueryBuilder
  limit(count: number): QueryBuilder
  upsert(values: unknown, options?: { onConflict?: string }): QueryBuilder
  insert(values: unknown): QueryBuilder
  delete(): QueryBuilder
  in(column: string, values: (string | number)[]): QueryBuilder
}

type SupabaseLike = { from(table: string): QueryBuilder }

let clientPromise: Promise<SupabaseLike | null> | null = null

async function getDb(): Promise<SupabaseLike | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const pkg = "@supabase/supabase-js"
        const mod = (await import(pkg)) as {
          createClient: (
            url: string,
            key: string,
            opts?: { auth?: { persistSession?: boolean } }
          ) => SupabaseLike
        }
        return mod.createClient(
          process.env.SUPABASE_URL as string,
          process.env.SUPABASE_SERVICE_ROLE_KEY as string,
          { auth: { persistSession: false } }
        )
      } catch (error) {
        console.error("[db] Failed to initialize Supabase client:", error)
        return null
      }
    })()
  }

  return clientPromise
}

export function writeBack(task: () => Promise<void>): void {
  void task().catch((error) => console.error("[db] write-back failed:", error))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
export async function getMembersFromDb(
  chamber: "house" | "senate"
): Promise<DbMember[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const { data, error } = await db.from("members").select("*").eq("chamber", chamber)
    if (error) {
      console.error(`[db] getMembersFromDb(${chamber}):`, error.message)
      return []
    }
    return (data as DbMember[]) ?? []
  } catch (error) {
    console.error(`[db] getMembersFromDb(${chamber}) threw:`, error)
    return []
  }
}

export async function upsertMembers(rows: DbMember[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  if (!db) return
  const stamped = rows.map((r) => ({ ...r, last_updated: new Date().toISOString() }))
  try {
    const { error } = await db.from("members").upsert(stamped, { onConflict: "bioguide_id" })
    if (error) {
      console.error("[db] upsertMembers:", error.message)
      return
    }
    const currentIds = new Set(rows.map((r) => r.bioguide_id))
    const { data, error: selError } = await db.from("members").select("bioguide_id")
    if (selError) {
      console.error("[db] upsertMembers prune select:", selError.message)
      return
    }
    const stale = ((data as { bioguide_id: string }[]) ?? [])
      .map((r) => r.bioguide_id)
      .filter((id) => !currentIds.has(id))
    if (stale.length > 0) {
      const { error: delError } = await db.from("members").delete().in("bioguide_id", stale)
      if (delError) console.error("[db] upsertMembers prune delete:", delError.message)
    }
  } catch (error) {
    console.error("[db] upsertMembers threw:", error)
  }
}

export async function getRecentTradesFromDb(limit = 1000): Promise<DbTrade[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const { data, error } = await db
      .from("trades")
      .select("*")
      .order("filed_at", { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) {
      console.error("[db] getRecentTradesFromDb:", error.message)
      return []
    }
    return (data as DbTrade[]) ?? []
  } catch (error) {
    console.error("[db] getRecentTradesFromDb threw:", error)
    return []
  }
}

export async function getTradesByBioguide(bioguideId: string): Promise<DbTrade[]> {
  const db = await getDb()
  if (!db) return []
  const pageSize = 1000
  const all: DbTrade[] = []
  try {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from("trades")
        .select("*")
        .eq("bioguide_id", bioguideId)
        .range(from, from + pageSize - 1)
      if (error) {
        console.error(`[db] getTradesByBioguide(${bioguideId}):`, error.message)
        break
      }
      const rows = (data as DbTrade[]) ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
  } catch (error) {
    console.error(`[db] getTradesByBioguide(${bioguideId}) threw:`, error)
  }
  return all
}

export async function deleteAllTrades(): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const { error } = await db.from("trades").delete().neq("trade_id", "")
    if (error) console.error("[db] deleteAllTrades:", error.message)
  } catch (error) {
    console.error("[db] deleteAllTrades threw:", error)
  }
}

export async function upsertTrades(rows: DbTrade[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  if (!db) return
  const deduped = [...new Map(rows.map((r) => [r.trade_id, r])).values()]
  try {
    // Chunk so a large live feed stays under the request payload limit.
    for (const batch of chunk(deduped, 500)) {
      const { error } = await db.from("trades").upsert(batch, { onConflict: "trade_id" })
      if (error) {
        console.error("[db] upsertTrades:", error.message)
        return
      }
    }
  } catch (error) {
    console.error("[db] upsertTrades threw:", error)
  }
}

export async function getPortfoliosFromDb(): Promise<DbPortfolio[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const { data, error } = await db.from("portfolio_data").select("*")
    if (error) {
      console.error("[db] getPortfoliosFromDb:", error.message)
      return []
    }
    return (data as DbPortfolio[]) ?? []
  } catch (error) {
    console.error("[db] getPortfoliosFromDb threw:", error)
    return []
  }
}

export async function upsertPortfolios(rows: DbPortfolio[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  if (!db) return
  const stamped = rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() }))
  try {
    const { error } = await db
      .from("portfolio_data")
      .upsert(stamped, { onConflict: "bioguide_id" })
    if (error) console.error("[db] upsertPortfolios:", error.message)
  } catch (error) {
    console.error("[db] upsertPortfolios threw:", error)
  }
}

export async function getAllTrades(): Promise<DbTrade[]> {
  const db = await getDb()
  if (!db) return []
  const pageSize = 1000
  const all: DbTrade[] = []
  try {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from("trades")
        .select("*")
        .range(from, from + pageSize - 1)
      if (error) {
        console.error("[db] getAllTrades:", error.message)
        break
      }
      const rows = (data as DbTrade[]) ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
  } catch (error) {
    console.error("[db] getAllTrades threw:", error)
  }
  return all
}

export async function getHoldingsFromDb(): Promise<DbHolding[]> {
  const db = await getDb()
  if (!db) return []
  const pageSize = 1000
  const all: DbHolding[] = []
  try {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from("portfolio_holdings")
        .select("*")
        .range(from, from + pageSize - 1)
      if (error) {
        console.error("[db] getHoldingsFromDb:", error.message)
        break
      }
      const rows = (data as DbHolding[]) ?? []
      all.push(...rows)
      if (rows.length < pageSize) break
    }
  } catch (error) {
    console.error("[db] getHoldingsFromDb threw:", error)
  }
  return all
}
export async function getHoldingsByTicker(ticker: string): Promise<DbHolding[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const { data, error } = await db
      .from("portfolio_holdings")
      .select("*")
      .eq("ticker", ticker)
    if (error) {
      console.error(`[db] getHoldingsByTicker(${ticker}):`, error.message)
      return []
    }
    return (data as DbHolding[]) ?? []
  } catch (error) {
    console.error(`[db] getHoldingsByTicker(${ticker}) threw:`, error)
    return []
  }
}

export async function replaceHoldingsForMembers(
  memberIds: string[],
  rows: DbHolding[]
): Promise<void> {
  if (memberIds.length === 0) return
  const db = await getDb()
  if (!db) return
  const stamped = [
    ...new Map(rows.map((r) => [`${r.bioguide_id}|${r.ticker}`, r])).values(),
  ].map((r) => ({ ...r, fetched_at: new Date().toISOString() }))
  try {
    for (const idBatch of chunk(memberIds, 200)) {
      const { error } = await db
        .from("portfolio_holdings")
        .delete()
        .in("bioguide_id", idBatch)
      if (error) {
        console.error("[db] replaceHoldingsForMembers delete:", error.message)
        return
      }
    }
    for (const batch of chunk(stamped, 500)) {
      const { error } = await db.from("portfolio_holdings").insert(batch)
      if (error) {
        console.error("[db] replaceHoldingsForMembers insert:", error.message)
        return
      }
    }
  } catch (error) {
    console.error("[db] replaceHoldingsForMembers threw:", error)
  }
}

export async function getFecCandidateFromDb(
  bioguideId: string
): Promise<DbFecCandidate | null> {
  const db = await getDb()
  if (!db) return null
  try {
    const { data, error } = await db
      .from("fec_candidates")
      .select("*")
      .eq("bioguide_id", bioguideId)
    if (error) {
      console.error(`[db] getFecCandidateFromDb(${bioguideId}):`, error.message)
      return null
    }
    return (data as DbFecCandidate[])?.[0] ?? null
  } catch (error) {
    console.error(`[db] getFecCandidateFromDb(${bioguideId}) threw:`, error)
    return null
  }
}

export async function upsertFecCandidate(row: DbFecCandidate): Promise<void> {
  const db = await getDb()
  if (!db) return
  const stamped = { ...row, fetched_at: new Date().toISOString() }
  try {
    const { error } = await db
      .from("fec_candidates")
      .upsert(stamped, { onConflict: "bioguide_id" })
    if (error) console.error("[db] upsertFecCandidate:", error.message)
  } catch (error) {
    console.error("[db] upsertFecCandidate threw:", error)
  }
}

export async function getPacDonationsFromDb(
  bioguideId: string
): Promise<DbPacDonation[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const { data, error } = await db
      .from("pac_donations")
      .select("*")
      .eq("bioguide_id", bioguideId)
    if (error) {
      console.error(`[db] getPacDonationsFromDb(${bioguideId}):`, error.message)
      return []
    }
    return (data as DbPacDonation[]) ?? []
  } catch (error) {
    console.error(`[db] getPacDonationsFromDb(${bioguideId}) threw:`, error)
    return []
  }
}

export async function replacePacDonations(
  bioguideId: string,
  rows: DbPacDonation[]
): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const { error: delError } = await db
      .from("pac_donations")
      .delete()
      .eq("bioguide_id", bioguideId)
    if (delError) {
      console.error(`[db] replacePacDonations delete(${bioguideId}):`, delError.message)
      return
    }
    if (rows.length === 0) return
    const { error: insError } = await db.from("pac_donations").insert(rows)
    if (insError) {
      console.error(`[db] replacePacDonations insert(${bioguideId}):`, insError.message)
    }
  } catch (error) {
    console.error(`[db] replacePacDonations(${bioguideId}) threw:`, error)
  }
}
