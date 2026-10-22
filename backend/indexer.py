"""Multi-threaded CPU decode + GPU batched embedding indexer pipeline."""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import torch

from .config import Config
from .decode import DecodeError, decode_file
from .embed import AudioWindow, EmbedderProtocol, compute_mean_file_vec, slice_audio_windows
from .features import AcousticFeatures, compute_waveform_peaks, extract_features
from .metadata import extract_metadata
from .scan import ScannedFile, diff_manifest, normalize_path, walk_roots
from .store import ChunkRecord, FileRecord, SfxStore


@dataclass
class DecodedWorkItem:
    scanned: ScannedFile
    format_name: str
    sample_rate: int
    channels: int
    features: AcousticFeatures
    tags_json: str
    search_text: str
    windows: list[AudioWindow]
    peaks: list[float] | None = None
    error: str | None = None


@dataclass
class IndexStats:
    scanned_count: int = 0
    skipped_unchanged: int = 0
    to_index_count: int = 0
    indexed_ok: int = 0
    indexed_errors: int = 0
    marked_missing: int = 0
    total_chunks: int = 0
    total_audio_seconds: float = 0.0
    elapsed_seconds: float = 0.0
    files_per_min: float = 0.0
    audio_hours_per_min: float = 0.0
    audio_hours_per_hour: float = 0.0
    gpu_memory_mb: float = 0.0


def _decode_worker_fn(
    item: ScannedFile,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    window_s: float,
    hop_s: float,
    max_chunks_per_file: int,
) -> DecodedWorkItem:
    try:
        decoded = decode_file(
            item.path,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            target_sr=48000,
        )
        feats = extract_features(decoded.samples, sample_rate=decoded.sample_rate)
        tags_json, search_text = extract_metadata(
            path=item.path,
            root=item.root,
            probe_tags=decoded.probe.tags,
        )
        windows = slice_audio_windows(
            samples=decoded.samples,
            sample_rate=decoded.sample_rate,
            window_s=window_s,
            hop_s=hop_s,
            max_chunks_per_file=max_chunks_per_file,
        )
        peaks = compute_waveform_peaks(decoded.samples, num_bins=200)
        return DecodedWorkItem(
            scanned=item,
            format_name=decoded.probe.format_name,
            sample_rate=decoded.probe.sample_rate,
            channels=decoded.probe.channels,
            features=feats,
            tags_json=tags_json,
            search_text=search_text,
            windows=windows,
            peaks=peaks,
            error=None,
        )
    except DecodeError as exc:
        tags_json, search_text = extract_metadata(path=item.path, root=item.root, probe_tags={})
        return DecodedWorkItem(
            scanned=item,
            format_name=item.ext,
            sample_rate=0,
            channels=0,
            features=AcousticFeatures(
                duration_s=0.0, lufs_integrated=None, peak_dbfs=-120.0, loop_score=None
            ),
            tags_json=tags_json,
            search_text=search_text,
            windows=[],
            peaks=None,
            error=str(exc),
        )
    except Exception as exc:
        tags_json, search_text = extract_metadata(path=item.path, root=item.root, probe_tags={})
        return DecodedWorkItem(
            scanned=item,
            format_name=item.ext,
            sample_rate=0,
            channels=0,
            features=AcousticFeatures(
                duration_s=0.0, lufs_integrated=None, peak_dbfs=-120.0, loop_score=None
            ),
            tags_json=tags_json,
            search_text=search_text,
            windows=[],
            peaks=None,
            error=f"Unexpected decode error: {exc}",
        )


def _get_gpu_memory_mb() -> float:
    if not torch.cuda.is_available():
        return 0.0
    try:
        alloc = torch.cuda.max_memory_allocated()
        reserved = torch.cuda.max_memory_reserved()
        return round(float(max(alloc, reserved)) / (1024.0 * 1024.0), 1)
    except Exception:
        return 0.0


