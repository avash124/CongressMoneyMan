"""Fetch + pin the P6 non-market aux snapshots: members, pac, committees.

    backend/.venv/Scripts/python -m ml.scripts.fetch_aux [--committees]

  - ``members``    : Supabase ``members`` roster (party/chamber/state/district).
  - ``pac``        : Supabase ``pac_donations`` (bioguide_id, pac_name, amount,
                     cycle) — cycle-granular, gated in ``features/pac.py``.
  - ``committees`` : congress.gov current committee assignments per member
                     (one detail request per member, paced). Off by default
                     (slow + needs CONGRESS_API_KEY); pass ``--committees``.

Each frame pins under its own ``<kind>-<hash>.parquet``. Print the hashes and
pass them to ``train_ranker --ablate`` for reproducibility.
"""

from __future__ import annotations

import argparse
import asyncio
import os

from .. import dataset


def _pin(kind: str, frame) -> None:
    path, h = dataset.snapshot(frame, kind=kind)
    print(f"  {kind:11s} {len(frame):6d} rows -> {path.name}  (hash {h})")


async def _fetch_committees(member_ids: list[str]):
    """Fetch congress.gov committee assignments for the given members.

    Imports the backend client at call time (this script is allowed to — it is
    not a feature/model module; the leakage scan does not cover ``scripts/``)."""
    from backend.app.clients.congress import fetch_committee_assignments

    api_key = os.getenv("CONGRESS_API_KEY")
    if not api_key:
        print("  committees   SKIPPED (no CONGRESS_API_KEY)")
        return None
    rows = await fetch_committee_assignments(api_key, member_ids)
    return dataset.committees_frame(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch + pin non-market aux.")
    parser.add_argument(
        "--committees", action="store_true",
        help="Also fetch congress.gov committee assignments (slow).",
    )
    args = parser.parse_args()

    print("Fetching aux from Supabase...")
    members = dataset.members_frame(dataset._fetch_all_members())
    _pin("members", members)
    _pin("pac", dataset.pac_frame(dataset._fetch_all_pac_donations()))

    if args.committees:
        member_ids = [
            b for b in members["bioguide_id"].dropna().astype(str).tolist() if b
        ]
        committees = asyncio.run(_fetch_committees(member_ids))
        if committees is not None:
            _pin("committees", committees)

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
