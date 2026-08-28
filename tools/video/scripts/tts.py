"""单段文本 → 语音（免费 edge-tts）+ 时长信息。

批量走 `tts_batch.py`；这里是单条自检入口。输出两份产物：
  <out>.mp3   合成音频
  <out>.json  {engine, voice, text, normalizedText, duration_seconds, cues:[...]}

时长与时间轴来自引擎返回的边界事件（中文音色给 SentenceBoundary，英文音色给
WordBoundary，两种都收），不需要 ffprobe。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from text_normalize import normalize
from tts_engine import (
    DEFAULT_ENGINE,
    DEFAULT_VOICE,
    ENGINES,
    TTSError,
    get_engine,
    mp3_duration_seconds,
    synthesize_to_file,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="把一段中文文本合成为 mp3，并输出时长/时间轴")
    parser.add_argument("--text", help="要合成的文本；与 --text-file 二选一")
    parser.add_argument("--text-file", type=Path, help="从文件读取文本（UTF-8）")
    parser.add_argument("--engine", default=DEFAULT_ENGINE, choices=sorted(ENGINES), help="TTS 引擎")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="音色，默认中文女声")
    parser.add_argument("--rate", default="+0%", help="语速，如 +10%%")
    parser.add_argument("--no-normalize", action="store_true", help="跳过缩写/货币/百分号的朗读改写")
    parser.add_argument("--retries", type=int, default=3, help="单条合成的最大尝试次数")
    parser.add_argument("--out", type=Path, default=Path("out/tts/sample"), help="输出路径前缀（不带扩展名）")
    args = parser.parse_args()

    if bool(args.text) == bool(args.text_file):
        parser.error("--text 与 --text-file 必须且只能提供一个")

    try:
        text = (args.text if args.text else args.text_file.read_text(encoding="utf-8")).strip()
        if not text:
            parser.error("文本为空")
        spoken, unknown = (text, []) if args.no_normalize else normalize(text)
    except OSError as exc:  # --text-file 或词表读不了，与批量脚本一样按读取失败退出
        print(f"读取失败：{exc}", file=sys.stderr)
        return 2
    for token in unknown:
        print(f"提示：{token!r} 未在 scripts/tts_lexicon.json 中登记，将按英文字母朗读", file=sys.stderr)

    out_base = args.out
    audio_path = out_base.with_suffix(".mp3")
    engine = get_engine(args.engine, args.voice, args.rate)

    try:
        result = synthesize_to_file(engine, spoken, audio_path, attempts=args.retries)
    except TTSError as exc:
        print(f"TTS 失败：{exc}", file=sys.stderr)
        print("edge-tts 需要联网调用微软接口；离线环境请改用 README「备选方案」一节的 Piper TTS。", file=sys.stderr)
        return 1

    meta = {
        "engine": engine.name,
        "voice": args.voice,
        "rate": args.rate,
        "text": text,
        "normalizedText": spoken,
        "audio": audio_path.name,
        "duration_seconds": result.duration_seconds,
        "container_duration_seconds": mp3_duration_seconds(audio_path),
        "cues": result.cues,
    }
    meta_path = out_base.with_suffix(".json")
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"音频 {audio_path}  时长 {result.duration_seconds}s  时间轴 {meta_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
