"""采集数据 → 画面用的图表与主数字（`scene.visuals`）。

## 为什么单独有这一层

`script_gen.py` 只读 `financials-summary.json` 与 `financials-analysis.json`，这两份都是
**文字产物**——于是成片里每一屏都是大段结论，屏幕说的和耳朵听的是同一句话，看两遍。
而所有数字都在第 1 步的 `collection` 里，且是带单位、双源交叉验证过的结构化字段，
从来没有被画面用过。

这一层就是把 collection 里的数接到画面上：**解说词管耳朵，视觉层管眼睛**，两边互不复述。
它不产出任何一个字的解说词，也不改动控时——`fit_duration` 裁的是 narration，裁不到这里。

## 三条硬规矩

1. **不重算、不推断口径。** 只做两件算术：把量级统一（`亿`/`百万元` → 同一个基数）和
   按两个同币种年度点算同比。两者都在代码里做、有回归测试，不是心算；除此之外一律
   照搬原文。取不到就不画。
2. **认不出来就不画，并记一条 note。** 跨公司的字段写法差异极大——`19383.99 + unit:百万元`
   与 `"1688.38亿"` 是同一个字段的两种形态，`"20.28x（TTM）/ 20.38x（静态）"` 是第三种。
   能认的认，认不出的宁可整张图不画，也不拿一条按猜出来的单位画的曲线糊弄人。
3. **每张图自己带闸门。** 关键序列不足就整张图降级（调用方改画文字卡），绝不画半张图。
   茅台的 `recentQuarters` 混着 H1 基期与推算单季、同比一半是 unavailable，就该一张图都不出——
   这不是缺陷，是闸门在正常工作。

跨公司统一：字段路径来自 `docs/model/financial-model.md` 的固定 10 维采集模板，
所以一套抽取规则适用全部公司，不存在「一家一家适配」。
"""

from __future__ import annotations

import re
from decimal import Decimal

from amount_format import OUTPUT_UNITS, parse_amount, scale_series

# 币种代码 → 金额原文里的后缀写法，用于给「1688.38亿」这种没带币种的值补上币种再解析。
CURRENCY_SUFFIX = {"CNY": "元", "RMB": "元", "USD": "美元", "HKD": "港元"}

# 折线至少要有这么多个点才画：两个点连成的「趋势」不是趋势，是一条线段。
MIN_TREND_POINTS = 3

# 一屏能读清的分部数上限；超了就说不清，交给解说词
MAX_SEGMENTS = 6

# 「20.28x（TTM）/ 20.38x（静态）」→ 取前导数值 20.28，括注留给 note。
# 正负号必须都认：三情景的涨跌幅原文是 `+30.8%`，漏掉 `+` 会让乐观情景整条取不到，
# 而悲观情景（`-50.9%`）却取得到——半张图比没有图更误导。
_LEADING_NUMBER = re.compile(r"^\s*[约近超逾略]?\s*([-+]?[\d,]+(?:\.\d+)?)")

# 数值后面紧跟的单位符号，算进数值本身、不算进口径括注：
# `20.28x（TTM）` 的括注是「（TTM）」，不是「x（TTM）」。
_TRAILING_UNIT = re.compile(r"^[xX%倍％]\s*")

# 期间标签里的补充说明（`2026H1（半年报，权威一手披露，2026-08-15公告）`）在画面上放不下，
# 只取括号前那一段；完整原文本来就在报告里，画面不是存档。
_PERIOD_NOTE = re.compile(r"[（(].*$")


class Notes:
    """抽取过程中的记账本；每条都会并进 script_gen 的 omissions。"""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, path: str, reason: str, handling: str) -> None:
        if any(item["path"] == path for item in self.items):
            return
        self.items.append({"path": path, "reason": reason, "handling": handling})


# -- 取值：collection 里同一个字段跨公司有四五种形态，全部收敛到这里 ----------


def unwrap(value):
    """剥掉 `{value, unit, source1, ...}` 外壳，返回里面那个值；`unavailable` 返回 None。

    契约里「没有这个数」的写法是 `{"status": "unavailable", "reason": ...}`，
    与「有这个数」的 `{"value": ...}` 是两种形状，必须在这里分开——把 unavailable
    当成 0 是这条链路上最容易犯也最难发现的错。
    """
    if isinstance(value, dict):
        if value.get("status") in ("unavailable", "not-applicable"):
            return None
        if "value" in value:
            return value["value"]
        return None
    return value


