"""Cron batch scorer — the P7 serving entrypoint (plan §3, §6 step 7).

Produces the CURRENT week's ranked predictions for every active member and
upserts them into ``trade_predictions``. Mirrors the cron write pattern
(``db.upsert_trade_features``): a SCRIPT (outside the leakage scan) fits the
offline ranker, scores, and writes a table the read-only API serves — the same
cron-writes / API-reads split as ``rankings``.

    backend/.venv/Scripts/python -m ml.scripts.score_batch            # fetch fresh, write
    backend/.venv/Scripts/python -m ml.scripts.score_batch --dry-run  # compute, print, no write
    backend/.venv/Scripts/python -m ml.scripts.score_batch \
        --snapshot ml/snapshots/trades-<hash>.parquet \
        --prices   ml/snapshots/prices-<hash>.parquet \
        --profiles ml/snapshots/profiles-<hash>.parquet --limit-members 25

Serve == the P6-verified config: the ranker is fit with ``DEFAULT_FAMILIES``
(base + market) and the prices/profiles aux, and ``model_version`` records the
trades + aux snapshot hashes so a served prediction is traceable to its run.

LEAK NOTE (production scoring, NOT backtesting): candidates + features are built
from ``trades_as_of(frame, today)`` — nothing filed after ``today``. The ranker
is trained only on MATURE folds (their horizon has fully disclosed). Scoring the
CURRENT week is legitimate: today's window can't be *scored* for ~75 days
(§2.3), but predicting "now" is exactly the product. Live holdings/PAC snapshots
would be a leak only when backtesting a past fold — here ``today`` is the
present, so there is no future to peek at.

Fit cost: a full ranker fit is ~10–15 min. This job fits once per run on the
current snapshot (plan §3 option a — the simplest thing that works; no model
registry). The weekly cadence makes that acceptable.
"""

from __future__ import annotations

import argparse
import logging
from datetime import date, datetime, timezone

import pandas as pd

from .. import config, dataset
from ..candidates import make_candidate_generator
from ..eval import harness
from ..features.build import DEFAULT_FAMILIES, AuxData
from ..models.direction import DirectionHead
from ..models.ranker import LGBMRankerScorer

logger = logging.getLogger("ml.score_batch")

PREDICTIONS_TABLE = "trade_predictions"
TOP_K = 20
ACTIVE_DAYS = 365
TRAIN_STRIDE = 4


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def active_members(as_of_frame: pd.DataFrame, as_of: date, active_days: int) -> list[str]:
    """Members who filed at least one disclosure in the trailing ``active_days``
    (point-in-time: uses ``filed_at``, already ``<= as_of`` in the as-of frame).
    These are the traders worth predicting for; the long tail of members who
    haven't filed in a year would only yield stale, low-signal candidates."""
    cutoff = dataset._as_timestamp(as_of) - pd.Timedelta(days=active_days)
    recent = as_of_frame[
        as_of_frame["filed_at"].notna()
        & (as_of_frame["filed_at"] > cutoff)
        & as_of_frame["bioguide_id"].notna()
    ]
    return recent["bioguide_id"].unique().tolist()


def assemble_rows(
    as_of_frame: pd.DataFrame,
    as_of: date,
    generate,
    ranker,
    head,
    *,
    model_version: str,
    k: int,
    members: list[str],
) -> list[dict]:
    """Build the ``trade_predictions`` rows for ``members`` at ``as_of``.

    Pure given fitted (``prepare``-d) ``ranker`` / ``head`` and a candidate
    ``generate`` fn — no DB, no model fitting — so a unit test can drive it with
    lightweight stand-in scorers. One row per top-``k`` candidate per member,
    ``rank`` 1..k, deduped by construction (the generator returns unique tickers).
    """
    computed_at = _now_iso()
    as_of_iso = as_of.isoformat()
    rows: list[dict] = []
    for member_id in members:
        candidates = generate(as_of_frame, member_id, as_of)
        if not candidates:
            continue
        scores = ranker.score(member_id, as_of, candidates)
        order = sorted(range(len(candidates)), key=lambda i: -scores[i])[:k]
        top_tickers = [candidates[i] for i in order]
        if head is not None:
            p_buys = head.predict_direction(member_id, as_of, top_tickers)
        else:
            p_buys = [None] * len(top_tickers)
        for rank, (idx, p_buy) in enumerate(zip(order, p_buys), start=1):
            rows.append(
                {
                    "bioguide_id": member_id,
                    "ticker": candidates[idx],
                    "rank": rank,
                    "score": float(scores[idx]),
                    "p_buy": None if p_buy is None else float(p_buy),
                    "as_of": as_of_iso,
                    "model_version": model_version,
                    "computed_at": computed_at,
                }
            )
    return rows


def _model_version(frame: pd.DataFrame, aux: AuxData) -> str:
    """A traceable version string: which families + which snapshot/aux hashes
    produced the prediction (reproducibility, §3)."""
    parts = [f"ranker-base+market@{dataset._frame_hash(frame)}"]
    if aux.prices is not None:
        parts.append(f"prices@{dataset._frame_hash(aux.prices)}")
    if aux.profiles is not None:
        parts.append(f"profiles@{dataset._frame_hash(aux.profiles)}")
    return "+".join(parts)


