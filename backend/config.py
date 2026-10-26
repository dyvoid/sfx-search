"""Configuration models and loader for sfx-search."""

from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

DEFAULT_EXTENSIONS: list[str] = [
    ".wav",
    ".flac",
    ".aif",
    ".aiff",
    ".mp3",
    ".ogg",
    ".opus",
    ".m4a",
    ".wma",
    ".aac",
]


class LibraryConfig(BaseModel):
    roots: list[str] = Field(default_factory=list)
    extensions: list[str] = Field(default_factory=lambda: list(DEFAULT_EXTENSIONS))


class PathsConfig(BaseModel):
    data_dir: str = "./data"
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"


class EmbeddingConfig(BaseModel):
    model_id: str = "laion/larger_clap_general"
    precision: Literal["fp16", "fp32"] = "fp16"
    window_s: float = Field(default=10.0, gt=0)
    hop_s: float = Field(default=5.0, gt=0)
    max_chunks_per_file: int = Field(default=120, ge=1)
    batch_size: int = 32


class IndexingConfig(BaseModel):
    decode_workers: int = Field(default_factory=lambda: max(1, (os.cpu_count() or 4) - 2))
    commit_every_files: int = Field(default=50, ge=1)


class SearchConfig(BaseModel):
    vector_candidates: int = Field(default=300, ge=1)
    keyword_candidates: int = 100
    rrf_k: int = Field(default=60, gt=0)
    default_k: int = 30
    vector_weight: float = 1.0
    keyword_weight: float = 1.0


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = Field(default=8765, ge=1, le=65535)


class Config(BaseModel):
    library: LibraryConfig = Field(default_factory=LibraryConfig)
    paths: PathsConfig = Field(default_factory=PathsConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    indexing: IndexingConfig = Field(default_factory=IndexingConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    variants: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @property
    def db_dir(self) -> Path:
        return Path(self.paths.data_dir) / "lancedb"

    @property
    def peaks_dir(self) -> Path:
        return Path(self.paths.data_dir) / "peaks"

    @property
    def transcode_dir(self) -> Path:
        return Path(self.paths.data_dir) / "transcode_cache"

    @property
    def settings_file(self) -> Path:
        return Path(self.paths.data_dir) / "settings.json"

    def save_library_roots(self, roots: list[str]) -> None:
        from .scan import normalize_path

        cleaned: list[str] = []
        seen: set[str] = set()
        for r in roots:
            if not r or not str(r).strip():
                continue
            norm = normalize_path(r)
            low = norm.lower()
            if low not in seen:
                seen.add(low)
                cleaned.append(norm)
        self.library.roots = cleaned
        sf = self.settings_file
        sf.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {}
        if sf.is_file():
            try:
                payload = json.loads(sf.read_text(encoding="utf-8"))
            except Exception:
                payload = {}
        payload["roots"] = cleaned
        tmp = sf.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(sf)

    def with_overrides(self, overrides: dict[str, Any]) -> Config:
        data = self.model_dump()
        _deep_merge(data, overrides)
        return Config.model_validate(data)

    def apply_variant(self, variant_name: str) -> Config:
        if variant_name not in self.variants:
            raise KeyError(
                f"Unknown config variant '{variant_name}'. Available: {list(self.variants)}"
            )
        return self.with_overrides(self.variants[variant_name])


def _deep_merge(base: dict[str, Any], updates: dict[str, Any]) -> None:
    for key, val in updates.items():
        if isinstance(val, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], val)
        else:
            base[key] = val


def load_config(config_path: str | Path | None = None) -> Config:
    env_path = os.environ.get("SFXSEARCH_CONFIG")
    resolved: Path | None = None
    if config_path is not None:
        resolved = Path(config_path)
    elif env_path:
        resolved = Path(env_path)
    else:
        for candidate in (Path("config.toml"), Path("config.example.toml")):
            if candidate.is_file():
                resolved = candidate
                break

    if resolved is not None and resolved.is_file():
        with resolved.open("rb") as f:
            raw = tomllib.load(f)
        cfg = Config.model_validate(raw)
        if not Path(cfg.paths.data_dir).is_absolute():
            cfg.paths.data_dir = str((resolved.parent / cfg.paths.data_dir).resolve())
    else:
        cfg = Config()
        cfg.paths.data_dir = str(Path(cfg.paths.data_dir).resolve())

    if cfg.settings_file.is_file():
        try:
            saved = json.loads(cfg.settings_file.read_text(encoding="utf-8"))
            if isinstance(saved.get("roots"), list):
                cfg.library.roots = [str(r) for r in saved["roots"] if str(r).strip()]
        except Exception:
            pass

    return cfg