def read_number(value) -> float | None:
    """取一个纯数值：int/float 直接用，字符串取前导数值，其余返回 None。

    字符串取前导数值是为了 `"20.28x（TTM）/ 20.38x（静态）"` 这类带口径括注的写法——
    前面那个数就是主口径，括注原样留给 note，不丢信息也不猜。
    """
    raw = unwrap(value)
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        matched = _LEADING_NUMBER.match(raw.replace(",", ""))
        if matched:
            try:
                return float(matched.group(1))
            except ValueError:
                return None
    return None


def read_pct(value) -> float | None:
    """百分比字段：`20.86`、`"91.23%"`、`{"value": "91.23%"}` 都认，返回 91.23 这样的数。"""
    return read_number(value)


def qualifier_note(value) -> str | None:
    """字段原文里跟在数值后面的口径括注（`（TTM）/ 20.38x（静态）`），供画面小字附注。

    主数字只写前导数值，口径必须跟着一起出现在画面上——`20.28` 和
    `20.28x（TTM）` 是两个不同强度的说法，把括注吞掉就是把一个口径说成了唯一口径。
    """
    raw = unwrap(value)
    if not isinstance(raw, str):
        return None
    matched = _LEADING_NUMBER.match(raw.replace(",", ""))
    if not matched:
        return None
    rest = _TRAILING_UNIT.sub("", raw.replace(",", "")[matched.end() :].strip()).strip()
    # 只取紧跟着的第一个括注。`20.28x（TTM）/ 20.38x（静态）` 的第二个读数是另一个口径的
    # 同一个指标，画面上主数字只报了第一个，把第二个也贴上去等于并排放两个没有主次的数。
    first = re.match(r"[（(]([^（()）]+)[)）]", rest)
    if first:
        # 括注本身也可能很长（`TTM，Tushare daily_basic dv_ttm字段，2026-08-14`）——
        # 逗号前那一段才是口径，后面是取数出处，出处属于报告不属于画面。
        return re.split(r"[，,;；]", first.group(1))[0].strip()[:16] or None
    return rest[:16].strip() or None


def short_period(value) -> str | None:
    """期间标签取括号前那一段，放得进画面。"""
    text = str(value or "").strip()
    if not text:
        return None
    return _PERIOD_NOTE.sub("", text).strip() or None


def compact(payload: dict) -> dict:
    """去掉值为 None 的键；画面侧对「没有这个键」和「这个键是 null」处理一致，
    但产出的 JSON 干净得多，人核对分镜稿时不用跳过一堆 `"note": null`。"""
    return {key: value for key, value in payload.items() if value is not None}


def read_amount(value) -> tuple[Decimal, str] | None:
    """金额字段 → `(以元/美元计的数值, 币种)`；认不出来返回 None。

    要认的三种形态（同一个 `revenue` 字段在不同公司里的实际写法）：
      A `{"value": 19383.99, "unit": "百万元", "currency": "CNY"}`  数值 + 独立量级
      B `{"value": "1688.38亿", "currency": "CNY"}`                 量级在字符串里、币种在旁边
      C `"RMB815亿"`                                                 全在字符串里
    """
    if isinstance(value, dict) and value.get("status") in ("unavailable", "not-applicable"):
        return None

    currency_code = value.get("currency") if isinstance(value, dict) else None
    unit = value.get("unit") if isinstance(value, dict) else None
    raw = unwrap(value)
    if raw is None:
        return None

    suffix = CURRENCY_SUFFIX.get(str(currency_code).upper()) if currency_code else None

    # A：数值和量级分开放，拼回一条完整原文再走同一个解析器，不另写一套换算
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        if unit and unit != "currency" and suffix:
            return parse_amount(f"{raw}{unit}{suffix}")
        # unit 是 "currency" 或没写：数值本身就以元/美元计
        if suffix:
            return Decimal(str(raw)), suffix
        return None

    if not isinstance(raw, str):
        return None

    # C：原文自带币种
    parsed = parse_amount(raw)
    if parsed is not None:
        return parsed
    # B：原文只有量级，币种在旁边的字段里
    if suffix:
        return parse_amount(f"{raw}{suffix}")
    return None


