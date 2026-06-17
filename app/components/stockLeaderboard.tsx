"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

type HoldingsRow = {
  ticker: string
  name: string
  totalValue: number
  sector: string
}

type PerformanceRow = {
  ticker: string
  name: string
  sector: string
  gainPct: number
  estGain: number
  boughtValue: number
  memberCount: number
  houseCount: number
  senateCount: number
}

type LeaderboardResponse = {
  holdings: HoldingsRow[]
  performance: PerformanceRow[]
  error?: string
}

type TickerHolder = {
  bioguideId: string
  name: string
  party: string
  chamber: "house" | "senate"
  value: number
}

type TickerHolders = {
  ticker: string
  totalValue: number
  houseCount: number
  senateCount: number
  holders: TickerHolder[]
}

type ChartRange = "24H" | "1W" | "1M" | "6M" | "1Y" | "5Y"
type ChartPoint = { t: number; c: number }

const RANGES: ChartRange[] = ["24H", "1W", "1M", "6M", "1Y", "5Y"]

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
const monthYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" })

function formatCurrency(value: number) {
  return currencyFormatter.format(value)
}

function formatPct(value: number) {
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

const SLICE_COLORS = [
  "#2563eb",
  "#0891b2",
  "#7c3aed",
  "#db2777",
  "#f59e0b",
  "#16a34a",
  "#ea580c",
  "#0ea5e9",
  "#9333ea",
  "#475569",
]

function partyColor(party: string): string {
  const p = party.toUpperCase()
  if (p.startsWith("D")) return "#2563eb"
  if (p.startsWith("R")) return "#dc2626"
  return "#7c3aed"
}

function partyLabel(party: string): string {
  const p = party.toUpperCase()
  if (p.startsWith("D")) return "Democrat"
  if (p.startsWith("R")) return "Republican"
  return "Independent"
}

function memberHref(holder: TickerHolder): string {
  return holder.chamber === "senate"
    ? `/senator/${holder.bioguideId}`
    : `/member/${holder.bioguideId}`
}

function tickFormatter(t: number, range: ChartRange): string {
  if (range === "24H") return timeFmt.format(t)
  if (range === "5Y") return monthYearFmt.format(t)
  return dayFmt.format(t)
}

function PerformanceChart({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<ChartRange>("1M")
  const [loaded, setLoaded] = useState<{ key: string; points: ChartPoint[] } | null>(null)
  const key = `${ticker}|${range}`

  useEffect(() => {
    let ignore = false
    fetch(`/api/stock-chart/${encodeURIComponent(ticker)}?range=${range}`, {
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((payload: { points?: ChartPoint[] }) => {
        if (!ignore) setLoaded({ key, points: payload.points ?? [] })
      })
      .catch(() => {
        if (!ignore) setLoaded({ key, points: [] })
      })
    return () => {
      ignore = true
    }
  }, [ticker, range, key])

  const loading = loaded?.key !== key
  const series = loaded?.key === key ? loaded.points : []
  const first = series[0]?.c ?? null
  const last = series[series.length - 1]?.c ?? null
  const change = first != null && last != null ? last - first : null
  const changePct = first ? ((last! - first) / first) * 100 : null
  const up = (change ?? 0) >= 0
  const color = up ? "#16a34a" : "#dc2626"

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Price Performance
          </h3>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900">
              {last != null ? priceFormatter.format(last) : "—"}
            </span>
            {change != null && changePct != null ? (
              <span className="text-sm font-semibold" style={{ color }}>
                {up ? "▲" : "▼"} {priceFormatter.format(Math.abs(change))} (
                {formatPct(changePct)})
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-4 min-h-[16rem] flex-1">
        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">
            Loading chart…
          </div>
        ) : series.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">
            No price data available for this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={256}>
            <AreaChart
              data={series}
              margin={{ top: 5, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id={`grad-${ticker}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 11 }}
                minTickGap={48}
                stroke="#9ca3af"
                tickFormatter={(t: number) => tickFormatter(t, range)}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fontSize: 11 }}
                width={60}
                stroke="#9ca3af"
                tickFormatter={(v: number) => priceFormatter.format(v)}
              />
              <Tooltip
                formatter={(v) => priceFormatter.format(Number(v))}
                labelFormatter={(t) => tickFormatter(Number(t), range)}
              />
              <Area
                type="monotone"
                dataKey="c"
                name="Price"
                stroke={color}
                strokeWidth={2}
                fill={`url(#grad-${ticker})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              r === range
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  )
}

function HolderTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: TickerHolder }>
}) {
  const holder = payload?.[0]?.payload
  if (!active || !holder) return null
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="font-semibold text-slate-900">{holder.name}</p>
      <p className="font-medium" style={{ color: partyColor(holder.party) }}>
        {partyLabel(holder.party)} · {holder.chamber === "senate" ? "Senate" : "House"}
      </p>
      <p className="mt-1 font-semibold text-slate-700">{formatCurrency(holder.value)}</p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
        Click slice to open profile →
      </p>
    </div>
  )
}

function OwnershipPanel({ data }: { data: TickerHolders }) {
  const router = useRouter()
  const { holders, totalValue } = data
  const chartData = holders.map((h, i) => ({
    ...h,
    fill: SLICE_COLORS[i % SLICE_COLORS.length],
  }))

  const top3 = holders.slice(0, 3)
  const medals = ["#f59e0b", "#94a3b8", "#b45309"]

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Congressional Ownership
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          {holders.length} member{holders.length === 1 ? "" : "s"} ·{" "}
          {data.houseCount} House · {data.senateCount} Senate
        </p>
      </div>

      {holders.length === 0 ? (
        <p className="text-sm text-slate-400">No disclosed holders found.</p>
      ) : (
        <>
          <div className="relative mx-auto h-52 w-52 shrink-0">
            <ResponsiveContainer width={208} height={208}>
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="100%"
                  paddingAngle={1.5}
                  stroke="none"
                  className="cursor-pointer focus:outline-none"
                  onClick={(slice) => {
                    const entry = slice as unknown as {
                      payload?: TickerHolder
                    } & Partial<TickerHolder>
                    const holder = entry.payload ?? entry
                    if (holder.bioguideId) router.push(memberHref(holder as TickerHolder))
                  }}
                />
                <Tooltip content={<HolderTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                Total Held
              </span>
              <span className="text-xl font-bold text-slate-900">
                {formatCurrency(totalValue)}
              </span>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Top Holders
            </p>
            <ul className="space-y-2">
              {top3.map((h, i) => (
                <li key={h.bioguideId}>
                  <Link
                    href={memberHref(h)}
                    className="group flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-100 transition hover:bg-blue-50 hover:ring-blue-200"
                  >
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: medals[i] }}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-900 group-hover:text-blue-700">
                        {h.name}
                      </span>
                      <span
                        className="text-xs font-medium"
                        style={{ color: partyColor(h.party) }}
                      >
                        {partyLabel(h.party)} · {h.chamber === "senate" ? "Senate" : "House"}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-semibold text-slate-900">
                        {formatCurrency(h.value)}
                      </span>
                      <span className="text-xs text-slate-400">
                        {totalValue > 0 ? `${((h.value / totalValue) * 100).toFixed(1)}%` : ""}
                      </span>
                    </span>
                    <span className="ml-1 text-slate-300 transition group-hover:text-blue-500">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function StockModal({
  row,
  onClose,
}: {
  row: HoldingsRow
  onClose: () => void
}) {
  const [holders, setHolders] = useState<TickerHolders | null>(null)
  const loading = !holders || holders.ticker !== row.ticker

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    let ignore = false
    fetch(`/api/stock-leaderboard/${encodeURIComponent(row.ticker)}`, {
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((payload: TickerHolders) => {
        if (!ignore) setHolders(payload)
      })
      .catch(() => {
        if (!ignore) {
          setHolders({
            ticker: row.ticker,
            totalValue: 0,
            houseCount: 0,
            senateCount: 0,
            holders: [],
          })
        }
      })
    return () => {
      ignore = true
    }
  }, [row.ticker])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative bg-gradient-to-br from-indigo-600 via-blue-600 to-cyan-500 px-6 py-6 text-white">
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-lg font-medium text-white transition hover:bg-white/30"
            aria-label="Close"
          >
            ×
          </button>
          <div className="flex flex-wrap items-end justify-between gap-3 pr-10">
            <div>
              <h2 className="text-3xl font-bold tracking-tight">{row.ticker}</h2>
              <p className="mt-0.5 max-w-md truncate text-sm text-white/80">{row.name}</p>
              <span className="mt-2 inline-block rounded-full bg-white/20 px-3 py-0.5 text-xs font-semibold">
                {row.sector}
              </span>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-white/70">
                Total Value Owned
              </p>
              <p className="text-2xl font-bold">{formatCurrency(row.totalValue)}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 p-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-100 bg-white p-5">
            {loading || !holders ? (
              <div className="flex h-72 items-center justify-center text-sm text-slate-400">
                Loading ownership…
              </div>
            ) : (
              <OwnershipPanel data={holders} />
            )}
          </div>

          <div className="rounded-2xl border border-slate-100 bg-white p-5">
            <PerformanceChart ticker={row.ticker} />
          </div>
        </div>
      </div>
    </div>
  )
}

function HoldingsTable({
  rows,
  onSelect,
}: {
  rows: HoldingsRow[]
  onSelect: (row: HoldingsRow) => void
}) {
  const [sector, setSector] = useState<string>("All")

  const sectors = useMemo(
    () => ["All", ...[...new Set(rows.map((r) => r.sector))].sort()],
    [rows]
  )

  const filtered = useMemo(
    () => (sector === "All" ? rows : rows.filter((r) => r.sector === sector)),
    [rows, sector]
  )

  return (
    <section className="dashboard-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-6 py-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            Most-Held Stocks by Portfolio Value
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Estimated live portfolio value owned across all members. Click any stock for a
            full ownership and price breakdown.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span className="font-medium">Sector</span>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s === "All" ? "All sectors" : s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="max-h-[40rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-[0.18em] text-slate-200">
            <tr>
              <th className="px-4 py-3 font-medium">Rank</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Categorization</th>
              <th className="px-4 py-3 text-right font-medium">Value Owned</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, index) => (
              <tr
                key={row.ticker}
                onClick={() => onSelect(row)}
                className="cursor-pointer border-b border-slate-200 text-sm text-slate-700 odd:bg-slate-50/70 hover:bg-blue-50"
              >
                <td className="px-4 py-3 font-medium text-slate-500">{index + 1}</td>
                <td className="px-4 py-3">
                  <span className="font-semibold text-gray-900">{row.ticker}</span>
                  <span className="ml-2 hidden text-xs text-slate-500 sm:inline">
                    {row.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-600">{row.sector}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">
                  {formatCurrency(row.totalValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

type PerfMetric = "gainPct" | "estGain"
type PerfView = "gainers" | "losers"

const VIEW_OPTIONS: ReadonlyArray<readonly [PerfView, string]> = [
  ["gainers", "Top Gainers"],
  ["losers", "Biggest Losers"],
]

function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<readonly [T, string]>
  onChange: (next: T) => void
}) {
  return (
    <div className="inline-flex rounded-full bg-slate-100 p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            value === key ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

type SortDir = "asc" | "desc"
function SortHeader({
  label,
  column,
  metric,
  direction,
  onSort,
}: {
  label: string
  column: PerfMetric
  metric: PerfMetric
  direction: SortDir
  onSort: (column: PerfMetric) => void
}) {
  const active = metric === column
  return (
    <th className="px-4 py-3 text-right font-medium">
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`Sort by ${label}`}
        className="inline-flex items-center gap-1 uppercase tracking-[0.18em] transition hover:text-white"
      >
        {label}
        <span className={`text-[10px] ${active ? "text-white" : "text-slate-500"}`}>
          {active ? (direction === "desc" ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  )
}

function PerformanceTable({
  rows,
  holdingsByTicker,
  onSelect,
}: {
  rows: PerformanceRow[]
  holdingsByTicker: Map<string, HoldingsRow>
  onSelect: (row: HoldingsRow) => void
}) {
  const [metric, setMetric] = useState<PerfMetric>("gainPct")
  const [direction, setDirection] = useState<SortDir>("desc")
  const [view, setView] = useState<PerfView>("gainers")
  const sorted = useMemo(() => {
    const sign = direction === "desc" ? -1 : 1
    return rows
      .filter((r) => (view === "gainers" ? r.gainPct > 0 : r.gainPct < 0))
      .sort((a, b) => sign * (a[metric] - b[metric]))
  }, [rows, metric, direction, view])

  const handleSort = (column: PerfMetric) => {
    if (column === metric) {
      setDirection((d) => (d === "desc" ? "asc" : "desc"))
    } else {
      setMetric(column)
      setDirection("desc")
    }
  }
  const selectView = (next: PerfView) => {
    setView(next)
    setDirection(next === "gainers" ? "desc" : "asc")
  }
  const toModalRow = (row: PerformanceRow): HoldingsRow =>
    holdingsByTicker.get(row.ticker) ?? {
      ticker: row.ticker,
      name: row.name,
      totalValue: 0,
      sector: row.sector,
    }

  return (
    <section className="dashboard-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-6 py-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            {view === "gainers" ? "Best" : "Worst"}-Performing Stocks by Congressional Gain
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Estimated gain from disclosed purchase price to today, weighted by disclosed
            amount, ranked.
          </p>
        </div>
        <SegmentedToggle value={view} options={VIEW_OPTIONS} onChange={selectView} />
      </div>

      <div className="max-h-[34rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-[0.18em] text-slate-200">
            <tr>
              <th className="px-4 py-3 font-medium">Rank</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Categorization</th>
              <SortHeader
                label="Est. Gain"
                column="estGain"
                metric={metric}
                direction={direction}
                onSort={handleSort}
              />
              <SortHeader
                label="Gain %"
                column="gainPct"
                metric={metric}
                direction={direction}
                onSort={handleSort}
              />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-sm text-slate-400"
                >
                  {view === "gainers"
                    ? "No traded stocks are showing a gain right now."
                    : "No traded stocks are showing a loss right now."}
                </td>
              </tr>
            ) : (
              sorted.map((row, index) => (
              <tr
                key={row.ticker}
                onClick={() => onSelect(toModalRow(row))}
                className="cursor-pointer border-b border-slate-200 text-sm text-slate-700 odd:bg-slate-50/70 hover:bg-blue-50"
              >
                <td className="px-4 py-3 font-medium text-slate-500">{index + 1}</td>
                <td className="px-4 py-3">
                  <span className="font-semibold text-gray-900">{row.ticker}</span>
                  <span className="ml-2 hidden text-xs text-slate-500 sm:inline">
                    {row.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-600">{row.sector}</td>
                <td
                  className={`px-4 py-3 text-right font-semibold ${
                    row.estGain >= 0 ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {formatCurrency(row.estGain)}
                </td>
                <td
                  className={`px-4 py-3 text-right font-semibold ${
                    row.gainPct >= 0 ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {formatPct(row.gainPct)}
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function StockLeaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<HoldingsRow | null>(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      try {
        const response = await fetch("/api/stock-leaderboard", { cache: "no-store" })
        const payload = (await response.json()) as LeaderboardResponse
        if (!response.ok) throw new Error(payload.error ?? "Failed to load stock leaderboard")
        if (!ignore) {
          setData(payload)
          setError(null)
        }
      } catch (loadError) {
        if (!ignore) {
          setError(
            loadError instanceof Error ? loadError.message : "Failed to load stock leaderboard"
          )
        }
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [])

  if (error) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-700">
        {error}
      </div>
    )
  }

  if (!data) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-sm text-slate-600 shadow-sm">
        Loading stock leaderboards...
      </div>
    )
  }

  const holdingsByTicker = new Map(data.holdings.map((h) => [h.ticker, h]))

  return (
    <div className="flex flex-col gap-6">
      {data.holdings.length === 0 ? (
        <div className="dashboard-card px-6 py-10 text-sm text-slate-600">
          Holdings data is still populating. Check back after the next refresh.
        </div>
      ) : (
        <HoldingsTable rows={data.holdings} onSelect={setSelected} />
      )}

      {data.performance.length === 0 ? (
        <div className="dashboard-card px-6 py-10 text-sm text-slate-600">
          Performance data is still populating. Check back after the next refresh.
        </div>
      ) : (
        <PerformanceTable
          rows={data.performance}
          holdingsByTicker={holdingsByTicker}
          onSelect={setSelected}
        />
      )}

      {selected ? (
        <StockModal row={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  )
}
