import { PacDonation } from "@/types/member"

interface PacDonationsCardProps {
  donations: PacDonation[]
}

export default function PACDonationsCard({
  donations,
}: PacDonationsCardProps) {
  return (
    <div
      style={{
        marginTop: "2rem",
        padding: "2rem",
        background: "white",
        borderRadius: "16px",
        boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
      }}
    >
      <h2
        style={{
          fontSize: "1.25rem",
          fontWeight: 600,
          marginBottom: "1.5rem",
        }}
      >
        Recent PAC Donations
      </h2>

      {donations.length === 0 ? (
        <p style={{ color: "#6b7280" }}>
          No PAC donation data available.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>PAC</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>

          <tbody>
            {donations.map((donation, index) => (
              <tr key={index}>
                <td style={{ padding: "0.75rem 0" }}>
                  {donation.pacName}
                </td>

                <td
                  style={{
                    textAlign: "right",
                    fontWeight: 600,
                  }}
                >
                  ${donation.amount.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}