# CongressMoneyMan Python backend

The application backend (FastAPI). Ported from the former Next.js API routes
(`app/api/*`) and backend libraries (`lib/*.ts`), which have been removed —
serves the same URL paths and JSON shapes those did, against the same Redis
cache keys and Supabase tables. The Next.js app is now frontend-only and
proxies every `/api/*` request here.

## Layout

```
backend/
  app/
    main.py        FastAPI app — run this
    config.py      loads ../.env.local (shared with Next.js) + key helpers
    core/          infrastructure
      http.py        shared httpx client (OS trust store for TLS)
      cache.py       Upstash Redis REST cache        (was lib/cache.ts)
      db.py          Supabase PostgREST data access  (was lib/db.ts)
      util.py        date parsing, concurrency, memoization helpers
    clients/       external API clients
      congress.py    Congress.gov rosters            (was lib/congress.ts)
      quiver.py      Quiver trades + circuit breaker (was lib/quiver.ts)
      fec.py         OpenFEC totals/donations        (was lib/fec.ts)
      prices.py      Alpaca + FMP market data        (was lib/prices.ts)
      disclosures.py House Clerk + Senate eFD annual financial disclosures
    services/      domain logic
      rankings.py            (was lib/rankings.ts) + FD net-worth fallback
      disclosures.py         FD net-worth estimates keyed by bioguide id
      profile.py             (was lib/profile.ts)
      trades.py              (was lib/trades.ts)
      stock_leaderboard.py   (was lib/stockLeaderboard.ts)
      pac_donations.py       (was lib/pacDonations.ts)
      pac_profile.py         (was lib/pacProfile.ts)
      sync.py                (was lib/sync.ts)
      sector_map.py          (was lib/sectorMap.ts)
      industry_classifier.py (was app/api/member/[id]/industryClassifier.ts)
    routers/       HTTP endpoints, one module per API area
      members.py rankings.py trades.py profiles.py pacs.py stocks.py cron.py
  worker.py        background sync loop              (was scripts/worker.ts)
  requirements.txt
```

## Setup

```sh
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS/Linux
```

Environment variables are read from the repo root `.env.local` (same file the
Next.js app uses): `CONGRESS_API_KEY`, `QUIVER_API_KEY`, `FEC_API_KEY`,
`ALPACA_KEY`/`ALPACA_SECRET`, `FMP_API_KEY`, `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`,
and optionally `CRON_SECRET`. Everything degrades gracefully when a credential
is missing (empty data, not errors), matching the TS behavior.

## Run

```sh
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

Interactive API docs: http://127.0.0.1:8000/docs

### The Next.js frontend

Next.js proxies every `/api/*` request here (see `rewrites()` in
`next.config.ts`), and its server components fetch profile/trade data from
this server directly. `FASTAPI_URL` controls the target; it defaults to
`http://127.0.0.1:8000`, so for local development just run both:

```sh
# terminal 1
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000
# terminal 2
npm run dev
```

In production set `FASTAPI_URL` to the deployed backend URL.

### Background jobs

Either run the standalone worker (same cadence as `scripts/worker.ts`):

```sh
.venv/Scripts/python worker.py
```

or drive the cron endpoints from an external scheduler (they are guarded by
`Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set), matching the
schedules in `vercel.json`:

| endpoint | schedule |
|---|---|
| `/api/cron/refresh-rankings` | every 2 h |
| `/api/cron/refresh-stocks`   | hourly at :15 |
| `/api/cron/sync-trades`      | every 15 min |
| `/api/cron/backfill-trades`  | daily 05:30 |
| `/api/cron/sync-members`     | daily 06:00 |
| `/api/cron/sync-fec`         | daily 07:00 |
| `/api/cron/sync-disclosures` | weekly |

## Net-worth coverage: financial-disclosure fallback

Quiver only estimates net worth and stock holdings for members who **disclose
stock trades**, so members who don't trade individual stocks come back empty
(~45 House, ~8 Senate). To fill the net-worth column, `sync-disclosures`
downloads every member's **annual Financial Disclosure** — House from the Clerk
(`disclosures-clerk.house.gov`, public ZIP index + per-filing PDFs), Senate from
the eFD portal (`efdsearch.senate.gov`, agreement-gated HTML reports) — and sums
each filing's asset-value-range midpoints into a gross net-worth estimate
(OpenSecrets' methodology). Results are cached weekly and keyed by bioguide id.

`get_house_rankings` / `get_senate_rankings` fill any row Quiver left null from
this map. Quiver's live figure always wins where present. Filled rows carry
`netWorthSource: "fd"` and `netWorthAsOf` (the filing year) so the UI badges
them as annual-disclosure estimates; live rows carry `netWorthSource: "quiver"`.
Stock holdings are never filled this way — an FD lists coarse value ranges, not
the live per-ticker portfolio that column shows.

Known gaps (left null): members who filed only an extension rather than an
annual report, and the minority who submit scanned/image PDFs with no text layer
(would need OCR). Estimates are gross assets from an annual snapshot, so they run
higher and staler than Quiver's live mark-to-market figure — hence the badge.

## Endpoints

Same surface the Next.js API routes had:
`/api/house-members`, `/api/senate-members`, `/api/house-rankings`,
`/api/senate-rankings`, `/api/liveTrades`, `/api/member/{id}`,
`/api/senator/{id}`, `/api/pac-donations`, `/api/pac-donations/{pac}`,
`/api/pac-chart/{pac}`, `/api/pac-recipients-feed/{pac}`,
`/api/stock-leaderboard`, `/api/stock-leaderboard/{ticker}`,
`/api/stock-chart/{ticker}?range=`, `/api/cron/*`, plus `/api/health`.

Granular endpoints used by the profile/trade server pages (formerly direct
`lib/profile.ts` / `lib/trades.ts` imports), letting each page section stream
independently: `/api/member/{id}/base` · `fec-totals` · `fec-donations` ·
`trades` · `portfolio`, `/api/senator/{id}/base` · `fec-totals` ·
`fec-donations`, and `/api/trade/{id}`.
