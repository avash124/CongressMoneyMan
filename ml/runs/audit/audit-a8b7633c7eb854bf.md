# Data audit — snapshot `a8b7633c7eb854bf`
_generated 2026-07-12T11:33:33.176511+00:00_

- **Rows**: 100,922
- **filed_at null**: 0 (0.0%) — these cannot be used point-in-time
- **transaction_date null**: 0.0%
- **asset_type null**: 56.17% (bulk-feed rows)
- **Distinct tickers**: 5,127

## Filed-vs-traded lag (days)
- n=100,873, mean=49.0, p50=28.0, p90=50.0, p95=147.0, max=4112.0
- **% filed >45d late**: 12.3% (informs the late-filer slack in the maturity gate)

## Member trade counts
- 342 members; median=27, p90=491, max=26907
- single-trade members: 38; 10+-trade members: 226

## Owner field
- {"has_owner_field": false, "note": "no owner column in schema"}

## Rows per year
```json
{
  "2014": 4267,
  "2015": 4636,
  "2016": 5781,
  "2017": 7682,
  "2018": 9703,
  "2019": 9257,
  "2020": 10950,
  "2021": 6817,
  "2022": 8636,
  "2023": 8813,
  "2024": 6378,
  "2025": 11736,
  "2026": 6266
}
```