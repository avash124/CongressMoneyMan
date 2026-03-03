interface Trade {
  ticker: string
  transactionDate: string
  transactionType: string
  amount: string
}

export default function CongressTradesCard({
  trades,
}: {
  trades: Trade[]
}) {
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
        Recent Stock Trades
      </h2>

      {trades.length === 0 ? (
        <p style={{ color: "#6b7280" }}>
          No trading activity available.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Ticker</th>
              <th style={{ textAlign: "left" }}>Type</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th style={{ textAlign: "right" }}>Date</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={index}>
                <td style={{ padding: "0.75rem 0" }}>
                  {trade.ticker}
                </td>
                <td>{trade.transactionType}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>
                  {trade.amount}
                </td>
                <td style={{ textAlign: "right" }}>
                  {trade.transactionDate}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}