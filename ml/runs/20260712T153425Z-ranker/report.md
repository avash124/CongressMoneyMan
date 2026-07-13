# Run: ranker

## Config
```json
{
  "label": "ranker",
  "snapshot": "ml/snapshots/trades-a8b7633c7eb854bf.parquet",
  "n_rows": 100922,
  "today": "2026-07-12",
  "horizon_days": 30,
  "k_values": [
    5,
    10,
    20
  ],
  "train_folds": 111,
  "eval_folds": 191,
  "train_frac": 0.7,
  "train_stride": 4,
  "features": [
    "m_total_trades",
    "m_distinct_tickers",
    "m_trades_per_month",
    "m_buy_ratio",
    "m_days_since_last_trade",
    "m_active_days",
    "mt_decayed_freq",
    "mt_trade_count",
    "mt_buy_count",
    "mt_sell_count",
    "mt_days_since_last",
    "mt_is_repeat",
    "h_net_position",
    "h_is_held",
    "pop_peer_count",
    "pop_chamber_count",
    "pop_global_count",
    "pop_peer_recent_count",
    "pop_global_recent_count",
    "pop_global_novel",
    "pop_peer_novel",
    "cand_recip_rank"
  ],
  "gate": {
    "passed": true,
    "ranker_map": 0.3042504329257728,
    "baseline_map": 0.275533714373921,
    "ranker_novel_r20": 0.052509184815615305,
    "baseline_novel_r20": 0.05232497007300471
  }
}
```

## Scorecard
- Folds scored: **191**
- Queries: **6766** (novel-bearing 4399, repeat-bearing 4928)

### Overall (all tickers)
| scorer | MAP | P@5 | P@10 | P@20 | R@5 | R@10 | R@20 | NDCG@5 | NDCG@10 | NDCG@20 |
|---|---|---|---|---|---|---|---|---|---|---|
| lgbm_ranker | 0.304 | 0.217 | 0.170 | 0.134 | 0.272 | 0.335 | 0.415 | 0.352 | 0.360 | 0.378 |
| persistence | 0.276 | 0.194 | 0.158 | 0.130 | 0.245 | 0.318 | 0.404 | 0.313 | 0.329 | 0.351 |
| holdings | 0.228 | 0.155 | 0.134 | 0.112 | 0.210 | 0.290 | 0.389 | 0.248 | 0.272 | 0.302 |
| popularity | 0.094 | 0.106 | 0.095 | 0.083 | 0.059 | 0.106 | 0.165 | 0.125 | 0.132 | 0.143 |
| base_rate | 0.093 | 0.117 | 0.093 | 0.079 | 0.068 | 0.096 | 0.149 | 0.143 | 0.136 | 0.143 |

### Novel vs. repeat recall (headline)
| scorer | novel MAP | repeat MAP | novel R@5 | novel R@10 | novel R@20 | repeat R@5 | repeat R@10 | repeat R@20 |
|---|---|---|---|---|---|---|---|---|
| lgbm_ranker | 0.028 | 0.447 | 0.019 | 0.031 | 0.053 | 0.409 | 0.511 | 0.634 |
| persistence | 0.024 | 0.408 | 0.010 | 0.026 | 0.052 | 0.374 | 0.488 | 0.613 |
| holdings | 0.024 | 0.337 | 0.010 | 0.026 | 0.052 | 0.321 | 0.447 | 0.596 |
| popularity | 0.034 | 0.116 | 0.024 | 0.046 | 0.075 | 0.078 | 0.133 | 0.205 |
| base_rate | 0.040 | 0.109 | 0.036 | 0.051 | 0.086 | 0.081 | 0.115 | 0.176 |

## Gate (plan §6 step 5)

Beat **persistence** on macro-MAP AND novel-ticker recall@20:

| metric | ranker | persistence | verdict |
|---|---|---|---|
| macro-MAP | 0.3043 | 0.2755 | ✅ |
| novel R@20 | 0.0525 | 0.0523 | ✅ |

**PASS**

## Feature importance (gain)

| feature | gain |
|---|---|
| cand_recip_rank | 0.509 |
| mt_days_since_last | 0.145 |
| mt_decayed_freq | 0.079 |
| m_distinct_tickers | 0.046 |
| m_days_since_last_trade | 0.038 |
| m_active_days | 0.031 |
| m_buy_ratio | 0.025 |
| pop_global_count | 0.023 |
| m_total_trades | 0.021 |
| h_net_position | 0.016 |
| m_trades_per_month | 0.015 |
| mt_trade_count | 0.011 |
| mt_buy_count | 0.008 |
| pop_peer_count | 0.008 |
| mt_sell_count | 0.007 |
| pop_chamber_count | 0.006 |
| pop_global_novel | 0.006 |
| pop_global_recent_count | 0.003 |
| h_is_held | 0.002 |
| pop_peer_recent_count | 0.000 |
| pop_peer_novel | 0.000 |
| mt_is_repeat | 0.000 |