#!/usr/bin/env python3
"""讲稿加工件（video brief）的契约与校验 — 研究 JSON → 口语化解说 + 画面重点。

## 为什么需要这一层

`script_gen.py` 是纯拼接：解说词逐字取自研究 JSON。好处是绝不编造，代价是**读起来像
报告不像人说话**——研究正文的一句话动辄一两百字，从句套从句，念出来听不懂；画面上
也只能整段铺开，观众在十几秒里读不完。

所以在出片之前加一道**加工**：把研究结论改写成口语解说（`spoken`）与画面重点
（`headline`）。改写只能由 LLM 做——这是判断，不是字符串处理。

## 那怎么保证不胡编

改写归 LLM，**放行归这个文件**。这里做的是确定性校验，过不了就不出片：

1. **数字白名单**（最重要）：讲稿里出现的每一个数字，都必须能在研究 JSON 里原样找到。
   把 `56.68亿` 说成 `57亿` 也算越界——四舍五入是一种改写，改的是研究者的口径。
2. **引用不得凭空出现**：讲稿里不许有 URL、字段路径这类原本就不该进解说的东西。
3. **画面要点**：1–3 条、每条 ≤ 16 字；**不许写维度名与分数**——画面上方各有一处，
   要点里再写一遍就是同一屏说三遍（`护城河` + `5.5 分` + 「护城河5.5分，已被重新定价」）。
4. **不得凭空加分镜**：`scenes` 里的 id 必须是分镜生成器认得的。

校验器只认「有没有越界」，不判断「改写得好不好」——后者是人读了才知道的事。

用法：

    python3 scripts/brief.py check --brief out/brief/<id>.json \\
        --summary   ../../research/companies/<id>/financials-summary.json \\
        --analysis  ../../research/companies/<id>/financials-analysis.json \\
        --collection ../../research/companies/<id>/financials-final.json

退出码：0 通过；1 校验不过（逐条打印越界项）；2 读不了输入。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 估时一律复用 script_gen 的那一个，**不在这里另写一套**。
# 它按「中文 1 字 1 拍、数字逐位、拉丁字母半拍 + 标点停顿」估算，而讲稿是数字密集的，
# 用 len/语速 会系统性低估：美团第二版按字数算 297s、按这个估时器算 303s，
# 于是校验放行了、下一步的控时闸门却拦下来——两个估时器打架比没有闸门更难查。
from script_gen import estimate_seconds

# 画面重点：**1–3 个关键点**，不是一句话。
# 一句话的写法逼着改写者把维度名和分数塞进去凑成完整句（「护城河5.5分，已被重新定价」），
# 而这两样画面上方已经各有一处；点式写法天然只剩结论本身。
POINT_MAX = 16
POINTS_MAX = 3
# 兼容旧契约的单条 headline，按一条要点对待
HEADLINE_MAX = POINT_MAX

# 画面上方已经有维度名与分数了，要点里再写一遍就是同一屏说三遍。
# 「分」要排掉时长与比例的用法：`30分钟`、`3分之1` 不是分数。
# 这条误伤过一次——「履约半径压缩到30分钟」被判成写了分数。
_SCORE_IN_POINT = re.compile(r"\d+(?:\.\d+)?\s*分(?!钟|之)|信心度")
# 解说单条分镜的兜底上限，秒。没给 `--storyboard` 时用它——一条分镜念过一分钟，观众早走神了。
SPOKEN_MAX_SECONDS = 60
# 给了 `--storyboard` 时按**每条分镜的控时预算**卡：预算 = 该分镜原解说的估时 × 语速。
# 口语化几乎一定比原文长（书面语一个词，口语要说一句），所以给一档宽容度；
# 但不能不卡——美团第一版讲稿把片长从 292s 撑到 642s，整支片子直接翻倍。
SPOKEN_BUDGET_SLACK = 1.25
# 单条分镜的地板，秒。控时阶梯把不少维度压成了「第九，管理层，信心度5.5分。」这种一句话，
# 按它的估时算出来的预算只有几秒，等于不许口语稿展开——而展开正是这一层的目的。
# **真正该硬卡的是片长总量**（下面的 max_seconds），逐条预算只防某一屏吃掉全部时间。
SPOKEN_BUDGET_FLOOR_SECONDS = 26.0

# 数字 token：整数或小数，允许千分位。百分号、亿、万这类后缀不进 token，
# 单独比对后缀没有意义——`7.9%` 与 `7.9倍` 的越界与否只看 7.9 在不在源文件里。
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
# 年份与序数这类在任何文本里都自然出现的数字，不要求在源文件里逐个命中：
# 「第一」「三条」在口语里是连接词，不是研究数据。
_FREE_NUMBERS = {str(n) for n in range(0, 13)}
_URL = re.compile(r"https?://|www\.")
# 字段路径：至少两个点的点分标识符，与 script_gen 的 FIELD_PATH_PATTERN 同一判据
_FIELD_PATH = re.compile(r"(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,}")


def _iter_strings(node):
    """把一份 JSON 里所有字符串摊平——数字白名单的干草堆。"""
    if isinstance(node, dict):
        for value in node.values():
            yield from _iter_strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_strings(item)
    elif isinstance(node, str):
        yield node
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        yield str(node)


def _normalize(token: str) -> str:
    """去掉千分位；`1,046.43` 与 `1046.43` 是同一个数。"""
    return token.replace(",", "")


def source_numbers(sources: list) -> set[str]:
    """研究 JSON 里出现过的全部数字 token。

    同时收录去掉尾随 0 的写法：源文件写 `7.90`、讲稿写 `7.9` 不该算越界。
    """
    found: set[str] = set()
    for source in sources:
        for text in _iter_strings(source):
            for match in _NUMBER.finditer(text):
                token = _normalize(match.group(0))
                found.add(token)
                if "." in token:
                    found.add(token.rstrip("0").rstrip("."))
    return found


def scene_budgets(storyboard: dict | None, rate: float) -> tuple[dict[str, float], float]:
    """分镜 id → 这条解说最多多少秒，以及整片的秒数上限。

    预算来自**未加工的分镜稿**：那一份已经过了 `script_gen.py` 的控时阶梯，
    每条分镜的 `estimatedSeconds` 就是它在成片里应得的时间。口语化只是换说法，
    不该顺手把片长翻一倍。
    """
    if not isinstance(storyboard, dict):
        return {}, 0.0
    budgets: dict[str, float] = {}
    for scene in storyboard.get("scenes") or []:
        if not isinstance(scene, dict) or not scene.get("id"):
            continue
        seconds = scene.get("estimatedSeconds")
        if not isinstance(seconds, (int, float)):
            continue
        budgets[str(scene["id"])] = max(SPOKEN_BUDGET_FLOOR_SECONDS, round(seconds * SPOKEN_BUDGET_SLACK, 2))
    target = (storyboard.get("totals") or {}).get("targetRange") or [0, 0]
    return budgets, float(target[1] or 0)


def brief_points(entry: dict) -> list[str]:
    """取这条分镜的画面要点。新契约用 `points` 数组，旧契约的单条 `headline` 也认。"""
    raw = entry.get("points")
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item or "").strip()]
    single = str(entry.get("headline") or "").strip()
    return [single] if single else []


def check_brief(
    brief: dict,
    sources: list,
    *,
    known_scene_ids: set[str] | None = None,
    titles: dict[str, str] | None = None,
    budgets: dict[str, float] | None = None,
    max_seconds: float = 0.0,
    rate: float = 4.25,
) -> list[str]:
    """返回越界项清单；空清单表示通过。"""
    problems: list[str] = []
    scenes = brief.get("scenes")
    if not isinstance(scenes, dict) or not scenes:
        return ["brief.scenes 必须是「分镜 id → {headline, spoken}」的对象，且不能为空"]

    allowed = source_numbers(sources)
    budgets = budgets or {}

    for scene_id, entry in scenes.items():
        if known_scene_ids is not None and scene_id not in known_scene_ids:
            problems.append(f"{scene_id}：分镜生成器里没有这个 id，讲稿不能凭空加分镜")
        if not isinstance(entry, dict):
            problems.append(f"{scene_id}：必须是含 headline / spoken 的对象")
            continue

        points = brief_points(entry)
        spoken = str(entry.get("spoken") or "").strip()
        title = (titles or {}).get(scene_id)
        if not points:
            problems.append(f"{scene_id}.points：不能为空（1–3 条画面要点）")
        elif len(points) > POINTS_MAX:
            problems.append(f"{scene_id}.points：{len(points)} 条，超过上限 {POINTS_MAX} 条")
        for point in points:
            if len(point) > POINT_MAX:
                problems.append(f"{scene_id}.points：「{point}」{len(point)} 字，超过上限 {POINT_MAX}")
            if _SCORE_IN_POINT.search(point):
                problems.append(
                    f"{scene_id}.points：「{point}」写了分数——画面上方已经有一处大号分数，"
                    "要点里只放结论"
                )
            if title and title in point:
                problems.append(
                    f"{scene_id}.points：「{point}」重复了维度名「{title}」——"
                    "画面上方已经有标题，要点里不必再说一遍"
                )
        if not spoken:
            problems.append(f"{scene_id}.spoken：不能为空")
        else:
            limit = budgets.get(scene_id, SPOKEN_MAX_SECONDS)
            seconds = estimate_seconds(spoken, rate)
            if seconds > limit:
                source = "控时预算" if scene_id in budgets else "兜底上限"
                problems.append(
                    f"{scene_id}.spoken：{len(spoken)} 字约 {seconds:.1f}s，超过{source} {limit:.1f}s"
                )

        for field, text in [("points", "　".join(points)), ("spoken", spoken)]:
            if _URL.search(text):
                problems.append(f"{scene_id}.{field}：出现 URL，引用不进解说")
            path = _FIELD_PATH.search(text)
            if path:
                problems.append(f"{scene_id}.{field}：出现字段路径「{path.group(0)}」，引用不进解说")
            for match in _NUMBER.finditer(text):
                token = _normalize(match.group(0))
                if token in _FREE_NUMBERS or token in allowed:
                    continue
                trimmed = token.rstrip("0").rstrip(".") if "." in token else token
                if trimmed in allowed:
                    continue
                problems.append(
                    f"{scene_id}.{field}：数字「{match.group(0)}」在研究数据里找不到——"
                    "改写不得引入新数字，四舍五入也算改口径"
                )

    # 逐条都在预算内、整片仍可能超——分镜多的时候零头会累起来，所以再卡一次总量
    if max_seconds > 0:
        spokens = [str(entry.get("spoken") or "") for entry in scenes.values() if isinstance(entry, dict)]
        total_seconds = round(sum(estimate_seconds(text, rate) for text in spokens), 2)
        if total_seconds > max_seconds:
            problems.append(
                f"整片：解说合计 {sum(len(t) for t in spokens)} 字约 {total_seconds:.0f}s，"
                f"超过目标上限 {max_seconds:.0f}s"
            )

    return problems


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"读不了 {path}：{exc}", file=sys.stderr)
        raise SystemExit(2)
    except json.JSONDecodeError as exc:
        print(f"{path} 不是合法 JSON：{exc}", file=sys.stderr)
        raise SystemExit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="校验讲稿加工件")
    check.add_argument("--brief", type=Path, required=True)
    check.add_argument("--summary", type=Path, required=True)
    check.add_argument("--analysis", type=Path)
    check.add_argument("--collection", type=Path)
    check.add_argument(
        "--storyboard",
        type=Path,
        help="未加工的分镜稿（script_gen.py 不带 --brief 的产出）；给了才能按每条分镜的控时预算卡字数",
    )
    check.add_argument("--rate", type=float, default=4.25, help="朗读语速，字/秒（默认 4.25，与 script_gen 一致）")
    args = parser.parse_args()

    brief = load_json(args.brief)
    sources = [load_json(args.summary)]
    for optional in (args.analysis, args.collection):
        if optional is not None:
            sources.append(load_json(optional))

    storyboard = load_json(args.storyboard) if args.storyboard is not None else None
    budgets, max_seconds = scene_budgets(storyboard, args.rate)
    scenes = (storyboard or {}).get("scenes", [])
    known = {str(scene.get("id")) for scene in scenes if scene.get("id")} or None
    # 维度名用来挡「要点重复标题」——画面上方已经有一处，要点里再写一遍就是同屏说两遍
    titles = {str(scene["id"]): str(scene.get("title") or "") for scene in scenes if scene.get("id")}

    problems = check_brief(
        brief,
        sources,
        known_scene_ids=known,
        titles=titles,
        budgets=budgets,
        max_seconds=max_seconds,
        rate=args.rate,
    )
    if problems:
        print(f"❌ 讲稿校验不通过，{len(problems)} 处越界：", file=sys.stderr)
        for item in problems:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print(f"✅ 讲稿校验通过：{len(brief['scenes'])} 条分镜，数字全部可回溯到研究数据")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
