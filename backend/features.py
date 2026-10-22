"""Acoustic feature extraction: duration, LUFS loudness, peak dBFS, loop score, and waveform peaks."""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
import pyloudnorm as pyln


@dataclass(frozen=True)
class AcousticFeatures:
    duration_s: float
    lufs_integrated: float | None
    peak_dbfs: float
    loop_score: float | None


def compute_peak_dbfs(samples: npt.NDArray[np.float32]) -> float:
    if samples.size == 0:
        return -120.0
    peak = float(np.max(np.abs(samples)))
    if peak <= 1e-6:
        return -120.0
    return float(20.0 * math.log10(peak))


def compute_lufs_integrated(
    samples: npt.NDArray[np.float32], sample_rate: int = 48000
) -> float | None:
    if samples.size == 0:
        return None
    block_size = 0.400
    min_samples = int(sample_rate * block_size)
    data = samples.astype(np.float64, copy=False)
    if data.shape[0] < min_samples:
        rms = float(np.sqrt(np.mean(np.square(data))))
        if rms <= 1e-6:
            return None
        return float(max(-70.0, 20.0 * math.log10(rms) - 0.691))

    try:
        meter = pyln.Meter(sample_rate, block_size=block_size)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            loudness = float(meter.integrated_loudness(data))
        if not math.isfinite(loudness) or loudness <= -70.0:
            return None
        return loudness
    except Exception:
        return None


def compute_loop_score(samples: npt.NDArray[np.float32], sample_rate: int = 48000) -> float | None:
    boundary_samples = int(0.5 * sample_rate)
    if samples.shape[0] < boundary_samples * 2:
        return None

    head = samples[:boundary_samples].astype(np.float64)
    tail = samples[-boundary_samples:].astype(np.float64)

    head_rms = float(np.sqrt(np.mean(head * head)))
    tail_rms = float(np.sqrt(np.mean(tail * tail)))
    max_rms = max(head_rms, tail_rms)
    if max_rms < 1e-4:
        return 0.0

    rms_ratio = min(head_rms, tail_rms) / max_rms

    n_fft = 2048
    hop = 512

    def _avg_mag_spectrum(seg: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
        if seg.shape[0] < n_fft:
            padded = np.pad(seg, (0, n_fft - seg.shape[0]))
            return np.abs(np.fft.rfft(padded * np.hanning(n_fft)))
        n_frames = 1 + (seg.shape[0] - n_fft) // hop
        win = np.hanning(n_fft)
        acc = np.zeros(n_fft // 2 + 1, dtype=np.float64)
        for i in range(n_frames):
            frame = seg[i * hop : i * hop + n_fft] * win
            acc += np.abs(np.fft.rfft(frame))
        return acc / float(max(1, n_frames))

    spec_head = _avg_mag_spectrum(head)
    spec_tail = _avg_mag_spectrum(tail)
    norm_h = float(np.linalg.norm(spec_head))
    norm_t = float(np.linalg.norm(spec_tail))
    if norm_h <= 1e-9 or norm_t <= 1e-9:
        spec_sim = 0.0
    else:
        spec_sim = float(np.dot(spec_head, spec_tail) / (norm_h * norm_t))
        spec_sim = max(0.0, min(1.0, spec_sim))

    jump = abs(float(samples[0]) - float(samples[-1]))
    slope_head = float(samples[1] - samples[0]) if samples.shape[0] > 1 else 0.0
    slope_tail = float(samples[-1] - samples[-2]) if samples.shape[0] > 1 else 0.0
    slope_diff = abs(slope_head - slope_tail)
    scale = max(0.01, max_rms * 2.0)
    continuity = math.exp(-((jump + 0.5 * slope_diff) / scale))

    score = (0.50 * spec_sim + 0.30 * rms_ratio + 0.20 * continuity) * rms_ratio
    return float(max(0.0, min(1.0, score)))


def extract_features(
    samples: npt.NDArray[np.float32], sample_rate: int = 48000
) -> AcousticFeatures:
    duration_s = float(samples.shape[0]) / float(sample_rate) if sample_rate > 0 else 0.0
    peak_dbfs = compute_peak_dbfs(samples)
    lufs = compute_lufs_integrated(samples, sample_rate=sample_rate)
    loop_score = compute_loop_score(samples, sample_rate=sample_rate)
    return AcousticFeatures(
        duration_s=duration_s,
        lufs_integrated=lufs,
        peak_dbfs=peak_dbfs,
        loop_score=loop_score,
    )


def compute_waveform_peaks(samples: npt.NDArray[np.float32], num_bins: int = 200) -> list[float]:
    if samples.size == 0 or num_bins <= 0:
        return [0.0] * max(1, num_bins)
    n = samples.shape[0]
    if n <= num_bins:
        vals = [round(float(abs(x)), 4) for x in samples]
        return vals + [0.0] * (num_bins - len(vals))
    edges = np.linspace(0, n, num_bins + 1, dtype=np.int64)
    peaks: list[float] = []
    abs_samples = np.abs(samples)
    for i in range(num_bins):
        s_idx = int(edges[i])
        e_idx = max(s_idx + 1, int(edges[i + 1]))
        peaks.append(round(float(np.max(abs_samples[s_idx:e_idx])), 4))
    return peaks
