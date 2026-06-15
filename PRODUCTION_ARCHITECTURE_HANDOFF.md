# Production Architecture Handoff — CongressMoneyMan

## Project Overview

**CongressMoneyMan** is a Next.js 16 (App Router, React 19, TypeScript, Tailwind v4) application that aggregates U.S. congressional financial data from three external APIs:

- **Congress.gov API** — member biographical data and chamber membership
- **Quiver Quant API** (`quiverquant.com`) — stock trade disclosures and live net-worth/portfolio data
- **OpenFEC API** — campaign finance, PAC donations, and candidate totals

The app has these user-facing routes: a home page with an interactive Mapbox district map, `/House` and `/Senate` rankings tables (members sorted by net worth and stock holdings), `/Trades` (live congressional stock trades), and `/member/[id]` + `/senator/[id]` detail profiles.

**Do not read any `.env` or `.env.local` files.** Reference environment variables only as `process.env.VARIABLE_NAME` in code.

---

## What Has Already Been Implemented

A prior pass addressed all critical and high-severity code-level bottlenecks. Do not redo these — they are complete:

- **`lib/congress.ts`** — Shared Congress.gov member fetching with parallel pagination (pages 2+3 fetched simultaneously). All 4 routes that needed member lists now import `fetchHouseMembers` / `fetchSenateMembers` from here instead of calling each other over HTTP.
- **`lib/quiver.ts`** — `fetchAllCongressTrades` with `next: { revalidate: 900 }`. The three routes that need trades share one cached Quiver response per 15-minute window.
- **`lib/fec.ts`** — `fetchPacDonations` (single pagination pass, returns both `topDonors` and `allDonations`), `fetchFecTotals` (cached 1 hour), `computeTopIndustries`. Eliminated the prior double-pagination bug where two functions independently paginated the same FEC endpoint.
- **Rankings ISR** — `export const revalidate = 3600` on `house-rankings` and `senate-rankings` route handlers. The 435-request Quiver fan-out now only runs once per hour.
- **Member/senator routes** — Parallelized independent fetches, fixed sequential FEC calls, moved to shared libs above.
- **Map fix** — `selected` district state moved from GeoJSON properties into Mapbox `featureState`, so the 435-feature re-map no longer fires on every district click.
- **`next.config.ts`** — `compress: true`, GeoJSON cache headers (1 day browser / 7 day CDN).
- **`loading.tsx`** — Skeleton pulse screens for `/member/[id]` and `/senator/[id]`.

---

## What Needs to Be Implemented — Production Architecture

The following architectural gaps remain. They cannot be solved with code-level fixes alone — they require new infrastructure services. Implement them in roughly priority order.

---

### 1. Redis / KV Cache Layer (Highest Priority)

**Problem:** Even with ISR, the first request after cache expiry triggers the full Quiver fan-out (435 HTTP requests, 7–30 seconds). ISR only helps if Vercel's CDN serves the cached edge response — on cold starts or cache misses, every user on that shard waits. A persistent KV store decouples the computation from the request entirely.

**What to build:**
- Wrap all external API calls (Congress.gov, Quiver, FEC) behind a Redis cache layer
- Cache keys: `house-members`, `senate-members`, `house-rankings`, `senate-rankings`, `congress-trades`, `member:{bioguideId}`, `senator:{bioguideId}`, `fec-totals:{candidateId}`, `fec-pac:{committeeId}:{cycle}`
- TTLs: rankings = 2 hours, trades = 15 minutes, member profiles = 1 hour, FEC totals = 6 hours, member lists = 1 hour