def format_scaled(value: Decimal, factor: Decimal, label: str, currency: str) -> str:
    """按整条序列共用的量级把一个数写成画面上的字（`1688.38亿元`）。"""
    scaled = (value / factor).quantize(Decimal("0.01")) if factor != 1 else value.quantize(Decimal("0.01"))
    text = format(scaled, "f").rstrip("0").rstrip(".") if "." in format(scaled, "f") else format(scaled, "f")
    return f"{text}{label}{currency}"


def format_amount_alone(pair: tuple[Decimal, str]) -> str:
    """单个金额（不属于任何序列）按自己的量级写成画面上的字。"""
    value, currency = pair
    factor, label = scale_series([value])
    return format_scaled(value, factor, label, currency)


def yoy_pct(current: Decimal, previous: Decimal) -> float | None:
    """同比涨跌幅；基数为 0 或负数不算——负基数的百分比没有意义，算出来是误导。"""
    if previous <= 0:
        return None
    return float((current - previous) / previous * 100)


# -- 各张图的抽取，每张自带闸门 ---------------------------------------------


def _annual(collection: dict) -> list[dict]:
    annual = ((collection.get("financialMetrics") or {}).get("annual")) or []
    return [item for item in annual if isinstance(item, dict)]


def amount_series(rows: list[dict], key: str) -> tuple[list[tuple[str, Decimal]], str | None]:
    """从年度序列里取一条金额曲线，并守住币种一致性闸门。

    币种不一致直接整条判废：把人民币和美元画进同一条折线，比不画这条线糟得多。
    这是 AGENTS.md 那道 Metadata 闸门在画面上的落地。
    """
    points: list[tuple[str, Decimal]] = []
    currency: str | None = None
    for row in rows:
        label = str(row.get("fiscalYear") or "").strip()
        parsed = read_amount(row.get(key))
        if not label or parsed is None:
            continue
        value, item_currency = parsed
        if currency is None:
            currency = item_currency
        elif item_currency != currency:
            return [], None
        points.append((label, value))
    return points, currency


def pct_series(rows: list[dict], key: str) -> list[tuple[str, float]]:
    points: list[tuple[str, float]] = []
    for row in rows:
        label = str(row.get("fiscalYear") or "").strip()
        value = read_pct(row.get(key))
        if label and value is not None:
            points.append((label, value))
    return points


def build_money_trend(collection: dict, notes: Notes) -> dict | None:
    """营收与净利润五年折线。两条都是同币种金额，共用一根轴——不是双轴。"""
    rows = _annual(collection)
    revenue, revenue_currency = amount_series(rows, "revenue")
    profit, profit_currency = amount_series(rows, "netProfit")

    if len(revenue) < MIN_TREND_POINTS:
        notes.add(
            "collection.financialMetrics.annual[].revenue",
            f"可用年度营收点不足 {MIN_TREND_POINTS} 个（取到 {len(revenue)} 个，或币种不一致）",
            "不画营收趋势图，该屏退回文字卡",
        )
        return None
    if profit and profit_currency != revenue_currency:
        notes.add(
            "collection.financialMetrics.annual[].netProfit",
            f"净利润币种（{profit_currency}）与营收（{revenue_currency}）不一致",
            "趋势图只画营收一条线",
        )
        profit = []

    # 两条线共用一个量级：折线图上两根线必须在同一个坐标系里读
    factor, label = scale_series([value for _, value in revenue] + [value for _, value in profit])
    currency = revenue_currency or ""

    def to_points(pairs: list[tuple[str, Decimal]]) -> list[dict]:
        return [
            {"x": name, "y": float(value / factor), "label": format_scaled(value, factor, label, currency)}
            for name, value in pairs
        ]

    series = [{"name": "营业收入", "points": to_points(revenue)}]
    if len(profit) >= MIN_TREND_POINTS:
        series.append({"name": "净利润", "points": to_points(profit)})
    elif profit:
        notes.add(
            "collection.financialMetrics.annual[].netProfit",
            f"可用年度净利润点不足 {MIN_TREND_POINTS} 个（取到 {len(profit)} 个）",
            "趋势图只画营收一条线",
        )

    return {"type": "line-series", "series": series, "axisUnit": f"{label}{currency}", "zeroBaseline": True}


