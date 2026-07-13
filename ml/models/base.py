"""The Scorer interface every model implements (plan §2.7).

    score(member_id, as_of, candidates) -> list[float]   # aligned to candidates

The four baselines, the candidate generator (scored at recall@k), the future
LightGBM ranker, and any later model all implement this, so the eval harness is
written once.

A scorer needs point-in-time data to score, but must NOT fetch it itself (that
is the DB-import ban, §2.2). Instead the harness hands each scorer the as-of
frame once per fold via ``prepare(as_of_frame, as_of)`` before calling
``score`` for each member. Stateless scorers can ignore ``prepare``.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol, runtime_checkable

import pandas as pd


@runtime_checkable
class Scorer(Protocol):
    name: str

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        """Cache whatever fold-level state scoring needs. ``as_of_frame`` is the
        output of ``dataset.trades_as_of`` — already leak-safe. Called once per
        fold before any ``score`` call."""
        ...

    def score(
        self, member_id: str, as_of: date, candidates: list[str]
    ) -> list[float]:
        """Return one score per candidate ticker, in ``candidates`` order.
        Higher = more likely the member trades it in the horizon."""
        ...


class BaseScorer:
    """Optional mixin: a no-op ``prepare`` and a name default, so simple
    scorers only implement ``score``."""

    name: str = "base"

    def prepare(self, as_of_frame: pd.DataFrame, as_of: date) -> None:
        self._frame = as_of_frame

    def score(
        self, member_id: str, as_of: date, candidates: list[str]
    ) -> list[float]:
        raise NotImplementedError
