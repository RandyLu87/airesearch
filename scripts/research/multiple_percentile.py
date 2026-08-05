#!/usr/bin/env python3
"""把价格序列统一到前复权，并算出当前倍数在自身历史中的分位。

研究快照 1.2.0 的页头第三格是 `summary.multiplePercentile`，schema 强制
`adjustmentBasis` 必须是「前复权」。原因写在 data-source-registry.md 第 9 节：三个
市场的行情接口口径不一致——A 股 `daily` 与美股 `us_daily` 不复权，港股
`hk_daily_adj` 已复权——所以「直接拿收盘价算历史分位」在两个市场上默认就是错的，
而且错得完全看不出来：分位数仍然落在 0–100，曲线仍然平滑。

本脚本只做算术，不联网。输入是一份已经取好的 JSON；价格怎么取见注册表第 9 节，
A 股复权因子用 `adj_factor`，美股用 `historical-price-eod/full` 的 `adjClose`，
港股 `hk_daily_adj` 本身已是复权序列。

两条容易搞反的规则，都来自注册表第 9 节：

1. **当前倍数用实际股价**，不用复权价。复权只改历史，当前时点的市值与倍数必须能
   和交易所行情对上。
2. **历史序列用前复权**，以最新价为基准回调历史。用后复权算分位会把分红再投资
   混进价格，分位随分红政策漂移。

用法：

    python3 scripts/research/multiple_percentile.py compute --input <path> [--json]
    python3 scripts/research/multiple_percentile.py self-test

输入格式（`--input` 指向的 JSON）：

    {
      "metricLabel": "P/E（正常化）",
      "basis": "不复权",              # 不复权 | 前复权 | 后复权
      "prices": [
        {"date": "2021-01-04", "close": "31.50", "adjFactor": "1.000"},
        ...
      ],
      "denominators": [               # 每股口径的分母，按报告期
        {"effectiveFrom": "2021-04-01", "perShare": "2.10"},
        ...
      ]
    }

`adjFactor` 是 A 股口径的累计复权因子；美股改用 `adjClose`；港股序列直接标
`"basis": "前复权"` 并省略这两个字段。`denominators[].effectiveFrom` 是该期数据
**公开可得**之日（不是报告期末），否则分位里会含入当时还看不到的信息。
"""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Optional

BASES = ("不复权", "前复权", "后复权")
# The one basis a historical percentile may be computed on. Kept here rather than
# inlined so the schema's enum and this script cannot drift apart silently.
REQUIRED_BASIS = "前复权"


class InputError(RuntimeError):
    pass


def decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError) as error:
        raise InputError(f"{field} 不是十进制数：{value!r}") from error


def front_adjust(prices: List[Dict[str, Any]], basis: str) -> List[Dict[str, Decimal]]:
    """把序列统一到前复权：以最新一天为基准回调历史。

    三条输入路径，因为三个市场给的东西不一样：

    * 已经是前复权（港股 `hk_daily_adj`）→ 原样通过；
    * 带累计复权因子（A 股 `adj_factor`）→ close × factor / factor[latest]；
    * 带复权收盘价（美股 `adjClose`）→ adjClose × close[latest] / adjClose[latest]。

    后复权序列会被拒绝而不是转换。从后复权反推前复权在数学上可行，但后复权已经把
    分红再投资折进价格里，转换后的「前复权」序列和交易所口径的前复权不是同一条线，
    而两者的分位可以差出十几个百分点。宁可让作者回去重取。
    """
    if basis not in BASES:
        raise InputError(f"basis 必须是 {BASES} 之一，收到 {basis!r}")
    if basis == "后复权":
        raise InputError(
            "后复权序列不能转成前复权用于分位：它已含分红再投资，"
            "转换结果与交易所口径的前复权不是同一条线。请按注册表第 9 节重新取前复权或不复权序列。"
        )
    if not prices:
        raise InputError("prices 为空")

    rows = sorted(prices, key=lambda row: str(row["date"]))
    if len({str(row["date"]) for row in rows}) != len(rows):
        raise InputError("prices 存在重复日期")

    latest = rows[-1]
    if basis == REQUIRED_BASIS:
        return [
            {"date": str(row["date"]), "adjusted": decimal(row["close"], "close")}
            for row in rows
        ]

    if "adjFactor" in latest:
        base = decimal(latest["adjFactor"], "adjFactor")
        if base <= 0:
            raise InputError("最新一天的 adjFactor 必须为正")
        return [
            {
                "date": str(row["date"]),
                "adjusted": decimal(row["close"], "close")
                * decimal(row["adjFactor"], "adjFactor")
                / base,
            }
            for row in rows
        ]

    if "adjClose" in latest:
        base = decimal(latest["adjClose"], "adjClose")
        if base <= 0:
            raise InputError("最新一天的 adjClose 必须为正")
        scale = decimal(latest["close"], "close") / base
        return [
            {
                "date": str(row["date"]),
                "adjusted": decimal(row["adjClose"], "adjClose") * scale,
            }
            for row in rows
        ]

    raise InputError(
        "不复权序列必须带 adjFactor（A 股 adj_factor）或 adjClose（美股 historical-price-eod/full）；"
        "两者都没有时无法复权，见注册表第 9 节。"
    )


