"""LanceDB tables, schema management, model consistency checks, and query primitives."""

from __future__ import annotations

import math
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import lancedb
import numpy as np
import numpy.typing as npt
import pyarrow as pa
from lancedb.index import FTS

from .scan import ManifestEntry


class ModelMismatchError(RuntimeError):
    """Raised when the configured embedding model or dimension disagrees with the database."""


@dataclass
class FileRecord:
    file_id: str
    path: str
    root: str
    size_bytes: int
    mtime_ns: int
    format: str
    duration_s: float
    sample_rate: int
    channels: int
    lufs_integrated: float | None
    peak_dbfs: float
    loop_score: float | None
    tags_json: str
    search_text: str
    file_vec: list[float]
    embedding_model: str
    status: str = "ok"
    error: str | None = None
    indexed_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class ChunkRecord:
    file_id: str
    chunk_idx: int
    start_s: float
    end_s: float
    vec: npt.NDArray[np.float32] | list[float]


@dataclass
class UserDataRecord:
    file_id: str
    favorite: bool = False
    user_tags: list[str] = field(default_factory=list)
    note: str = ""


@dataclass
class SearchFilters:
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
    required_phrases: list[str] | None = None
    excluded_terms: list[str] | None = None


def _sql_escape(val: str) -> str:
    return val.replace("'", "''")


def _sql_like_escape(val: str) -> str:
    # Lance only accepts the backslash as LIKE ESCAPE char.
    return val.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def make_files_schema(embedding_dim: int, embedding_model: str) -> pa.Schema:
    return pa.schema(
        [
            pa.field("file_id", pa.string()),
            pa.field("path", pa.string()),
            pa.field("root", pa.string()),
            pa.field("size_bytes", pa.int64()),
            pa.field("mtime_ns", pa.int64()),
            pa.field("format", pa.string()),
            pa.field("duration_s", pa.float32()),
            pa.field("sample_rate", pa.int32()),
            pa.field("channels", pa.int16()),
            pa.field("lufs_integrated", pa.float32(), nullable=True),
            pa.field("peak_dbfs", pa.float32()),
            pa.field("loop_score", pa.float32(), nullable=True),
            pa.field("tags_json", pa.string()),
            pa.field("search_text", pa.string()),
            pa.field("file_vec", pa.list_(pa.float32(), embedding_dim)),
            pa.field("embedding_model", pa.string()),
            pa.field("status", pa.string()),
            pa.field("error", pa.string(), nullable=True),
            pa.field("indexed_at", pa.timestamp("us", tz="UTC")),
        ],
        metadata={
            b"embedding_model": embedding_model.encode("utf-8"),
            b"embedding_dim": str(embedding_dim).encode("utf-8"),
        },
    )


def make_chunks_schema(embedding_dim: int, embedding_model: str) -> pa.Schema:
    return pa.schema(
        [
            pa.field("file_id", pa.string()),
            pa.field("chunk_idx", pa.int32()),
            pa.field("start_s", pa.float32()),
            pa.field("end_s", pa.float32()),
            pa.field("vec", pa.list_(pa.float32(), embedding_dim)),
        ],
        metadata={
            b"embedding_model": embedding_model.encode("utf-8"),
            b"embedding_dim": str(embedding_dim).encode("utf-8"),
        },
    )


def make_user_data_schema() -> pa.Schema:
    return pa.schema(
        [
            pa.field("file_id", pa.string()),
            pa.field("favorite", pa.bool_()),
            pa.field("user_tags", pa.list_(pa.string())),
            pa.field("note", pa.string()),
        ]
    )


