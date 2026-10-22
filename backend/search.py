"""Hybrid retrieval, query syntax parser, Reciprocal Rank Fusion, and similarity search."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

import numpy as np
import numpy.typing as npt

from .config import Config
from .decode import decode_file
from .embed import EmbedderProtocol
from .store import SearchFilters, SfxStore, UserDataRecord

SearchMode = Literal["hybrid", "audio_only", "keyword_only"]

_INLINE_DUR_RE = re.compile(r"\bdur:(?:(\d+(?:\.\d+)?))?-(?:(\d+(?:\.\d+)?))?\b", re.IGNORECASE)
_INLINE_DUR_CMP_RE = re.compile(r"\bdur:([<>]=?)(\d+(?:\.\d+)?)\b", re.IGNORECASE)
_INLINE_LOOP_RE = re.compile(r"\bloop:(true|false|\d+(?:\.\d+)?)\b", re.IGNORECASE)
_INLINE_FMT_RE = re.compile(r"\b(?:fmt|format):([a-zA-Z0-9_.-]+)\b", re.IGNORECASE)
_INLINE_FAV_RE = re.compile(r"\bfav(?:orite)?s?:(true|1|yes)\b", re.IGNORECASE)
_INLINE_TAG_RE = re.compile(r"\btag:([a-zA-Z0-9_.-]+)\b", re.IGNORECASE)
_PHRASE_RE = re.compile(r'"([^"]+)"')
_EXCLUSION_RE = re.compile(r"(?:^|\s)-([a-zA-Z0-9_]+)\b")


@dataclass
class ParsedQuery:
    raw_query: str
    semantic_query: str
    keyword_query: str
    filters: SearchFilters


@dataclass
class SearchHit:
    file_id: str
    path: str
    root: str
    filename: str
    folder: str
    format: str
    duration_s: float
    sample_rate: int
    channels: int
    lufs_integrated: float | None
    peak_dbfs: float
    loop_score: float | None
    tags: dict[str, Any]
    search_text: str
    best_offset_s: float
    best_end_s: float
    best_chunk_idx: int
    clap_score: float | None
    bm25_score: float | None
    rrf_score: float
    favorite: bool = False
    user_tags: list[str] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_id": self.file_id,
            "path": self.path,
            "root": self.root,
            "filename": self.filename,
            "folder": self.folder,
            "format": self.format,
            "duration_s": round(self.duration_s, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "lufs_integrated": (
                round(self.lufs_integrated, 2) if self.lufs_integrated is not None else None
            ),
            "peak_dbfs": round(self.peak_dbfs, 2),
            "loop_score": round(self.loop_score, 3) if self.loop_score is not None else None,
            "tags": self.tags,
            "search_text": self.search_text,
            "best_offset_s": round(self.best_offset_s, 3),
            "best_end_s": round(self.best_end_s, 3),
            "best_chunk_idx": self.best_chunk_idx,
            "clap_score": round(self.clap_score, 4) if self.clap_score is not None else None,
            "bm25_score": round(self.bm25_score, 4) if self.bm25_score is not None else None,
            "rrf_score": round(self.rrf_score, 6),
            "favorite": self.favorite,
            "user_tags": self.user_tags,
            "note": self.note,
        }


def parse_query(raw_query: str, base_filters: SearchFilters | None = None) -> ParsedQuery:
    f = replace(base_filters) if base_filters is not None else SearchFilters()
    f.required_phrases = list(f.required_phrases or [])
    f.excluded_terms = list(f.excluded_terms or [])
    f.formats = list(f.formats) if f.formats else None

    working = raw_query

    for m in _INLINE_DUR_RE.finditer(working):
        lo, hi = m.group(1), m.group(2)
        if lo is not None:
            f.min_duration = float(lo)
        if hi is not None:
            f.max_duration = float(hi)
    working = _INLINE_DUR_RE.sub(" ", working)

    for m in _INLINE_DUR_CMP_RE.finditer(working):
        op, val_str = m.group(1), m.group(2)
        val = float(val_str)
        if op.startswith(">"):
            f.min_duration = val
        elif op.startswith("<"):
            f.max_duration = val
    working = _INLINE_DUR_CMP_RE.sub(" ", working)

    for m in _INLINE_LOOP_RE.finditer(working):
        lval = m.group(1).lower()
        if lval == "true":
            f.min_loop_score = f.min_loop_score if f.min_loop_score is not None else 0.6
        elif lval != "false":
            f.min_loop_score = float(lval)
    working = _INLINE_LOOP_RE.sub(" ", working)

    for m in _INLINE_FMT_RE.finditer(working):
        fmt_val = m.group(1).lower().lstrip(".")
        if f.formats is None:
            f.formats = [fmt_val]
        elif fmt_val not in f.formats:
            f.formats.append(fmt_val)
    working = _INLINE_FMT_RE.sub(" ", working)

    if _INLINE_FAV_RE.search(working):
        f.favorites_only = True
    working = _INLINE_FAV_RE.sub(" ", working)

    for m in _INLINE_TAG_RE.finditer(working):
        f.user_tag = m.group(1).strip()
    working = _INLINE_TAG_RE.sub(" ", working)

    for m in _PHRASE_RE.finditer(working):
        phrase = m.group(1).strip()
        if phrase:
            f.required_phrases.append(phrase)
    working_no_quotes = _PHRASE_RE.sub(r" \1 ", working)

    for m in _EXCLUSION_RE.finditer(working_no_quotes):
        term = m.group(1).strip().lower()
        if term:
            f.excluded_terms.append(term)
    cleaned = _EXCLUSION_RE.sub(" ", working_no_quotes)
    cleaned = " ".join(cleaned.split())

    return ParsedQuery(
        raw_query=raw_query,
        semantic_query=cleaned or raw_query.strip(),
        keyword_query=cleaned,
        filters=f,
    )


def reciprocal_rank_fusion(
    vector_ranked_ids: Sequence[str],
    keyword_ranked_ids: Sequence[str],
    rrf_k: int = 60,
    vector_weight: float = 1.0,
    keyword_weight: float = 1.0,
) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    for rank_idx, fid in enumerate(vector_ranked_ids, start=1):
        scores[fid] = scores.get(fid, 0.0) + vector_weight * (1.0 / float(rrf_k + rank_idx))
    for rank_idx, fid in enumerate(keyword_ranked_ids, start=1):
        scores[fid] = scores.get(fid, 0.0) + keyword_weight * (1.0 / float(rrf_k + rank_idx))
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return ranked


class SearchEngine:
    """Executes hybrid, vector-only, keyword-only, and audio similarity queries."""

    def __init__(
        self, config: Config, store: SfxStore, embedder: EmbedderProtocol | None = None
    ) -> None:
        self.config = config
        self.store = store
        self._embedder = embedder

    @property
    def embedder(self) -> EmbedderProtocol:
        if self._embedder is None:
            from .embed import ClapEmbedder

            self._embedder = ClapEmbedder(
                model_id=self.config.embedding.model_id,
                precision=self.config.embedding.precision,
                window_s=self.config.embedding.window_s,
                hop_s=self.config.embedding.hop_s,
                max_chunks_per_file=self.config.embedding.max_chunks_per_file,
                batch_size=self.config.embedding.batch_size,
            )
        return self._embedder

    def search(
        self,
        query: str,
        k: int | None = None,
        mode: SearchMode = "hybrid",
        filters: SearchFilters | None = None,
    ) -> list[SearchHit]:
        top_k = k if k is not None else self.config.search.default_k
        parsed = parse_query(query, base_filters=filters)
        eff_filters = parsed.filters

        eligible_ids = self.store.get_eligible_file_ids(eff_filters)
        if eligible_ids is not None and len(eligible_ids) == 0:
            return []

        vector_ranked: list[str] = []
        best_chunk_by_file: dict[str, tuple[float, float, float, int]] = {}

        if mode in ("hybrid", "audio_only") and parsed.semantic_query.strip():
            q_vec = self.embedder.embed_text(parsed.semantic_query)
            raw_chunks = self.store.search_chunks_knn(
                query_vec=q_vec,
                limit=self.config.search.vector_candidates,
                eligible_file_ids=eligible_ids,
            )
            for row in raw_chunks:
                fid = str(row["file_id"])
                dist = float(row.get("_distance", 1.0))
                sim = float(1.0 - dist)
                start_s = float(row.get("start_s", 0.0))
                end_s = float(row.get("end_s", start_s + self.config.embedding.window_s))
                c_idx = int(row.get("chunk_idx", 0))
                prev = best_chunk_by_file.get(fid)
                if prev is None or sim > prev[0]:
                    best_chunk_by_file[fid] = (sim, start_s, end_s, c_idx)

            sorted_vec = sorted(best_chunk_by_file.items(), key=lambda kv: kv[1][0], reverse=True)
            vector_ranked = [fid for fid, _ in sorted_vec]

        keyword_ranked: list[str] = []
        bm25_by_file: dict[str, float] = {}

        if mode in ("hybrid", "keyword_only") and parsed.keyword_query.strip():
            bm25_rows = self.store.search_files_bm25(
                query_text=parsed.keyword_query,
                limit=self.config.search.keyword_candidates,
                filters=eff_filters,
            )
            for row in bm25_rows:
                fid = str(row["file_id"])
                if eligible_ids is not None and fid not in eligible_ids:
                    continue
                score = float(row.get("_score", 0.0))
                if fid not in bm25_by_file:
                    bm25_by_file[fid] = score
                    keyword_ranked.append(fid)

        if mode == "audio_only":
            merged = [(fid, best_chunk_by_file[fid][0]) for fid in vector_ranked[:top_k]]
        elif mode == "keyword_only":
            if not keyword_ranked and not parsed.keyword_query.strip() and eligible_ids:
                fallback_ids = sorted(eligible_ids)[:top_k]
                merged = [(fid, 1.0) for fid in fallback_ids]
            else:
                merged = [(fid, bm25_by_file[fid]) for fid in keyword_ranked[:top_k]]
        else:
            fused = reciprocal_rank_fusion(
                vector_ranked_ids=vector_ranked,
                keyword_ranked_ids=keyword_ranked,
                rrf_k=self.config.search.rrf_k,
                vector_weight=self.config.search.vector_weight,
                keyword_weight=self.config.search.keyword_weight,
            )
            merged = fused[:top_k]

        if not merged:
            return []

        top_file_ids = [fid for fid, _ in merged]
        files_map = self.store.get_files_by_ids(top_file_ids)
        user_map = self.store.get_user_data_map(top_file_ids)

        hits: list[SearchHit] = []
        for fid, final_score in merged:
            f_row = files_map.get(fid)
            if f_row is None:
                continue
            chunk_info = best_chunk_by_file.get(fid)
            clap_score = chunk_info[0] if chunk_info is not None else None
            best_offset_s = chunk_info[1] if chunk_info is not None else 0.0
            best_end_s = (
                chunk_info[2]
                if chunk_info is not None
                else min(float(f_row.get("duration_s", 0.0)), self.config.embedding.window_s)
            )
            best_chunk_idx = chunk_info[3] if chunk_info is not None else 0
            bm25_score = bm25_by_file.get(fid)
            u_rec = user_map.get(fid, UserDataRecord(file_id=fid))

            hits.append(
                self._build_hit(
                    f_row=f_row,
                    u_rec=u_rec,
                    best_offset_s=best_offset_s,
                    best_end_s=best_end_s,
                    best_chunk_idx=best_chunk_idx,
                    clap_score=clap_score,
                    bm25_score=bm25_score,
                    rrf_score=final_score,
                )
            )
        return hits

    def find_similar(
        self,
        file_id_or_path: str,
        k: int | None = None,
        chunk_idx: int | None = None,
        filters: SearchFilters | None = None,
        exclude_self: bool = True,
    ) -> list[SearchHit]:
        top_k = k if k is not None else self.config.search.default_k
        ref_row = self.store.get_file_by_id_or_path(file_id_or_path, include_vec=True)

        if ref_row is not None:
            ref_file_id = str(ref_row["file_id"])
            if chunk_idx is not None:
                chunks = self.store.get_chunks_for_file(ref_file_id, include_vec=True)
                target_chunk = next((c for c in chunks if int(c["chunk_idx"]) == chunk_idx), None)
                if target_chunk is None and chunks:
                    target_chunk = chunks[0]
                if target_chunk is None:
                    raise ValueError(f"No chunks found for file_id={ref_file_id}")
                q_vec = np.asarray(target_chunk["vec"], dtype=np.float32)
                return self._similar_by_chunk_vec(
                    q_vec=q_vec,
                    top_k=top_k,
                    filters=filters,
                    exclude_file_id=ref_file_id if exclude_self else None,
                )

            q_vec = np.asarray(ref_row["file_vec"], dtype=np.float32)
            return self._similar_by_file_vec(
                q_vec=q_vec,
                top_k=top_k,
                filters=filters,
                exclude_file_id=ref_file_id if exclude_self else None,
            )

        path_obj = Path(file_id_or_path)
        if not path_obj.is_file():
            raise FileNotFoundError(f"Reference file or file_id not found: {file_id_or_path}")
        return self.find_similar_from_audio_file(path_obj, k=top_k, filters=filters)

    def find_similar_from_audio_file(
        self,
        audio_path: str | Path,
        k: int | None = None,
        filters: SearchFilters | None = None,
    ) -> list[SearchHit]:
        top_k = k if k is not None else self.config.search.default_k
        decoded = decode_file(
            audio_path,
            ffmpeg_bin=self.config.paths.ffmpeg,
            ffprobe_bin=self.config.paths.ffprobe,
            target_sr=48000,
        )
        embedded = self.embedder.embed_audio(decoded.samples, sample_rate=decoded.sample_rate)
        return self._similar_by_file_vec(
            q_vec=embedded.file_vec,
            top_k=top_k,
            filters=filters,
            exclude_file_id=None,
        )

    def _similar_by_file_vec(
        self,
        q_vec: npt.NDArray[np.float32],
        top_k: int,
        filters: SearchFilters | None = None,
        exclude_file_id: str | None = None,
    ) -> list[SearchHit]:
        rows = self.store.search_files_knn(
            query_vec=q_vec,
            limit=top_k + (5 if exclude_file_id else 0),
            filters=filters,
        )
        filtered_rows = [r for r in rows if str(r["file_id"]) != exclude_file_id][:top_k]
        if not filtered_rows:
            return []
        fids = [str(r["file_id"]) for r in filtered_rows]
        user_map = self.store.get_user_data_map(fids)

        hits: list[SearchHit] = []
        for r in filtered_rows:
            fid = str(r["file_id"])
            dist = float(r.get("_distance", 1.0))
            sim = float(1.0 - dist)
            dur = float(r.get("duration_s", 0.0))
            u_rec = user_map.get(fid, UserDataRecord(file_id=fid))
            hits.append(
                self._build_hit(
                    f_row=r,
                    u_rec=u_rec,
                    best_offset_s=0.0,
                    best_end_s=min(dur, self.config.embedding.window_s),
                    best_chunk_idx=0,
                    clap_score=sim,
                    bm25_score=None,
                    rrf_score=sim,
                )
            )
        return hits

    def _similar_by_chunk_vec(
        self,
        q_vec: npt.NDArray[np.float32],
        top_k: int,
        filters: SearchFilters | None = None,
        exclude_file_id: str | None = None,
    ) -> list[SearchHit]:
        eligible_ids = self.store.get_eligible_file_ids(filters)
        raw_chunks = self.store.search_chunks_knn(
            query_vec=q_vec,
            limit=max(self.config.search.vector_candidates, top_k * 5),
            eligible_file_ids=eligible_ids,
        )
        best_by_file: dict[str, tuple[float, float, float, int]] = {}
        for row in raw_chunks:
            fid = str(row["file_id"])
            if exclude_file_id and fid == exclude_file_id:
                continue
            dist = float(row.get("_distance", 1.0))
            sim = float(1.0 - dist)
            start_s = float(row.get("start_s", 0.0))
            end_s = float(row.get("end_s", start_s + self.config.embedding.window_s))
            c_idx = int(row.get("chunk_idx", 0))
            prev = best_by_file.get(fid)
            if prev is None or sim > prev[0]:
                best_by_file[fid] = (sim, start_s, end_s, c_idx)

        ranked = sorted(best_by_file.items(), key=lambda kv: kv[1][0], reverse=True)[:top_k]
        if not ranked:
            return []
        fids = [fid for fid, _ in ranked]
        files_map = self.store.get_files_by_ids(fids)
        user_map = self.store.get_user_data_map(fids)

        hits: list[SearchHit] = []
        for fid, (sim, start_s, end_s, c_idx) in ranked:
            f_row = files_map.get(fid)
            if f_row is None:
                continue
            u_rec = user_map.get(fid, UserDataRecord(file_id=fid))
            hits.append(
                self._build_hit(
                    f_row=f_row,
                    u_rec=u_rec,
                    best_offset_s=start_s,
                    best_end_s=end_s,
                    best_chunk_idx=c_idx,
                    clap_score=sim,
                    bm25_score=None,
                    rrf_score=sim,
                )
            )
        return hits

    def _build_hit(
        self,
        f_row: dict[str, Any],
        u_rec: UserDataRecord,
        best_offset_s: float,
        best_end_s: float,
        best_chunk_idx: int,
        clap_score: float | None,
        bm25_score: float | None,
        rrf_score: float,
    ) -> SearchHit:
        path_str = str(f_row["path"])
        p = Path(path_str)
        raw_tags = str(f_row.get("tags_json") or "{}")
        try:
            tags_dict = json.loads(raw_tags)
        except Exception:
            tags_dict = {}

        return SearchHit(
            file_id=str(f_row["file_id"]),
            path=path_str,
            root=str(f_row.get("root") or ""),
            filename=p.name,
            folder=str(p.parent).replace("\\", "/"),
            format=str(f_row.get("format") or ""),
            duration_s=float(f_row.get("duration_s") or 0.0),
            sample_rate=int(f_row.get("sample_rate") or 0),
            channels=int(f_row.get("channels") or 0),
            lufs_integrated=(
                float(f_row["lufs_integrated"])
                if f_row.get("lufs_integrated") is not None
                else None
            ),
            peak_dbfs=float(f_row.get("peak_dbfs") or -120.0),
            loop_score=(
                float(f_row["loop_score"]) if f_row.get("loop_score") is not None else None
            ),
            tags=tags_dict,
            search_text=str(f_row.get("search_text") or ""),
            best_offset_s=best_offset_s,
            best_end_s=best_end_s,
            best_chunk_idx=best_chunk_idx,
            clap_score=clap_score,
            bm25_score=bm25_score,
            rrf_score=rrf_score,
            favorite=u_rec.favorite,
            user_tags=u_rec.user_tags,
            note=u_rec.note,
        )
