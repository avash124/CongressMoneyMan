import { PacDonation } from "@/types/member"

interface PacDonationsCardProps {
  donations: PacDonation[]
}

export default function PACDonationsCard({
  donations,
}: PacDonationsCardProps) {
  const sorted = [...donations].sort(
    (a, b) => b.amount - a.amount
  )

  return (
    <div
      style={{
        marginTop: "3rem",
        padding: "2rem",
        border: "1px solid #e5e5e5",
        borderRadius: "12px",
      }}
    >
      <h2 style={{ fontSize: "1.25rem", marginBottom: "1.5rem" }}>
        Largest PAC Donations
      </h2>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: "left", paddingBottom: "0.75rem" }}>
              PAC Name
            </th>
            <th style={{ textAlign: "right", paddingBottom: "0.75rem" }}>
              Amount
            </th>
          </tr>
        </thead>

        <tbody>
          {sorted.map((donation) => (
            <tr key={donation.pacName}>
              <td style={{ padding: "0.75rem 0" }}>
                {donation.pacName}
              </td>
              <td
                style={{
                  padding: "0.75rem 0",
                  textAlign: "right",
                  fontWeight: "600",
                }}
              >
                ${donation.amount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}