#!/usr/bin/env python3
"""数据校验工具 — 研究流程第 4 步（docs/research/workflow/04-data-validation.md）。

对前三步落盘的 JSON（采集 / 分析 / 总结）做模板驱动的完整性校验与打分（满分 10 分）。
零外部依赖，仅用 Python 标准库，Python >= 3.7。

用法：
    python3 docs/research/tools/data_validator.py check \
        --collection research/companies/<id>/<采集文件>.json \
        --analysis   research/companies/<id>/<分析文件>.json \
        --summary    research/companies/<id>/<总结文件>.json \
        [--threshold 7] [--json] [--gaps-out gaps.json]

三个文件参数均可省略，只校验给出的文件。
退出码：0 = 全部放行；1 = 存在未放行的文件；2 = 参数或文件错误。

三道闸门，任一不过都拒绝放行：

    1. 完整性分数 —— 模板槽位的填写率，低于阈值不放行；
    2. 首屏可渲染性 —— 页头摘要条与首页卡片直读的四个字段（市值 / 股价 / PE /
       数据截止）必须能解析成一句话。分数只看填没填，看不出「填了但页面显示不出来」，
       这道闸门专门挡这种：字段写成页面认不出的形状时，读者看到的是破折号；
    3. 写法闸门（全量叶子扫描）—— 首屏四格之外的字段同样会被读到。两类写法页面
       认得出、但读者看到的是错的：裸占位字符串（`"unavailable"` 当值写，页面原样
       输出，5 年趋势表里拼出 `unavailable%`）与未缩写大数字（`23051044345` 直接
       渲染成 11 位数字）。见 scan_shape。

打分规则（模板驱动）：
    - 「槽位」= 模板中值含 __TODO__ 的叶子字段，或形如 "A | B | C" 的枚举提示字段；
      模板中的固定文本（title、question、免责声明等）不计分。
    - 已填（有实值且不含 __TODO__、不等于枚举提示原文）计 1 分权重；
    - 规范的 { "status": "unavailable" | "not-applicable", "reason": "..." } 计 0.5 分权重——
      「取不到并写明已查范围」「算不出并写明为什么」都是合法结果，但完整性弱于取到；
    - 缺键、残留 __TODO__、空值、枚举未选、unavailable 未写 reason 计 0 分并记入缺口清单；
    - 写法闸门命中的字段（裸占位字符串 / 未缩写大数字）同样计 0 分权重并记入缺口清单——
      这类字段有值，但读者看到的那句话是错的，按「没填」算；
    - 得分 = 10 × (已填 + 0.5 × unavailable) / 槽位总数，四舍五入到 1 位小数。

数组规则：模板数组为空（如 dataGaps: []）表示允许为空，跳过；模板数组含 N 个条目时，
实例第 i 项对照模板第 min(i, N-1) 项校验（单示例数组=逐项套用示例，定长数组=按位对照），
实例条目数少于模板条目数时，缺的条目按缺失计。
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evals_log  # noqa: E402  第 7 步的运行事件记账（写失败不阻断本流程）

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))          # docs/research/tools
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_TOOLS_DIR)))
MODEL_DIR = os.path.join(REPO_ROOT, "docs", "model")

TEMPLATES = {
    "collection": "financials—model-template.json",
    "analysis": "financials—analysis-template.json",
    "summary": "financials—summary-template.json",
}
STEP_LABELS = {
    "collection": "第 1 步·数据采集",
    "analysis": "第 2 步·多维度分析",
    "summary": "第 3 步·分析总结",
}

META_KEYS = {"_spec", "_dimension", "_hint"}
TODO = "__TODO__"


def is_enum_hint(value):
    return isinstance(value, str) and " | " in value and TODO not in value


def is_slot(value):
    """模板叶子是否为需要填写的槽位。"""
    if isinstance(value, str):
        return TODO in value or is_enum_hint(value)
    return False


## 「没有数值」的两种合法占位。unavailable = 查不到（来源没有 / 未披露），
## not-applicable = 算不出（分母为负、口径不成立，如亏损公司的 PE）。
## 打分上两者等价（均记 0.5 权重），区别只在页面怎么说这句话。
ABSENT_STATUSES = {"unavailable": "未取得", "not-applicable": "不适用"}


def absent_status(node):
    if not isinstance(node, dict):
        return None
    status = node.get("status")
    return status if isinstance(status, str) and status in ABSENT_STATUSES else None


def is_unavailable(node):
    return absent_status(node) is not None


# ---------------------------------------------------------------------------
# 首屏可渲染性闸门
#
# 完整性分数只看槽位填没填，看不出「填了但页面显示不出来」。理想汽车
# （hk-2015，H 股 + 美股 ADS 双重上市）就是这样发出去的：sharePrice 写成
# {hk: …, us_ads: …}、marketCap.reported 写成 {hk_hkd: …, us_usd: …}，
# 槽位全满、拿到 9.7 分，页头的市值与股价却是两个破折号
# （research/evals/defects.jsonl 2026-08-09 那条）。
#
# 下面这段解析规则是 apps/web/lib/field-text.ts 的 text() 的 Python 镜像，
# **两边必须同时改**：解析不出文本的首屏字段一律不放行。
# ---------------------------------------------------------------------------

# 字段对象里不承载数值的键：判断「这是不是多口径映射」时先剔除，
# 否则 source / note 之类的注解会被当成一个口径。
FIELD_ANNOTATION_KEYS = {
    "source", "source1", "source2", "sources", "url", "note", "notes", "flag",
    "deviationPct", "unit", "currency", "status", "reason", "method", "toolOutput",
    "toolVerified", "asOf", "_dimension",
}


def resolve_multi_field(value):
    """多市场 / 多币种字段：`{primary, alt[]}` 契约优先，其次是每个非注解键都挂着
    校验对象的映射（如 `{hk: …, us_ads: …}`）。**不认裸标量**——
    `{hk_hkd: 101219774273}` 把币种编进键名，没有单位可读，页面不替它猜。"""
    if "primary" in value:
        head = resolve_field(value["primary"])
        if head is None:
            return None
        raw_alt = value.get("alt")
        alt_items = raw_alt if isinstance(raw_alt, list) else ([] if raw_alt is None else [raw_alt])
        legs = [head] + [item for item in (resolve_field(a) for a in alt_items) if item]
    else:
        entries = [(k, v) for k, v in value.items() if k not in FIELD_ANNOTATION_KEYS]
        if not entries:
            return None
        if not all(isinstance(v, dict) and "value" in v for _, v in entries):
            return None
        legs = [item for item in (resolve_field(v) for _, v in entries) if item]
        if not legs:
            return None
    # 主口径在前，次口径进括号——与 field-text.ts 的 joinLegs() 一致。
    return "%s（%s）" % (legs[0], " / ".join(legs[1:])) if len(legs) > 1 else legs[0]


# 量级词表：`unit` 里可能出现的量级，**长的先匹配**（`万亿` 必须排在 `亿` 与 `万` 前面，
# 否则 `万亿元` 会被读成 `万`）。field-text.ts 的 MAGNITUDES 是同一张表。
MAGNITUDES = (
    ("万亿", 1e12), ("trillion", 1e12),
    ("十亿", 1e9), ("billion", 1e9), ("bn", 1e9),
    ("亿", 1e8),
    ("千万", 1e7),
    ("百万", 1e6), ("million", 1e6), ("mn", 1e6),
    ("万", 1e4),
    ("千", 1e3), ("thousand", 1e3),
)

# 占位币种：`-` / `N/A` 这类「没写」的写法，拼进单位串只会变成 `140.19 million ADS N/A`。
PLACEHOLDER_LABEL = re.compile(r"^(?:[-—–]+|n/?a|未?披露|\?+)$", re.I)


def magnitude_of(label):
    """单位串里声明的量级；没有量级词返回 None（`"HKD"`、`"股"`、`"currency"`）。"""
    lower = label.lower()
    for token, scale in MAGNITUDES:
        if token in lower:
            return scale
    return None


def magnitude_rest(label):
    """单位串去掉量级词后剩下的部分：`"百万"` → `""`，`"RMB million"` → `"RMB"`，
    `"亿股"` → `"股"`。剩下东西就说明这个单位自己点明了计量对象，不需要 currency 补。"""
    lower = label.lower()
    for token, _ in MAGNITUDES:
        at = lower.find(token)
        if at >= 0:
            return re.sub(r"[\s,，/·]+", " ", label[:at] + label[at + len(token):]).strip()
    return label.strip()


def annotation(value):
    """注解键（unit / currency）取成字符串：对象与 None 当作没写。"""
    if isinstance(value, str):
        return value.strip()
    if value is None or isinstance(value, (dict, list, bool)):
        return ""
    return str(value)


def unit_label(field):
    """校验对象的单位串——field-text.ts 的 unitLabel() 的镜像。

    默认取 currency，例外是「量级只写在 unit 里」：
    `{value: 751766, unit: "RMB million", currency: "RMB"}` 按 currency 优先会渲染成
    `751,766 RMB`，比真实值小 6 个量级。这种字段的语义是「数值 + 量级 + 币种」三元组，
    量级词不能被纯币种压掉，所以保留 unit；unit 只写量级不写币种（`"百万"`）时把
    currency 接在后面。只在 value 是裸数字时这么做（缩写过的 value 再叠一次量级就是
    乘两次），currency 自己也带量级（`"RMB百万"`）时照旧取 currency。

    currency 只补给**纯量级** unit（`"百万"`）：unit 去掉量级词后还剩东西，它自己就点明了
    计量对象——`"RMB million"` 的币种、`"亿股"` 的股数、`"million ADS"` 的凭证数——再接
    currency 会拼出 `252.2 亿股 CNY`（招行 sharesOutstanding）这种读不通的串。

    `-` / `n/a` 这类占位 currency 一律当成没写，否则它非空、会压过真正的 unit。
    """
    unit = annotation(field.get("unit"))
    # 占位币种当成没写：`-` / `n/a` 非空，会在下面每一条「取 currency」的分支里压过
    # 真正的单位——快手 sharesOutstanding 渲染成 `43.3亿 -`，读者看不出计量的是股数。
    declared = annotation(field.get("currency"))
    currency = "" if PLACEHOLDER_LABEL.match(declared) else declared
    if not unit or not currency:
        return currency or unit
    if not is_bare_number(field.get("value")):
        return currency
    if magnitude_of(unit) is None or magnitude_of(currency) is not None:
        return currency
    if magnitude_rest(unit) != "":
        return unit
    return "%s %s" % (unit, currency)


def resolve_field(value):
    """把字段解析成页面会显示的文本；页面显示不出来时返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int, float)):
        return str(value)
    if not isinstance(value, dict):
        return None
    absent = absent_status(value)
    if absent:
        # 缺失必须带原因：只写 status 的字段在页面上和「没这个字段」没有区别。
        reason = value.get("reason")
        return "%s：%s" % (ABSENT_STATUSES[absent], reason) if reason else None
    if "value" in value:
        return ("%s %s" % (value["value"], unit_label(value))).strip()
    return resolve_multi_field(value)


