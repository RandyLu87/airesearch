#!/usr/bin/env python3
"""Validate company directories, canonical snapshots, and retained legacy notes."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
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
    # 1.1.0 是以立场、合理价值和操作区间开篇的契约，1.0.0 更早。两者仅供已发布的
    # 历史快照原样保留，不回填；新研究一律 1.2.0。见 ADR-0017、ADR-0021。
    if data.get("schemaVersion") not in {"1.0.0", "1.1.0", "1.2.0"}:
        errors.append(
            f"研究快照 schemaVersion 必须为 1.2.0（历史快照可保留 1.1.0 或 1.0.0）："
            f"{snapshot.relative_to(root)}"
        )
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
        ledger: Path | None = None
        for item in sorted(entry.iterdir()):
            if item.name == ".DS_Store":
                continue
            if item.is_dir():
                if item.name == "snapshots":
                    snapshots_dir = item
                else:
                    errors.append(f"公司目录内不允许此子目录：{item.relative_to(root)}")
                continue

            if item.name == "financials.json":
                ledger = item
                continue

            # 承诺台账与财报账本同级：管理层说过的话跨期结算，一次录入长期
            # 复用。缺它不报错——刚上市的公司可能确实没有可录入的承诺——
            # 但存在时必须合法，由 node 校验器逐字段比对。见 ADR-0019。
            if item.name == "commitments.json":
                continue

            match = ANALYSIS_PATTERN.fullmatch(item.name)
            if not match or match.group("extension") != "md":
                errors.append(
                    f"公司目录根部仅允许历史 Markdown 研究记录、financials.json "
                    f"与 commitments.json：{item.relative_to(root)}；"
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

        # 有快照就必须有账本：报告期取数昂贵（港股只能人工从 PDF 抠），
        # 丢一次就得重抠一次。硬约束放在这里而不是每份合成快照上。
        if ledger is None:
            errors.append(
                f"公司目录有 canonical snapshots 但缺少财报期间账本："
                f"{(entry / 'financials.json').relative_to(root)}；"
                "见 docs/adr/0014-commit-a-financial-period-ledger.md。"
            )

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


def find_repo_root() -> Path:
    """Walk up from this file to the workspace root.

    Deliberately not a fixed number of `parents[...]` hops: this script has
    already moved once, and a level count would fail silently the next time.
    """
    for candidate in Path(__file__).resolve().parents:
        manifest = candidate / "package.json"
        if not manifest.is_file():
            continue
        try:
            if isinstance(json.loads(manifest.read_text(encoding="utf-8")).get("workspaces"), list):
                return candidate
        except (OSError, json.JSONDecodeError):
            continue
    raise SystemExit("无法定位仓库根目录（未找到带 workspaces 的 package.json）。")


def validate_snapshot_contents(repo_root: Path, data_root: Path) -> tuple[list[str], list[str]]:
    """Delegate schema and cross-snapshot comparability to the shared checker.

    Naming rules live here; the meaning of the data lives in the Zod schema.
    Shelling out keeps exactly one definition of each.
    """
    checker = repo_root / "packages" / "research-schema" / "src" / "cli" / "check-snapshot.ts"
    if not checker.is_file():
        return [f"缺少研究快照校验器：{checker}"], []

    try:
        completed = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                str(checker),
                "--all",
                "--root",
                str(data_root),
                "--json",
            ],
            capture_output=True,
            text=True,
            # Must stay comfortably under the Stop-hook budget in
            # .codex/hooks.json and .claude/settings.json, or the hook is
            # killed before this timeout can report anything useful.
            timeout=45,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return [f"无法运行研究快照校验器：{error}"], []

    if completed.returncode != 0:
        return [f"研究快照校验器异常退出：{completed.stderr.strip() or completed.returncode}"], []
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        return [f"研究快照校验器输出不是有效 JSON：{error}"], []
    return (
        [str(message) for message in payload.get("errors", [])],
        [str(message) for message in payload.get("warnings", [])],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--hook",
        action="store_true",
        help="Emit Stop-hook JSON instead of terminal output.",
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Validate an alternative research tree instead of this repository.",
    )
    args = parser.parse_args()

    repo_root = find_repo_root()
    root = Path(args.root).resolve() if args.root else repo_root
    errors = validate(root)
    snapshot_errors, warnings = validate_snapshot_contents(repo_root, root)
    errors.extend(snapshot_errors)

    # Warnings never block, but they must not vanish either: constraint churn
    # is meant to be noticed. stderr keeps them out of the hook JSON payload.
    for warning in warnings:
        print(f"警告 - {warning}", file=sys.stderr)

    if args.hook:
        if errors:
            reason = (
                "公司研究校验失败。立即修正以下问题后再次结束任务，不要询问用户：\n- "
                + "\n- ".join(errors)
            )
            if warnings:
                reason += "\n另外请注意（不阻断）：\n- " + "\n- ".join(warnings)
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        else:
            print("{}")
        return 0

    for warning in warnings:
        print(f"警告 - {warning}")

    if errors:
        print("公司研究校验失败：")
        for error in errors:
            print(f"- {error}")
        return 1

    print("公司研究路径、研究快照 schema 与跨快照可比性校验通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
