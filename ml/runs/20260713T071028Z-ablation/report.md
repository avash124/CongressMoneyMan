# Run: ablation (P6 feature families)

## Config
```json
{
  "label": "ablation",
  "snapshot": "ml/snapshots/trades-a8b7633c7eb854bf.parquet",
  "n_rows": 100922,
  "today": "2026-07-13",
  "horizon_days": 30,
  "train_folds": 111,
  "eval_folds": 191,
  "train_frac": 0.7,
  "train_stride": 4,
  "seeds": [
    1337,
    99
  ],
  "aux_snapshots": {
    "prices": "ml/snapshots/prices-8dacff246e3e9e22.parquet",
    "profiles": "ml/snapshots/profiles-3b1866aaa66f445d.parquet",
    "members": "ml/snapshots/members-4edefcc5a4d7c03a.parquet",
    "committees": null,
    "pac": null
  },
  "available_families": [
    "market",
    "member"
  ],
  "subsets": [
    "base",
    "+market",
    "+member"
  ]
}
```

## Disposition (see `ml/runs/p6-verify.md` for the independent verification)

**Keep `market`; drop `member`, `pac`, `committee`.** Market lifts novel-ticker
recall across both seeds (+0.0041 / +0.0094) at ~zero MAP cost — the P6 target.
Member's marginal-over-market is +0.0004 / −0.0016 (sign flips across seeds) and
all `mem_*` gains ≤ 0.001. PAC has only cycle-2026 data (cycle-gated empty on
every historical fold); committee has no data source (congress.gov v3 exposes no
roster) — both are implemented + unit-tested but not evaluable here.

**Honest nuance (verified independently):** the market novel-recall lift is
**time-regime-dependent** — clearly positive on earlier held-out folds
(Δnovel ≈ +0.011 on the earliest 50), slightly negative on the most-recent ~50
(Δnovel ≈ −0.003), the same MAP↔novel-recall tradeoff wall documented in
`p5-verify.md` §2. The full-191 average is the net of opposing regimes, not a
uniform gain. See `p6-verify.md` §4.

## Ablation tables

Cumulative family subsets on identical train/eval folds. Δ is vs the P5 **base** row. Tracks MAP, novel R@20, repeat R@20 (a novel win that craters MAP is the §2 tradeoff wall, not progress).

### Ablation (seed 1337) — Δ vs P5 base

| subset | MAP | ΔMAP | novel R@20 | Δnovel | repeat R@20 | Δrepeat |
|---|---|---|---|---|---|---|
| base | 0.3043 | +0.0000 | 0.0525 | +0.0000 | 0.6335 | +0.0000 |
| +market | 0.3020 | -0.0022 | 0.0566 | +0.0041 | 0.6314 | -0.0021 |
| +member | 0.3022 | -0.0020 | 0.0570 | +0.0045 | 0.6326 | -0.0009 |

### Ablation (seed 99) — Δ vs P5 base

| subset | MAP | ΔMAP | novel R@20 | Δnovel | repeat R@20 | Δrepeat |
|---|---|---|---|---|---|---|
| base | 0.3049 | +0.0000 | 0.0493 | +0.0000 | 0.6335 | +0.0000 |
| +market | 0.3049 | +0.0001 | 0.0587 | +0.0094 | 0.6325 | -0.0010 |
| +member | 0.3046 | -0.0002 | 0.0571 | +0.0078 | 0.6315 | -0.0020 |

## Feature importance — +member model (gain)

| feature | gain |
|---|---|
| cand_recip_rank | 0.530 |
| mt_days_since_last | 0.135 |
| mkt_log_mktcap | 0.062 |
| mt_decayed_freq | 0.048 |
| m_distinct_tickers | 0.041 |
| m_days_since_last_trade | 0.024 |
| m_active_days | 0.023 |
| m_total_trades | 0.018 |
| h_net_position | 0.017 |
| m_buy_ratio | 0.017 |
| m_trades_per_month | 0.014 |
| mt_trade_count | 0.013 |
| mkt_sector_affinity | 0.011 |
| pop_global_count | 0.009 |
| mt_buy_count | 0.006 |
| mt_sell_count | 0.006 |
| pop_peer_count | 0.005 |
| pop_chamber_count | 0.005 |
| mkt_volatility | 0.003 |
| pop_global_novel | 0.003 |
| h_is_held | 0.003 |
| mkt_momentum | 0.002 |
| pop_global_recent_count | 0.002 |
| mem_is_senate | 0.001 |
| mem_party_d | 0.001 |
| mem_is_house | 0.001 |
| mem_hq_state_match | 0.001 |
| mem_party_r | 0.001 |
| mkt_sector_match | 0.000 |
| pop_peer_recent_count | 0.000 |
| pop_peer_novel | 0.000 |
| mt_is_repeat | 0.000 |
