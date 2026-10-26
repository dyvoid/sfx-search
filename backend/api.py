"""FastAPI HTTP server for sfx-search."""

from __future__ import annotations

import dataclasses
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import soundfile as sf
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Config, load_config
from .decode import decode_audio_pcm
from .embed import EmbedderProtocol
from .features import compute_waveform_peaks
from .indexer import IndexStats, index_single_file, run_indexer
from .scan import compute_file_id, normalize_path, to_os_path
from .search import SearchEngine, SearchMode, SortMode
from .store import ModelMismatchError, SearchFilters, SfxStore, UserDataRecord

NATIVE_BROWSER_EXTS: set[str] = {".mp3", ".ogg", ".opus", ".m4a", ".aac", ".flac"}


class SearchRequestBody(BaseModel):
    query: str = ""
    k: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)
    mode: SearchMode = "hybrid"
    sort: SortMode = "relevance"
    min_duration: float | None = None
    max_duration: float | None = None
    min_lufs: float | None = None
    max_lufs: float | None = None
    sample_rates: list[int] | None = None
    channels: list[int] | None = None
    formats: list[str] | None = None
    roots: list[str] | None = None
    folders: list[str] | None = None
    favorites_only: bool = False
    user_tag: str | None = None
    min_loop_score: float | None = None


class UserDataUpdateBody(BaseModel):
    favorite: bool | None = None
    user_tags: list[str] | None = None
    note: str | None = None


class RootAddBody(BaseModel):
    path: str


class RootRemoveBody(BaseModel):
    path: str
    remove_indexed_files: bool = True


class RescanBody(BaseModel):
    reindex: bool = False


class BackgroundIndexManager:
    """Manages asynchronous background scanning and indexing for the Web UI."""

    def __init__(self, config: Config, store: SfxStore, engine: SearchEngine) -> None:
        self.config = config
        self.store = store
        self.engine = engine
        self._lock = threading.Lock()
        self._state: str = "idle"
        self._last_error: str | None = None
        self._latest_stats: IndexStats = IndexStats()
        self._pending_rescan: bool = False
        self._pending_reindex: bool = False
        self._thread: threading.Thread | None = None

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            st = self._latest_stats
            done = st.indexed_ok + st.indexed_errors
            total = st.to_index_count
            rem = max(0, total - done)
            eta_s = (rem / (st.files_per_min / 60.0)) if st.files_per_min > 0 else 0.0
            return {
                "state": self._state,
                "error": self._last_error,
                "scanned_count": st.scanned_count,
                "skipped_unchanged": st.skipped_unchanged,
                "to_index_count": total,
                "indexed_ok": st.indexed_ok,
                "indexed_errors": st.indexed_errors,
                "marked_missing": st.marked_missing,
                "total_chunks": st.total_chunks,
                "elapsed_seconds": st.elapsed_seconds,
                "files_per_min": st.files_per_min,
                "audio_hours_per_hour": st.audio_hours_per_hour,
                "gpu_memory_mb": st.gpu_memory_mb,
                "eta_seconds": round(eta_s, 1),
            }

    def trigger_scan(self, reindex: bool = False) -> None:
        with self._lock:
            if self._state == "running":
                self._pending_rescan = True
                if reindex:
                    self._pending_reindex = True
                return
            self._state = "running"
            self._last_error = None
            self._latest_stats = IndexStats()
            self._pending_rescan = False
            self._pending_reindex = False
            self._thread = threading.Thread(
                target=self._worker_loop,
                args=(reindex,),
                daemon=True,
            )
            self._thread.start()

    def _worker_loop(self, initial_reindex: bool) -> None:
        reindex = initial_reindex
        while True:
            roots = list(self.config.library.roots)
            if not roots:
                with self._lock:
                    self._state = "idle"
                return

            def _on_progress(st: IndexStats) -> None:
                # Snapshot: the indexer thread keeps mutating `st` after the call.
                with self._lock:
                    self._latest_stats = dataclasses.replace(st)

            try:
                final_stats = run_indexer(
                    config=self.config,
                    store=self.store,
                    embedder=self.engine.embedder,
                    roots=roots,
                    reindex=reindex,
                    progress_callback=_on_progress,
                )
                with self._lock:
                    self._latest_stats = final_stats
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
                    self._state = "error"
                return

            with self._lock:
                if self._pending_rescan:
                    self._pending_rescan = False
                    reindex = self._pending_reindex
                    self._pending_reindex = False
                    self._latest_stats = IndexStats()
                    continue
                self._state = "idle"
                return


