"""文本 → 语音（edge-tts，免费）+ 时长信息。

单独可运行，不依赖 Remotion。输出两份产物：
  <out>.mp3   合成音频
  <out>.json  {voice, text, duration_seconds, cues:[{kind, text, start, end}]}

时长与时间轴来自 edge-tts 返回的边界事件（中文音色给的是 SentenceBoundary，
英文音色给的是 WordBoundary，两种都收），不需要 ffprobe，后续分镜对齐直接读这份 JSON。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

TICKS_PER_SECOND = 10_000_000  # edge-tts 的 offset/duration 单位是 100 纳秒


async def synthesize(text: str, voice: str, rate: str, out_base: Path) -> dict:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    audio_path = out_base.with_suffix(".mp3")
    cues: list[dict] = []

    with audio_path.open("wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                start = chunk["offset"] / TICKS_PER_SECOND
                cues.append(
                    {
                        "kind": chunk["type"],
                        "text": chunk["text"],
                        "start": round(start, 3),
                        "end": round(start + chunk["duration"] / TICKS_PER_SECOND, 3),
                    }
                )

    if not cues:
        raise RuntimeError("edge-tts 未返回边界事件，无法给出时长；请检查文本或换用备选方案")

    return {
        "voice": voice,
        "rate": rate,
        "text": text,
        "audio": audio_path.name,
        "duration_seconds": round(max(cue["end"] for cue in cues), 3),
        "cues": cues,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="用 edge-tts 把中文文本合成为 mp3，并输出时长/逐词时间轴")
    parser.add_argument("--text", help="要合成的文本；与 --text-file 二选一")
    parser.add_argument("--text-file", type=Path, help="从文件读取文本（UTF-8）")
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural", help="音色，默认中文女声")
    parser.add_argument("--rate", default="+0%", help="语速，如 +10%%")
    parser.add_argument("--out", type=Path, default=Path("out/tts/sample"), help="输出路径前缀（不带扩展名）")
    args = parser.parse_args()

    if bool(args.text) == bool(args.text_file):
        parser.error("--text 与 --text-file 必须且只能提供一个")

    text = args.text if args.text else args.text_file.read_text(encoding="utf-8")
    text = text.strip()
    if not text:
        parser.error("文本为空")

    out_base = args.out
    out_base.parent.mkdir(parents=True, exist_ok=True)

    try:
        meta = asyncio.run(synthesize(text, args.voice, args.rate, out_base))
    except Exception as exc:  # 网络不可达时给出可执行的下一步，而不是裸栈
        print(f"TTS 失败：{exc}", file=sys.stderr)
        print("edge-tts 需要联网调用微软接口；离线环境请改用 README「备选方案」一节的 Piper TTS。", file=sys.stderr)
        return 1

    meta_path = out_base.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"音频 {out_base.with_suffix('.mp3')}  时长 {meta['duration_seconds']}s  时间轴 {meta_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
