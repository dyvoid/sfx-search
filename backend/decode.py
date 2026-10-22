"""ffmpeg and ffprobe subprocess wrappers for audio decoding and probing."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from .scan import to_os_path

TARGET_SAMPLE_RATE = 48000


@dataclass
class ProbeInfo:
    format_name: str
    codec_name: str
    duration_s: float
    sample_rate: int
    channels: int
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class DecodedAudio:
    samples: npt.NDArray[np.float32]
    sample_rate: int
    probe: ProbeInfo


class DecodeError(RuntimeError):
    """Raised when ffprobe or ffmpeg fails to decode an audio file."""


def probe_audio(
    path: str | Path, ffprobe_bin: str = "ffprobe", timeout_s: float = 30.0
) -> ProbeInfo:
    os_path = to_os_path(path)
    cmd = [
        ffprobe_bin,
        "-v",
        "quiet",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        os_path,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except Exception as exc:
        raise DecodeError(f"ffprobe invocation failed: {exc}") from exc

    if proc.returncode != 0:
        stderr_txt = proc.stderr.decode("utf-8", errors="replace").strip()
        raise DecodeError(f"ffprobe exited with {proc.returncode}: {stderr_txt}")

    try:
        payload: dict[str, Any] = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except Exception as exc:
        raise DecodeError(f"ffprobe invalid JSON output: {exc}") from exc

    fmt = payload.get("format") or {}
    streams = payload.get("streams") or []
    audio_stream: dict[str, Any] = {}
    for st in streams:
        if st.get("codec_type") == "audio":
            audio_stream = st
            break
    if not audio_stream and streams:
        audio_stream = streams[0]
    if not audio_stream and not fmt:
        raise DecodeError("No audio streams or format info found")

    raw_format = str(fmt.get("format_name") or "").split(",")[0].strip().lower()
    codec = str(audio_stream.get("codec_name") or raw_format or "unknown").lower()
    ext = Path(str(path)).suffix.lstrip(".").lower()
    container = ext or raw_format or codec

    dur_raw = audio_stream.get("duration") or fmt.get("duration") or 0.0
    try:
        duration_s = max(0.0, float(dur_raw))
    except (TypeError, ValueError):
        duration_s = 0.0

    try:
        sample_rate = int(audio_stream.get("sample_rate") or TARGET_SAMPLE_RATE)
    except (TypeError, ValueError):
        sample_rate = TARGET_SAMPLE_RATE

    try:
        channels = int(audio_stream.get("channels") or 1)
    except (TypeError, ValueError):
        channels = 1

    tags: dict[str, str] = {}
    for source in (fmt.get("tags"), audio_stream.get("tags")):
        if isinstance(source, dict):
            for k, v in source.items():
                if v is not None and str(v).strip():
                    tags[str(k)] = str(v).strip()

    return ProbeInfo(
        format_name=f"{container}/{codec}" if codec and codec != container else container,
        codec_name=codec,
        duration_s=duration_s,
        sample_rate=sample_rate,
        channels=channels,
        tags=tags,
    )


def decode_audio_pcm(
    path: str | Path,
    ffmpeg_bin: str = "ffmpeg",
    target_sr: int = TARGET_SAMPLE_RATE,
    timeout_s: float = 120.0,
) -> npt.NDArray[np.float32]:
    os_path = to_os_path(path)
    cmd = [
        ffmpeg_bin,
        "-nostdin",
        "-v",
        "error",
        "-i",
        os_path,
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        str(target_sr),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except Exception as exc:
        raise DecodeError(f"ffmpeg invocation failed: {exc}") from exc

    if proc.returncode != 0:
        stderr_txt = proc.stderr.decode("utf-8", errors="replace").strip()
        raise DecodeError(f"ffmpeg exited with {proc.returncode}: {stderr_txt}")

    buf = proc.stdout
    n_floats = len(buf) // 4
    if n_floats == 0:
        stderr_txt = proc.stderr.decode("utf-8", errors="replace").strip()
        raise DecodeError(f"Decoded 0 audio samples ({stderr_txt})")

    samples = np.frombuffer(buf[: n_floats * 4], dtype="<f4").astype(np.float32, copy=True)
    if not np.all(np.isfinite(samples)):
        samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    return samples


def decode_file(
    path: str | Path,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    target_sr: int = TARGET_SAMPLE_RATE,
) -> DecodedAudio:
    probe = probe_audio(path, ffprobe_bin=ffprobe_bin)
    samples = decode_audio_pcm(path, ffmpeg_bin=ffmpeg_bin, target_sr=target_sr)
    actual_dur = float(samples.shape[0]) / float(target_sr)
    if actual_dur > 0:
        probe.duration_s = actual_dur
    return DecodedAudio(samples=samples, sample_rate=target_sr, probe=probe)
