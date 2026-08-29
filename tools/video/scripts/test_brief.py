"""讲稿加工件校验 — scripts/brief.py。

这层是整条链路上唯一允许 LLM 改写文字的地方，所以它的校验必须是确定性的：
**改写可以换说法，不能换数字。** 下面每个用例都对应一种真实会犯的越界。
"""

import unittest

import brief


SOURCES = [
    {
        "dimensionSummary": [
            {
                "dimensionId": "moat",
                "confidence": 5.5,
                "conclusion": "核心本地商业经营溢利56.68亿，经营利润率7.9%，环比+11.1pct。",
            }
        ],
        "meta": {"marketCap": "4783.2亿", "sharePrice": 77.5},
    }
]


def brief_of(headline, spoken, scene_id="dimension-moat"):
    """旧契约（单条 headline）的构造器——兼容路径仍要能跑。"""
    return {"companyId": "hk-3690-meituan", "scenes": {scene_id: {"headline": headline, "spoken": spoken}}}


def points_of(points, spoken="解说。", scene_id="dimension-moat"):
    return {"companyId": "hk-3690-meituan", "scenes": {scene_id: {"points": points, "spoken": spoken}}}


class NumberWhitelist(unittest.TestCase):
    def test_original_numbers_pass(self):
        problems = brief.check_brief(
            brief_of("规模效应是唯一被证实的一条", "这个季度核心本地商业赚了56.68亿，利润率7.9%，比上个季度高了11.1个点。"),
            SOURCES,
        )
        self.assertEqual(problems, [])

    def test_rounding_is_rejected(self):
        """把 56.68 亿说成 57 亿也算越界：四舍五入改的是研究者的口径，不是文风。"""
        problems = brief.check_brief(brief_of("赚了57亿", "核心本地商业这个季度赚了57亿。"), SOURCES)
        self.assertTrue(any("57" in item for item in problems), problems)

    def test_invented_number_is_rejected(self):
        problems = brief.check_brief(
            brief_of("利润率回到20%", "经营利润率已经回到20.4%了。"),
            SOURCES,
        )
        self.assertTrue(any("20.4" in item for item in problems), problems)

    def test_thousand_separator_and_trailing_zero_are_same_number(self):
        """`1,046.43` 与 `1046.43`、`7.90` 与 `7.9` 是同一个数，不该报越界。"""
        sources = [{"revenue": "1,046.43亿", "margin": "7.90%"}]
        problems = brief.check_brief(brief_of("收入1046.43亿", "收入1046.43亿，利润率7.9%。"), sources)
        self.assertEqual(problems, [])

    def test_small_integers_are_free(self):
        """「第一」「三条」这类口语连接词里的小数字不要求在源文件里命中。"""
        problems = brief.check_brief(brief_of("三条理由", "理由有三条：第一，第二，第三。"), SOURCES)
        self.assertEqual(problems, [])


class ShapeAndNoise(unittest.TestCase):
    def test_headline_length_cap(self):
        """旧契约的单条 headline 走同一条长度闸门（报错里叫 points，因为它就是一条要点）。"""
        problems = brief.check_brief(brief_of("规模效应是这一季唯一被硬数据证实的一条护城河而其余四类都还不成立", "短。"), SOURCES)
        self.assertTrue(any("points" in item and "上限" in item for item in problems), problems)

    def test_url_and_field_path_are_rejected(self):
        problems = brief.check_brief(
            brief_of("看这里", "详见 dimensions.moat.analysis 与 https://example.com 的说明。"),
            SOURCES,
        )
        self.assertTrue(any("URL" in item for item in problems), problems)
        self.assertTrue(any("字段路径" in item for item in problems), problems)

    def test_unknown_scene_id_is_rejected(self):
        problems = brief.check_brief(
            brief_of("重点", "解说。", scene_id="dimension-nonexistent"),
            SOURCES,
            known_scene_ids={"dimension-moat"},
        )
        self.assertTrue(any("凭空加分镜" in item for item in problems), problems)

    def test_empty_scenes_is_rejected(self):
        self.assertTrue(brief.check_brief({"scenes": {}}, SOURCES))




