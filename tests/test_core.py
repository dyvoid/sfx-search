"""Unit tests for scanning, Windows paths, metadata, features, windowing, store, indexer, and search."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest
from sfxsearch.config import Config, IndexingConfig, LibraryConfig, PathsConfig
from sfxsearch.embed import slice_audio_windows
from sfxsearch.eval.harness import (
    EvalQuery,
    evaluate_queries,
)
from sfxsearch.features import (
    compute_loop_score,
    extract_features,
)
from sfxsearch.indexer import run_indexer
from sfxsearch.metadata import extract_metadata, parse_wav_chunks, tokenize_identifier
from sfxsearch.scan import (
    compute_file_id,
    normalize_path,
    to_os_path,
    walk_roots,
)
from sfxsearch.search import SearchEngine
from sfxsearch.store import ModelMismatchError, SearchFilters, SfxStore

from .conftest import FakeEmbedder, append_bwf_and_ixml_chunks, write_sine_wav


def test_windows_path_normalization_and_file_id() -> None:
    p1 = r"C:\Projects\SFX\Foley\Wood\Creak_01.WAV"
    p2 = "c:/projects/sfx/foley/wood/creak_01.wav"
    p3 = r"\\?\C:\Projects\SFX\Foley\Wood\Creak_01.WAV"

    assert normalize_path(p1) == "C:/Projects/SFX/Foley/Wood/Creak_01.WAV"
    assert normalize_path(p3) == "C:/Projects/SFX/Foley/Wood/Creak_01.WAV"
    assert compute_file_id(p1) == compute_file_id(p2)
    assert compute_file_id(p1) == compute_file_id(p3)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows path semantics")
def test_to_os_path_always_extended_length_prefixed() -> None:
    short = to_os_path(r"C:\SFX\hit.wav")
    assert short == "\\\\?\\C:\\SFX\\hit.wav"
    unc = to_os_path(r"\\NAS\share\sfx\hit.wav")
    assert unc == "\\\\?\\UNC\\NAS\\share\\sfx\\hit.wav"
    already = to_os_path(r"\\?\C:\SFX\hit.wav")
    assert already == r"\\?\C:\SFX\hit.wav"


def test_long_and_unicode_windows_paths(tmp_path: Path) -> None:
    deep_parts = [" Folder_Üñîçødé_" + ("A" * 35) for _ in range(7)]
    deep_dir = tmp_path
    for part in deep_parts:
        deep_dir = deep_dir / part.strip()

    os_dir = to_os_path(deep_dir)
    os.makedirs(os_dir, exist_ok=True)
    target_wav = deep_dir / "long_unicode_creak_éè_01.wav"
    os_wav = Path(to_os_path(target_wav))
    write_sine_wav(os_wav, freq_hz=330.0, duration_s=0.5)

    scanned = walk_roots([tmp_path], extensions=[".wav"])
    assert len(scanned) == 1
    assert scanned[0].path.endswith("long_unicode_creak_éè_01.wav")
    assert len(scanned[0].path) > 250


def test_slice_audio_windows_short_exact_and_cap() -> None:
    sr = 48000
    # 1) Short file (< 10s) -> single window
    short_audio = np.ones(sr * 3, dtype=np.float32)
    w_short = slice_audio_windows(
        short_audio, sample_rate=sr, window_s=10.0, hop_s=5.0, max_chunks_per_file=120
    )
    assert len(w_short) == 1
    assert w_short[0].start_s == 0.0
    assert pytest.approx(w_short[0].end_s, rel=1e-4) == 3.0

    # 2) 20s file with 10s window, 5s hop -> chunks at [0..10], [5..15], [10..20]
    med_audio = np.ones(sr * 20, dtype=np.float32)
    w_med = slice_audio_windows(
        med_audio, sample_rate=sr, window_s=10.0, hop_s=5.0, max_chunks_per_file=120
    )
    assert len(w_med) == 3
    assert [w.start_s for w in w_med] == [0.0, 5.0, 10.0]
    assert [w.end_s for w in w_med] == [10.0, 15.0, 20.0]

    # 3) Long file exceeding max_chunks_per_file -> capped at max_chunks_per_file and spans whole file
    long_audio = np.ones(sr * 100, dtype=np.float32)
    w_capped = slice_audio_windows(
        long_audio, sample_rate=sr, window_s=10.0, hop_s=5.0, max_chunks_per_file=8
    )
    assert len(w_capped) == 8
    assert w_capped[0].start_s == 0.0
    assert pytest.approx(w_capped[-1].end_s, rel=1e-3) == 100.0
    for w in w_capped:
        assert w.samples.shape[0] <= sr * 10


def test_metadata_tokenizer_and_bwf_ixml_extraction(tmp_path: Path) -> None:
    tokens = tokenize_identifier("AmbienceForest_WindThroughTrees_v2_final_01")
    assert "ambience" in tokens
    assert "forest" in tokens
    assert "wind" in tokens
    assert "trees" in tokens
    assert "final" not in tokens
    assert "v2" not in tokens
    assert "01" not in tokens

    wav_file = tmp_path / "Foley" / "Wood" / "FloorBoardCreak_Slow_03.wav"
    write_sine_wav(wav_file, freq_hz=220.0, duration_s=1.0)
    append_bwf_and_ixml_chunks(
        wav_file,
        bext_description="Creaking oak plank under heavy boot",
        bext_originator="BoomLibrary",
        ixml_category="WOOD",
        ixml_subcategory="MOVEMENT",
        ixml_keywords="plank oak creak",
    )

    parsed_chunks = parse_wav_chunks(wav_file)
    assert "oak plank" in parsed_chunks.get("bext_description", "")
    assert parsed_chunks.get("ixml_category") == "WOOD"

    tags_json, search_text = extract_metadata(
        wav_file, root=tmp_path, probe_tags={"artist": "FoleyArtist"}
    )
    tags = json.loads(tags_json)
    assert tags["bext_originator"] == "BoomLibrary"
    assert "floor" in search_text
    assert "creak" in search_text
    assert "oak" in search_text
    assert "movement" in search_text
    assert "foley" in search_text


def test_acoustic_features_and_loop_score() -> None:
    sr = 48000
    # Continuous phase-locked sine wave over 2.0 seconds -> high loop score
    t = np.arange(sr * 2, dtype=np.float32) / float(sr)
    seamless_loop = (0.5 * np.sin(2.0 * np.pi * 200.0 * t)).astype(np.float32)
    feats_loop = extract_features(seamless_loop, sample_rate=sr)
    assert feats_loop.duration_s == pytest.approx(2.0, rel=1e-4)
    assert feats_loop.peak_dbfs == pytest.approx(-6.02, abs=0.2)
    assert feats_loop.lufs_integrated is not None
    assert feats_loop.loop_score is not None and feats_loop.loop_score > 0.85

    # One-shot impact (loud burst in first 200ms, silence at tail) -> very low loop score
    one_shot = np.zeros(sr * 2, dtype=np.float32)
    one_shot[: int(0.2 * sr)] = 0.8 * np.sin(2.0 * np.pi * 120.0 * t[: int(0.2 * sr)])
    loop_oneshot = compute_loop_score(one_shot, sample_rate=sr)
    assert loop_oneshot is not None and loop_oneshot < 0.15


def test_indexer_manifest_resumability_and_error_handling(tmp_path: Path) -> None:
    lib_root = tmp_path / "library"
    data_dir = tmp_path / "data"

    f1 = write_sine_wav(lib_root / "Wood" / "creak_floor_01.wav", freq_hz=200.0, duration_s=1.2)
    f2 = write_sine_wav(lib_root / "Metal" / "clang_door_01.wav", freq_hz=880.0, duration_s=2.0)
    corrupt = lib_root / "Broken" / "corrupt_audio.wav"
    corrupt.parent.mkdir(parents=True, exist_ok=True)
    corrupt.write_bytes(b"NOT_A_VALID_RIFF_WAV_FILE_AT_ALL")

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
        indexing=IndexingConfig(decode_workers=2, commit_every_files=2),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)

    # First run indexes 2 ok files and records 1 error file
    stats1 = run_indexer(config=cfg, store=store, embedder=embedder)
    assert stats1.scanned_count == 3
    assert stats1.indexed_ok == 2
    assert stats1.indexed_errors == 1

    # Add user data (favorite + tag) to f1
    f1_id = compute_file_id(f1)
    store.set_user_data(f1_id, favorite=True, user_tags=["hero", "wood"], note="Great creak")

    # Second run skips unchanged ok files
    stats2 = run_indexer(config=cfg, store=store, embedder=embedder)
    assert stats2.skipped_unchanged == 2
    assert stats2.indexed_ok == 0

    # Delete f2 from disk; third run marks f2 as missing and excludes it from search
    compute_file_id(f2)
    f2.unlink()
    stats3 = run_indexer(config=cfg, store=store, embedder=embedder)
    assert stats3.marked_missing == 1

    lib_stats = store.get_library_stats()
    assert lib_stats["ok_files"] == 1
    assert lib_stats["error_files"] == 1
    assert lib_stats["missing_files"] == 1
    assert lib_stats["favorites_count"] == 1

    # Verify user_data survived re-indexing
    stats4 = run_indexer(config=cfg, store=store, embedder=embedder, reindex=True)
    assert stats4.indexed_ok == 1
    u_map = store.get_user_data_map([f1_id])
    assert u_map[f1_id].favorite is True
    assert u_map[f1_id].user_tags == ["hero", "wood"]


def test_model_mismatch_protection(tmp_path: Path) -> None:
    store = SfxStore(tmp_path / "lancedb")
    store.verify_or_init_tables(embedding_model="model-a", embedding_dim=16)

    with pytest.raises(ModelMismatchError):
        store.verify_or_init_tables(embedding_model="model-b", embedding_dim=16)

    with pytest.raises(ModelMismatchError):
        store.verify_or_init_tables(embedding_model="model-a", embedding_dim=32)


def test_hybrid_search_filters_and_similarity(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    data_dir = tmp_path / "data"

    w1 = write_sine_wav(
        lib_root / "Foley" / "Wood" / "wooden_floor_creak_slow.wav", freq_hz=180.0, duration_s=4.5
    )
    w2 = write_sine_wav(
        lib_root / "Foley" / "Wood" / "wooden_chair_squeak_short.wav", freq_hz=210.0, duration_s=1.0
    )
    write_sine_wav(
        lib_root / "Impacts" / "Metal" / "heavy_metal_anvil_clang.wav",
        freq_hz=1200.0,
        duration_s=2.5,
    )

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)

    engine = SearchEngine(config=cfg, store=store, embedder=embedder)

    # Keyword + Hybrid search
    hits_kw = engine.search("wooden floor creak", k=10, mode="keyword_only")
    assert len(hits_kw) >= 1
    assert hits_kw[0].file_id == compute_file_id(w1)

    # Inline duration filter & negative exclusion
    hits_filtered = engine.search("wooden -chair dur:3-6", k=10, mode="hybrid")
    returned_ids = {h.file_id for h in hits_filtered}
    assert compute_file_id(w1) in returned_ids
    assert compute_file_id(w2) not in returned_ids

    # Find similar by file_id
    sim_hits = engine.find_similar(compute_file_id(w1), k=5)
    assert len(sim_hits) == 2
    assert all(h.file_id != compute_file_id(w1) for h in sim_hits)

    # Find similar by chunk_idx
    sim_chunk_hits = engine.find_similar(compute_file_id(w1), k=5, chunk_idx=0)
    assert len(sim_chunk_hits) == 2

    # Eval harness check
    eq = [
        EvalQuery(
            id="q-wood",
            query="wooden floor creak",
            relevant=["**/Wood/wooden_floor_*.wav"],
        )
    ]
    eval_summary = evaluate_queries(cfg, store, eq, embedder=embedder, variant_name="hybrid")
    assert eval_summary.mean_recall_at_10 == 1.0
    assert eval_summary.mean_mrr > 0.0


def test_folder_filter_and_folder_index(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    data_dir = tmp_path / "data"

    w1 = write_sine_wav(
        lib_root / "Foley" / "Wood" / "creak_floor.wav", freq_hz=200.0, duration_s=1.0
    )
    w2 = write_sine_wav(
        lib_root / "Foley" / "Wood" / "Deep" / "creak_deep.wav",
        freq_hz=210.0,
        duration_s=1.0,
    )
    w3 = write_sine_wav(lib_root / "Impacts" / "clang_hit.wav", freq_hz=800.0, duration_s=1.0)

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
    )
    store = SfxStore(cfg.db_dir)
    run_indexer(config=cfg, store=store, embedder=FakeEmbedder(embedding_dim=16))
    engine = SearchEngine(config=cfg, store=store, embedder=FakeEmbedder(embedding_dim=16))

    foley_wood = normalize_path(str(lib_root / "Foley" / "Wood"))
    impacts = normalize_path(str(lib_root / "Impacts"))

    folder_paths = {e["path"] for e in store.get_folder_index()}
    assert foley_wood in folder_paths
    assert f"{foley_wood}/Deep" in folder_paths
    assert impacts in folder_paths

    # A selected folder matches itself and all descendant folders
    hits = engine.search("", k=10, mode="keyword_only", filters=SearchFilters(folders=[foley_wood]))
    ids = {h.file_id for h in hits}
    assert compute_file_id(w1) in ids
    assert compute_file_id(w2) in ids
    assert compute_file_id(w3) not in ids

    # Multi-select unions folders; matching is case-insensitive
    hits_multi = engine.search(
        "",
        k=10,
        mode="keyword_only",
        filters=SearchFilters(folders=[foley_wood.lower(), impacts]),
    )
    ids_multi = {h.file_id for h in hits_multi}
    assert ids_multi == {
        compute_file_id(w1),
        compute_file_id(w2),
        compute_file_id(w3),
    }


def test_parse_query_phrases_exclusions_and_filters() -> None:
    from sfxsearch.search import parse_query

    # Quoted phrases are masked before operator extraction: "-" and "dur:"
    # inside quotes must not become exclusion terms or filters.
    p = parse_query('"big - whoosh" dog dur:3-6 -cat')
    assert p.filters.required_phrases == ["big - whoosh"]
    assert p.filters.excluded_terms == ["cat"]
    assert p.filters.min_duration == 3.0
    assert p.filters.max_duration == 6.0
    assert "big - whoosh" in p.semantic_query
    assert "dog" in p.semantic_query
    assert "-cat" not in p.semantic_query

    # Hyphenated words outside quotes are not exclusions either.
    p2 = parse_query("kick-drum")
    assert p2.filters.excluded_terms == []
    assert p2.semantic_query == "kick-drum"

    # Filter-only queries must not feed filter tokens into the CLAP embedder.
    p3 = parse_query("fmt:wav -dog")
    assert p3.semantic_query == ""
    assert p3.filters.excluded_terms == ["dog"]
    assert p3.filters.formats == ["wav"]


def test_reciprocal_rank_fusion_ordering_and_weights() -> None:
    from sfxsearch.search import reciprocal_rank_fusion

    # Doc "b" ranks #1 in both lists and must win outright.
    fused = reciprocal_rank_fusion(["a", "b", "c"], ["b", "d", "a"], rrf_k=60)
    assert fused[0][0] == "b"
    assert fused[-1][0] == "c"

    # A higher keyword weight must be able to reorder the result.
    fused_kw = reciprocal_rank_fusion(
        ["a", "b"], ["b", "a"], rrf_k=1, vector_weight=1.0, keyword_weight=5.0
    )
    assert fused_kw[0][0] == "b"


def test_find_similar_invalid_chunk_idx_raises(tmp_path: Path) -> None:
    lib_root = tmp_path / "sfx"
    data_dir = tmp_path / "data"

    w1 = write_sine_wav(lib_root / "a" / "tone_a.wav", freq_hz=200.0, duration_s=1.0)
    write_sine_wav(lib_root / "b" / "tone_b.wav", freq_hz=400.0, duration_s=1.0)

    cfg = Config(
        library=LibraryConfig(roots=[str(lib_root)]),
        paths=PathsConfig(data_dir=str(data_dir)),
    )
    store = SfxStore(cfg.db_dir)
    embedder = FakeEmbedder(embedding_dim=16)
    run_indexer(config=cfg, store=store, embedder=embedder)

    engine = SearchEngine(config=cfg, store=store, embedder=embedder)
    fid = compute_file_id(w1)

    with pytest.raises(ValueError, match="chunk_idx"):
        engine.find_similar(fid, k=5, chunk_idx=999)
