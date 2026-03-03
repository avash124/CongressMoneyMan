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

  const location =
    member.district === "Senate"
      ? `${member.state} • Senate`
      : `${member.state} • ${member.district}`

  return (
    <div
      style={{
        padding: "2.5rem",
        borderRadius: "16px",
        background: "white",
        boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
        flex: 1,
      }}
    >
      <h1
        style={{
          fontSize: "2.5rem",
          fontWeight: 700,
          marginBottom: "0.5rem",
        }}
      >
        {member.name}
      </h1>

      <div
        style={{
          display: "inline-block",
          background: partyColor,
          color: "white",
          padding: "6px 14px",
          borderRadius: "999px",
          fontWeight: 600,
          fontSize: "0.9rem",
          marginBottom: "1.5rem",
        }}
      >
        {partyLabel} • {location}
      </div>

      <div
        style={{
          display: "flex",
          gap: "3rem",
          marginTop: "1rem",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.9rem",
              color: "#6b7280",
              marginBottom: "0.25rem",
            }}
          >
            Total Raised
          </div>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: 700,
            }}
          >
            ${member.totalRaised.toLocaleString()}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "0.9rem",
              color: "#6b7280",
              marginBottom: "0.25rem",
            }}
          >
            Total Spent
          </div>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: 700,
            }}
          >
            ${member.totalSpent.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
}