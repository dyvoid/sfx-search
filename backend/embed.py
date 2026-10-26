"""CLAP audio and text embedder with deterministic windowing and LRU query cache."""

from __future__ import annotations

import logging
import math
import threading
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import numpy as np
import numpy.typing as npt
import torch
from transformers import ClapModel, ClapProcessor

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AudioWindow:
    chunk_idx: int
    start_s: float
    end_s: float
    samples: npt.NDArray[np.float32]


@dataclass(frozen=True)
class EmbeddedFileResult:
    chunk_indices: list[int]
    start_times: list[float]
    end_times: list[float]
    chunk_vecs: npt.NDArray[np.float32]
    file_vec: npt.NDArray[np.float32]


class EmbedderProtocol(Protocol):
    @property
    def model_id(self) -> str: ...

    @property
    def embedding_dim(self) -> int: ...

    def embed_windows(
        self, windows: Sequence[npt.NDArray[np.float32]]
    ) -> npt.NDArray[np.float32]: ...

    def embed_audio(
        self,
        samples: npt.NDArray[np.float32],
        sample_rate: int = 48000,
    ) -> EmbeddedFileResult: ...

    def embed_text(self, query: str) -> npt.NDArray[np.float32]: ...

    def embed_texts(self, queries: Sequence[str]) -> npt.NDArray[np.float32]: ...


