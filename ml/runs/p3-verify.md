# Phase 3 independent verification — eval harness + 4 baselines

**Agent:** independent P3 verifier (did not write the code).
**Gate (plan §6 step 3):** "baseline scorecard exists; numbers sane (persistence
should already look strong)."
**Snapshot under test:** `ml/snapshots/trades-a8b7633c7eb854bf.parquet` (100,922 rows,
342 members; `filed_at` null-rate 0, `transaction_date` null-rate 0).
**Run report verified:** `ml/runs/20260712T115909Z-baselines/report.md`
(persistence overall MAP=0.219, novel R@20=0.044, repeat R@20=0.612).

## VERDICT: **PASS**

Every claim I independently re-derived agreed with the harness within float noise.
No leakage or score-inflation vector found. The persistence==holdings novel
coincidence is *correct* behavior (explained below), not a bug.

---

## 1. Test suite

`backend/.venv/Scripts/python -m pytest ml/tests/ -q` → **32 passed in 0.20s**.
(test_metrics: 11, test_harness: 5, test_labels + test_leakage: 16.)

## 2. Metric math re-derived by hand

Canonical example `ranked=[A,B,C,D,E]`, `relevant={A,C,E}`:

| metric | hand | code |
|---|---|---|
| P@3 | 2/3 = 0.66667 | 0.66667 |
| P@5 | 3/5 = 0.60000 | 0.60000 |
| R@3 | 2/3 = 0.66667 | 0.66667 |
| AP  | (1 + 2/3 + 3/5)/3 = 0.75556 | 0.75556 |
| DCG@5 | 1/log2(2)+1/log2(4)+1/log2(6) = 1.88685 | 1.88685 |
| NDCG@5 | 1.88685 / (1/log2(2)+1/log2(3)+1/log2(4)) = 0.88546 | 0.88546 |

All exact. AP normalizes by `|relevant|` (not by hit count) — the standard MAP
per-query term, matching the plan. `precision_at_k` correctly keeps `k` as the
denominator even when fewer than `k` candidates are relevant. `recall_at_k`
returns 0 on empty relevant by convention.

## 3. One member's persistence MAP re-derived by hand (plan §6.1)

I wrote a throwaway script (pasted below) that **does not import the harness or
baselines** for its computation — it re-implements `trades_as_of` (filed_at ≤
end-of-as_of-day), candidate generation (member history ∪ top-100 popular,
order-preserved/deduped), labels (transaction_date in (as_of, as_of+30d]),
persistence scoring (Σ exp(−age_days/90) grouped by ticker), stable ranking, and
AP — all from scratch. Then it pulls the harness's own per-query AP for the SAME
(member, as_of) pairs and diffs them.

Pairs: 6 active members × 6 recent mature as_of dates (2026-01-05 … 2026-03-23,
all ≤ maturity cutoff 2026-03-29). 24 of them had labels.

**Per-query AP agreement: all 24 pairs matched within 1e-9.** Examples:

```
K000389 2026-03-16  mine=0.790028  harness=0.790028
M001157 2026-03-02  mine=0.019064  harness=0.019064
G000583 2026-03-09  mine=0.057860  harness=0.057860
C001123 2026-01-05  mine=0.268814  harness=0.268814
```

My hand-derived persistence MAP over those 24 pairs = **0.327966**; harness over
the same pairs = **0.327966**. (Higher than the report's overall 0.219 only
because these are hyperactive members; the 0.219 macro-averages over all 342
members incl. quiet ones. Not a discrepancy — the load-bearing check is the
exact per-query match.)

## 4. Headline sanity — is persistence strongest, and does it collapse on novel?

Independently re-aggregated the 12 most-recent mature weekly folds
(2026-01-11 … 2026-03-29; 446 queries) with my own novel/repeat partition:

```
persistence  allMAP=0.2901  novelMAP=0.0202  novelR@20=0.0711  repeatMAP=0.4168
holdings     allMAP=0.2050  novelMAP=0.0202  novelR@20=0.0711  repeatMAP=0.2887
popularity   allMAP=0.1261  novelMAP=0.0399  novelR@20=0.1412  repeatMAP=0.1587
base_rate    allMAP=0.1110  novelMAP=0.0429  novelR@20=0.1318  repeatMAP=0.1331
```

Same shape as the full-run report: **persistence wins overall MAP and repeat
MAP; collapses on novel** (novel R@20 ≈ 0.07 vs repeat far higher). Confirmed.

**Novel/repeat split is computed correctly.** `split_novel_repeat` does
`repeat = relevant & history`, `novel = relevant − history`, where `history` is
the member's pre-as_of traded tickers taken from the **leak-safe as_of frame**
(`as_of_frame.groupby('bioguide_id')['ticker']`), i.e. novel = ticker the member
never traded before as_of. Exactly the plan's definition.

### The persistence==holdings novel coincidence is CORRECT, not a mislabel
The report shows persistence and holdings with *identical* novel numbers
(novel MAP 0.018, novel R@20 0.044). I verified this is expected: both scorers
score **purely from the member's own history**, so any *novel* ticker (never
traded by the member) gets score **0** from both. With all novel labels at
score 0, novel recall/AP is decided only by where the zero-scored novel tickers
sit in the shared popular tail — identical candidate set ⇒ identical novel
metrics. Verified directly: for member B001236's novel labels, both scorers
return 0.0; full rankings differ (holdings ≠ persistence on repeat tickers) but
novel R@20 is 0.0 for both. No mislabeling.

