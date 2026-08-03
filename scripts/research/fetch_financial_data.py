#!/usr/bin/env python3
"""Build auditable SEC or Tushare data packs for company research."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CATALOG_PATH = Path(__file__).with_name("api-catalog.json")


class FetchError(RuntimeError):
    pass


def load_catalog() -> Dict[str, Any]:
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FetchError(f"无法读取 API 目录 {CATALOG_PATH}: {error}") from error
    if catalog.get("schema_version") != 1:
        raise FetchError("API 目录 schema_version 不受支持。")
    if not isinstance(catalog.get("sec"), dict):
        raise FetchError("API 目录缺少 sec 配置。")
    tushare = catalog.get("tushare")
    if not isinstance(tushare, dict) or not isinstance(tushare.get("profiles"), dict):
        raise FetchError("API 目录缺少 tushare.profiles 配置。")
    return catalog


API_CATALOG = load_catalog()
SEC_CONFIG = API_CATALOG["sec"]
TUSHARE_CONFIG = API_CATALOG["tushare"]
TUSHARE_PROFILES: Dict[str, List[Dict[str, Any]]] = TUSHARE_CONFIG["profiles"]
DEFAULT_FORMS = ",".join(SEC_CONFIG["default_forms"])


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def path_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def catalog_metadata() -> Dict[str, Any]:
    encoded = CATALOG_PATH.read_bytes()
    return {
        "schema_version": API_CATALOG["schema_version"],
        "path": "scripts/research/api-catalog.json",
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def safe_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-")
    if not cleaned:
        raise FetchError("证券代码或标签为空。")
    return cleaned.lower()


def validate_date(value: Optional[str]) -> None:
    if value is not None and not re.fullmatch(r"\d{8}", value):
        raise FetchError(f"日期必须使用 YYYYMMDD：{value}")


def write_json(path: Path, payload: Any) -> Dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    path.write_bytes(encoded)
    return {
        "path": str(path),
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def request_json(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    payload: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
    max_attempts: int = 3,
) -> Any:
    body = None
    method = "GET"
    final_headers = {"Accept": "application/json"}
    if headers:
        final_headers.update(headers)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        method = "POST"
        final_headers["Content-Type"] = "application/json"

    for attempt in range(1, max_attempts + 1):
        request = Request(url, data=body, headers=final_headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            retryable = error.code == 429 or 500 <= error.code < 600
            if retryable and attempt < max_attempts:
                retry_after = error.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else 2 ** (attempt - 1)
                except ValueError:
                    delay = 2 ** (attempt - 1)
                time.sleep(min(max(delay, 0.0), 30.0))
                continue
            raise FetchError(f"HTTP {error.code} {url}: {detail}") from error
        except URLError as error:
            if attempt < max_attempts:
                time.sleep(2 ** (attempt - 1))
                continue
            raise FetchError(f"无法访问 {url}: {error.reason}") from error
        except json.JSONDecodeError as error:
            raise FetchError(f"接口未返回有效 JSON：{url}") from error

    raise FetchError(f"无法访问 {url}。")


def git_email() -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "config", "--get", "user.email"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    email = result.stdout.strip()
    return email if "@" in email else None


def sec_user_agent() -> str:
    configured = os.environ.get("SEC_USER_AGENT", "").strip()
    if configured:
        return configured
    email = git_email()
    if email:
        return f"airesearch/1.0 {email}"
    raise FetchError(
        "SEC 要求可识别 User-Agent。请设置 SEC_USER_AGENT，"
        "或配置 git config user.email。"
    )


def resolve_sec_company(ticker_payload: Dict[str, Any], ticker: str) -> Dict[str, Any]:
    fields = ticker_payload.get("fields")
    rows = ticker_payload.get("data")
    if not isinstance(fields, list) or not isinstance(rows, list):
        raise FetchError("SEC ticker 映射结构不符合预期。")

    wanted = ticker.upper()
    for row in rows:
        record = dict(zip(fields, row))
        if str(record.get("ticker", "")).upper() == wanted:
            return record
    raise FetchError(f"SEC ticker 映射中未找到 {wanted}。")


def normalize_sec_filings(
    submissions: Dict[str, Any], forms: Iterable[str]
) -> List[Dict[str, Any]]:
    recent = submissions.get("filings", {}).get("recent", {})
    accessions = recent.get("accessionNumber", [])
    if not isinstance(accessions, list):
        raise FetchError("SEC submissions.recent.accessionNumber 结构不符合预期。")
    wanted = set(forms)
    result: List[Dict[str, Any]] = []
    cik = str(int(submissions["cik"]))

    required_fields = [
        "form",
        "filingDate",
        "reportDate",
        "acceptanceDateTime",
        "primaryDocument",
    ]
    for field in required_fields:
        values = recent.get(field)
        if not isinstance(values, list) or len(values) != len(accessions):
            raise FetchError(f"SEC submissions.recent.{field} 长度不符合预期。")

    descriptions = recent.get("primaryDocDescription")
    if not isinstance(descriptions, list) or len(descriptions) != len(accessions):
        descriptions = [""] * len(accessions)

    for index, accession in enumerate(accessions):
        form = recent["form"][index]
        if wanted and form not in wanted:
            continue
        primary_document = recent["primaryDocument"][index]
        accession_compact = accession.replace("-", "")
        result.append(
            {
                "form": form,
                "filing_date": recent["filingDate"][index],
                "report_date": recent["reportDate"][index],
                "acceptance_datetime": recent["acceptanceDateTime"][index],
                "accession_number": accession,
                "primary_document": primary_document,
                "primary_doc_description": descriptions[index],
                "url": (
                    SEC_CONFIG["archive_url_template"].format(
                        cik=cik,
                        accession=accession_compact,
                        document=primary_document,
                    )
                ),
            }
        )
    return result


def fetch_sec(args: argparse.Namespace) -> int:
    user_agent = sec_user_agent()
    headers = {"User-Agent": user_agent}
    output_root = Path(args.output_root)

    ticker = args.ticker.upper() if args.ticker else None
    ticker_map = None
    if args.cik:
        cik = str(int(args.cik)).zfill(10)
    else:
        ticker_map = request_json(SEC_CONFIG["ticker_exchange_url"], headers=headers)
        company = resolve_sec_company(ticker_map, ticker)
        cik = str(int(company["cik"])).zfill(10)

    submissions_url = SEC_CONFIG["submissions_url_template"].format(cik=cik)
    companyfacts_url = SEC_CONFIG["companyfacts_url_template"].format(cik=cik)
    interval = SEC_CONFIG["request_interval_seconds"]
    time.sleep(interval)
    submissions = request_json(submissions_url, headers=headers)
    time.sleep(interval)
    companyfacts = None
    errors = []
    try:
        companyfacts = request_json(companyfacts_url, headers=headers)
    except FetchError as error:
        errors.append({"dataset": "companyfacts", "error": str(error)})

    submission_tickers = submissions.get("tickers") or [cik]
    resolved_ticker = ticker or str(submission_tickers[0]).upper()
    run_dir = output_root / f"us-{safe_component(resolved_ticker)}" / path_stamp()
    files = []
    sources = [submissions_url]
    if ticker_map is not None:
        files.append(write_json(run_dir / "sec-company-tickers.json", ticker_map))
        sources.insert(0, SEC_CONFIG["ticker_exchange_url"])
    files.append(write_json(run_dir / "sec-submissions.json", submissions))
    if companyfacts is not None:
        files.append(write_json(run_dir / "sec-companyfacts.json", companyfacts))
        sources.append(companyfacts_url)

    forms = [item.strip() for item in args.forms.split(",") if item.strip()]
    filings = normalize_sec_filings(submissions, forms)
    files.append(write_json(run_dir / "sec-filings.json", filings))

    manifest = {
        "schema_version": 1,
        "provider": SEC_CONFIG["provider"],
        "market": "us",
        "symbol": resolved_ticker,
        "cik": cik,
        "fetched_at": utc_now(),
        "forms": forms,
        "sources": sources,
        "api_catalog": catalog_metadata(),
        "files": files,
        "errors": errors,
        "caveats": [
            "companyfacts excludes company-specific extension taxonomies and many segment facts",
            "read the original filing and notes before using a fact in an investment conclusion",
        ],
    }
    write_json(run_dir / "manifest.json", manifest)
    write_json(run_dir.parent / "latest.json", {"run_dir": str(run_dir), **manifest})
    print(run_dir)
    if errors:
        print("warning: companyfacts failed; inspect manifest.json", file=sys.stderr)
    return 0


def normalize_tushare(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = response.get("data") or {}
    fields = data.get("fields") or []
    items = data.get("items") or []
    return [dict(zip(fields, item)) for item in items]


def tushare_query(token: str, api_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
    response = request_json(
        TUSHARE_CONFIG["endpoint"],
        payload={
            "api_name": api_name,
            "token": token,
            "params": params,
            "fields": "",
        },
    )
    if not isinstance(response, dict):
        raise FetchError(f"Tushare {api_name} 返回结构不符合预期。")
    if response.get("code") != 0:
        raise FetchError(
            f"Tushare {api_name} 失败：code={response.get('code')} "
            f"msg={response.get('msg')}"
        )
    return response


def fetch_tushare(args: argparse.Namespace) -> int:
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token:
        raise FetchError(
            "未设置 TUSHARE_TOKEN。请把 token 放入环境变量，不要写入仓库或命令参数。"
        )
    validate_date(args.start_date)
    validate_date(args.end_date)

    output_root = Path(args.output_root)
    run_dir = (
        output_root
        / f"{args.market}-{safe_component(args.symbol)}"
        / path_stamp()
    )
    files = []
    errors = []
    sources = []

    for dataset in TUSHARE_PROFILES[args.market]:
        api_name = dataset["api"]
        params: Dict[str, Any] = {"ts_code": args.symbol}
        if dataset.get("dated"):
            if args.start_date:
                params["start_date"] = args.start_date
            if args.end_date:
                params["end_date"] = args.end_date
        try:
            response = tushare_query(token, api_name, params)
            normalized = normalize_tushare(response)
            files.append(write_json(run_dir / f"{api_name}.raw.json", response))
            files.append(write_json(run_dir / f"{api_name}.json", normalized))
            sources.append(
                {
                    "api": api_name,
                    "endpoint": TUSHARE_CONFIG["endpoint"],
                    "rows": len(normalized),
                }
            )
        except FetchError as error:
            errors.append(
                {"api": api_name, "error": str(error).replace(token, "<redacted>")}
            )
        time.sleep(TUSHARE_CONFIG["request_interval_seconds"])

    manifest = {
        "schema_version": 1,
        "provider": TUSHARE_CONFIG["provider"],
        "market": args.market,
        "symbol": args.symbol,
        "fetched_at": utc_now(),
        "requested_range": {
            "start_date": args.start_date,
            "end_date": args.end_date,
        },
        "sources": sources,
        "api_catalog": catalog_metadata(),
        "files": files,
        "errors": errors,
        "caveats": [
            "Tushare is a secondary normalized data source, not a regulatory filing source",
            "verify latest period, currency, units, restatements and key figures against original filings",
        ],
    }
    write_json(run_dir / "manifest.json", manifest)
    write_json(run_dir.parent / "latest.json", {"run_dir": str(run_dir), **manifest})
    print(run_dir)
    if errors:
        print(f"warning: {len(errors)} dataset(s) failed; inspect manifest.json", file=sys.stderr)
    return 0 if files else 2


def self_test() -> int:
    sample_tushare = {
        "code": 0,
        "data": {"fields": ["symbol", "value"], "items": [["X", 1], ["Y", 2]]},
    }
    assert normalize_tushare(sample_tushare) == [
        {"symbol": "X", "value": 1},
        {"symbol": "Y", "value": 2},
    ]

    sample_tickers = {
        "fields": ["cik", "name", "ticker", "exchange"],
        "data": [[123, "Example", "EXM", "NYSE"]],
    }
    assert resolve_sec_company(sample_tickers, "exm")["cik"] == 123

    sample_submissions = {
        "cik": "123",
        "filings": {
            "recent": {
                "accessionNumber": ["0000000123-26-000001"],
                "form": ["10-K"],
                "filingDate": ["2026-01-01"],
                "reportDate": ["2025-12-31"],
                "acceptanceDateTime": ["2026-01-01T12:00:00.000Z"],
                "primaryDocument": ["example.htm"],
                "primaryDocDescription": ["Annual report"],
            }
        },
    }
    filings = normalize_sec_filings(sample_submissions, ["10-K"])
    assert filings[0]["url"].endswith("/123/000000012326000001/example.htm")
    assert set(TUSHARE_PROFILES) == {"a", "hk", "us"}
    assert TUSHARE_CONFIG["endpoint"].startswith("https://")
    assert SEC_CONFIG["submissions_url_template"].startswith("https://data.sec.gov/")
    metadata = catalog_metadata()
    assert not Path(metadata["path"]).is_absolute()
    assert len(metadata["sha256"]) == 64
    print("self-test: OK")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", default="tmp/data")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sec = subparsers.add_parser("sec", help="Fetch official SEC filings and XBRL facts")
    identity = sec.add_mutually_exclusive_group(required=True)
    identity.add_argument("--ticker")
    identity.add_argument("--cik")
    sec.add_argument("--forms", default=DEFAULT_FORMS)
    sec.set_defaults(handler=fetch_sec)

    tushare = subparsers.add_parser(
        "tushare", help="Fetch a fixed market snapshot through Tushare Pro"
    )
    tushare.add_argument("--market", choices=sorted(TUSHARE_PROFILES), required=True)
    tushare.add_argument("--symbol", required=True)
    tushare.add_argument("--start-date")
    tushare.add_argument("--end-date")
    tushare.set_defaults(handler=fetch_tushare)

    test = subparsers.add_parser("self-test", help="Run deterministic offline checks")
    test.set_defaults(handler=lambda _args: self_test())
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.handler(args)
    except FetchError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