def denominator_at(denominators: List[Dict[str, Any]], date: str) -> Optional[Decimal]:
    """该日**当时可得**的最近一期每股分母。

    用 `effectiveFrom`（公开可得日）而不是报告期末，否则历史分位会用上当天还没
    披露的利润——那条曲线会显得比真实历史更便宜，且偏差集中在财报前后。
    """
    usable = [row for row in denominators if str(row["effectiveFrom"]) <= date]
    if not usable:
        return None
    latest = max(usable, key=lambda row: str(row["effectiveFrom"]))
    value = decimal(latest["perShare"], "perShare")
    return value if value > 0 else None


def percentile_rank(series: List[Decimal], value: Decimal) -> Decimal:
    """`value` 在 `series` 中的百分位，用「小于等于」的比例。

    小样本上不做插值：分位本身是个粗读数，插值只会给它一个不该有的精度。
    """
    if not series:
        raise InputError("倍数序列为空，无法算分位")
    at_or_below = sum(1 for item in series if item <= value)
    return (Decimal(at_or_below) / Decimal(len(series)) * 100).quantize(Decimal("0.1"))


def compute(payload: Dict[str, Any]) -> Dict[str, Any]:
    prices = payload.get("prices") or []
    denominators = payload.get("denominators") or []
    if not denominators:
        raise InputError("denominators 为空：没有分母就没有倍数")

    adjusted = front_adjust(prices, str(payload.get("basis", "")))

    multiples: List[Decimal] = []
    skipped = 0
    for row in adjusted:
        denominator = denominator_at(denominators, row["date"])
        if denominator is None:
            skipped += 1
            continue
        multiples.append(row["adjusted"] / denominator)

    if not multiples:
        raise InputError("没有任何交易日能匹配到当时可得的分母，检查 effectiveFrom")

    # The current multiple deliberately uses the *unadjusted* last close: market
    # cap and today's multiple have to reconcile with the exchange tape, and
    # front-adjustment only ever rewrites history (registry §9 rule 2).
    last = sorted(prices, key=lambda row: str(row["date"]))[-1]
    current_denominator = denominator_at(denominators, str(last["date"]))
    if current_denominator is None:
        raise InputError("最新交易日没有可得的分母")
    current = decimal(last["close"], "close") / current_denominator

    return {
        "metricLabel": payload.get("metricLabel", "倍数"),
        "status": "calculated",
        "value": str(current.quantize(Decimal("0.01"))),
        "percentile": str(percentile_rank(multiples, current)),
        "windowFrom": adjusted[0]["date"],
        "windowTo": adjusted[-1]["date"],
        "adjustmentBasis": REQUIRED_BASIS,
        "observations": len(multiples),
        "skippedNoDenominator": skipped,
    }


