"""TTS 引擎抽象：调用方只依赖 `get_engine(name)` 与 `SynthesisResult`。

MVP 只实现免费的 edge-tts。要换成付费方案（ElevenLabs 等）时新增一个实现类、
在 `ENGINES` 里登记即可，`tts.py` / `tts_batch.py` 不用改。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path

TICKS_PER_SECOND = 10_000_000  # edge-tts 的 offset/duration 单位是 100 纳秒
DEFAULT_ENGINE = "edge-tts"
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


class TTSError(RuntimeError):
    """合成失败；调用方据此重试或带非零码退出，不落空音频。"""


@dataclass
class SynthesisResult:
    audio: bytes
    duration_seconds: float
    cues: list[dict] = field(default_factory=list)


class EdgeTTSEngine:
    """微软 Edge 朗读接口，免费但需联网，无官方 SLA。"""

    name = DEFAULT_ENGINE

    def __init__(self, voice: str = DEFAULT_VOICE, rate: str = "+0%") -> None:
        self.voice = voice
        self.rate = rate

    def synthesize(self, text: str) -> SynthesisResult:
        try:
            return asyncio.run(self._synthesize(text))
        except TTSError:
            raise
        except Exception as exc:  # 网络抖动 / 限流 / 协议变更
            raise TTSError(f"edge-tts 调用失败：{exc}") from exc

    async def _synthesize(self, text: str) -> SynthesisResult:
        import edge_tts

        communicate = edge_tts.Communicate(text, self.voice, rate=self.rate)
        chunks: list[bytes] = []
        cues: list[dict] = []

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
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

        audio = b"".join(chunks)
        if not audio:
            raise TTSError("edge-tts 返回空音频")
        if not cues:
            raise TTSError("edge-tts 未返回边界事件，拿不到时长；换用 README「备选方案」一节的 Piper TTS")

        return SynthesisResult(audio=audio, duration_seconds=round(max(c["end"] for c in cues), 3), cues=cues)


ENGINES = {EdgeTTSEngine.name: EdgeTTSEngine}


def get_engine(name: str, voice: str, rate: str):
    if name not in ENGINES:
        raise TTSError(f"未知 TTS 引擎 {name!r}，可选：{', '.join(sorted(ENGINES))}")
    return ENGINES[name](voice=voice, rate=rate)


def synthesize_to_file(engine, text: str, out_path: Path, attempts: int = 3, backoff: float = 2.0) -> SynthesisResult:
    """带退避重试的合成；全部失败时抛 TTSError，绝不写出半截或空的音频文件。"""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            result = engine.synthesize(text)
        except TTSError as exc:
            last = exc
            if attempt < attempts:
                time.sleep(backoff * attempt)
            continue
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(result.audio)  # 先拿到完整音频再落盘
        return result
    raise TTSError(f"重试 {attempts} 次仍失败：{last}")