# 页头摘要条与首页卡片直接读的字段：这几格是报告最先被读到的地方。
HEADLINE_FIELDS = (
    ("市值", ("currentValuation", "marketCap", "reported")),
    ("股价", ("currentValuation", "sharePrice")),
    ("PE", ("currentValuation", "pe")),
    ("数据截止", ("meta", "dataCutoff")),
)

HEADLINE_HINT = (
    "首屏字段必须能解析成一句话：标量（\"190.36B HKD（…）\"）、校验对象"
    "（{\"value\": 44.18, \"currency\": \"HKD\", …}）、多市场对象"
    "（{\"primary\": {…}, \"alt\": [{…}]}），或带 reason 的 "
    "{\"status\": \"unavailable\" | \"not-applicable\", \"reason\": \"…\"}。"
)


def dig(node, path):
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def summarize_node(node):
    if node is None:
        return "（字段不存在）"
    try:
        raw = json.dumps(node, ensure_ascii=False)
    except (TypeError, ValueError):
        raw = repr(node)
    return raw if len(raw) <= 120 else raw[:117] + "..."


def check_headline(instance):
    """首屏四格逐个解析，解析不出来的返回一条问题。"""
    problems = []
    for label, path in HEADLINE_FIELDS:
        node = dig(instance, path)
        if resolve_field(node) is None:
            problems.append({
                "label": label,
                "path": ".".join(path),
                "found": summarize_node(node),
            })
    return problems


