"""Tests for FastAPI endpoints (including HTTP Range streaming and transcoding), MCP tools, and real CLAP GPU determinism/fp16 parity."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient
from sfxsearch.api import create_app
from sfxsearch.config import Config, LibraryConfig, PathsConfig
from sfxsearch.embed import ClapEmbedder
from sfxsearch.indexer import run_indexer
from sfxsearch.mcp_server import create_mcp_server
from sfxsearch.scan import compute_file_id
from sfxsearch.store import SfxStore

from .conftest import FakeEmbedder, write_sine_wav


def test_fastapi_endpoints_range_and_transcode(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    data_dir = tmp_path / "data"

    wav1 = write_sine_wav(lib_root / "SciFi" / "laser_zap_01.wav", freq_hz=660.0, duration_s=1.5)
    # Create an AIFF file via ffmpeg to test on-the-fly browser transcode fallback
    aiff_path = lib_root / "Foley" / "door_creak_02.aiff"
    aiff_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-i",
            str(wav1),
            "-acodec",
            "pcm_s16be",
            str(aiff_path),
        ],
        check=True,
    )

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)

    app = create_app(config=cfg, store=store, embedder=embedder)
    client = TestClient(app)

    # 1. Stats & Filters
    r_stats = client.get("/api/stats")
    assert r_stats.status_code == 200
    assert r_stats.json()["ok_files"] == 2

    r_filters = client.get("/api/filters")
    assert r_filters.status_code == 200
    assert "wav" in r_filters.json()["formats"]

    # 2. Search GET & POST
    r_search = client.get("/api/search", params={"q": "laser zap", "mode": "keyword_only"})
    assert r_search.status_code == 200
    results = r_search.json()["results"]
    assert len(results) >= 1
    wav1_id = compute_file_id(wav1)
    assert results[0]["file_id"] == wav1_id

    r_post = client.post("/api/search", json={"query": "laser", "k": 5, "mode": "hybrid"})
    assert r_post.status_code == 200
    assert r_post.json()["count"] >= 1

    # 3. File detail & user data update
    r_file = client.get(f"/api/files/{wav1_id}")
    assert r_file.status_code == 200
    assert r_file.json()["filename"] == "laser_zap_01.wav"

    r_user = client.put(
        f"/api/files/{wav1_id}/user",
        json={"favorite": True, "user_tags": ["laser", "weapon"], "note": "Punchy"},
    )
    assert r_user.status_code == 200
    assert r_user.json()["favorite"] is True

    # 4. Waveform peaks
    r_peaks = client.get(f"/api/peaks/{wav1_id}")
    assert r_peaks.status_code == 200
    assert len(r_peaks.json()["peaks"]) == 200

    # 5. Audio streaming with HTTP Range request
    r_range = client.get(f"/api/audio/{wav1_id}", headers={"Range": "bytes=0-1023"})
    assert r_range.status_code == 206
    assert r_range.headers["Accept-Ranges"] == "bytes"
    assert r_range.headers["Content-Range"].startswith("bytes 0-1023/")
    assert len(r_range.content) == 1024

    # 6. Audio streaming for AIFF triggers on-the-fly WAV transcoding + Range support
    aiff_id = compute_file_id(aiff_path)
    r_trans = client.get(f"/api/audio/{aiff_id}", headers={"Range": "bytes=0-511"})
    assert r_trans.status_code == 206
    assert r_trans.headers["content-type"].startswith("audio/wav")
    assert r_trans.content[:4] == b"RIFF"

    # 7. Find similar & upload reference
    r_sim = client.get(f"/api/similar/{wav1_id}")
    assert r_sim.status_code == 200
    assert r_sim.json()["count"] == 1

    with wav1.open("rb") as f_up:
        r_up = client.post(
            "/api/similar/upload",
            files={"file": ("ref.wav", f_up, "audio/wav")},
        )
    assert r_up.status_code == 200
    assert r_up.json()["count"] == 2

    # 8. Empty-query browse pagination & sort modes
    r_browse_p1 = client.post(
        "/api/search",
        json={"query": "", "k": 1, "offset": 0, "sort": "duration_asc"},
    )
    assert r_browse_p1.status_code == 200
    b1 = r_browse_p1.json()
    assert b1["total"] == 2
    assert b1["count"] == 1

    r_browse_p2 = client.post(
        "/api/search",
        json={"query": "", "k": 1, "offset": 1, "sort": "duration_asc"},
    )
    assert r_browse_p2.status_code == 200
    b2 = r_browse_p2.json()
    assert b2["total"] == 2
    assert b2["count"] == 1
    assert b1["results"][0]["file_id"] != b2["results"][0]["file_id"]
    assert b1["results"][0]["duration_s"] <= b2["results"][0]["duration_s"]

    # 9. Library root management & background indexing endpoints
    r_lib = client.get("/api/library")
    assert r_lib.status_code == 200
    assert len(r_lib.json()["roots"]) == 1

    extra_root = tmp_path / "extra_sfx"
    write_sine_wav(extra_root / "UI" / "button_pop.wav", freq_hz=500.0, duration_s=0.4)
    r_add = client.post("/api/library/roots", json={"path": str(extra_root)})
    assert r_add.status_code == 200
    assert len(r_add.json()["roots"]) == 2
    assert cfg.settings_file.is_file()

    r_rem = client.request(
        "DELETE",
        "/api/library/roots",
        json={"path": str(extra_root), "remove_indexed_files": True},
    )
    assert r_rem.status_code == 200
    assert len(r_rem.json()["roots"]) == 1


@pytest.mark.asyncio
async def test_mcp_server_tools(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    data_dir = tmp_path / "data"
    wav1 = write_sine_wav(
        lib_root / "Ambience" / "forest_wind_trees.wav", freq_hz=300.0, duration_s=2.0
    )

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)

    mcp = create_mcp_server(config=cfg, store=store, embedder=embedder)
    tools = await mcp.list_tools()
    tool_names = {t.name for t in tools}
    assert {
        "search_sounds",
        "batch_search",
        "find_similar",
        "get_sound",
        "library_stats",
    } <= tool_names

    res_stats = await mcp.call_tool("library_stats", {})
    stats_content = getattr(res_stats, "content", res_stats)
    stats_txt = stats_content[0].text
    assert "ok_files" in stats_txt

    res_search = await mcp.call_tool("search_sounds", {"query": "forest wind", "k": 5})
    search_content = getattr(res_search, "content", res_search)
    search_txt = search_content[0].text
    parsed = json.loads(search_txt)
    assert parsed["count"] == 1
    assert parsed["results"][0]["file_id"] == compute_file_id(wav1)

    res_batch = await mcp.call_tool("batch_search", {"queries": ["forest", "wind"], "k": 3})
    batch_content = getattr(res_batch, "content", res_batch)
    batch_parsed = json.loads(batch_content[0].text)
    assert len(batch_parsed["batches"]) == 2

    res_get = await mcp.call_tool("get_sound", {"file_id": compute_file_id(wav1)})
    get_content = getattr(res_get, "content", res_get)
    get_parsed = json.loads(get_content[0].text)
    assert get_parsed["filename"] == "forest_wind_trees.wav"


@pytest.mark.skipif(
    not torch.cuda.is_available(),
    reason="Real CLAP fp16 vs fp32 parity check requires CUDA GPU",
)
def test_real_clap_determinism_and_fp16_vs_fp32_agreement() -> None:
    sr = 48000
    t = np.arange(sr * 4, dtype=np.float32) / float(sr)
    window = (0.4 * np.sin(2.0 * np.pi * 220.0 * t) + 0.2 * np.cos(2.0 * np.pi * 550.0 * t)).astype(
        np.float32
    )

    emb_fp16 = ClapEmbedder(model_id="laion/larger_clap_general", precision="fp16", batch_size=4)
    assert emb_fp16.embedding_dim == 512

    # 1. Determinism check: embedding the same window twice returns identical vectors
    v1 = emb_fp16.embed_windows([window])[0]
    v2 = emb_fp16.embed_windows([window])[0]
    assert np.allclose(v1, v2, atol=1e-6), f"Max diff: {np.max(np.abs(v1 - v2))}"
    assert pytest.approx(float(np.linalg.norm(v1)), rel=1e-4) == 1.0

    # 2. Query embedding determinism & LRU cache
    q1 = emb_fp16.embed_text("slow wooden floor creak")
    q2 = emb_fp16.embed_text("slow wooden floor creak")
    assert np.array_equal(q1, q2)
    assert pytest.approx(float(np.linalg.norm(q1)), rel=1e-4) == 1.0

    # 3. fp16 vs fp32 cosine similarity check (Section 12 item 2)
    emb_fp32 = ClapEmbedder(model_id="laion/larger_clap_general", precision="fp32", batch_size=4)
    v_fp32 = emb_fp32.embed_windows([window])[0]
    q_fp32 = emb_fp32.embed_text("slow wooden floor creak")

    audio_cos = float(np.dot(v1, v_fp32))
    text_cos = float(np.dot(q1, q_fp32))
    assert audio_cos > 0.999, f"fp16 vs fp32 audio cosine similarity too low: {audio_cos}"
    assert text_cos > 0.999, f"fp16 vs fp32 text cosine similarity too low: {text_cos}"
