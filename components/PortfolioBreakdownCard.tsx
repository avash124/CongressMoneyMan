"use client"

import { Pie, PieChart, Tooltip } from "recharts"
import type { AssetAllocation } from "@/types/member"

// Distinct, color-blind-friendly palette cycled across asset-type slices.
const COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#f59e0b", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#ea580c", // orange
  "#475569", // slate
]

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

export default function PortfolioBreakdownCard({
  allocations,
}: {
  allocations: AssetAllocation[]
}) {
  const total = allocations.reduce((sum, a) => sum + a.value, 0)

  // Recharts v3 reads each slice's color from a `fill` on the datum (the old
  // per-slice <Cell> child is deprecated).
  const chartData = allocations.map((a, i) => ({
    ...a,
    fill: COLORS[i % COLORS.length],
  }))

  return (
    <div className="dashboard-card card-hover p-8">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Portfolio Breakdown</h2>
        <p className="mt-1 text-sm text-gray-500">
          Estimated holdings by asset type, based on disclosed trades.
        </p>
      </div>

      {allocations.length === 0 || total === 0 ? (
        <p className="text-gray-500">No portfolio data available.</p>
      ) : (
        <div className="flex flex-col items-center gap-8 lg:flex-row lg:gap-12">
          {/* Donut chart with a centered total. Rendered at a fixed pixel size
              (matching the h-64/w-64 box) instead of ResponsiveContainer, whose
              height="100%" can't be measured on the first paint and logs a
              width(-1)/height(-1) warning. */}
          <div className="relative h-64 w-64 shrink-0">
            <PieChart width={256} height={256}>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="category"
                innerRadius="62%"
                outerRadius="100%"
                paddingAngle={1.5}
                stroke="none"
              />
              <Tooltip formatter={(value) => usd.format(Number(value))} />
            </PieChart>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs uppercase tracking-wide text-gray-400">
                Total
              </span>
              <span className="text-2xl font-bold text-gray-900">
                {usd.format(total)}
              </span>
            </div>
          </div>

          {/* Per-category legend with dollar value and share */}
          <ul className="w-full flex-1 space-y-3">
            {allocations.map((a, i) => (
              <li key={a.category} className="flex items-center gap-3">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 truncate text-gray-700">{a.category}</span>
                <span className="font-semibold text-gray-900">
                  {usd.format(a.value)}
                </span>
                <span className="w-14 text-right text-sm text-gray-500">
                  {((a.value / total) * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