# ---------------------------------------------------------------------------
# 写法闸门（全量叶子扫描）
#
# 首屏闸门只看四个字段，但报告里被读到的字段远不止四个。这里扫全树，挡两类
# 「页面认得出、读者看到的却是错的」写法——三类都发生过：
#
#   1. 裸占位字符串：`grossMarginPct: "unavailable"` 而不是
#      { "status": "unavailable", "reason": … }。渲染层 text() 对字符串原样输出，
#      百分比列再拼一个后缀，页面上就是 `unavailable%`。resolve_field() 也会把它
#      str() 成非 None，分数上被当作「已填」——所以必须单独挡。
#   2. 未缩写大数字：`{ "value": 23051044345, "currency": "HKD" }`。缩写是采集/分析
#      文件的约定（`"230.51亿"` / `"23.05B"`），渲染层不猜量级（field-text.ts 的
#      formatNumeric 只加千分位），漏写就是页头一串 11 位数字。
#   3. 量级被币种压掉：`{ "value": 751766, "unit": "RMB million", "currency": "RMB" }`。
#      量级只写在 unit 里，旧的 `currency ?? unit` 取值规则把它丢了，页面显示
#      `751,766 RMB`（腾讯 FY2024 收入，实为 7,517.66 亿元）。渲染层与 unit_label()
#      现在都保留 unit 的量级；这条检测挡的是两侧规则再次漂移，以及 unit 与 currency
#      各自声明不同量级、渲染层无法判断的写法。
#
# 注意：这三条不改 resolve_field() / text() 的解析规则——两边的解析规则仍是镜像，
# 这里加的是「解析得出来但不该这么写」的前置拦截。
# ---------------------------------------------------------------------------

# 大数字缩写阈值：百万起就该缩写。财报量级的数字（收入、市值、股本）一律超过它，
# 而股价、倍数、百分比这些天然的小数值不会被误伤。
ABBREV_THRESHOLD = 1e6

