"""Offline ML package: congressional-trade prediction.

Reads Supabase via its own thin connection (``ml/dataset.py``) using the same
env vars as the backend, but must NOT import ``backend.app`` — this keeps the
package independently runnable and makes the no-DB-imports leakage test a simple
static check over ``ml/features/`` and ``ml/models/``.
"""
