"""MCP server exposing sfx-search tools over stdio and local HTTP transports."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer

from .config import Config, load_config
from .embed import EmbedderProtocol
from .search import SearchEngine, SearchHit, SearchMode
from .store import SearchFilters, SfxStore, UserDataRecord


def _compact_hit(hit: SearchHit) -> dict[str, Any]:
    tags_summary = ", ".join(f"{k}:{v}" for k, v in list(hit.tags.items())[:6])
    return {
        "file_id": hit.file_id,
        "path": hit.path,
        "duration_s": round(hit.duration_s, 2),
        "format": hit.format,
        "tags_summary": tags_summary,
        "best_offset_s": round(hit.best_offset_s, 2),
        "scores": {
            "rrf_score": round(hit.rrf_score, 5),
            "clap_score": round(hit.clap_score, 4) if hit.clap_score is not None else None,
            "bm25_score": round(hit.bm25_score, 4) if hit.bm25_score is not None else None,
        },
        "favorite": hit.favorite,
        "user_tags": hit.user_tags,
    }


def create_mcp_server(
    config: Config | None = None,
    store: SfxStore | None = None,
    embedder: EmbedderProtocol | None = None,
) -> MCPServer:
    cfg = config or load_config()
    st = store or SfxStore(cfg.db_dir)
    engine = SearchEngine(config=cfg, store=st, embedder=embedder)

    mcp = MCPServer(
        name="sfx-search",
        title="SFX Search MCP Server",
        description="Semantic and hybrid keyword search over a local sound-effects library.",
        version="0.1.0",
    )

    @mcp.tool()
    def search_sounds(
        query: str,
        k: int = 20,
        mode: SearchMode = "hybrid",
        min_duration: float | None = None,
        max_duration: float | None = None,
        min_lufs: float | None = None,
        max_lufs: float | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        format: str | None = None,
        root: str | None = None,
        favorites_only: bool = False,
        user_tag: str | None = None,
        min_loop_score: float | None = None,
    ) -> str:
        """Search sound effects by natural-language description and/or metadata keywords."""
        filters = SearchFilters(
            min_duration=min_duration,
            max_duration=max_duration,
            min_lufs=min_lufs,
            max_lufs=max_lufs,
            sample_rates=[sample_rate] if sample_rate is not None else None,
            channels=[channels] if channels is not None else None,
            formats=[format] if format else None,
            roots=[root] if root else None,
            favorites_only=favorites_only,
            user_tag=user_tag,
            min_loop_score=min_loop_score,
        )
        hits = engine.search(query=query, k=k, mode=mode, filters=filters)
        payload = {
            "query": query,
            "mode": mode,
            "count": len(hits),
            "results": [_compact_hit(h) for h in hits],
        }
        return json.dumps(payload, ensure_ascii=False)

    @mcp.tool()
    def batch_search(
        queries: list[str],
        k: int = 10,
        mode: SearchMode = "hybrid",
        min_duration: float | None = None,
        max_duration: float | None = None,
        min_lufs: float | None = None,
        max_lufs: float | None = None,
        format: str | None = None,
        root: str | None = None,
        favorites_only: bool = False,
        min_loop_score: float | None = None,
    ) -> str:
        """Run multiple sound-effect search queries at once with shared filters."""
        filters = SearchFilters(
            min_duration=min_duration,
            max_duration=max_duration,
            min_lufs=min_lufs,
            max_lufs=max_lufs,
            formats=[format] if format else None,
            roots=[root] if root else None,
            favorites_only=favorites_only,
            min_loop_score=min_loop_score,
        )
        batch_out: list[dict[str, Any]] = []
        for q in queries:
            hits = engine.search(query=q, k=k, mode=mode, filters=filters)
            batch_out.append(
                {
                    "query": q,
                    "count": len(hits),
                    "results": [_compact_hit(h) for h in hits],
                }
            )
        return json.dumps({"batches": batch_out}, ensure_ascii=False)

    @mcp.tool()
    def find_similar(
        file_id_or_path: str,
        k: int = 20,
        chunk_idx: int | None = None,
    ) -> str:
        """Find sounds acoustically similar to a reference file_id or file path."""
        hits = engine.find_similar(
            file_id_or_path=file_id_or_path,
            k=k,
            chunk_idx=chunk_idx,
        )
        payload = {
            "reference": file_id_or_path,
            "chunk_idx": chunk_idx,
            "count": len(hits),
            "results": [_compact_hit(h) for h in hits],
        }
        return json.dumps(payload, ensure_ascii=False)

    @mcp.tool()
    def get_sound(file_id: str) -> str:
        """Return full metadata, acoustic features, chunks, and user annotations for one sound."""
        f_row = st.get_file_by_id_or_path(file_id)
        if f_row is None:
            return json.dumps({"error": f"Sound not found: {file_id}"})
        fid = str(f_row["file_id"])
        u_map = st.get_user_data_map([fid])
        u_rec = u_map.get(fid, UserDataRecord(file_id=fid))
        chunks = st.get_chunks_for_file(fid, include_vec=False)
        try:
            tags_dict = json.loads(str(f_row.get("tags_json") or "{}"))
        except Exception:
            tags_dict = {}

        p = Path(str(f_row["path"]))
        payload = {
            "file_id": fid,
            "path": str(f_row["path"]),
            "filename": p.name,
            "root": str(f_row.get("root") or ""),
            "size_bytes": int(f_row.get("size_bytes") or 0),
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
            "favorite": u_rec.favorite,
            "user_tags": u_rec.user_tags,
            "note": u_rec.note,
            "chunks": [
                {
                    "chunk_idx": int(c["chunk_idx"]),
                    "start_s": round(float(c["start_s"]), 2),
                    "end_s": round(float(c["end_s"]), 2),
                }
                for c in chunks
            ],
        }
        return json.dumps(payload, ensure_ascii=False)

    @mcp.tool()
    def library_stats() -> str:
        """Return library counts, total duration, embedding model info, and available filters."""
        stats = st.get_library_stats()
        filters = st.get_available_filters()
        return json.dumps({"stats": stats, "available_filters": filters}, ensure_ascii=False)

    return mcp


def run_mcp_server(
    transport: Literal["stdio", "sse", "streamable-http"] = "stdio",
    host: str = "127.0.0.1",
    port: int = 8766,
    config: Config | None = None,
) -> None:
    mcp = create_mcp_server(config=config)
    if transport == "stdio":
        mcp.run(transport="stdio")
    else:
        mcp.run(transport=transport, host=host, port=port)


if __name__ == "__main__":
    run_mcp_server()
