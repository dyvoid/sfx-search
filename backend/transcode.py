"""Encode Studio output to the format chosen in the Save / Download dialog.

The browser always sends a lossless WAV; `ffmpeg` (already required for
decoding) writes the requested format, so the web app needs no encoders.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .scan import to_os_path

OutputFormat = Literal["wav", "flac", "mp3", "ogg", "opus"]

EXTENSIONS: dict[str, str] = {
    "wav": ".wav",
    "flac": ".flac",
    "mp3": ".mp3",
    "ogg": ".ogg",
    "opus": ".opus",
}

MEDIA_TYPES: dict[str, str] = {
    "wav": "audio/wav",
    "flac": "audio/flac",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
}

BIT_DEPTHS: dict[str, tuple[int, ...]] = {
    "wav": (16, 24, 32),
    "flac": (16, 24),
}

# kbps; Opus tops out at 256 per channel pair in practice, MP3 at 320.
BITRATES: dict[str, tuple[int, ...]] = {
    "mp3": (128, 192, 256, 320),
    "ogg": (96, 128, 192, 256, 320),
    "opus": (64, 96, 128, 192, 256),
}


class TranscodeError(Exception):
    pass


@dataclass(frozen=True)
class EncodeSpec:
    format: OutputFormat = "wav"
    bit_depth: int = 24
    bitrate_kbps: int = 192

    @property
    def extension(self) -> str:
        return EXTENSIONS[self.format]

    @property
    def media_type(self) -> str:
        return MEDIA_TYPES[self.format]


def parse_spec(fmt: str, bit_depth: int | None, bitrate_kbps: int | None) -> EncodeSpec:
    """Validate dialog options; raises ValueError with a user-facing message."""
    f = fmt.strip().lower().lstrip(".")
    if f not in EXTENSIONS:
        raise ValueError(f"Unsupported format: {fmt}")
    if f in BIT_DEPTHS:
        depth = bit_depth if bit_depth is not None else 24
        if depth not in BIT_DEPTHS[f]:
            raise ValueError(f"{f.upper()} supports bit depth {BIT_DEPTHS[f]}, got {depth}")
        return EncodeSpec(format=f, bit_depth=depth)  # type: ignore[arg-type]
    rate = bitrate_kbps if bitrate_kbps is not None else 192
    if rate not in BITRATES[f]:
        raise ValueError(f"{f.upper()} supports bitrates {BITRATES[f]} kbps, got {rate}")
    return EncodeSpec(format=f, bitrate_kbps=rate)  # type: ignore[arg-type]


def _codec_args(spec: EncodeSpec) -> list[str]:
    if spec.format == "wav":
        codec = {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_f32le"}[spec.bit_depth]
        return ["-c:a", codec, "-f", "wav"]
    if spec.format == "flac":
        fmt = "s16" if spec.bit_depth == 16 else "s32"
        return [
            "-c:a",
            "flac",
            "-sample_fmt",
            fmt,
            "-bits_per_raw_sample",
            str(spec.bit_depth),
            "-compression_level",
            "8",
            "-f",
            "flac",
        ]
    rate = f"{spec.bitrate_kbps}k"
    if spec.format == "mp3":
        return ["-c:a", "libmp3lame", "-b:a", rate, "-f", "mp3"]
    if spec.format == "ogg":
        return ["-c:a", "libvorbis", "-b:a", rate, "-f", "ogg"]
    return ["-c:a", "libopus", "-b:a", rate, "-f", "opus"]


def transcode_file(
    src: str | Path,
    dst: str | Path,
    spec: EncodeSpec,
    ffmpeg_bin: str = "ffmpeg",
    timeout_s: float = 300.0,
) -> None:
    """Encode the WAV at `src` into `dst` (overwritten) per `spec`."""
    cmd = [
        ffmpeg_bin,
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        to_os_path(src),
        "-vn",
        "-map_metadata",
        "-1",
        *_codec_args(spec),
        to_os_path(dst),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_s, check=False)
    except Exception as exc:
        raise TranscodeError(f"ffmpeg invocation failed: {exc}") from exc
    if proc.returncode != 0:
        stderr_txt = proc.stderr.decode("utf-8", errors="replace").strip()
        raise TranscodeError(f"ffmpeg exited with {proc.returncode}: {stderr_txt}")
