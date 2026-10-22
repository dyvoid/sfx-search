"""FastAPI HTTP server for sfx-search."""

from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Config, load_config
from .decode import decode_audio_pcm
from .embed import EmbedderProtocol
from .features import compute_waveform_peaks
from .indexer import IndexStats, run_indexer
from .scan import normalize_path, to_os_path
from .search import SearchEngine, SearchMode
from .store import SearchFilters, SfxStore, UserDataRecord

NATIVE_BROWSER_EXTS: set[str] = {".mp3", ".ogg", ".opus", ".m4a", ".aac", ".flac"}


class SearchRequestBody(BaseModel):
    query: str = ""
    k: int = 30
    mode: SearchMode = "hybrid"
    min_duration: float | None = None
    max_duration: float | None = None
    min_lufs: float | None = None
    max_lufs: float | None = None
    sample_rates: list[int] | None = None
    channels: list[int] | None = None
    formats: list[str] | None = None
    roots: list[str] | None = None
    favorites_only: bool = False
    user_tag: str | None = None
    min_loop_score: float | None = None


class UserDataUpdateBody(BaseModel):
    favorite: bool | None = None
    user_tags: list[str] | None = None
    note: str | None = None


class BatchSearchBody(BaseModel):
    queries: list[str] = Field(default_factory=list)
    k: int = 20
    mode: SearchMode = "hybrid"


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
                with self._lock:
                    self._latest_stats = st

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
    tmp_path = transcode_dir / f"{fid}_{mtime_ns}.tmp.wav"
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
        raise HTTPException(status_code=500, detail=f"Audio transcode failed: {stderr_txt}")
    tmp_path.replace(cached_path)
    return cached_path


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
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )

    app.state.config = cfg
    app.state.store = st
    app.state.engine = engine
    app.state.index_mgr = index_mgr

    @app.get("/api/library")
    def api_get_library() -> dict[str, Any]:
        stats = st.get_library_stats()
        configured_roots = [normalize_path(r) for r in cfg.library.roots if str(r).strip()]
        return {
            "roots": configured_roots,
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
        k: int = Query(30, ge=1, le=500),
        mode: SearchMode = Query("hybrid"),
        min_dur: float | None = Query(None),
        max_dur: float | None = Query(None),
        min_lufs: float | None = Query(None),
        max_lufs: float | None = Query(None),
        sample_rate: int | None = Query(None),
        channels: int | None = Query(None),
        format: str | None = Query(None),
        root: str | None = Query(None),
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
            favorites_only=favorites,
            user_tag=user_tag,
            min_loop_score=min_loop,
        )
        hits = engine.search(query=eff_q, k=k, mode=mode, filters=filters)
        return {
            "query": eff_q,
            "mode": mode,
            "count": len(hits),
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
            favorites_only=body.favorites_only,
            user_tag=body.user_tag,
            min_loop_score=body.min_loop_score,
        )
        hits = engine.search(query=body.query, k=body.k, mode=body.mode, filters=filters)
        return {
            "query": body.query,
            "mode": body.mode,
            "count": len(hits),
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
        suffix = Path(file.filename or "upload.wav").suffix or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = Path(tmp.name)
        try:
            hits = engine.find_similar_from_audio_file(tmp_path, k=k)
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Failed to process uploaded audio: {exc}"
            ) from exc
        finally:
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
    def api_stream_audio(file_id: str, request: Request) -> Response:
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")

        if _needs_transcode(f_row):
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
            peaks = [0.0] * bins

        payload = {
            "file_id": fid,
            "duration_s": round(float(f_row.get("duration_s") or 0.0), 4),
            "peaks": peaks,
        }
        try:
            cache_file.write_text(json.dumps(payload), encoding="utf-8")
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
        if sys.platform == "win32":
            subprocess.Popen(["explorer.exe", f"/select,{win_path}"])
        return {"revealed": True, "path": raw_path}

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

    web_dist = Path(__file__).resolve().parent.parent / "web" / "dist"
    if web_dist.is_dir():
        assets_dir = web_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_spa(full_path: str) -> Response:
            candidate = web_dist / full_path
            if full_path and candidate.is_file():
                return FileResponse(str(candidate))
            index_html = web_dist / "index.html"
            if index_html.is_file():
                return FileResponse(str(index_html))
            raise HTTPException(status_code=404, detail="Not found")

    return app
