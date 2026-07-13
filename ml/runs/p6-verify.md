# Phase 6 independent verification — feature expansion + ablations

**Gate (plan §6 step 6):** an ablation table in the run report; drop feature
families that don't move held-out metrics, and report that honestly. Success is
NOT "all families help" — it is a **trustworthy table showing which do**.

**Snapshot under test:** `ml/snapshots/trades-a8b7633c7eb854bf.parquet`
(100,922 rows). Aux snapshots pinned:
- `prices-8dacff246e3e9e22.parquet` — 1,067,375 Alpaca daily closes, 895 tickers, 2021-06 → 2026-07
- `profiles-3b1866aaa66f445d.parquet` — 166 FMP company profiles (sector / HQ-state / market-cap / name)
- `members-4edefcc5a4d7c03a.parquet` — 531 roster rows (party / chamber / state / district)
- `pac-f0da9e75d305f304.parquet` — 13,423 `pac_donations` rows (**all cycle 2026**)

**Run report verified:** `ml/runs/20260713T071028Z-ablation/` (train-frac 0.7,
191 held-out folds, seeds 1337 + 99).

## VERDICT: **PASS** — the ablation table is trustworthy; market is the one family that earns its keep, and no leakage was found.

Two fresh-context agents (given the plan + repo, NOT the implementation
conversation) independently agreed:
- **Gate re-derivation** confirmed the headline under its own fold-split and its
  own ranker fits: base reproduces P5, market's novel-recall lift reproduces with
  the correct sign and comparable magnitude across both seeds, member is
  marginal/inconsistent, PAC/committee are genuinely unavailable and honestly
  dropped. It added one honest nuance (§4) — the market lift is
  **time-regime-dependent**, not uniform.
- **Adversarial leakage hunt** found **NO LEAK** on all five P6 checklist items,
  including the load-bearing empirical proof that market features are
  byte-identical with vs without 172,830 future-dated closes present.

---

## 1. Data availability shaped which families the ablation could exercise

The gate is a trustworthy table of which families move held-out metrics. On THIS
snapshot only **market** and **member** had usable aux data; both agents confirmed
the other two are genuinely unavailable, not silently skipped:

- **PAC — dropped (no historical data).** `pac_donations` holds only the **2026
  cycle** (all 13,423 rows). Honest cycle-gating (donations from cycles strictly
  before the as_of cycle) leaves the family empty on every 2022–2026 eval fold
  (independently reconfirmed: empty for all 2022–2026 as_ofs, non-empty only at a
  2028 as_of — so the gate is real, not always-empty). The feature code is correct
  and unit-tested (synthetic fixture proves cycle-gating + company-linking); it
  simply has no usable data here.
- **Committee — dropped (no data source).** congress.gov v3 exposes no
  committee↔member roster (neither `/member/{id}` nor `/committee/{code}` detail
  lists membership — verified against the live API during implementation). The
  endpoint + static committee→sector dict + unit tests are complete and
  dormant-correct; the family activates the moment a roster source lands. Config
  shows `committees: null`; the family was not run.
- **Member — run, but geography is sparse.** Party/chamber attributes populate
  from the 531-row roster; the HQ-state match needs FMP HQ data (163 tickers,
  ~16% of the candidate universe), so it fires rarely. All `mem_*` feature-gain
  importances are ≤ 0.001.
- **Market — run, well-covered on price features.** Momentum/volatility have
  895-ticker coverage; sector affinity uses FMP sectors backfilled by a 218-ticker
  static S&P map (~25% of candidate tickers); market cap needs FMP (166 tickers).

## 2. Base row reproduces P5 exactly (the refactor is behavior-preserving)

The family-aware `FeatureBuilder`/ranker refactor must leave P5 behavior unchanged
when no aux is present. Confirmed by both the run and the re-derivation agent
(which checked `feature_cols(("base",))` == the 22 P5 columns byte-for-byte, and
that the ablation's folds are identical to P5's eval set):

| metric | P6 base (seed 1337) | P5 authoritative (`runs/20260712T153425Z-ranker`) |
|---|---|---|
| MAP | 0.3043 | 0.3043 |
| novel R@20 | 0.0525 | 0.0525 |
| repeat R@20 | 0.6335 | 0.6335 |

## 3. Ablation table (train-frac 0.7, 191 held-out folds)

Cumulative subsets on identical train/eval folds; Δ vs the P5 base row.

| subset | MAP (s1337 / s99) | Δnovel R@20 (s1337 / s99) | Δrepeat R@20 |
|---|---|---|---|
| base | 0.3043 / 0.3049 | — | — |
| **+market** | 0.3020 / 0.3049 | **+0.0041 / +0.0094** | −0.0021 / −0.0010 |
| +member | 0.3022 / 0.3046 | +0.0045 / +0.0078 | −0.0009 / −0.0020 |

