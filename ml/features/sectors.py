"""Pure ticker -> GICS-style sector resolution, shared by market/committee/PAC.

The authoritative sector for a ticker is whatever the profiles snapshot carries
(fetched from FMP); when a ticker is absent from the snapshot we fall back to a
small static map of well-known large-caps so the synthetic tests and cold
tickers still resolve. NO DB import — the profiles frame is handed in.

The 11 GICS sectors used as the canonical vocabulary (matches the backend's
``services/sector_map.py`` labels, so committee->sector keys line up):

    Technology, Communication Services, Consumer Discretionary,
    Consumer Staples, Financials, Health Care, Industrials, Energy,
    Utilities, Real Estate, Materials
"""

from __future__ import annotations
import pandas as pd
from ._sector_data import STATIC_SECTOR as _STATIC_SECTOR


def build_sector_lookup(profiles: pd.DataFrame | None) -> dict[str, str]:
    """{ticker -> sector} from the profiles snapshot, backfilled with the static
    map. Profiles win on conflict (they are the fetched ground truth). Tickers
    are already upper-cased in ``dataset.profiles_frame``; we upper-case the
    static keys to match. Blank/absent sectors are dropped so a lookup miss is
    unambiguous (the caller treats a miss as 'unknown sector')."""
    lookup: dict[str, str] = dict(_STATIC_SECTOR)
    if profiles is not None and not profiles.empty:
        for ticker, sector in zip(profiles["ticker"], profiles["sector"]):
            if isinstance(sector, str) and sector.strip():
                lookup[str(ticker).strip().upper()] = sector.strip()
    return lookup
