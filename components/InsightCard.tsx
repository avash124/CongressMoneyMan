import { fetchBackend } from "@/lib/backend"

type Insight = {
  kind: string
  entity: string
  insight: string
  model: string
  generatedAt: string
}

interface InsightCardProps {
  path: string
  title: string
}

export default async function InsightCard({ path, title }: InsightCardProps) {
  const data = await fetchBackend<Insight>(path)
  if (!data) return null

  const paragraphs = data.insight
    .replace(/\s*\[\d+\]/g, "")
    .split(/\n+/)
    .filter((p) => p.trim().length > 0)

  return (
    <div className="dashboard-card p-8 h-fit">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">{title}</h2>

      <div className="space-y-3">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="text-gray-700 leading-relaxed">
            {paragraph}
          </p>
        ))}
      </div>

      <p className="mt-6 text-xs text-gray-400">
        AI-generated from disclosed trades. Dollar figures are midpoint
        estimates of disclosure ranges, not exact amounts.
      </p>
    </div>
  )
}