## 5. Score-inflation vectors checked — none found

- **Candidate set peeking into label window:** built from `aof` (leak-safe). Of
  14 tickers that appear in the label window but not the as_of frame, **0**
  reached any of 37 sampled members' candidate sets. No label-window leakage.
- **`trades_as_of` admitting future filings:** 0 rows with `filed_at > cutoff`.
- **Recall denominator:** uses full `|relevant|`, NOT `|relevant ∩ candidates|`.
  A label not in the candidate set simply can't be recalled → recall is
  conservative (if anything deflated), never inflated. (Member A000372: 2 labels,
  1 in candidates, denominator still 2.)
- **Tie-breaking:** `_rank` is a stable sort on **fixed candidate order** (member
  history, then popularity) — decided before labels are seen, so ties cannot be
  broken favorably toward labels. Verified: equal-score items keep candidate
  order.
- **Macro-averaging:** per-query pooled across folds (each member-fold weighted
  equally); label-less queries are skipped (`if not relevant: continue`) so they
  neither inflate nor deflate. 25752 queries / 635 folds ≈ 40.6/fold, consistent
  with my 12-fold slice (~37/fold).

## Minor observations (non-blocking, not findings)
- The default candidate set is member-history ∪ top-100 popular — deliberately
  minimal for P3 (Phase 4 owns real recall@k). Recall@k here is bounded by this
  set (novel-ticker recall in particular is candidate-limited), so the low novel
  numbers partly reflect the placeholder candidate generator, not only scorer
  weakness — expected and called out in the harness docstring.
- `PopularityScorer.prepare` mutates then copies a fold frame; harmless (operates
  on the leak-safe `as_of_frame`), noted only for completeness.

---

### Throwaway re-derivation script (independent of harness for its own number)

```python
import math, os, sys
from datetime import date
import numpy as np, pandas as pd
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

SNAP = "ml/snapshots/trades-a8b7633c7eb854bf.parquet"
HALFLIFE, HORIZON, TOP_N_POPULAR = 90.0, 30, 100
df = pd.read_parquet(SNAP)
df["ticker"] = df["ticker"].astype("string").str.strip().str.upper()

def as_of_eod(d):
    ts = pd.Timestamp(d).tz_localize("UTC")
    return ts + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)

def my_trades_as_of(frame, d):
    c = as_of_eod(d)
    return frame[frame["filed_at"].notna() & (frame["filed_at"] <= c)]

def my_candidates(aof, member_id):
    t = aof.dropna(subset=["ticker"])
    popular = t["ticker"].value_counts().head(TOP_N_POPULAR).index.tolist()
    mine = list(dict.fromkeys(t[t["bioguide_id"] == member_id]["ticker"].tolist()))
    return list(dict.fromkeys([*mine, *popular]))

def my_labels(frame, member_id, d):
    lo = as_of_eod(d); hi = lo + pd.Timedelta(days=HORIZON); tx = frame["transaction_date"]
    m = ((frame["bioguide_id"] == member_id) & tx.notna() & (tx > lo) & (tx <= hi)
         & frame["ticker"].notna())
    return set(frame.loc[m, "ticker"].tolist())

def my_persistence(aof, member_id, d, cands):
    mine = aof[aof["bioguide_id"] == member_id]
    if mine.empty: return {c: 0.0 for c in cands}
    age = (as_of_eod(d) - mine["transaction_date"]).dt.total_seconds() / 86400.0
    w = np.exp(-age.clip(lower=0) / HALFLIFE)
    s = pd.Series(w.to_numpy(), index=mine["ticker"].to_numpy()).groupby(level=0).sum()
    return {c: float(s.get(c, 0.0)) for c in cands}

def my_rank(cands, sm):
    return sorted(cands, key=lambda c: (-sm[c], cands.index(c)))

def my_ap(ranked, rel):
    if not rel: return 0.0
    hits = running = 0
    for i, t in enumerate(ranked, 1):
        if t in rel:
            hits += 1; running += hits / i
    return running / len(rel)

members = ["K000389","M001157","G000583","C001123","M001193","P000612"]
dates = [date(2026,3,2),date(2026,3,9),date(2026,3,16),date(2026,2,2),date(2026,1,5),date(2026,3,23)]
aps = []
for m in members:
    for d in dates:
        aof = my_trades_as_of(df, d); rel = my_labels(df, m, d)
        if not rel: continue
        cands = my_candidates(aof, m)
        ap = my_ap(my_rank(cands, my_persistence(aof, m, d, cands)), rel)
        aps.append(ap)
print("my persistence MAP:", sum(aps)/len(aps))   # -> 0.327966

# comparison against harness per-query AP (import only to compare):
from ml import dataset
from ml.eval import harness, metrics as hm
from ml.models.baselines import PersistenceScorer
for m in members:
    for d in dates:
        aof = dataset.trades_as_of(df, d); rel = dataset.label_tickers(df, m, d, 30)
        if not rel: continue
        cands = harness.make_default_candidates(aof)(aof, m, d)
        sc = PersistenceScorer(); sc.prepare(aof, d)
        ap = hm.average_precision(harness._rank(cands, sc.score(m, d, cands)), rel)
        # assert abs(ap - mine[(m,d)]) < 1e-9   # held for all 24 labeled pairs
```
