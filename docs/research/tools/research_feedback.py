#!/usr/bin/env python3
"""研究评估与反馈 — 研究流程第 7 步（docs/research/workflow/07-evaluation-and-feedback.md）。

把一次研究的机器指标与人工阅读评分合并成一条研究评估记录，并把「最差的一处」
物化成一条缺陷记录，最后重跑一次站点发布，让研究评估页立刻是最新的。

用法：
    # 交互式（正常反馈）
    python3 docs/research/tools/research_feedback.py --company hk-2015-li-auto

    # 非交互（测试与离线补录）
    python3 docs/research/tools/research_feedback.py --company hk-2015-li-auto \
        --rating-json tmp/rating.json --no-publish

退出码：0 = 已写入；1 = 记录已写入但发布失败；2 = 参数或评分输入不合法（未写入任何记录）。

机器指标有两个来源，可靠性分层：
  - 运行事件（research/evals/events.jsonl）由工具自己写，是一等事实——
    校验轮数、是否一次过、三份得分都取自这里。
  - 会话日志只用来补 token 与耗时这两个工具自身拿不到的量。它依赖编辑器的
    内部日志格式、会随版本变化，因此解析全部包在 try 里：**取不到就写空值，
    绝不阻断本步骤**。记账的准确性让位于研究流程的健壮性。

零外部依赖，仅用 Python 标准库，Python >= 3.7。
"""

import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evals_log  # noqa: E402

REPO_ROOT = evals_log.REPO_ROOT

RATING_FIELDS = ("trust", "insight", "readability", "actionable", "density")
RATING_LABELS = {
    "trust": "可信——读完敢不敢照它做决定",
    "insight": "洞察——有没有告诉你一件自己没想到的事",
    "readability": "好读——5 分钟能不能抓住要点",
    "actionable": "可执行——触发条件真的能照着盯吗",
    "density": "信息密度——套话与重复占比小不小",
}
VS_LAST = ("better", "same", "worse")
VS_LAST_LABELS = {"better": "更好", "same": "差不多", "worse": "更差"}
DEFECT_STEPS = ("collection", "analysis", "summary", "render", "process", "unspecified")

# 相邻消息间隔超过这个分钟数视为离开，不计入实际投入时长。
IDLE_GAP_MINUTES = 10


# --------------------------------------------------------------------------
# 运行事件（一等事实）
# --------------------------------------------------------------------------

def machine_metrics_from_events(company):
    """校验轮数、是否一次过、三份得分——全部取自工具自己写的运行事件。"""
    events = [e for e in evals_log.read(evals_log.EVENTS_FILE) if e.get("company") == company]
    validations = [e for e in events if e.get("tool") == "data_validator"]
    merges = [e for e in events if e.get("tool") == "build_final"]

    metrics = {
        "validationRounds": len(validations),
        # 「一次过」= 第一次跑校验就通过。补过缺口再过，不算一次过。
        "firstPassValidation": bool(validations) and validations[0].get("exitCode") == 0,
        "mergeAttempts": len(merges),
        "scores": None,
        "eventCount": len(events),
    }
    passing_merge = [m for m in merges if m.get("exitCode") == 0]
    source = passing_merge[-1] if passing_merge else (validations[-1] if validations else None)
    if source:
        metrics["scores"] = source.get("scores")
    if not events:
        metrics["note"] = "没有找到该公司的运行事件；本次研究可能跑在记账上线之前。"
    return metrics, events


def company_facts_from_events(events):
    """公司名与数据截止时点：合并事件里带了就用，省得再读一遍产出文件。"""
    for event in reversed(events):
        if event.get("tool") == "build_final" and event.get("exitCode") == 0:
            return event.get("companyName") or "", event.get("dataCutoff") or ""
    return "", ""


def fallback_company_facts(company):
    """运行事件里没有时，退回读该公司的最终产出文件。"""
    path = os.path.join(REPO_ROOT, "research", "companies", company, "financials-final.json")
    try:
        with open(path, encoding="utf-8") as fh:
            meta = (json.load(fh) or {}).get("meta") or {}
        return meta.get("companyName") or "", meta.get("dataCutoff") or ""
    except Exception:  # noqa: BLE001
        return "", ""


# --------------------------------------------------------------------------
# 会话日志（尽力而为，失败写空值）
# --------------------------------------------------------------------------

def transcript_roots(explicit_dir):
    if explicit_dir:
        return [os.path.abspath(explicit_dir)]
    slug = REPO_ROOT.replace(os.sep, "-")
    home = os.path.expanduser("~")
    return [
        os.path.join(home, ".claude-work", "projects", slug),
        os.path.join(home, ".claude", "projects", slug),
    ]