**Disposition:** keep **market**, drop **member** (marginal-over-market: +0.0004
seed 1337, **−0.0016** seed 99 — sign flips), drop **PAC**/**committee** (no data).
Feature importance corroborates: `mkt_log_mktcap` is the **3rd-strongest** feature
by gain (0.062), `mkt_sector_affinity` 0.011; every `mem_*` is ≤ 0.001.

Recommended production set `DEFAULT_FAMILIES = (base, market)`. The code default
stays `(base,)` so the no-aux path is exactly P5 (existing tests unchanged).

## 4. Time-regime nuance (gate-re-derivation agent, disclosed not hidden)

The market novel-recall lift is **not uniform over time.** The re-derivation agent
re-fit base and +market on identical folds and found the effect reverses on the
most-recent window — the same MAP↔novel-recall tradeoff wall P5 documented at
train-frac 0.8:

| eval subset | seed | ΔMAP | Δnovel R@20 |
|---|---|---|---|
| earliest 50 folds (2022-08 → 2023-07) | 1337 | +0.0032 | **+0.0107** |
| earliest 50 folds | 99 | +0.0031 | **+0.0121** |
| most-recent 50 folds (2025-04 → 2026-03) | 1337 | −0.0046 | **−0.0027** |

The two seed-1337 subsets (+0.0107 early, −0.0027 late) **bracket** the full-191
average of +0.0041 — a net-positive-but-modest number is the average of opposing
regimes. So the honest headline is: **market lifts novel-ticker recall on the bulk
of held-out folds at ~zero MAP cost, but the gain is concentrated in earlier
windows and vanishes/slightly reverses in the most-recent ~50 folds** (the P5
tradeoff-wall window). This is a nuance to disclose, not a reason to fail the
gate — it is exactly the frontier P5-verify §2 proved is intrinsic to novel-recall
at k=20 (candidate-ceiling-limited to ~0.55, noisy near the floor).

## 5. Leakage hunt — NO LEAK (independent, empirical)

The adversarial agent hunted every §6.1 P6 checklist item on the real snapshots:

1. **Market features computed past as_of (THE #1 item) — CLEAN, load-bearing.**
   At as_of 2025-09-01 the prices frame had **172,830 future-dated closes**
   (`close_date > as_of`). `MarketFeatures.pair_features` over 8 members was
   **byte-identical** (`np.array_equal == True`, not merely close) whether or not
   those future rows were present. Boundary: `market._as_ts(as_of)` =
   end-of-day, **exactly equal** to `dataset._as_timestamp`; gate is
   `close_date <= cutoff`. Momentum/volatility never used a post-cutoff close.
   The member sector-mix derives from the already-windowed `as_of_frame`, so it
   inherits the `filed_at` cutoff.
2. **Committee future-leak — CLEAN.** The current-assignments→historical-folds
   approximation is documented in `committee.py`, not hidden; the family loads no
   data in the ablation (`committees: null`).
3. **PAC cycle-gating — CLEAN.** Empirically zero nonzero cells for all
   2022–2026 as_ofs; non-empty at a 2028 as_of (1,289 links), proving the gate is
   real. Same-cycle, future-cycle, and null-cycle donations all excluded.
4. **Aux mutated after pinning — CLEAN.** All six aux frame hashes unchanged
   before/after a full-family build over 10 members; builders only assign to their
   local `out` frame.
5. **Usual P5 vectors on new code — CLEAN.** No `transaction_date`/`traded` used
   as a knowledge cutoff in the new modules; no import of the cached
   `trade_features`/`asset_class_stats` aggregates; the no-DB-imports scan covers
   all new modules (market/member/committee/pac/sectors/_sector_data).

Non-blocking note (both agents): `ml/scripts/fetch_aux.py` imports
`backend.app.clients.congress` — correct, as scripts are outside the leakage-scan
scope by design and only fetch to pin a snapshot (feature builders still receive
frames, never fetch).

## 6. Test suite

`backend/.venv/Scripts/python -m pytest ml/tests/ -q` → **67 passed**
(P6 additions in `test_p6_features.py`: per-family hand-computed values on tiny
synthetic aux fixtures, the market as-of-windowing proof — a close dated after
as_of must not move any feature — and the ablation-subset filtering that skips
data-less families). The leakage scan (`test_leakage.py`, 9 tests) covers all new
feature modules and stays green.

## 7. Known limitations carried forward

- **Novel-recall is the binding constraint** and remains candidate-ceiling-limited
  (~0.55) and noisy at k=20. Market lifts it on most folds but the gain is
  time-regime-dependent (§4).
- **PAC and committee are implemented but data-starved** on this snapshot. They
  cost nothing to keep (behind the aux switch, off by default) and become live the
  moment multi-cycle donation history / a committee roster source lands.
- **FMP profile coverage is thin** (166 of ~1000 top-traded tickers; the rest are
  options/foreign/small-caps FMP doesn't profile), capping sector/HQ/market-cap
  feature coverage. The static 218-ticker S&P sector map backfills sector only.
