"""mp3 时长解析的回归测试：python3 -m unittest（不联网、不调 TTS）。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from tts_engine import mp3_duration_seconds  # noqa: E402

# MPEG2 Layer III / 24 kHz / 48 kbps：每帧 144 字节、0.024s，与 edge-tts 输出同规格。
_FRAME = bytes([0xFF, 0xF3, 0x64, 0x00]) + b"\x00" * 140


def _id3(payload_size: int) -> bytes:
    """ID3v2 头：长度字段是 syncsafe 的，每字节只用低 7 位。"""
    size = bytes([(payload_size >> 21) & 0x7F, (payload_size >> 14) & 0x7F, (payload_size >> 7) & 0x7F, payload_size & 0x7F])
    return b"ID3\x03\x00\x00" + size + b"\x00" * payload_size


class Mp3DurationTest(unittest.TestCase):
    def _duration(self, data: bytes) -> float | None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.mp3"
            path.write_bytes(data)
            return mp3_duration_seconds(path)

    def test_frames_accumulate(self):
        self.assertEqual(self._duration(_FRAME * 100), 2.4)

    def test_large_id3_tag_is_skipped_exactly(self):
        # 长度 > 127 时按 8 位解会短算，偏移落进音频里丢帧——这条就是那个回归。
        self.assertEqual(self._duration(_id3(1000) + _FRAME * 100), 2.4)

    def test_not_an_mp3_returns_none(self):
        self.assertIsNone(self._duration(b"\x00" * 512))


if __name__ == "__main__":
    unittest.main()
