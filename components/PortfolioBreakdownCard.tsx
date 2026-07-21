"use client"
import { Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import type { AssetAllocation } from "@/types/member"
const COLORS = [
  "#2563eb",
  "#16a34a",
  "#f59e0b", 
  "#dc2626", 
  "#7c3aed", 
  "#0891b2", 
  "#db2777", 
  "#65a30d",
  "#ea580c", 
  "#475569", 
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
  const chartData = allocations.map((a, i) => ({
    ...a,
    fill: COLORS[i % COLORS.length],
  }))

  return (
    <div className="dashboard-card card-hover p-8">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900">Portfolio Breakdown</h2>
        <p className="mt-1 text-sm text-slate-500">
          Estimated holdings by asset type, based on disclosed trades.
        </p>
      </div>

      {allocations.length === 0 || total === 0 ? (
        <p className="text-slate-500">No portfolio data available.</p>
      ) : (
        <div className="flex flex-col items-center gap-8 lg:flex-row lg:gap-12">
          {}
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
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Total
              </span>
              <span className="text-2xl font-mono font-bold tabular-nums text-slate-900">
                {usd.format(total)}
              </span>
            </div>
          </div>

          {}
          <ul className="w-full flex-1 space-y-3">
            {allocations.map((a, i) => (
              <li key={a.category} className="flex items-center gap-3">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 truncate text-slate-700">{a.category}</span>
                <span className="font-mono font-semibold tabular-nums text-slate-900">
                  {usd.format(a.value)}
                </span>
                <span className="w-14 text-right font-mono text-sm tabular-nums text-slate-500">
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
