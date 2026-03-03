"use client"

import { useEffect, useState } from "react"
import type { Trade } from "@/types/member"

export default function CongressTradesCard({
  initialTrades,
  memberId,
}: {
  initialTrades: Trade[]
  memberId: string
}) {
  const [trades, setTrades] = useState<Trade[]>(initialTrades)

  useEffect(() => {
    let cancelled = false

    async function loadTrades() {
      try {
        const response = await fetch(`/api/member/${memberId}/trades`, {
          cache: "no-store",
        })
        if (!response.ok) {
          return
        }

        const payload = (await response.json()) as { trades?: Trade[] }
        if (!cancelled) {
          setTrades(payload.trades ?? [])
        }
      } catch {
        // Keep the initial trades if the refresh fails.
      }
    }

    loadTrades()

    return () => {
      cancelled = true
    }
  }, [memberId])

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