# 纯数字字符串：`"23051044345"` / `"23,051,044,345"` / `"1234.5"`。
# 渲染层的 formatNumeric 只作用于 number，字符串一律原样输出——「stringify 了但没缩写」
# 在页面上和裸数字完全一样，所以同样命中。
NUMERIC_STRING = re.compile(r"^-?\d[\d,]*(\.\d+)?$")

SHAPE_LABELS = {
    "bare-absent-string": "裸占位字符串",
    "unabbreviated-number": "大数字未缩写",
    "unit-overridden-by-currency": "量级被币种压掉",
    "placeholder-unit-label": "单位写成占位符",
    "mixed-notation": "同一文件内记数法混用",
}

SHAPE_HINTS = {
    "bare-absent-string":
        "「取不到 / 不适用」必须写成完整对象 "
        "{ \"status\": \"unavailable\" | \"not-applicable\", \"reason\": \"缺失原因 + 已查范围\" }；"
        "裸字符串会被原样渲染（百分比列里拼成 unavailable%）。",
    "unabbreviated-number":
        "大额数字按采集/分析约定写成缩写字符串（\"230.51亿\" / \"23.05B\"）；"
        "货币之外的计数单位（股 / 辆 / 户 / MAU）同样要缩写（\"2.05亿\"）。"
        "渲染层不猜量级，裸数字会整串拼进页面——只加引号不缩写（\"23051044345\"）"
        "渲染出来一模一样，同样算没改。",
    "unit-overridden-by-currency":
        "`unit` 与 `currency` 各自声明了不同的量级（如 unit \"RMB million\" 对 "
        "currency \"RMB billion\"），渲染层无法判断哪个才是 value 的量级。"
        "把量级只留在一处：unit 写全（\"RMB million\"）、currency 只写币种（\"RMB\"），"
        "或者干脆把量级折进 value 的缩写字符串（\"7517.66亿\"）。",
    "placeholder-unit-label":
        "`unit` / `currency` 只写真单位，没有就写 null——`\"-\"` / `\"n/a\"` / `\"—\"` 这类占位符"
        "字符串非空，渲染层拿它当单位拼在数值后面（`43.3亿 -`）；currency 位上的占位符还会"
        "压过真正的 unit，读者看不出计量的是股数还是钱。",
    "mixed-notation":
        "同一份公司文件里的金额数字只用一套记数法：中文量级（\"1044.61亿\"）或英文缩写"
        "（\"104.46B\"）。两套并存不是错值，但同一页里两种量级要读者自己换算——"
        "按该文件里占多数的那套改写少数派（数值语义不变）。计数类单位（股 / 辆 / 户）"
        "与 source1 / source2 里照抄来源原文的数值副本不在此列。",
}


def is_bare_absent(value):
    """值本身就是 `"unavailable"` / `"not-applicable"` 字符串（而不是规范占位对象）。"""
    return isinstance(value, str) and value.strip() in ABSENT_STATUSES


def is_unabbreviated_number(node):
    """标了 currency/unit 的校验对象，value 却是裸大数字。"""
    if not isinstance(node, dict) or "value" not in node:
        return False
    if not (node.get("currency") or node.get("unit")):
        return False
    return is_unabbreviated_value(node["value"])


def is_bare_number(value):
    """未缩写的裸数字：Python 数字，或只 stringify 过的纯数字串（`"751,766"`）。
    缩写过的 `"7517.66亿"` / `"23.05B"` 不算。"""
    if isinstance(value, bool):
        return False
    if isinstance(value, str):
        return bool(NUMERIC_STRING.match(value.strip()))
    return isinstance(value, (int, float))


def is_unabbreviated_value(value):
    """裸大数字：裸数字且已经到了该缩写的量级。"""
    if not is_bare_number(value):
        return False
    number = float(value.strip().replace(",", "")) if isinstance(value, str) else value
    return abs(number) >= ABBREV_THRESHOLD


def is_unit_magnitude_dropped(node):
    """量级只写在 `unit` 里，渲染出来的文本却没带上它。

    `{value: 751766, unit: "RMB million", currency: "RMB"}` 在旧的 `currency ?? unit`
    取值规则下渲染成 `751,766 RMB`，比真实值小 6 个量级（腾讯 FY2024 收入，全仓库同类
    写法 160 处）。渲染层与本文件的 `unit_label()` 现在都保留 unit 的量级，所以这条
    检测既是那次改动的回归闸门（两侧解析规则一旦再次漂移就报），也挡住剩下那种渲染层
    无法判断的写法：unit 与 currency 各自声明了**不同**的量级。
    """
    if not isinstance(node, dict) or "value" not in node:
        return False
    unit, currency = annotation(node.get("unit")), annotation(node.get("currency"))
    if not (unit and currency and is_bare_number(node["value"])):
        return False
    scale = magnitude_of(unit)
    if scale is None:
        return False
    return magnitude_of(unit_label(node)) != scale


