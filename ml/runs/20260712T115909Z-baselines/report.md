# Run: baselines

## Config
```json
{
  "label": "baselines",
  "snapshot": "ml/snapshots/trades-a8b7633c7eb854bf.parquet",
  "n_rows": 100922,
  "today": "2026-07-12",
  "horizon_days": 30,
  "k_values": [
    5,
    10,
    20
  ],
  "maturity_cutoff": "2026-03-29"
}
```

## Scorecard
- Folds scored: **635**
- Queries: **25752** (novel-bearing 18668, repeat-bearing 17836)

### Overall (all tickers)
| scorer | MAP | P@5 | P@10 | P@20 | R@5 | R@10 | R@20 | NDCG@5 | NDCG@10 | NDCG@20 |
|---|---|---|---|---|---|---|---|---|---|---|
| persistence | 0.219 | 0.161 | 0.132 | 0.108 | 0.207 | 0.273 | 0.358 | 0.253 | 0.268 | 0.292 |
| holdings | 0.183 | 0.136 | 0.116 | 0.096 | 0.172 | 0.245 | 0.334 | 0.209 | 0.228 | 0.254 |
| popularity | 0.092 | 0.088 | 0.078 | 0.069 | 0.069 | 0.115 | 0.184 | 0.110 | 0.118 | 0.136 |
| base_rate | 0.076 | 0.078 | 0.067 | 0.058 | 0.055 | 0.089 | 0.141 | 0.096 | 0.099 | 0.112 |

### Novel vs. repeat recall (headline)
| scorer | novel MAP | repeat MAP | novel R@5 | novel R@10 | novel R@20 | repeat R@5 | repeat R@10 | repeat R@20 |
|---|---|---|---|---|---|---|---|---|
| persistence | 0.018 | 0.361 | 0.012 | 0.023 | 0.044 | 0.347 | 0.467 | 0.612 |
| holdings | 0.018 | 0.303 | 0.012 | 0.023 | 0.044 | 0.293 | 0.421 | 0.572 |
| popularity | 0.025 | 0.132 | 0.022 | 0.039 | 0.068 | 0.099 | 0.164 | 0.263 |
| base_rate | 0.026 | 0.103 | 0.026 | 0.044 | 0.073 | 0.071 | 0.114 | 0.181 |
