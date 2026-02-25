import { Member } from "@/types/member"

interface MemberHeaderProps {
  member: Member
}

export default function MemberHeader({ member }: MemberHeaderProps) {
  const partyLabel =
    member.party === "D"
      ? "Democrat"
      : member.party === "R"
      ? "Republican"
      : "Independent"

  const partyColor =
    member.party === "D"
      ? "#2563eb"
      : member.party === "R"
      ? "#dc2626"
      : "#6b7280"

  return (
    <div
      style={{
        padding: "2rem",
        border: "1px solid #e5e5e5",
        borderRadius: "12px",
        flex: 1,
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>
        {member.name}
      </h1>

      <p
        style={{
          color: partyColor,
          fontWeight: "600",
          marginTop: "0.5rem",
        }}
      >
        {partyLabel} • {member.state}-{member.district}
      </p>

      <div style={{ marginTop: "1.5rem" }}>
        <div>
          <strong>Total Raised:</strong>{" "}
          ${member.totalRaised.toLocaleString()}
        </div>

        <div>
          <strong>Total Spent:</strong>{" "}
          ${member.totalSpent.toLocaleString()}
        </div>
      </div>
    </div>
  )
}