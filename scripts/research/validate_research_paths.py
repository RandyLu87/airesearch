#!/usr/bin/env python3
"""Validate company directories and new-flow research outputs.

新研究流程（docs/research/public-company-financial-research.md 1–6 步）的路径校验：
公司目录命名、四份固定名产出的合法性与归属。旧快照流程的产物
（snapshots/、financials.json、commitments.json、历史 Markdown）作为只读存档
允许存在，不再校验内容。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


COMPANY_PATTERNS = (
    re.compile(r"^hk-\d{4,5}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
    re.compile(r"^us-[a-z][a-z0-9]{0,9}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
    re.compile(r"^(?:sh|sz|bj)-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$"),
)

# 旧流程遗留的研究记录命名（只读存档，仅按名放行）。
LEGACY_NOTE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{4}-analysis\.(?:md|json)$")
LEGACY_FILES = ("financials.json", "commitments.json")

# 新研究流程的四份固定名产出，渲染层与合并脚本按名发现，不接受变体。
NEW_FLOW_FILES = (
    "financials-collection.json",
    "financials-analysis.json",
    "financials-summary.json",
    "financials-final.json",
)


def validate_new_flow_file(path: Path, company_id: str, root: Path) -> list[str]:
    """新流程产出只做轻校验：合法 JSON、公司归属一致。完整性打分归 data_validator.py。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"研究数据文件不是有效 JSON：{path.relative_to(root)}；{exc}"]
    meta_id = (data.get("meta") or {}).get("companyId")
    if meta_id and meta_id != company_id:
        return [f"研究数据文件 meta.companyId 与目录不一致：{path.relative_to(root)}"]
    return []


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

        has_new_flow = False
        has_archive = False
        for item in sorted(entry.iterdir()):
            if item.name == ".DS_Store":
                continue
            if item.is_dir():
                if item.name == "snapshots":
                    has_archive = True  # 旧流程快照存档，不校验内容
                else:
                    errors.append(f"公司目录内不允许此子目录：{item.relative_to(root)}")
                continue

            if item.name in NEW_FLOW_FILES:
                has_new_flow = True
                errors.extend(validate_new_flow_file(item, entry.name, root))
                continue

            if item.name in LEGACY_FILES or LEGACY_NOTE_PATTERN.fullmatch(item.name):
                has_archive = True
                continue

            errors.append(
                f"公司目录根部仅允许新流程四份产出（financials-collection/"
                f"analysis/summary/final.json）与旧流程只读存档："
                f"{item.relative_to(root)}。"
            )

        if not has_new_flow and not has_archive:
            errors.append(
                f"公司目录既没有新流程产出也没有旧流程存档：{entry.relative_to(root)}"
            )

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

    if args.hook:
        if errors:
            reason = (
                "公司研究校验失败。立即修正以下问题后再次结束任务，不要询问用户：\n- "
                + "\n- ".join(errors)
            )
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        else:
            print("{}")
        return 0

    if errors:
        print("公司研究校验失败：")
        for error in errors:
            print(f"- {error}")
        return 1

    print("公司研究路径与新流程产出校验通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
