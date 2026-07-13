"""Pure feature builders: as-of frame -> feature columns (plan §2.5).

P5 families (history + popularity), all reading only the as-of frame:
  - ``history``    : member-level + member×ticker trading-history features
  - ``holdings``   : net-position features from as-of trades
  - ``popularity`` : peer/chamber/global trailing herding counts (long + fresh)
  - ``build``      : the assembler — combines the above into one feature matrix
                     per (member, candidates), plus the candidate-list rank prior

Modules here MUST NOT import the DB layer or ``backend.app`` — leakage defense
is enforced by ``ml/tests/test_leakage.py`` (no-DB-imports scan). In particular
they must NOT read the cached ``trade_features`` table (full-history -> leaks);
the same stats are recomputed as-of from ``dataset.trades_as_of`` output.
"""
