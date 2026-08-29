"""采集数据 → 图表抽取（visuals.py）的回归用例。

这一层最危险的失败不是报错，是**画出一张看起来没问题的错图**：把 unavailable 当成 0、
把人民币和美元画进同一条折线、把一半分部缺同比的季度画成柱状图。所以用例的重心不在
「能画出来」，而在**该不该画**——每一道闸门都要有一条用例直接撞上去。

真实形态取自仓库里已有的两家公司：茅台（金额是「1688.38亿」这种中文量级字符串、
毛利率是 `{"value": "91.23%"}`）与 B 站（金额是 `19383.99 + unit:百万元`、毛利率是裸浮点）。
两种写法是同一个字段的合法形态，任何一种认不出都会让那家公司整块画面消失。
"""

from __future__ import annotations

import unittest
from decimal import Decimal

import visuals


def annual(year: str, revenue=None, profit=None, gross=None, operating=None) -> dict:
    row = {"fiscalYear": year}
    if revenue is not None:
        row["revenue"] = revenue
    if profit is not None:
        row["netProfit"] = profit
    if gross is not None:
        row["grossMarginPct"] = gross
    if operating is not None:
        row["operatingMarginPct"] = operating
    return row


UNAVAILABLE = {"status": "unavailable", "reason": "本次采集未取得"}