def parse_ts(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def scan_transcript(path):
    """读一份会话日志，返回用量、时间窗口与用户消息数。"""
    usage = {"outputTokens": 0, "inputTokens": 0,
             "cacheReadTokens": 0, "cacheWriteTokens": 0}
    stamps = []
    user_messages = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            stamp = parse_ts(entry.get("timestamp"))
            if stamp:
                stamps.append(stamp)
            message = entry.get("message") or {}
            counts = message.get("usage") or {}
            usage["outputTokens"] += counts.get("output_tokens", 0) or 0
            usage["inputTokens"] += counts.get("input_tokens", 0) or 0
            usage["cacheReadTokens"] += counts.get("cache_read_input_tokens", 0) or 0
            usage["cacheWriteTokens"] += counts.get("cache_creation_input_tokens", 0) or 0
            if (entry.get("type") == "user"
                    and not entry.get("isSidechain")
                    and not entry.get("isMeta")
                    and isinstance(message.get("content"), str)
                    # 斜杠命令的回显与工具结果不是人工干预。
                    and not message["content"].lstrip().startswith("<")):
                user_messages += 1
    return {
        "usage": usage,
        "first": min(stamps) if stamps else None,
        "last": max(stamps) if stamps else None,
        "stamps": sorted(stamps),
        "userMessages": user_messages,
    }


def scan_with_subagents(path):
    """一份会话日志连同它派发的后台 Agent——后者的开销同样是本次研究的成本。"""
    scan = scan_transcript(path)
    usage = dict(scan["usage"])
    stamps = list(scan["stamps"])
    stem = os.path.splitext(path)[0]
    for sub in sorted(glob.glob(os.path.join(stem, "subagents", "*.jsonl"))):
        try:
            sub_scan = scan_transcript(sub)
        except OSError:
            continue
        for key in usage:
            usage[key] += sub_scan["usage"][key]
        stamps.extend(sub_scan["stamps"])
    return {**scan, "usage": usage, "stamps": sorted(stamps)}


def active_minutes(stamps):
    """相邻消息间隔小于阈值的部分才算实际投入，避免把过夜挂机算成耗时。"""
    total = 0.0
    for earlier, later in zip(stamps, stamps[1:]):
        gap = (later - earlier).total_seconds() / 60.0
        if 0 <= gap <= IDLE_GAP_MINUTES:
            total += gap
    return round(total, 1)


def metrics_from_scans(scans, names, source):
    """把若干份会话日志的统计合并成一条成本指标。"""
    usage = {"outputTokens": 0, "inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0}
    stamps = []
    users = 0
    for scan in scans:
        for key in usage:
            usage[key] += scan["usage"][key]
        stamps.extend(scan["stamps"])
        users += scan["userMessages"]
    stamps.sort()
    # 跨会话时 wallClock 取首尾之差；中间的空档由 activeMinutes 排除。
    wall = ((stamps[-1] - stamps[0]).total_seconds() / 60.0) if len(stamps) > 1 else 0.0
    return {
        **usage,
        "wallClockMinutes": round(wall, 1),
        "activeMinutes": active_minutes(stamps),
        "userMessages": users,
        "transcript": names if len(names) > 1 else (names[0] if names else None),
        "costSource": source,
    }


def session_metrics(events, explicit_dir, explicit_files=None):
    """挑出承载本次研究的会话并统计成本。任何异常都退化成空值。

    一次研究可能跨多个会话文件（上下文压缩、中途换会话），自动识别只认得出
    含第 4 步校验事件的那一个，因此显式传入的文件优先——补录历史研究时更是
    只能靠它。
    """
    empty = {
        "outputTokens": None, "inputTokens": None,
        "cacheReadTokens": None, "cacheWriteTokens": None,
        "wallClockMinutes": None, "activeMinutes": None,
        "userMessages": None, "transcript": None,
        "costSource": "unavailable",
    }
    if explicit_files:
        try:
            scans, names = [], []
            for path in explicit_files:
                scans.append(scan_with_subagents(path))
                names.append(os.path.basename(path))
            return metrics_from_scans(scans, names, "transcript-explicit")
        except Exception as exc:  # noqa: BLE001
            empty["costReason"] = "指定的会话日志无法解析：%s" % exc
            return empty
    try:
        anchors = [parse_ts(e.get("at")) for e in events]
        anchors = [a for a in anchors if a]
        if not anchors:
            empty["costReason"] = "没有可用的运行事件时点，无法认出承载本次研究的会话。"
            return empty
        first_event, last_event = min(anchors), max(anchors)

        candidates = []
        for root in transcript_roots(explicit_dir):
            candidates.extend(sorted(glob.glob(os.path.join(root, "*.jsonl"))))
        if not candidates:
            empty["costReason"] = "找不到会话日志目录。"
            return empty

        # 第 4 步的校验事件一定发生在承载本次研究的会话窗口内，用它认人。
        chosen, chosen_scan = None, None
        for path in candidates:
            scan = scan_transcript(path)
            if not scan["first"] or not scan["last"]:
                continue
            if scan["first"] <= first_event <= scan["last"]:
                span = (min(scan["last"], last_event) - first_event).total_seconds()
                if chosen is None or span > chosen[1]:
                    chosen, chosen_scan = (path, span), scan
        if not chosen:
            empty["costReason"] = "没有会话日志的时间窗口覆盖本次研究的运行事件。"
            return empty

        path = chosen[0]
        return metrics_from_scans(
            [scan_with_subagents(path)], [os.path.basename(path)], "transcript")
    except Exception as exc:  # noqa: BLE001  解析失败绝不阻断本步骤
        empty["costReason"] = "会话日志解析失败：%s" % exc
        return empty


# --------------------------------------------------------------------------
# 阅读评分
# --------------------------------------------------------------------------

def validate_rating(raw):
    """返回 (rating, errors)。有任何错误就不写入任何记录。"""
    errors = []
    if not isinstance(raw, dict):
        return None, ["评分输入必须是一个 JSON 对象。"]

    rating = {}
    for field in RATING_FIELDS:
        value = raw.get(field)
        if isinstance(value, bool) or not isinstance(value, int):
            errors.append("%s 必须是 1–5 的整数（当前 %r）。" % (field, value))
        elif not 1 <= value <= 5:
            errors.append("%s 必须落在 1–5（当前 %r）。" % (field, value))
        else:
            rating[field] = value

    vs_last = raw.get("vsLast")
    if vs_last not in VS_LAST:
        errors.append("vsLast 必须是 %s 之一（当前 %r）。" % ("/".join(VS_LAST), vs_last))
    else:
        rating["vsLast"] = vs_last

    worst = raw.get("worstPart")
    if not isinstance(worst, str) or not worst.strip():
        errors.append("worstPart 必填：五个分数会向上漂移直至饱和，「最差的一处」不会。")
    else:
        rating["worstPart"] = worst.strip()

    for field in ("changedMyPosition", "familiarIndustry"):
        value = raw.get(field)
        if not isinstance(value, bool):
            errors.append("%s 必须是 true / false（当前 %r）。" % (field, value))
        else:
            rating[field] = value

    corrections = raw.get("correctionMessages")
    if corrections is None:
        rating["correctionMessages"] = None
    elif isinstance(corrections, bool) or not isinstance(corrections, int) or corrections < 0:
        errors.append("correctionMessages 必须是不小于 0 的整数或省略（当前 %r）。" % (corrections,))
    else:
        rating["correctionMessages"] = corrections

    step = raw.get("defectStep", "unspecified")
    if step not in DEFECT_STEPS:
        errors.append("defectStep 必须是 %s 之一（当前 %r）。" % ("/".join(DEFECT_STEPS), step))
    else:
        rating["defectStep"] = step

    rating["model"] = raw.get("model") or "unspecified"
    if isinstance(raw.get("notes"), str) and raw["notes"].strip():
        rating["notes"] = raw["notes"].strip()

    if errors:
        return None, errors
    return rating, []


def ask_rating():
    """交互式采集。趁热打分，攒到周末再补的分全是噪音。"""
    print("=" * 60)
    print("阅读评分（读完报告当场打，1–5 分）")
    print("=" * 60)
    raw = {}
    for field in RATING_FIELDS:
        while True:
            answer = input("%-12s %s：" % (field, RATING_LABELS[field])).strip()
            if answer.isdigit() and 1 <= int(answer) <= 5:
                raw[field] = int(answer)
                break
            print("  请输入 1–5 的整数。")

    while True:
        answer = input("比上一份同类报告（1 更好 / 2 差不多 / 3 更差）：").strip()
        if answer in ("1", "2", "3"):
            raw["vsLast"] = VS_LAST[int(answer) - 1]
            break
        print("  请输入 1、2 或 3。")

    while True:
        answer = input("这份报告最差的一处是什么（必填）：").strip()
        if answer:
            raw["worstPart"] = answer
            break
        print("  这一条不能跳过——它是整套机制里唯一不会饱和的信号。")

    print("缺陷归属步骤：%s" % " / ".join(
        "%d %s" % (i + 1, s) for i, s in enumerate(DEFECT_STEPS)))
    answer = input("选一个（回车 = unspecified）：").strip()
    raw["defectStep"] = (DEFECT_STEPS[int(answer) - 1]
                         if answer.isdigit() and 1 <= int(answer) <= len(DEFECT_STEPS)
                         else "unspecified")

    raw["changedMyPosition"] = input("这次研究改变了你的仓位或关注列表吗（y/N）：").strip().lower() == "y"
    raw["familiarIndustry"] = input("这家公司属于你熟悉的行业吗（y/N）：").strip().lower() == "y"

    answer = input("干预里有几次是纠错（回车 = 不填）：").strip()
    raw["correctionMessages"] = int(answer) if answer.isdigit() else None

    raw["model"] = input("本次研究所用模型（回车 = unspecified）：").strip() or "unspecified"
    notes = input("其他备注（回车跳过）：").strip()
    if notes:
        raw["notes"] = notes
    return raw


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="研究流程第 7 步：评估与反馈")
    parser.add_argument("--company", required=True, help="公司目录名，如 hk-2015-li-auto")
    parser.add_argument("--rating-json", help="非交互模式：一份填好的评分 JSON")
    parser.add_argument("--transcript-dir", help="会话日志目录（默认自动查找）")
    parser.add_argument("--transcript", action="append",
                        help="显式指定会话日志文件，可重复；一次研究跨多个会话或补录历史研究时用")
    parser.add_argument("--no-publish", action="store_true", help="只写记录，不跑发布")
    args = parser.parse_args()

    company = args.company.strip().strip("/")
    company_dir = os.path.join(REPO_ROOT, "research", "companies", company)
    if not os.path.isdir(company_dir):
        sys.stderr.write("错误：找不到公司目录 research/companies/%s\n" % company)
        sys.exit(2)

    if args.rating_json:
        try:
            with open(args.rating_json, encoding="utf-8") as fh:
                raw = json.load(fh)
        except FileNotFoundError:
            sys.stderr.write("错误：找不到评分文件 %s\n" % args.rating_json)
            sys.exit(2)
        except json.JSONDecodeError as exc:
            sys.stderr.write("错误：评分文件不是合法 JSON（%s）\n" % exc)
            sys.exit(2)
    else:
        raw = ask_rating()

    rating, errors = validate_rating(raw)
    if errors:
        sys.stderr.write("错误：评分输入不合法，未写入任何记录。\n")
        for message in errors:
            sys.stderr.write("  - %s\n" % message)
        sys.exit(2)

    machine, events = machine_metrics_from_events(company)
    machine.update(session_metrics(events, args.transcript_dir, args.transcript))
    machine["correctionMessages"] = rating.pop("correctionMessages", None)

    company_name, data_cutoff = company_facts_from_events(events)
    if not company_name or not data_cutoff:
        fallback_name, fallback_cutoff = fallback_company_facts(company)
        company_name = company_name or fallback_name
        data_cutoff = data_cutoff or fallback_cutoff

    rated_at = evals_log.now_iso()
    commit = evals_log.skill_commit()
    defect_step = rating.pop("defectStep")
    model = rating.pop("model")

    run_record = {
        "company": company,
        "companyName": company_name,
        "ratedAt": rated_at,
        "dataCutoff": data_cutoff,
        "skillCommit": commit,
        "model": model,
        "machine": machine,
        "rating": rating,
    }
    wrote_run = evals_log.append(evals_log.RUNS_FILE, run_record)
    wrote_defect = evals_log.append(evals_log.DEFECTS_FILE, {
        "at": rated_at,
        "company": company,
        "step": defect_step,
        "symptom": rating["worstPart"],
        "skillCommit": commit,
        "model": model,
        "status": "open",
    })
    if not wrote_run or not wrote_defect:
        sys.stderr.write("错误：评估记录写入失败，评分未被保存。\n")
        sys.exit(2)

    average = sum(rating[f] for f in RATING_FIELDS) / len(RATING_FIELDS)
    print("✅ 已记录 %s：均分 %.1f（比上一份%s），%s" % (
        company, average, VS_LAST_LABELS[rating["vsLast"]],
        "校验一次通过" if machine["firstPassValidation"] else
        "校验 %d 轮" % machine["validationRounds"]))
    print("   缺陷已登记：%s" % rating["worstPart"])
    if machine.get("costSource") == "unavailable":
        print("   成本指标不可用：%s" % machine.get("costReason", "未知原因"))
    else:
        print("   本次成本：输出 %s token，投入 %s 分钟（来源：%s）" % (
            f"{machine['outputTokens']:,}", machine["activeMinutes"], machine["costSource"]))
    if machine.get("note"):
        print("   注意：%s" % machine["note"])

    if args.no_publish:
        sys.exit(0)

    print("正在重跑发布，让研究评估页包含这次评分……")
    result = subprocess.run(["npm", "run", "publish"], cwd=REPO_ROOT)
    if result.returncode != 0:
        sys.stderr.write("提示：记录已写入，但发布失败。修好后手动跑一次 npm run publish 即可。\n")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
