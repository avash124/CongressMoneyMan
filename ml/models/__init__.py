"""Scorers: baselines and (later) the LightGBM ranker.

Modules here MUST NOT import the DB layer or ``backend.app`` — enforced by
``ml/tests/test_leakage.py``.
"""