class ReadValues(unittest.TestCase):
    def test_amount_numeric_with_separate_unit(self):
        """B 站形态：数值、量级、币种分三个键放。"""
        parsed = visuals.read_amount({"value": 19383.99, "unit": "百万元", "currency": "CNY"})
        self.assertEqual(parsed, (Decimal("19383990000.00"), "元"))

    def test_amount_chinese_magnitude_string(self):
        """茅台形态：量级在字符串里，币种在旁边的键上。"""
        parsed = visuals.read_amount({"value": "1688.38亿", "currency": "CNY"})
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed[0], Decimal("168838000000.00"))
        self.assertEqual(parsed[1], "元")

    def test_amount_self_contained_string(self):
        self.assertEqual(visuals.read_amount("RMB815亿")[0], Decimal("81500000000"))

    def test_annual_rows_are_sorted_ascending(self):
        """采集文件新→旧、旧→新两种排法都有，下游一律按升序假定。

        回归的是一个画得出来、但画反了的错：降序文件会把逐年增长画成一路下滑，
        KPI 还会拿五年前那一年当「最新」。比图没画出来更难发现。
        """
        descending = {
            "financialMetrics": {
                "annual": [
                    {"fiscalYear": "FY2025", "grossMarginPct": 30.43},
                    {"fiscalYear": "FY2024", "grossMarginPct": 38.44},
                    {"fiscalYear": "FY2023", "grossMarginPct": 35.05},
                ]
            }
        }
        rows = visuals._annual(descending)
        self.assertEqual([row["fiscalYear"] for row in rows], ["FY2023", "FY2024", "FY2025"])
        self.assertEqual(rows[-1]["grossMarginPct"], 30.43, "rows[-1] 必须是最新一年")

    def test_annual_rows_keep_order_when_years_unreadable(self):
        """年份认不全就别排：猜出来的时间轴比不排序更危险。"""
        rows = visuals._annual(
            {"financialMetrics": {"annual": [{"fiscalYear": "最近一期"}, {"fiscalYear": "上一期"}]}}
        )
        self.assertEqual([row["fiscalYear"] for row in rows], ["最近一期", "上一期"])

    def test_amount_unit_writings_across_companies(self):
        """`unit` 的写法在 16 家里就有七八种，量级不能只认 `百万元` 一种。

        回归的是一个只会悄悄发生的错：认不出来时整条曲线消失、退回文字卡，
        没有任何报错——曾经 16 家里有 7 家因此丢掉营收趋势图。
        """
        expected = Decimal("19383990000.00")
        for unit in ("百万元", "人民币百万元", "RMB million", "RMB百万", "百万USD", "HK$ million", "百万"):
            with self.subTest(unit=unit):
                parsed = visuals.read_amount({"value": 19383.99, "unit": unit, "currency": "CNY"})
                self.assertIsNotNone(parsed, f"{unit} 应当认得出量级")
                self.assertEqual(parsed[0], expected)

    def test_amount_magnitude_written_on_currency_key(self):
        """理想汽车形态：量级被写在 `currency` 位上（`{"unit": "currency", "currency": "RMB百万"}`）。

        那是数据侧的写法问题，但在这里判废的代价是整张图消失，所以对称地也拆一次。
        """
        parsed = visuals.read_amount({"value": 27009.779, "unit": "currency", "currency": "RMB百万"})
        self.assertEqual(parsed, (Decimal("27009779000.00"), "元"))

    def test_unit_currency_does_not_override_declared_currency(self):
        """`unit` 里的币种只在 `currency` 没声明时兜底，不能盖过声明的那个。"""
        parsed = visuals.read_amount({"value": 100, "unit": "百万元", "currency": "USD"})
        self.assertEqual(parsed, (Decimal("100000000.00"), "美元"))

    def test_split_unit_reads_magnitude_and_currency(self):
        self.assertEqual(visuals.split_unit("千美元"), ("千", "美元"))
        self.assertEqual(visuals.split_unit("人民币百万元"), ("百万", "元"))
        self.assertEqual(visuals.split_unit("currency"), ("", None))
        self.assertEqual(visuals.split_unit(None), ("", None))

    def test_amount_without_magnitude_is_refused(self):
        """没有量级就认不出是百万还是亿——猜出来的单位比没有图危险得多。"""
        self.assertIsNone(visuals.read_amount({"value": 16635}))

    def test_unavailable_is_not_zero(self):
        """`unavailable` 必须是 None，绝不能变成 0：这是这条链路上最难发现的错。"""
        self.assertIsNone(visuals.read_amount(UNAVAILABLE))
        self.assertIsNone(visuals.read_number(UNAVAILABLE))
        self.assertIsNone(visuals.read_pct(UNAVAILABLE))

    def test_pct_accepts_bare_float_and_percent_string(self):
        self.assertEqual(visuals.read_pct(20.86), 20.86)
        self.assertEqual(visuals.read_pct({"value": "91.23%"}), 91.23)

    def test_signed_percent_is_parsed(self):
        """`+30.8%` 的加号不能漏：漏了会只剩负情景取得到，画出半张更误导的图。"""
        self.assertEqual(visuals.read_pct("+30.8%"), 30.8)
        self.assertEqual(visuals.read_pct("-50.9%"), -50.9)

    def test_qualifier_note_keeps_only_first_parenthetical(self):
        note = visuals.qualifier_note("20.28x（TTM）/ 20.38x（静态）")
        self.assertEqual(note, "TTM")

    def test_market_cap_nested_in_reported_primary(self):
        value = {"reported": {"primary": {"value": "67.74亿", "unit": "元", "currency": "USD"}}, "computed": 6774289958.6}
        parsed = visuals.read_market_cap(value)
        self.assertEqual(parsed[1], "美元")
        self.assertEqual(parsed[0], Decimal("6774000000.00"))

    def test_yoy_refuses_non_positive_base(self):
        """负基数的同比百分比没有意义——亏损收窄算不出一个能读的百分数。"""
        self.assertIsNone(visuals.yoy_pct(Decimal(10), Decimal(-40)))
        self.assertIsNone(visuals.yoy_pct(Decimal(10), Decimal(0)))
        self.assertAlmostEqual(visuals.yoy_pct(Decimal(110), Decimal(100)), 10.0)