def build_margin_trend(collection: dict, notes: Notes) -> dict | None:
    """毛利率与经营利润率折线。两条都是百分比，天然同轴。"""
    rows = _annual(collection)
    plan = (("grossMarginPct", "毛利率"), ("operatingMarginPct", "经营利润率"))
    series = []
    for key, name in plan:
        points = pct_series(rows, key)
        if len(points) >= MIN_TREND_POINTS:
            series.append(
                {"name": name, "points": [{"x": x, "y": y, "label": f"{y:g}%"} for x, y in points]}
            )
        else:
            notes.add(
                f"collection.financialMetrics.annual[].{key}",
                f"可用年度{name}点不足 {MIN_TREND_POINTS} 个（取到 {len(points)} 个）",
                f"利润率趋势图不画{name}这条线",
            )
    if not series:
        return None
    return {"type": "line-series", "series": series, "axisUnit": "%", "zeroBaseline": False}


def build_segment_growth(collection: dict, notes: Notes) -> dict | None:
    """最新一期分部同比涨跌柱。

    闸门刻意严：**最新一期的每一个分部都要有能认出来的同比**，缺一个就整张不画。
    茅台的最新一期里「茅台酒 +2.82%」认得出、但同一期还有一半分部的同比是
    `unavailable`，画出来会让人以为没画的那几条是零增长。
    """
    quarters = [item for item in ((collection.get("revenueStructure") or {}).get("recentQuarters") or []) if isinstance(item, dict)]
    if not quarters:
        return None
    latest = quarters[-1]
    segments = [item for item in (latest.get("segments") or []) if isinstance(item, dict)]
    if len(segments) < 2:
        return None

    items = []
    for item in segments:
        name = str(item.get("name") or "").strip()
        growth = read_pct(item.get("yoyGrowthPct"))
        if not name or growth is None:
            notes.add(
                "collection.revenueStructure.recentQuarters[-1].segments[].yoyGrowthPct",
                f"分部「{name or '未命名'}」的同比取不到（unavailable 或无法解析）",
                "不画分部同比柱状图——缺一条就会让人以为它是零增长",
            )
            return None
        items.append({"name": name, "valuePct": growth, "label": f"{growth:+.1f}%"})

    if len(items) > MAX_SEGMENTS:
        return None
    return compact({"type": "delta-bars", "period": short_period(latest.get("period")), "items": items})


# 概率 / 影响的三档取值。契约里这两个字段就是这三个词，不是自由文本——
# 出现第四种写法说明上游变了口径，那一条不落格，宁可少画一个点也不硬塞进最近的一档。
RISK_LEVELS = ("低", "中", "高")


def risk_level(value) -> str | None:
    text = str(unwrap(value) or "").strip()
    return text if text in RISK_LEVELS else None


def build_risk_matrix(analysis: dict | None, notes: Notes) -> dict | None:
    """失败路径的「概率 × 影响」矩阵。

    这一屏问的是「聪明人为什么会不买/做空」，而 `failurePaths` 每条都自带概率与影响两档
    判定——正好是一张 3×3 的图。它比把八条路径抄成八行字更接近这个问题的答案：
    真正要看的是**右上角那一格里有几条**，而不是逐条读完。

    落不了格的路径不丢掉，计入 `omitted` 由画面如实说明——矩阵里少一个点，
    和报告里少一条风险，是两回事。
    """
    if not isinstance(analysis, dict):
        return None
    block = ((analysis.get("dimensions") or {}).get("inversion") or {}).get("analysis")
    paths = [item for item in (block.get("failurePaths") or []) if isinstance(item, dict)] if isinstance(block, dict) else []
    if not paths:
        return None

    cells = []
    omitted = 0
    for item in paths:
        probability = risk_level(item.get("probability"))
        impact = risk_level(item.get("impact"))
        label = str(item.get("path") or "").strip()
        if probability is None or impact is None or not label:
            omitted += 1
            continue
        cells.append({"probability": probability, "impact": impact, "label": label})

    if len(cells) < 3:
        notes.add(
            "analysis.dimensions.inversion.analysis.failurePaths",
            f"能同时认出概率与影响的失败路径只有 {len(cells)} 条",
            "不画风险矩阵，该屏退回纯问答",
        )
        return None
    if omitted:
        notes.add(
            "analysis.dimensions.inversion.analysis.failurePaths",
            f"{omitted} 条失败路径缺概率或影响判定（或取值不在 低/中/高 三档内）",
            "这几条不落格，画面上另行说明条数",
        )
    return {"type": "risk-matrix", "cells": cells, "omitted": omitted, "total": len(paths)}