def placeholder_unit_labels(node):
    """`unit` / `currency` 写成占位符的键名。

    `"-"` / `"n/a"` / `"—"` 是「这里没有单位」的意思，但它们是非空字符串：渲染层照单位
    拼在数值后面（快手 sharesOutstanding 渲染成 `43.3亿 -`），currency 位上的占位符还会
    压过真正的 unit。`unit_label()` 现在把它们当没写（OWLL-27 / PR #19），所以这条检测
    挡的是数据层——没有单位就写 `null`，不要用字符串占位。
    """
    if not isinstance(node, dict):
        return []
    return [key for key in ("unit", "currency")
            if key in node and PLACEHOLDER_LABEL.match(annotation(node.get(key)))]


# ---------------------------------------------------------------------------
# 记数法一致性（文件级）
#
# 金额缩写有两套记数法：中文量级（`"1044.61亿"`）与英文缩写（`"104.46B"`）。两套都对，
# 混在同一份文件里就不对——理想汽车 hk-2015 的市值一处写 `"101.22B"`（reported）、
# 一处写 `"1044.61亿"`（computed），同一个指标在同一页上要读者自己换算两套量级。
#
# 判定基准是「同一文件内是否两套并存」，不是上市地：快手是港股中文报告，`亿` 在那份
# 文件里本来就是主流写法，按上市地一刀切会误伤。两类不算数：
#   - 计数类单位（股 / 辆 / 户 / MAU）——中文里「3.49亿股」是自然写法，与金额记数法无关；
#   - `source1` / `source2` 里的数值副本——那是照抄来源原文，来源怎么写就怎么记。
# ---------------------------------------------------------------------------

# 缩写过的金额字符串：`"1044.61亿"` / `"104.46B"` / `"81.5bn"`，币种词可以带在里面
# （`"230.51亿元"`）。裸数字（未缩写）由 unabbreviated-number 那条管，不在这里重复报。
#
# 只认「数字 + 量级（+ 币种）」这一种整串写法：`"6,071亿美元（2029年，全球生成式AI市场
# 规模预测）"`（MiniMax 引自 IDC 的行业 TAM）这类带括号注释的引述不参与比较——它是照抄
# 来源原文的一句话，改写它等于改写引文，不是本文件自己的记数法。
CN_ABBREV = re.compile(r"^-?\d[\d,]*(\.\d+)?\s*(万亿|亿|千万|百万|万|千)\s*"
                       r"(元|美元|港元|港币|人民币|日元|欧元|美金)?$")
EN_ABBREV = re.compile(r"^-?\d[\d,]*(\.\d+)?\s*(trillion|billion|million|thousand|bn|mn|[TBMK])\s*"
                       r"(RMB|CNY|HKD|USD|EUR|JPY|GBP|TWD|SGD|KRW)?$", re.I)

# 币种词表：只有金额字段参与记数法比较，靠 unit / currency 里的币种词认出来。
CURRENCY_TOKENS = ("rmb", "cny", "hkd", "usd", "eur", "jpy", "gbp", "twd", "sgd", "krw",
                   "人民币", "港元", "港币", "美元", "美金", "日元", "欧元", "元")

# 数值副本所在的键：来源怎么写就怎么记，不参与本文件的记数法比较。
PROVENANCE_KEYS = {"source1", "source2", "sources", "source"}


def is_currency_label(label):
    lower = label.lower()
    return any(token in lower for token in CURRENCY_TOKENS)