def l2_normalize(vecs: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    arr = np.asarray(vecs, dtype=np.float32)
    if arr.ndim == 1:
        norm = float(np.linalg.norm(arr))
        if norm <= 1e-12:
            return arr
        return (arr / norm).astype(np.float32)
    norms = np.linalg.norm(arr, axis=-1, keepdims=True)
    norms = np.where(norms <= 1e-12, 1.0, norms)
    return (arr / norms).astype(np.float32)


def compute_mean_file_vec(chunk_vecs: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    if chunk_vecs.ndim == 1:
        return l2_normalize(chunk_vecs)
    mean_vec = np.mean(chunk_vecs.astype(np.float64), axis=0).astype(np.float32)
    return l2_normalize(mean_vec)


def slice_audio_windows(
    samples: npt.NDArray[np.float32],
    sample_rate: int = 48000,
    window_s: float = 10.0,
    hop_s: float = 5.0,
    max_chunks_per_file: int = 120,
) -> list[AudioWindow]:
    if sample_rate <= 0:
        raise ValueError(f"sample_rate must be positive, got {sample_rate}")
    win_samples = max(1, int(round(window_s * sample_rate)))
    hop_samples = max(1, int(round(hop_s * sample_rate)))
    total_samples = int(samples.shape[0])

    if total_samples == 0:
        zeros = np.zeros(win_samples, dtype=np.float32)
        return [AudioWindow(chunk_idx=0, start_s=0.0, end_s=0.0, samples=zeros)]

    if total_samples <= win_samples:
        dur_s = float(total_samples) / float(sample_rate)
        return [
            AudioWindow(
                chunk_idx=0,
                start_s=0.0,
                end_s=dur_s,
                samples=samples.astype(np.float32, copy=False),
            )
        ]

    raw_n_chunks = 1 + math.ceil((total_samples - win_samples) / hop_samples)
    if max_chunks_per_file > 1 and raw_n_chunks > max_chunks_per_file:
        starts_f = np.linspace(0, total_samples - win_samples, max_chunks_per_file)
        starts = [int(round(float(s))) for s in starts_f]
    elif max_chunks_per_file == 1:
        starts = [0]
    else:
        starts = list(range(0, total_samples - win_samples, hop_samples))
        last_start = total_samples - win_samples
        if not starts or starts[-1] != last_start:
            starts.append(last_start)

    windows: list[AudioWindow] = []
    for idx, s_idx in enumerate(starts):
        e_idx = min(total_samples, s_idx + win_samples)
        seg = samples[s_idx:e_idx].astype(np.float32, copy=False)
        windows.append(
            AudioWindow(
                chunk_idx=idx,
                start_s=float(s_idx) / float(sample_rate),
                end_s=float(e_idx) / float(sample_rate),
                samples=seg,
            )
        )
    return windows


def _extract_embedding_tensor(output: Any) -> torch.Tensor:
    if isinstance(output, torch.Tensor):
        return output
    if hasattr(output, "pooler_output") and output.pooler_output is not None:
        return output.pooler_output
    if hasattr(output, "audio_embeds") and output.audio_embeds is not None:
        return output.audio_embeds
    if hasattr(output, "text_embeds") and output.text_embeds is not None:
        return output.text_embeds
    if (
        isinstance(output, (tuple, list))
        and len(output) > 0
        and isinstance(output[0], torch.Tensor)
    ):
        return output[0]
    raise TypeError(f"Unsupported model output type: {type(output)}")


def _arch_supported(capability: tuple[int, int], arch_list: Sequence[str]) -> bool:
    """Whether a torch build with `arch_list` has kernels for a GPU of `capability`.

    A cubin for sm_XY runs on the same major version with an equal or higher minor;
    PTX (compute_XY) is JIT-compiled for any equal or newer GPU.
    """
    major, minor = capability
    for arch in arch_list:
        kind, _, num = arch.partition("_")
        if not num.isdigit() or len(num) < 2:
            continue
        a_major, a_minor = int(num[:-1]), int(num[-1])
        if kind == "sm" and a_major == major and a_minor <= minor:
            return True
        if kind == "compute" and (a_major, a_minor) <= (major, minor):
            return True
    return False


def _cuda_unusable_reason() -> str | None:
    """Why CUDA can't run CLAP on this machine, or None when it can."""
    try:
        capability = torch.cuda.get_device_capability(0)
        name = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001 - any driver/runtime failure means "not usable"
        return f"CUDA device query failed: {exc}"
    arch_list = torch.cuda.get_arch_list()
    if arch_list and not _arch_supported(capability, arch_list):
        return (
            f"{name} (sm_{capability[0]}{capability[1]}) is not supported by this PyTorch "
            f"build ({torch.__version__}, kernels for {', '.join(arch_list)})"
        )
    try:
        (torch.ones(1, device="cuda") + 1).item()
    except Exception as exc:  # noqa: BLE001
        return f"CUDA smoke test failed on {name}: {str(exc).splitlines()[0]}"
    return None


def resolve_device(requested: str | None = None) -> str:
    """Pick the device for CLAP: the requested one, else CUDA when it can actually run, else CPU."""
    if requested:
        return requested
    if not torch.cuda.is_available():
        return "cpu"
    reason = _cuda_unusable_reason()
    if reason is not None:
        logger.warning("Running CLAP on the CPU (slower): %s", reason)
        return "cpu"
    return "cuda"


class ClapEmbedder:
    """CLAP model wrapper enforcing deterministic 48 kHz window preprocessing."""

    def __init__(
        self,
        model_id: str = "laion/larger_clap_general",
        precision: Literal["fp16", "fp32"] = "fp16",
        window_s: float = 10.0,
        hop_s: float = 5.0,
        max_chunks_per_file: int = 120,
        batch_size: int = 32,
        device: str | None = None,
        query_cache_size: int = 256,
    ) -> None:
        self._model_id = model_id
        self.precision = precision
        self.window_s = window_s
        self.hop_s = hop_s
        self.max_chunks_per_file = max_chunks_per_file
        self.batch_size = max(1, batch_size)
        self.device = resolve_device(device)
        self.dtype = (
            torch.float16
            if (precision == "fp16" and self.device.startswith("cuda"))
            else torch.float32
        )

        self.processor = ClapProcessor.from_pretrained(model_id)
        self.feature_extractor = self.processor.feature_extractor
        self.tokenizer = self.processor.tokenizer

        self._assert_preprocessor_config()

        loaded_model: Any = ClapModel.from_pretrained(model_id, torch_dtype=self.dtype)
        loaded_model.eval()
        loaded_model.to(self.device)
        self.model: Any = loaded_model

        proj_dim = getattr(self.model.config, "projection_dim", 512)
        self._embedding_dim = int(proj_dim)

        self._query_cache: OrderedDict[str, npt.NDArray[np.float32]] = OrderedDict()
        self._query_cache_size = max(16, query_cache_size)
        self._cache_lock = threading.Lock()

    def _assert_preprocessor_config(self) -> None:
        sr = int(getattr(self.feature_extractor, "sampling_rate", 0))
        max_len_s = float(getattr(self.feature_extractor, "max_length_s", 0.0))
        nb_max = int(getattr(self.feature_extractor, "nb_max_samples", 0))
        if sr != 48000:
            raise AssertionError(f"Expected CLAP sampling_rate=48000, got {sr}")
        if nb_max != int(round(sr * max_len_s)):
            raise AssertionError(
                f"Inconsistent CLAP feature extractor nb_max_samples={nb_max} vs {sr}*{max_len_s}"
            )
        if self.window_s > max_len_s:
            raise ValueError(
                f"Configured window_s={self.window_s} exceeds model max_length_s={max_len_s}, "
                "which would trigger non-deterministic truncation."
            )

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def embedding_dim(self) -> int:
        return self._embedding_dim

    @property
    def max_samples(self) -> int:
        return int(self.feature_extractor.nb_max_samples)

    def embed_windows(self, windows: Sequence[npt.NDArray[np.float32]]) -> npt.NDArray[np.float32]:
        if not windows:
            return np.zeros((0, self._embedding_dim), dtype=np.float32)

        max_s = self.max_samples
        clipped: list[npt.NDArray[np.float32]] = []
        for w in windows:
            arr = np.asarray(w, dtype=np.float32)
            if arr.ndim != 1:
                arr = arr.reshape(-1)
            if arr.shape[0] > max_s:
                arr = arr[:max_s]
            elif arr.shape[0] == 0:
                arr = np.zeros(480, dtype=np.float32)
            clipped.append(arr)

        all_vecs: list[npt.NDArray[np.float32]] = []
        with torch.inference_mode():
            for start in range(0, len(clipped), self.batch_size):
                batch_wavs = clipped[start : start + self.batch_size]
                inputs = self.feature_extractor(
                    raw_speech=batch_wavs,
                    sampling_rate=48000,
                    padding="repeatpad",
                    truncation="rand_trunc",
                    return_tensors="pt",
                )
                input_features = inputs["input_features"].to(device=self.device, dtype=self.dtype)
                is_longer = inputs.get("is_longer")
                if is_longer is not None:
                    is_longer = is_longer.to(device=self.device)
                raw_out = self.model.get_audio_features(
                    input_features=input_features,
                    is_longer=is_longer,
                )
                tensor_out = _extract_embedding_tensor(raw_out)
                vecs = tensor_out.detach().to(dtype=torch.float32, device="cpu").numpy()
                all_vecs.append(l2_normalize(vecs))

        return np.vstack(all_vecs).astype(np.float32)

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
        if not queries:
            return np.zeros((0, self._embedding_dim), dtype=np.float32)
        cleaned = [q.strip() or "sound" for q in queries]
        with torch.inference_mode():
            tok_inputs = self.tokenizer(
                cleaned,
                padding=True,
                truncation=True,
                return_tensors="pt",
            )
            tok_inputs = {k: v.to(self.device) for k, v in tok_inputs.items()}
            raw_out = self.model.get_text_features(**tok_inputs)
            tensor_out = _extract_embedding_tensor(raw_out)
            vecs = tensor_out.detach().to(dtype=torch.float32, device="cpu").numpy()
        return l2_normalize(vecs)

    def embed_text(self, query: str) -> npt.NDArray[np.float32]:
        key = query.strip()
        with self._cache_lock:
            if key in self._query_cache:
                self._query_cache.move_to_end(key)
                return self._query_cache[key]
        vec = self.embed_texts([key])[0]
        with self._cache_lock:
            self._query_cache[key] = vec
            self._query_cache.move_to_end(key)
            if len(self._query_cache) > self._query_cache_size:
                self._query_cache.popitem(last=False)
        return vec