class SfxStore:
    """LanceDB storage wrapper for files, chunks, and user_data tables."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.mkdir(parents=True, exist_ok=True)
        self.db = lancedb.connect(str(self.db_path))
        self._write_lock = threading.RLock()
        self._fts_rebuild_attempted = False

    def table_names(self) -> set[str]:
        res: Any = self.db.list_tables()
        if hasattr(res, "tables"):
            return set(res.tables or [])
        return {str(t) for t in res}

    def has_index(self) -> bool:
        names = self.table_names()
        return "files" in names and "chunks" in names

    def get_stored_model_info(self) -> tuple[str | None, int | None]:
        if "files" not in self.table_names():
            return None, None
        tbl = self.db.open_table("files")
        meta = tbl.schema.metadata or {}
        model_bytes = meta.get(b"embedding_model")
        dim_bytes = meta.get(b"embedding_dim")
        stored_model = model_bytes.decode("utf-8") if model_bytes else None
        stored_dim = int(dim_bytes.decode("utf-8")) if dim_bytes else None

        if stored_dim is None:
            vec_field = tbl.schema.field("file_vec")
            if isinstance(vec_field.type, pa.FixedSizeListType):
                stored_dim = vec_field.type.list_size

        if stored_model is None and tbl.count_rows() > 0:
            rows = tbl.search().select(["embedding_model"]).limit(1).to_list()
            if rows and rows[0].get("embedding_model"):
                stored_model = str(rows[0]["embedding_model"])

        return stored_model, stored_dim

    def verify_or_init_tables(
        self,
        embedding_model: str,
        embedding_dim: int,
        reset: bool = False,
    ) -> None:
        names = self.table_names()
        if reset:
            for tname in ("files", "chunks"):
                if tname in names:
                    self.db.drop_table(tname)
            names = self.table_names()

        if "files" in names:
            stored_model, stored_dim = self.get_stored_model_info()
            tbl = self.db.open_table("files")
            row_count = tbl.count_rows()
            if row_count > 0 or stored_model is not None:
                if stored_model and stored_model != embedding_model:
                    raise ModelMismatchError(
                        f"Database contains embeddings from model '{stored_model}' "
                        f"but current config specifies '{embedding_model}'. "
                        "Refusing to mix models in one database. Use --reindex or a separate data_dir."
                    )
                if stored_dim and stored_dim != embedding_dim:
                    raise ModelMismatchError(
                        f"Database embedding dimension is {stored_dim} "
                        f"but model '{embedding_model}' produces {embedding_dim}-d vectors."
                    )
        else:
            self.db.create_table(
                "files",
                schema=make_files_schema(
                    embedding_dim=embedding_dim, embedding_model=embedding_model
                ),
            )

        if "chunks" not in names:
            self.db.create_table(
                "chunks",
                schema=make_chunks_schema(
                    embedding_dim=embedding_dim, embedding_model=embedding_model
                ),
            )

        if "user_data" not in names:
            self.db.create_table("user_data", schema=make_user_data_schema())

    def ensure_user_data_table(self) -> None:
        if "user_data" not in self.table_names():
            self.db.create_table("user_data", schema=make_user_data_schema())

    def load_manifest(self, roots: Sequence[str] | None = None) -> dict[str, ManifestEntry]:
        if "files" not in self.table_names():
            return {}
        tbl = self.db.open_table("files")
        if tbl.count_rows() == 0:
            return {}
        q = tbl.search().select(["file_id", "path", "root", "size_bytes", "mtime_ns", "status"])
        rows = q.limit(tbl.count_rows() + 100).to_list()
        norm_roots = {r.lower().rstrip("/") for r in roots} if roots else None
        manifest: dict[str, ManifestEntry] = {}
        for row in rows:
            if norm_roots is not None:
                row_root = str(row.get("root") or "").lower().rstrip("/")
                row_path = str(row.get("path") or "").lower()
                if row_root not in norm_roots and not any(
                    row_path.startswith(nr + "/") or row_path == nr for nr in norm_roots
                ):
                    continue
            fid = str(row["file_id"])
            manifest[fid] = ManifestEntry(
                file_id=fid,
                path=str(row["path"]),
                size_bytes=int(row["size_bytes"]),
                mtime_ns=int(row["mtime_ns"]),
                status=str(row["status"]),
            )
        return manifest

    def upsert_batch(
        self,
        files: Sequence[FileRecord],
        chunks: Sequence[ChunkRecord],
        rebuild_fts: bool = True,
    ) -> None:
        if not files and not chunks:
            return
        with self._write_lock:
            self._upsert_batch_locked(files, chunks, rebuild_fts)

    def _upsert_batch_locked(
        self,
        files: Sequence[FileRecord],
        chunks: Sequence[ChunkRecord],
        rebuild_fts: bool,
    ) -> None:
        files_tbl = self.db.open_table("files")
        chunks_tbl = self.db.open_table("chunks")

        file_ids = [f.file_id for f in files]
        if file_ids:
            self._delete_by_file_ids(files_tbl, file_ids)
            self._delete_by_file_ids(chunks_tbl, file_ids)

        # Chunks are written before files so a mid-batch crash leaves an absent
        # file row (re-indexed next run) rather than an "ok" file with no chunks.

        if files:
            file_dicts = [
                {
                    "file_id": f.file_id,
                    "path": f.path,
                    "root": f.root,
                    "size_bytes": int(f.size_bytes),
                    "mtime_ns": int(f.mtime_ns),
                    "format": f.format,
                    "duration_s": float(f.duration_s),
                    "sample_rate": int(f.sample_rate),
                    "channels": int(f.channels),
                    "lufs_integrated": (
                        float(f.lufs_integrated) if f.lufs_integrated is not None else None
                    ),
                    "peak_dbfs": float(f.peak_dbfs),
                    "loop_score": float(f.loop_score) if f.loop_score is not None else None,
                    "tags_json": f.tags_json,
                    "search_text": f.search_text,
                    "file_vec": [float(x) for x in f.file_vec],
                    "embedding_model": f.embedding_model,
                    "status": f.status,
                    "error": f.error,
                    "indexed_at": f.indexed_at,
                }
                for f in files
            ]
            files_to_add = file_dicts
        else:
            files_to_add = []

        if chunks:
            chunk_dicts = [
                {
                    "file_id": c.file_id,
                    "chunk_idx": int(c.chunk_idx),
                    "start_s": float(c.start_s),
                    "end_s": float(c.end_s),
                    "vec": np.asarray(c.vec, dtype=np.float32).tolist(),
                }
                for c in chunks
            ]
            chunks_tbl.add(chunk_dicts)

        if files_to_add:
            files_tbl.add(files_to_add)

        if rebuild_fts:
            self.rebuild_fts_index()

    def mark_missing(self, file_ids: Sequence[str]) -> None:
        if not file_ids or "files" not in self.table_names():
            return
        with self._write_lock:
            files_tbl = self.db.open_table("files")
            batch_size = 200
            for i in range(0, len(file_ids), batch_size):
                batch = file_ids[i : i + batch_size]
                quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in batch)
                files_tbl.update(where=f"file_id IN ({quoted})", values={"status": "missing"})
            if "chunks" in self.table_names():
                chunks_tbl = self.db.open_table("chunks")
                self._delete_by_file_ids(chunks_tbl, file_ids)

    def remove_root_files(self, root_path: str) -> int:
        from .scan import normalize_path

        if "files" not in self.table_names():
            return 0
        norm_root = normalize_path(root_path).lower().rstrip("/")
        files_tbl = self.db.open_table("files")
        total = files_tbl.count_rows()
        if total == 0:
            return 0
        rows = files_tbl.search().select(["file_id", "root", "path"]).limit(total + 100).to_list()
        target_ids: list[str] = []
        for r in rows:
            r_root = str(r.get("root") or "").lower().rstrip("/")
            r_path = str(r.get("path") or "").lower()
            if r_root == norm_root or r_path.startswith(norm_root + "/"):
                target_ids.append(str(r["file_id"]))
        if not target_ids:
            return 0
        with self._write_lock:
            self._delete_by_file_ids(files_tbl, target_ids)
            if "chunks" in self.table_names():
                chunks_tbl = self.db.open_table("chunks")
                self._delete_by_file_ids(chunks_tbl, target_ids)
            self.rebuild_fts_index()
        return len(target_ids)

    def rebuild_fts_index(self) -> None:
        if "files" not in self.table_names():
            return
        with self._write_lock:
            files_tbl = self.db.open_table("files")
            if files_tbl.count_rows() == 0:
                return
            files_tbl.create_index("search_text", config=FTS(), replace=True)

    def optimize_tables(self) -> None:
        """Compact all tables and drop tombstoned fragments after bulk writes."""
        with self._write_lock:
            for name in ("files", "chunks", "user_data"):
                if name in self.table_names():
                    try:
                        self.db.open_table(name).optimize()
                    except Exception:
                        pass

    def create_vector_indices(self, embedding_dim: int) -> None:
        """Create ANN indices on vec/file_vec when tables are large enough to benefit."""
        with self._write_lock:
            for table_name, column in (("chunks", "vec"), ("files", "file_vec")):
                if table_name not in self.table_names():
                    continue
                tbl = self.db.open_table(table_name)
                rows = tbl.count_rows()
                if rows < 2048:
                    continue
                num_sub_vectors = next(
                    (d for d in (64, 48, 32, 16, 8, 4, 2, 1) if embedding_dim % d == 0),
                    1,
                )
                try:
                    tbl.create_index(
                        vector_column_name=column,
                        index_type="IVF_PQ",
                        metric="cosine",
                        num_partitions=max(2, min(256, rows // 32)),
                        num_sub_vectors=num_sub_vectors,
                        replace=True,
                    )
                except Exception:
                    pass

    def _delete_by_file_ids(self, table: Any, file_ids: Sequence[str]) -> None:
        if not file_ids or table.count_rows() == 0:
            return
        batch_size = 200
        for i in range(0, len(file_ids), batch_size):
            batch = file_ids[i : i + batch_size]
            quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in batch)
            table.delete(f"file_id IN ({quoted})")

    def get_user_data_map(self, file_ids: Iterable[str] | None = None) -> dict[str, UserDataRecord]:
        if "user_data" not in self.table_names():
            return {}
        tbl = self.db.open_table("user_data")
        total = tbl.count_rows()
        if total == 0:
            return {}
        rows: list[dict[str, Any]] = []
        if file_ids is not None:
            id_list = list(file_ids)
            if not id_list:
                return {}
            for i in range(0, len(id_list), 200):
                batch = id_list[i : i + 200]
                quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in batch)
                rows.extend(
                    tbl.search().where(f"file_id IN ({quoted})").limit(len(batch) + 10).to_list()
                )
        else:
            rows = tbl.search().limit(total + 100).to_list()
        result: dict[str, UserDataRecord] = {}
        for r in rows:
            fid = str(r["file_id"])
            result[fid] = UserDataRecord(
                file_id=fid,
                favorite=bool(r.get("favorite", False)),
                user_tags=[str(t) for t in (r.get("user_tags") or [])],
                note=str(r.get("note") or ""),
            )
        return result

    def set_user_data(
        self,
        file_id: str,
        favorite: bool | None = None,
        user_tags: list[str] | None = None,
        note: str | None = None,
    ) -> UserDataRecord:
        with self._write_lock:
            self.ensure_user_data_table()
            tbl = self.db.open_table("user_data")
            existing_map = self.get_user_data_map([file_id])
            current = existing_map.get(file_id, UserDataRecord(file_id=file_id))

            updated = UserDataRecord(
                file_id=file_id,
                favorite=favorite if favorite is not None else current.favorite,
                user_tags=user_tags if user_tags is not None else current.user_tags,
                note=note if note is not None else current.note,
            )
            self._delete_by_file_ids(tbl, [file_id])
            tbl.add(
                [
                    {
                        "file_id": updated.file_id,
                        "favorite": updated.favorite,
                        "user_tags": updated.user_tags,
                        "note": updated.note,
                    }
                ]
            )
        return updated

    def build_files_where_clause(
        self, filters: SearchFilters | None = None
    ) -> tuple[str, set[str] | None]:
        clauses: list[str] = ["status = 'ok'"]
        allowed_user_ids: set[str] | None = None

        if filters is not None:

            def _f(v: float | None) -> float | None:
                return v if v is not None and math.isfinite(v) else None

            if (v := _f(filters.min_duration)) is not None:
                clauses.append(f"duration_s >= {float(v)}")
            if (v := _f(filters.max_duration)) is not None:
                clauses.append(f"duration_s <= {float(v)}")
            if (v := _f(filters.min_lufs)) is not None:
                clauses.append(f"lufs_integrated IS NOT NULL AND lufs_integrated >= {float(v)}")
            if (v := _f(filters.max_lufs)) is not None:
                clauses.append(f"lufs_integrated IS NOT NULL AND lufs_integrated <= {float(v)}")
            if filters.sample_rates:
                sr_list = ", ".join(str(int(sr)) for sr in filters.sample_rates)
                clauses.append(f"sample_rate IN ({sr_list})")
            if filters.channels:
                ch_list = ", ".join(str(int(ch)) for ch in filters.channels)
                clauses.append(f"channels IN ({ch_list})")
            if filters.formats:
                fmt_clauses = []
                for fmt in filters.formats:
                    clean = _sql_escape(fmt.lower().lstrip("."))
                    like_clean = _sql_like_escape(clean)
                    fmt_clauses.append(
                        f"(LOWER(format) = '{clean}' OR LOWER(format) LIKE '{like_clean}/%' ESCAPE '\\' OR LOWER(format) LIKE '%/{like_clean}' ESCAPE '\\')"
                    )
                clauses.append("(" + " OR ".join(fmt_clauses) + ")")
            if filters.roots:
                root_clauses = []
                for rt in filters.roots:
                    clean_rt = _sql_escape(rt.replace("\\", "/").rstrip("/"))
                    like_rt = _sql_like_escape(clean_rt)
                    root_clauses.append(
                        f"(LOWER(root) = LOWER('{clean_rt}') OR LOWER(path) LIKE LOWER('{like_rt}/%') ESCAPE '\\')"
                    )
                clauses.append("(" + " OR ".join(root_clauses) + ")")
            if filters.folders:
                folder_clauses = []
                for fd in filters.folders:
                    clean_fd = _sql_escape(fd.replace("\\", "/").rstrip("/"))
                    like_fd = _sql_like_escape(clean_fd)
                    folder_clauses.append(f"LOWER(path) LIKE LOWER('{like_fd}/%') ESCAPE '\\'")
                clauses.append("(" + " OR ".join(folder_clauses) + ")")
            if (v := _f(filters.min_loop_score)) is not None:
                clauses.append(f"loop_score IS NOT NULL AND loop_score >= {float(v)}")

            if filters.favorites_only or filters.user_tag:
                user_map = self.get_user_data_map()
                matched_ids: set[str] = set()
                tag_target = filters.user_tag.lower().strip() if filters.user_tag else None
                for fid, urec in user_map.items():
                    if filters.favorites_only and not urec.favorite:
                        continue
                    if tag_target and tag_target not in [t.lower() for t in urec.user_tags]:
                        continue
                    matched_ids.add(fid)
                allowed_user_ids = matched_ids
                if not matched_ids:
                    clauses.append("1 = 0")
                elif len(matched_ids) <= 300:
                    quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in matched_ids)
                    clauses.append(f"file_id IN ({quoted})")

        return " AND ".join(clauses), allowed_user_ids

    def get_eligible_file_ids(self, filters: SearchFilters | None = None) -> set[str] | None:
        if "files" not in self.table_names():
            return set()
        where_sql, allowed_user_ids = self.build_files_where_clause(filters)
        has_extra_filters = (
            where_sql != "status = 'ok'"
            or allowed_user_ids is not None
            or (filters is not None and bool(filters.required_phrases or filters.excluded_terms))
        )
        tbl = self.db.open_table("files")
        total = tbl.count_rows()
        if total == 0:
            return set()

        select_cols = ["file_id"]
        need_text_check = bool(filters and (filters.required_phrases or filters.excluded_terms))
        if need_text_check:
            select_cols.append("search_text")
            select_cols.append("path")

        rows = tbl.search().where(where_sql).select(select_cols).limit(total + 100).to_list()
        ids: set[str] = set()
        for r in rows:
            fid = str(r["file_id"])
            if allowed_user_ids is not None and fid not in allowed_user_ids:
                continue
            if need_text_check and filters is not None:
                haystack = f"{r.get('search_text', '')} {r.get('path', '')}".lower()
                if filters.required_phrases and any(
                    p.lower() not in haystack for p in filters.required_phrases
                ):
                    continue
                if filters.excluded_terms and any(
                    ex.lower() in haystack for ex in filters.excluded_terms
                ):
                    continue
            ids.add(fid)

        if not has_extra_filters and len(ids) == total:
            return None
        return ids

    def browse_file_ids(
        self,
        filters: SearchFilters | None = None,
        sort: str = "name_asc",
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[str], int]:
        if "files" not in self.table_names():
            return [], 0
        where_sql, allowed_user_ids = self.build_files_where_clause(filters)
        tbl = self.db.open_table("files")
        total_rows = tbl.count_rows()
        if total_rows == 0:
            return [], 0

        select_cols = ["file_id", "path", "duration_s", "lufs_integrated"]
        need_text_check = bool(filters and (filters.required_phrases or filters.excluded_terms))
        if need_text_check:
            select_cols.append("search_text")

        rows = tbl.search().where(where_sql).select(select_cols).limit(total_rows + 100).to_list()
        matched: list[dict[str, Any]] = []
        for r in rows:
            fid = str(r["file_id"])
            if allowed_user_ids is not None and fid not in allowed_user_ids:
                continue
            if need_text_check and filters is not None:
                haystack = f"{r.get('search_text', '')} {r.get('path', '')}".lower()
                if filters.required_phrases and any(
                    p.lower() not in haystack for p in filters.required_phrases
                ):
                    continue
                if filters.excluded_terms and any(
                    ex.lower() in haystack for ex in filters.excluded_terms
                ):
                    continue
            matched.append(r)

        def _filename_key(row: dict[str, Any]) -> tuple[str, str]:
            p = str(row.get("path") or "").replace("\\", "/")
            name = p.rsplit("/", 1)[-1].lower()
            return (name, p.lower())

        if sort == "name_desc":
            matched.sort(key=_filename_key, reverse=True)
        elif sort == "duration_asc":
            matched.sort(key=lambda r: (float(r.get("duration_s") or 0.0), _filename_key(r)))
        elif sort == "duration_desc":
            matched.sort(
                key=lambda r: (float(r.get("duration_s") or 0.0), _filename_key(r)),
                reverse=True,
            )
        elif sort == "lufs_desc":
            matched.sort(
                key=lambda r: (
                    float(r["lufs_integrated"]) if r.get("lufs_integrated") is not None else -999.0
                ),
                reverse=True,
            )
        elif sort == "lufs_asc":
            matched.sort(
                key=lambda r: (
                    float(r["lufs_integrated"]) if r.get("lufs_integrated") is not None else 999.0
                )
            )
        else:
            matched.sort(key=_filename_key)

        total_matched = len(matched)
        page_slice = matched[max(0, offset) : max(0, offset) + max(1, limit)]
        return [str(r["file_id"]) for r in page_slice], total_matched

    def get_files_by_ids(
        self,
        file_ids: Sequence[str],
        include_vec: bool = False,
    ) -> dict[str, dict[str, Any]]:
        if not file_ids or "files" not in self.table_names():
            return {}
        tbl = self.db.open_table("files")
        if tbl.count_rows() == 0:
            return {}
        cols = [
            "file_id",
            "path",
            "root",
            "size_bytes",
            "mtime_ns",
            "format",
            "duration_s",
            "sample_rate",
            "channels",
            "lufs_integrated",
            "peak_dbfs",
            "loop_score",
            "tags_json",
            "search_text",
            "embedding_model",
            "status",
            "error",
            "indexed_at",
        ]
        if include_vec:
            cols.append("file_vec")

        out: dict[str, dict[str, Any]] = {}
        batch_size = 200
        for i in range(0, len(file_ids), batch_size):
            batch = file_ids[i : i + batch_size]
            quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in batch)
            rows = (
                tbl.search()
                .where(f"file_id IN ({quoted})")
                .select(cols)
                .limit(len(batch) + 10)
                .to_list()
            )
            for r in rows:
                out[str(r["file_id"])] = r
        return out

    def get_file_by_id_or_path(
        self,
        file_id_or_path: str,
        include_vec: bool = False,
    ) -> dict[str, Any] | None:
        from .scan import compute_file_id, normalize_path

        by_id = self.get_files_by_ids([file_id_or_path], include_vec=include_vec)
        if file_id_or_path in by_id:
            return by_id[file_id_or_path]

        computed_id = compute_file_id(file_id_or_path)
        by_comp = self.get_files_by_ids([computed_id], include_vec=include_vec)
        if computed_id in by_comp:
            return by_comp[computed_id]

        if "files" not in self.table_names():
            return None
        tbl = self.db.open_table("files")
        norm = _sql_escape(normalize_path(file_id_or_path))
        rows = tbl.search().where(f"LOWER(path) = LOWER('{norm}')").limit(1).to_list()
        return rows[0] if rows else None

    def get_chunks_for_file(self, file_id: str, include_vec: bool = False) -> list[dict[str, Any]]:
        if "chunks" not in self.table_names():
            return []
        tbl = self.db.open_table("chunks")
        if tbl.count_rows() == 0:
            return []
        cols = ["file_id", "chunk_idx", "start_s", "end_s"]
        if include_vec:
            cols.append("vec")
        rows = (
            tbl.search()
            .where(f"file_id = '{_sql_escape(file_id)}'")
            .select(cols)
            .limit(1000)
            .to_list()
        )
        rows.sort(key=lambda r: int(r["chunk_idx"]))
        return rows

    def search_chunks_knn(
        self,
        query_vec: npt.NDArray[np.float32] | Sequence[float],
        limit: int = 300,
        eligible_file_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        if "chunks" not in self.table_names():
            return []
        if eligible_file_ids is not None and len(eligible_file_ids) == 0:
            return []
        tbl = self.db.open_table("chunks")
        if tbl.count_rows() == 0:
            return []

        q: Any = tbl.search(list(map(float, query_vec)), vector_column_name="vec")
        q = q.metric("cosine")
        if eligible_file_ids is not None and len(eligible_file_ids) <= 400:
            quoted = ", ".join(f"'{_sql_escape(fid)}'" for fid in eligible_file_ids)
            q = q.where(f"file_id IN ({quoted})")
            rows = q.limit(limit).to_list()
        elif eligible_file_ids is not None:
            rows = q.limit(max(limit * 4, 1000)).to_list()
            rows = [r for r in rows if str(r["file_id"]) in eligible_file_ids][:limit]
        else:
            rows = q.limit(limit).to_list()
        return rows

    def search_files_knn(
        self,
        query_vec: npt.NDArray[np.float32] | Sequence[float],
        limit: int = 100,
        filters: SearchFilters | None = None,
    ) -> list[dict[str, Any]]:
        if "files" not in self.table_names():
            return []
        tbl = self.db.open_table("files")
        if tbl.count_rows() == 0:
            return []
        where_sql, allowed_user_ids = self.build_files_where_clause(filters)
        if allowed_user_ids is not None and len(allowed_user_ids) == 0:
            return []
        # >300 matching ids are filtered in Python, so over-fetch like the
        # chunks path does to avoid starving the result list.
        post_filter = allowed_user_ids is not None and len(allowed_user_ids) > 300
        fetch_limit = limit * 4 if post_filter else limit
        q_files: Any = tbl.search(list(map(float, query_vec)), vector_column_name="file_vec")
        rows = q_files.metric("cosine").where(where_sql).limit(fetch_limit).to_list()
        if allowed_user_ids is not None:
            rows = [r for r in rows if str(r["file_id"]) in allowed_user_ids][:limit]
        return rows

    def search_files_bm25(
        self,
        query_text: str,
        limit: int = 100,
        filters: SearchFilters | None = None,
    ) -> list[dict[str, Any]]:
        cleaned = query_text.strip()
        if not cleaned or "files" not in self.table_names():
            return []
        tbl = self.db.open_table("files")
        if tbl.count_rows() == 0:
            return []
        where_sql, allowed_user_ids = self.build_files_where_clause(filters)
        if allowed_user_ids is not None and len(allowed_user_ids) == 0:
            return []
        overfetch = 1
        if filters and (filters.required_phrases or filters.excluded_terms):
            overfetch = 2
        if allowed_user_ids is not None and len(allowed_user_ids) > 300:
            overfetch = max(overfetch, 4)
        fetch_limit = limit * overfetch
        try:
            rows = (
                tbl.search(cleaned, query_type="fts", fts_columns="search_text")
                .where(where_sql)
                .select(["file_id", "path", "search_text"])
                .limit(fetch_limit)
                .to_list()
            )
        except Exception:
            # Assume a stale/missing FTS index; rebuild once per process and
            # retry on a fresh handle (the old one may pin a pre-index
            # snapshot). A malformed query fails again -> return [].
            with self._write_lock:
                if self._fts_rebuild_attempted:
                    return []
                self._fts_rebuild_attempted = True
            try:
                self.rebuild_fts_index()
                rows = (
                    self.db.open_table("files")
                    .search(cleaned, query_type="fts", fts_columns="search_text")
                    .where(where_sql)
                    .select(["file_id", "path", "search_text"])
                    .limit(fetch_limit)
                    .to_list()
                )
            except Exception:
                return []

        filtered: list[dict[str, Any]] = []
        for r in rows:
            fid = str(r["file_id"])
            if allowed_user_ids is not None and fid not in allowed_user_ids:
                continue
            if filters is not None:
                haystack = f"{r.get('search_text', '')} {r.get('path', '')}".lower()
                if filters.required_phrases and any(
                    p.lower() not in haystack for p in filters.required_phrases
                ):
                    continue
                if filters.excluded_terms and any(
                    ex.lower() in haystack for ex in filters.excluded_terms
                ):
                    continue
            filtered.append(r)
            if len(filtered) >= limit:
                break
        return filtered

    def get_library_stats(self) -> dict[str, Any]:
        names = self.table_names()
        if "files" not in names:
            return {
                "total_files": 0,
                "ok_files": 0,
                "error_files": 0,
                "missing_files": 0,
                "total_chunks": 0,
                "total_duration_s": 0.0,
                "total_duration_hours": 0.0,
                "total_size_bytes": 0,
                "embedding_model": None,
                "embedding_dim": None,
                "roots": [],
                "formats": {},
                "favorites_count": 0,
            }

        files_tbl = self.db.open_table("files")
        total_rows = files_tbl.count_rows()
        chunks_count = self.db.open_table("chunks").count_rows() if "chunks" in names else 0
        stored_model, stored_dim = self.get_stored_model_info()

        cols = [
            "status",
            "duration_s",
            "size_bytes",
            "root",
            "format",
        ]
        rows = (
            files_tbl.search().select(cols).limit(total_rows + 100).to_list()
            if total_rows > 0
            else []
        )

        ok_files = 0
        error_files = 0
        missing_files = 0
        total_duration_s = 0.0
        total_size_bytes = 0
        roots_set: set[str] = set()
        formats_count: dict[str, int] = {}

        for r in rows:
            st = str(r.get("status", "ok"))
            if st == "ok":
                ok_files += 1
                total_duration_s += float(r.get("duration_s") or 0.0)
                total_size_bytes += int(r.get("size_bytes") or 0)
                rt = str(r.get("root") or "")
                if rt:
                    roots_set.add(rt)
                fmt = str(r.get("format") or "unknown").split("/")[0]
                formats_count[fmt] = formats_count.get(fmt, 0) + 1
            elif st == "error":
                error_files += 1
            elif st == "missing":
                missing_files += 1

        user_map = self.get_user_data_map()
        fav_count = sum(1 for u in user_map.values() if u.favorite)

        return {
            "total_files": total_rows,
            "ok_files": ok_files,
            "error_files": error_files,
            "missing_files": missing_files,
            "total_chunks": chunks_count,
            "total_duration_s": round(total_duration_s, 2),
            "total_duration_hours": round(total_duration_s / 3600.0, 4),
            "total_size_bytes": total_size_bytes,
            "embedding_model": stored_model,
            "embedding_dim": stored_dim,
            "roots": sorted(roots_set),
            "formats": formats_count,
            "favorites_count": fav_count,
        }

    def get_available_filters(self) -> dict[str, Any]:
        if "files" not in self.table_names():
            return {
                "formats": [],
                "roots": [],
                "sample_rates": [],
                "channels": [],
                "min_duration_s": 0.0,
                "max_duration_s": 0.0,
                "min_lufs": -70.0,
                "max_lufs": 0.0,
                "user_tags": [],
            }
        files_tbl = self.db.open_table("files")
        total = files_tbl.count_rows()
        if total == 0:
            return {
                "formats": [],
                "roots": [],
                "sample_rates": [],
                "channels": [],
                "min_duration_s": 0.0,
                "max_duration_s": 0.0,
                "min_lufs": -70.0,
                "max_lufs": 0.0,
                "user_tags": [],
            }

        cols = ["format", "root", "sample_rate", "channels", "duration_s", "lufs_integrated"]
        rows = files_tbl.search().where("status = 'ok'").select(cols).limit(total + 100).to_list()

        formats_set: set[str] = set()
        roots_set: set[str] = set()
        sr_set: set[int] = set()
        ch_set: set[int] = set()
        durations: list[float] = []
        lufs_vals: list[float] = []

        for r in rows:
            fmt = str(r.get("format") or "").split("/")[0].strip()
            if fmt:
                formats_set.add(fmt)
            rt = str(r.get("root") or "").strip()
            if rt:
                roots_set.add(rt)
            sr = r.get("sample_rate")
            if sr:
                sr_set.add(int(sr))
            ch = r.get("channels")
            if ch:
                ch_set.add(int(ch))
            dur = r.get("duration_s")
            if dur is not None:
                durations.append(float(dur))
            lufs = r.get("lufs_integrated")
            if lufs is not None:
                lufs_vals.append(float(lufs))

        user_map = self.get_user_data_map()
        tags_set: set[str] = set()
        for u in user_map.values():
            for t in u.user_tags:
                if t.strip():
                    tags_set.add(t.strip())

        return {
            "formats": sorted(formats_set),
            "roots": sorted(roots_set),
            "sample_rates": sorted(sr_set),
            "channels": sorted(ch_set),
            "min_duration_s": round(min(durations), 2) if durations else 0.0,
            "max_duration_s": round(max(durations), 2) if durations else 0.0,
            "min_lufs": round(min(lufs_vals), 1) if lufs_vals else -70.0,
            "max_lufs": round(max(lufs_vals), 1) if lufs_vals else 0.0,
            "user_tags": sorted(tags_set),
        }

    def get_folder_index(self) -> list[dict[str, Any]]:
        """Folders containing ok files, with per-folder file counts.

        Entries carry the directory of each indexed file only; intermediate
        ancestor folders without direct files are synthesized by the caller.
        Case variants of the same folder merge under the first-seen spelling.
        """
        if "files" not in self.table_names():
            return []
        files_tbl = self.db.open_table("files")
        total = files_tbl.count_rows()
        if total == 0:
            return []
        rows = (
            files_tbl.search().where("status = 'ok'").select(["path"]).limit(total + 100).to_list()
        )
        counts: dict[str, tuple[str, int]] = {}
        for r in rows:
            path_str = str(r.get("path") or "")
            sep = path_str.rfind("/")
            if sep <= 0:
                continue
            folder = path_str[:sep]
            key = folder.lower()
            prev = counts.get(key)
            counts[key] = (folder, (prev[1] if prev else 0) + 1)
        return [
            {"path": path, "count": count}
            for path, count in sorted(counts.values(), key=lambda kv: kv[0].lower())
        ]
