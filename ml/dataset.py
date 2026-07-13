"""Dataset + as-of layer — the single chokepoint for point-in-time correctness.

Everything downstream (features, baselines, ranker) reads a pandas frame that
came through here. The leakage invariant is enforced in one place:

    trades_as_of(frame, as_of)  ->  rows with filed_at <= as_of, never later.

Feature builders take the returned frame and are forbidden from touching the DB
(``ml/tests/test_leakage.py`` scans for that). Labels are built separately and
*are* allowed to use post-hoc knowledge (transaction_date in the future window).

Known data quirks handled here (hit in the RAG work):
  - ``filed_at`` / ``transaction_date`` are stored as text -> parsed to UTC
    Timestamps; unparseable/empty become NaT.
  - ``asset_type`` is NULL on bulk-feed rows -> left as-is (callers decide).
  - Rows with a null ``filed_at`` cannot be placed point-in-time and are
    dropped by ``trades_as_of`` (they would otherwise leak or misdate).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from . import config

logger = logging.getLogger("ml.dataset")

_PAGE_SIZE = 1000

_DATE_COLS = ("filed_at", "transaction_date", "traded")


def _fetch_all(table: str, order: str) -> list[dict]:
    """Page through ``table`` via PostgREST, ordered for stable page boundaries.

    Unordered PostgREST pagination can silently duplicate or drop rows across
    pages (same reasoning as ``backend/app/core/db._select_all_pages``), so a
    total order is required. Uses a synchronous httpx client with a truststore
    SSL context — the machine may sit behind Norton's TLS MITM (project memory),
    which the system trust store knows about but certifi does not.
    """
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
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    rows: list[dict] = []
    offset = 0
    with httpx.Client(timeout=60.0, verify=ctx) as client:
        while True:
            resp = client.get(
                f"{base}/{table}",
                params={
                    "select": "*",
                    "order": order,
                    "limit": str(_PAGE_SIZE),
                    "offset": str(offset),
                },
                headers=headers,
            )
            resp.raise_for_status()
            page = resp.json() or []
            rows.extend(page)
            if len(page) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE
    return rows


def _fetch_all_trades() -> list[dict]:
    """Page through the whole ``trades`` table via PostgREST."""
    return _fetch_all("trades", "trade_id.asc")


def _fetch_all_holdings() -> list[dict]:
    """Page through ``portfolio_holdings`` (current positions, no history)."""
    return _fetch_all("portfolio_holdings", "bioguide_id.asc,ticker.asc")


def _fetch_all_members() -> list[dict]:
    """Page through the ``members`` roster (party/chamber/state/district).

    The members table is cleaner than the trades feed's inline party/chamber
    (single encoding), so P6's member/geography family reads it. Ordered by the
    primary key for stable pagination (§2.5 #5 / plan §5)."""
    return _fetch_all("members", "bioguide_id.asc")


def _fetch_all_pac_donations() -> list[dict]:
    """Page through ``pac_donations`` (bioguide_id, pac_name, amount, cycle).

    A live snapshot with cycle granularity only — no event dates — so the PAC
    family gates on cycle, not a point-in-time timestamp (P6 handoff §2 #4)."""
    return _fetch_all("pac_donations", "id.asc")


def _parse_date_series(series: pd.Series) -> pd.Series:
    """Text ISO dates -> tz-aware UTC Timestamps; unparseable -> NaT.

    Mirrors ``core.util.parse_ms``: naive datetimes are treated as UTC, a
    trailing ``Z`` is honored. ``utc=True`` makes the whole column tz-aware so
    comparisons against an as-of Timestamp are unambiguous.
    """
    return pd.to_datetime(series, errors="coerce", utc=True)


def trades_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize raw trade dicts into the canonical frame used everywhere.

    Pure: given the same rows it always yields the same frame (this is what the
    snapshot hash pins). Parses the text date columns to UTC Timestamps.
    """
    df = pd.DataFrame(rows)
    if df.empty:
        cols = [
            "trade_id", "bioguide_id", "ticker", "transaction_type",
            "asset_type", "transaction_date", "traded", "filed_at",
            "trade_size_usd",
        ]
        empty = pd.DataFrame({c: pd.Series(dtype="object") for c in cols})
        for c in _DATE_COLS:
            empty[c] = pd.Series(dtype="datetime64[ns, UTC]")
        return empty

    for col in _DATE_COLS:
        if col in df.columns:
            df[col] = _parse_date_series(df[col])
    if "ticker" in df.columns:
        df["ticker"] = df["ticker"].astype("string").str.strip().str.upper()
    return df


def _as_timestamp(as_of: date | datetime | str | pd.Timestamp) -> pd.Timestamp:
    """Coerce an as-of value to a tz-aware UTC Timestamp for comparison.

    A bare ``date``/date-string denotes the END of that calendar day in UTC —
    i.e. everything filed on that day is visible. This matters for the maturity
    math and matches how humans read "as of 2026-06-01".
    """
    ts = pd.Timestamp(as_of)
    if ts.tz is None:
        ts = ts.tz_localize("UTC")
    else:
        ts = ts.tz_convert("UTC")
    if ts.normalize() == ts:
        ts = ts + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
    return ts


def trades_as_of(
    frame: pd.DataFrame, as_of: date | datetime | str | pd.Timestamp
) -> pd.DataFrame:
    """All trades KNOWN by ``as_of`` — i.e. ``filed_at <= as_of``.

    This is the only sanctioned way to build a point-in-time view for features.
    Uses ``filed_at`` (disclosure time), NEVER ``transaction_date`` (which is
    unknown until filed). Rows with a null/unparseable ``filed_at`` are dropped:
    they cannot be dated point-in-time.
    """
    cutoff = _as_timestamp(as_of)
    filed = frame["filed_at"]
    mask = filed.notna() & (filed <= cutoff)
    return frame.loc[mask].copy()


def holdings_as_of(holdings: pd.DataFrame, as_of=None) -> pd.DataFrame:
    """Current-position snapshot.

    ``portfolio_holdings`` has no history — it is a live snapshot with no
    point-in-time column — so this is a pass-through today and exists to keep
    the as-of contract uniform (and to hold the line if a dated holdings table
    ever lands). ``as_of`` is accepted and ignored on purpose.
    """
    return holdings.copy()


def label_tickers(
    frame: pd.DataFrame,
    bioguide_id: str,
    as_of: date | datetime | str | pd.Timestamp,
    horizon_days: int = config.HORIZON_DAYS,
) -> set[str]:
    """Tickers ``bioguide_id`` transacts in ``(as_of, as_of + horizon]``.

    Labels use ``transaction_date`` (the actual event time) — post-hoc
    knowledge is legitimate for the target, illegitimate for features. The
    window is left-open / right-closed so an as_of-day trade is not double
    counted with the prior window.
    """
    lo = _as_timestamp(as_of)
    hi = lo + pd.Timedelta(days=horizon_days)
    tx = frame["transaction_date"]
    mask = (
        (frame["bioguide_id"] == bioguide_id)
        & tx.notna()
        & (tx > lo)
        & (tx <= hi)
        & frame["ticker"].notna()
    )
    return set(frame.loc[mask, "ticker"].tolist())


def is_window_mature(
    as_of: date | datetime | str | pd.Timestamp,
    today: date | None = None,
    horizon_days: int = config.HORIZON_DAYS,
) -> bool:
    """True iff the label window at ``as_of`` has fully disclosed by ``today``.

    Guards against scoring windows whose trades may not be filed yet (§2.3).
    Requires ``today >= as_of + horizon + disclosure_lag + late_filer_slack``.
    """
    if today is None:
        today = datetime.now(timezone.utc).date()
    as_of_date = _as_timestamp(as_of).date()
    return as_of_date <= config.maturity_cutoff(today)


def _frame_hash(frame: pd.DataFrame) -> str:
    """Content hash of a frame, stable across process runs.

    Hashes the row-wise value hashes (order-independent within the pinned
    sort) so an upstream Quiver revision surfaces as a changed hash — the whole
    point of snapshotting (§3, §7).
    """
    import numpy as np

    row_hashes = np.sort(pd.util.hash_pandas_object(frame, index=False).to_numpy())
    digest = hashlib.sha256()
    digest.update(row_hashes.tobytes())
    digest.update(json.dumps(sorted(frame.columns.tolist())).encode())
    return digest.hexdigest()[:16]


def snapshot(
    frame: pd.DataFrame,
    snapshots_dir: Path | None = None,
    kind: str = "trades",
) -> tuple[Path, str]:
    """Write ``frame`` to a hash-named parquet and return ``(path, hash)``.

    Idempotent: the same data writes to the same filename, so re-runs reuse the
    existing snapshot instead of piling up copies. ``kind`` is the filename
    prefix (``trades``/``prices``/``profiles``/``members``/``committees``/``pac``)
    so aux frames pin alongside trades under distinct, hash-pinned names — every
    run records its aux hashes for reproducibility (P6 handoff §5).
    """
    snapshots_dir = snapshots_dir or config.SNAPSHOTS_DIR
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    h = _frame_hash(frame)
    path = snapshots_dir / f"{kind}-{h}.parquet"
    if not path.exists():
        frame.to_parquet(path, index=False)
    return path, h


def load_snapshot(path: str | Path) -> pd.DataFrame:
    """Read a pinned parquet snapshot back into the canonical frame."""
    return pd.read_parquet(path)


def build_snapshot_from_db(snapshots_dir: Path | None = None) -> tuple[Path, str]:
    """Fetch all trades from Supabase, normalize, and pin a snapshot.

    Convenience entrypoint for scripts (audit/train). Returns ``(path, hash)``.
    """
    frame = trades_frame(_fetch_all_trades())
    return snapshot(frame, snapshots_dir)


def _norm_ticker_series(series: pd.Series) -> pd.Series:
    """Upper-case/strip tickers so aux data joins the trades feed's convention
    (``trades_frame`` does the same — P6 handoff §5 data-quirks note)."""
    return series.astype("string").str.strip().str.upper()


def members_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize ``members`` roster rows: bioguide_id, party, chamber, state,
    district. Party is normalized to single-letter codes (D/R/I) here because
    the roster is the clean source; peer grouping elsewhere still uses the RAW
    trades ``party`` (P6 handoff §2 #2 — don't change peer semantics)."""
    cols = ["bioguide_id", "party", "chamber", "state", "district"]
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype="string") for c in cols})
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = pd.NA
    df["state"] = df["state"].astype("string").str.strip().str.upper()
    df["chamber"] = df["chamber"].astype("string").str.strip().str.lower()
    df["district"] = df["district"].astype("string").str.strip()
    df["party"] = df["party"].map(normalize_party)
    return df[cols]


