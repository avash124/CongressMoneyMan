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

type PacDonationRow = {
  bioguideId: string
  memberName: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
  state: string
  pacName: string
  amount: number
}

type PacDonationsResponse = {
  donations: PacDonationRow[]
  error?: string
}

type PacRecipient = {
  bioguideId: string
  name: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
  amount: number
}

type PacRecipients = {
  pacName: string
  totalAmount: number
  houseCount: number
  senateCount: number
  recipients: PacRecipient[]
}

type SpendingPoint = { t: number; c: number }
type ChamberFilter = "all" | "house" | "senate"

type FeedMember = {
  bioguideId: string
  name: string
  party: "D" | "R" | "I"
  chamber: "house" | "senate"
}
type WindowContribution = { bioguideId: string; amount: number; date: number }
type PacContributionFeed = {
  committeeId: string | null
  members: FeedMember[]
  contributions: WindowContribution[]
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

const monthYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" })
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

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

function partyClasses(party: PacDonationRow["party"]) {
  if (party === "D") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
  if (party === "R") return "bg-red-50 text-red-700 ring-1 ring-red-200"
  return "bg-gray-100 text-gray-700 ring-1 ring-gray-200"
}

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

function memberHref(chamber: "house" | "senate", bioguideId: string): string {
  return chamber === "senate" ? `/senator/${bioguideId}` : `/member/${bioguideId}`
}

type Range = "6M" | "1Y" | "2Y" | "5Y" | "ALL"
const RANGES: Range[] = ["6M", "1Y", "2Y", "5Y", "ALL"]
const RANGE_DAYS: Record<Range, number> = {
  "6M": 183,
  "1Y": 365,
  "2Y": 730,
  "5Y": 1825,
  ALL: Infinity,
}

function PacSpendingChart({
  pacName,
  range,
  onRangeChange,
}: {
  pacName: string
  range: Range
  onRangeChange: (range: Range) => void
}) {
  const [points, setPoints] = useState<SpendingPoint[] | null>(null)

  useEffect(() => {
    let ignore = false
    setPoints(null)
    fetch(`/api/pac-chart/${encodeURIComponent(pacName)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: { points?: SpendingPoint[] }) => {
        if (!ignore) setPoints(payload.points ?? [])
      })
      .catch(() => {
        if (!ignore) setPoints([])
      })
    return () => {
      ignore = true
    }
  }, [pacName])

  const series = useMemo(() => {
    if (!points) return []
    const days = RANGE_DAYS[range]
    if (!Number.isFinite(days)) return points
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    return points.filter((p) => p.t >= cutoff)
  }, [points, range])

  const rangeTotal = series.reduce((sum, p) => sum + p.c, 0)

  return (
    <div className="flex h-full flex-col">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Spending Over Time
        </h3>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">
            {currencyFormatter.format(rangeTotal)}
          </span>
          <span className="text-sm font-medium text-slate-500">disbursed in range</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-400">
          Total disbursements per FEC reporting period
        </p>
      </div>

      <div className="mt-4 min-h-[16rem] flex-1">
        {points === null ? (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">
            Loading spending history…
          </div>
        ) : series.length === 0 ? (
          <div className="flex h-64 items-center justify-center px-4 text-center text-sm text-slate-400">
            No FEC spending history available for this PAC in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={256}>
            <AreaChart data={series} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pac-spend-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0891b2" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#0891b2" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 11 }}
                minTickGap={40}
                stroke="#9ca3af"
                tickFormatter={(t: number) => monthYearFmt.format(t)}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                width={64}
                stroke="#9ca3af"
                tickFormatter={(v: number) => currencyFormatter.format(v)}
              />
              <Tooltip
                formatter={(v) => currencyFormatter.format(Number(v))}
                labelFormatter={(t) => monthYearFmt.format(Number(t))}
              />
              <Area
                type="monotone"
                dataKey="c"
                name="Disbursed"
                stroke="#0891b2"
                strokeWidth={2}
                fill="url(#pac-spend-grad)"
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
            onClick={() => onRangeChange(r)}
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
type PieDatum = {
  name: string
  value: number
  bioguideId: string
  chamber: "house" | "senate"
  party: "D" | "R" | "I"
  fill: string
}

function buildPieData(recipients: PacRecipient[]): PieDatum[] {
  return recipients.map((r, i) => ({
    name: r.name,
    value: r.amount,
    bioguideId: r.bioguideId,
    chamber: r.chamber,
    party: r.party,
    fill: SLICE_COLORS[i % SLICE_COLORS.length],
  }))
}

function RecipientTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean
  payload?: Array<{ payload: PieDatum }>
  total: number
}) {
  const datum = payload?.[0]?.payload
  if (!active || !datum) return null
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="font-semibold text-slate-900">{datum.name}</p>
      <p className="font-medium" style={{ color: partyColor(datum.party) }}>
        {partyLabel(datum.party)} · {datum.chamber === "senate" ? "Senate" : "House"}
      </p>
      <p className="mt-1 font-semibold text-slate-700">
        {currencyFormatter.format(datum.value)}
        {total > 0 ? ` · ${((datum.value / total) * 100).toFixed(1)}%` : ""}
      </p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-blue-600">
        Click slice to open profile →
      </p>
    </div>
  )
}

function PacRecipientsPanel({ data }: { data: PacRecipients }) {
  const router = useRouter()
  const { recipients, totalAmount } = data
  const pieData = useMemo(() => buildPieData(recipients), [recipients])

  const top3 = recipients.slice(0, 3)
  const medals = ["#f59e0b", "#94a3b8", "#b45309"]

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Politicians Supported
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          {recipients.length} member{recipients.length === 1 ? "" : "s"} · {data.houseCount}{" "}
          House · {data.senateCount} Senate
        </p>
      </div>

      {recipients.length === 0 ? (
        <p className="text-sm text-slate-400">No recipients found for this PAC.</p>
      ) : (
        <>
          <div className="relative mx-auto h-52 w-52 shrink-0">
            <ResponsiveContainer width={208} height={208}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="100%"
                  paddingAngle={pieData.length > 24 ? 0 : 1.5}
                  stroke="none"
                  className="cursor-pointer focus:outline-none"
                  onClick={(slice) => {
                    const entry = slice as unknown as { payload?: PieDatum } & Partial<PieDatum>
                    const datum = entry.payload ?? entry
                    if (datum.bioguideId) {
                      router.push(memberHref(datum.chamber as "house" | "senate", datum.bioguideId))
                    }
                  }}
                />
                <Tooltip content={<RecipientTooltip total={totalAmount} />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                Total Given
              </span>
              <span className="text-xl font-bold text-slate-900">
                {currencyFormatter.format(totalAmount)}
              </span>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Top Recipients
            </p>
            <ul className="space-y-2">
              {top3.map((r, i) => (
                <li key={r.bioguideId}>
                  <Link
                    href={memberHref(r.chamber, r.bioguideId)}
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
                        {r.name}
                      </span>
                      <span
                        className="text-xs font-medium"
                        style={{ color: partyColor(r.party) }}
                      >
                        {partyLabel(r.party)} · {r.chamber === "senate" ? "Senate" : "House"}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-semibold text-slate-900">
                        {currencyFormatter.format(r.amount)}
                      </span>
                      <span className="text-xs text-slate-400">
                        {totalAmount > 0
                          ? `${((r.amount / totalAmount) * 100).toFixed(1)}%`
                          : ""}
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

const RANGE_LABELS: Record<Range, string> = {
  "6M": "last 6 months",
  "1Y": "last year",
  "2Y": "last 2 years",
  "5Y": "last 5 years",
  ALL: "all time",
}

type WindowRow = { member: FeedMember; total: number; count: number; lastDate: number }

function PacWindowRecipients({ pacName, range }: { pacName: string; range: Range }) {
  const [feed, setFeed] = useState<PacContributionFeed | null>(null)

  useEffect(() => {
    let ignore = false
    setFeed(null)
    fetch(`/api/pac-recipients-feed/${encodeURIComponent(pacName)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: PacContributionFeed) => {
        if (!ignore) setFeed(payload)
      })
      .catch(() => {
        if (!ignore) setFeed({ committeeId: null, members: [], contributions: [] })
      })
    return () => {
      ignore = true
    }
  }, [pacName])

  const { rows, totalAmount, contribCount } = useMemo(() => {
    if (!feed) return { rows: [] as WindowRow[], totalAmount: 0, contribCount: 0 }
    const days = RANGE_DAYS[range]
    const cutoff = Number.isFinite(days) ? Date.now() - days * 24 * 60 * 60 * 1000 : -Infinity
    const byId = new Map(feed.members.map((m) => [m.bioguideId, m]))
    const agg = new Map<string, WindowRow>()
    let count = 0
    for (const c of feed.contributions) {
      if (c.date < cutoff) continue
      const member = byId.get(c.bioguideId)
      if (!member) continue
      count++
      const existing = agg.get(c.bioguideId)
      if (existing) {
        existing.total += c.amount
        existing.count++
        if (c.date > existing.lastDate) existing.lastDate = c.date
      } else {
        agg.set(c.bioguideId, { member, total: c.amount, count: 1, lastDate: c.date })
      }
    }
    const sorted = [...agg.values()].sort((a, b) => b.total - a.total)
    return { rows: sorted, totalAmount: sorted.reduce((s, r) => s + r.total, 0), contribCount: count }
  }, [feed, range])

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Members Donated To · {RANGE_LABELS[range]}
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            Direct FEC contributions to current House &amp; Senate members in this window
          </p>
        </div>
        {feed && rows.length > 0 ? (
          <p className="text-sm text-slate-600">
            {rows.length} member{rows.length === 1 ? "" : "s"} ·{" "}
            {currencyFormatter.format(totalAmount)} · {contribCount} contribution
            {contribCount === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>

      <div className="mt-3 max-h-72 overflow-auto rounded-xl ring-1 ring-slate-100">
        {feed === null ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-400">
            Loading contributions…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-slate-400">
            No itemized contributions to current members in this range.
          </div>
        ) : (
          <table className="min-w-full border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-10 bg-slate-950 text-[10px] uppercase tracking-[0.18em] text-slate-200">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Party</th>
                <th className="px-3 py-2 font-medium">Chamber</th>
                <th className="px-3 py-2 font-medium">Latest Gift</th>
                <th className="px-3 py-2 text-right font-medium">Gifts</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.member.bioguideId}
                  className="border-b border-slate-100 text-sm text-slate-700 odd:bg-slate-50/70 hover:bg-blue-50"
                >
                  <td className="px-3 py-2 font-medium text-slate-400">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={memberHref(r.member.chamber, r.member.bioguideId)}
                      className="font-semibold text-gray-900 hover:text-blue-600"
                    >
                      {r.member.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${partyClasses(
                        r.member.party
                      )}`}
                    >
                      {r.member.party}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.member.chamber === "senate" ? "Senate" : "House"}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{dateFmt.format(r.lastDate)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{r.count}</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">
                    {currencyFormatter.format(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PacModal({ pacName, onClose }: { pacName: string; onClose: () => void }) {
  const [recipients, setRecipients] = useState<PacRecipients | null>(null)
  const [range, setRange] = useState<Range>("2Y")
  const loading = !recipients || recipients.pacName !== pacName

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    let ignore = false
    fetch(`/api/pac-donations/${encodeURIComponent(pacName)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: PacRecipients) => {
        if (!ignore) setRecipients(payload)
      })
      .catch(() => {
        if (!ignore) {
          setRecipients({
            pacName,
            totalAmount: 0,
            houseCount: 0,
            senateCount: 0,
            recipients: [],
          })
        }
      })
    return () => {
      ignore = true
    }
  }, [pacName])

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
              <span className="text-xs font-semibold uppercase tracking-wide text-white/70">
                Political Action Committee
              </span>
              <h2 className="mt-0.5 text-2xl font-bold tracking-tight">{pacName}</h2>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-white/70">Total to Congress</p>
              <p className="text-2xl font-bold">
                {recipients ? currencyFormatter.format(recipients.totalAmount) : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-6 p-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 bg-white p-5">
              {loading || !recipients ? (
                <div className="flex h-72 items-center justify-center text-sm text-slate-400">
                  Loading recipients…
                </div>
              ) : (
                <PacRecipientsPanel data={recipients} />
              )}
            </div>

            <div className="rounded-2xl border border-slate-100 bg-white p-5">
              <PacSpendingChart pacName={pacName} range={range} onRangeChange={setRange} />
            </div>
          </div>

          <PacWindowRecipients pacName={pacName} range={range} />
        </div>
      </div>
    </div>
  )
}
export default function PacDonations() {
  const [donations, setDonations] = useState<PacDonationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [chamber, setChamber] = useState<ChamberFilter>("all")
  const [selectedPac, setSelectedPac] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const res = await fetch("/api/pac-donations", { cache: "no-store" })
        const payload = (await res.json()) as PacDonationsResponse
        if (!res.ok) throw new Error(payload.error ?? "Failed to load PAC donations")
        if (active) {
          setDonations(payload.donations)
          setError(null)
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load PAC donations")
        }
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  const filtered = useMemo(() => {
    if (!donations) return []
    const q = query.trim().toLowerCase()
    return donations.filter((d) => {
      if (chamber !== "all" && d.chamber !== chamber) return false
      if (!q) return true
      return (
        d.pacName.toLowerCase().includes(q) ||
        d.memberName.toLowerCase().includes(q) ||
        d.state.toLowerCase().includes(q)
      )
    })
  }, [donations, query, chamber])

  const total = useMemo(() => filtered.reduce((sum, d) => sum + d.amount, 0), [filtered])

  if (error) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-700">
        {error}
      </div>
    )
  }

  if (!donations) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-sm text-slate-600 shadow-sm">
        Loading PAC donations...
      </div>
    )
  }

  return (
    <section className="dashboard-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-6 py-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">PAC Donations to Congress</h2>
          <p className="mt-1 text-sm text-slate-600">
            Largest PAC contributions to each House and Senate member for the current cycle.
            Click any row for a PAC&apos;s recipients and spending history. Showing{" "}
            {filtered.length.toLocaleString()} of {donations.length.toLocaleString()} ·{" "}
            {currencyFormatter.format(total)} total
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search PAC, member, or state"
            className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span className="font-medium">Chamber</span>
            <select
              value={chamber}
              onChange={(e) => setChamber(e.target.value as ChamberFilter)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All</option>
              <option value="house">House</option>
              <option value="senate">Senate</option>
            </select>
          </label>
        </div>
      </div>

      <div className="max-h-[44rem] overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-10 bg-slate-950 text-xs uppercase tracking-[0.18em] text-slate-200">
            <tr>
              <th className="px-4 py-3 font-medium">Rank</th>
              <th className="px-4 py-3 font-medium">PAC</th>
              <th className="px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Party</th>
              <th className="px-4 py-3 font-medium">Chamber</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                  No PAC donations match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((row, index) => (
                <tr
                  key={`${row.bioguideId}-${row.pacName}-${index}`}
                  onClick={() => setSelectedPac(row.pacName)}
                  className="cursor-pointer border-b border-slate-200 text-sm text-slate-700 odd:bg-slate-50/70 hover:bg-blue-50"
                >
                  <td className="px-4 py-3 font-medium text-slate-500">{index + 1}</td>
                  <td className="px-4 py-3 font-semibold text-gray-900">{row.pacName}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={memberHref(row.chamber, row.bioguideId)}
                      onClick={(e) => e.stopPropagation()}
                      className="font-semibold text-gray-900 hover:text-blue-600"
                    >
                      {row.memberName}
                    </Link>
                    <span className="ml-2 text-xs text-slate-400">{row.state}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${partyClasses(
                        row.party
                      )}`}
                    >
                      {row.party}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {row.chamber === "senate" ? "Senate" : "House"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {currencyFormatter.format(row.amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedPac ? (
        <PacModal pacName={selectedPac} onClose={() => setSelectedPac(null)} />
      ) : null}
    </section>
  )
}
