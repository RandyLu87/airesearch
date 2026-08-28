"""金额字符串规范化：把研究数据里十种写法统一成中文习惯的量级单位。

第 2 步的 `revenueBreakdown.items[].revenue` 是人写的自由文本，跨公司毫无统一口径——
仓库现状是 16 家公司约 10 种写法：

    11928.29百万元CNY      369,281百万元        RMB815亿         RMB 267.26亿元
    53,075千美元（同比+143.4%）                  2,608.26 亿元     5,994,000千元人民币，同比+12%
    199.57亿美元           16635（连单位都没有）

念出来尤其难听：「11928.29百万元CNY」会被中文音色读成「一万一千九百二十八点二九百万元
C N Y」。这里把能认出来的统一成「<数值><量级><币种>」，例如 `119.28亿元` / `5307.5万美元`。

两条硬规矩：

1. **换算靠 Decimal 精确运算，不靠心算**，且只做量级换算——不碰汇率，不合并口径。
   原文一并保留（调用方存进 `revenueRaw`），任何时候都能回去核对。
2. **认不出来就原样返回**。宁可留着「16635」这种没单位的原文，也不猜它是百万还是亿——
   猜出来的单位比难看的单位危险得多。

量级选「让数值 ≥ 1 的最大中文单位」：0.53 亿写成 5307.5 万才是中文的读法。
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

# 中文量级词 → 相对「元」的倍数。千/百万是财报里常见的英文口径直译，万/亿是中文读法。
MAGNITUDES = {
    "千": Decimal(10) ** 3,
    "万": Decimal(10) ** 4,
    "百万": Decimal(10) ** 6,
    "千万": Decimal(10) ** 7,
    "亿": Decimal(10) ** 8,
}

# 输出只用这两级：中文财经语境里「万」和「亿」之外的量级（百万/千）都是英文口径直译。
OUTPUT_UNITS = ((Decimal(10) ** 8, "亿"), (Decimal(10) ** 4, "万"))

# 币种的各种写法 → 统一叫法。前缀（RMB815亿）与后缀（815亿元人民币）都要认。
CURRENCIES = (
    (("元人民币", "人民币", "元CNY", "元RMB", "CNY", "RMB", "¥", "元"), "元"),
    (("美元", "USD", "US$", "$"), "美元"),
    (("港元", "港币", "HKD", "HK$"), "港元"),
)

# 「11928.29百万元CNY」→ 数值 / 量级 / 币种三段。允许千分位、允许量级与币种之间有空格。
_AMOUNT = re.compile(
    r"^\s*(?P<prefix>RMB|CNY|USD|HKD|US\$|HK\$|[¥$])?\s*"
    r"(?P<value>-?[\d,]+(?:\.\d+)?)\s*"
    r"(?P<magnitude>千万|百万|千|万|亿)?\s*"
    r"(?P<suffix>元人民币|元CNY|元RMB|人民币|美元|港元|港币|元|USD|CNY|RMB|HKD)?\s*"
    r"(?P<rest>.*)$",
    re.DOTALL,
)


def _currency_of(prefix: str, suffix: str) -> str | None:
    """前缀与后缀里认币种；两边都没写就返回 None（调用方据此放弃改写）。"""
    for token in (suffix, prefix):
        if not token:
            continue
        for spellings, canonical in CURRENCIES:
            if token in spellings:
                return canonical
    return None


def _trim(value: Decimal) -> str:
    """去掉无意义的尾零：119.2800 → 119.28，777.00 → 777。"""
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def format_amount(raw: str) -> str:
    """把一条金额原文改写成 `<数值><量级><币种>`；认不出来就原样返回。

    >>> format_amount("11928.29百万元CNY")
    '119.28亿元'
    >>> format_amount("53,075千美元（同比+143.4%）")
    '5307.5万美元（同比+143.4%）'
    >>> format_amount("16635")
    '16635'
    """
    if not isinstance(raw, str) or not raw.strip():
        return raw

    matched = _AMOUNT.match(raw)
    if not matched:
        return raw

    magnitude = matched.group("magnitude")
    currency = _currency_of(matched.group("prefix") or "", matched.group("suffix") or "")
    # 量级与币种缺了任何一个都不改写：「16635」既可能是百万也可能是亿，猜错就是编数字。
    if not magnitude or not currency:
        return raw

    try:
        value = Decimal(matched.group("value").replace(",", ""))
    except InvalidOperation:
        return raw

    in_yuan = value * MAGNITUDES[magnitude]
    for factor, label in OUTPUT_UNITS:
        if abs(in_yuan) >= factor:
            # 量化到两位小数：显示用精度，原文由调用方另存一份
            scaled = (in_yuan / factor).quantize(Decimal("0.01"))
            return f"{_trim(scaled)}{label}{currency}{matched.group('rest').strip()}"

    # 不足一万：直接按元报，不硬套量级词
    return f"{_trim(in_yuan.quantize(Decimal('0.01')))}{currency}{matched.group('rest').strip()}"
