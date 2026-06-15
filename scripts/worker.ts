// Background ETL worker.
//
//   npm run worker
//
// A long-running process that keeps Postgres fresh by polling the upstream APIs
// on a timer — no manual browsing or curling. Runs identically on a laptop and on
// any always-on host. Reuses the same sync routines as the /api/cron/* routes.
//
// Freshness is bounded by each job's interval (the upstream APIs don't push, so a
// change is only discovered on the next poll). Reads stay fast because the app
// serves from Postgres/Redis, not these fetches.

import "./load-env"
import { syncMembers, syncTrades, syncRankings, syncFec } from "../lib/sync"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

type Job = {
  name: string
  intervalMs: number
  run: () => Promise<unknown>
}

const jobs: Job[] = [
  { name: "members", intervalMs: 24 * HOUR, run: syncMembers },
  { name: "trades", intervalMs: 5 * MINUTE, run: syncTrades },
  { name: "rankings", intervalMs: 60 * MINUTE, run: syncRankings },
  { name: "fec", intervalMs: 24 * HOUR, run: syncFec },
]

const inProgress = new Set<string>()

async function runJob(job: Job): Promise<void> {
  if (inProgress.has(job.name)) {
    console.log(`[worker] ${job.name}: still running, skipping this tick`)
    return
  }
  inProgress.add(job.name)
  const startedAt = Date.now()
  try {
    const result = await job.run()
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[worker] ${job.name}: ok (${secs}s)`, result)
  } catch (error) {
    console.error(
      `[worker] ${job.name}: failed:`,
      error instanceof Error ? error.message : error
    )
  } finally {
    inProgress.delete(job.name)
  }
}

async function main(): Promise<void> {
  console.log("[worker] starting — seeding once, then polling on interval")

  // Initial seed, sequential and light -> heavy, so the DB fills on startup.
  for (const job of jobs) {
    await runJob(job)
  }

  // Recurring schedule.
  for (const job of jobs) {
    setInterval(() => void runJob(job), job.intervalMs)
  }

  console.log(
    "[worker] scheduled:",
    jobs.map((j) => `${j.name} every ${Math.round(j.intervalMs / MINUTE)}min`).join(", ")
  )
}

void main()
