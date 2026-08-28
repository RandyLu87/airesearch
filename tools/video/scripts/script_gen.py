"""financials-summary.json → 分镜解说文案（确定性拼接，不调用 LLM）。

输入是任意一家公司符合 `docs/model/financials—summary-template.json` 契约的第 3 步产出，
输出是一份分镜 JSON，供 TTS 合成与 Remotion 模板消费：

  {
    "companyId": "...", "companyName": "...",   # 顶层重复一份，tts_batch 的 manifest 只认这里
    "meta":    {companyId, companyName, dataCutoff, source, speechRate, ...},
    "scenes":  [{id, kind, title, narration, estimatedSeconds, data}],
    "totals":  {estimatedSeconds, targetRange, withinTarget, sceneCount},
    "adjustments": [...],   # 为落进时长区间做了哪些裁剪/扩展
    "omissions":   [...]    # 原文缺失(unavailable/__TODO__)因而没播的字段
  }

三条硬规矩，和 docs/research/tools/ 下的脚本一致：

1. **不新增判断、不重算数字**。解说词只转述 `dimensionSummary[].conclusion`、
   `strategies[].advice/condition/action/signal/observable` 与 `disclaimer` 的原文，
   分数直接取 `confidence` 原值。模板只提供「第几、维度名、信心度 X 分」这类连接词。
2. **缺失如实说**。`unavailable` / `__TODO__` / 空值一律播「暂无数据」并记进 `omissions`，
   不拿别的字段顶替。
3. **不静默截断**。总时长超出区间时按固定阶梯裁剪，每一步都写进 `adjustments`；
   阶梯走完仍不达标就带 `withinTarget: false` 输出，让调用方看得见。

`scoreBasis` 与 `triggers[].basis` 刻意不进解说词：它们是给人核对的引用路径
（`dimensions.valuation.analysis.threeScenario` 这类），念出来只会是噪音。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

TODO_SENTINEL = "__TODO__"

DEFAULT_RATE = 4.5  # 中文朗读语速，字/秒（edge-tts zh-CN-XiaoxiaoNeural 默认语速实测区间 4-5）
DEFAULT_MIN_SECONDS = 120.0
DEFAULT_MAX_SECONDS = 180.0

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


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?])", text)
    return [part for part in (p.strip() for p in parts) if part]


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


def ensure_period(text: str) -> str:
    if not text:
        return text
    return text if text[-1] in "。！？!?" else text + "。"


def estimate_seconds(text: str, rate: float) -> float:
    """按字数/语速估时，中文 1 字 1 拍、数字逐位读、拉丁字母半拍，再加标点停顿。

    只是估算：真实时长以 stage 2 的 TTS 产出（`tts.py` 的 duration_seconds）为准，
    这里的作用是在合成之前就能判断要不要裁剪。
    """
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
    def __init__(self, summary: dict, rate: float):
        self.summary = summary
        self.rate = rate
        self.omissions: list[dict] = []
        self.adjustments: list[dict] = []

    def note_omission(self, path: str, value, note: str, reason: str | None = None) -> None:
        if any(item["path"] == path for item in self.omissions):
            return  # 同一字段可能被开场与维度分镜各碰一次，只记一条
        self.omissions.append({"path": path, "reason": reason or missing_reason(value), "handling": note})

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
            positioning = first_sentence(normalize_for_speech(text_of(quality["conclusion"])))
        else:
            self.note_omission(
                "dimensionSummary[businessQuality].conclusion",
                (quality or {}).get("conclusion"),
                "开场省略一句话定位，只报公司名",
            )

        return {
            "id": "opening",
            "kind": "opening",
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
        parts = [f"本期看的公司是{name}。"]
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

    # -- 七维度 -------------------------------------------------------

    def build_dimensions(self) -> list[dict]:
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
                conclusion = ensure_period(normalize_for_speech(text_of(item["conclusion"])))

            scenes.append(
                {
                    "id": f"dimension-{dimension_id}",
                    "kind": "dimension",
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
        self, key: str, item_limit: int, *, note_missing: bool = True, allow_empty: bool = False
    ) -> dict | None:
        """note_missing=False 关掉记账（重建/试探，缺失早已记过）；
        allow_empty=True 允许返回空正文分镜，只有「已在分镜里、仅重新裁剪」才该开。"""
        block = (self.summary.get("strategies") or {}).get(key)
        if not isinstance(block, dict):
            if note_missing:
                self.note_omission(f"strategies.{key}", block, "该类策略未播报")
            return None

        title = text_of(block.get("title")) or STRATEGY_FALLBACK_TITLE.get(key, key)
        advice = "" if is_missing(block.get("advice")) else normalize_for_speech(text_of(block["advice"]))
        items = self._strategy_items(key, block)

        spoken_items = []
        for item in items[:item_limit]:
            if key in ADVICE_STRATEGIES:
                condition = normalize_for_speech(text_of(item.get("condition")))
                action = normalize_for_speech(text_of(item.get("action")))
            else:
                condition = normalize_for_speech(text_of(item.get("observable")))
                action = normalize_for_speech(text_of(item.get("signal")))
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
            "title": title,
            "narration": self._strategy_narration(key, title, advice, spoken_items),
            "data": {
                "strategyId": key,
                "advice": advice,
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

    def rewrite_strategy(self, scene: dict, item_limit: int) -> None:
        rebuilt = self.build_strategy(
            scene["data"]["strategyId"], item_limit, note_missing=False, allow_empty=True
        )
        if rebuilt is None:
            return
        scene["narration"] = rebuilt["narration"]
        scene["data"] = rebuilt["data"]

    # -- 结尾 ---------------------------------------------------------

    def build_closing(self) -> dict:
        disclaimer = text_of(self.summary.get("disclaimer"))
        if not disclaimer:
            self.note_omission("disclaimer", self.summary.get("disclaimer"), "使用契约默认免责声明")
            disclaimer = "本内容仅供研究参考，不构成个性化投资建议。"
        return {
            "id": "closing",
            "kind": "closing",
            "title": "免责声明",
            "narration": ensure_period(normalize_for_speech(disclaimer)),
            "data": {"disclaimer": disclaimer},
        }


# ---------------------------------------------------------------- 时长调节


def measure(scenes: list[dict], rate: float) -> float:
    total = 0.0
    for scene in scenes:
        scene["estimatedSeconds"] = estimate_seconds(scene["narration"], rate)
        total += scene["estimatedSeconds"]
    return round(total, 2)


def fit_duration(
    builder: ScriptBuilder,
    scenes: list[dict],
    min_seconds: float,
    max_seconds: float,
) -> tuple[list[dict], float]:
    """把总时长压/拉进 [min, max]，每一步都记账。

    裁剪阶梯先动「维度理由的长度」（信息密度最低、也最容易在句读处干净截断），
    再动策略的触发条件，最后才砍掉整类内容——顺序固定，同一份输入永远得到同一份产出。
    七维度是报告主干，所以策略排在维度理由之后被裁；契约本身也只要求播 1-2 类策略。

    扩展阶梯只加内容、不回滚已裁的部分，且每一步都要复核「补完不会重新超上限」，
    否则裁了又加会在区间边界上来回抖。
    """
    rate = builder.rate
    total = measure(scenes, rate)

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

    # --- 超时：逐级裁剪 ---
    if total > max_seconds:
        dimension_scenes = [s for s in scenes if s["kind"] == "dimension"]
        if dimension_scenes:
            for scene in dimension_scenes:
                builder.rewrite_dimension(scene, "first-sentence")
            total = record("dimension-first-sentence", "维度理由只播第一句", total)

    if total > max_seconds:
        # 逐级收紧句读预算，取「仍然放得下的最大 K」，而不是一步砍到只剩一句读。
        dimension_scenes = [s for s in scenes if s["kind"] == "dimension"]
        widest = max(
            (len(split_clauses(first_sentence(s["data"]["conclusion"]))) for s in dimension_scenes),
            default=0,
        )
        for budget in range(widest - 1, 0, -1):
            for scene in dimension_scenes:
                builder.rewrite_dimension(scene, f"clauses:{budget}")
            if measure(scenes, rate) <= max_seconds or budget == 1:
                total = record("dimension-clause-budget", f"维度理由只播前 {budget} 个句读", total)
                break

    if total > max_seconds:
        opening = next((s for s in scenes if s["kind"] == "opening"), None)
        if opening is not None and opening["data"]["positioning"]:
            builder.rewrite_opening(opening, "clauses:1")
            total = record("opening-first-clause", "开场定位只播第一个句读", total)

    if total > max_seconds:
        strategy_scenes = [s for s in scenes if s["kind"] == "strategy"]
        if strategy_scenes and any(s["data"]["items"] for s in strategy_scenes):
            for scene in strategy_scenes:
                builder.rewrite_strategy(scene, 0)
            total = record("strategy-drop-triggers", "策略只播建议正文，不播触发条件", total)

    if total > max_seconds:
        strategy_scenes = [s for s in scenes if s["kind"] == "strategy"]
        if len(strategy_scenes) > 1:
            dropped = [s["data"]["strategyId"] for s in strategy_scenes[1:]]
            scenes = [s for s in scenes if s["kind"] != "strategy" or s is strategy_scenes[0]]
            total = record("strategy-keep-one", f"只保留 {strategy_scenes[0]['data']['strategyId']}，移除 {'、'.join(dropped)}", total)

    if total > max_seconds:
        # 最后一级：从最长的维度开始逐个只留分数，够了就停——一次性全砍会把
        # 总时长打到下限以下，反而更差。
        dropped = []
        candidates = sorted(
            (s for s in scenes if s["kind"] == "dimension" and s["data"]["detail"] != "score-only"),
            key=lambda scene: scene["estimatedSeconds"],
            reverse=True,
        )
        for scene in candidates:
            if total <= max_seconds:
                break
            builder.rewrite_dimension(scene, "score-only")
            dropped.append(scene["title"])
            total = measure(scenes, rate)
        if dropped:
            total = record("dimension-score-only", f"{'、'.join(dropped)} 只播名称与信心度，不播理由", total)

    # --- 不足：逐级扩展（裁剪跨过区间时也会走到这里，补的只是策略，不回滚已裁内容）---
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


def generate(summary: dict, rate: float, min_seconds: float, max_seconds: float, strategy_ids: list[str] | None) -> dict:
    builder = ScriptBuilder(summary, rate)

    eligible = builder.eligible_strategies()
    selected = [key for key in (strategy_ids or DEFAULT_STRATEGIES) if key in eligible]
    for key in (strategy_ids or DEFAULT_STRATEGIES):
        if key not in eligible:
            builder.note_omission(f"strategies.{key}", (summary.get("strategies") or {}).get(key), "该类策略无内容，未播报")
    if not selected:
        selected = eligible[:2]

    scenes = [builder.build_opening()]
    scenes.extend(builder.build_dimensions())
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
    parser.add_argument("--out", type=Path, help="输出路径；省略则写 stdout")
    parser.add_argument("--rate", type=float, default=DEFAULT_RATE, help=f"朗读语速，字/秒（默认 {DEFAULT_RATE}）")
    parser.add_argument("--min-seconds", type=float, default=DEFAULT_MIN_SECONDS, help="目标时长下限")
    parser.add_argument("--max-seconds", type=float, default=DEFAULT_MAX_SECONDS, help="目标时长上限")
    parser.add_argument(
        "--strategies",
        help=f"要播报的策略类别，逗号分隔（默认 {','.join(DEFAULT_STRATEGIES)}；可选 {','.join(STRATEGY_ORDER)}）",
    )
    args = parser.parse_args()

    if args.min_seconds > args.max_seconds:
        print("--min-seconds 不能大于 --max-seconds", file=sys.stderr)
        return 2
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

    result = generate(summary, args.rate, args.min_seconds, args.max_seconds, strategy_ids)
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