class MoneyTrendGates(unittest.TestCase):
    def rows(self, currency="CNY"):
        return [
            annual("FY2023", {"value": "100亿", "currency": currency}, {"value": "10亿", "currency": currency}),
            annual("FY2024", {"value": "120亿", "currency": currency}, {"value": "12亿", "currency": currency}),
            annual("FY2025", {"value": "150亿", "currency": currency}, {"value": "15亿", "currency": currency}),
        ]

    def test_draws_two_series_when_complete(self):
        notes = visuals.Notes()
        chart = visuals.build_money_trend({"financialMetrics": {"annual": self.rows()}}, notes)
        self.assertEqual(chart["type"], "line-series")
        self.assertEqual([item["name"] for item in chart["series"]], ["营业收入", "净利润"])
        # 两条线共用一个量级，否则画面上两根线不在同一个坐标系里
        self.assertEqual(chart["axisUnit"], "亿元")
        self.assertEqual(chart["series"][0]["points"][0]["label"], "100亿元")

    def test_too_few_points_drops_the_chart(self):
        notes = visuals.Notes()
        chart = visuals.build_money_trend({"financialMetrics": {"annual": self.rows()[:2]}}, notes)
        self.assertIsNone(chart)
        self.assertTrue(any("revenue" in note["path"] for note in notes.items))

    def test_mixed_currency_across_years_drops_the_chart(self):
        """同一条曲线上跨币种是口径错配，整条判废——这是 Metadata 闸门在画面上的落地。"""
        rows = self.rows()
        rows[2]["revenue"] = {"value": "150亿", "currency": "USD"}
        notes = visuals.Notes()
        chart = visuals.build_money_trend({"financialMetrics": {"annual": rows}}, notes)
        self.assertIsNone(chart)

    def test_profit_gaps_leave_revenue_line_alone(self):
        """净利润点不够就只画营收那一条，不是整张图不画。"""
        rows = self.rows()
        for row in rows[:2]:
            row["netProfit"] = UNAVAILABLE
        notes = visuals.Notes()
        chart = visuals.build_money_trend({"financialMetrics": {"annual": rows}}, notes)
        self.assertEqual([item["name"] for item in chart["series"]], ["营业收入"])
        self.assertTrue(any("netProfit" in note["path"] for note in notes.items))


class MarginTrendGates(unittest.TestCase):
    def test_only_series_with_enough_points_are_drawn(self):
        rows = [
            annual("FY2023", gross={"value": "92.11%"}, operating=UNAVAILABLE),
            annual("FY2024", gross={"value": "92.01%"}, operating=UNAVAILABLE),
            annual("FY2025", gross={"value": "91.23%"}, operating={"value": "68.02%"}),
        ]
        notes = visuals.Notes()
        chart = visuals.build_margin_trend({"financialMetrics": {"annual": rows}}, notes)
        self.assertEqual([item["name"] for item in chart["series"]], ["毛利率"])
        self.assertTrue(any("operatingMarginPct" in note["path"] for note in notes.items))

    def test_no_usable_series_means_no_chart(self):
        notes = visuals.Notes()
        rows = [annual("FY2025", gross=UNAVAILABLE, operating=UNAVAILABLE)]
        self.assertIsNone(visuals.build_margin_trend({"financialMetrics": {"annual": rows}}, notes))


class SegmentGrowthGates(unittest.TestCase):
    def quarter(self, segments):
        return {"revenueStructure": {"recentQuarters": [{"period": "2026Q2（截至2026-06-30）", "segments": segments}]}}

    def test_draws_when_every_segment_has_growth(self):
        notes = visuals.Notes()
        chart = visuals.build_segment_growth(
            self.quarter([{"name": "广告", "yoyGrowthPct": 27.86}, {"name": "游戏", "yoyGrowthPct": -13.68}]), notes
        )
        self.assertEqual(chart["type"], "delta-bars")
        # 期间标签去掉括注才放得进画面
        self.assertEqual(chart["period"], "2026Q2")
        self.assertEqual([item["label"] for item in chart["items"]], ["+27.9%", "-13.7%"])

    def test_one_missing_growth_drops_the_whole_chart(self):
        """缺一条就整张不画：画出来会让人以为没画的那条是零增长。"""
        notes = visuals.Notes()
        chart = visuals.build_segment_growth(
            self.quarter([{"name": "广告", "yoyGrowthPct": 27.86}, {"name": "游戏", "yoyGrowthPct": UNAVAILABLE}]), notes
        )
        self.assertIsNone(chart)
        self.assertTrue(any("yoyGrowthPct" in note["path"] for note in notes.items))


class ScenarioGates(unittest.TestCase):
    def scenario(self, **overrides):
        base = {
            "optimistic": {"impliedReturnPct": "+30.8%", "targetPrice": "1755.6元（目标EPS 79.80×22x）"},
            "neutral": {"impliedReturnPct": "-10.0%", "targetPrice": "1208.0元"},
            "pessimistic": {"impliedReturnPct": "-50.9%", "targetPrice": "659.4元"},
        }
        base.update(overrides)
        return {"dimensions": {"valuation": {"analysis": {"threeScenario": base}}}}

    def test_draws_three_scenarios_worst_to_best(self):
        notes = visuals.Notes()
        chart = visuals.build_scenarios(self.scenario(), notes)
        self.assertEqual([item["name"] for item in chart["items"]], ["悲观", "中性", "乐观"])
        # 目标价原文里的推算过程不进画面，只留价格本身
        self.assertEqual(chart["items"][2]["note"], "1755.6元")

    def test_incomplete_scenarios_draw_nothing(self):
        notes = visuals.Notes()
        self.assertIsNone(visuals.build_scenarios(self.scenario(neutral={"impliedReturnPct": UNAVAILABLE}), notes))


