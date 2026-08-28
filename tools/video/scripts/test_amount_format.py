"""金额规范化的回归用例 —— tools/video/scripts/amount_format.py。

这一层会改动财务数字的写法，所以两件事必须钉死：换算结果精确，
以及**认不出来的一律原样返回**——猜出来的单位比难看的单位危险得多。
"""

import unittest

from amount_format import format_amount


class FormatAmountTest(unittest.TestCase):
    def test_百万换算成亿(self):
        # 仓库现状里最难听的一条：会被中文音色读成「…点二九百万元 C N Y」
        self.assertEqual(format_amount("11928.29百万元CNY"), "119.28亿元")
        self.assertEqual(format_amount("10058.43百万元CNY"), "100.58亿元")
        self.assertEqual(format_amount("369,281百万元"), "3692.81亿元")

    def test_千元与千美元(self):
        self.assertEqual(format_amount("5,994,000千元人民币"), "59.94亿元")
        # 0.53 亿在中文里该读成 5307.5 万，不该硬套「亿」
        self.assertEqual(format_amount("53,075千美元"), "5307.5万美元")

    def test_已经是亿的原样保留数值(self):
        self.assertEqual(format_amount("199.57亿美元"), "199.57亿美元")
        self.assertEqual(format_amount("2,608.26 亿元"), "2608.26亿元")
        self.assertEqual(format_amount("RMB815亿"), "815亿元")
        self.assertEqual(format_amount("RMB 267.26亿元"), "267.26亿元")
        self.assertEqual(format_amount("5,595亿元"), "5595亿元")

    def test_尾随注释原样跟在后面(self):
        self.assertEqual(format_amount("53,075千美元（同比+143.4%）"), "5307.5万美元（同比+143.4%）")
        self.assertEqual(
            format_amount("777.20亿元（Tushare fina_mainbz口径，四舍五入至0.1亿）"),
            "777.2亿元（Tushare fina_mainbz口径，四舍五入至0.1亿）",
        )

    def test_缺量级或缺币种一律不改写(self):
        # AMD 与富途的原文就是纯数字：既可能是百万也可能是亿，猜错就是编数字
        self.assertEqual(format_amount("16635"), "16635")
        self.assertEqual(format_amount("10572.744"), "10572.744")
        self.assertEqual(format_amount("815亿"), "815亿")  # 有量级没币种
        self.assertEqual(format_amount("123元"), "123元")  # 有币种没量级

    def test_认不出的写法原样返回(self):
        for raw in ["", "   ", "暂无数据", "约占三成", "__TODO__"]:
            self.assertEqual(format_amount(raw), raw)

    def test_非字符串原样返回(self):
        self.assertEqual(format_amount(None), None)
        self.assertEqual(format_amount(16635), 16635)

    def test_换算走精确运算而不是浮点(self):
        # 0.1 + 0.2 那类浮点误差不能出现在金额上
        self.assertEqual(format_amount("0.29百万元"), "29万元")
        self.assertEqual(format_amount("1234.5678百万元"), "12.35亿元")

    def test_不足一万时不硬套量级词(self):
        self.assertEqual(format_amount("5千元"), "5000元")

    # --- 以下是仓库里还没出现、但后续报告很可能写成的形态 ---

    def test_英文量级后缀(self):
        self.assertEqual(format_amount("12.3B美元"), "123亿美元")
        self.assertEqual(format_amount("US$8.5B"), "85亿美元")
        self.assertEqual(format_amount("3,500mn USD"), "35亿美元")

    def test_不认K免得吃掉分辨率(self):
        # 研究数据里 K 的常态是 4K视频 / 2K分辨率，认成「千」会把它们变成金额
        self.assertEqual(format_amount("4K视频"), "4K视频")
        self.assertEqual(format_amount("3.2K美元"), "3.2K美元")

    def test_限定词原样带回去(self):
        # 把「约」抹掉等于把估算值说成精确值
        self.assertEqual(format_amount("约1,234百万元"), "约12.34亿元")
        self.assertEqual(format_amount("近500百万美元"), "近5亿美元")

    def test_万亿(self):
        self.assertEqual(format_amount("12000亿元"), "1.2万亿元")
        self.assertEqual(format_amount("1.2万亿元"), "1.2万亿元")
        # 「万亿」必须排在「万」前面匹配，否则会被当成 1.2 万
        self.assertEqual(format_amount("2万亿美元"), "2万亿美元")

    def test_币种写在前面(self):
        self.assertEqual(format_amount("USD 12.5亿"), "12.5亿美元")
        self.assertEqual(format_amount("¥3,200百万"), "32亿元")
        self.assertEqual(format_amount("7,890千港元"), "789万港元")


if __name__ == "__main__":
    unittest.main()
