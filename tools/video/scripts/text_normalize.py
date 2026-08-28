"""朗读前的中文文本规范化。

研究报告里的原文混着英文缩写、货币前缀、百分号和季度写法（"US$3亿"、"35.11x PE"、
"2026Q2 -13.7%"），直接喂给中文音色会读错或读漏。这里把它们改写成中文音色能正确朗读的
写法，规则全部确定性、可复核，词表在 `tts_lexicon.json`，新增缩写不用改代码。

改写只做"同义展开"，不引入原文没有的判断或数字（见 OWLL-46 的约束）。
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from pathlib import Path

LEXICON_PATH = Path(__file__).with_name("tts_lexicon.json")

# 规范化后仍残留的英文串大概率是词表没覆盖的缩写，逐条报出来让人补词表。单字母也要收
# （"2026年Q2" 里的 Q 就是这么漏掉的）；词表展开本身产出的字母另行放行，见 _allowed_latin。
_RESIDUAL_LATIN = re.compile(r"(?<![A-Za-z])[A-Za-z]+(?![A-Za-z])")
_CJK_UNIT = "万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千"
# K 只在 "4K视频"/"2K分辨率" 这类词里出现，研究数据里没有一处是量级后缀，故不认 K。
_MAGNITUDES = {"B": 10**9, "M": 10**6}
_NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"


def load_lexicon(path: Path = LEXICON_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _allowed_latin(lex: dict) -> tuple[set[str], set[str]]:
    """不该报进 unknownTokens 的英文串，分两类返回 (无条件放行, 带后缀才放行)。

    无条件的是词表键和词表展开结果里的字母（"IP" → "I P"）；allowedLatin 里带中文后缀的
    条目（"B站"）只在那个上下文里放行，否则 "26H1" 的 H 会被 "H股" 的放行顺带盖住。
    """
    acronyms = lex.get("acronyms", {})
    allowed = set(acronyms)
    for value in acronyms.values():
        allowed.update(re.findall(r"[A-Za-z]+", value))
    contextual = set()
    for entry in lex.get("allowedLatin", []):
        (contextual if re.fullmatch(r"[A-Za-z]+", entry) is None else allowed).add(entry)
    return allowed, contextual


def _acronym_pattern(key: str) -> re.Pattern:
    # 前边界挡住字母数字（避免 "2026Q2" 里误伤），后边界只挡字母（"PE35.11x" 仍需命中）。
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(key)}(?![A-Za-z])")


def _expand_magnitude(match: re.Match) -> str:
    """8.5B → 85亿；读作"八点五B"或"八点五十亿"都不对，换算成中文量级词再读。

    千分位要连着一起吃掉：只匹配尾组的话 "34,639M" 会被改写成 "34,6.39亿"，
    量级差 100 倍还不进 unknownTokens。货币前缀原样带回，交给后面的货币规则后置。
    """
    prefix, digits, suffix = match.group(1) or "", match.group(2), match.group(3)
    value = Decimal(digits.replace(",", "")) * _MAGNITUDES[suffix.upper()]
    if value >= 10**8:
        return f"{prefix}{_plain(value / 10**8)}亿"
    if value >= 10**4:
        return f"{prefix}{_plain(value / 10**4)}万"
    return f"{prefix}{_plain(value)}"


def _expand_date(match: re.Match) -> str:
    """2026-06-30 → 2026年6月30日；末尾带 "/20" 的日期区间读成 "到20日"。"""
    year, _, month, day, through = match.groups()
    tail = f"到{int(through)}日" if through else ""
    return f"{int(year)}年{int(month)}月{int(day)}日{tail}"


def _plain(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def normalize(text: str, lexicon: dict | None = None) -> tuple[str, list[str]]:
    """返回 (规范化文本, 未识别的英文串列表)。"""
    lex = lexicon if lexicon is not None else load_lexicon()
    out = text

    # 1) 符号级替换
    for src, dst in lex.get("replacements", {}).items():
        out = out.replace(src, dst)

    # 2) 缩写展开，长的优先，避免 GAAP 抢在 Non-GAAP 前面
    for key in sorted(lex.get("acronyms", {}), key=len, reverse=True):
        out = _acronym_pattern(key).sub(lex["acronyms"][key], out)

    # 3) 量级后缀：US$8.5B → US$85亿（先于货币规则，让 85亿 落进货币规则的数量词里）。
    #    货币前缀一并纳入匹配，否则 "HKD72B" 的数字被前面的字母挡在 lookbehind 外面不会展开。
    prefixes = "|".join(re.escape(c) for c in sorted(lex.get("currencies", {}), key=len, reverse=True)) or "(?!)"
    out = re.sub(
        rf"(?<![A-Za-z0-9.,])({prefixes})?\s*({_NUMBER})\s*([BM])(?![A-Za-z0-9])",
        _expand_magnitude,
        out,
    )

    # 4) 货币前缀后置：US$3亿 → 3亿美元
    for symbol in sorted(lex.get("currencies", {}), key=len, reverse=True):
        word = lex["currencies"][symbol]
        out = re.sub(
            rf"{re.escape(symbol)}\s*([\d,]+(?:\.\d+)?)\s*({_CJK_UNIT})?",
            lambda m, w=word: f"{m.group(1)}{m.group(2) or ''}{w}",
            out,
        )

    # 5) 财报期写法：FY2025 → 2025财年，2026Q2 → 2026年第二季度，2026H1 → 2026年上半年
    quarters = {"1": "一", "2": "二", "3": "三", "4": "四"}
    out = re.sub(r"(?<![A-Za-z0-9])FY\s*(\d{4})", r"\1财年", out)
    out = re.sub(r"(\d{4})\s*[Qq]([1-4])(?![\d])", lambda m: f"{m.group(1)}年第{quarters[m.group(2)]}季度", out)
    out = re.sub(r"(\d{4})\s*[Hh]([12])(?![\d])", lambda m: f"{m.group(1)}年{'上' if m.group(2) == '1' else '下'}半年", out)

    # 5b) 贴在数字后面的计量单位：20.5pct / 0.8pp / 15bp。**不能靠词表**——缩写展开的
    #     前边界是 `(?<![A-Za-z0-9])`（挡着 "2026Q2" 的误伤），数字紧跟着的后缀一律匹配
    #     不上。登记进词表反而更糟：匹配不上照样读成字母，却因为「已登记」不再报进
    #     unknownTokens，变成静默读错。长的排前面，ppt/bps 不能被 pp/bp 抢先吃掉。
    unit_suffixes = {"pct": "个百分点", "ppt": "个百分点", "pp": "个百分点", "bps": "个基点", "bp": "个基点"}
    out = re.sub(
        r"(?<=\d)\s*(ppt|pct|pp|bps|bp)(?![A-Za-z0-9])",
        lambda m: unit_suffixes[m.group(1).lower()],
        out,
        flags=re.IGNORECASE,
    )

    # 6) 日期要先于区间规则，否则 "2026-06-30" 会被读成 "2026到06到30"。斜杠写法
    #    （"2026/03/18"）走同一条规则，分隔符用反向引用锁死，混用两种分隔符的 URL 路径
    #    （"2026-04/17"）不会命中。末尾可选的 "/20" 是日期区间（"2026-08-19/20"）：只认两位
    #    数且后面不接字母、数字、"." 或 "-"，否则 "2023/03/22/8d30…" 的哈希前缀、
    #    "…/1225047590.PDF" 的文件名和 "2026-07-02/07-06" 的次段都会被当成结束日。
    out = re.sub(
        r"(?<!\d)(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:/(\d{2})(?![\dA-Za-z.-]))?(?!\d)",
        _expand_date,
        out,
    )

    #    两位数年份的财报期（"26Q2"、"26H1"）要排在日期之后：日期里的月/日也是两位数，
    #    先跑就会把 "2026-08-05 Q2" 的 "05 Q2" 吃成 "2005年第二季度"。lookbehind 同样挡住
    #    "/"，免得斜杠日期的尾段重蹈覆辙。
    out = re.sub(r"(?<![\dA-Za-z/])(\d{2})\s*[Qq]([1-4])(?![\d])", lambda m: f"20{m.group(1)}年第{quarters[m.group(2)]}季度", out)
    out = re.sub(
        r"(?<![\dA-Za-z/])(\d{2})\s*[Hh]([12])(?![\d])",
        lambda m: f"20{m.group(1)}年{'上' if m.group(2) == '1' else '下'}半年",
        out,
    )
    #    不带年份的 H1 / H2 / Q1-Q4（"H1营收同比+1.30%"、"2026年Q2"）：上面几条都要求
    #    紧邻着年份，不命中就剩个字母 H / Q 被逐字母念出来。必须排在带年份的规则之后，
    #    否则会抢先吃掉 "2026H1" 的尾段。
    out = re.sub(
        r"(?<![\dA-Za-z/])[Hh]([12])(?![\d])",
        lambda m: "上半年" if m.group(1) == "1" else "下半年",
        out,
    )
    out = re.sub(r"(?<![\dA-Za-z/])[Qq]([1-4])(?![\d])", lambda m: f"第{quarters[m.group(1)]}季度", out)

    # 7) 区间要先于正负号处理，否则 "22-28%" 会被读成 "22 负 28"；
    #    百分比区间的百分号只管到区间末尾，"22-28%" 应读成 "百分之22到28"
    out = re.sub(r"([\d.]+)\s*[-–~～]\s*([\d.]+)\s*(?:%|％)", r"百分之\1到\2", out)
    out = re.sub(r"(\d)\s*[-–~～]\s*(?=\d)", r"\1到", out)

    # 8) 倍数：35.11x → 35.11倍
    out = re.sub(r"([\d.]+)\s*[xX×](?![A-Za-z0-9])", r"\1倍", out)

    # 9) 百分号前置：-63.4% → 负百分之63.4
    out = re.sub(r"([+-])?([\d.]+)\s*(?:%|％)", lambda m: f"{_sign(m.group(1))}百分之{m.group(2)}", out)

    # 10) 剩余数字前的正负号。左边界必须用 ASCII 字符类：Python3 的 `\w` 连中文一起匹配，
    #     写成 `(?<![\w.])` 会让「同比+0.8个百分点」这种紧跟在中文后面的符号一个都匹配不上
    #     ——而那恰恰是研究正文里最常见的写法（带 % 的靠上一条规则兜住了，不带的就漏了）。
    out = re.sub(r"(?<![A-Za-z0-9_.])([+-])(?=[\d.])", lambda m: _sign(m.group(1)), out)

    # 11) 规范化留下的多余空白；缩写展开后中文之间的空格会被读成停顿，去掉
    out = re.sub(r"(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])", "", out)
    out = re.sub(r"[ \t]{2,}", " ", out).strip()

    allowed, contextual = _allowed_latin(lex)
    unknown = sorted(
        {
            m.group(0)
            for m in _RESIDUAL_LATIN.finditer(out)
            if m.group(0) not in allowed
            and not any(out.startswith(entry, m.start()) for entry in contextual)
        }
    )
    return out, unknown


def _sign(sign: str | None) -> str:
    if sign == "+":
        return "正"
    if sign == "-":
        return "负"
    return ""
