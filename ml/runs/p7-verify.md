# Phase 7 independent verification — ship the ranker

**Gate (plan §6 step 7):** an end-to-end cron run populates `trade_predictions`,
and the API returns ranked, leak-free predictions for a known-active member.
Success is a **working serving path** with sane predictions — NOT a new modeling
win (P5/P6 earned the ranking quality; P7 must not regress it).

**Snapshot under test:** `ml/snapshots/trades-a8b7633c7eb854bf.parquet` (100,922
rows) + the P6-verified aux `prices-8dacff246e3e9e22.parquet` /
`profiles-3b1866aaa66f445d.parquet`. Serve config = `DEFAULT_FAMILIES`
(base+market), matching the P6 ablation. `model_version` for the verified run:
`ranker-base+market@a8b7633c7eb854bf+prices@8dacff246e3e9e22+profiles@3b1866aaa66f445d`.

## VERDICT: **PASS** — the direction head earns its keep, the serving path works end-to-end, and no leakage was found.

Three fresh-context agents (given the plan + repo, NOT the implementation
conversation) independently agreed:
- **Gate re-derivation** re-computed the direction head vs the modal baseline from
  scratch and confirmed **KEEP** with bit-identical numbers; its own buy/sell
  labels matched `horizon_direction_labels` exactly.
- **End-to-end serving** ran the API against the cron-populated table and confirmed
  non-empty, deduped, rank-ordered predictions for two known-active members, every
  served ticker a legitimate point-in-time candidate.
- **Adversarial leakage hunt** found **NO LEAK** on all five P7 checklist items,
  including the load-bearing byte-identity proof that future filings do not move
  the head's training features.

---

## 1. Direction head vs modal baseline — KEEP (plan §2.6)