def self_test() -> int:
    # A 2-for-1 split, which is the case this whole script exists for.
    #
    # Tushare's `adj_factor` is cumulative and non-decreasing: back-adjusted price
    # is close × factor, so the factor doubles *after* a 2-for-1 to keep the series
    # continuous on the listing-day basis. Front adjustment divides by the latest
    # factor, so the pre-split 100 restates to 50 on today's share basis and the
    # series comes out flat — the split stops looking like a 50% crash.
    #
    # Getting the factor direction backwards is the easy mistake here, and it does
    # not raise: it produces 200 → 50, a fabricated halving. Hence the assertion.
    split = front_adjust(
        [
            {"date": "2025-01-02", "close": "100", "adjFactor": "1"},
            {"date": "2025-01-03", "close": "50", "adjFactor": "2"},
        ],
        "不复权",
    )
    assert [row["adjusted"] for row in split] == [Decimal("50"), Decimal("50")], split

    # US path: adjClose scaled onto the latest raw close.
    us = front_adjust(
        [
            {"date": "2025-01-02", "close": "100", "adjClose": "98"},
            {"date": "2025-01-03", "close": "110", "adjClose": "110"},
        ],
        "不复权",
    )
    assert [row["adjusted"] for row in us] == [Decimal("98"), Decimal("110")]

    # An already-adjusted HK series passes through untouched.
    hk = front_adjust([{"date": "2025-01-02", "close": "12.5"}], "前复权")
    assert hk[0]["adjusted"] == Decimal("12.5")

    # Back-adjusted input is refused rather than converted.
    try:
        front_adjust([{"date": "2025-01-02", "close": "1"}], "后复权")
        raise AssertionError("后复权 must be refused")
    except InputError as error:
        assert "分红再投资" in str(error)

    # An unadjusted series with no factors at all cannot be rescued.
    try:
        front_adjust([{"date": "2025-01-02", "close": "1"}], "不复权")
        raise AssertionError("a factorless unadjusted series must be refused")
    except InputError as error:
        assert "adjFactor" in str(error)

    # A denominator is only usable once it was public.
    denominators = [
        {"effectiveFrom": "2025-03-31", "perShare": "5"},
        {"effectiveFrom": "2026-03-31", "perShare": "10"},
    ]
    assert denominator_at(denominators, "2025-01-01") is None
    assert denominator_at(denominators, "2025-06-30") == Decimal("5")
    assert denominator_at(denominators, "2026-06-30") == Decimal("10")

    assert percentile_rank([Decimal(1), Decimal(2), Decimal(3), Decimal(4)], Decimal(3)) == Decimal("75.0")
    assert percentile_rank([Decimal(5)], Decimal(1)) == Decimal("0.0")

    result = compute(
        {
            "metricLabel": "P/E",
            "basis": "前复权",
            "prices": [
                {"date": "2025-04-01", "close": "50"},
                {"date": "2025-05-01", "close": "60"},
                {"date": "2025-06-01", "close": "70"},
            ],
            "denominators": [{"effectiveFrom": "2025-03-31", "perShare": "10"}],
        }
    )
    assert result["value"] == "7.00", result
    assert result["percentile"] == "100.0", result
    assert result["adjustmentBasis"] == REQUIRED_BASIS
    assert result["observations"] == 3
    assert result["windowFrom"] == "2025-04-01"

    # Days before the first denominator was public are dropped, not guessed.
    partial = compute(
        {
            "basis": "前复权",
            "prices": [
                {"date": "2025-01-01", "close": "40"},
                {"date": "2025-04-01", "close": "50"},
            ],
            "denominators": [{"effectiveFrom": "2025-03-31", "perShare": "10"}],
        }
    )
    assert partial["skippedNoDenominator"] == 1, partial

    print("self-test: OK")
    return 0


def run_compute(args: argparse.Namespace) -> int:
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    result = compute(payload)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    print(f"{result['metricLabel']}：当前 {result['value']}×，分位 {result['percentile']}%")
    print(f"窗口 {result['windowFrom']}–{result['windowTo']}，口径 {result['adjustmentBasis']}")
    print(f"有效观测 {result['observations']} 个，因分母未公开而跳过 {result['skippedNoDenominator']} 个")
    print()
    print("把下面这段填进 summary.multiplePercentile，并补上价格序列与分母的 evidenceIds：")
    print(json.dumps(
        {key: result[key] for key in
         ("metricLabel", "status", "value", "percentile", "windowFrom", "windowTo", "adjustmentBasis")},
        ensure_ascii=False,
        indent=2,
    ))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    compute_parser = subparsers.add_parser("compute", help="统一复权口径并算出当前倍数分位")
    compute_parser.add_argument("--input", required=True)
    compute_parser.add_argument("--json", action="store_true")
    compute_parser.set_defaults(handler=run_compute)

    test = subparsers.add_parser("self-test", help="离线确定性检查")
    test.set_defaults(handler=lambda _args: self_test())
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.handler(args)
    except InputError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
