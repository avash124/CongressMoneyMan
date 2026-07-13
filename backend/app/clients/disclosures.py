"""Congressional annual Financial Disclosure (FD) client.

Fills the net-worth gap Quiver leaves for members who don't trade individual
stocks. Every member of Congress files an annual FD listing all assets in value
ranges; summing the asset-range midpoints yields a gross-net-worth estimate,
the same methodology OpenSecrets uses. This is the only source that covers 100%
of Congress, since it derives from mandatory filings rather than stock trades.

Two disclosure systems, one per chamber:

- House: the Clerk publishes a public ZIP index of the year's filings plus one
  public PDF per filing (disclosures-clerk.house.gov). No auth.
- Senate: the eFD portal requires accepting a one-time agreement to get a
  session cookie, then exposes a search API returning HTML reports
  (efdsearch.senate.gov). Reports are HTML tables, not PDFs.

Estimates are gross assets (FD reports assets and liabilities separately; we do
not subtract liabilities because their ranges are far coarser and often blank),
so they run higher than Quiver's mark-to-market net figure. They are annual
snapshots, hence the `as_of` year the caller can surface.
"""

import io
import logging
import re
import zipfile
from datetime import date

from ..core.http import shared_client

logger = logging.getLogger("disclosures")


_RANGE = re.compile(r"\$([\d,]+)\s*-\s*\$([\d,]+)")
_ASSET_CODE = re.compile(r"\[[A-Z]{2}\]")


def _midpoint(low: str, high: str) -> float:
    return (int(low.replace(",", "")) + int(high.replace(",", ""))) / 2


_HOUSE_ZIP_URL = (
    "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP"
)
_HOUSE_PDF_URL = (
    "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}/{doc_id}.pdf"
)
_ANNUAL_FILING_TYPE = "O"


async def house_annual_filings(year: int) -> list[dict]:
    """Return one entry per House member annual FD filing for `year`:
    {"first", "last", "state_dst", "doc_id"}."""
    response = await shared_client().get(_HOUSE_ZIP_URL.format(year=year))
    if response.status_code >= 400:
        logger.warning("house FD index %s -> HTTP %s", year, response.status_code)
        return []

    archive = zipfile.ZipFile(io.BytesIO(response.content))
    index_name = f"{year}FD.txt"
    if index_name not in archive.namelist():
        logger.warning("house FD index %s missing %s", year, index_name)
        return []

    lines = archive.read(index_name).decode("utf-8-sig").splitlines()
    if not lines:
        return []
    header = lines[0].split("\t")
    filings = []
    for line in lines[1:]:
        if not line.strip():
            continue
        row = dict(zip(header, line.split("\t")))
        if row.get("FilingType") != _ANNUAL_FILING_TYPE:
            continue
        filings.append(
            {
                "first": row.get("First", "").strip(),
                "last": row.get("Last", "").strip(),
                "state_dst": row.get("StateDst", "").strip(),
                "doc_id": row.get("DocID", "").strip(),
            }
        )
    return filings


def _estimate_from_house_text(text: str) -> tuple[float, int]:
    """Sum asset-value midpoints from an extracted House FD PDF.

    Slice to Schedule A (the asset schedule) so trailing sections' dollar
    figures can't leak in, then take the first range after each asset-type code.
    """
    header = re.search(r"Value of Asset", text)
    start = header.end() if header else 0
    section_b = re.search(r"S\s*B\s*:", text[start:])
    body = text[start : start + section_b.start()] if section_b else text[start:]

    total = 0.0
    count = 0
    for block in _ASSET_CODE.split(body)[1:]:
        match = _RANGE.search(block)
        if match:
            total += _midpoint(*match.groups())
            count += 1
    return total, count


async def house_net_worth(doc_id: str, year: int) -> tuple[float, int] | None:
    """Download and parse one House FD PDF into (estimate, asset_count).

    A minority of members submit scanned/image PDFs with no text layer; those
    extract to near-empty text and yield a zero asset count, which the caller
    treats as a miss (OCR would be needed to recover them)."""
    from pypdf import PdfReader

    response = await shared_client().get(
        _HOUSE_PDF_URL.format(year=year, doc_id=doc_id)
    )
    if response.status_code >= 400:
        return None
    try:
        reader = PdfReader(io.BytesIO(response.content))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as error:
        logger.warning("house FD PDF %s parse failed: %s", doc_id, error)
        return None
    return _estimate_from_house_text(text)


