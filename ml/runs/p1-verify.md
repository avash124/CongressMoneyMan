# P1 Independent Verification — Dataset + as-of layer

**Phase:** P1 (build order step 2) — `trades_as_of`, parquet snapshotting, label
builder with maturity gate.
**Gate:** "leakage pytests pass."
**Agent:** independent verifier (did NOT write the implementation).
**Date:** 2026-07-12.

## VERDICT: **PASS**

No leak found. Every independently re-derived number agreed with the code
exactly (9/9 `(member, as_of)` windows, both as-of ticker sets and label sets).
The as-of chokepoint, null-`filed_at` exclusion, maturity gate math, snapshot
hashing, and the no-DB-imports scan all behave as the plan (§2.2, §2.3, §3, §7)
requires. One **minor, non-blocking** gap in the leakage scan is noted below
(FINDING-1) — it does not affect the P1 gate because current `__init__.py`
files are clean.

---

## 1. Test suite

- `backend/.venv/Scripts/python -m pytest ml/tests/ -q` → **37 passed** in 0.22s.
- P1-specific (`test_leakage.py` + `test_labels.py`) → **19 passed**.
- The extra 18 are P3 code (harness/metrics/candidates) already landed; not
  part of the P1 gate but scanned for leakage anyway (§3 below).

## 2. Independent re-derivation (did NOT trust the existing tests)

Loaded the real snapshot `ml/snapshots/trades-a8b7633c7eb854bf.parquet`
(100,922 rows, `filed_at`/`transaction_date` range 2012–2026). Re-implemented
`trades_as_of` and `label_tickers` **from scratch in raw pandas** (own
`_as_timestamp`, own filed<=cutoff mask, own `(as_of, as_of+H]` window), then
compared to what `ml/dataset.py` returns for 3 members × 3 as_of dates.

Members: `K000389`, `M001157`, `G000583`. As_of: `2023-06-15`, `2024-01-31`,
`2025-03-01`.

**Result — all 9 pairs agreed exactly, both tasks:**

| member | as_of | as-of tickers (mine==ml) | filed>cutoff violations | labels (mine==ml) |
|---|---|---|---|---|
| K000389 | 2023-06-15 | 1264 == 1264 | 0 | 224 == 224 |
| K000389 | 2024-01-31 | 1286 == 1286 | 0 | 130 == 130 |
| K000389 | 2025-03-01 | 1319 == 1319 | 0 | 212 == 212 |
| M001157 | 2023-06-15 | 1060 == 1060 | 0 | 24 == 24 |
| M001157 | 2024-01-31 | 1105 == 1105 | 0 | 42 == 42 |
| M001157 | 2025-03-01 | 1133 == 1133 | 0 | 14 == 14 |
| G000583 | 2023-06-15 | 446 == 446 | 0 | 39 == 39 |
| G000583 | 2024-01-31 | 475 == 475 | 0 | 28 == 28 |
| G000583 | 2025-03-01 | 517 == 517 | 0 | 41 == 41 |

`rows_in_win` (raw transactions) consistently exceeded distinct label tickers
(e.g. K000389 @ 2023-06-15: 320 raw txns → 224 distinct tickers), confirming
correct de-duplication into a set. Zero rows with `filed_at > cutoff` in any
as-of view. **No disagreement — gate re-derivation passes.**

Throwaway script (`scratchpad/rederive.py`), core logic:

```python
def my_as_of_cutoff(as_of_str):          # replicate _as_timestamp
    ts = pd.Timestamp(as_of_str).tz_localize("UTC")
    if ts.normalize() == ts:             # bare date -> END of UTC day
        ts = ts + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
    return ts

def my_trades_as_of(df, as_of_str):
    cutoff = my_as_of_cutoff(as_of_str)
    return df.loc[df["filed_at"].notna() & (df["filed_at"] <= cutoff)]

def my_labels(df, bio, as_of_str, H=30):
    lo = my_as_of_cutoff(as_of_str); hi = lo + pd.Timedelta(days=H)
    tx = df["transaction_date"]
    m = (df["bioguide_id"]==bio) & tx.notna() & (tx>lo) & (tx<=hi) & df["ticker"].notna()
    return set(df.loc[m, "ticker"])
# ...then assert my_* == dataset.* for every (member, as_of). All equal.
```

## 3. Adversarial leakage hunt (§6.1 checklist)

### 3a. `transaction_date`/`traded` used as a knowledge cutoff? — NO leak.
Grepped all of `ml/`. `transaction_date` appears in `models/baselines.py`,
`candidates.py`, `eval/harness.py`. In every case it is used as a **feature
value / recency weight on rows already filtered by `trades_as_of`**, which the
plan explicitly permits — not as the knowledge cutoff. Proof: the harness does
`as_of_frame = dataset.trades_as_of(frame, as_of)` (harness.py:143) **before**
handing the frame to `scorer.prepare()` and the candidate factory. The
knowledge cutoff is always `filed_at`.

