"""朗读改写规则的回归测试：python3 scripts/test_text_normalize.py（不联网）。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from text_normalize import normalize  # noqa: E402


class NormalizeTest(unittest.TestCase):
    def assertNormalized(self, raw: str, expected: str) -> None:
        self.assertEqual(normalize(raw)[0], expected)

    def test_acronyms_expand_without_eating_neighbours(self):
        self.assertNormalized("PE35.11x", "市盈率35.11倍")
        self.assertNormalized("PEG 与 PE 不同", "市盈率相对盈利增长比率与市盈率不同")
        self.assertNormalized("Non-GAAP 与 GAAP", "非通用会计准则与通用会计准则")

    def test_fiscal_periods(self):
        self.assertNormalized("FY2025", "2025财年")
        self.assertNormalized("2026Q2", "2026年第二季度")
        self.assertNormalized("2026H1", "2026年上半年")
        self.assertNormalized("26Q2收入", "2026年第二季度收入")  # 两位数年份也要展开
        self.assertNormalized("26H1仅$221M", "2026年上半年仅2.21亿美元")
        self.assertNormalized("512张H800", "512张H800")  # 不误伤型号

    def test_currency_prefix_moves_after_amount(self):
        self.assertNormalized("US$3亿回购", "3亿美元回购")
        self.assertNormalized("目标价17.5美元", "目标价17.5美元")

    def test_percent_and_signs(self):
        self.assertNormalized("同比+8%", "同比正百分之8")
        self.assertNormalized("下跌空间-63.4%", "下跌空间负百分之63.4")
        self.assertNormalized("增速22-28%", "增速百分之22到28")
        self.assertNormalized("-17.1%→-14.3%", "负百分之17.1，负百分之14.3")

    def test_iso_dates_survive_the_range_rule(self):
        self.assertNormalized("数据截至2026-06-30", "数据截至2026年6月30日")
        self.assertNormalized("区间22-28%不受影响", "区间百分之22到28不受影响")

    def test_magnitude_suffixes(self):
        self.assertNormalized("市值US$8.5B", "市值85亿美元")
        self.assertNormalized("回购US$250M", "回购2.5亿美元")
        self.assertNormalized("FY2025收入34,639M", "2025财年收入346.39亿")  # 千分位要整段吃掉
        self.assertNormalized("现金储备10,552M", "现金储备105.52亿")
        self.assertNormalized("约HKD72B", "约720亿港元")  # 字母货币码不挡住量级换算
        self.assertNormalized("原生4K视频直出", "原生4K视频直出")  # K 不是量级后缀

    def test_unknown_latin_tokens_are_reported_not_swallowed(self):
        spoken, unknown = normalize("公司披露 XYZS 指标")
        self.assertIn("XYZS", spoken)
        self.assertEqual(unknown, ["XYZS"])

    def test_single_letter_leftovers_are_reported(self):
        self.assertEqual(normalize("2026年Q2营收")[1], ["Q"])
        self.assertEqual(normalize("A股、B站与H股")[1], [])  # 词表放行，中文音色本来就读得对
        self.assertEqual(normalize("B端开放平台")[1], ["B"])  # 放行只在 "B站" 这个上下文里成立
        self.assertEqual(normalize("公司持有IP与UP主资源")[1], [])  # 词表展开产出的字母不算残留


if __name__ == "__main__":
    unittest.main()