**Recommended service:** [Upstash Redis](https://upstash.com/) — serverless-native, HTTP-based (works in Next.js route handlers and Edge Runtime), generous free tier, `@upstash/redis` npm package.

**Integration points in this codebase:**
- Add a `lib/cache.ts` module: `getCache<T>(key)` and `setCache<T>(key, value, ttlSeconds)` wrapping `@upstash/redis`
- Import and wrap the fetch calls in `lib/congress.ts`, `lib/quiver.ts`, `lib/fec.ts` — check cache first, fall through to API on miss, write result to cache
- The ranking fan-out in `app/api/house-rankings/route.ts` and `app/api/senate-rankings/route.ts` should read from `house-rankings` / `senate-rankings` cache keys set by the background job (see item 2 below)

**Env vars to add (reference only, do not read .env):** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

---

### 2. Background Job for Rankings Pre-computation (Highest Priority, paired with #1)

**Problem:** The rankings computation (435 × Quiver requests) must never run at user request time. It needs to run on a schedule, store the result in Redis, and API routes just read from the cache.

**What to build:**
- A background job that: (a) fetches all House members via `lib/congress.ts`, (b) runs the Quiver fan-out with `mapWithConcurrency`, (c) sorts the results, (d) writes the full rankings JSON to `house-rankings` and `senate-rankings` cache keys in Redis with a 2-hour TTL
- Same job for Senate rankings
- The job should run every 90 minutes so the cache never expires between runs
- Update `app/api/house-rankings/route.ts` and `app/api/senate-rankings/route.ts` to: read from Redis cache → if hit, return JSON; if miss, trigger computation inline as fallback (current behavior), then populate the cache

**Vercel Cron approach (simplest):**
- Create `app/api/cron/refresh-rankings/route.ts` that runs the fan-out and writes to Redis
- Add `vercel.json` with cron config:
  ```json
  {
    "crons": [{ "path": "/api/cron/refresh-rankings", "schedule": "0 */2 * * *" }]
  }
  ```
- Protect the route with a `CRON_SECRET` header check against `process.env.CRON_SECRET`

**Alternative:** [Trigger.dev](https://trigger.dev/) or [Inngest](https://www.inngest.com/) for the job runner — both integrate natively with Next.js, support cron scheduling, retry logic, and observability dashboards.

---

### 3. PostgreSQL Database for Persisted Congressional Data

**Problem:** All member profile data (Congress.gov + FEC + Quiver trades) is fetched at request time on every visit. FEC donation data takes 15 sequential HTTP pages to collect. A database makes member profile loads go from ~5–10 seconds to ~50ms.

**What to store:**

| Table | Key Columns |
|---|---|
| `members` | `bioguide_id`, `name`, `party`, `state`, `district`, `chamber`, `last_updated` |
| `trades` | `bioguide_id`, `ticker`, `transaction_type`, `transaction_date`, `amount`, `filed_at` — indexed on `bioguide_id` |
| `portfolio_data` | `bioguide_id`, `net_worth`, `stock_holdings`, `fetched_at` |
| `fec_candidates` | `bioguide_id`, `candidate_id`, `committee_ids[]`, `total_raised`, `total_spent`, `cycle`, `fetched_at` |
| `pac_donations` | `bioguide_id`, `pac_name`, `amount`, `cycle` |

**Recommended service:** [Supabase](https://supabase.com/) (managed Postgres + Prisma-compatible, free tier) or [Neon](https://neon.tech/) (serverless Postgres with connection pooling via PgBouncer, autoscaling, free tier).

**ORM:** Prisma — add `prisma/schema.prisma`, run `prisma generate`, use `@prisma/client` in route handlers.

**Integration pattern:**
- Background ETL job (item 4 below) populates all tables on a schedule
- `app/api/member/[id]/route.ts` and `app/api/senator/[id]/route.ts` query Postgres directly instead of hitting external APIs
- Cold path fallback: if no DB record exists, fall back to the current external API flow and cache the result

**Env vars to add:** `DATABASE_URL`

---

### 4. ETL Ingestion Pipeline (pairs with #3)

**Problem:** The three external APIs have different update frequencies. Running ad-hoc per-request fetches means stale or inconsistent data. A scheduled ETL writes clean, normalized data to Postgres on each API's natural cadence.

**Jobs to build:**

| Job | Source | Schedule | Writes to |
|---|---|---|---|
| `sync-members` | Congress.gov `/v3/member` | Daily | `members` table |
| `sync-trades` | Quiver `/beta/live/congresstrading` | Every 15 min | `trades` table |
| `sync-portfolios` | Quiver `/get_politician_page_tab_data/:id` (one per member) | Every 2 hours | `portfolio_data` table |
| `sync-fec-candidates` | FEC `/v1/candidates/search/` | Daily | `fec_candidates` table |
| `sync-fec-donations` | FEC `/v1/schedules/schedule_a/` | Daily | `pac_donations` table |

**Implementation:** Trigger.dev or Inngest tasks, each with retry logic and exponential backoff. The `sync-portfolios` job is the most expensive (one Quiver request per member — ~435 for House); use the `mapWithConcurrency` pattern already established in `app/api/house-rankings/route.ts` but write results to Postgres rather than returning them at request time.

---

### 5. Edge Runtime for Read-Heavy Routes

**Problem:** After Redis is in place, `house-rankings`, `senate-rankings`, and `liveTrades` routes will be pure Redis reads (~5ms). These should run on the Edge (Vercel Edge Runtime / Cloudflare Workers) — ~10ms cold start vs ~300ms for Node.js serverless — and execute geographically close to each user.

**What to add** to these three route files:
```typescript
export const runtime = 'edge'
```

**Caveat:** Edge Runtime does not support Node.js APIs (`fs`, `Buffer`, `crypto`, TCP sockets). Routes must use only Web APIs and `@upstash/redis` (which uses HTTP, not TCP). Ensure `lib/cache.ts` uses the `@upstash/redis` HTTP client, not `ioredis`.

---

### 6. Vector Tiles for the Congressional District Map

**Problem:** `public/geo/cd119.geojson` (congressional district boundaries for 435 districts) is a large file downloaded in full by every home page visitor before the map renders. Congressional GeoJSON files typically range from 5–30MB.

**What to build:**
- Install `tippecanoe` (CLI) and convert the GeoJSON to PMTiles format:
  ```bash
  tippecanoe -o public/geo/cd119.pmtiles -z8 -Z2 --simplification=4 public/geo/cd119.geojson
  ```
- Host the `.pmtiles` file on Cloudflare R2 or AWS S3 + CloudFront
- In `app/components/congressionalMap.tsx`, replace the GeoJSON `fetch` + `<Source type="geojson">` pattern with a PMTiles source using the `pmtiles` protocol adapter for Mapbox GL JS:
  ```typescript
  import { Protocol } from 'pmtiles'
  // register protocol once in useEffect, then pass pmtiles://... URL as source
  ```
- PMTiles serves only the tiles visible at the current zoom level — reduces initial load from megabytes to kilobytes at country zoom

**Alternative (simpler):** Run `mapshaper` to simplify polygon complexity by 60–80%, serve the smaller GeoJSON via CDN with Brotli encoding. Less impactful than PMTiles but zero browser-side code changes.

**Package:** `pmtiles` (npm)

---

### 7. Streaming SSR with Suspense for Member Profile Pages

**Problem:** `app/member/[id]/page.tsx` and `app/senator/[id]/page.tsx` call their own API route over HTTP (`fetch(\`${protocol}://${host}/api/member/${id}\`)`) and block all rendering until every data source resolves. The member header (fast, ~100ms from Congress.gov) and the PAC/trade data (slow, up to 10 seconds from FEC) are coupled into a single blocking fetch.

**What to build:**
- Split each profile page into composable async server components, one per data section, each importing directly from `lib/` (no HTTP self-call)
- Wrap each section in a `<Suspense>` boundary with a card skeleton fallback
- Example structure for `app/member/[id]/page.tsx`:
  ```tsx
  import { Suspense } from 'react'

  export default async function MemberPage({ params }) {
    const { id } = await params
    return (
      <div style={{ padding: '2rem' }}>
        <Suspense fallback={<HeaderSkeleton />}>
          <MemberHeaderSection id={id} />     {/* Congress.gov only — ~100ms */}
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <TopIndustriesSection id={id} />    {/* FEC — streams in when ready */}
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <PacDonationsSection id={id} />     {/* FEC — streams in when ready */}
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <TradesSection id={id} />           {/* Quiver — streams in when ready */}
        </Suspense>
      </div>
    )
  }
  ```
- Each `*Section` component is an `async` server component that imports from `lib/` and fetches its own data
- This removes the intra-server HTTP loopback entirely and lets the browser progressively render as data arrives

---

### 8. Rate-Limit-Aware Quiver Client with Circuit Breaker

**Problem:** The rankings fan-out fires 435+ requests to `quiverquant.com` (an unofficial web scraping endpoint, not a documented API). At this scale without backoff, rate-limiting is near-certain. Currently, failed requests silently return `null`, producing corrupted rankings tables with no signal to operators.

**What to build in `lib/quiver.ts`:**
- Exponential backoff with jitter on 429 and 5xx responses — retry up to 3 times with delays of 500ms, 1500ms, 4500ms + random jitter
- Circuit breaker: track consecutive failures in Redis (key: `quiver:circuit-breaker`); if > 10 failures in 60 seconds, stop sending requests and return stale cached data instead
- Structured error logging on rate-limit events so failures surface in Vercel logs / your observability stack

---

## Key Files Reference

| File | Purpose |
|---|---|
| `lib/congress.ts` | Congress.gov member fetching, parallel pagination, `getStateCode` |
| `lib/quiver.ts` | `fetchAllCongressTrades`, `formatTradeRange` |
| `lib/fec.ts` | `fetchPacDonations` (single-pass), `fetchFecTotals`, `computeTopIndustries` |
| `app/api/house-rankings/route.ts` | 435-request Quiver fan-out, ISR `revalidate=3600` |
| `app/api/senate-rankings/route.ts` | Same as above for Senate |
| `app/api/member/[id]/route.ts` | Member profile data aggregation |
| `app/api/senator/[id]/route.ts` | Senator profile data aggregation |
| `app/api/member/[id]/industryClassifier.ts` | Keyword-based PAC industry classification (32 industries) |
| `app/components/congressionalMap.tsx` | Mapbox GL map, district selection via Mapbox feature state |
| `app/components/houseMembersRankingsNetWorth.tsx` | Client component — renders rankings tables |
| `app/components/liveTrades.tsx` | Client component — renders trades table |
| `types/member.ts` | Canonical `Member`, `Trade`, `PacDonation`, `Industry` types |
| `next.config.ts` | `compress: true`, GeoJSON cache headers |
| `app/member/[id]/loading.tsx` | Skeleton shown while member page server component fetches |
| `app/senator/[id]/loading.tsx` | Skeleton shown while senator page server component fetches |

---

## Recommended Implementation Order

| Priority | Item | Unblocks |
|---|---|---|
| 1 | Upstash Redis + `lib/cache.ts` | Everything else |
| 2 | Rankings background job (Vercel Cron) | Eliminates 7–30s cold path |
| 3 | Postgres (Supabase/Neon) + Prisma schema | Fast member profiles |
| 4 | ETL ingestion jobs (Trigger.dev/Inngest) | Populates Postgres on schedule |
| 5 | Edge runtime on rankings + trades routes | After Redis is wired |
| 6 | Streaming SSR on member/senator pages | After Postgres is ready |
| 7 | PMTiles for district map | Independent — can be done any time |
| 8 | Quiver circuit breaker | Add alongside or after background job |
