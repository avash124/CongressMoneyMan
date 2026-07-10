"use client"

import Link from "next/link"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { DaySnapshot, ProfitLoss, TradeDetail } from "@/types/trade"

const priceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
})

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

const shortDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
})
 
function formatDate(value: string) {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? value || "—" : dateFmt.format(ms)
}

function formatSigned(value: number) {
  const sign = value >= 0 ? "+" : "-"
  return `${sign}${priceFmt.format(Math.abs(value))}`
}

function ChartPanel({
  id,
  title,
  date,
  snapshot,
  color,
}: {
  id: string
  title: string
  date: string
  snapshot: DaySnapshot | null
  color: string
}) {
  const isDaily = snapshot?.timeframe === "daily"
  const data = (snapshot?.bars ?? []).map((b) => ({
    time: isDaily ? shortDateFmt.format(b.t) : timeFmt.format(b.t),
    price: b.c,
  }))
  const price = snapshot?.close ?? null

  return (
    <div className="dashboard-card p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <p className="text-sm text-gray-500">{formatDate(date)}</p>
        </div>
        <span className="text-2xl font-bold" style={{ color }}>
          {price != null ? priceFmt.format(price) : "—"}
        </span>
      </div>

      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={360}>
          <AreaChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 11 }}
              minTickGap={40}
              stroke="#9ca3af"
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 11 }}
              width={64}
              stroke="#9ca3af"
              tickFormatter={(v: number) => priceFmt.format(v)}
            />
            <Tooltip formatter={(v) => priceFmt.format(Number(v))} />
            <Area
              type="monotone"
              dataKey="price"
              stroke={color}
              strokeWidth={2}
              fill={`url(#grad-${id})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[360px] items-center justify-center text-sm text-gray-400">
          {isDaily
            ? "No recent price data available"
            : "No intraday chart available for this day"}
        </div>
      )}
    </div>
  )
}

function ProfitLossCard({ pl }: { pl: ProfitLoss }) {
  const gain = pl.pctChange >= 0
  const color = gain ? "#16a34a" : "#dc2626"
  const lo = Math.min(pl.plLow, pl.plHigh)
  const hi = Math.max(pl.plLow, pl.plHigh)

  return (
    <div className="dashboard-card p-6">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">
        Estimated {gain ? "Profit" : "Loss"}{" "}
        {pl.exitBasis === "current" ? "(unrealized)" : "(realized)"}
      </h2>

      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-sm text-gray-500">Estimated {gain ? "gain" : "loss"} range</p>
          <p className="text-2xl font-bold" style={{ color }}>
            {formatSigned(lo)} – {formatSigned(hi)}
          </p>
        </div>

        <div>
          <p className="text-sm text-gray-500">Percentage</p>
          <p className="text-2xl font-bold" style={{ color }}>
            {gain ? "+" : ""}
            {pl.pctChange.toFixed(2)}%
          </p>
        </div>

        <div className="text-sm text-gray-500">
          <p>
            Buy {priceFmt.format(pl.buyPrice)} →{" "}
            {pl.exitBasis === "sale" ? "Sell" : "Current"}{" "}
            {priceFmt.format(pl.exitPrice)}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Range applies the price move to the disclosed purchase amount.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function StockTradeView({ detail }: { detail: TradeDetail }) {
  const memberHref = detail.chamber?.toLowerCase().includes("senate")
    ? `/senator/${detail.bioguideId}`
    : `/member/${detail.bioguideId}`

  return (
    <div className="flex flex-col gap-6">
      <div className="dashboard-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {detail.ticker || "—"}
            </h1>
            {detail.assetName ? (
              <p className="text-gray-500">{detail.assetName}</p>
            ) : null}
          </div>
          {detail.bioguideId ? (
            <Link
              href={memberHref}
              className="text-sm font-semibold text-blue-600 hover:underline"
            >
              {detail.memberName || "View member"} →
            </Link>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600">
          {detail.buy ? (
            <span>
              Bought {formatDate(detail.buy.date)} · {detail.buy.range || "—"}
            </span>
          ) : null}
          {detail.sell ? (
            <span>
              Sold {formatDate(detail.sell.date)} · {detail.sell.range || "—"}
            </span>
          ) : (
            <span className="text-gray-400">Position not yet sold</span>
          )}
        </div>
      </div>

      {detail.profitLoss ? (
        <ProfitLossCard pl={detail.profitLoss} />
      ) : (
        <div className="dashboard-card p-6 text-sm text-gray-500">
          Profit/loss estimate unavailable —{" "}
          {detail.buy
            ? "price data is missing for this ticker."
            : "no matching purchase was found for this position."}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <ChartPanel
          id="buy"
          title="Day of Purchase"
          date={detail.buy?.date ?? ""}
          snapshot={detail.buySnapshot}
          color="#2563eb"
        />
        {detail.sell ? (
          <ChartPanel
            id="sell"
            title="Day of Sale"
            date={detail.sell.date}
            snapshot={detail.sellSnapshot}
            color="#dc2626"
          />
        ) : null}
        <ChartPanel
          id="today"
          title="Today"
          date={detail.todaySnapshot?.date ?? ""}
          snapshot={detail.todaySnapshot}
          color="#16a34a"
        />
      </div>
    </div>
  )
}
