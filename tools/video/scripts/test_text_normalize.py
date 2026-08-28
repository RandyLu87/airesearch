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

    def test_currency_prefix_moves_after_amount(self):
        self.assertNormalized("US$3亿回购", "3亿美元回购")
        self.assertNormalized("目标价17.5美元", "目标价17.5美元")

    def test_percent_and_signs(self):
        self.assertNormalized("同比+8%", "同比正百分之8")
        self.assertNormalized("下跌空间-63.4%", "下跌空间负百分之63.4")
        self.assertNormalized("增速22-28%", "增速百分之22到28")
        self.assertNormalized("-17.1%→-14.3%", "负百分之17.1，负百分之14.3")

    def test_unknown_latin_tokens_are_reported_not_swallowed(self):
        spoken, unknown = normalize("公司披露 XYZS 指标")
        self.assertIn("XYZS", spoken)
        self.assertEqual(unknown, ["XYZS"])


if __name__ == "__main__":
    unittest.main()