def run_indexer(
    config: Config,
    store: SfxStore,
    embedder: EmbedderProtocol,
    roots: Sequence[str | Path] | None = None,
    limit: int | None = None,
    reindex: bool = False,
    progress_callback: Callable[[IndexStats], None] | None = None,
) -> IndexStats:
    t0 = time.perf_counter()
    target_roots = [normalize_path(r) for r in (roots or config.library.roots)]

    store.verify_or_init_tables(
        embedding_model=embedder.model_id,
        embedding_dim=embedder.embedding_dim,
        reset=False,
    )

    scanned_files = walk_roots(
        roots=target_roots,
        extensions=config.library.extensions,
        limit=limit,
    )
    existing_manifest = store.load_manifest(roots=target_roots if limit is None else None)
    diff = diff_manifest(
        scanned=scanned_files,
        existing=existing_manifest,
        reindex=reindex,
        mark_missing=(limit is None),
    )

    if diff.missing_ids:
        store.mark_missing(diff.missing_ids)

    stats = IndexStats(
        scanned_count=len(scanned_files),
        skipped_unchanged=len(diff.unchanged_ids),
        to_index_count=len(diff.to_index),
        marked_missing=len(diff.missing_ids),
    )

    if not diff.to_index:
        stats.elapsed_seconds = round(time.perf_counter() - t0, 3)
        stats.gpu_memory_mb = _get_gpu_memory_mb()
        if progress_callback:
            progress_callback(stats)
        return stats

    peaks_dir = config.peaks_dir
    peaks_dir.mkdir(parents=True, exist_ok=True)

    workers = max(1, config.indexing.decode_workers)
    max_queue_size = max(4, workers * 3)
    work_queue: queue.Queue[DecodedWorkItem | None] = queue.Queue(maxsize=max_queue_size)
    stop_event = threading.Event()
    consumer_done = threading.Event()

    def _resolve_future(fut: Future[DecodedWorkItem], item: ScannedFile) -> DecodedWorkItem:
        try:
            return fut.result()
        except Exception as exc:
            try:
                tags_json, search_text = extract_metadata(
                    path=item.path, root=item.root, probe_tags={}
                )
            except Exception:
                tags_json, search_text = "{}", ""
            return DecodedWorkItem(
                scanned=item,
                format_name=item.ext,
                sample_rate=0,
                channels=0,
                features=AcousticFeatures(
                    duration_s=0.0, lufs_integrated=None, peak_dbfs=-120.0, loop_score=None
                ),
                tags_json=tags_json,
                search_text=search_text,
                windows=[],
                peaks=None,
                error=f"Decode worker failed: {exc}",
            )

    def _producer() -> None:
        def _safe_put(value: DecodedWorkItem | None) -> bool:
            while not stop_event.is_set():
                try:
                    work_queue.put(value, timeout=0.25)
                    return True
                except queue.Full:
                    continue
            return False

        def _put_sentinel() -> None:
            # Block until a live consumer drains a slot so no queued work is
            # lost; only evict once the consumer is gone.
            while not consumer_done.is_set():
                try:
                    work_queue.put(None, timeout=0.1)
                    return
                except queue.Full:
                    continue
            try:
                work_queue.put_nowait(None)
            except queue.Full:
                try:
                    work_queue.get_nowait()
                    work_queue.put_nowait(None)
                except (queue.Empty, queue.Full):
                    pass

        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                in_flight: list[tuple[ScannedFile, Future[DecodedWorkItem]]] = []
                for item in diff.to_index:
                    if stop_event.is_set():
                        break
                    while len(in_flight) >= max_queue_size and not stop_event.is_set():
                        done_item, done_fut = in_flight.pop(0)
                        if not _safe_put(_resolve_future(done_fut, done_item)):
                            break
                    if stop_event.is_set():
                        break
                    fut = pool.submit(
                        _decode_worker_fn,
                        item,
                        config.paths.ffmpeg,
                        config.paths.ffprobe,
                        config.embedding.window_s,
                        config.embedding.hop_s,
                        config.embedding.max_chunks_per_file,
                    )
                    in_flight.append((item, fut))

                for pending_item, fut in in_flight:
                    if stop_event.is_set():
                        break
                    if not _safe_put(_resolve_future(fut, pending_item)):
                        break
        finally:
            _put_sentinel()

    producer_thread = threading.Thread(target=_producer, daemon=True)
    producer_thread.start()

    pending_files: list[FileRecord] = []
    pending_chunks: list[ChunkRecord] = []
    zero_vec = [0.0] * embedder.embedding_dim
    commit_every = max(1, config.indexing.commit_every_files)
    committed_first_ok = False

    try:
        while True:
            decoded_item = work_queue.get()
            if decoded_item is None:
                break

            now_utc = datetime.now(UTC)
            sf = decoded_item.scanned

            if decoded_item.error is not None:
                f_rec = FileRecord(
                    file_id=sf.file_id,
                    path=sf.path,
                    root=sf.root,
                    size_bytes=sf.size_bytes,
                    mtime_ns=sf.mtime_ns,
                    format=decoded_item.format_name,
                    duration_s=0.0,
                    sample_rate=0,
                    channels=0,
                    lufs_integrated=None,
                    peak_dbfs=-120.0,
                    loop_score=None,
                    tags_json=decoded_item.tags_json,
                    search_text=decoded_item.search_text,
                    file_vec=zero_vec,
                    embedding_model=embedder.model_id,
                    status="error",
                    error=decoded_item.error,
                    indexed_at=now_utc,
                )
                pending_files.append(f_rec)
                stats.indexed_errors += 1
            else:
                win_arrays = [w.samples for w in decoded_item.windows]
                chunk_vecs_np = embedder.embed_windows(win_arrays)
                file_vec_np = compute_mean_file_vec(chunk_vecs_np)

                for w, cvec in zip(decoded_item.windows, chunk_vecs_np, strict=True):
                    pending_chunks.append(
                        ChunkRecord(
                            file_id=sf.file_id,
                            chunk_idx=w.chunk_idx,
                            start_s=w.start_s,
                            end_s=w.end_s,
                            vec=np.asarray(cvec, dtype=np.float32),
                        )
                    )

                f_rec = FileRecord(
                    file_id=sf.file_id,
                    path=sf.path,
                    root=sf.root,
                    size_bytes=sf.size_bytes,
                    mtime_ns=sf.mtime_ns,
                    format=decoded_item.format_name,
                    duration_s=decoded_item.features.duration_s,
                    sample_rate=decoded_item.sample_rate,
                    channels=decoded_item.channels,
                    lufs_integrated=decoded_item.features.lufs_integrated,
                    peak_dbfs=decoded_item.features.peak_dbfs,
                    loop_score=decoded_item.features.loop_score,
                    tags_json=decoded_item.tags_json,
                    search_text=decoded_item.search_text,
                    file_vec=[float(x) for x in file_vec_np],
                    embedding_model=embedder.model_id,
                    status="ok",
                    error=None,
                    indexed_at=now_utc,
                )
                pending_files.append(f_rec)

                if decoded_item.peaks is not None:
                    peak_file = peaks_dir / f"{sf.file_id}.json"
                    try:
                        peak_tmp = peaks_dir / f"{sf.file_id}.json.tmp"
                        peak_tmp.write_text(
                            json.dumps(
                                {
                                    "file_id": sf.file_id,
                                    "mtime_ns": sf.mtime_ns,
                                    "duration_s": round(decoded_item.features.duration_s, 4),
                                    "peaks": decoded_item.peaks,
                                }
                            ),
                            encoding="utf-8",
                        )
                        peak_tmp.replace(peak_file)
                    except OSError:
                        pass

                stats.indexed_ok += 1
                stats.total_chunks += len(decoded_item.windows)
                stats.total_audio_seconds += decoded_item.features.duration_s

            elapsed = max(1e-6, time.perf_counter() - t0)
            done_count = stats.indexed_ok + stats.indexed_errors
            stats.elapsed_seconds = round(elapsed, 3)
            stats.files_per_min = round((done_count / elapsed) * 60.0, 2)
            stats.audio_hours_per_min = round(
                ((stats.total_audio_seconds / 3600.0) / elapsed) * 60.0, 3
            )
            stats.audio_hours_per_hour = round(
                (stats.total_audio_seconds / 3600.0) / (elapsed / 3600.0), 2
            )
            stats.gpu_memory_mb = _get_gpu_memory_mb()

            should_commit_first = not committed_first_ok and stats.indexed_ok >= 1
            if should_commit_first or len(pending_files) >= commit_every:
                store.upsert_batch(pending_files, pending_chunks, rebuild_fts=False)
                pending_files.clear()
                pending_chunks.clear()
                if stats.indexed_ok >= 1:
                    committed_first_ok = True

            if progress_callback:
                try:
                    progress_callback(stats)
                except Exception:
                    pass

        if pending_files or pending_chunks:
            store.upsert_batch(pending_files, pending_chunks, rebuild_fts=True)
            pending_files.clear()
            pending_chunks.clear()
        else:
            store.rebuild_fts_index()
    finally:
        stop_event.set()
        consumer_done.set()
        producer_thread.join(timeout=15.0)

    store.create_vector_indices(embedder.embedding_dim)
    store.optimize_tables()

    elapsed = max(1e-6, time.perf_counter() - t0)
    done_count = stats.indexed_ok + stats.indexed_errors
    stats.elapsed_seconds = round(elapsed, 3)
    stats.files_per_min = round((done_count / elapsed) * 60.0, 2)
    stats.audio_hours_per_min = round(((stats.total_audio_seconds / 3600.0) / elapsed) * 60.0, 3)
    stats.audio_hours_per_hour = round((stats.total_audio_seconds / 3600.0) / (elapsed / 3600.0), 2)
    stats.gpu_memory_mb = _get_gpu_memory_mb()
    return stats
