#!/usr/bin/env python3
"""Validate company research directories and analysis filenames."""

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
    r"^(?P<date>\d{4}-\d{2}-\d{2})-(?P<time>\d{4})-analysis\.md$"
)


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

        dates_seen: dict[str, Path] = {}
        for note in sorted(entry.iterdir()):
            if note.name == ".DS_Store":
                continue
            if not note.is_file():
                errors.append(f"公司目录内不允许子目录：{note.relative_to(root)}")
                continue

            match = ANALYSIS_PATTERN.fullmatch(note.name)
            if not match:
                errors.append(
                    f"研究文件命名不合规：{note.relative_to(root)}；"
                    "应使用 YYYY-MM-DD-HHMM-analysis.md。"
                )
                continue

            timestamp = match.group("date") + "-" + match.group("time")
            try:
                datetime.strptime(timestamp, "%Y-%m-%d-%H%M")
            except ValueError:
                errors.append(f"研究文件日期或时间无效：{note.relative_to(root)}")
                continue

            date = match.group("date")
            previous = dates_seen.get(date)
            if previous is not None:
                errors.append(
                    "同一公司同一天只能有一个研究文件："
                    f"{previous.relative_to(root)}、{note.relative_to(root)}；"
                    "后续更新应追加到当天已有文件。"
                )
            else:
                dates_seen[date] = note

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

    print("公司研究路径命名校验通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
