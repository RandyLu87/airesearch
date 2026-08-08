#!/usr/bin/env python3
"""评估记录的写入与读取 — 研究流程第 7 步（docs/research/workflow/07-close-and-review.md）。

三份追加式、不追溯改写的 JSONL 保存在 `research/evals/`：

    events.jsonl   运行事件：校验 / 合并 / 发布每跑一次追加一行，由工具自己写。
    runs.jsonl     研究评估记录：一次研究一行，由第 7 步收尾命令合并生成。
    defects.jsonl  缺陷记录：由每次评分的「最差的一处」物化而来。

追加式是硬约束：历史评价一旦可以被后来的认知改写，纵向比较就不成立。

**记账永远不能阻断研究流程。** 本模块的写入全部包在 try 里，失败只往 stderr
打一行提示——校验闸门失败必须让流程停下，记账失败不必。

零外部依赖，仅用 Python 标准库，Python >= 3.7。
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))          # docs/research/tools
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_TOOLS_DIR)))

CST = timezone(timedelta(hours=8))  # Asia/Shanghai

EVENTS_FILE = "events.jsonl"
RUNS_FILE = "runs.jsonl"
DEFECTS_FILE = "defects.jsonl"

# 事实源位置是一个显式配置点：测试指向临时目录，因此永不读写真实评估记录。
EVALS_DIR_ENV = "AIRESEARCH_EVALS_DIR"


def evals_dir():
    override = os.environ.get(EVALS_DIR_ENV)
    if override:
        return os.path.abspath(override)
    return os.path.join(REPO_ROOT, "research", "evals")


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def skill_commit():
    """当前 HEAD 的短 SHA，用于把改动的效果与模型的变化分开看。"""
    try:
        out = subprocess.run(
            ["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def append(filename, record):
    """追加一行 JSON。写失败只提示，不抛出——记账不能阻断研究流程。"""
    try:
        directory = evals_dir()
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, filename), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return True
    except Exception as exc:  # noqa: BLE001  记账失败不是流程失败
        sys.stderr.write("提示：评估记账写入失败（不影响本次流程）：%s\n" % exc)
        return False


def read(filename):
    """读回一份 JSONL；文件缺失返回空列表，坏行跳过。"""
    path = os.path.join(evals_dir(), filename)
    records = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        return []
    except OSError:
        return []
    return records


def log_event(tool, event, company=None, exit_code=None, **extra):
    """运行事件：让「第 4 步跑了几轮」「是不是一次过」成为一等事实，
    而不依赖任何事后解析。"""
    record = {
        "at": now_iso(),
        "tool": tool,
        "event": event,
        "company": company,
        "exitCode": exit_code,
        "skillCommit": skill_commit(),
    }
    record.update(extra)
    return append(EVENTS_FILE, record)


def company_from_paths(*paths):
    """从 research/companies/<id>/... 形式的路径里认出公司标识。"""
    for path in paths:
        if not path:
            continue
        parts = os.path.abspath(path).split(os.sep)
        if "companies" in parts:
            index = parts.index("companies")
            if index + 1 < len(parts):
                return parts[index + 1]
    return None