class RiskMatrixGates(unittest.TestCase):
    def paths(self, items):
        return {"dimensions": {"inversion": {"analysis": {"failurePaths": items}}}}

    def test_places_every_path_that_has_both_axes(self):
        notes = visuals.Notes()
        chart = visuals.build_risk_matrix(
            self.paths(
                [
                    {"path": "渠道转直营净增量不及预期", "probability": "高", "impact": "高"},
                    {"path": "系列酒失控式下滑", "probability": "高", "impact": "中"},
                    {"path": "食品安全黑天鹅", "probability": "低", "impact": "高"},
                ]
            ),
            notes,
        )
        self.assertEqual(chart["type"], "risk-matrix")
        self.assertEqual(len(chart["cells"]), 3)
        self.assertEqual(chart["omitted"], 0)
        self.assertEqual(chart["total"], 3)

    def test_unparseable_axis_is_counted_not_dropped_silently(self):
        """缺判定的那条不落格，但要计进 omitted——矩阵里少个点和报告里少条风险是两回事。"""
        notes = visuals.Notes()
        chart = visuals.build_risk_matrix(
            self.paths(
                [
                    {"path": "A", "probability": "高", "impact": "高"},
                    {"path": "B", "probability": "中", "impact": "中"},
                    {"path": "C", "probability": "低", "impact": "低"},
                    {"path": "D", "probability": UNAVAILABLE, "impact": "高"},
                    {"path": "E", "probability": "极高", "impact": "高"},
                ]
            ),
            notes,
        )
        self.assertEqual(len(chart["cells"]), 3)
        self.assertEqual(chart["omitted"], 2)
        self.assertEqual(chart["total"], 5)
        self.assertTrue(any("failurePaths" in note["path"] for note in notes.items))

    def test_too_few_placeable_paths_drops_the_chart(self):
        notes = visuals.Notes()
        chart = visuals.build_risk_matrix(
            self.paths([{"path": "A", "probability": "高", "impact": "高"}, {"path": "B", "probability": "中", "impact": "中"}]),
            notes,
        )
        self.assertIsNone(chart)
        self.assertTrue(any("failurePaths" in note["path"] for note in notes.items))

    def test_off_scale_level_is_never_snapped_to_a_nearby_bucket(self):
        """「极高」不能被当成「高」——落格是判定，不是就近取整。"""
        self.assertIsNone(visuals.risk_level("极高"))
        self.assertIsNone(visuals.risk_level(UNAVAILABLE))
        self.assertEqual(visuals.risk_level("高"), "高")


class Assembly(unittest.TestCase):
    def test_empty_collection_draws_nothing_but_says_why(self):
        """空采集不该抛错，也不该悄悄什么都不画——每一张没画的图都要留下原因。"""
        payloads, notes = visuals.build_visuals({}, None, ["businessQuality"])
        self.assertEqual(payloads, {})
        self.assertTrue(notes)
        self.assertTrue(any("financialMetrics" in note["path"] for note in notes))

    def test_only_known_dimension_ids_get_attached(self):
        collection = {
            "financialMetrics": {
                "annual": [
                    annual("FY2023", {"value": "100亿", "currency": "CNY"}),
                    annual("FY2024", {"value": "120亿", "currency": "CNY"}),
                    annual("FY2025", {"value": "150亿", "currency": "CNY"}),
                ]
            }
        }
        payloads, _ = visuals.build_visuals(collection, None, ["moat"])
        self.assertNotIn("dimension-businessQuality", payloads)
        payloads, _ = visuals.build_visuals(collection, None, ["businessQuality"])
        self.assertIn("dimension-businessQuality", payloads)


if __name__ == "__main__":
    unittest.main()