_EFD_BASE = "https://efdsearch.senate.gov"
_EFD_HOME = f"{_EFD_BASE}/search/home/"
_EFD_SEARCH = f"{_EFD_BASE}/search/report/data/"
_CSRF = re.compile(r'name="csrfmiddlewaretoken" value="([^"]+)"')
_HREF = re.compile(r'href="([^"]+)"')
_TAGS = re.compile(r"<[^>]+>")


async def _efd_accept_agreement() -> str | None:
    """Accept the eFD prohibition agreement to unlock the search API; returns
    the CSRF token to reuse for the search POST. The session cookie is stored on
    the shared client. Returns None if the flow can't complete."""
    client = shared_client()
    home = await client.get(_EFD_HOME)
    token_match = _CSRF.search(home.text)
    if not token_match:
        return None
    token = token_match.group(1)
    await client.post(
        _EFD_HOME,
        data={"csrfmiddlewaretoken": token, "prohibition_agreement": "1"},
        headers={"Referer": _EFD_HOME},
    )
    return client.cookies.get("csrftoken") or token


async def senate_annual_filings(year: int) -> list[dict]:
    """Return one entry per sitting-senator annual FD filing for `year`:
    {"first", "last", "report_url"}. Skips candidate reports."""
    token = await _efd_accept_agreement()
    if not token:
        logger.warning("senate eFD agreement flow failed")
        return []

    client = shared_client()
    filings: list[dict] = []
    start = 0
    page_size = 100
    while True:
        response = await client.post(
            _EFD_SEARCH,
            data={
                "csrfmiddlewaretoken": token,
                "start": str(start),
                "length": str(page_size),
                "report_types": "[7]",
                "filer_types": "[]",
                "submitted_start_date": f"01/01/{year} 00:00:00",
                "submitted_end_date": "",
                "candidate_state": "",
                "senator_state": "",
                "office_id": "",
                "first_name": "",
                "last_name": "",
            },
            headers={
                "Referer": f"{_EFD_BASE}/search/",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        if response.status_code >= 400:
            break
        payload = response.json()
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            filer_type = row[2] if len(row) > 2 else ""
            if "Senator" not in filer_type:
                continue
            link = row[3] if len(row) > 3 else ""
            href = _HREF.search(link)
            if not href or "/annual/" not in href.group(1):
                continue
            filings.append(
                {
                    "first": (row[0] or "").strip(),
                    "last": (row[1] or "").strip(),
                    "report_url": _EFD_BASE + href.group(1),
                }
            )
        if len(rows) < page_size:
            break
        start += page_size
    return filings


def _estimate_from_senate_html(html: str) -> tuple[float, int]:
    """Sum asset-value midpoints from a Senate annual report's HTML.

    The report lists assets in a "List of assets" table before the
    "Transactions" section; slice to that window so transaction and liability
    figures don't leak in, then sum every value range.
    """
    text = re.sub(r"\s+", " ", _TAGS.sub(" ", html))
    start_match = re.search(r"List of assets", text)
    start = start_match.end() if start_match else 0
    end_match = re.search(r"Part 4|Transactions", text[start:])
    body = text[start : start + end_match.start()] if end_match else text[start:]

    total = 0.0
    count = 0
    for match in _RANGE.finditer(body):
        total += _midpoint(*match.groups())
        count += 1
    return total, count


async def senate_net_worth(report_url: str) -> tuple[float, int] | None:
    """Fetch and parse one Senate annual report into (estimate, asset_count)."""
    response = await shared_client().get(
        report_url, headers={"Referer": f"{_EFD_BASE}/search/"}
    )
    if response.status_code >= 400:
        return None
    return _estimate_from_senate_html(response.text)


def candidate_filing_years() -> list[int]:
    """Filing years to try, newest first. A calendar year's FDs are submitted
    the following year (deadline mid-May, extensions later), and the Clerk names
    each ZIP by submission year. So this year's ZIP may exist yet hold few or no
    annual reports until they land; the caller tries these in order and merges,
    preferring the newest filing that actually covers a member."""
    this_year = date.today().year
    return [this_year, this_year - 1, this_year - 2]
