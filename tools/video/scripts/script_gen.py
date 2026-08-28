"""financials-summary.json (+ financials-analysis.json) → 分镜解说文案（确定性拼接，不调用 LLM）。

必填输入是符合 `docs/model/financials—summary-template.json` 契约的第 3 步产出；
可选输入 `--analysis` 是第 2 步的 `financials—analysis-template.json` 产出，给了就走
**详解版**：商业模式与护城河从「一句结论」展开成核心段落，目标时长 4-5 分钟。

  {
    "companyId": "...", "companyName": "...",   # 顶层重复一份，tts_batch 的 manifest 只认这里
    "meta":    {companyId, companyName, dataCutoff, source, speechRate, mode, ...},
    "scenes":  [{id, kind, layer, title, narration, estimatedSeconds, data}],
    "totals":  {estimatedSeconds, targetRange, withinTarget, sceneCount},
    "adjustments": [...],   # 为落进时长区间做了哪些裁剪/扩展
    "omissions":   [...]    # 原文缺失(unavailable/__TODO__)或被过滤因而没播的字段
  }

两种模式的差别只在**素材来源与目标区间**，规矩完全一样：

  summary-only  只有总结          目标 120-180s   分镜 kind：opening/dimension/strategy/closing
  detailed      总结 + 维度分析   目标 240-300s   另加 business-model / moat-checklist /
                                                  moat-trend / inquiry 四种深讲分镜

三条硬规矩，和 docs/research/tools/ 下的脚本一致：

1. **不新增判断、不重算数字**。解说词只转述原文：总结侧是 `dimensionSummary[].conclusion`、
   `strategies[].advice/condition/action/signal/observable` 与 `disclaimer`；分析侧是
   `revenueBreakdown` / `stickiness` / `operatingLeverage` / `moat.analysis.types` /
   `trendPast5y` / `trendNext5y` / `inquiry` 的原值。金额与占比一律照抄，不换算量级、
   不重算百分比。模板只提供「第几、维度名、信心度 X 分」这类连接词。
2. **缺失如实说**。`unavailable` / `__TODO__` / 空值一律播「暂无数据」并记进 `omissions`，
   不拿别的字段顶替。
3. **不静默截断**。总时长超出区间时按**分层**阶梯裁剪（快讲层与策略先动，核心层最后动），
   每一步都写进 `adjustments`；阶梯走完仍不达标就带 `withinTarget: false` 输出。

朗读安全：`scoreBasis`、`triggers[].basis`、`evidence[].source` 整块不进解说词；进解说的
正文还要过一道 `strip_speech_noise`——内嵌的 URL 与形如 `a.b.c` 的字段路径引用会被摘掉并
记进 `omissions`。它们是给人核对的引用，念出来是「moat 点 analysis 点 trend Next 5 y」。

逐条点亮：深讲分镜的 `data.beats` 每条带 `sentenceIndex`，指向 `narration` 里念它的那一句。
TTS 的句级边界事件（cues）按同一个下标就能换算出点亮帧号，见 scripts/report_props.mjs。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from functools import lru_cache
from pathlib import Path

from text_normalize import load_lexicon, normalize

TODO_SENTINEL = "__TODO__"

# 中文朗读语速，字/秒（edge-tts zh-CN-XiaoxiaoNeural 默认语速实测区间 4-5）。
# 取 4.25 而不是区间中值：估时算的是解说词，成片还要加每条分镜的句末留白与帧对齐
# （16 条约 3-5 秒）。按 4.5 估，哔哩哔哩这支实测音频 301s、成片 305s，压着 300s 的上限过。
DEFAULT_RATE = 4.25
# 目标区间跟着可用素材走：只有总结时全部念完也就 3 分钟，硬拗 4-5 分钟只能靠注水。
SUMMARY_ONLY_RANGE = (120.0, 180.0)
DETAILED_RANGE = (240.0, 300.0)

# 停顿补偿：句末标点比句读停得久，估时里单独加，不然长句会被系统性低估。
PAUSE_MAJOR = 0.30  # 。！？；
PAUSE_MINOR = 0.15  # ，、：
MAJOR_PUNCT = "。！？；!?;"
MINOR_PUNCT = "，、：,:"

ORDINALS = ["第一", "第二", "第三", "第四", "第五", "第六", "第七", "第八", "第九", "第十"]

CIRCLED = {chr(0x2460 + i): ORDINALS[i] + "，" for i in range(10)}  # ①-⑩

# 策略类别的播报优先级。空仓者/持仓者是面向「听众此刻的处境」的建议，任何听众都落在
# 其中之一，所以默认播这两类；卖出/加仓信号是条件触发的补充，只在需要撑时长时追加。
STRATEGY_ORDER = ["noPosition", "holding", "sellSignals", "addSignals"]
DEFAULT_STRATEGIES = ["noPosition", "holding"]
ADVICE_STRATEGIES = ("noPosition", "holding")  # 这两类读 triggers，另两类读 signals
# 原文 title 缺失时的兜底叫法，正常情况下播的是 strategies.<key>.title 原值
STRATEGY_FALLBACK_TITLE = {
    "noPosition": "空仓者",
    "holding": "持仓者",
    "sellSignals": "卖出信号",
    "addSignals": "加仓信号",
}

# 分镜所属的时长层级。裁剪阶梯按层级推进：core 是这支片子的主线（商业模式与护城河），
# 只在其他层都压不动了才动它；frame 是开场与免责声明，最短且不参与逐级裁剪。
LAYER_CORE = "core"
LAYER_FAST = "fast"
LAYER_STRATEGY = "strategy"
LAYER_FRAME = "frame"

# 深讲分镜取自 analysis 的哪两个维度。键是 analysis.dimensions 下的键，也是 summary
# 侧 `mapsTo: "dimensions.<key>"` 指向的目标——两边对不上时以 mapsTo 为准。
DEEP_BUSINESS_KEY = "businessEssence"
DEEP_MOAT_KEY = "moat"


# ---------------------------------------------------------------- 字段读取


def is_missing(value) -> bool:
    """契约里三种「没有」：unavailable 对象、__TODO__ 占位、空值。"""
    if value is None:
        return True
    if isinstance(value, str):
        stripped = value.strip()
        return not stripped or stripped == TODO_SENTINEL or stripped.startswith(TODO_SENTINEL)
    if isinstance(value, dict):
        return value.get("status") == "unavailable" or not value
    if isinstance(value, list):
        return not value
    return False


def missing_reason(value) -> str:
    if isinstance(value, dict) and value.get("status") == "unavailable":
        return str(value.get("reason") or "原文标注 unavailable")
    if isinstance(value, str) and value.strip().startswith(TODO_SENTINEL):
        return "原文仍是 __TODO__ 占位"
    return "原文缺失或为空"


def text_of(value) -> str:
    return "" if is_missing(value) else str(value).strip()


def format_score(value) -> str | None:
    """信心度原样播报，不做换算；0-10 之外或非数字视为缺失。"""
    if score_defect(value) is not None:
        return None
    score = float(value)
    return str(int(score)) if score.is_integer() else f"{score:g}"


def score_defect(value) -> str | None:
    """None 表示可播报；否则返回不可播报的原因，区分「没填」与「填错」。"""
    if is_missing(value):
        return missing_reason(value)
    try:
        score = float(value)
    except (TypeError, ValueError):
        return f"confidence 值 {value!r} 不是数字，不符合 0-10 契约区间"
    if not 0 <= score <= 10:
        return f"confidence 值 {value!r} 不在 0-10 契约区间"
    return None


# ---------------------------------------------------------------- 文本处理


def normalize_for_speech(text: str) -> str:
    """只做「念得出来」的形态归一：①②③ 换成第一第二第三，压掉换行与多余空白。

    不改词、不删句——原文有多少判断，念出来还是多少。
    """
    for circled, spoken in CIRCLED.items():
        text = text.replace(circled, spoken)
    # 中文之间的空白直接压掉，但 ASCII 词之间要留一个空格，否则
    # 「35.11x TTM PE」会粘成「35.11xTTMPE」，TTS 读不出词界。
    text = re.sub(r"\s+", "\x00", text)
    text = re.sub(r"(?<=[0-9A-Za-z])\x00(?=[0-9A-Za-z])", " ", text)
    text = text.replace("\x00", "")
    # ①在句首换成「第一，」后可能和原有标点撞成「；第一，」以外的重复标点
    text = re.sub(r"[；;]\s*(第[一二三四五六七八九十]，)", r"；\1", text)
    return text.strip()


# 内嵌 URL 与字段路径引用：研究正文里它们是给人核对的锚点，念出来是「moat 点 analysis
# 点 trend Next 5 y」这样的噪音（长江电力的 advice 已经中招）。字段路径要求**至少两个点**，
# 三段以上才算——一个点的形态（`Inc.`、`U.S.`、`20.86`）在财报正文里是正常写法，宁可漏掉
# 一个真路径，也不能把公司名或小数点吃掉。
# 左边界一律用 ASCII 字符类，**不能写 `(?<![\w.])`**：Python3 的 `\w` 默认匹配 Unicode
# 词字符，中文也算，于是「另见下方latestQuarterUpdate」「参考moat.analysis.trendNext5y」
# 这类紧贴在中文后面的引用一个都匹配不上——而这恰恰是研究正文里最常见的写法。
BOUNDARY = r"(?<![A-Za-z0-9_.])"
URL_PATTERN = re.compile(rf"https?://\S+|{BOUNDARY}www\.\S+")
FIELD_PATH_PATTERN = re.compile(rf"{BOUNDARY}[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){{2,}}(?:\[\d+\])*")
# 不带点的字段名交叉引用，如快手 revenueBreakdown.period 里的「另见下方 latestQuarterUpdate」。
# 判据是 lowerCamelCase（小写开头 + 至少一个内部大写）且**长度 ≥ 8**：长度这一条把
# iPhone / iPad / eBay 这类小写开头的商标挡在外面，它们是要正常念出来的专有名词。
FIELD_NAME_PATTERN = re.compile(rf"{BOUNDARY}[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+(?:\[\d+\])*")
FIELD_NAME_MIN_LENGTH = 8
# 公司英文名括注：`哔哩哔哩 (Bilibili Inc.)` 的括号部分对中文听众是冗余的，
# 念出来还会被中文音色逐字母拼读。只在解说词里摘掉，画面上照旧完整显示。
LATIN_PARENTHETICAL = re.compile(r"\s*[（(][\sA-Za-z0-9.,:&'’\-/]*[A-Za-z][\sA-Za-z0-9.,:&'’\-/]*[)）]")


def strip_speech_noise(text: str) -> tuple[str, list[str]]:
    """摘掉正文里内嵌的 URL 与字段路径引用，返回 (清理后的正文, 被摘掉的原串)。

    只做删除，不做替换或改写——留下的每个字仍是原文的字。删除后收拾现场：压掉多出来的
    空白，以及删除留下的连续标点（「详见 X 与 Y 的判断」删空后不该变成「详见 、 的判断」）。
    """
    removed: list[str] = []

    def take(match: re.Match) -> str:
        removed.append(match.group(0))
        return " "

    def take_field_name(match: re.Match) -> str:
        if len(match.group(0)) < FIELD_NAME_MIN_LENGTH:
            return match.group(0)
        return take(match)

    cleaned = URL_PATTERN.sub(take, text)
    cleaned = FIELD_PATH_PATTERN.sub(take, cleaned)
    cleaned = FIELD_NAME_PATTERN.sub(take_field_name, cleaned)
    if not removed:
        return text, []

    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"\s+([，、；：。！？,;:!?）)】」])", r"\1", cleaned)
    cleaned = re.sub(r"([（(【「])\s+", r"\1", cleaned)
    cleaned = re.sub(r"([，、；：,;:])\s*(?=[，、；：。！？,;:!?])", "", cleaned)
    return cleaned.strip(), removed


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?])", text)
    return [part for part in (p.strip() for p in parts) if part]


def split_points(text: str) -> list[str]:
    """把一段正文拆成可以逐条点亮的要点。

    研究正文里的多点论述几乎都写成 `①…；②…；③…`，所以圈号优先；没有圈号才退回句子，
    再没有才按分号切。每条要点都是原文的连续子串（只去掉两端的编号与标点），
    这样「画面上这一条」和「原文那一句」永远能对上。
    """
    stripped = text.strip()
    if not stripped:
        return []
    if any(char in stripped for char in CIRCLED):
        parts = re.split(f"[{''.join(CIRCLED)}]", stripped)
    else:
        sentences = split_sentences(stripped)
        parts = sentences if len(sentences) > 1 else re.split(r"[；;]", stripped)
    points = [part.strip(" 　，、；;。") for part in parts]
    return [point for point in points if point] or [stripped]


class NarrationBuilder:
    """按句累积解说词，并记住每次追加的内容从第几句开始。

    `data.beats[].sentenceIndex` 必须和 `split_sentences(narration)` 的下标严格对齐——
    渲染层就是按这个下标去认 TTS 的句级边界事件的。手工数句子迟早会数错（一段正文自己
    可能就含好几个句号），所以下标一律由这里算出来，不写字面量。
    """

    def __init__(self) -> None:
        self._sentences: list[str] = []

    def say(self, text: str) -> int:
        """追加一段正文，返回它的**第一句**在整条解说词里的下标；空文本返回 -1。"""
        piece = ensure_period(text.strip())
        if not piece:
            return -1
        start = len(self._sentences)
        self._sentences.extend(split_sentences(piece) or [piece])
        return start

    @property
    def text(self) -> str:
        return "".join(self._sentences)


def split_clauses(text: str) -> list[str]:
    """按句读切分。只切 `，；`，不切 `、`——顿号连的是并列成分，切了会把
    「VAS、广告、游戏三条现金流」腰斩成半句。"""
    parts = re.split(r"(?<=[，；;])", text)
    return [part for part in (p.strip() for p in parts) if part]


def first_sentence(text: str) -> str:
    sentences = split_sentences(text)
    return sentences[0] if sentences else text


def take_clauses(text: str, count: int) -> str:
    clauses = split_clauses(text)
    if count >= len(clauses):
        return text
    kept = "".join(clauses[:count]).rstrip("，；;")
    return ensure_period(kept)


def trim_text(text: str, detail: str) -> str:
    """按裁剪级别取正文的前一段：`full` 全文、`first-sentence` 第一句、`clauses:N` 前 N 个句读。

    维度结论与策略建议共用这一套级别，两边的裁剪阶梯才好按同一个口径推进。
    """
    if not text or detail == "full":
        return text
    if detail == "first-sentence":
        return ensure_period(first_sentence(text))
    if detail.startswith("clauses:"):
        return take_clauses(first_sentence(text), int(detail.split(":", 1)[1]))
    return text


def text_levels(text: str, current: str, *, floor: str | None = None) -> list[str]:
    """一段正文**还剩下**的裁剪级别，从当前级别之后接着往下。"""
    ladder = ["full", "first-sentence"]
    ladder += [f"clauses:{k}" for k in range(len(split_clauses(first_sentence(text))) - 1, 0, -1)]
    if floor:
        ladder.append(floor)
    return ladder[_ladder_position(ladder, current) :]


def ensure_period(text: str) -> str:
    if not text:
        return text
    return text if text[-1] in "。！？!?" else text + "。"


@lru_cache(maxsize=4096)
def _spoken_text(text: str) -> str:
    """解说词经朗读改写后**真正被念出来的**那串字。

    估时必须按它算，不能按原文算：`11928.29百万元CNY` 原文 17 个字符，念出来是
    「一万一千九百二十八点二九百万元人民币」二十来个音节。按原文估，含大量金额与
    百分比的深讲分镜会被系统性低估——实测整片会短估约 9%，5 分钟的目标做出 5 分 23 秒的片子。

    改写规则与 stage 2 的 tts_batch.py 用的是同一份词表，词表一改，估时跟着一起变。
    """
    return normalize(text, _lexicon())[0]


@lru_cache(maxsize=1)
def _lexicon() -> dict:
    return load_lexicon()


def estimate_seconds(text: str, rate: float) -> float:
    """按字数/语速估时，中文 1 字 1 拍、数字逐位读、拉丁字母半拍，再加标点停顿。

    只是估算：真实时长以 stage 2 的 TTS 产出（`tts.py` 的 duration_seconds）为准，
    这里的作用是在合成之前就能判断要不要裁剪。
    """
    text = _spoken_text(text)
    units = 0.0
    pauses = 0.0
    for char in text:
        if char in MAJOR_PUNCT:
            pauses += PAUSE_MAJOR
        elif char in MINOR_PUNCT:
            pauses += PAUSE_MINOR
        elif char.isspace():
            continue
        elif "一" <= char <= "鿿":
            units += 1.0
        elif char.isdigit() or char in ".%":
            units += 1.0  # 「35.11」读作三十五点一一，逐位近似
        elif char.isascii() and char.isalpha():
            units += 0.5
        else:
            units += 0.5
    return round(units / rate + pauses, 2)


# ---------------------------------------------------------------- 分镜构造


class ScriptBuilder:
    def __init__(self, summary: dict, rate: float, analysis: dict | None = None):
        self.summary = summary
        self.rate = rate
        self.analysis = analysis if isinstance(analysis, dict) else None
        self.omissions: list[dict] = []
        self.adjustments: list[dict] = []
        # 深讲分镜裁剪时要从原始素材重建，素材本身不进产出 JSON（那是给渲染层看的画面数据，
        # 不是生成器的中间态）；所以留在 builder 里，按分镜 id 索引。
        self.deep_sources: dict[str, dict] = {}

    def note_omission(self, path: str, value, note: str, reason: str | None = None) -> None:
        if any(item["path"] == path for item in self.omissions):
            return  # 同一字段可能被开场与维度分镜各碰一次，只记一条
        self.omissions.append({"path": path, "reason": reason or missing_reason(value), "handling": note})

    # -- 取词：所有进解说词的正文都从这里过 -------------------------------

    def spoken(self, value, path: str) -> str:
        """把一个原文字段变成可朗读的正文：缺失返回空串，内嵌 URL/字段路径的摘掉并记账。

        进解说词的每一段正文都必须走这里，包括 summary 侧的结论与建议——长江电力的
        `advice` 里内嵌 `moat.analysis.trendNext5y` 就是从那条路进来的。
        """
        raw = text_of(value)
        if not raw:
            return ""
        cleaned, removed = strip_speech_noise(raw)
        if removed:
            self.note_omission(
                path,
                value,
                "已从解说词与画面正文中移除，其余原文照播",
                f"正文内嵌 {'、'.join(removed)}，属给人核对的 URL/字段路径引用，朗读为噪音",
            )
        return normalize_for_speech(cleaned)

    def analysis_dimension(self, key: str) -> dict | None:
        """按 analysis.dimensions.<key> 取维度块；不存在或形状不对都返回 None。"""
        dimensions = (self.analysis or {}).get("dimensions")
        block = dimensions.get(key) if isinstance(dimensions, dict) else None
        return block if isinstance(block, dict) else None

    # -- 开场 ---------------------------------------------------------

    def build_opening(self) -> dict:
        meta = self.summary.get("meta") or {}
        name = text_of(meta.get("companyName")) or text_of(meta.get("companyId")) or "本期公司"
        cutoff_raw = text_of(meta.get("dataCutoff")) or text_of(meta.get("summarizedAt"))
        # 契约里 dataCutoff 常带「（Asia/Shanghai）」时区后缀，念出来是噪音，只播日期。
        cutoff = re.sub(r"[（(].*?[）)]", "", cutoff_raw).strip()

        # 「一句话定位」直接取生意质量结论的第一句，不另行概括。
        positioning = ""
        quality = self._dimension("businessQuality")
        if quality is not None and not is_missing(quality.get("conclusion")):
            positioning = first_sentence(
                self.spoken(quality["conclusion"], "dimensionSummary[businessQuality].conclusion")
            )
        else:
            self.note_omission(
                "dimensionSummary[businessQuality].conclusion",
                (quality or {}).get("conclusion"),
                "开场省略一句话定位，只报公司名",
            )

        return {
            "id": "opening",
            "kind": "opening",
            "layer": LAYER_FRAME,
            "title": name,
            "narration": self._opening_narration(name, positioning, cutoff),
            "data": {
                "companyName": name,
                "dataCutoff": cutoff_raw,
                "spokenCutoff": cutoff,
                "positioning": positioning,
                "detail": "full",
            },
        }

    @staticmethod
    def _opening_narration(name: str, positioning: str, cutoff: str) -> str:
        # 画面上的标题保留 `哔哩哔哩 (Bilibili Inc.)` 全称，念的时候只念中文名：
        # 括注里的英文对中文听众是冗余的，中文音色还会把它逐字母拼出来。
        spoken_name = LATIN_PARENTHETICAL.sub("", name).strip() or name
        parts = [f"本期看的公司是{spoken_name}。"]
        if positioning:
            parts.append(ensure_period(positioning))
        if cutoff:
            parts.append(f"以下内容基于截至{cutoff}的公开信息。")
        return "".join(parts)

    def rewrite_opening(self, scene: dict, detail: str) -> None:
        data = scene["data"]
        positioning = data["positioning"]
        if detail.startswith("clauses:"):
            positioning = take_clauses(positioning, int(detail.split(":", 1)[1]))
        data["detail"] = detail
        scene["narration"] = self._opening_narration(data["companyName"], positioning, data["spokenCutoff"])

    def _dimension(self, dimension_id: str) -> dict | None:
        for item in self.summary.get("dimensionSummary") or []:
            if item.get("dimensionId") == dimension_id:
                return item
        return None

    def dimension_id_for(self, analysis_key: str) -> str | None:
        """analysis 的维度键 → 总结里对应的 dimensionId，按契约的 `mapsTo` 认。

        用 mapsTo 而不是猜 dimensionId：总结侧叫「生意质量 businessQuality」，分析侧叫
        「生意本质 businessEssence」，两边本就不同名，而 `mapsTo: "dimensions.<key>"`
        是契约里明写的那条线。注意要精确匹配——企业文化的 mapsTo 是
        `dimensions.management.analysis.culture`，前缀匹配会把它误认成管理层。
        """
        target = f"dimensions.{analysis_key}"
        for item in self.summary.get("dimensionSummary") or []:
            if text_of(item.get("mapsTo")) == target:
                return text_of(item.get("dimensionId")) or None
        return None

    # -- 七维度 -------------------------------------------------------

    def build_dimensions(self, core_ids: set[str] | None = None) -> list[dict]:
        """七维度分镜。`core_ids` 里的维度归核心层（详解版下它们后面跟着深讲分镜），
        其余归快讲层，控时阶梯先动快讲层。"""
        core_ids = core_ids or set()
        scenes = []
        items = self.summary.get("dimensionSummary") or []
        for index, item in enumerate(items):
            dimension_id = text_of(item.get("dimensionId")) or f"dimension{index + 1}"
            title = text_of(item.get("title")) or dimension_id
            ordinal = ORDINALS[index] if index < len(ORDINALS) else f"第{index + 1}"
            score = format_score(item.get("confidence"))
            if score is None:
                self.note_omission(
                    f"dimensionSummary[{dimension_id}].confidence",
                    item.get("confidence"),
                    "该维度播报为「暂无评分」",
                    score_defect(item.get("confidence")),
                )

            conclusion = ""
            if is_missing(item.get("conclusion")):
                self.note_omission(
                    f"dimensionSummary[{dimension_id}].conclusion",
                    item.get("conclusion"),
                    "该维度播报为「暂无数据」",
                )
            else:
                conclusion = ensure_period(
                    self.spoken(item["conclusion"], f"dimensionSummary[{dimension_id}].conclusion")
                )

            scenes.append(
                {
                    "id": f"dimension-{dimension_id}",
                    "kind": "dimension",
                    "layer": LAYER_CORE if dimension_id in core_ids else LAYER_FAST,
                    "title": title,
                    "narration": self._dimension_narration(ordinal, title, score, conclusion, "full"),
                    "data": {
                        "dimensionId": dimension_id,
                        "ordinal": index + 1,
                        "score": None if score is None else float(score),
                        "scoreLabel": f"{score} 分" if score else "暂无评分",
                        "conclusion": conclusion,
                        "detail": "full",
                    },
                }
            )
        if not scenes:
            self.note_omission("dimensionSummary", self.summary.get("dimensionSummary"), "跳过全部维度分镜")
        return scenes

    @staticmethod
    def _dimension_narration(ordinal: str, title: str, score: str | None, conclusion: str, detail: str) -> str:
        head = f"{ordinal}，{title}，" + (f"信心度{score}分。" if score else "暂无评分。")
        if not conclusion:
            return head + "暂无数据。"
        if detail == "score-only":
            return head
        if detail == "first-sentence":
            return head + ensure_period(first_sentence(conclusion))
        if detail.startswith("clauses:"):
            return head + take_clauses(first_sentence(conclusion), int(detail.split(":", 1)[1]))
        return head + conclusion

    def rewrite_dimension(self, scene: dict, detail: str) -> None:
        data = scene["data"]
        ordinal = ORDINALS[data["ordinal"] - 1] if data["ordinal"] <= len(ORDINALS) else f"第{data['ordinal']}"
        score = None if data["score"] is None else format_score(data["score"])
        data["detail"] = detail
        scene["narration"] = self._dimension_narration(ordinal, scene["title"], score, data["conclusion"], detail)

    # -- 策略 ---------------------------------------------------------

    def eligible_strategies(self) -> list[str]:
        strategies = self.summary.get("strategies") or {}
        eligible = []
        for key in STRATEGY_ORDER:
            block = strategies.get(key)
            if not isinstance(block, dict):
                continue
            if self._strategy_items(key, block) or not is_missing(block.get("advice")):
                eligible.append(key)
        return eligible

    @staticmethod
    def _strategy_items(key: str, block: dict) -> list[dict]:
        raw = block.get("triggers") if key in ADVICE_STRATEGIES else block.get("signals")
        return [item for item in (raw or []) if isinstance(item, dict)]

    def build_strategy(
        self,
        key: str,
        item_limit: int,
        *,
        note_missing: bool = True,
        allow_empty: bool = False,
        advice_detail: str = "full",
    ) -> dict | None:
        """note_missing=False 关掉记账（重建/试探，缺失早已记过）；
        allow_empty=True 允许返回空正文分镜，只有「已在分镜里、仅重新裁剪」才该开。"""
        block = (self.summary.get("strategies") or {}).get(key)
        if not isinstance(block, dict):
            if note_missing:
                self.note_omission(f"strategies.{key}", block, "该类策略未播报")
            return None

        title = text_of(block.get("title")) or STRATEGY_FALLBACK_TITLE.get(key, key)
        advice = "" if is_missing(block.get("advice")) else self.spoken(block["advice"], f"strategies.{key}.advice.text")
        items = self._strategy_items(key, block)

        spoken_items = []
        for index, item in enumerate(items[:item_limit]):
            base = f"strategies.{key}.{'triggers' if key in ADVICE_STRATEGIES else 'signals'}[{index}]"
            if key in ADVICE_STRATEGIES:
                condition = self.spoken(item.get("condition"), f"{base}.condition")
                action = self.spoken(item.get("action"), f"{base}.action")
            else:
                condition = self.spoken(item.get("observable"), f"{base}.observable")
                action = self.spoken(item.get("signal"), f"{base}.signal")
            if not condition and not action:
                continue
            spoken_items.append({"condition": condition, "action": action})

        if not advice and not spoken_items and not allow_empty:
            # 正文与触发条件都没得播：这是真的没内容，只记「已跳过」一条，不再记 advice。
            if note_missing:
                reason = None
                if not is_missing(block):
                    reason = missing_reason(block.get("advice"))
                self.note_omission(f"strategies.{key}", block, "该类策略无可播报内容，已跳过", reason)
            return None

        if not advice and note_missing:
            # 正文缺失但触发条件还能播：分镜保留，缺失照样如实记一条。
            self.note_omission(
                f"strategies.{key}.advice",
                block.get("advice"),
                "该类策略播报为「暂无建议正文」，只播触发条件",
            )

        return {
            "id": f"strategy-{key}",
            "kind": "strategy",
            "layer": LAYER_STRATEGY,
            "title": title,
            # 画面给建议正文全文，解说按 advice_detail 只念前几句——和维度分镜同一个口径：
            # data.conclusion 是全文、narration 是裁过的。屏幕不花时间，耳朵才花。
            "narration": self._strategy_narration(key, title, trim_text(advice, advice_detail), spoken_items),
            "data": {
                "strategyId": key,
                "advice": advice,
                "detail": advice_detail,
                "items": spoken_items,
                "itemsAvailable": len(items),
            },
        }

    @staticmethod
    def _strategy_narration(key: str, title: str, advice: str, items: list[dict]) -> str:
        lead = f"接下来是给{title}的建议。" if key in ADVICE_STRATEGIES else f"接下来是{title}。"
        parts = [lead]
        if advice:
            parts.append(ensure_period(advice))
        else:
            parts.append("暂无建议正文。")
        for item in items:
            condition = item["condition"]
            action = item["action"]
            if condition and action:
                parts.append(f"触发条件：{condition}，{ensure_period(action)}")
            else:
                parts.append(ensure_period(f"触发条件：{condition or action}"))
        return "".join(parts)

    def reconcile_strategy_omissions(self, scenes: list[dict]) -> None:
        """advice 缺失的记账写于构造时；裁剪阶梯可能事后把触发条件也拿掉，handling 要跟上产出。"""
        narrated = {
            s["data"]["strategyId"]: s for s in scenes if s["kind"] == "strategy"
        }
        for item in self.omissions:
            key = item["path"].removesuffix(".advice")
            if key == item["path"] or not key.startswith("strategies."):
                continue
            scene = narrated.get(key.removeprefix("strategies."))
            if scene is not None and not scene["data"]["items"]:
                item["handling"] = "该类策略播报为「暂无建议正文」，触发条件因控时未播报"

    def rewrite_strategy(self, scene: dict, item_limit: int, advice_detail: str | None = None) -> None:
        rebuilt = self.build_strategy(
            scene["data"]["strategyId"],
            item_limit,
            note_missing=False,
            allow_empty=True,
            # 不传就沿用当前的正文裁剪级别：改触发条件数量不该顺手把正文恢复成全文
            advice_detail=advice_detail if advice_detail is not None else scene["data"].get("detail", "full"),
        )
        if rebuilt is None:
            return
        scene["narration"] = rebuilt["narration"]
        scene["data"] = rebuilt["data"]

    def rewrite_strategy_advice(self, scene: dict, advice_detail: str) -> None:
        self.rewrite_strategy(scene, len(scene["data"]["items"]), advice_detail)

    # -- 结尾 ---------------------------------------------------------

    def build_closing(self) -> dict:
        disclaimer = self.spoken(self.summary.get("disclaimer"), "disclaimer.text")
        if not disclaimer:
            self.note_omission("disclaimer", self.summary.get("disclaimer"), "使用契约默认免责声明")
            disclaimer = "本内容仅供研究参考，不构成个性化投资建议。"
        return {
            "id": "closing",
            "kind": "closing",
            "layer": LAYER_FRAME,
            "title": "免责声明",
            "narration": ensure_period(disclaimer),
            "data": {"disclaimer": disclaimer},
        }


    # -- 深讲分镜（详解版） ---------------------------------------------

    def field(self, value, path: str, note: str) -> str:
        """取一个要进解说词的原文字段：缺失如实记账并返回空串，其余交给 `spoken` 过滤。"""
        if is_missing(value):
            self.note_omission(path, value, note)
            return ""
        return self.spoken(value, path)

    def points_of(self, value, path: str, note: str) -> list[str]:
        """取一段多点论述，按 ①②③ 拆成要点；缺失记账并返回空列表。"""
        text = self.field(value, path, note)
        return split_points(text) if text else []

    def _register_deep(self, scene_id: str, kind: str, title: str, payload: dict) -> dict:
        """素材抽取只做一次（omissions 也只记一次），此后裁剪都从这份 payload 重渲染。"""
        self.deep_sources[scene_id] = {
            "kind": kind,
            "title": title,
            "payload": payload,
            "budgetMax": self._budget_max(kind, payload),
        }
        narration, data = self._render_deep(scene_id, "full")
        return {"id": scene_id, "kind": kind, "layer": LAYER_CORE, "title": title, "narration": narration, "data": data}

    @staticmethod
    def _budget_max(kind: str, payload: dict) -> int:
        """这一屏的要点预算最多能取到几——按**单组**的条数算，不是所有组加起来。

        趋势屏的预算是分别作用在过去/未来两组上的，拿两组之和当上限会先空转好几级
        （`beats:6` 对每组各 3 条的素材毫无作用），把裁剪机会浪费在原地踏步上。
        """
        if kind == "moat-checklist":
            return 2  # 清单只有「带检验问题」与「只报判定」两档，条目数不裁
        if kind == "moat-trend":
            return max((len(side["points"]) for side in payload.values() if isinstance(side, dict)), default=1)
        if kind == "inquiry":
            return len(payload["points"])
        if payload.get("focus") == "revenue":
            return len(payload["items"])
        return max(len(payload["mechanism"]), len(payload["leverage"]), 1)

    def deep_ladder(self, scene: dict) -> list[str]:
        """一屏深讲从最全到最简的完整级别序列。"""
        budget_max = self.deep_sources[scene["id"]]["budgetMax"]
        return ["full"] + [f"beats:{k}" for k in range(budget_max - 1, 0, -1)] + ["minimal"]

    def deep_levels(self, scene: dict) -> list[str]:
        """一屏深讲**还剩下**的裁剪级别：先逐条收紧要点，实在不行才只播判定与方向。

        从当前 detail 之后接着往下，不从头来过——重头开始会把已经裁过的一屏重新渲染成
        更长的级别，等于把裁剪撤销掉。
        """
        ladder = self.deep_ladder(scene)
        return ladder[_ladder_position(ladder, scene["data"]["detail"]) :]

    def restore_deep_one_level(self, scene: dict) -> str | None:
        """把一屏深讲往回升一级（更全），返回升到的级别；已经是最全则返回 None。"""
        ladder = self.deep_ladder(scene)
        detail = scene["data"]["detail"]
        position = ladder.index(detail) if detail in ladder else 0
        if position == 0:
            return None
        self.rewrite_deep(scene, ladder[position - 1])
        return ladder[position - 1]

    def rewrite_deep(self, scene: dict, detail: str) -> None:
        narration, data = self._render_deep(scene["id"], detail)
        scene["narration"] = narration
        scene["data"] = data

    def build_business_model_scenes(self) -> list[dict]:
        """商业模式深讲：收入结构一屏，粘性与经营杠杆一屏。

        拆成两条而不是一屏讲完，是因为一屏得停 90 秒——MVP 评估里 37 秒的策略卡已经是
        全片最难熬的段落，再翻一倍就不用看了。
        """
        base = f"dimensions.{DEEP_BUSINESS_KEY}"
        block = self.analysis_dimension(DEEP_BUSINESS_KEY)
        if block is None:
            self.note_omission(base, block, "跳过商业模式深讲分镜", "维度分析里没有这一块")
            return []
        analysis = block.get("analysis") if isinstance(block.get("analysis"), dict) else {}

        scenes = []
        revenue = self._build_revenue_payload(analysis, base)
        if revenue is not None:
            scenes.append(self._register_deep("business-model-revenue", "business-model", "收入结构", revenue))

        economics = self._build_economics_payload(analysis, base)
        if economics is not None:
            scenes.append(self._register_deep("business-model-economics", "business-model", "生意的经济特征", economics))
        return scenes

    def _build_revenue_payload(self, analysis: dict, base: str) -> dict | None:
        breakdown = analysis.get("revenueBreakdown")
        path = f"{base}.analysis.revenueBreakdown"
        if not isinstance(breakdown, dict):
            self.note_omission(path, breakdown, "跳过收入结构分镜", "原文没有收入结构块")
            return None

        items = []
        for index, item in enumerate(breakdown.get("items") or []):
            if not isinstance(item, dict):
                continue
            item_path = f"{path}.items[{index}]"
            segment = self.field(item.get("segment"), f"{item_path}.segment", "该条业务线未播报")
            if not segment:
                continue  # 连业务线名字都没有，这一条没什么可播的
            items.append(
                {
                    "segment": segment,
                    # 金额与占比一律照抄原文，不换算量级、不重算百分比
                    "revenue": self.field(item.get("revenue"), f"{item_path}.revenue", "该条只播业务线与占比"),
                    "sharePct": self.field(item.get("sharePct"), f"{item_path}.sharePct", "该条只播业务线与金额"),
                }
            )
        if not items:
            self.note_omission(f"{path}.items", breakdown.get("items"), "跳过收入结构分镜", "原文没有可播的业务线")
            return None

        canvas = analysis.get("businessModelCanvas") if isinstance(analysis.get("businessModelCanvas"), dict) else {}
        return {
            "focus": "revenue",
            "period": self.field(breakdown.get("period"), f"{path}.period", "收入结构不播报告期"),
            "items": items,
            "salesModel": text_of(canvas.get("salesModel")),
            "productForm": text_of(canvas.get("productForm")),
        }

    def _build_economics_payload(self, analysis: dict, base: str) -> dict | None:
        stickiness = analysis.get("stickiness") if isinstance(analysis.get("stickiness"), dict) else {}
        leverage = analysis.get("operatingLeverage") if isinstance(analysis.get("operatingLeverage"), dict) else {}
        level = text_of(stickiness.get("level"))
        mechanism = self.points_of(
            stickiness.get("mechanism"), f"{base}.analysis.stickiness.mechanism", "不播粘性机制"
        )
        observation = self.points_of(
            leverage.get("observation"), f"{base}.analysis.operatingLeverage.observation", "不播经营杠杆观察"
        )
        if not level and not mechanism and not observation:
            self.note_omission(
                f"{base}.analysis.stickiness", stickiness, "跳过经济特征分镜", "粘性与经营杠杆都没有可播内容"
            )
            return None
        return {"focus": "economics", "level": level, "mechanism": mechanism, "leverage": observation}

    def build_moat_scenes(self) -> list[dict]:
        """护城河深讲：五类壁垒逐条检验、过去与未来五年的方向、十年之问。"""
        base = f"dimensions.{DEEP_MOAT_KEY}"
        block = self.analysis_dimension(DEEP_MOAT_KEY)
        if block is None:
            self.note_omission(base, block, "跳过护城河深讲分镜", "维度分析里没有这一块")
            return []
        analysis = block.get("analysis") if isinstance(block.get("analysis"), dict) else {}

        scenes = []
        checklist = self._build_checklist_payload(analysis, base)
        if checklist is not None:
            scenes.append(self._register_deep("moat-checklist", "moat-checklist", "护城河逐条检验", checklist))

        trend = self._build_trend_payload(analysis, base)
        if trend is not None:
            scenes.append(self._register_deep("moat-trend", "moat-trend", "护城河的过去与未来", trend))

        inquiry = self._build_inquiry_payload(block, base)
        if inquiry is not None:
            scenes.append(self._register_deep("moat-inquiry", "inquiry", "十年之问", inquiry))
        return scenes

    def _build_checklist_payload(self, analysis: dict, base: str) -> dict | None:
        path = f"{base}.analysis.types"
        items = []
        for index, item in enumerate(analysis.get("types") or []):
            if not isinstance(item, dict):
                continue
            item_path = f"{path}[{index}]"
            kind = self.field(item.get("type"), f"{item_path}.type", "该条壁垒未播报")
            if not kind:
                continue
            items.append(
                {
                    "type": kind,
                    "test": self.field(item.get("test"), f"{item_path}.test", "该条只播判定，不播检验问题"),
                    # 判定原样转述：「待验证」不是「不存在」，改写一个字就是替研究者下结论
                    "verdict": self.field(item.get("verdict"), f"{item_path}.verdict", "该条判定暂无"),
                }
            )
        if not items:
            self.note_omission(path, analysis.get("types"), "跳过护城河清单分镜", "原文没有可播的壁垒条目")
            return None
        return {"items": items}

    def _build_trend_payload(self, analysis: dict, base: str) -> dict | None:
        sides = {}
        for side, key, label in (("past", "trendPast5y", "过去五年"), ("next", "trendNext5y", "未来五年")):
            raw = analysis.get(key) if isinstance(analysis.get(key), dict) else {}
            path = f"{base}.analysis.{key}"
            direction = self.field(raw.get("direction"), f"{path}.direction", f"{label}不播方向")
            points = self.points_of(raw.get("basis"), f"{path}.basis", f"{label}不播判断依据")
            if direction or points:
                sides[side] = {"label": label, "direction": direction, "points": points}
        if not sides:
            self.note_omission(f"{base}.analysis.trendPast5y", None, "跳过护城河趋势分镜", "过去与未来五年都没有可播内容")
            return None
        return sides

    def _build_inquiry_payload(self, block: dict, base: str) -> dict | None:
        raw = block.get("inquiry") if isinstance(block.get("inquiry"), dict) else {}
        path = f"{base}.inquiry"
        question = self.field(raw.get("question"), f"{path}.question", "十年之问不播问题原文")
        points = self.points_of(raw.get("answer"), f"{path}.answer", "十年之问不播回答")
        if not points:
            self.note_omission(path, raw, "跳过十年之问分镜", "原文没有可播的回答")
            return None
        return {"question": question, "points": points}

    # -- 深讲分镜的渲染与裁剪 -------------------------------------------

    def _render_deep(self, scene_id: str, detail: str) -> tuple[str, dict]:
        source = self.deep_sources[scene_id]
        payload, kind = source["payload"], source["kind"]
        if kind == "business-model":
            if payload["focus"] == "revenue":
                return self._render_revenue(payload, detail)
            return self._render_economics(payload, detail)
        if kind == "moat-checklist":
            return self._render_checklist(payload, detail)
        if kind == "moat-trend":
            return self._render_trend(payload, detail)
        return self._render_inquiry(payload, detail)

    @staticmethod
    def _budget(detail: str, available: int, minimal: int) -> int:
        """detail → 这一屏最多播几条。`full` 全播，`beats:N` 封顶 N，`minimal` 只留最少的几条。"""
        if detail == "minimal":
            return min(minimal, available)
        if detail.startswith("beats:"):
            return max(0, min(int(detail.split(":", 1)[1]), available))
        return available

    def _render_revenue(self, payload: dict, detail: str) -> tuple[str, dict]:
        available = len(payload["items"])
        budget = max(1, self._budget(detail, available, minimal=1))  # 收入结构至少念一条，全砍等于这屏没解说

        speech = NarrationBuilder()
        speech.say("先看这门生意的收入结构")
        if payload["period"]:
            speech.say(f"报告期{payload['period']}")
        beats = []
        for item in payload["items"][:budget]:
            parts = [item["segment"]]
            if item["revenue"]:
                parts.append(item["revenue"])
            if item["sharePct"]:
                parts.append(f"占{item['sharePct']}")
            line = "，".join(parts)
            beats.append({"group": "revenue", "text": line, "sentenceIndex": speech.say(line)})
        return speech.text, {
            "focus": "revenue",
            "period": payload["period"],
            # 画面给全部业务线，解说按控时只念前 spokenCount 条——被裁的是**时间**，不是内容，
            # 而屏幕不花时间。没念到的那几条在画面上压暗显示，不参与逐条点亮。
            "items": payload["items"],
            "itemsAvailable": available,
            "spokenCount": len(beats),
            "salesModel": payload["salesModel"],
            "productForm": payload["productForm"],
            "beats": beats,
            "detail": detail,
        }

    def _render_economics(self, payload: dict, detail: str) -> tuple[str, dict]:
        mechanism = payload["mechanism"][: self._budget(detail, len(payload["mechanism"]), minimal=1)]
        leverage = payload["leverage"][: self._budget(detail, len(payload["leverage"]), minimal=0)]

        speech = NarrationBuilder()
        speech.say("再看这门生意的经济特征")
        if payload["level"]:
            speech.say(f"用户粘性判定为{payload['level']}")
        beats = []
        if mechanism:
            speech.say("粘性靠什么")
            for point in mechanism:
                beats.append({"group": "mechanism", "text": point, "sentenceIndex": speech.say(point)})
        if leverage:
            speech.say("再看经营杠杆")
            for point in leverage:
                beats.append({"group": "leverage", "text": point, "sentenceIndex": speech.say(point)})
        return speech.text, {
            "focus": "economics",
            "level": payload["level"],
            # 同收入结构：画面给全部要点，beats 只覆盖念到的那几条
            "mechanism": payload["mechanism"],
            "leverage": payload["leverage"],
            "beats": beats,
            "beatsAvailable": len(payload["mechanism"]) + len(payload["leverage"]),
            "detail": detail,
        }

    def _render_checklist(self, payload: dict, detail: str) -> tuple[str, dict]:
        # 清单的条目数不裁——五类壁垒少一条就是另一张图；压时长只压检验问题那半句。
        terse = detail == "minimal" or detail.startswith("beats:")
        speech = NarrationBuilder()
        speech.say("护城河逐条检验")
        beats = []
        for item in payload["items"]:
            verdict = item["verdict"] or "暂无判定"
            line = f"{item['type']}，判定为{verdict}" if terse or not item["test"] else f"{item['type']}：{item['test']}判定为{verdict}"
            beats.append({"group": "type", "text": line, "sentenceIndex": speech.say(line)})
        return speech.text, {
            "items": payload["items"],
            "beats": beats,
            "spokenTest": not terse,
            "detail": detail,
        }

    def _render_trend(self, payload: dict, detail: str) -> tuple[str, dict]:
        speech = NarrationBuilder()
        speech.say("这条护城河这五年怎么走，未来五年又会怎么走")
        beats = []
        sides = {}
        for side in ("past", "next"):
            block = payload.get(side)
            if block is None:
                continue
            direction = block["direction"] or "暂无判断"
            speech.say(f"{block['label']}，方向是{direction}")
            points = block["points"][: self._budget(detail, len(block["points"]), minimal=0)]
            for point in points:
                beats.append({"group": side, "text": point, "sentenceIndex": speech.say(point)})
            sides[side] = {
                "label": block["label"],
                "direction": block["direction"],
                # 画面给全部判断依据：裁到 minimal 时若连画面也一起空掉，这一屏就只剩
                # 两个「变宽」孤零零挂十几秒，是全片最空的一屏。
                "points": block["points"],
                "spokenCount": len(points),
                "pointsAvailable": len(block["points"]),
            }
        return speech.text, {**sides, "beats": beats, "detail": detail}

    def _render_inquiry(self, payload: dict, detail: str) -> tuple[str, dict]:
        points = payload["points"][: max(1, self._budget(detail, len(payload["points"]), minimal=1))]
        speech = NarrationBuilder()
        speech.say("最后一个问题")
        if payload["question"]:
            speech.say(payload["question"])
        beats = [{"group": "answer", "text": point, "sentenceIndex": speech.say(point)} for point in points]
        return speech.text, {
            "question": payload["question"],
            "points": payload["points"],  # 画面给全部回答要点，解说按控时只念前几条
            "spokenCount": len(beats),
            "beats": beats,
            "beatsAvailable": len(payload["points"]),
            "detail": detail,
        }


# ---------------------------------------------------------------- 时长调节


def measure(scenes: list[dict], rate: float) -> float:
    total = 0.0
    for scene in scenes:
        scene["estimatedSeconds"] = estimate_seconds(scene["narration"], rate)
        total += scene["estimatedSeconds"]
    return round(total, 2)


# 各层在「开场收尾之外的时长」里占的份额。核心层拿最大的一份，这是这支片子的主线；
# 详解版 5 分钟片上大致是核心 170s / 快讲 58s / 策略 47s，和 issue #31 写的预算一致。
LAYER_WEIGHTS = {LAYER_CORE: 0.66, LAYER_FAST: 0.19, LAYER_STRATEGY: 0.15}

# 每条分镜在成片里比解说词多出来的时长：render.mjs 的默认句末留白 0.2s + 帧向上取整。
# 与 scripts/render.mjs 的 scenePadSeconds 默认值绑定，那边改了这里要跟着改。
RENDER_PAD_PER_SCENE = 0.25


def _ladder_position(ladder: list[str], detail: str) -> int:
    """当前 detail 在裁剪阶梯上的下一级下标；认不出的 detail 从第二级（第一次裁剪）接着走。"""
    return ladder.index(detail) + 1 if detail in ladder else 1


def dimension_levels(scene: dict) -> list[str]:
    """一条维度分镜**还剩下**的裁剪级别：整段 → 第一句 → 逐级收句读 → 只报分数。"""
    return text_levels(scene["data"]["conclusion"], scene["data"]["detail"], floor="score-only")


def strategy_levels(scene: dict) -> list[str]:
    """一条策略分镜**还剩下**的建议正文裁剪级别。

    没有「只报标题」这一级：一条只报「接下来是给持仓者的建议」却不说建议内容的分镜，
    存在的意义为零，不如让这一层略微超预算。
    """
    return text_levels(scene["data"]["advice"], scene["data"].get("detail", "full"))


def layer_seconds(scenes: list[dict], layer: str) -> float:
    return round(sum(scene["estimatedSeconds"] for scene in scenes if scene.get("layer") == layer), 2)


def layer_budgets(scenes: list[dict], max_seconds: float) -> dict[str, float]:
    """按层分配时长上限。

    开场与免责声明据实占用（它们本来就短，按份额分反而会把免责声明裁没），剩下的按权重
    分给**在场的**层——纯总结模式下没有核心层，它那份自然由快讲与策略按比例分掉。
    某一层用不满自己的预算时，余额让给核心层：主线可以更长，但不能因为别的层短而被迫更短。
    """
    rest = max(0.0, max_seconds - layer_seconds(scenes, LAYER_FRAME))
    present = {layer: weight for layer, weight in LAYER_WEIGHTS.items() if any(s.get("layer") == layer for s in scenes)}
    if not present:
        return {}
    weight_sum = sum(present.values())
    budgets = {layer: rest * weight / weight_sum for layer, weight in present.items()}
    if LAYER_CORE in budgets:
        surplus = sum(max(0.0, budgets[l] - layer_seconds(scenes, l)) for l in budgets if l != LAYER_CORE)
        budgets[LAYER_CORE] += surplus
    return budgets


def fit_duration(
    builder: ScriptBuilder,
    scenes: list[dict],
    min_seconds: float,
    max_seconds: float,
) -> tuple[list[dict], float]:
    """把总时长压/拉进 [min, max]，每一步都记账。

    裁剪阶梯**按层级推进，核心层最后动**：商业模式与护城河是这支片子的主线，先被裁的
    永远是快讲层（其余五维的理由长度）与策略的触发条件。顺序固定，同一份输入永远得到
    同一份产出。纯总结模式下没有核心层，core-* 各级自然空转，阶梯退化成原来的样子。

    扩展阶梯只加内容、不回滚已裁的部分，且每一步都要复核「补完不会重新超上限」，
    否则裁了又加会在区间边界上来回抖。
    """
    rate = builder.rate
    total = measure(scenes, rate)

    # 估时算的是解说词，成片还要长一点：render.mjs 给每条分镜的句末补 0.2s 留白，再按帧
    # 向上取整。16 条分镜就是 3.5 秒左右——刚好够把一支「预估 299.7s」的片子顶成 300.2s。
    # 所以控时按扣掉留白后的上限来裁，withinTarget 仍按声明的区间判定。
    max_seconds = max(min_seconds, max_seconds - len(scenes) * RENDER_PAD_PER_SCENE)

    def dimensions_in(layer: str) -> list[dict]:
        return [s for s in scenes if s["kind"] == "dimension" and s.get("layer") == layer]

    def deep_scenes() -> list[dict]:
        return [s for s in scenes if s["id"] in builder.deep_sources]

    def record(step: str, detail: str, before: float) -> float:
        after = measure(scenes, rate)
        if abs(after - before) < 0.01:
            return before  # 这一级对本份素材没作用（如结论本就只有一句），不记流水账
        builder.adjustments.append(
            {
                "direction": "trim" if after < before else "expand",
                "step": step,
                "detail": detail,
                "deltaSeconds": round(after - before, 2),
                "totalSeconds": after,
            }
        )
        return after

    # --- 超时：先按层预算逐层压进去 ---
    # 不按预算、只按「核心层最后动」的顺序一路裁下去，会把快讲与策略先削到骨头：实测
    # 哔哩哔哩会裁掉整个「持仓者」和全部触发条件，核心层却独占 68%。给每层一个上限，
    # 各层压到自己的份额就停手，主线拿大头的同时策略也还剩得下一段。
    budgets = layer_budgets(scenes, max_seconds) if total > max_seconds else {}

    def layer_over(layer: str) -> bool:
        """这一层超没超自己的预算；总时长本来就没超时不算预算，恒为 False。"""
        ceiling = budgets.get(layer)
        return ceiling is not None and layer_seconds(scenes, layer) > ceiling

    def keep_one_strategy(before: float) -> float:
        nonlocal scenes
        strategy_scenes = [s for s in scenes if s["kind"] == "strategy"]
        if len(strategy_scenes) <= 1:
            return before
        if before - sum(s["estimatedSeconds"] for s in strategy_scenes[1:]) < min_seconds:
            return before  # 砍掉整类会掉到下限以下：拿「太短」换「太长」，两边都不达标
        dropped = [s["data"]["strategyId"] for s in strategy_scenes[1:]]
        scenes = [s for s in scenes if s["kind"] != "strategy" or s is strategy_scenes[0]]
        return record(
            "strategy-keep-one",
            f"只保留 {strategy_scenes[0]['data']['strategyId']}，移除 {'、'.join(dropped)}",
            before,
        )

    def current_total() -> float:
        return round(sum(scene["estimatedSeconds"] for scene in scenes), 2)

    def trim_longest_first(pool, levels_of, rewrite, still_over) -> list[tuple[dict, str]]:
        """**每次只把当前最长的那一屏降一级**，降完重新排序再看下一屏，一放得下就收手。

        比「所有分镜一起降到同一级」重要得多：后者会整步跨过预算，把本来放得下的内容
        白扔掉——实测哔哩哔哩的核心层会从 429s 一步掉到 246s，再由扩展阶梯拿策略把时长
        填回来，于是核心层被压成骨架、策略反倒成了最长的段落，与这支片子的主线正相反。

        返回实际动过的分镜与它们的终态级别，供记账时说清楚每一屏被裁到了哪一级。
        """
        levels = {scene["id"]: levels_of(scene) for scene in pool}
        cursor = {scene["id"]: 0 for scene in pool}
        entry = {scene["id"]: scene["data"]["detail"] for scene in pool}
        while still_over():
            candidates = sorted(
                (scene for scene in pool if cursor[scene["id"]] < len(levels[scene["id"]])),
                # 时长相同时按 id 定序，保证同一份输入永远裁出同一份产出
                key=lambda scene: (-scene["estimatedSeconds"], scene["id"]),
            )
            if not candidates:
                break
            scene = candidates[0]
            index = cursor[scene["id"]]
            rewrite(scene, levels[scene["id"]][index])
            cursor[scene["id"]] += 1
            measure(scenes, rate)
            if current_total() < min_seconds:
                # 这一级跨过了下限：撤回并停手。太短和太长一样是不达标，用「更短」去换
                # 「不太长」没有意义，何况扩展阶梯多半会立刻把它加回来，白折腾一轮。
                rewrite(scene, levels[scene["id"]][index - 1] if index else entry[scene["id"]])
                cursor[scene["id"]] -= 1
                measure(scenes, rate)
                break
        return [(scene, levels[scene["id"]][cursor[scene["id"]] - 1]) for scene in pool if cursor[scene["id"]]]

    def trim_dimensions(pool, step: str, label: str, still_over, before: float) -> float:
        touched = trim_longest_first(pool, dimension_levels, builder.rewrite_dimension, still_over)
        if not touched:
            return before
        detail = "、".join(f"{scene['title']} 降到 {level}" for scene, level in touched)
        return record(step, f"{label}：{detail}", before)

    if layer_over(LAYER_FAST):
        total = trim_dimensions(
            dimensions_in(LAYER_FAST), "fast-dimension-trim", "快讲层维度按屏收紧", lambda: layer_over(LAYER_FAST), total
        )

    if layer_over(LAYER_STRATEGY):
        strategy_scenes = [s for s in scenes if s["kind"] == "strategy"]
        if any(s["data"]["items"] for s in strategy_scenes):
            kept = [len(s["data"]["items"]) for s in strategy_scenes]
            for scene in strategy_scenes:
                builder.rewrite_strategy(scene, 0)
            measure(scenes, rate)
            if current_total() < min_seconds:
                # 同上：裁到下限以下会被扩展阶梯原样加回来，只在流水账里留下一对
                # 自相矛盾的记录（「不播触发条件」紧跟着「播报全部触发条件」）。
                for scene, limit in zip(strategy_scenes, kept):
                    builder.rewrite_strategy(scene, limit)
                measure(scenes, rate)
            else:
                total = record("strategy-drop-triggers", "策略只播建议正文，不播触发条件", total)

    if layer_over(LAYER_STRATEGY):
        # 建议正文本身可能很长（AMD 单条 72 秒、一条触发条件都没有）。没有这一级，策略层
        # 只能整类整类地砍，超出的那几十秒最后全压到核心层身上——实测 AMD 的护城河维度
        # 会被压到只报分数，而策略仍占 72 秒。
        before = total
        touched = trim_longest_first(
            [s for s in scenes if s["kind"] == "strategy"],
            strategy_levels,
            builder.rewrite_strategy_advice,
            lambda: layer_over(LAYER_STRATEGY),
        )
        if touched:
            detail = "、".join(f"{scene['title']} 降到 {level}" for scene, level in touched)
            total = record("strategy-advice-trim", f"策略建议正文按屏收紧：{detail}", before)

    if LAYER_CORE in budgets:
        # 核心层最后裁，所以它的预算不该停在开局那次分配上：快讲与策略压完之后剩下多少，
        # 核心层就能用多少。不重算的话，别的层省下来的几十秒谁也用不上——成片会停在
        # 265 秒左右，而本可以多讲半屏护城河。
        budgets[LAYER_CORE] = max_seconds - sum(
            layer_seconds(scenes, layer) for layer in (LAYER_FRAME, LAYER_FAST, LAYER_STRATEGY)
        )

    if layer_over(LAYER_CORE):
        before = total
        touched = trim_longest_first(
            deep_scenes(), builder.deep_levels, builder.rewrite_deep, lambda: layer_over(LAYER_CORE)
        )
        if touched:
            detail = "、".join(f"{scene['title']} 降到 {level}" for scene, level in touched)
            total = record("core-deep-trim", f"商业模式与护城河按屏收紧：{detail}", before)

    if layer_over(LAYER_CORE):
        total = trim_dimensions(
            dimensions_in(LAYER_CORE), "core-dimension-trim", "核心层维度按屏收紧", lambda: layer_over(LAYER_CORE), total
        )

    # --- 各层都压到预算了仍然超上限：走兜底阶梯，从最不心疼的内容开始 ---
    # 整类策略是最后才动的：它是**一整块内容消失**，不像逐级收紧那样只是变短。放在
    # 分层预算里会为了几秒钟的超额砍掉整个「持仓者」，代价和收益完全不成比例。
    if total > max_seconds:
        opening = next((s for s in scenes if s["kind"] == "opening"), None)
        if opening is not None and opening["data"]["positioning"]:
            builder.rewrite_opening(opening, "clauses:1")
            total = record("opening-first-clause", "开场定位只播第一个句读", total)

    if total > max_seconds:
        total = trim_dimensions(
            [s for s in scenes if s["kind"] == "dimension"],
            "dimension-trim-to-fit",
            "维度按屏收紧至放得下",
            lambda: current_total() > max_seconds,
            total,
        )

    if total > max_seconds:
        total = keep_one_strategy(total)

    # --- 还有富余：先把核心层补回来 ---
    # 补到上限为止，而不是补到下限就停：裁剪是逐级的，最后一级往往一步跨过预算线，
    # 于是核心层停在预算之下、整片白白空出几十秒。这些秒数应该还给最先被裁掉的核心内容，
    # 而不是留白，更不是拿策略的触发条件去填——那会做出「护城河只剩两个方向词、
    # 策略却占 79 秒」的片子，正好和这支片子的主线相反。
    if total < max_seconds:
        before = total
        deep = deep_scenes()
        restored: dict[str, str] = {}
        while total < max_seconds:
            # 每次挑当前最短的一屏升一级：让被裁得最狠的那屏先拿回内容
            progressed = False
            for scene in sorted(deep, key=lambda scene: (scene["estimatedSeconds"], scene["id"])):
                previous = scene["data"]["detail"]
                level = builder.restore_deep_one_level(scene)
                if level is None:
                    continue
                if measure(scenes, rate) > max_seconds:
                    builder.rewrite_deep(scene, previous)  # 升过头了，撤回并换下一屏试
                    measure(scenes, rate)
                    continue
                restored[scene["title"]] = level
                total = measure(scenes, rate)
                progressed = True
                break
            if not progressed:
                break
        if restored:
            detail = "、".join(f"{title} 恢复到 {level}" for title, level in restored.items())
            total = record("core-deep-restore", f"时长有富余，补回商业模式与护城河：{detail}", before)

    if total < min_seconds:
        strategy_scenes = [s for s in scenes if s["kind"] == "strategy"]
        expandable = [s for s in strategy_scenes if s["data"]["itemsAvailable"] > len(s["data"]["items"])]
        if expandable:
            before = [len(s["data"]["items"]) for s in expandable]
            for scene in expandable:
                builder.rewrite_strategy(scene, scene["data"]["itemsAvailable"])
            if measure(scenes, rate) > max_seconds:
                for scene, limit in zip(expandable, before):
                    builder.rewrite_strategy(scene, limit)
                measure(scenes, rate)
            else:
                total = record("strategy-all-triggers", "策略播报全部触发条件", total)

    if total < min_seconds:
        spoken = {s["data"]["strategyId"] for s in scenes if s["kind"] == "strategy"}
        for key in STRATEGY_ORDER:
            if total >= min_seconds:
                break
            if key in spoken:
                continue
            extra = builder.build_strategy(key, 2, note_missing=False)
            if extra is None:
                continue
            closing_index = next((i for i, s in enumerate(scenes) if s["kind"] == "closing"), len(scenes))
            scenes.insert(closing_index, extra)
            if measure(scenes, rate) > max_seconds:
                scenes.remove(extra)
                measure(scenes, rate)
                continue
            total = record("strategy-add-class", f"补充播报 {key}", total)

    return scenes, total


# ---------------------------------------------------------------- 入口


def generate(
    summary: dict,
    rate: float,
    min_seconds: float,
    max_seconds: float,
    strategy_ids: list[str] | None,
    analysis: dict | None = None,
) -> dict:
    builder = ScriptBuilder(summary, rate, analysis)
    detailed = builder.analysis is not None
    if not detailed:
        builder.note_omission(
            "analysis",
            analysis,
            "本片按纯总结模式产出，没有商业模式与护城河深讲分镜",
            "未提供 --analysis（第 2 步维度分析产出）",
        )

    eligible = builder.eligible_strategies()
    selected = [key for key in (strategy_ids or DEFAULT_STRATEGIES) if key in eligible]
    for key in (strategy_ids or DEFAULT_STRATEGIES):
        if key not in eligible:
            builder.note_omission(f"strategies.{key}", (summary.get("strategies") or {}).get(key), "该类策略无内容，未播报")
    if not selected:
        selected = eligible[:2]

    # 深讲分镜挂在它解释的那个维度后面：先听结论，再听展开。mapsTo 认不出来时不猜，
    # 整块深讲按缺失处理，免得把护城河的展开挂到估值后面。
    deep_by_dimension: dict[str, list[dict]] = {}
    if detailed:
        for analysis_key, factory in (
            (DEEP_BUSINESS_KEY, builder.build_business_model_scenes),
            (DEEP_MOAT_KEY, builder.build_moat_scenes),
        ):
            dimension_id = builder.dimension_id_for(analysis_key)
            if dimension_id is None:
                builder.note_omission(
                    f"dimensions.{analysis_key}",
                    None,
                    "跳过该块深讲分镜",
                    f"总结里没有 mapsTo 指向 dimensions.{analysis_key} 的维度，无从判断插在哪一段之后",
                )
                continue
            deep = factory()
            if deep:
                deep_by_dimension[dimension_id] = deep

    scenes = [builder.build_opening()]
    for scene in builder.build_dimensions(core_ids=set(deep_by_dimension)):
        scenes.append(scene)
        scenes.extend(deep_by_dimension.get(scene["data"]["dimensionId"], []))
    for key in selected:
        scene = builder.build_strategy(key, 1)
        if scene is not None:
            scenes.append(scene)
    scenes.append(builder.build_closing())

    scenes, total = fit_duration(builder, scenes, min_seconds, max_seconds)
    builder.reconcile_strategy_omissions(scenes)
    within = min_seconds <= total <= max_seconds

    meta = summary.get("meta") or {}
    company_id = text_of(meta.get("companyId"))
    company_name = text_of(meta.get("companyName"))
    result = {
        # companyId / companyName 同时放在顶层：tts_batch.py 的 manifest 只认顶层这两个键
        "companyId": company_id,
        "companyName": company_name,
        "meta": {
            "companyId": company_id,
            "companyName": company_name,
            "dataCutoff": text_of(meta.get("dataCutoff")),
            "summarizedAt": text_of(meta.get("summarizedAt")),
            "speechRate": rate,
            "targetRange": [min_seconds, max_seconds],
            "mode": "detailed" if detailed else "summary-only",
            "generator": "tools/video/scripts/script_gen.py",
        },
        "scenes": scenes,
        "totals": {
            "sceneCount": len(scenes),
            "estimatedSeconds": total,
            "targetRange": [min_seconds, max_seconds],
            "withinTarget": within,
        },
        "adjustments": builder.adjustments,
        "omissions": builder.omissions,
    }
    if not within:
        result["totals"]["warning"] = (
            f"裁剪/扩展阶梯已走完，预估时长 {total}s 仍在目标区间 "
            f"[{min_seconds}, {max_seconds}] 之外，请人工决定取舍"
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="把 financials-summary.json 转成分镜解说文案 JSON")
    parser.add_argument("--summary", type=Path, required=True, help="第 3 步产出 financials-summary.json 的路径")
    parser.add_argument(
        "--analysis",
        type=Path,
        help="第 2 步产出 financials-analysis.json 的路径；给了就走详解版（商业模式与护城河深讲）",
    )
    parser.add_argument("--out", type=Path, help="输出路径；省略则写 stdout")
    parser.add_argument("--rate", type=float, default=DEFAULT_RATE, help=f"朗读语速，字/秒（默认 {DEFAULT_RATE}）")
    parser.add_argument(
        "--min-seconds",
        type=float,
        help=f"目标时长下限（默认详解版 {DETAILED_RANGE[0]:g}、纯总结 {SUMMARY_ONLY_RANGE[0]:g}）",
    )
    parser.add_argument(
        "--max-seconds",
        type=float,
        help=f"目标时长上限（默认详解版 {DETAILED_RANGE[1]:g}、纯总结 {SUMMARY_ONLY_RANGE[1]:g}）",
    )
    parser.add_argument(
        "--strategies",
        help=f"要播报的策略类别，逗号分隔（默认 {','.join(DEFAULT_STRATEGIES)}；可选 {','.join(STRATEGY_ORDER)}）",
    )
    args = parser.parse_args()

    if args.rate <= 0:
        print("--rate 必须为正数", file=sys.stderr)
        return 2

    try:
        summary = json.loads(args.summary.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"找不到 {args.summary}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"{args.summary} 不是合法 JSON：{exc}", file=sys.stderr)
        return 2

    # --analysis 给了就必须读得出来：路径写错却静默降级成 2-3 分钟的短片，是最难发现的一种错。
    analysis = None
    if args.analysis is not None:
        try:
            analysis = json.loads(args.analysis.read_text(encoding="utf-8"))
        except OSError as exc:
            print(f"读不了 {args.analysis}：{exc}", file=sys.stderr)
            return 2
        except json.JSONDecodeError as exc:
            print(f"{args.analysis} 不是合法 JSON：{exc}", file=sys.stderr)
            return 2
        if not isinstance(analysis, dict) or not isinstance(analysis.get("dimensions"), dict):
            print(f"{args.analysis} 不符合 financials—analysis 契约：缺少 dimensions 对象", file=sys.stderr)
            return 2

    # 目标区间跟着可用素材走：没有维度分析就没有 4-5 分钟的料，硬撑只能靠注水。
    default_min, default_max = DETAILED_RANGE if analysis is not None else SUMMARY_ONLY_RANGE
    min_seconds = default_min if args.min_seconds is None else args.min_seconds
    max_seconds = default_max if args.max_seconds is None else args.max_seconds
    if min_seconds > max_seconds:
        print("--min-seconds 不能大于 --max-seconds", file=sys.stderr)
        return 2

    if not isinstance(summary, dict) or "dimensionSummary" not in summary:
        print(f"{args.summary} 不符合 financials—summary 契约：缺少 dimensionSummary", file=sys.stderr)
        return 2

    # 形状不对要在这里退 2（契约违规），不能让下游抛 AttributeError 退 1——
    # 退 1 是「产出了但时长超区间」的信号，两者不能混。
    dimensions = summary["dimensionSummary"]
    if not isinstance(dimensions, list) or any(not isinstance(item, dict) for item in dimensions):
        print(f"{args.summary} 不符合契约：dimensionSummary 必须是对象数组", file=sys.stderr)
        return 2
    if "strategies" in summary and not isinstance(summary["strategies"], dict):
        print(f"{args.summary} 不符合契约：strategies 必须是对象", file=sys.stderr)
        return 2

    strategy_ids = None
    if args.strategies:
        strategy_ids = [key.strip() for key in args.strategies.split(",") if key.strip()]
        unknown = [key for key in strategy_ids if key not in STRATEGY_ORDER]
        if unknown:
            print(f"未知策略类别：{'、'.join(unknown)}；可选 {'、'.join(STRATEGY_ORDER)}", file=sys.stderr)
            return 2

    result = generate(summary, args.rate, min_seconds, max_seconds, strategy_ids, analysis)
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
        totals = result["totals"]
        print(
            f"{args.out}：{totals['sceneCount']} 个分镜，预估 {totals['estimatedSeconds']}s"
            + ("" if totals["withinTarget"] else "（超出目标区间，见 totals.warning）"),
            file=sys.stderr,
        )
    else:
        sys.stdout.write(payload)

    return 0 if result["totals"]["withinTarget"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
