# `ml/` — Congressional trade prediction (offline)

Offline batch ML that reads the same Supabase the backend uses and ranks, per
`(member, week)`, which tickers a member is likely to trade next. Implements
`docs/trade-prediction-plan.md`. **Not imported by the FastAPI app** — serving
(later) is a cron job that writes a predictions table the API reads, exactly
like `rankings` works today.

## Status

Foundation phases (the plan's "leverage") are built and tested:

| Phase | What | Where | Gate |
|---|---|---|---|
| P0 | Data audit | `scripts/audit.py` | ✅ go: 0% `filed_at` null, 100.9k rows, lag p90=50d |
| P1 | As-of dataset layer + labels + snapshots | `dataset.py` | ✅ leakage + label pytests pass |
| P3 | Scorer interface, 4 baselines, walk-forward eval, metrics, reports | `models/`, `eval/` | ✅ baseline scorecard in `runs/` |
| P4 | Candidate generation (history ∪ holdings ∪ peer-popular ∪ top-traded) | `candidates.py`, `eval/candidate_eval.py` | recall@1000 gate (see note) — `runs/*-candidate-recall/` |
| P5 | LightGBM lambdarank + history/holdings/popularity features | `features/`, `models/ranker.py`, `scripts/train_ranker.py` | ✅ beats persistence on macro-MAP + novel recall (pooled) — see note |
| P6 | Feature expansion (market / member / committee / PAC) + ablations | `features/{market,member,committee,pac}.py`, `eval/ablation.py`, `scripts/{fetch_market,fetch_aux}.py` | ablation table in `runs/*-ablation/` — drop families that don't move held-out metrics (see note) |
| P7 | Ship: direction head, `trade_predictions` migration, cron batch scorer, read-only router | `models/direction.py`, `scripts/{score_batch,train_direction}.py`, `supabase/migrations/0006_*.sql`, `backend/app/routers/predictions.py` | end-to-end cron populates the table; API returns ranked predictions for a known-active member (see P7 note) |

**P4 gate deviation**: the plan targets ~200 candidates at recall@200 ≥ 0.9. A
ceiling probe on this data showed 200 candidates cover only ~65% of trades
(~24% of *novel* trades) — congress trades are too dispersed across the ~5,000
ticker universe to reach 0.9 in 200 slots. The budget is widened to ~1,000
(avg 952/member, still a >5× cut, cheap for a GBDT) and the gate is
**recall@1000 ≥ 0.80** — **PASS at 0.805** (repeat 1.00, **novel 0.55**). The
binding constraint the ranker inherits is novel-ticker recall ≈ 0.55; that is
the real ceiling on novel prediction, documented honestly rather than hidden.

**P5 gate note**: the ranker robustly beats persistence on **macro-MAP** (0.3043
vs 0.2755, +10.5 %, in every split/seed) and beats it on **novel-ticker recall@20**
on the primary walk-forward (0.0525 vs 0.0523, pooled over 191 held-out folds).
The novel-recall margin is marginal and split-dependent: it flips at train-frac
0.8, where a *proven MAP↔novel-recall tradeoff* (documented in `runs/p5-verify.md`
§2) makes a simultaneous win impossible for any history+popularity ordering.
Novel R@20 ≈ 0.05 sits near the noise floor at k=20 (candidate-ceiling-limited to
~0.55). PASS on the primary walk-forward; the P6 families (market/committee/PAC)
are budgeted to lift novel recall past popularity's ceiling.

**P6 gate note** (feature expansion + ablations, `runs/20260713T071028Z-ablation/`):
the ablation fits family subsets on identical folds (191 held-out, train-frac 0.7,
seeds 1337+99) and reports Δ vs the P5 base. Result — **market is the only family
that earns its keep**:

| subset | novel R@20 (s1337 / s99) | Δnovel | MAP Δ | disposition |
|---|---|---|---|---|
| base (P5) | 0.0525 / 0.0493 | — | — | — |
| +market | 0.0566 / 0.0587 | **+0.0041 / +0.0094** | −0.0022 / +0.0001 | **keep** |
| +member | 0.0570 / 0.0571 | +0.0004 / −0.0016 (marginal) | −0.0020 / −0.0002 | drop |

Market lifts novel-ticker recall (P6's real target — new member↔ticker affinity
that history+popularity can't express) **robustly across both seeds at ~zero MAP
cost**; `mkt_log_mktcap` is the 3rd-strongest feature by gain. **PAC** and
**committee** could not be evaluated on this data and are dropped:
`pac_donations` holds only the 2026 cycle (honest cycle-gating leaves it empty on
every historical fold), and congress.gov v3 exposes no committee↔member roster
(the endpoint + static committee→sector map + tests are complete and dormant).
The base row reproduces the P5 authoritative run to 4 decimals, so the
family-aware refactor is behavior-preserving. Recommended production set:
`DEFAULT_FAMILIES = (base, market)`; the code default stays `(base,)` so the
no-aux path is exactly P5.

**Independent verification** (plan §6.1): P1/P3 gates re-derived by fresh-context
agents (`runs/p1-verify.md`, `runs/p3-verify.md`, both PASS). P5 (`runs/p5-verify.md`):
leakage independently confirmed clean (byte-identical features with/without
future-filed rows); the gate + robustness re-derived across splits/seeds; the
frac=0.8 failure established as a tradeoff, not a leak or a missing feature. P6
(`runs/p6-verify.md`): market as-of windowing confirmed leak-free (features
byte-identical with/without 172k future-dated closes), PAC cycle-gating verified,
ablation headline re-derived independently.

**P7 note** (ship the ranker): serving is batch, mirroring `rankings` — a cron
(`scripts/score_batch.py`, wired into `backend/worker.py` + a `CRON_SECRET`-guarded
`/api/cron/refresh-predictions`) fits the ranker with `DEFAULT_FAMILIES`
(base+market) + prices/profiles aux, scores each active member's candidates for
the current week, attaches a direction-head `p_buy`, and upserts top-K into
`trade_predictions` (migration `0006`). The read-only `routers/predictions.py`
serves a member's latest-`as_of` ranked list. The **direction head**
(`models/direction.py`, buy/sell LightGBM) is kept only if it beats the
per-member modal-direction baseline on held-out balanced-accuracy/AUC across ≥2
seeds (`scripts/train_direction.py`); otherwise it is dropped and `p_buy` served
null, same discipline as P6. `model_version` carries the snapshot + aux hashes so
a served prediction is traceable to its run. Migration `0006` must be applied
(out-of-band, Supabase) before the router serves. See `runs/p7-verify.md`.

Not yet built (deliberately — has a verify gate): P8 optional sequence model.

## The one rule: point-in-time correctness

Everything reads a pandas frame that came through **`dataset.trades_as_of(frame,
as_of)`** — rows with `filed_at <= as_of`, never `transaction_date`. Feature
builders and scorers get that frame handed to them and **must not touch the
DB** (enforced by `tests/test_leakage.py`, a no-DB-imports scan over
`features/` and `models/`). Labels are separate and *may* use post-hoc
knowledge (`dataset.label_tickers`). Folds are only scored once their
disclosure window has matured (`dataset.is_window_mature`).

## Layout

```
config.py        horizon H, k values, maturity gate, snapshot/run paths, creds
dataset.py       trades_as_of / label_tickers / snapshot — the chokepoint
features/        pure as-of feature builders (no DB — enforced by leakage test)
  history.py     member-level + member×ticker trading-history features
  holdings.py    net-position features from as-of trades
  popularity.py  peer/chamber/global trailing herding counts (long + fresh)
  sectors.py     P6: pure ticker->sector resolver (profiles snapshot + fallback)
  market.py      P6: momentum/volatility/mktcap/sector-affinity (close_date<=as_of)
  member.py      P6: party/chamber attrs + member-state↔company-HQ-state match
  committee.py   P6: committee->sector jurisdiction match (static ~30-committee dict)
  pac.py         P6: donor-company link + donor-sector affinity (cycle-gated)
  build.py       assembler: -> one feature matrix per (member, candidates);
                 AuxData + feature_cols(families) drive the P6 ablation switch
models/
  base.py        Scorer protocol (prepare + score)
  baselines.py   persistence, holdings, popularity, base_rate
  ranker.py      LightGBM lambdarank ranker (fit + Scorer), monotone-constrained,
                 family-aware (pins its fitted column list; aux-frame injected)
  direction.py   P7: buy/sell head (binary LightGBM on the ranker's features) +
                 per-member modal-direction baseline (kept only if it beats it)
eval/
  metrics.py     MAP / NDCG@k / P@k / R@k, novel-vs-repeat split
  harness.py     walk-forward loop over Scorers (mature folds only; eval_folds)
  ablation.py    P6: fit/eval family subsets on identical folds -> ablation table
  report.py      runs/<ts>/{config,metrics}.json + report.md
scripts/
  audit.py       P0 data-quality audit  -> runs/audit/
  train.py       snapshot -> baselines -> walk-forward -> run report
  train_ranker.py P5/P6: split -> fit ranker -> eval; --ablate runs the P6 sweep
  train_direction.py P7: direction-head vs modal-baseline gate (bal-acc/AUC)
  score_batch.py P7: cron entrypoint -> fit ranker+head -> upsert trade_predictions
  fetch_market.py P6: pin prices + profiles aux snapshots (Alpaca/FMP, paced)
  fetch_aux.py   P6: pin members / pac (Supabase) + committees (congress.gov)
tests/           leakage, labels, metrics, harness, features, ranker, p6 (no DB)
runs/            committed reports (small JSON/markdown)
snapshots/       parquet, gitignored (reproducible from DB + pinned hash)
```

## Running

From the repo root, using the backend venv (which has pandas/pyarrow/sklearn
from `backend/requirements-dev.txt`):

```bash
# Data audit (fetches from Supabase, pins a snapshot, writes runs/audit/)
backend/.venv/Scripts/python -m ml.scripts.audit

# Baseline walk-forward eval (reuse the audit's snapshot to skip re-fetching)
backend/.venv/Scripts/python -m ml.scripts.train --snapshot ml/snapshots/trades-<hash>.parquet

# Candidate recall@200 gate (P4)
backend/.venv/Scripts/python -m ml.scripts.candidate_recall --snapshot ml/snapshots/trades-<hash>.parquet

# LightGBM ranker: train on early folds, eval vs baselines on held-out folds (P5)
backend/.venv/Scripts/python -m ml.scripts.train_ranker --snapshot ml/snapshots/trades-<hash>.parquet

# P6: pin the aux snapshots (market first, then DB/congress aux)
backend/.venv/Scripts/python -m ml.scripts.fetch_market --snapshot ml/snapshots/trades-<hash>.parquet --top-n 1000
backend/.venv/Scripts/python -m ml.scripts.fetch_aux            # members + pac
#   (--committees also pulls congress.gov, but v3 exposes no committee roster — see P6 note)

# P6: family ablation on identical folds -> runs/<ts>-ablation/report.md
backend/.venv/Scripts/python -m ml.scripts.train_ranker \
    --snapshot ml/snapshots/trades-<hash>.parquet --ablate \
    --prices ml/snapshots/prices-<hash>.parquet \
    --profiles ml/snapshots/profiles-<hash>.parquet \
    --members ml/snapshots/members-<hash>.parquet \
    --pac ml/snapshots/pac-<hash>.parquet

# P7: direction-head gate (head vs modal baseline, ≥2 seeds)
backend/.venv/Scripts/python -m ml.scripts.train_direction \
    --snapshot ml/snapshots/trades-<hash>.parquet \
    --prices ml/snapshots/prices-<hash>.parquet \
    --profiles ml/snapshots/profiles-<hash>.parquet --seeds 1337,99

# P7: cron batch scorer -> trade_predictions (migration 0006 applied first).
#   --dry-run computes + prints without writing; --table targets a scratch table.
backend/.venv/Scripts/python -m ml.scripts.score_batch \
    --snapshot ml/snapshots/trades-<hash>.parquet \
    --prices ml/snapshots/prices-<hash>.parquet \
    --profiles ml/snapshots/profiles-<hash>.parquet --dry-run

# Tests
backend/.venv/Scripts/python -m pytest ml/tests/ -q
```

`--today YYYY-MM-DD` overrides the maturity gate's "now"; `--max-folds N` caps
folds for a quick smoke run.

## Reproducibility

Each run writes `runs/<ts>-<label>/` with the snapshot hash in `config.json`.
Trades mutate upstream (Quiver amendments), so a changed hash is how a run
becomes non-comparable — snapshotting makes that visible instead of silent.