class DurationBudget(unittest.TestCase):
    """片长闸门。数字对、口语好，但把 292s 的片子撑成 634s，同样不能放行。"""

    STORYBOARD = {
        "scenes": [
            {"id": "dimension-moat", "estimatedSeconds": 8.0},
            {"id": "dimension-valuation", "estimatedSeconds": 8.0},
        ],
        "totals": {"targetRange": [120, 180]},
    }

    def test_per_scene_budget_from_storyboard(self):
        budgets, max_seconds = brief.scene_budgets(self.STORYBOARD, 4.25)
        # 8s × 1.25 宽容 = 10s，低于地板，取地板；预算的单位是秒不是字，
        # 因为估时器把数字按逐位念，同样字数的稿子秒数能差一大截
        self.assertEqual(budgets["dimension-moat"], brief.SPOKEN_BUDGET_FLOOR_SECONDS)
        self.assertEqual(max_seconds, 180)

    def test_scene_over_budget_is_rejected(self):
        problems = brief.check_brief(
            brief_of("重点", "这条解说写得很长" * 10),
            SOURCES,
            budgets={"dimension-moat": 5.0},
        )
        self.assertTrue(any("超过控时预算" in item for item in problems), problems)

    def test_digit_heavy_text_costs_more_seconds_than_char_count_suggests(self):
        """数字逐位念：同样字数，数字密的稿子念得久。

        回归的是一个「校验放行、下一步却拦下」的错——校验器曾用 字数÷语速 估时，
        比 script_gen 的估时器低估，于是讲稿过了校验、控时闸门又把它拦回来。
        """
        digits = brief.check_brief(
            brief_of("重点", "收入56.68亿，利润率7.9%，环比11.1个点。"),
            SOURCES,
            budgets={"dimension-moat": 4.0},
        )
        self.assertTrue(any("超过控时预算" in item for item in digits), digits)

    def test_total_duration_is_capped_even_when_each_scene_fits(self):
        """逐条都在预算内、整片仍可能超——分镜多的时候零头会累起来。"""
        scenes = {f"scene-{i}": {"headline": "重点", "spoken": "口" * 100} for i in range(20)}
        problems = brief.check_brief({"scenes": scenes}, SOURCES, max_seconds=180, rate=4.25)
        self.assertTrue(any(item.startswith("整片") for item in problems), problems)

    def test_within_total_passes(self):
        scenes = {"a": {"headline": "重点", "spoken": "口" * 60}}
        problems = brief.check_brief({"scenes": scenes}, SOURCES, max_seconds=180, rate=4.25)
        self.assertEqual(problems, [])


class ScreenPoints(unittest.TestCase):
    """画面要点：1–3 条结论，不重复画面上已有的维度名与分数。

    回归的是一个**看起来没错、但一屏说三遍**的写法：
    标题「护城河」+ 大号「5.5 分」+ 要点「护城河5.5分，已被重新定价」。
    """

    def test_points_pass(self):
        problems = brief.check_brief(
            points_of(["规模效应是唯一被证实的", "品牌定价权不存在"]),
            SOURCES,
            titles={"dimension-moat": "护城河"},
        )
        self.assertEqual(problems, [])

    def test_point_repeating_dimension_title_is_rejected(self):
        problems = brief.check_brief(
            points_of(["护城河已被重新定价"]),
            SOURCES,
            titles={"dimension-moat": "护城河"},
        )
        self.assertTrue(any("重复了维度名" in item for item in problems), problems)

    def test_point_with_score_is_rejected(self):
        problems = brief.check_brief(points_of(["信心度5.5分"]), SOURCES)
        self.assertTrue(any("写了分数" in item for item in problems), problems)

    def test_minutes_are_not_scores(self):
        """`30分钟` 是时长不是分数——这条误伤过一次，把「履约半径压缩到30分钟」判成了写分数。"""
        sources = [{"note": "履约半径压缩到30分钟"}]
        problems = brief.check_brief(points_of(["履约半径压缩到30分钟"]), sources)
        self.assertEqual(problems, [])

    def test_too_many_points_is_rejected(self):
        problems = brief.check_brief(points_of(["一", "二", "三", "四"]), SOURCES)
        self.assertTrue(any("超过上限" in item and "条" in item for item in problems), problems)

    def test_point_length_cap(self):
        problems = brief.check_brief(points_of(["这一条要点写得实在是太长了根本放不下"]), SOURCES)
        self.assertTrue(any("超过上限" in item for item in problems), problems)

    def test_legacy_headline_still_accepted(self):
        """旧契约的单条 headline 仍认，按一条要点处理——但同样要过重复与分数的检查。"""
        self.assertEqual(brief.brief_points({"headline": "规模效应是唯一被证实的"}), ["规模效应是唯一被证实的"])
        self.assertEqual(brief.brief_points({"points": ["甲", "乙"]}), ["甲", "乙"])


if __name__ == "__main__":
    unittest.main()