Verified end-to-end with a trap (`scratchpad/harness_leak.py`): a trade
transacted 2026-01-01 but **filed** 2026-06-01, fed as the RAW frame.
- `PersistenceScorer` score for that ticker at as_of=2026-03-01 → **0.0**
  (invisible, because unfiled).
- Same ticker at as_of=2026-06-15 (after filing) → **0.16** (visible).

The `trades_as_of` gate genuinely shields the scorers from not-yet-filed trades.

### 3b. No-DB-imports scan — CATCHES real imports (not vacuous), one gap.
- Planted `import httpx` + `from backend.app.core import db` in a throwaway
  `ml/features/_poison_tmp.py` → scan **FAILED** as required (caught both).
- Planted `import requests` + `import psycopg2` in `ml/models/_poison_tmp.py`
  → scan **FAILED** (caught both). Both dirs are actively scanned.
- Removed poison; scan green again. The real files (`models/base.py`,
  `models/baselines.py`) import only pandas/numpy/stdlib — clean.
- No import of the cached `trade_features`/`asset_class_stats` aggregates
  anywhere in `ml/` (the plan's §7 "leak-by-convenience" risk). Clean.

**FINDING-1 (minor, non-blocking):** the scan **skips `__init__.py`**
(`test_leakage.py:70`, `p.name != "__init__.py"`). I planted `import httpx` in
`ml/features/__init__.py` and the test still **PASSED** — a forbidden import in
any package `__init__.py` would go undetected. Low severity for the P1 gate
because both current `__init__.py` files are docstring-only. Recommend either
scanning `__init__.py` too or asserting they contain no import statements
before Phase 5/6 add real feature modules (the point where a convenience import
would actually be tempting). Not a leak today; a hole in the guard.

### 3c. Null-`filed_at` rows excluded from as-of but kept for labels — PROVEN.
The real snapshot happens to have 0 null `filed_at`, so I proved the behavior
synthetically (`scratchpad/adversarial.py`) across `None`, empty string `""`,
and unparseable `"not-a-date"` — all coerce to `NaT`:
- as-of view at 2026-12-31 returned **only** the row with a valid `filed_at`;
  all three NaT rows excluded.
- `label_tickers` (which keys on `transaction_date`) **kept** all three NaT-filed
  rows — correct, since the trade still happened and labels may use post-hoc
  knowledge.

### 3d. Maturity gate math — re-derived by hand.
Config: H=30, DISCLOSURE_LAG=45, LATE_FILER_SLACK=30 → sum **105 days**.
- `is_window_mature(as_of=2026-04-01, today=2026-07-15)` → True; at
  `today=2026-07-14` (one day short) → **False**. Boundary is exactly
  `today >= as_of + 105d`.
- `maturity_cutoff(2026-07-15)` → `2026-04-01` == `today - 105d` (hand-checked).
- `is_window_mature(maturity_cutoff(today), today)` True; one day past it False.
Consistent with §2.3 / §5.

### 3e. Snapshot hash changes on mutation — PROVEN.
- Identical frame re-snapshotted → **same** hash (`afdb190d5282c93e`).
- Mutate a `trade_size_usd` → hash changes (`973f2ecfafb88677`).
- Mutate a `filed_at` date → hash changes (`581ef3ec330b578f`).
Upstream Quiver revisions will surface as a changed hash (§7 intent met).
Snapshots dir is correctly gitignored (`ml/.gitignore`), per §3.1.

## 4. Cleanup
All poison/throwaway files planted during the hunt were removed;
`git status ml/` shows no stray files and the full suite is green (37 passed)
after cleanup.

---

## Summary of findings
- **Numeric gate:** PASS — 9/9 windows agree exactly; 0 as-of violations.
- **Leakage hunt:** No leak. `filed_at` is the only knowledge cutoff; the
  harness filters before scorers see data; null filings excluded from as-of;
  maturity math correct; snapshot hashing correct; no `trade_features` import.
- **FINDING-1 (minor):** no-DB-imports scan ignores `__init__.py`; harden
  before Phase 5/6. Does **not** block P1.

**Phase P1 gate: PASS.**

---

## FINDING-1 resolution (post-verify, by implementer)
Closed: `_python_files()` in `test_leakage.py` no longer excludes
`__init__.py`, so package inits are now scanned. Re-verified by planting
`import httpx` in `ml/features/__init__.py` — the scan test now FAILS as it
should, and passes once reverted.