def prices_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize daily-close rows into ``(ticker, close_date, close)``.

    ``close_date`` is a tz-aware UTC Timestamp so the market builder can window
    ``close_date <= as_of`` (the #1 §6.1 leakage item). Tickers upper-cased."""
    cols = ["ticker", "close_date", "close"]
    if not rows:
        out = pd.DataFrame({c: pd.Series(dtype="object") for c in cols})
        out["close_date"] = pd.Series(dtype="datetime64[ns, UTC]")
        out["close"] = pd.Series(dtype="float64")
        return out
    df = pd.DataFrame(rows)
    df["ticker"] = _norm_ticker_series(df["ticker"])
    df["close_date"] = _parse_date_series(df["close_date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    return df[cols]


def profiles_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize company-profile rows: ticker, company_name, sector, hq_state,
    market_cap.

    Captures HQ state and market cap (P6 handoff §2 #1 — the backend wrapper
    only kept name/sector/industry; member geography needs HQ state). Keeps
    ``company_name`` so the PAC family can fuzzy-match donor names to tickers."""
    cols = ["ticker", "company_name", "sector", "hq_state", "market_cap"]
    if not rows:
        out = pd.DataFrame({c: pd.Series(dtype="object") for c in cols})
        out["market_cap"] = pd.Series(dtype="float64")
        return out
    df = pd.DataFrame(rows)
    df["ticker"] = _norm_ticker_series(df["ticker"])
    if "company_name" not in df.columns:
        df["company_name"] = pd.NA
    df["company_name"] = df["company_name"].astype("string").str.strip()
    df["sector"] = df["sector"].astype("string").str.strip()
    df["hq_state"] = df["hq_state"].astype("string").str.strip().str.upper()
    df["market_cap"] = pd.to_numeric(df["market_cap"], errors="coerce")
    return df[cols]


def committees_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize committee-assignment rows into ``(bioguide_id, committee)``.

    One row per (member, committee). ``committee`` is a stable committee name
    or code the static committee->sector dict keys on (committee.py)."""
    cols = ["bioguide_id", "committee"]
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype="string") for c in cols})
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = pd.NA
    df["bioguide_id"] = df["bioguide_id"].astype("string").str.strip()
    df["committee"] = df["committee"].astype("string").str.strip()
    return df[cols]


