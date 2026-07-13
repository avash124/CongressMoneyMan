# Run: direction head vs modal baseline (P7 §2.1)

## Config
```json
{
  "label": "direction",
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
  "aux": {
    "prices": "ml/snapshots/prices-8dacff246e3e9e22.parquet",
    "profiles": "ml/snapshots/profiles-3b1866aaa66f445d.parquet"
  },
  "families": [
    "base",
    "market"
  ],
  "verdict": "KEEP"
}
```

## Head vs modal baseline (held-out events)

| seed | events | head bal-acc | base bal-acc | head auc | base auc | head wins |
|---|---|---|---|---|---|---|
| 1337 | 103047 | 0.5960 | 0.5484 | 0.6438693448242138 | 0.5789939054644253 | ✅ |
| 99 | 103047 | 0.5883 | 0.5484 | 0.6334691229334004 | 0.5789939054644253 | ✅ |

**Verdict: KEEP** — the head beats the modal baseline on every seed; serve `p_buy`.