def _resolve_aux(args) -> AuxData:
    """Load the prices/profiles aux (P6-verified production set). Explicit paths
    win; otherwise auto-discover the newest pinned snapshot of each kind so the
    cron serves the verified config without babysitting hashes. A missing frame
    degrades that family to zeros (loud warning — that would silently serve P5)."""
    def newest(kind: str):
        matches = list(config.SNAPSHOTS_DIR.glob(f"{kind}-*.parquet"))
        return max(matches, key=lambda p: p.stat().st_mtime) if matches else None

    prices_path = args.prices or newest("prices")
    profiles_path = args.profiles or newest("profiles")
    logger.info("aux: prices=%s profiles=%s", prices_path, profiles_path)
    if prices_path is None or profiles_path is None:
        logger.warning(
            "Missing market aux (prices=%s profiles=%s) — market family degrades "
            "to zeros; this serves the P5 history-only set, NOT the verified "
            "base+market config.", prices_path, profiles_path,
        )
    return AuxData(
        prices=dataset.load_snapshot(prices_path) if prices_path else None,
        profiles=dataset.load_snapshot(profiles_path) if profiles_path else None,
    )


def _upsert_predictions(rows: list[dict], table: str) -> None:
    """Idempotent upsert into ``table`` via PostgREST, keyed on
    ``(bioguide_id, ticker, as_of)`` with merge-duplicates — the same write shape
    as ``db.upsert_trade_features``. Synchronous truststore client (Norton TLS
    MITM, project memory), like ``dataset._fetch_all`` — so ``ml`` never imports
    ``backend.app``."""
    import ssl

    import httpx
    import truststore

    creds = config.supabase_credentials()
    if creds is None:
        raise RuntimeError(
            "Supabase not configured — set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY (see .env.local)."
        )
    base, key = creds
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    with httpx.Client(timeout=60.0, verify=ctx) as client:
        for start in range(0, len(rows), 500):
            batch = rows[start : start + 500]
            resp = client.post(
                f"{base}/{table}",
                params={"on_conflict": "bioguide_id,ticker,as_of"},
                json=batch,
                headers=headers,
            )
            resp.raise_for_status()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description="Cron batch scorer → trade_predictions.")
    parser.add_argument("--snapshot", help="Trades snapshot; omit to fetch fresh from DB.")
    parser.add_argument("--prices", help="prices-<hash>.parquet aux (default: newest pinned).")
    parser.add_argument("--profiles", help="profiles-<hash>.parquet aux (default: newest pinned).")
    parser.add_argument("--today", help="Override 'today' / as_of (YYYY-MM-DD).")
    parser.add_argument("--k", type=int, default=TOP_K, help=f"Top-K per member (default {TOP_K}).")
    parser.add_argument(
        "--active-days", type=int, default=ACTIVE_DAYS,
        help=f"A member is active if they filed within this trailing window (default {ACTIVE_DAYS}).",
    )
    parser.add_argument(
        "--train-stride", type=int, default=TRAIN_STRIDE,
        help=f"Subsample train folds by this stride to cut fit cost (default {TRAIN_STRIDE}).",
    )
    parser.add_argument(
        "--no-direction", action="store_true",
        help="Skip the direction head; serve rank/score only (p_buy null).",
    )
    parser.add_argument(
        "--limit-members", type=int, default=None,
        help="Cap the number of members scored (smoke run).",
    )
    parser.add_argument("--table", default=PREDICTIONS_TABLE, help="Target table (scratch/staging override).")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Compute + print a summary but do NOT write to the DB.",
    )
    args = parser.parse_args()

    today = (
        datetime.strptime(args.today, "%Y-%m-%d").date()
        if args.today
        else datetime.now(timezone.utc).date()
    )

    if args.snapshot:
        frame = dataset.load_snapshot(args.snapshot)
        print(f"Loaded snapshot {args.snapshot} ({len(frame)} rows).")
    else:
        path, snap_hash = dataset.build_snapshot_from_db()
        frame = dataset.load_snapshot(path)
        print(f"Fetched + pinned trades snapshot {path.name} ({len(frame)} rows).")
    if frame.empty:
        print("Empty trades snapshot — nothing to score.")
        return 1

    aux = _resolve_aux(args)
    model_version = _model_version(frame, aux)

    train_folds = harness._fold_dates(frame, today)[:: args.train_stride]
    if not train_folds:
        print("No mature training folds — cannot fit the ranker.")
        return 1
    print(f"Fitting ranker (base+market) on {len(train_folds)} train folds...")
    ranker = LGBMRankerScorer(families=DEFAULT_FAMILIES, aux=aux)
    ranker.fit(frame, train_folds, candidate_factory=make_candidate_generator)

    head = None
    if not args.no_direction:
        print("Fitting direction head...")
        head = DirectionHead(families=DEFAULT_FAMILIES, aux=aux)
        head.fit(frame, train_folds)

    as_of_frame = dataset.trades_as_of(frame, today)
    generate = make_candidate_generator(as_of_frame, today)
    ranker.prepare(as_of_frame, today)
    if head is not None:
        head.prepare(as_of_frame, today)

    members = active_members(as_of_frame, today, args.active_days)
    if args.limit_members is not None:
        members = members[: args.limit_members]
    print(f"Scoring {len(members)} active members at as_of={today} (top-{args.k})...")

    rows = assemble_rows(
        as_of_frame, today, generate, ranker, head,
        model_version=model_version, k=args.k, members=members,
    )
    scored_members = len({r["bioguide_id"] for r in rows})
    print(
        f"Built {len(rows)} rows for {scored_members} members "
        f"(p_buy {'attached' if head is not None else 'null'}).\n"
        f"model_version={model_version}"
    )

    if args.dry_run:
        print("[dry-run] not writing to the DB.")
        for r in rows[:10]:
            print(
                f"  {r['bioguide_id']:>8} #{r['rank']:<2} {r['ticker']:<6} "
                f"score={r['score']:.4f} p_buy={r['p_buy']}"
            )
        return 0

    _upsert_predictions(rows, args.table)
    print(f"Upserted {len(rows)} rows into {args.table}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
