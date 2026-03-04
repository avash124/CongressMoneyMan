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
        background: "white",
        borderRadius: "16px",
        boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
        padding: "2rem",
        minWidth: "320px",
        height: "fit-content",
      }}
    >
      <h2
        style={{
          fontSize: "1.25rem",
          fontWeight: 600,
          marginBottom: "1.5rem",
        }}
      >
        Top Supporting Industries
      </h2>

      {topThree.length === 0 ? (
        <p style={{ color: "#6b7280" }}>
          No industry data available.
        </p>
      ) : (
        topThree.map((industry, index) => (
          <div
            key={industry.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1rem",
              paddingBottom: "0.75rem",
              borderBottom:
                index !== topThree.length - 1
                  ? "1px solid #f3f4f6"
                  : "none",
            }}
          >
            <span
              style={{
                color: "#374151",
              }}
            >
              {index + 1}. {industry.name}
            </span>

            <span
              style={{
                fontWeight: 600,
              }}
            >
              ${industry.amount.toLocaleString()}
            </span>
          </div>
        ))
      )}
    </div>
  )
}