def build_scenarios(analysis: dict | None, notes: Notes) -> dict | None:
    """三情景涨跌幅区间图。数据来自第 2 步估值维度，本身就是工具算好的。"""
    if not isinstance(analysis, dict):
        return None
    block = ((analysis.get("dimensions") or {}).get("valuation") or {}).get("analysis")
    scenario = block.get("threeScenario") if isinstance(block, dict) else None
    if not isinstance(scenario, dict):
        return None

    plan = (("pessimistic", "悲观"), ("neutral", "中性"), ("optimistic", "乐观"))
    items = []
    for key, name in plan:
        entry = scenario.get(key)
        if not isinstance(entry, dict):
            continue
        change = read_pct(entry.get("impliedReturnPct"))
        if change is None:
            continue
        target = unwrap(entry.get("targetPrice"))
        items.append(
            compact(
                {
                    "name": name,
                    "valuePct": change,
                    "label": f"{change:+.1f}%",
                    # 目标价原文里带着推算过程（`1755.6元（目标EPS 79.80×22x）`），只取价格本身
                    "note": short_period(target) if isinstance(target, str) else None,
                }
            )
        )

    if len(items) < 3:
        notes.add(
            "analysis.dimensions.valuation.analysis.threeScenario",
            f"三情景里能认出涨跌幅的只有 {len(items)} 个",
            "不画三情景区间图",
        )
        return None
    return {"type": "range-band", "items": items}


# -- 主数字 ---------------------------------------------------------------


def read_market_cap(value) -> tuple[Decimal, str] | None:
    """市值在契约里有三层写法，逐层往里试；到底都认不出就返回 None。

      A `{"reported": "1.6776万亿 CNY（…）", "computed": …}`        —— 整条原文在 reported 上
      B `{"reported": {"primary": {"value": "67.74亿", "currency": "USD"}}}` —— 主口径在 primary 里
      C `{"value": …, "currency": …}`                                —— 和别的金额字段同形

    只认 `primary`，不碰 `alt`：港股同时给美股与港股两个市值时，`alt` 是另一个币种的
    同一家公司，挑哪个都不该由这一层替人决定。
    """
    if value is None:
        return None
    for candidate in (
        value,
        value.get("reported") if isinstance(value, dict) else None,
        ((value.get("reported") or {}).get("primary") if isinstance(value.get("reported"), dict) else None)
        if isinstance(value, dict)
        else None,
    ):
        if candidate is None:
            continue
        parsed = read_amount(candidate)
        if parsed is not None:
            return parsed
    return None


