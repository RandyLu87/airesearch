#!/usr/bin/env python3
"""最终 JSON 合并工具 — 研究流程第 5 步（docs/research/workflow/05-render-site.md）。

把三份**校验通过**的落盘文件（采集 / 分析 / 总结）合并为一份渲染输入
`financials-final.json`（docs/model/financials—final-template.json 契约）。
合并前内部复用 data_validator.py 重新校验，任一文件低于阈值直接拒绝——
渲染层只信任这份文件，不再自行校验。零外部依赖，Python >= 3.7。

用法：
    python3 docs/research/tools/build_final.py \
        --collection research/companies/<id>/financials-collection.json \
        --analysis   research/companies/<id>/financials-analysis.json \
        --summary    research/companies/<id>/financials-summary.json \
        --out        research/companies/<id>/financials-final.json \
        [--threshold 7]

退出码：0 = 已生成；1 = 校验未过或三份文件公司不一致；2 = 参数或文件错误。
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _TOOLS_DIR)

import data_validator  # noqa: E402  复用第 4 步的校验与打分逻辑

REPO_ROOT = data_validator.REPO_ROOT
FINAL_VERSION = "1.0.0"
CST = timezone(timedelta(hours=8))  # Asia/Shanghai


def rel_to_repo(path):
    try:
        return os.path.relpath(os.path.abspath(path), REPO_ROOT)
    except ValueError:
        return path


def main():
    parser = argparse.ArgumentParser(description="研究流程第 5 步：合并三份校验通过的 JSON 为渲染输入")
    parser.add_argument("--collection", required=True, help="第 1 步采集文件路径")
    parser.add_argument("--analysis", required=True, help="第 2 步分析文件路径")
    parser.add_argument("--summary", required=True, help="第 3 步总结文件路径")
    parser.add_argument("--out", required=True, help="输出 financials-final.json 的路径")
    parser.add_argument("--threshold", type=float, default=7.0, help="校验阈值，默认 7 分")
    args = parser.parse_args()

    targets = [("collection", args.collection), ("analysis", args.analysis), ("summary", args.summary)]

    # 1) 复用第 4 步校验，任一低于阈值拒绝合并
    results = [data_validator.check_file(step, path) for step, path in targets]
    failing = [r for r in results if r["score"] < args.threshold]
    for res in results:
        mark = "✅" if res["score"] >= args.threshold else "❌"
        print("%s %s  %.1f 分（阈值 %.1f）  %s" % (mark, res["stepLabel"], res["score"], args.threshold, res["file"]))
    if failing:
        sys.stderr.write("拒绝合并：%d 份文件低于阈值。先回到第 4 步跑关键信息补全流程"
                         "（data_validator.py --gaps-out），达标后再来。\n" % len(failing))
        sys.exit(1)

    # 2) 三份文件必须属于同一家公司
    docs = {step: data_validator.load_json(path, data_validator.STEP_LABELS[step]) for step, path in targets}
    company_ids = {step: (docs[step].get("meta") or {}).get("companyId") for step in docs}
    distinct = {v for v in company_ids.values() if v}
    if len(distinct) != 1:
        sys.stderr.write("拒绝合并：三份文件的 meta.companyId 不一致或缺失：%s\n"
                         % json.dumps(company_ids, ensure_ascii=False))
        sys.exit(1)
    company_id = distinct.pop()

    collection_meta = docs["collection"].get("meta") or {}
    now = datetime.now(CST).isoformat(timespec="seconds")

    final = {
        "finalVersion": FINAL_VERSION,
        "meta": {
            "companyId": company_id,
            "companyName": collection_meta.get("companyName", ""),
            "generatedAt": now,
            "dataCutoff": collection_meta.get("dataCutoff", ""),
            "validation": {
                "threshold": args.threshold,
                "scores": {r["step"]: r["score"] for r in results},
                "validatedAt": now,
            },
            "sources": {step: rel_to_repo(path) for step, path in targets},
        },
        "collection": docs["collection"],
        "analysis": docs["analysis"],
        "summary": docs["summary"],
    }

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(final, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("✅ 已生成 %s（公司 %s，三份得分 %s）"
          % (rel_to_repo(args.out), company_id,
             " / ".join("%.1f" % r["score"] for r in results)))
    sys.exit(0)


if __name__ == "__main__":
    main()
