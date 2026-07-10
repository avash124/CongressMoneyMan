"""Shared async HTTP client for all outbound requests."""

import ssl

import httpx
import truststore

_client: httpx.AsyncClient | None = None


def shared_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Verify TLS against the OS trust store instead of certifi's bundle, so
        # corporate/antivirus HTTPS interception (whose CA lives in the OS
        # store) doesn't break every outbound request.
        _client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