def build_overview(collection: dict, notes: Notes) -> dict | None:
    """开场：市值当主数字，其余关键指标排成一行卡片。

    每一项自己取自己的，取不到就不出现——卡片数量本来就是可变的，
    少一张卡不会让画面塌，写一个「暂无」上去才是浪费一整格。
    """
    valuation = collection.get("currentValuation") or {}
    rows = _annual(collection)
    latest = rows[-1] if rows else {}
    previous = rows[-2] if len(rows) >= 2 else {}

    hero = None
    market_cap = read_market_cap(valuation.get("marketCap"))
    if market_cap is not None:
        hero = compact(
            {
                "label": "总市值",
                "value": format_amount_alone(market_cap),
                "note": short_period(valuation.get("priceAsOf")),
            }
        )
    else:
        # 「字段不存在」和「字段在但认不出」要分开说：前者是采集没做，后者是写法超出解析范围，
        # 两种情况该改的地方完全不同。
        notes.add(
            "collection.currentValuation.marketCap",
            "采集数据里没有 marketCap 字段" if valuation.get("marketCap") is None else "市值原文无法解析成数值",
            "开场不显示市值主数字",
        )

    items = []

    revenue = read_amount(latest.get("revenue"))
    if revenue is not None:
        card = {"label": f"{latest.get('fiscalYear') or '最新财年'} 营业收入", "value": format_amount_alone(revenue)}
        prior = read_amount(previous.get("revenue"))
        # 同比只在两年同币种时算，币种一换算出来的百分比就是汇率噪音
        if prior is not None and prior[1] == revenue[1]:
            change = yoy_pct(revenue[0], prior[0])
            if change is not None:
                card["delta"] = f"{change:+.1f}%"
                card["deltaNote"] = "同比"
        items.append(card)

    profit = read_amount(latest.get("netProfit"))
    if profit is not None:
        card = {"label": "净利润", "value": format_amount_alone(profit)}
        prior = read_amount(previous.get("netProfit"))
        if prior is not None and prior[1] == profit[1]:
            change = yoy_pct(profit[0], prior[0])
            if change is not None:
                card["delta"] = f"{change:+.1f}%"
                card["deltaNote"] = "同比"
        items.append(card)

    margin = read_pct(latest.get("grossMarginPct"))
    if margin is not None:
        items.append({"label": "毛利率", "value": f"{margin:g}%"})

    for key, label in (("pe", "市盈率"), ("dividendYieldPct", "股息率"), ("roe", "ROE")):
        value = read_number(valuation.get(key))
        if value is None:
            continue
        suffix = "倍" if key == "pe" else "%"
        items.append(
            compact(
                {
                    "label": label,
                    "value": f"{value:g}{suffix}",
                    "note": qualifier_note(valuation.get(key)),
                }
            )
        )

    if hero is None and not items:
        return None
    return {"hero": hero, "chart": {"type": "kpi-grid", "items": items[:5]} if items else None}


def build_valuation_hero(collection: dict) -> dict | None:
    valuation = collection.get("currentValuation") or {}
    pe = read_number(valuation.get("pe"))
    if pe is None:
        return None
    return compact({"label": "市盈率", "value": f"{pe:g}", "unit": "倍", "note": qualifier_note(valuation.get("pe"))})


def build_quality_hero(collection: dict) -> dict | None:
    rows = _annual(collection)
    for row in reversed(rows):
        margin = read_pct(row.get("grossMarginPct"))
        if margin is not None:
            return compact(
                {"label": "毛利率", "value": f"{margin:g}", "unit": "%", "note": str(row.get("fiscalYear") or "") or None}
            )
    return None


def build_revenue_hero(collection: dict) -> dict | None:
    latest = (collection.get("revenueStructure") or {}).get("latestFiscalYear")
    if not isinstance(latest, dict):
        return None
    total = read_amount(latest.get("totalRevenue"))
    if total is None:
        return None
    return compact(
        {"label": "营业收入", "value": format_amount_alone(total), "note": short_period(latest.get("period"))}
    )


# -- 组装 -----------------------------------------------------------------


def build_visuals(collection: dict, analysis: dict | None, dimension_ids: list[str]) -> tuple[dict[str, dict], list[dict]]:
    """按分镜 id 给出 `visuals`；返回 `(by_scene_id, notes)`。

    只认得出的分镜才挂——挂不上的分镜画面不变，仍然是原来的文字卡，不会因为
    这一层的存在而变空。
    """
    notes = Notes()
    if not isinstance(collection, dict):
        return {}, notes.items

    result: dict[str, dict] = {}

    def put(scene_id: str, hero=None, chart=None) -> None:
        if hero is None and chart is None:
            return
        payload = {}
        if hero is not None:
            payload["hero"] = hero
        if chart is not None:
            payload["chart"] = chart
        result[scene_id] = payload

    overview = build_overview(collection, notes)
    if overview is not None:
        put("opening", overview.get("hero"), overview.get("chart"))

    ids = set(dimension_ids)
    if "businessQuality" in ids:
        put("dimension-businessQuality", build_quality_hero(collection), build_money_trend(collection, notes))
    if "valuation" in ids:
        put("dimension-valuation", build_valuation_hero(collection), build_scenarios(analysis, notes))

    # 收入结构屏本来就有一排按业务线的占比条（跟着解说词逐条点亮），再叠一张堆叠饼
    # 就是把同一份数据画两遍。这里只补它没有的两样：总收入主数字，和各分部的同比。
    put("business-model-revenue", build_revenue_hero(collection), build_segment_growth(collection, notes))
    put("business-model-economics", None, build_margin_trend(collection, notes))
    put("inversion-inquiry", None, build_risk_matrix(analysis, notes))

    return result, notes.items
