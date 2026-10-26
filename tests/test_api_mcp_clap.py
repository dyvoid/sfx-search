"""Tests for FastAPI endpoints (including HTTP Range streaming and transcoding), MCP tools, and real CLAP GPU determinism/fp16 parity."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

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


def test_health_endpoint(tmp_path: Path) -> None:
    cfg = Config(
        library=LibraryConfig(roots=[str(tmp_path / "sfx")]),
        paths=PathsConfig(data_dir=str(tmp_path / "data")),
    )
    store = SfxStore(cfg.db_dir)
    app = create_app(config=cfg, store=store, embedder=FakeEmbedder(embedding_dim=16))
    client = TestClient(app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


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
    assert r_lib.json()["missing_roots"] == []

    # Configured roots that no longer exist on disk are reported as missing.
    cfg.library.roots.append(str(tmp_path / "gone_sfx"))
    r_lib2 = client.get("/api/library")
    assert r_lib2.status_code == 200
    assert r_lib2.json()["missing_roots"] == [str(tmp_path / "gone_sfx").replace("\\", "/")]
    cfg.library.roots.pop()

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

    # 10. Save edited/looped audio back to library with immediate indexing & metadata inheritance
    looped_wav_tmp = tmp_path / "looped_export.wav"
    write_sine_wav(looped_wav_tmp, freq_hz=660.0, duration_s=1.0)
    with looped_wav_tmp.open("rb") as f_loop:
        r_save = client.post(
            f"/api/files/{wav1_id}/save-edited",
            params={"suffix": ".loop", "overwrite": "false", "copy_user_data": "true"},
            files={"file": ("laser_zap_01.loop.wav", f_loop, "audio/wav")},
        )
    assert r_save.status_code == 200
    saved_payload = r_save.json()
    assert saved_payload["saved"] is True
    saved_hit = saved_payload["hit"]
    assert saved_hit["filename"] == "laser_zap_01.loop.wav"
    assert saved_hit["favorite"] is True
    assert "loop" in saved_hit["user_tags"]
    assert "laser" in saved_hit["user_tags"]
    assert (lib_root / "SciFi" / "laser_zap_01.loop.wav").is_file()

    # Second save with same suffix auto-increments (_2) instead of colliding
    with looped_wav_tmp.open("rb") as f_loop2:
        r_save2 = client.post(
            f"/api/files/{wav1_id}/save-edited",
            params={"suffix": ".loop", "overwrite": "false"},
            files={"file": ("laser_zap_01.loop.wav", f_loop2, "audio/wav")},
        )
    assert r_save2.status_code == 200
    assert r_save2.json()["hit"]["filename"] == "laser_zap_01.loop_2.wav"


def _save_edited_client(tmp_path: Path) -> tuple[TestClient, Path, Path, str, str]:
    lib_root = tmp_path / "sfx"
    wav = write_sine_wav(lib_root / "SciFi" / "zap.wav", freq_hz=660.0, duration_s=1.0)
    aiff = lib_root / "SciFi" / "door.aiff"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(wav), "-acodec", "pcm_s16be"]
        + [str(aiff)],
        check=True,
    )
    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(tmp_path / "data")),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)
    client = TestClient(create_app(config=cfg, store=store, embedder=embedder))
    return client, wav, aiff, compute_file_id(wav), compute_file_id(aiff)


def _post_edit(client: TestClient, fid: str, tmp_path: Path, **params: str) -> Any:
    payload = tmp_path / "payload.wav"
    write_sine_wav(payload, freq_hz=440.0, duration_s=0.5)
    with payload.open("rb") as f:
        return client.post(
            f"/api/files/{fid}/save-edited",
            params=params,
            files={"file": ("x.wav", f, "audio/wav")},
        )


def test_audio_range_header_edge_cases(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    wav = write_sine_wav(lib_root / "tone.wav", duration_s=1.0)
    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(tmp_path / "data")),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)
    client = TestClient(create_app(config=cfg, store=store, embedder=embedder))
    fid = compute_file_id(wav)
    size = wav.stat().st_size
    url = f"/api/audio/{fid}"

    for bad in ("bytes=-0", "bytes=5-2", "bytes=abc", "bytes=-abc", f"bytes={size}-"):
        assert client.get(url, headers={"Range": bad}).status_code == 416, bad

    r_suffix = client.get(url, headers={"Range": "bytes=-100"})
    assert r_suffix.status_code == 206
    assert r_suffix.headers["Content-Range"] == f"bytes {size - 100}-{size - 1}/{size}"
    assert len(r_suffix.content) == 100

    r_open = client.get(url, headers={"Range": "bytes=10-"})
    assert r_open.status_code == 206
    assert len(r_open.content) == size - 10

    r_past_end = client.get(url, headers={"Range": f"bytes=0-{size * 10}"})
    assert r_past_end.status_code == 206
    assert len(r_past_end.content) == size

    # Multi-range requests are served as the first range only.
    r_multi = client.get(url, headers={"Range": "bytes=0-9,20-29"})
    assert r_multi.status_code == 206
    assert len(r_multi.content) == 10


def test_save_edited_custom_name(tmp_path: Path) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    d = wav.parent

    r = _post_edit(client, wid, tmp_path, name="My Take.WAV")
    assert r.status_code == 200
    assert r.json()["hit"]["filename"] == "My Take.wav"
    # Collision without overwrite auto-increments, and never touches the source.
    r = _post_edit(client, wid, tmp_path, name="My Take")
    assert r.json()["hit"]["filename"] == "My Take_2.wav"
    src_bytes = wav.read_bytes()
    r = _post_edit(client, wid, tmp_path, name="zap")
    assert r.json()["hit"]["filename"] == "zap_2.wav"
    assert wav.read_bytes() == src_bytes
    # Overwrite replaces the named file in place.
    r = _post_edit(client, wid, tmp_path, name="My Take", overwrite="true")
    assert r.json()["hit"]["filename"] == "My Take.wav"
    assert not (d / "My Take_3.wav").exists()

    # Traversal / junk is flattened into the source directory or rejected.
    r = _post_edit(client, wid, tmp_path, name="../../evil")
    assert r.status_code == 200
    assert Path(r.json()["hit"]["path"]).parent == d
    assert not (tmp_path / "evil.wav").exists()
    assert _post_edit(client, wid, tmp_path, name="..  ").status_code == 400
    assert _post_edit(client, wid, tmp_path, name="///").status_code == 400


@pytest.mark.parametrize("bad", ["CON", "nul", "COM1", "lpt9", "con.take", "Aux ", "COM\u00b9"])
def test_save_edited_windows_reserved_names(tmp_path: Path, bad: str) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    r = _post_edit(client, wid, tmp_path, name=bad)
    assert r.status_code == 200
    stem = Path(r.json()["hit"]["filename"]).stem
    assert stem.split(".")[0].strip().upper() not in {
        "CON",
        "NUL",
        "COM1",
        "LPT9",
        "AUX",
        "COM\u00b9",
    }


def test_save_edited_overwrite_never_writes_wav_into_non_wav_source(tmp_path: Path) -> None:
    client, _wav, aiff, _wid, aid = _save_edited_client(tmp_path)
    before = aiff.read_bytes()
    r = _post_edit(client, aid, tmp_path, overwrite="true")
    assert r.status_code == 400
    assert aiff.read_bytes() == before
    # A custom name is fine: writes a sibling .wav.
    r = _post_edit(client, aid, tmp_path, overwrite="true", name="door_edit")
    assert r.status_code == 200
    assert aiff.read_bytes() == before


def test_save_edited_rejects_non_wav_payload(tmp_path: Path) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    before = wav.read_bytes()
    junk = {"file": ("x.wav", b"garbage" * 50, "audio/wav")}
    url = f"/api/files/{wid}/save-edited"
    r = client.post(url, params={"overwrite": "true"}, files=junk)
    assert r.status_code == 400
    assert wav.read_bytes() == before
    r = client.post(url, params={"name": "junk"}, files=junk)
    assert r.status_code == 400
    assert not (wav.parent / "junk.wav").exists()
    assert not list(wav.parent.glob("*.tmp"))


def test_save_edited_overwrite_keeps_target_user_data(tmp_path: Path) -> None:
    client, _wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    oid = _post_edit(client, wid, tmp_path, name="other").json()["hit"]["file_id"]
    body = {"favorite": True, "user_tags": ["keep"], "note": "mine"}
    assert client.put(f"/api/files/{oid}/user", json=body).status_code == 200
    hit = _post_edit(client, wid, tmp_path, name="other", overwrite="true").json()["hit"]
    assert hit["file_id"] == oid
    assert hit["favorite"] is True
    assert hit["note"] == "mine"
    assert hit["user_tags"] == ["keep", "loop"]


def test_save_edited_rejects_riff_header_with_junk_body(tmp_path: Path) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    before = wav.read_bytes()
    junk = b"RIFF\x00\x00\x00\x00WAVE" + b"x" * 100
    r = client.post(
        f"/api/files/{wid}/save-edited",
        params={"overwrite": "true"},
        files={"file": ("x.wav", junk, "audio/wav")},
    )
    assert r.status_code == 400
    assert wav.read_bytes() == before
    assert not list(wav.parent.glob("*.tmp"))


def test_save_edited_ignores_orphan_target_user_data(tmp_path: Path) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    body = {"favorite": False, "user_tags": ["src"], "note": "srcnote"}
    assert client.put(f"/api/files/{wid}/user", json=body).status_code == 200
    oid = _post_edit(client, wid, tmp_path, name="other").json()["hit"]["file_id"]
    stale = {"favorite": True, "user_tags": ["stale"], "note": "stale"}
    assert client.put(f"/api/files/{oid}/user", json=stale).status_code == 200
    (wav.parent / "other.wav").unlink()
    hit = _post_edit(client, wid, tmp_path, name="other").json()["hit"]
    assert hit["note"] == "srcnote"
    assert hit["favorite"] is False
    assert hit["user_tags"] == ["src", "loop"]


def test_save_edited_long_name_is_bounded(tmp_path: Path) -> None:
    client, wav, _aiff, wid, _aid = _save_edited_client(tmp_path)
    r = _post_edit(client, wid, tmp_path, name="a" * 600)
    assert r.status_code == 200
    assert len(Path(r.json()["hit"]["filename"]).name) <= 255


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

    with pytest.raises(Exception, match="Error executing tool batch_search"):
        await mcp.call_tool("batch_search", {"queries": [f"q{i}" for i in range(21)]})

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