def pac_frame(rows: list[dict]) -> pd.DataFrame:
    """Normalize ``pac_donations`` rows: bioguide_id, pac_name, amount, cycle.

    Cycle-granular, no event dates — the PAC family gates on cycle (donations
    from cycles strictly before the as_of cycle; P6 handoff §2 #4)."""
    cols = ["bioguide_id", "pac_name", "amount", "cycle"]
    if not rows:
        out = pd.DataFrame({c: pd.Series(dtype="object") for c in cols})
        out["amount"] = pd.Series(dtype="float64")
        out["cycle"] = pd.Series(dtype="Int64")
        return out
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = pd.NA
    df["bioguide_id"] = df["bioguide_id"].astype("string").str.strip()
    df["pac_name"] = df["pac_name"].astype("string").str.strip()
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce").fillna(0.0)
    df["cycle"] = pd.to_numeric(df["cycle"], errors="coerce").astype("Int64")
    return df[cols]


def normalize_party(value) -> str | None:
    """Collapse mixed party encodings to a single letter (D/R/I) or None.

    The trades feed mixes 'Republican'/'R', 'Democratic'/'D'; the members table
    is cleaner but still normalized here before any join (P6 handoff §2 #2)."""
    if value is None:
        return None
    s = str(value).strip().upper()
    if not s:
        return None
    if s in ("D", "DEM", "DEMOCRAT", "DEMOCRATIC", "DFL"):
        return "D"
    if s in ("R", "REP", "REPUBLICAN"):
        return "R"
    if s in ("I", "IND", "INDEPENDENT"):
        return "I"
    return None


