"""分镜文案 JSON → 逐条音频 + 时长清单。

输入是 OWLL-46 产出的分镜文案 JSON，输出目录里得到：
  01-opening.mp3, 02-business-quality.mp3, …   与分镜 id 一一对应、按顺序编号
  manifest.json                                 分镜 id → 音频路径 → 时长

manifest 里的 `durationSeconds` 就是 stage 3 视频模板对齐画面的依据；`cues` 保留句级
时间轴，需要更细的字幕切分时可以直接用。

输入契约（对字段名做了兼容，字段缺失会明确报错而不是静默跳过）：
  {"companyName": "...", "scenes": [{"id": "opening", "text": "..."}, ...]}
分镜数组键接受 scenes / shots / storyboard / segments，顶层也可以直接是数组；
每条的文本键接受 text / narration / script / content / voiceover，
id 键接受 id / sceneId / scene_id / shotId，缺 id 时按序号兜底为 scene-01。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from text_normalize import load_lexicon, normalize
from tts_engine import DEFAULT_ENGINE, DEFAULT_VOICE, ENGINES, TTSError, get_engine, synthesize_to_file

SCENES_KEYS = ("scenes", "shots", "storyboard", "segments")
TEXT_KEYS = ("text", "narration", "script", "content", "voiceover")
ID_KEYS = ("id", "sceneId", "scene_id", "shotId", "shot_id")


class StoryboardError(ValueError):
    pass


def load_scenes(path: Path) -> tuple[dict, list[dict]]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise StoryboardError(f"{path} 不是合法 JSON：{exc}") from exc

    if isinstance(doc, list):
        return {}, doc
    if not isinstance(doc, dict):
        raise StoryboardError(f"{path} 顶层应为对象或数组，实际是 {type(doc).__name__}")

    for key in SCENES_KEYS:
        raw = doc.get(key)
        if isinstance(raw, list):
            return doc, raw
    raise StoryboardError(f"{path} 里找不到分镜数组，期望顶层键之一：{', '.join(SCENES_KEYS)}")


def _pick(scene: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = scene.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def slugify(scene_id: str) -> str:
    """分镜 id → 文件名安全片段；中文 id 直接保留，只清掉路径分隔符与空白。"""
    slug = re.sub(r"[^\w一-鿿-]+", "-", scene_id).strip("-")
    return slug or "scene"


def build_jobs(scenes: list) -> list[dict]:
    jobs = []
    for index, scene in enumerate(scenes, start=1):
        if not isinstance(scene, dict):
            raise StoryboardError(f"第 {index} 条分镜应为对象，实际是 {type(scene).__name__}")
        text = _pick(scene, TEXT_KEYS)
        if text is None:
            raise StoryboardError(f"第 {index} 条分镜没有文案，期望字段之一：{', '.join(TEXT_KEYS)}")
        scene_id = _pick(scene, ID_KEYS) or f"scene-{index:02d}"
        jobs.append({"index": index, "id": scene_id, "text": text, "title": _pick(scene, ("title", "name"))})

    seen: dict[str, int] = {}
    for job in jobs:  # id 允许重复，但文件名必须唯一
        slug = slugify(job["id"])
        seen[slug] = seen.get(slug, 0) + 1
        if seen[slug] > 1:
            slug = f"{slug}-{seen[slug]}"
        job["audio"] = f"{job['index']:02d}-{slug}.mp3"
    return jobs


def main() -> int:
    parser = argparse.ArgumentParser(description="按分镜文案 JSON 批量合成音频，并输出时长清单")
    parser.add_argument("--storyboard", type=Path, required=True, help="分镜文案 JSON")
    parser.add_argument("--out-dir", type=Path, required=True, help="音频与 manifest.json 的输出目录")
    parser.add_argument("--engine", default=DEFAULT_ENGINE, choices=sorted(ENGINES), help="TTS 引擎")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="音色，默认中文女声")
    parser.add_argument("--rate", default="+0%", help="语速，如 +10%%")
    parser.add_argument("--no-normalize", action="store_true", help="跳过缩写/货币/百分号的朗读改写")
    parser.add_argument("--retries", type=int, default=3, help="单条分镜的最大尝试次数")
    args = parser.parse_args()

    try:
        doc, raw_scenes = load_scenes(args.storyboard)
        jobs = build_jobs(raw_scenes)
    except StoryboardError as exc:
        print(f"分镜文案读取失败：{exc}", file=sys.stderr)
        return 2
    if not jobs:
        print("分镜文案里没有任何分镜", file=sys.stderr)
        return 2

    lexicon = load_lexicon()
    engine = get_engine(args.engine, args.voice, args.rate)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    unknown_tokens: set[str] = set()
    for job in jobs:
        spoken, unknown = (job["text"], []) if args.no_normalize else normalize(job["text"], lexicon)
        unknown_tokens.update(unknown)
        audio_path = args.out_dir / job["audio"]
        try:
            result = synthesize_to_file(engine, spoken, audio_path, attempts=args.retries)
        except TTSError as exc:
            # 中途失败直接退出：已生成的分镜留在磁盘上，重跑覆盖即可，绝不留空音频冒充成功。
            print(f"分镜 {job['id']}（第 {job['index']} 条）合成失败：{exc}", file=sys.stderr)
            print("edge-tts 需要联网调用微软接口；离线环境请改用 README「备选方案」一节的 Piper TTS。", file=sys.stderr)
            return 1

        entries.append(
            {
                "index": job["index"],
                "id": job["id"],
                "title": job["title"],
                "audio": job["audio"],
                "durationSeconds": result.duration_seconds,
                "text": job["text"],
                "normalizedText": spoken,
                "cues": result.cues,
            }
        )
        print(f"[{job['index']:02d}/{len(jobs)}] {job['id']}  {result.duration_seconds}s  {job['audio']}")

    total = round(sum(e["durationSeconds"] for e in entries), 3)
    manifest = {
        "companyId": doc.get("companyId"),
        "companyName": doc.get("companyName") or doc.get("company"),
        "storyboard": str(args.storyboard),
        "engine": engine.name,
        "voice": args.voice,
        "rate": args.rate,
        "normalized": not args.no_normalize,
        "sceneCount": len(entries),
        "totalDurationSeconds": total,
        "unknownTokens": sorted(unknown_tokens),
        "scenes": entries,
    }
    manifest_path = args.out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n{len(entries)} 条分镜，总时长 {total}s（{total / 60:.2f} 分钟）→ {manifest_path}")
    if unknown_tokens:
        print(f"提示：{', '.join(sorted(unknown_tokens))} 未在 scripts/tts_lexicon.json 中登记，按英文字母朗读", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