def _pick_folder_native() -> str | None:
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "folder = filedialog.askdirectory(title='Select SFX Library Folder')\n"
        "root.destroy()\n"
        "print(folder or '')\n"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=120.0,
            check=False,
        )
        chosen = proc.stdout.strip()
        return normalize_path(chosen) if chosen else None
    except Exception:
        return None


def _needs_transcode(file_row: dict[str, Any]) -> bool:
    path_str = str(file_row.get("path") or "")
    ext = Path(path_str).suffix.lower()
    fmt = str(file_row.get("format") or "").lower()
    channels = int(file_row.get("channels") or 1)

    if ext in (".aif", ".aiff", ".wma"):
        return True
    if ext == ".wav":
        if channels > 2:
            return True
        if "pcm_s24" in fmt or "pcm_s32" in fmt or "pcm_f64" in fmt or "adpcm" in fmt:
            return True
        return False
    if ext in NATIVE_BROWSER_EXTS:
        return channels > 2
    return True


def _ensure_transcoded_wav(
    file_row: dict[str, Any],
    transcode_dir: Path,
    ffmpeg_bin: str = "ffmpeg",
) -> Path:
    transcode_dir.mkdir(parents=True, exist_ok=True)
    fid = str(file_row["file_id"])
    mtime_ns = int(file_row.get("mtime_ns") or 0)
    cached_path = transcode_dir / f"{fid}_{mtime_ns}.wav"
    if cached_path.is_file() and cached_path.stat().st_size > 44:
        return cached_path

    src_os = to_os_path(str(file_row["path"]))
    out_channels = min(2, max(1, int(file_row.get("channels") or 1)))
    tmp_path = transcode_dir / f"{fid}_{mtime_ns}.{os.getpid()}_{threading.get_ident()}.tmp.wav"
    cmd = [
        ffmpeg_bin,
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        src_os,
        "-vn",
        "-ac",
        str(out_channels),
        "-ar",
        "48000",
        "-acodec",
        "pcm_s16le",
        str(tmp_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=120.0, check=False)
    if proc.returncode != 0 or not tmp_path.is_file():
        stderr_txt = proc.stderr.decode("utf-8", errors="replace").strip()
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Audio transcode failed: {stderr_txt}")
    try:
        tmp_path.replace(cached_path)
    except OSError:
        # Another request may be streaming cached_path; serve it if valid.
        if not (cached_path.is_file() and cached_path.stat().st_size > 44):
            raise
    finally:
        tmp_path.unlink(missing_ok=True)
    _prune_transcode_cache(transcode_dir)
    return cached_path


def _prune_transcode_cache(transcode_dir: Path, max_files: int = 256) -> None:
    try:
        now = time.time()
        wavs: list[Path] = []
        for p in transcode_dir.iterdir():
            if p.suffix == ".tmp" or p.name.endswith(".tmp.wav"):
                try:
                    if now - p.stat().st_mtime > 600:
                        p.unlink(missing_ok=True)
                except OSError:
                    pass
                continue
            if p.suffix == ".wav":
                wavs.append(p)
        if len(wavs) > max_files:
            wavs.sort(key=lambda p: p.stat().st_mtime)
            for p in wavs[: len(wavs) - max_files]:
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass
    except OSError:
        pass


def _iter_file_range(
    path: str | Path, start: int, length: int, chunk_size: int = 65536
) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _serve_file_with_range(
    request: Request,
    file_path: str | Path,
    media_type: str,
) -> Response:
    os_path = to_os_path(file_path)
    if not os.path.isfile(os_path):
        raise HTTPException(status_code=404, detail="Audio file missing on disk")

    file_size = os.path.getsize(os_path)
    range_header = request.headers.get("range") or request.headers.get("Range")
    common_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }

    if not range_header or not range_header.strip().lower().startswith("bytes="):
        return StreamingResponse(
            _iter_file_range(os_path, 0, file_size),
            status_code=200,
            media_type=media_type,
            headers={**common_headers, "Content-Length": str(file_size)},
        )

    range_spec = range_header.strip()[6:].split(",")[0].strip()
    if "-" not in range_spec:
        raise HTTPException(status_code=416, detail="Invalid Range header")

    start_str, end_str = range_spec.split("-", 1)
    try:
        if start_str == "":
            suffix_len = int(end_str)
            start = max(0, file_size - suffix_len)
            end = file_size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str else file_size - 1
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="Malformed Range values") from exc

    if start < 0 or start >= file_size or end < start:
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{file_size}"},
        )

    end = min(end, file_size - 1)
    content_length = end - start + 1
    headers = {
        **common_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    }
    return StreamingResponse(
        _iter_file_range(os_path, start, content_length),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


_WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"COM{i}" for i in range(10)}
    | {f"LPT{i}" for i in range(10)}
    | {f"{p}{d}" for p in ("COM", "LPT") for d in "\u00b9\u00b2\u00b3"}
)