_ALPACA_BASE_URL = "https://data.alpaca.markets"
_FMP_BASE_URL = "https://financialmodelingprep.com/stable"
PRICE_DELAY_MS = 350


def _market_client():
    import ssl

    import httpx
    import truststore

    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return httpx.Client(timeout=30.0, verify=ctx, follow_redirects=True)


def _fetch_alpaca_daily_closes(
    client, ticker: str, start: str, end: str
) -> list[dict]:
    """Adjusted daily closes for one ticker over [start, end] (ISO dates)."""
    key = os.getenv("ALPACA_KEY")
    secret = os.getenv("ALPACA_SECRET")
    if not key or not secret:
        return []
    resp = client.get(
        f"{_ALPACA_BASE_URL}/v2/stocks/{ticker}/bars",
        params={
            "timeframe": "1Day",
            "start": start,
            "end": end,
            "adjustment": "all",
            "feed": "iex",
            "sort": "asc",
            "limit": "10000",
        },
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
    )
    if resp.status_code >= 400:
        return []
    bars = (resp.json() or {}).get("bars") or []
    return [
        {"ticker": ticker, "close_date": b["t"], "close": b["c"]}
        for b in bars
        if isinstance(b.get("c"), (int, float))
    ]


def _fetch_fmp_profile(client, ticker: str) -> dict | None:
    """FMP company profile -> {ticker, company_name, sector, hq_state,
    market_cap}. Captures HQ state + market cap the backend wrapper drops."""
    key = os.getenv("FMP_API_KEY")
    if not key:
        return None
    resp = client.get(
        f"{_FMP_BASE_URL}/profile", params={"symbol": ticker, "apikey": key}
    )
    if resp.status_code >= 400:
        return None
    rows = resp.json() or []
    p = rows[0] if rows else None
    if not p:
        return None
    return {
        "ticker": ticker,
        "company_name": (p.get("companyName") or "").strip(),
        "sector": (p.get("sector") or "").strip(),
        "hq_state": (p.get("state") or "").strip(),
        "market_cap": p.get("marketCap") or p.get("mktCap"),
    }


def fetch_market_snapshots(
    tickers: list[str],
    start: str,
    end: str,
    snapshots_dir: Path | None = None,
    delay_ms: int = PRICE_DELAY_MS,
) -> dict[str, tuple[Path, str]]:
    """Fetch daily closes + profiles for ``tickers`` and pin two snapshots.

    Returns ``{"prices": (path, hash), "profiles": (path, hash)}``. Politely
    paced (``delay_ms`` between tickers). Tickers with no data are simply
    absent from the frames — the market builder treats a miss as neutral."""
    import time

    price_rows: list[dict] = []
    profile_rows: list[dict] = []
    with _market_client() as client:
        for ticker in tickers:
            price_rows.extend(
                _fetch_alpaca_daily_closes(client, ticker, start, end)
            )
            prof = _fetch_fmp_profile(client, ticker)
            if prof is not None:
                profile_rows.append(prof)
            time.sleep(delay_ms / 1000.0)

    prices = prices_frame(price_rows)
    profiles = profiles_frame(profile_rows)
    return {
        "prices": snapshot(prices, snapshots_dir, kind="prices"),
        "profiles": snapshot(profiles, snapshots_dir, kind="profiles"),
    }


def fetch_profiles_snapshot(
    tickers: list[str],
    snapshots_dir: Path | None = None,
    delay_ms: int = PRICE_DELAY_MS,
) -> tuple[Path, str]:
    """Fetch + pin only company profiles (no price pull). Returns ``(path,
    hash)``. Lets a run re-pin profiles after an FMP quota reset without
    re-pulling the (large, unchanged) close history."""
    import time

    profile_rows: list[dict] = []
    with _market_client() as client:
        for ticker in tickers:
            prof = _fetch_fmp_profile(client, ticker)
            if prof is not None:
                profile_rows.append(prof)
            time.sleep(delay_ms / 1000.0)
    return snapshot(profiles_frame(profile_rows), snapshots_dir, kind="profiles")
