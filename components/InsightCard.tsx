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
      <h2 className="font-display text-2xl leading-tight text-ink">{title}</h2>
      <div className="ledger-rule mt-4 mb-5" role="presentation" />

      <div className="max-w-[68ch] space-y-3">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="leading-relaxed text-body text-pretty">
            {paragraph}
          </p>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted">
        AI-generated from disclosed trades. Dollar figures are midpoint
        estimates of disclosure ranges, not exact amounts.
      </p>
    </div>
  )
}
