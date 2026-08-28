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
# 云扬是新闻播报向的男声，比晓晓沉稳，配长期价值调研这种内容比较合适；
# 再放慢 8% 让数字与财报期听得清。
#
# 改这两个常量会改变成片时长，必须重新校准 script_gen.py 的 DEFAULT_RATE（字/秒），
# 否则控时会整体偏。本组合实测：哔哩哔哩详解版估时 293.14s / 实际音频 291.576s，
# 比值 0.995，仍是 4.25 字/秒——云扬本身语速比晓晓快，-8% 之后两者基本持平。
DEFAULT_VOICE = "zh-CN-YunyangNeural"
DEFAULT_RATE = "-8%"


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

    def __init__(self, voice: str = DEFAULT_VOICE, rate: str = DEFAULT_RATE) -> None:
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

# MPEG Layer III 帧头解析用表：[版本][比特率索引] kbps，[版本][采样率索引] Hz。
_MP3_BITRATES = {
    1: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0),
    2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0),
}
_MP3_SAMPLE_RATES = {1: (44100, 48000, 32000), 2: (22050, 24000, 16000), 25: (11025, 12000, 8000)}
_MP3_VERSIONS = {0b00: 25, 0b10: 2, 0b11: 1}


def mp3_duration_seconds(path: Path) -> float | None:
    """逐帧累加得到的容器时长；解析不出来返回 None。

    引擎给的 `duration_seconds` 来自边界事件，停在最后一句收尾处，尾部静音不计，
    比实际文件短最多约 0.07s。stage 3 真去拼 mp3 时按这个容器时长对齐才不会累积漂移。
    纯 stdlib 解析帧头，不依赖 ffprobe（本机 PATH 上没有 ffmpeg，只有 Remotion 自带的）。
    """
    data = path.read_bytes()
    pos = 0
    if data[:3] == b"ID3" and len(data) >= 10:
        # ID3v2 的长度字段是 syncsafe：每字节只用低 7 位，按 8 位解会把 127 字节以上的
        # 标签算短，偏移落进音频里，前几帧被当噪声丢掉。逐字节 & 0x7F 是对不规范写入器的
        # 防御——最高位本该是 0，真置了位不掩掉就会把标签算长，偏移直接跳过开头的音频。
        pos = 10 + sum((b & 0x7F) << shift for b, shift in zip(data[6:10], (21, 14, 7, 0)))

    total = 0.0
    end = len(data)
    while pos + 4 <= end:
        if data[pos] != 0xFF or (data[pos + 1] & 0xE0) != 0xE0:
            pos += 1
            continue
        header, rates = data[pos + 1], data[pos + 2]
        version = _MP3_VERSIONS.get((header >> 3) & 0b11)
        if version is None or (header >> 1) & 0b11 != 0b01:  # 只认 Layer III
            pos += 1
            continue
        bitrate = _MP3_BITRATES[1 if version == 1 else 2][(rates >> 4) & 0b1111]
        rate_index = (rates >> 2) & 0b11
        if not bitrate or rate_index == 0b11:
            pos += 1
            continue
        sample_rate = _MP3_SAMPLE_RATES[version][rate_index]
        samples = 1152 if version == 1 else 576
        frame_bytes = int(samples // 8 * bitrate * 1000 / sample_rate) + ((rates >> 1) & 1)
        if frame_bytes <= 0:
            pos += 1
            continue
        total += samples / sample_rate
        pos += frame_bytes

    return round(total, 3) if total else None


def get_engine(name: str, voice: str, rate: str):
    if name not in ENGINES:
        raise TTSError(f"未知 TTS 引擎 {name!r}，可选：{', '.join(sorted(ENGINES))}")
    return ENGINES[name](voice=voice, rate=rate)


def synthesize_to_file(engine, text: str, out_path: Path, attempts: int = 3, backoff: float = 2.0) -> SynthesisResult:
    """带退避重试的合成；全部失败时抛 TTSError，绝不写出半截或空的音频文件。"""
    attempts = max(1, attempts)  # --retries 0 至少也要试一次，否则报 "重试 0 次仍失败：None"
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
