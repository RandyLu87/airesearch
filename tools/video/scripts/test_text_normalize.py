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
        # 日期里的月/日也是两位数：两位数财报期规则若跑在前面会把 "05 Q2" 吃成 "2005年第二季度"。
        # 这条守的是**日期没被吃掉**；后面孤立的 Q2 / H1 该正常展开成中文，它们单独出现时
        # 留成字母才会被逐字母念出来。
        self.assertNormalized("2026-08-05 Q2 财报", "2026年8月5日第二季度财报")
        self.assertNormalized("2026/08/05 H1", "2026年8月5日上半年")
        self.assertNormalized("区间22-28%不受影响", "区间百分之22到28不受影响")

    def test_slash_dates_and_day_ranges(self):
        self.assertNormalized("2026/03/18发布", "2026年3月18日发布")
        self.assertNormalized("2026-08-19/20 Q2业绩会", "2026年8月19日到20日第二季度业绩会")
        self.assertNormalized("2026-07-02/03）", "2026年7月2日到3日）")
        # 分隔符必须一致，否则 URL 路径里的 "2026-04/17" 会被当成日期
        self.assertNormalized("articleFileDir/2026-04/17/1b9", "articleFileDir/2026到04/17/1b9")
        # 区间尾段只认两位数且后面不接字母/数字/"."/"-"，挡住哈希前缀、文件名和次段日期
        self.assertNormalized("uploads/2023/03/22/8d30", "uploads/2023年3月22日/8d30")
        self.assertNormalized("finalpage/2026-03-28/1225047590", "finalpage/2026年3月28日/1225047590")
        self.assertNormalized("2026-07-02/07-06", "2026年7月2日/07到06")

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
        self.assertEqual(normalize("2026年X2营收")[1], ["X"])
        self.assertEqual(normalize("A股、B站与H股")[1], [])  # 词表放行，中文音色本来就读得对
        self.assertEqual(normalize("B端与C端毛利率")[1], [])
        self.assertEqual(normalize("美国1260H清单")[1], [])
        self.assertEqual(normalize("B轮融资")[1], ["B"])  # 放行只在词表列出的上下文里成立
        self.assertEqual(normalize("公司持有IP与UP主资源")[1], [])  # 词表展开产出的字母不算残留

    def test_unit_suffixes_glued_to_numbers(self):
        """贴在数字后面的计量单位。**词表管不了它们**——缩写展开的前边界挡着数字，
        登记进词表只会让它「已登记」而不再报进 unknownTokens，变成静默读错。"""
        self.assertNormalized("增速差达20.5pct", "增速差达20.5个百分点")
        self.assertNormalized("毛利率同比+0.8pp", "毛利率同比正0.8个百分点")
        self.assertNormalized("净息差下降15bp", "净息差下降15个基点")
        self.assertNormalized("同比+12bps", "同比正12个基点")

    def test_bare_fiscal_periods_expand(self):
        self.assertNormalized("H1营收同比增长", "上半年营收同比增长")
        self.assertNormalized("2026年Q2", "2026年第二季度")
        # 带年份的写法仍走原来那两条规则，不能被这条抢走
        self.assertNormalized("报告期2026H1", "报告期2026年上半年")
        self.assertNormalized("26Q2", "2026年第二季度")


if __name__ == "__main__":
    unittest.main()
