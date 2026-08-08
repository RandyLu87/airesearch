#!/usr/bin/env python3
"""数据校验工具 — 研究流程第 4 步（docs/research/workflow/04-data-validation.md）。

对前三步落盘的 JSON（采集 / 分析 / 总结）做模板驱动的完整性校验与打分（满分 10 分）。
零外部依赖，仅用 Python 标准库，Python >= 3.7。

用法：
    python3 docs/research/tools/data_validator.py check \
        --collection research/companies/<id>/<采集文件>.json \
        --analysis   research/companies/<id>/<分析文件>.json \
        --summary    research/companies/<id>/<总结文件>.json \
        [--threshold 7] [--json] [--gaps-out gaps.json]

三个文件参数均可省略，只校验给出的文件。
退出码：0 = 全部达到阈值；1 = 存在低于阈值的文件；2 = 参数或文件错误。

打分规则（模板驱动）：
    - 「槽位」= 模板中值含 __TODO__ 的叶子字段，或形如 "A | B | C" 的枚举提示字段；
      模板中的固定文本（title、question、免责声明等）不计分。
    - 已填（有实值且不含 __TODO__、不等于枚举提示原文）计 1 分权重；
    - 规范的 { "status": "unavailable", "reason": "..." } 计 0.5 分权重——
      「取不到并写明已查范围」是合法结果，但完整性弱于取到；
    - 缺键、残留 __TODO__、空值、枚举未选、unavailable 未写 reason 计 0 分并记入缺口清单；
    - 得分 = 10 × (已填 + 0.5 × unavailable) / 槽位总数，四舍五入到 1 位小数。

数组规则：模板数组为空（如 dataGaps: []）表示允许为空，跳过；模板数组含 N 个条目时，
实例第 i 项对照模板第 min(i, N-1) 项校验（单示例数组=逐项套用示例，定长数组=按位对照），
实例条目数少于模板条目数时，缺的条目按缺失计。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evals_log  # noqa: E402  第 7 步的运行事件记账（写失败不阻断本流程）

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))          # docs/research/tools
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_TOOLS_DIR)))
MODEL_DIR = os.path.join(REPO_ROOT, "docs", "model")

TEMPLATES = {
    "collection": "financials—model-template.json",
    "analysis": "financials—analysis-template.json",
    "summary": "financials—summary-template.json",
}
STEP_LABELS = {
    "collection": "第 1 步·数据采集",
    "analysis": "第 2 步·多维度分析",
    "summary": "第 3 步·分析总结",
}

META_KEYS = {"_spec", "_dimension", "_hint"}
TODO = "__TODO__"


def is_enum_hint(value):
    return isinstance(value, str) and " | " in value and TODO not in value


def is_slot(value):
    """模板叶子是否为需要填写的槽位。"""
    if isinstance(value, str):
        return TODO in value or is_enum_hint(value)
    return False


def is_unavailable(node):
    return isinstance(node, dict) and node.get("status") == "unavailable"


class Tally:
    def __init__(self):
        self.filled = 0
        self.unavailable = 0
        self.gaps = []  # 每条: {path, type, expected}

    @property
    def required(self):
        return self.filled + self.unavailable + len(self.gaps)

    def gap(self, path, gap_type, expected):
        if isinstance(expected, str) and len(expected) > 120:
            expected = expected[:117] + "..."
        self.gaps.append({"path": path, "type": gap_type, "expected": expected})

    def score(self):
        if self.required == 0:
            return 10.0
        return round(10.0 * (self.filled + 0.5 * self.unavailable) / self.required, 1)


def count_slots_as_missing(template, path, tally, gap_type="missing"):
    """模板子树整体缺失时，把其中所有槽位记为缺口。"""
    if isinstance(template, dict):
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            count_slots_as_missing(tval, "%s.%s" % (path, key), tally, gap_type)
    elif isinstance(template, list):
        if template:
            count_slots_as_missing(template[0], path + "[0]", tally, gap_type)
    elif is_slot(template):
        tally.gap(path, gap_type, template)


def mark_unavailable(template, path, tally, has_reason):
    """实例以 unavailable 替代模板子树：有 reason 记 0.5 权重，无 reason 记缺口。"""
    if isinstance(template, dict):
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            mark_unavailable(tval, "%s.%s" % (path, key), tally, has_reason)
    elif isinstance(template, list):
        if template:
            mark_unavailable(template[0], path + "[0]", tally, has_reason)
    elif is_slot(template):
        if has_reason:
            tally.unavailable += 1
        else:
            tally.gap(path, "unavailable-without-reason", template)


def walk(template, instance, path, tally):
    if isinstance(template, dict):
        if is_unavailable(instance):
            mark_unavailable(template, path, tally, bool(instance.get("reason")))
            return
        if not isinstance(instance, dict):
            count_slots_as_missing(template, path, tally)
            return
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            child_path = "%s.%s" % (path, key) if path else key
            if key not in instance:
                count_slots_as_missing(tval, child_path, tally)
            else:
                walk(tval, instance[key], child_path, tally)
    elif isinstance(template, list):
        if not template:
            return  # 模板允许为空的数组（如 dataGaps）
        if not isinstance(instance, list):
            count_slots_as_missing(template[0], path + "[0]", tally,
                                   "missing" if instance is None else "type-mismatch")
            return
        n = max(len(instance), len(template))
        for i in range(n):
            t_item = template[min(i, len(template) - 1)]
            item_path = "%s[%d]" % (path, i)
            if i < len(instance):
                walk(t_item, instance[i], item_path, tally)
            else:
                count_slots_as_missing(t_item, item_path, tally)
    else:
        if not is_slot(template):
            return  # 模板固定文本，不计分
        if instance is None or instance == "":
            tally.gap(path, "empty", template)
        elif isinstance(instance, str) and TODO in instance:
            tally.gap(path, "todo", template)
        elif is_enum_hint(template) and instance == template:
            tally.gap(path, "unfilled-enum", template)
        elif is_unavailable(instance):
            if instance.get("reason"):
                tally.unavailable += 1
            else:
                tally.gap(path, "unavailable-without-reason", template)
        else:
            tally.filled += 1


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        sys.stderr.write("错误：找不到%s文件 %s\n" % (what, path))
        sys.exit(2)
    except json.JSONDecodeError as exc:
        sys.stderr.write("错误：%s文件不是合法 JSON（%s）：%s\n" % (what, exc, path))
        sys.exit(2)


def check_file(step, instance_path):
    template_path = os.path.join(MODEL_DIR, TEMPLATES[step])
    template = load_json(template_path, "模板")
    instance = load_json(instance_path, STEP_LABELS[step])
    tally = Tally()
    walk(template, instance, "", tally)
    return {
        "step": step,
        "stepLabel": STEP_LABELS[step],
        "file": instance_path,
        "score": tally.score(),
        "requiredSlots": tally.required,
        "filled": tally.filled,
        "unavailable": tally.unavailable,
        "gapCount": len(tally.gaps),
        "gaps": tally.gaps,
    }


def print_report(results, threshold):
    print("=" * 60)
    print("数据完整性校验（满分 10 分，阈值 %s 分）" % threshold)
    print("=" * 60)
    for res in results:
        mark = "✅" if res["score"] >= threshold else "❌"
        print("%s %s  %.1f 分  （槽位 %d：已填 %d / unavailable %d / 缺口 %d）"
              % (mark, res["stepLabel"], res["score"], res["requiredSlots"],
                 res["filled"], res["unavailable"], res["gapCount"]))
        print("   文件：%s" % res["file"])
        for gap in res["gaps"][:10]:
            print("   - [%s] %s" % (gap["type"], gap["path"]))
        if res["gapCount"] > 10:
            print("   ... 其余 %d 条缺口见 --gaps-out / --json" % (res["gapCount"] - 10))
    print("-" * 60)
    failing = [r for r in results if r["score"] < threshold]
    if failing:
        print("❌ %d 份文件低于阈值，进入关键信息补全流程（用 --gaps-out 导出缺口清单）。"
              % len(failing))
    else:
        print("✅ 全部达到阈值，可进入下一流程。")


def main():
    parser = argparse.ArgumentParser(description="研究流程第 4 步：数据完整性校验与打分")
    sub = parser.add_subparsers(dest="command")
    check = sub.add_parser("check", help="校验前三步的落盘 JSON 并打分")
    check.add_argument("--collection", help="第 1 步采集文件路径")
    check.add_argument("--analysis", help="第 2 步分析文件路径")
    check.add_argument("--summary", help="第 3 步总结文件路径")
    check.add_argument("--threshold", type=float, default=7.0, help="通过阈值，默认 7 分")
    check.add_argument("--json", action="store_true", help="以 JSON 输出完整结果")
    check.add_argument("--gaps-out", help="把低于阈值文件的缺口清单写到该路径（给补全 Agent）")
    args = parser.parse_args()

    if args.command != "check":
        parser.print_help()
        sys.exit(2)

    targets = [(step, getattr(args, step))
               for step in ("collection", "analysis", "summary")
               if getattr(args, step)]
    if not targets:
        sys.stderr.write("错误：至少提供 --collection / --analysis / --summary 之一。\n")
        sys.exit(2)

    results = [check_file(step, path) for step, path in targets]
    failing = [r for r in results if r["score"] < args.threshold]

    if args.gaps_out:
        gaps_payload = {
            "purpose": "关键信息补全清单：按 path 定位缺口，expected 为模板对该字段的填写要求。"
                       "补全须遵守对应步骤正文的规范（采集缺口按第 1 步双源规则，"
                       "分析缺口按第 2 步统一信封，总结缺口按第 3 步评分与策略规则）。"
                       "确实取不到的信息写 { \"status\": \"unavailable\", \"reason\": \"缺失原因 + 已查范围\" }，不得编造。",
            "threshold": args.threshold,
            "files": [
                {
                    "step": r["step"],
                    "stepLabel": r["stepLabel"],
                    "file": r["file"],
                    "score": r["score"],
                    "gaps": r["gaps"],
                }
                for r in failing
            ],
        }
        with open(args.gaps_out, "w", encoding="utf-8") as fh:
            json.dump(gaps_payload, fh, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps({"threshold": args.threshold,
                          "pass": not failing,
                          "results": results}, ensure_ascii=False, indent=2))
    else:
        print_report(results, args.threshold)
        if args.gaps_out and failing:
            print("缺口清单已写入：%s" % args.gaps_out)

    exit_code = 1 if failing else 0
    # 通过与未过都要记：第 4 步跑了几轮、是不是一次过，靠的正是失败那几行。
    evals_log.log_event(
        "data_validator", "validate",
        company=evals_log.company_from_paths(*[path for _, path in targets]),
        exit_code=exit_code,
        threshold=args.threshold,
        scores={r["step"]: r["score"] for r in results},
        gapCounts={r["step"]: r["gapCount"] for r in results},
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