The head is a binary buy/sell LightGBM on the ranker's features
(`DEFAULT_FAMILIES`), trained only on positive events; the label is the
horizon trade's `transaction_type` (post-hoc target knowledge, legitimate like
`label_tickers`). The bar is a **per-member modal-direction baseline** ("this
member buys X% of the time", X = the member's as-of buy fraction). Kept only if
it beats the baseline on the FULL held-out set across ≥2 seeds (no smoke slice).

Authoritative run `ml/runs/20260713T100206Z-direction/` (train-frac 0.7 → 111
train / 191 held-out folds, **103,047** held-out events, 47.8% buys):

| seed | head bal-acc | base bal-acc | head AUC | base AUC | head wins |
|---|---|---|---|---|---|
| 1337 | 0.5960 | 0.5484 | 0.6439 | 0.5790 | ✅ |
| 99   | 0.5883 | 0.5484 | 0.6335 | 0.5790 | ✅ |

The baseline is member-level, so its metrics are seed-invariant (0.5484 /
0.5790). The head beats it on **balanced accuracy AND AUC on both seeds**
(~+0.04–0.05 bal-acc, ~+0.055–0.065 AUC) → **KEEP**; production serves `p_buy`.

**Independent re-derivation agreed.** A fresh-context agent re-implemented the
protocol from scratch (its own label logic, its own modal baseline, its own eval
over the full 191 held-out folds, ~27 min, both seeds) and reproduced the same
table:
- Its buy/sell labels **matched `horizon_direction_labels` exactly** on all 12
  sampled folds (`labels_agree = True`).
- Its independently-recomputed modal baseline was **bit-identical** (0.5484 /
  0.5790) — the bar the head is measured against is legitimate, not rigged.
- Honest nuance it disclosed: the head's feature set already contains the
  member-level buy tendency (`m_buy_ratio`, `mt_buy_count`, `mt_sell_count`) the
  baseline uses, so it *supersets* the baseline's information — but the AUC lift
  (0.64 vs 0.58) is a genuine **per-ticker** improvement beyond the member's rate,
  so the KEEP is real, not an artifact of information overlap.

The **size head is deferred** (plan §2.6): the bottom disclosure bracket
dominates so a per-member modal-bracket baseline is likely unbeatable — not
built, noted as deferred.

## 2. End-to-end serving path — PASS (plan §6 step 7 gate)

A real cron run (`ml/scripts/score_batch.py`) at `as_of=2026-07-13` fit the
ranker (base+market, 159 mature train folds) + the direction head, scored every
active member's ~1,500 candidates, and upserted top-20 into `trade_predictions`.
The read-only API (`GET /api/predictions/{bioguide_id}` →
`services/predictions.get_latest_predictions`) serves the latest `as_of`.

A fresh-context serving agent confirmed, against the populated table:

- **API ranking (K000389, M001157):** HTTP 200, **20** predictions each, `rank`
  exactly 1..20 (no gaps), rows sorted by `score` **descending** (rank order ==
  score order), tickers unique, every `pBuy ∈ [0,1]`, `asOf`/`modelVersion`
  populated. Unknown bioguide id → 200 with `predictions: []` (graceful).
  - K000389 top-3: BSX (2.946, p_buy 0.588), ABT (2.870, 0.508), ACN (2.796, 0.425)
  - M001157 top-3: VRNG (2.890, 0.718), INTU (2.658, 0.628), AMZN (2.052, 0.254)
- **No fabrication / no leak:** every served ticker ∈ the member's independently
  rebuilt `make_candidate_generator(trades_as_of(frame, 2026-07-13), …)` set
  (K000389: 20 ⊆ 1,566; M001157: 20 ⊆ 1,598). Nothing scored that a
  point-in-time candidate build wouldn't produce.
- **Table integrity:** 2,240 rows = 112 members × 20; single `as_of`
  (2026-07-13); single `model_version`; PK `(bioguide_id, ticker, as_of)`
  duplicates = **0**.

## 3. Adversarial leakage hunt — NO LEAK

The new P7 surface is the **direction label** and the **production scoring path**.
A fresh-context agent attacked all five checklist items assuming a leak existed:

1. **Direction head using `transaction_date`/`traded` as a cutoff (THE #1 item) —
   CLEAN, load-bearing.** `DirectionHead.fit` builds features from
   `dataset.trades_as_of(frame, as_of)` (filed_at ≤ as_of); only the LABEL reads
   the future window. Empirical proof: injecting 1,890 future-dated filings
   (`filed_at = as_of+10d`) for the exact events at `as_of=2026-01-29`, holding
   the event set fixed, left the head's training feature matrix (630 events × 27
   cols) **byte-identical** (`np.array_equal == True`); 0 injected rows appeared
   in the as-of frame. `ModalDirectionBaseline.prepare` uses the as-of frame only.
2. **Batch scorer windowing — CLEAN.** Candidates + features at serve time use
   `trades_as_of(frame, today)`; the ranker/head are trained only on mature folds
   (`harness._fold_dates` stops at `maturity_cutoff`). Live "now" scoring is not a
   backtest leak — `today` is the present.
3. **Feature/label `as_of` alignment — CLEAN.** One loop over `as_of`; features
   from `trades_as_of(frame, as_of)` and label from `(as_of, as_of+30d]` share the
   same `as_of` by construction — no cross-fold mismatch possible.
4. **No cached-aggregate import — CLEAN.** No feature/model module imports
   `trade_features` / `asset_class_stats` (every grep hit is a disclaiming comment
   or the script-side DB write, outside the feature path).
5. **No-DB scan covers `direction.py` — CLEAN (green).** `test_leakage.py` → 9
   passed; `direction.py` is in scope (models/); its imports are all allowed. The
   batch scorer correctly lives in `ml/scripts/` (outside the scan) and is the
   sole DB-touching component.

## 4. Test suite

`backend/.venv/Scripts/python -m pytest ml/tests/ -q` → **75 passed** (67 prior +
8 P7 additions):
- `test_direction.py` (5): hand-computed buy/sell labels on the synthetic fixture
  (M1 at as_of=2026-01-31 → {AAPL:0, MSFT:1, NVDA:1}; M2 → {AAPL:1}), the
  tie/neither-typed drop rule, head fit/predict wiring, predict-before-fit raises,
  and the modal baseline's per-member buy fraction.
- `test_score_batch.py` (3): `assemble_rows` row shape (full column set), ranks
  1..K, dedup per `(member, ticker, as_of)`, `p_buy` attached vs null when the head
  is dropped, and `active_members` recency windowing.
The leakage scan stays green over `direction.py`.

## 5. Notes carried forward

- **Migration `0006_trade_predictions.sql` must be applied out-of-band** (Supabase)
  before the router serves. On the verified environment it was already applied
  (table present, all 8 columns readable) — that is how the end-to-end run wrote
  and the API read.
- **Serving deps graduated** (plan §4): `lightgbm`, `pandas`, `pyarrow` added to
  `backend/requirements.txt` (the batch scorer's fit/serve runtime).
- **Fit cost:** the scorer fits once per run on the current snapshot (~8 min
  ranker + ~7 min head on this data; plan §3 option a — no model registry). Wired
  into serving as a weekly `worker.py` job and a `CRON_SECRET`-guarded
  `/api/cron/refresh-predictions` (launches the scorer detached — a 15-min fit
  cannot block an HTTP request), via a subprocess helper so `backend.app` never
  imports the `ml` package.
- **Dead-but-correct path:** `DirectionHead._constant` (single-class fallback)
  never engages on real two-class data (confirmed by both the run and the
  re-derivation agent); it exists so the fit/predict wiring is valid on degenerate
  synthetic fixtures.
- **Predictions can't be *scored* for ~75 days** (§2.3) — the current-week `as_of`
  is a production prediction for "now"; its label window matures later. This is
  expected, not a defect.
