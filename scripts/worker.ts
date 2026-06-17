import "./load-env"
import {
  syncMembers,
  syncTrades,
  backfillTrades,
  syncRankings,
  syncStockPerformance,
  syncFec,
} from "../lib/sync"

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
  { name: "trades-backfill", intervalMs: 24 * HOUR, run: backfillTrades },
  { name: "rankings", intervalMs: 60 * MINUTE, run: syncRankings },
  { name: "stock-performance", intervalMs: 24 * HOUR, run: syncStockPerformance },
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

  for (const job of jobs) {
    await runJob(job)
  }

  for (const job of jobs) {
    setInterval(() => void runJob(job), job.intervalMs)
  }

  console.log(
    "[worker] scheduled:",
    jobs.map((j) => `${j.name} every ${Math.round(j.intervalMs / MINUTE)}min`).join(", ")
  )
}

void main()