def create_app(
    config: Config | None = None,
    store: SfxStore | None = None,
    embedder: EmbedderProtocol | None = None,
) -> FastAPI:
    cfg = config or load_config()
    st = store or SfxStore(cfg.db_dir)
    engine = SearchEngine(config=cfg, store=st, embedder=embedder)
    index_mgr = BackgroundIndexManager(config=cfg, store=st, engine=engine)

    app = FastAPI(title="sfx-search API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        # Other local tools (e.g. web UIs on other dev-server ports) may fetch
        # dropped audio URLs cross-origin.
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    @app.middleware("http")
    async def local_origin_guard(request: Request, call_next: Any) -> Response:
        # Browsers always send Origin on mutating requests; local tools don't.
        # Rejects browser-originated CSRF from arbitrary websites.
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            origin = request.headers.get("origin") or ""
            if origin:
                from urllib.parse import urlsplit

                try:
                    host = urlsplit(origin).hostname or ""
                except ValueError:
                    host = ""
                if host not in {"localhost", "127.0.0.1", "::1"}:
                    return JSONResponse(status_code=403, content={"detail": "Forbidden origin"})
        return await call_next(request)

    app.state.config = cfg
    app.state.store = st
    app.state.engine = engine
    app.state.index_mgr = index_mgr

    @app.exception_handler(ModelMismatchError)
    async def model_mismatch_handler(request: Request, exc: ModelMismatchError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/api/health")
    def api_health() -> dict[str, Any]:
        return {"status": "ok"}

    @app.get("/api/library")
    def api_get_library() -> dict[str, Any]:
        stats = st.get_library_stats()
        configured_roots = [normalize_path(r) for r in cfg.library.roots if str(r).strip()]
        missing_roots = [r for r in configured_roots if not os.path.isdir(to_os_path(r))]
        return {
            "roots": configured_roots,
            "missing_roots": missing_roots,
            "stats": stats,
            "indexing": index_mgr.get_status(),
        }

    @app.post("/api/library/roots")
    def api_add_library_root(body: RootAddBody) -> dict[str, Any]:
        raw = body.path.strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Folder path cannot be empty")
        norm = normalize_path(raw)
        if not os.path.isdir(to_os_path(norm)):
            raise HTTPException(status_code=400, detail=f"Folder does not exist on disk: {norm}")

        current = [normalize_path(r) for r in cfg.library.roots if str(r).strip()]
        if norm.lower() not in [c.lower() for c in current]:
            current.append(norm)
        cfg.save_library_roots(current)
        index_mgr.trigger_scan(reindex=False)

        return {
            "roots": cfg.library.roots,
            "indexing": index_mgr.get_status(),
        }

    @app.delete("/api/library/roots")
    def api_remove_library_root(body: RootRemoveBody) -> dict[str, Any]:
        if not body.path.strip():
            raise HTTPException(status_code=400, detail="Path must not be empty")
        norm = normalize_path(body.path.strip())
        current = [
            normalize_path(r)
            for r in cfg.library.roots
            if str(r).strip() and normalize_path(r).lower() != norm.lower()
        ]
        cfg.save_library_roots(current)
        removed_count = 0
        if body.remove_indexed_files:
            removed_count = st.remove_root_files(norm)
        return {
            "roots": cfg.library.roots,
            "removed_files": removed_count,
            "stats": st.get_library_stats(),
            "indexing": index_mgr.get_status(),
        }

    @app.post("/api/library/rescan")
    def api_rescan_library(body: RescanBody | None = None) -> dict[str, Any]:
        reindex = body.reindex if body is not None else False
        index_mgr.trigger_scan(reindex=reindex)
        return {
            "roots": cfg.library.roots,
            "indexing": index_mgr.get_status(),
        }

    @app.post("/api/library/pick-folder")
    def api_pick_folder() -> dict[str, Any]:
        picked = _pick_folder_native()
        return {"path": picked}

    @app.get("/api/search")
    def api_search_get(
        q: str = Query("", alias="q"),
        query: str | None = Query(None),
        k: int = Query(50, ge=1, le=500),
        offset: int = Query(0, ge=0),
        mode: SearchMode = Query("hybrid"),
        sort: SortMode = Query("relevance"),
        min_dur: float | None = Query(None),
        max_dur: float | None = Query(None),
        min_lufs: float | None = Query(None),
        max_lufs: float | None = Query(None),
        sample_rate: int | None = Query(None),
        channels: int | None = Query(None),
        format: str | None = Query(None),
        root: str | None = Query(None),
        folder: str | None = Query(None),
        favorites: bool = Query(False),
        user_tag: str | None = Query(None),
        min_loop: float | None = Query(None),
    ) -> dict[str, Any]:
        eff_q = query if query is not None else q
        filters = SearchFilters(
            min_duration=min_dur,
            max_duration=max_dur,
            min_lufs=min_lufs,
            max_lufs=max_lufs,
            sample_rates=[sample_rate] if sample_rate is not None else None,
            channels=[channels] if channels is not None else None,
            formats=[format] if format else None,
            roots=[root] if root else None,
            folders=[folder] if folder else None,
            favorites_only=favorites,
            user_tag=user_tag,
            min_loop_score=min_loop,
        )
        hits, total = engine.search_page(
            query=eff_q,
            k=k,
            offset=offset,
            mode=mode,
            sort=sort,
            filters=filters,
        )
        return {
            "query": eff_q,
            "mode": mode,
            "sort": sort,
            "offset": offset,
            "count": len(hits),
            "total": total,
            "results": [h.to_dict() for h in hits],
        }

    @app.post("/api/search")
    def api_search_post(body: SearchRequestBody) -> dict[str, Any]:
        filters = SearchFilters(
            min_duration=body.min_duration,
            max_duration=body.max_duration,
            min_lufs=body.min_lufs,
            max_lufs=body.max_lufs,
            sample_rates=body.sample_rates,
            channels=body.channels,
            formats=body.formats,
            roots=body.roots,
            folders=body.folders,
            favorites_only=body.favorites_only,
            user_tag=body.user_tag,
            min_loop_score=body.min_loop_score,
        )
        hits, total = engine.search_page(
            query=body.query,
            k=body.k,
            offset=body.offset,
            mode=body.mode,
            sort=body.sort,
            filters=filters,
        )
        return {
            "query": body.query,
            "mode": body.mode,
            "sort": body.sort,
            "offset": body.offset,
            "count": len(hits),
            "total": total,
            "results": [h.to_dict() for h in hits],
        }

    @app.get("/api/similar/{file_id}")
    def api_similar(
        file_id: str,
        k: int = Query(30, ge=1, le=500),
        chunk: int | None = Query(None),
    ) -> dict[str, Any]:
        try:
            hits = engine.find_similar(file_id_or_path=file_id, k=k, chunk_idx=chunk)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "source_file_id": file_id,
            "chunk_idx": chunk,
            "count": len(hits),
            "results": [h.to_dict() for h in hits],
        }

    @app.post("/api/similar/upload")
    async def api_similar_upload(
        file: UploadFile = File(...),
        k: int = Query(30, ge=1, le=500),
    ) -> dict[str, Any]:
        from starlette.concurrency import run_in_threadpool

        suffix = Path(file.filename or "upload.wav").suffix or ".wav"
        max_bytes = 256 * 1024 * 1024
        too_large = False
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp_path = Path(tmp.name)
                written = 0
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        too_large = True
                        break
                    tmp.write(chunk)
            if too_large:
                raise HTTPException(status_code=413, detail="Upload too large")
            hits = await run_in_threadpool(engine.find_similar_from_audio_file, tmp_path, k=k)
        except (HTTPException, ModelMismatchError):
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Failed to process uploaded audio: {exc}"
            ) from exc
        finally:
            if tmp_path is not None:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
        return {
            "source_filename": file.filename,
            "count": len(hits),
            "results": [h.to_dict() for h in hits],
        }

    @app.get("/api/files/{file_id}")
    def api_get_file(file_id: str) -> dict[str, Any]:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")
        fid = str(f_row["file_id"])
        u_map = st.get_user_data_map([fid])
        u_rec = u_map.get(fid, UserDataRecord(file_id=fid))
        chunks = st.get_chunks_for_file(fid, include_vec=False)
        try:
            tags_dict = json.loads(str(f_row.get("tags_json") or "{}"))
        except Exception:
            tags_dict = {}

        p = Path(str(f_row["path"]))
        return {
            "file_id": fid,
            "path": str(f_row["path"]),
            "filename": p.name,
            "folder": str(p.parent).replace("\\", "/"),
            "root": str(f_row.get("root") or ""),
            "size_bytes": int(f_row.get("size_bytes") or 0),
            "mtime_ns": int(f_row.get("mtime_ns") or 0),
            "format": str(f_row.get("format") or ""),
            "duration_s": round(float(f_row.get("duration_s") or 0.0), 3),
            "sample_rate": int(f_row.get("sample_rate") or 0),
            "channels": int(f_row.get("channels") or 0),
            "lufs_integrated": (
                round(float(f_row["lufs_integrated"]), 2)
                if f_row.get("lufs_integrated") is not None
                else None
            ),
            "peak_dbfs": round(float(f_row.get("peak_dbfs") or -120.0), 2),
            "loop_score": (
                round(float(f_row["loop_score"]), 3)
                if f_row.get("loop_score") is not None
                else None
            ),
            "tags": tags_dict,
            "search_text": str(f_row.get("search_text") or ""),
            "embedding_model": str(f_row.get("embedding_model") or ""),
            "status": str(f_row.get("status") or "ok"),
            "error": f_row.get("error"),
            "favorite": u_rec.favorite,
            "user_tags": u_rec.user_tags,
            "note": u_rec.note,
            "chunks": [
                {
                    "chunk_idx": int(c["chunk_idx"]),
                    "start_s": round(float(c["start_s"]), 3),
                    "end_s": round(float(c["end_s"]), 3),
                }
                for c in chunks
            ],
        }

    @app.get("/api/audio/{file_id}")
    @app.head("/api/audio/{file_id}", include_in_schema=False)
    def api_stream_audio(file_id: str, request: Request) -> Response:
        return _stream_audio(file_id, request)

    @app.get("/api/audio/{file_id}/{fname}")
    @app.head("/api/audio/{file_id}/{fname}", include_in_schema=False)
    def api_stream_audio_named(file_id: str, fname: str, request: Request) -> Response:
        return _stream_audio(file_id, request)

    def _stream_audio(file_id: str, request: Request) -> Response:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")

        if str(f_row.get("status") or "ok") != "ok" or not os.path.isfile(
            to_os_path(str(f_row["path"]))
        ):
            raise HTTPException(status_code=404, detail="Audio file missing on disk")

        if _needs_transcode(f_row):
            if request.method == "HEAD":
                # Avoid running ffmpeg just for headers; report the
                # transcode cache entry's size when it already exists.
                fid = str(f_row["file_id"])
                mtime_ns = int(f_row.get("mtime_ns") or 0)
                cached = cfg.transcode_dir / f"{fid}_{mtime_ns}.wav"
                headers = {
                    "Content-Type": "audio/wav",
                    "Accept-Ranges": "bytes",
                }
                if cached.is_file():
                    headers["Content-Length"] = str(cached.stat().st_size)
                return Response(status_code=200, headers=headers)
            target_path = _ensure_transcoded_wav(
                f_row,
                transcode_dir=cfg.transcode_dir,
                ffmpeg_bin=cfg.paths.ffmpeg,
            )
            return _serve_file_with_range(request, target_path, media_type="audio/wav")

        raw_path = str(f_row["path"])
        mime, _ = mimetypes.guess_type(raw_path)
        ext = Path(raw_path).suffix.lower()
        if ext == ".wav":
            mime = "audio/wav"
        elif ext == ".flac":
            mime = "audio/flac"
        elif ext == ".ogg" or ext == ".opus":
            mime = "audio/ogg"
        elif ext == ".mp3":
            mime = "audio/mpeg"
        elif ext == ".m4a" or ext == ".aac":
            mime = "audio/mp4"
        return _serve_file_with_range(
            request, raw_path, media_type=mime or "application/octet-stream"
        )

    @app.get("/api/peaks/{file_id}")
    def api_get_peaks(file_id: str, bins: int = Query(200, ge=32, le=2000)) -> JSONResponse:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")
        fid = str(f_row["file_id"])
        peaks_dir = cfg.peaks_dir
        peaks_dir.mkdir(parents=True, exist_ok=True)
        cache_file = peaks_dir / (f"{fid}.json" if bins == 200 else f"{fid}_{bins}.json")

        if cache_file.is_file():
            try:
                payload = json.loads(cache_file.read_text(encoding="utf-8"))
                cached_mtime = payload.get("mtime_ns")
                if cached_mtime is None or int(cached_mtime) == int(f_row.get("mtime_ns") or 0):
                    return JSONResponse(
                        content=payload,
                        headers={"Cache-Control": "public, max-age=86400"},
                    )
            except Exception:
                pass

        try:
            samples = decode_audio_pcm(
                str(f_row["path"]),
                ffmpeg_bin=cfg.paths.ffmpeg,
                target_sr=48000,
            )
            peaks = compute_waveform_peaks(samples, num_bins=bins)
        except Exception:
            return JSONResponse(
                content={
                    "file_id": fid,
                    "mtime_ns": int(f_row.get("mtime_ns") or 0),
                    "duration_s": round(float(f_row.get("duration_s") or 0.0), 4),
                    "peaks": [0.0] * bins,
                },
                headers={"Cache-Control": "no-store"},
            )

        payload = {
            "file_id": fid,
            "mtime_ns": int(f_row.get("mtime_ns") or 0),
            "duration_s": round(float(f_row.get("duration_s") or 0.0), 4),
            "peaks": peaks,
        }
        try:
            cache_tmp = cache_file.with_suffix(".json.tmp")
            cache_tmp.write_text(json.dumps(payload), encoding="utf-8")
            cache_tmp.replace(cache_file)
        except OSError:
            pass
        return JSONResponse(
            content=payload,
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @app.put("/api/files/{file_id}/user")
    def api_update_user_data(file_id: str, body: UserDataUpdateBody) -> dict[str, Any]:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")
        fid = str(f_row["file_id"])
        updated = st.set_user_data(
            file_id=fid,
            favorite=body.favorite,
            user_tags=body.user_tags,
            note=body.note,
        )
        return {
            "file_id": updated.file_id,
            "favorite": updated.favorite,
            "user_tags": updated.user_tags,
            "note": updated.note,
        }

    @app.post("/api/files/{file_id}/reveal")
    def api_reveal_file(file_id: str) -> dict[str, Any]:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")
        raw_path = str(f_row["path"])
        win_path = os.path.normpath(raw_path.replace("/", "\\"))
        if not os.path.exists(to_os_path(win_path)):
            raise HTTPException(status_code=404, detail=f"File not found on disk: {win_path}")
        if sys.platform != "win32":
            raise HTTPException(
                status_code=501, detail="Reveal in Explorer is only supported on Windows"
            )
        subprocess.Popen(["explorer.exe", "/select,", win_path])
        return {"revealed": True, "path": raw_path}

    @app.post("/api/files/{file_id}/save-edited")
    async def api_save_edited_file(
        file_id: str,
        file: UploadFile = File(...),
        suffix: str = Query(".loop"),
        name: str | None = Query(None),
        overwrite: bool = Query(False),
        copy_user_data: bool = Query(True),
    ) -> dict[str, Any]:
        from starlette.concurrency import run_in_threadpool

        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")

        source_fid = str(f_row["file_id"])
        source_path = str(f_row["path"])
        source_root = str(f_row.get("root") or "")
        src_p = Path(source_path)
        parent_dir = src_p.parent
        os_parent = to_os_path(parent_dir)
        if not os.path.isdir(os_parent):
            raise HTTPException(
                status_code=404, detail=f"Destination directory missing: {parent_dir}"
            )

        custom_name = (name or "").strip()
        if custom_name.lower().endswith(".wav"):
            custom_name = custom_name[:-4]

        if custom_name:
            safe_stem = "".join(
                ch for ch in custom_name if ch.isalnum() or ch in (".", "_", "-", " ")
            )[:120].strip(" .")
            if not safe_stem:
                raise HTTPException(status_code=400, detail="Invalid filename")
            if safe_stem.split(".")[0].strip().upper() in _WINDOWS_RESERVED_NAMES:
                safe_stem = f"_{safe_stem}"
            candidate = parent_dir / f"{safe_stem}.wav"
            if not overwrite:
                counter = 2
                while os.path.exists(to_os_path(candidate)):
                    candidate = parent_dir / f"{safe_stem}_{counter}.wav"
                    counter += 1
            target_norm = normalize_path(candidate)
        elif overwrite:
            if src_p.suffix.lower() != ".wav":
                raise HTTPException(
                    status_code=400,
                    detail="Overwrite without a name is only supported for .wav sources",
                )
            target_norm = normalize_path(src_p)
        else:
            raw_suffix = suffix.strip() or ".loop"
            safe_suffix = "".join(ch for ch in raw_suffix if ch.isalnum() or ch in (".", "_", "-"))
            if not safe_suffix:
                safe_suffix = ".loop"
            if not safe_suffix.startswith((".", "_", "-")):
                safe_suffix = f".{safe_suffix}"

            stem = src_p.stem
            # Avoid stacking .loop.loop when saving an already-looped file
            if stem.lower().endswith(safe_suffix.lower()):
                base_stem = stem
            else:
                base_stem = f"{stem}{safe_suffix}"

            candidate = parent_dir / f"{base_stem}.wav"
            counter = 2
            while os.path.exists(to_os_path(candidate)):
                candidate = parent_dir / f"{base_stem}_{counter}.wav"
                counter += 1
            target_norm = normalize_path(candidate)

        target_fid = compute_file_id(target_norm)
        u_map = st.get_user_data_map([source_fid, target_fid])
        max_bytes = 256 * 1024 * 1024
        target_existed = False
        os_target = to_os_path(target_norm)
        os_tmp = f"{os_target}.{os.getpid()}_{threading.get_ident()}.tmp"
        try:
            written = 0
            with open(os_tmp, "wb") as out_f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise HTTPException(status_code=413, detail="Edited audio file too large")
                    out_f.write(chunk)
            if written < 44:
                raise HTTPException(status_code=400, detail="Edited audio payload is empty")
            try:
                wav_info = sf.info(os_tmp)
                wav_ok = (
                    wav_info.format in ("WAV", "WAVEX")
                    and wav_info.frames > 0
                    and wav_info.samplerate > 0
                )
            except Exception:
                wav_ok = False
            if not wav_ok:
                raise HTTPException(status_code=400, detail="Edited audio is not a valid WAV file")
            target_existed = os.path.exists(os_target)
            os.replace(os_tmp, os_target)
        except HTTPException:
            try:
                if os.path.exists(os_tmp):
                    os.unlink(os_tmp)
            except OSError:
                pass
            raise
        except Exception as exc:
            try:
                if os.path.exists(os_tmp):
                    os.unlink(os_tmp)
            except OSError:
                pass
            raise HTTPException(
                status_code=500, detail=f"Failed to write edited audio file: {exc}"
            ) from exc

        try:
            f_rec = await run_in_threadpool(
                index_single_file,
                path=target_norm,
                root=source_root or str(parent_dir),
                config=cfg,
                store=st,
                embedder=engine.embedder,
            )
        except Exception as exc:
            if not overwrite:
                try:
                    os.unlink(os_target)
                except OSError:
                    pass
            raise HTTPException(
                status_code=500, detail=f"Saved file but indexing failed: {exc}"
            ) from exc

        src_u = u_map.get(source_fid, UserDataRecord(file_id=source_fid))
        if copy_user_data:
            if overwrite and target_existed and target_fid != source_fid and target_fid in u_map:
                src_u = u_map[target_fid]
            next_tags = list(src_u.user_tags)
            if "loop" not in [t.lower() for t in next_tags]:
                next_tags.append("loop")
            u_rec = st.set_user_data(
                file_id=f_rec.file_id,
                favorite=src_u.favorite,
                user_tags=next_tags,
                note=src_u.note,
            )
        else:
            u_new_map = st.get_user_data_map([f_rec.file_id])
            u_rec = u_new_map.get(f_rec.file_id, UserDataRecord(file_id=f_rec.file_id))

        try:
            tags_dict = json.loads(f_rec.tags_json or "{}")
        except Exception:
            tags_dict = {}

        p_out = Path(f_rec.path)
        hit_dict = {
            "file_id": f_rec.file_id,
            "path": f_rec.path,
            "root": f_rec.root,
            "filename": p_out.name,
            "folder": str(p_out.parent).replace("\\", "/"),
            "format": f_rec.format,
            "duration_s": round(float(f_rec.duration_s), 3),
            "sample_rate": int(f_rec.sample_rate),
            "channels": int(f_rec.channels),
            "lufs_integrated": (
                round(float(f_rec.lufs_integrated), 2)
                if f_rec.lufs_integrated is not None
                else None
            ),
            "peak_dbfs": round(float(f_rec.peak_dbfs), 2),
            "loop_score": (
                round(float(f_rec.loop_score), 3) if f_rec.loop_score is not None else None
            ),
            "tags": tags_dict,
            "search_text": f_rec.search_text,
            "best_offset_s": 0.0,
            "best_end_s": round(float(f_rec.duration_s), 3),
            "best_chunk_idx": 0,
            "clap_score": None,
            "bm25_score": None,
            "rrf_score": 1.0,
            "favorite": u_rec.favorite,
            "user_tags": u_rec.user_tags,
            "note": u_rec.note,
        }
        return {"saved": True, "hit": hit_dict}

    @app.get("/api/stats")
    def api_stats() -> dict[str, Any]:
        stats = st.get_library_stats()
        stats["configured_model"] = cfg.embedding.model_id
        stats["configured_precision"] = cfg.embedding.precision
        stats["configured_roots"] = cfg.library.roots
        stats["indexing"] = index_mgr.get_status()
        return stats

    @app.get("/api/filters")
    def api_filters() -> dict[str, Any]:
        return st.get_available_filters()

    @app.get("/api/folders")
    def api_folders() -> dict[str, Any]:
        return {"folders": st.get_folder_index()}

    web_dist_env = os.environ.get("SFXSEARCH_WEB_DIST")
    web_dist = (
        Path(web_dist_env).resolve()
        if web_dist_env
        else Path(__file__).resolve().parent.parent / "web" / "dist"
    ).resolve()
    if web_dist.is_dir():
        assets_dir = web_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_spa(full_path: str) -> Response:
            if full_path.split("/", 1)[0] == "api":
                raise HTTPException(status_code=404, detail="Not found")
            candidate = (web_dist / full_path).resolve()
            if full_path and candidate.is_relative_to(web_dist) and candidate.is_file():
                return FileResponse(str(candidate))
            index_html = web_dist / "index.html"
            if index_html.is_file():
                return FileResponse(
                    str(index_html),
                    headers={
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                        "Pragma": "no-cache",
                        "Expires": "0",
                    },
                )
            raise HTTPException(status_code=404, detail="Not found")

    return app
