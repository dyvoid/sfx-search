"""Shared test fixtures and deterministic fake embedder for fast unit testing."""

from __future__ import annotations

import hashlib
import struct
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import numpy.typing as npt
import soundfile as sf
from sfxsearch.embed import (
    EmbeddedFileResult,
    compute_mean_file_vec,
    l2_normalize,
    slice_audio_windows,
)


class FakeEmbedder:
    """Fast deterministic embedder for unit tests that do not require the full CLAP GPU model."""

    def __init__(
        self,
        model_id: str = "test/fake-clap",
        embedding_dim: int = 16,
        window_s: float = 10.0,
        hop_s: float = 5.0,
        max_chunks_per_file: int = 120,
    ) -> None:
        self._model_id = model_id
        self._embedding_dim = embedding_dim
        self.window_s = window_s
        self.hop_s = hop_s
        self.max_chunks_per_file = max_chunks_per_file
        self.text_calls: list[str] = []

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def embedding_dim(self) -> int:
        return self._embedding_dim

    def embed_windows(self, windows: Sequence[npt.NDArray[np.float32]]) -> npt.NDArray[np.float32]:
        if not windows:
            return np.zeros((0, self._embedding_dim), dtype=np.float32)
        vecs: list[npt.NDArray[np.float32]] = []
        for w in windows:
            arr = np.asarray(w, dtype=np.float32)
            # Compute deterministic spectral/statistical features + hash projection
            vec = np.zeros(self._embedding_dim, dtype=np.float32)
            if arr.size > 0:
                rms = float(np.sqrt(np.mean(arr * arr)))
                zcr = float(np.mean(np.abs(np.diff(np.sign(arr)))))
                spec = np.abs(np.fft.rfft(arr[: min(48000, arr.size)]))
                bands = np.array_split(spec, min(self._embedding_dim, max(1, spec.size)))
                for i, b in enumerate(bands[: self._embedding_dim]):
                    vec[i] = float(np.mean(b)) if b.size > 0 else 0.0
                vec[0] += rms * 10.0
                if self._embedding_dim > 1:
                    vec[1] += zcr * 5.0
            if float(np.linalg.norm(vec)) <= 1e-9:
                vec[0] = 1.0
            vecs.append(l2_normalize(vec))
        return np.vstack(vecs).astype(np.float32)

    def embed_audio(
        self,
        samples: npt.NDArray[np.float32],
        sample_rate: int = 48000,
    ) -> EmbeddedFileResult:
        windows = slice_audio_windows(
            samples=samples,
            sample_rate=sample_rate,
            window_s=self.window_s,
            hop_s=self.hop_s,
            max_chunks_per_file=self.max_chunks_per_file,
        )
        chunk_vecs = self.embed_windows([w.samples for w in windows])
        file_vec = compute_mean_file_vec(chunk_vecs)
        return EmbeddedFileResult(
            chunk_indices=[w.chunk_idx for w in windows],
            start_times=[w.start_s for w in windows],
            end_times=[w.end_s for w in windows],
            chunk_vecs=chunk_vecs,
            file_vec=file_vec,
        )

    def embed_texts(self, queries: Sequence[str]) -> npt.NDArray[np.float32]:
        out: list[npt.NDArray[np.float32]] = []
        for q in queries:
            self.text_calls.append(q)
            digest = hashlib.sha256(q.lower().strip().encode("utf-8")).digest()
            raw = (
                np.frombuffer(digest, dtype=np.uint8)[: self._embedding_dim].astype(np.float32)
                - 128.0
            )
            if raw.shape[0] < self._embedding_dim:
                raw = np.pad(raw, (0, self._embedding_dim - raw.shape[0]))
            out.append(l2_normalize(raw))
        return np.vstack(out).astype(np.float32)

    def embed_text(self, query: str) -> npt.NDArray[np.float32]:
        return self.embed_texts([query])[0]


def write_sine_wav(
    path: Path,
    freq_hz: float = 440.0,
    duration_s: float = 1.5,
    sample_rate: int = 48000,
    amplitude: float = 0.5,
    channels: int = 1,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(round(duration_s * sample_rate))
    t = np.arange(n, dtype=np.float32) / float(sample_rate)
    mono = (amplitude * np.sin(2.0 * np.pi * freq_hz * t)).astype(np.float32)
    if channels > 1:
        data = np.column_stack([mono for _ in range(channels)])
    else:
        data = mono
    sf.write(str(path), data, sample_rate, subtype="PCM_16")
    return path


def append_bwf_and_ixml_chunks(
    wav_path: Path,
    bext_description: str = "Slow creaking wooden floorboard in old house",
    bext_originator: str = "SFX Lab",
    ixml_category: str = "WOOD",
    ixml_subcategory: str = "CREAK",
    ixml_keywords: str = "floor creak wood eerie",
) -> None:
    raw = bytearray(wav_path.read_bytes())
    bext_buf = bytearray(612)
    desc_bytes = bext_description.encode("utf-8")[:255]
    orig_bytes = bext_originator.encode("utf-8")[:31]
    bext_buf[0 : len(desc_bytes)] = desc_bytes
    bext_buf[256 : 256 + len(orig_bytes)] = orig_bytes

    ixml_str = (
        f"<BWFXML><CATEGORY>{ixml_category}</CATEGORY>"
        f"<SUBCATEGORY>{ixml_subcategory}</SUBCATEGORY>"
        f"<KEYWORDS>{ixml_keywords}</KEYWORDS></BWFXML>"
    )
    ixml_bytes = ixml_str.encode("utf-8")
    if len(ixml_bytes) % 2 == 1:
        ixml_bytes += b"\x00"

    raw.extend(b"bext" + struct.pack("<I", len(bext_buf)) + bext_buf)
    raw.extend(b"iXML" + struct.pack("<I", len(ixml_bytes)) + ixml_bytes)

    riff_size = len(raw) - 8
    raw[4:8] = struct.pack("<I", riff_size)
    wav_path.write_bytes(bytes(raw))
