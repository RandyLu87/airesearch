#!/usr/bin/env python3
"""Validate company directories, canonical snapshots, and retained legacy notes."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path


COMPANY_PATTERNS = (
    re.compile(r"^hk-\d{4,5}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
    re.compile(r"^us-[a-z][a-z0-9]{0,9}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
    re.compile(r"^(?:sh|sz|bj)-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
)
ANALYSIS_PATTERN = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<time>\d{4})-analysis\.(?P<extension>md|json)$"
)


def validate_timestamp(file_path: Path, match: re.Match[str], root: Path) -> str | None:
    timestamp = match.group("date") + "-" + match.group("time")
    try:
        datetime.strptime(timestamp, "%Y-%m-%d-%H%M")
    except ValueError:
        return f"研究文件日期或时间无效：{file_path.relative_to(root)}"
    return None


def validate_snapshot(snapshot: Path, company_id: str, root: Path) -> list[str]:
    errors: list[str] = []
    match = ANALYSIS_PATTERN.fullmatch(snapshot.name)
    if not match or match.group("extension") != "json":
        return [
            f"研究快照命名不合规：{snapshot.relative_to(root)}；"
            "应使用 YYYY-MM-DD-HHMM-analysis.json。"
        ]

    timestamp_error = validate_timestamp(snapshot, match, root)
    if timestamp_error:
        errors.append(timestamp_error)
        return errors

    try:
        data = json.loads(snapshot.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"研究快照不是有效 JSON：{snapshot.relative_to(root)}；{exc}"]

    expected_id = snapshot.stem
    if data.get("schemaVersion") != "1.0.0":
        errors.append(f"研究快照 schemaVersion 必须为 1.0.0：{snapshot.relative_to(root)}")
    if data.get("company", {}).get("id") != company_id:
        errors.append(f"研究快照 company.id 与目录不一致：{snapshot.relative_to(root)}")
    if data.get("snapshot", {}).get("id") != expected_id:
        errors.append(f"研究快照 snapshot.id 与文件名不一致：{snapshot.relative_to(root)}")
    source_note = data.get("snapshot", {}).get("sourceNote")
    if source_note and not (snapshot.parent.parent / source_note).is_file():
        errors.append(f"研究快照 sourceNote 不存在：{snapshot.relative_to(root)} -> {source_note}")
    return errors


def validate(root: Path) -> list[str]:
    companies = root / "research" / "companies"
    errors: list[str] = []

    if not companies.is_dir():
        return ["缺少 research/companies/ 目录。"]

    for entry in sorted(companies.iterdir()):
        if entry.name == ".DS_Store":
            continue
        if not entry.is_dir():
            errors.append(f"公司目录根部不允许文件：{entry.relative_to(root)}")
            continue
        if not any(pattern.fullmatch(entry.name) for pattern in COMPANY_PATTERNS):
            errors.append(
                "公司目录命名不合规："
                f"{entry.relative_to(root)}；应使用 hk-<4至5位代码>-<slug>、"
                "us-<小写代码>-<slug> 或 sh|sz|bj-<6位代码>-<slug>。"
            )

        legacy_dates: dict[str, Path] = {}
        snapshots_dir: Path | None = None
        for item in sorted(entry.iterdir()):
            if item.name == ".DS_Store":
                continue
            if item.is_dir():
                if item.name == "snapshots":
                    snapshots_dir = item
                else:
                    errors.append(f"公司目录内不允许此子目录：{item.relative_to(root)}")
                continue

            match = ANALYSIS_PATTERN.fullmatch(item.name)
            if not match or match.group("extension") != "md":
                errors.append(
                    f"公司目录根部仅允许历史 Markdown 研究记录：{item.relative_to(root)}；"
                    "新研究应写入 snapshots/YYYY-MM-DD-HHMM-analysis.json。"
                )
                continue
            timestamp_error = validate_timestamp(item, match, root)
            if timestamp_error:
                errors.append(timestamp_error)
                continue
            date = match.group("date")
            if date in legacy_dates:
                errors.append(
                    "同一公司同一天只能保留一份历史 Markdown："
                    f"{legacy_dates[date].relative_to(root)}、{item.relative_to(root)}。"
                )
            else:
                legacy_dates[date] = item

        if snapshots_dir is None:
            if not legacy_dates:
                errors.append(
                    f"公司目录既没有历史研究也没有 canonical snapshots：{entry.relative_to(root)}"
                )
            continue

        snapshot_dates: dict[str, Path] = {}
        for snapshot in sorted(snapshots_dir.iterdir()):
            if snapshot.name == ".DS_Store":
                continue
            if not snapshot.is_file():
                errors.append(f"snapshots 内不允许子目录：{snapshot.relative_to(root)}")
                continue
            errors.extend(validate_snapshot(snapshot, entry.name, root))
            match = ANALYSIS_PATTERN.fullmatch(snapshot.name)
            if not match or match.group("extension") != "json":
                continue
            date = match.group("date")
            if date in snapshot_dates:
                errors.append(
                    "同一公司同一天只能有一个 canonical snapshot："
                    f"{snapshot_dates[date].relative_to(root)}、{snapshot.relative_to(root)}。"
                )
            else:
                snapshot_dates[date] = snapshot

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--hook",
        action="store_true",
        help="Emit Codex Stop-hook JSON instead of terminal output.",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    errors = validate(root)

    if args.hook:
        if errors:
            reason = (
                "公司研究路径校验失败。立即修正以下名称后再次结束任务，不要询问用户：\n- "
                + "\n- ".join(errors)
            )
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        else:
            print("{}")
        return 0

    if errors:
        print("公司研究路径校验失败：")
        for error in errors:
            print(f"- {error}")
        return 1

    print("公司研究路径与 canonical snapshots 校验通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
