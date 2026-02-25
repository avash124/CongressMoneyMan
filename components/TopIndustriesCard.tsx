import { Industry } from "@/types/member"

interface TopIndustriesCardProps {
  industries: Industry[]
}

export default function TopIndustriesCard({
  industries,
}: TopIndustriesCardProps) {
  const topThree = [...industries]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)

  return (
    <div
      style={{
        padding: "2rem",
        border: "1px solid #e5e5e5",
        borderRadius: "12px",
        width: "320px",
      }}
    >
      <h2 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>
        Top Supporting Industries
      </h2>

      {topThree.map((industry, index) => (
        <div
          key={industry.name}
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "0.75rem",
          }}
        >
          <span>
            {index + 1}. {industry.name}
          </span>
          <span style={{ fontWeight: "600" }}>
            ${industry.amount.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}