def notation_of(value):
    """缩写字符串用的是哪套记数法：`"cn"` / `"en"` / None（没缩写或不是数字）。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if CN_ABBREV.match(text):
        return "cn"
    if EN_ABBREV.match(text):
        return "en"
    return None


def scan_notation(node, path="", found=None):
    """收集金额字段用的记数法，返回 [(path, "cn" | "en")]。"""
    if found is None:
        found = []
    if isinstance(node, dict):
        unit, currency = annotation(node.get("unit")), annotation(node.get("currency"))
        if "value" in node and (is_currency_label(unit) or is_currency_label(currency)):
            notation = notation_of(node["value"])
            if notation:
                found.append((path, notation))
        for key, value in node.items():
            if key in META_KEYS or key in PROVENANCE_KEYS:
                continue
            scan_notation(value, "%s.%s" % (path, key) if path else key, found)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            scan_notation(item, "%s[%d]" % (path, i), found)
    return found


def mixed_notation_problems(instance):
    """两套记数法并存时，把少数派的字段逐个报出来（并列时报后出现的那一套）。"""
    found = scan_notation(instance)
    groups = {"cn": [p for p, n in found if n == "cn"], "en": [p for p, n in found if n == "en"]}
    if not (groups["cn"] and groups["en"]):
        return []
    # 少数派要改写；数量相同时改后出现的那一套（先立住的写法是这份文件的基调）。
    first_seen = {notation: index for index, (_, notation) in reversed(list(enumerate(found)))}
    minority = min(groups, key=lambda n: (len(groups[n]), -first_seen[n]))
    majority = "en" if minority == "cn" else "cn"
    label = {"cn": "中文量级", "en": "英文缩写"}
    return [{
        "path": path,
        "type": "mixed-notation",
        "found": "%s（本文件金额多数用%s，如 %s）"
                 % (label[minority], label[majority], groups[majority][0]),
    } for path in groups[minority]]


def scan_shape(node, path="", problems=None):
    """全量扫描写法问题，返回 [{path, type, found}]。"""
    if problems is None:
        problems = []
    if isinstance(node, dict):
        if is_unit_magnitude_dropped(node):
            problems.append({
                "path": path,
                "type": "unit-overridden-by-currency",
                "found": "%s（unit %s / currency %s）" % (node["value"], node.get("unit"),
                                                        node.get("currency")),
            })
        for key in placeholder_unit_labels(node):
            problems.append({
                "path": "%s.%s" % (path, key) if path else key,
                "type": "placeholder-unit-label",
                "found": "%s: %r" % (key, node[key]),
            })
        if is_unabbreviated_number(node):
            problems.append({
                "path": path,
                "type": "unabbreviated-number",
                "found": ("%s %s" % (node["value"],
                                     node.get("currency") or node.get("unit"))).strip(),
            })
        for key, value in node.items():
            if key in META_KEYS:
                continue
            # `status: "unavailable"` 是规范占位对象的一部分，不是裸占位；
            # 缺 reason 的情况由 walk() / resolve_field() 管。
            if key == "status" and is_bare_absent(value):
                continue
            scan_shape(value, "%s.%s" % (path, key) if path else key, problems)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            scan_shape(item, "%s[%d]" % (path, i), problems)
    elif is_bare_absent(node):
        problems.append({"path": path, "type": "bare-absent-string", "found": node})
    return problems


class Tally:
    def __init__(self):
        self.filled = 0
        self.unavailable = 0
        self.gaps = []  # 每条: {path, type, expected}
        self.filled_paths = set()  # 计了满权重的槽位，写法闸门要按 path 收回

    def fill(self, path):
        self.filled += 1
        self.filled_paths.add(path)

    def demote(self, *paths):
        """写法闸门命中一个已计满权重的槽位：收回那 1 分，返回被收回的 path。

        模板把校验对象写成标量槽位时（`marketCap.reported: "__TODO__（校验对象…）"`），
        walk() 记的是父 path；模板展开到 value 时记的是 `<path>.value`。两种都试。
        """
        for path in paths:
            if path in self.filled_paths:
                self.filled_paths.discard(path)
                self.filled -= 1
                return path
        return None

    @property
    def required(self):
        return self.filled + self.unavailable + len(self.gaps)

    def gap(self, path, gap_type, expected):
        if isinstance(expected, str) and len(expected) > 120:
            expected = expected[:117] + "..."
        self.gaps.append({"path": path, "type": gap_type, "expected": expected})

    def score(self):
        if self.required == 0:
            return 10.0
        return round(10.0 * (self.filled + 0.5 * self.unavailable) / self.required, 1)


def count_slots_as_missing(template, path, tally, gap_type="missing"):
    """模板子树整体缺失时，把其中所有槽位记为缺口。"""
    if isinstance(template, dict):
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            count_slots_as_missing(tval, "%s.%s" % (path, key), tally, gap_type)
    elif isinstance(template, list):
        if template:
            count_slots_as_missing(template[0], path + "[0]", tally, gap_type)
    elif is_slot(template):
        tally.gap(path, gap_type, template)


def mark_unavailable(template, path, tally, has_reason):
    """实例以 unavailable 替代模板子树：有 reason 记 0.5 权重，无 reason 记缺口。"""
    if isinstance(template, dict):
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            mark_unavailable(tval, "%s.%s" % (path, key), tally, has_reason)
    elif isinstance(template, list):
        if template:
            mark_unavailable(template[0], path + "[0]", tally, has_reason)
    elif is_slot(template):
        if has_reason:
            tally.unavailable += 1
        else:
            tally.gap(path, "unavailable-without-reason", template)


def walk(template, instance, path, tally):
    if isinstance(template, dict):
        if is_unavailable(instance):
            mark_unavailable(template, path, tally, bool(instance.get("reason")))
            return
        if not isinstance(instance, dict):
            count_slots_as_missing(template, path, tally)
            return
        for key, tval in template.items():
            if key in META_KEYS:
                continue
            child_path = "%s.%s" % (path, key) if path else key
            if key not in instance:
                count_slots_as_missing(tval, child_path, tally)
            else:
                walk(tval, instance[key], child_path, tally)
    elif isinstance(template, list):
        if not template:
            return  # 模板允许为空的数组（如 dataGaps）
        if not isinstance(instance, list):
            count_slots_as_missing(template[0], path + "[0]", tally,
                                   "missing" if instance is None else "type-mismatch")
            return
        n = max(len(instance), len(template))
        for i in range(n):
            t_item = template[min(i, len(template) - 1)]
            item_path = "%s[%d]" % (path, i)
            if i < len(instance):
                walk(t_item, instance[i], item_path, tally)
            else:
                count_slots_as_missing(t_item, item_path, tally)
    else:
        if not is_slot(template):
            return  # 模板固定文本，不计分
        if instance is None or instance == "":
            tally.gap(path, "empty", template)
        elif isinstance(instance, str) and TODO in instance:
            tally.gap(path, "todo", template)
        elif is_enum_hint(template) and instance == template:
            tally.gap(path, "unfilled-enum", template)
        elif is_unavailable(instance):
            if instance.get("reason"):
                tally.unavailable += 1
            else:
                tally.gap(path, "unavailable-without-reason", template)
        elif is_bare_absent(instance):
            # 裸 "unavailable" 有值但不是占位对象：resolve_field() 会 str() 出非 None，
            # 不在这里拦就会当作「已填」计 1 分。写法闸门另有一条同 path 的记录，check_file 去重。
            tally.gap(path, "bare-absent-string", template)
        else:
            tally.fill(path)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        sys.stderr.write("错误：找不到%s文件 %s\n" % (what, path))
        sys.exit(2)
    except json.JSONDecodeError as exc:
        sys.stderr.write("错误：%s文件不是合法 JSON（%s）：%s\n" % (what, exc, path))
        sys.exit(2)


def check_file(step, instance_path):
    template_path = os.path.join(MODEL_DIR, TEMPLATES[step])
    template = load_json(template_path, "模板")
    instance = load_json(instance_path, STEP_LABELS[step])
    tally = Tally()
    walk(template, instance, "", tally)
    # 写法问题独立于模板：命中的字段可能根本不在模板槽位上（如 source2.name），
    # 一律补记为 0 分权重缺口；walk() 已记过的同一 path 不重复计。
    # 记数法一致性是文件级判断（「同一份文件内是否两套并存」），单个节点上看不出来。
    shape_problems = scan_shape(instance) + mixed_notation_problems(instance)
    recorded = {(g["path"], g["type"]) for g in tally.gaps}
    for problem in shape_problems:
        key = (problem["path"], problem["type"])
        if key in recorded:
            continue
        recorded.add(key)
        # 命中的字段 walk() 多半已按「已填」记过满权重：先把那 1 分收回再记缺口，
        # 分母不变、分子 -1，落到「命中即计 0 分权重」；没记过的（如 source2.name
        # 这类模板外字段）才是净增一个 0 分槽位。
        demoted = tally.demote(problem["path"], "%s.value" % problem["path"])
        tally.gap(demoted or problem["path"], problem["type"], SHAPE_HINTS[problem["type"]])
    return {
        "step": step,
        "stepLabel": STEP_LABELS[step],
        "file": instance_path,
        "score": tally.score(),
        "requiredSlots": tally.required,
        "filled": tally.filled,
        "unavailable": tally.unavailable,
        "gapCount": len(tally.gaps),
        "gaps": tally.gaps,
        # 首屏字段只存在于采集文件里；它是独立于分数的硬闸门，见 check_headline。
        "headlineProblems": check_headline(instance) if step == "collection" else [],
        "shapeProblems": shape_problems,
    }


def blocked(result, threshold):
    """是否拒绝放行：分数不足、首屏字段渲染不出来，或存在写法问题。"""
    return (result["score"] < threshold
            or bool(result["headlineProblems"])
            or bool(result["shapeProblems"]))


def print_report(results, threshold):
    print("=" * 60)
    print("数据完整性校验（满分 10 分，阈值 %s 分）" % threshold)
    print("=" * 60)
    for res in results:
        mark = "✅" if not blocked(res, threshold) else "❌"
        print("%s %s  %.1f 分  （槽位 %d：已填 %d / unavailable %d / 缺口 %d）"
              % (mark, res["stepLabel"], res["score"], res["requiredSlots"],
                 res["filled"], res["unavailable"], res["gapCount"]))
        print("   文件：%s" % res["file"])
        for gap in res["gaps"][:10]:
            print("   - [%s] %s" % (gap["type"], gap["path"]))
        if res["gapCount"] > 10:
            print("   ... 其余 %d 条缺口见 --gaps-out / --json" % (res["gapCount"] - 10))
        for problem in res["headlineProblems"]:
            print("   - [首屏渲染不出] %s ← %s：%s"
                  % (problem["label"], problem["path"], problem["found"]))
        for problem in res["shapeProblems"][:10]:
            print("   - [%s] %s ← %s"
                  % (SHAPE_LABELS[problem["type"]], problem["path"], problem["found"]))
        if len(res["shapeProblems"]) > 10:
            print("   ... 其余 %d 处写法问题见 --gaps-out / --json"
                  % (len(res["shapeProblems"]) - 10))
    print("-" * 60)
    failing = [r for r in results if blocked(r, threshold)]
    unrenderable = [r for r in results if r["headlineProblems"]]
    if unrenderable:
        print("❌ 首屏字段渲染不出，页头与首页卡片会是空白。%s" % HEADLINE_HINT)
    for gap_type in ("bare-absent-string", "unabbreviated-number",
                     "unit-overridden-by-currency"):
        hits = sum(len([p for p in r["shapeProblems"] if p["type"] == gap_type])
                   for r in results)
        if hits:
            print("❌ %d 处%s。%s" % (hits, SHAPE_LABELS[gap_type], SHAPE_HINTS[gap_type]))
    if failing:
        print("❌ %d 份文件未放行，进入关键信息补全流程（用 --gaps-out 导出缺口清单）。"
              % len(failing))
    else:
        print("✅ 全部达到阈值且首屏可渲染，可进入下一流程。")


def main():
    parser = argparse.ArgumentParser(description="研究流程第 4 步：数据完整性校验与打分")
    sub = parser.add_subparsers(dest="command")
    check = sub.add_parser("check", help="校验前三步的落盘 JSON 并打分")
    check.add_argument("--collection", help="第 1 步采集文件路径")
    check.add_argument("--analysis", help="第 2 步分析文件路径")
    check.add_argument("--summary", help="第 3 步总结文件路径")
    check.add_argument("--threshold", type=float, default=7.0, help="通过阈值，默认 7 分")
    check.add_argument("--json", action="store_true", help="以 JSON 输出完整结果")
    check.add_argument("--gaps-out", help="把低于阈值文件的缺口清单写到该路径（给补全 Agent）")
    args = parser.parse_args()

    if args.command != "check":
        parser.print_help()
        sys.exit(2)

    targets = [(step, getattr(args, step))
               for step in ("collection", "analysis", "summary")
               if getattr(args, step)]
    if not targets:
        sys.stderr.write("错误：至少提供 --collection / --analysis / --summary 之一。\n")
        sys.exit(2)

    results = [check_file(step, path) for step, path in targets]
    failing = [r for r in results if blocked(r, args.threshold)]

    if args.gaps_out:
        gaps_payload = {
            "purpose": "关键信息补全清单：按 path 定位缺口，expected 为模板对该字段的填写要求。"
                       "补全须遵守对应步骤正文的规范（采集缺口按第 1 步双源规则，"
                       "分析缺口按第 2 步统一信封，总结缺口按第 3 步评分与策略规则）。"
                       "确实取不到的信息写 { \"status\": \"unavailable\", \"reason\": \"缺失原因 + 已查范围\" }，"
                       "算不出来的（分母为负等）写 { \"status\": \"not-applicable\", \"reason\": \"…\" }，不得编造。"
                       "headlineProblems 是首屏字段的形状问题：数据往往已经采到，要改的是写法而不是再去取数。"
                       "shapeProblems 同理是写法问题（裸占位字符串 / 大数字未缩写 / 量级被币种压掉），"
                       "按 shapeHints 改写，不要重新取数。",
            "threshold": args.threshold,
            "headlineHint": HEADLINE_HINT,
            "shapeHints": SHAPE_HINTS,
            "files": [
                {
                    "step": r["step"],
                    "stepLabel": r["stepLabel"],
                    "file": r["file"],
                    "score": r["score"],
                    "gaps": r["gaps"],
                    "headlineProblems": r["headlineProblems"],
                    "shapeProblems": r["shapeProblems"],
                }
                for r in failing
            ],
        }
        with open(args.gaps_out, "w", encoding="utf-8") as fh:
            json.dump(gaps_payload, fh, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps({"threshold": args.threshold,
                          "pass": not failing,
                          "results": results}, ensure_ascii=False, indent=2))
    else:
        print_report(results, args.threshold)
        if args.gaps_out and failing:
            print("缺口清单已写入：%s" % args.gaps_out)

    exit_code = 1 if failing else 0
    # 通过与未过都要记：第 4 步跑了几轮、是不是一次过，靠的正是失败那几行。
    evals_log.log_event(
        "data_validator", "validate",
        company=evals_log.company_from_paths(*[path for _, path in targets]),
        exit_code=exit_code,
        threshold=args.threshold,
        scores={r["step"]: r["score"] for r in results},
        gapCounts={r["step"]: r["gapCount"] for r in results},
        headlineProblems=sum(len(r["headlineProblems"]) for r in results),
        shapeProblems=sum(len(r["shapeProblems"]) for r in results),
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
