"""Library directory walker, Windows path normalization, and manifest diffing."""

from __future__ import annotations

import hashlib
import os
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ScannedFile:
    file_id: str
    path: str
    root: str
    size_bytes: int
    mtime_ns: int
    ext: str


@dataclass(frozen=True)
class ManifestEntry:
    file_id: str
    path: str
    size_bytes: int
    mtime_ns: int
    status: str


@dataclass(frozen=True)
class ScanDiff:
    to_index: list[ScannedFile]
    unchanged_ids: list[str]
    missing_ids: list[str]


def to_os_path(path: str | Path) -> str:
    raw = str(path)
    if sys.platform == "win32":
        if raw.startswith("\\\\?\\"):
            return raw
        abs_path = os.path.abspath(raw.replace("/", "\\"))
        if len(abs_path) >= 248:
            if abs_path.startswith("\\\\"):
                return "\\\\?\\UNC\\" + abs_path[2:]
            return "\\\\?\\" + abs_path
        return abs_path
    return os.path.abspath(raw)


def normalize_path(path: str | Path) -> str:
    raw = str(path)
    if raw.startswith("\\\\?\\UNC\\"):
        raw = "\\\\" + raw[8:]
    elif raw.startswith("\\\\?\\"):
        raw = raw[4:]
    resolved = os.path.abspath(raw).replace("\\", "/")
    while "//" in resolved[2:]:
        resolved = resolved[:2] + resolved[2:].replace("//", "/")
    if len(resolved) >= 2 and resolved[1] == ":":
        resolved = resolved[0].upper() + resolved[1:]
    return resolved.rstrip("/") if len(resolved) > 3 else resolved


def compute_file_id(path: str | Path) -> str:
    norm = normalize_path(path).lower()
    return hashlib.sha256(norm.encode("utf-8", errors="surrogatepass")).hexdigest()[:24]


def walk_roots(
    roots: Iterable[str | Path],
    extensions: Iterable[str],
    limit: int | None = None,
) -> list[ScannedFile]:
    allowed_exts = {ext.lower() if ext.startswith(".") else f".{ext.lower()}" for ext in extensions}
    results: list[ScannedFile] = []
    seen_ids: set[str] = set()

    for root in roots:
        norm_root = normalize_path(root)
        os_root = to_os_path(norm_root)
        if not os.path.exists(os_root):
            continue

        for dirpath, dirnames, filenames in os.walk(os_root):
            dirnames.sort()
            filenames.sort()
            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in allowed_exts:
                    continue
                full_os_path = os.path.join(dirpath, fname)
                try:
                    st = os.stat(full_os_path)
                except OSError:
                    continue

                norm_file = normalize_path(full_os_path)
                fid = compute_file_id(norm_file)
                if fid in seen_ids:
                    continue
                seen_ids.add(fid)

                results.append(
                    ScannedFile(
                        file_id=fid,
                        path=norm_file,
                        root=norm_root,
                        size_bytes=int(st.st_size),
                        mtime_ns=int(st.st_mtime_ns),
                        ext=ext.lstrip("."),
                    )
                )
                if limit is not None and len(results) >= limit:
                    return results

    return results


def diff_manifest(
    scanned: Iterable[ScannedFile],
    existing: dict[str, ManifestEntry],
    reindex: bool = False,
    mark_missing: bool = True,
) -> ScanDiff:
    to_index: list[ScannedFile] = []
    unchanged_ids: list[str] = []
    seen_ids: set[str] = set()

    for item in scanned:
        seen_ids.add(item.file_id)
        prev = existing.get(item.file_id)
        if (
            not reindex
            and prev is not None
            and prev.status == "ok"
            and prev.size_bytes == item.size_bytes
            and prev.mtime_ns == item.mtime_ns
            and prev.path.lower() == item.path.lower()
        ):
            unchanged_ids.append(item.file_id)
        else:
            to_index.append(item)

    missing_ids: list[str] = []
    if mark_missing:
        for fid, prev in existing.items():
            if fid not in seen_ids and prev.status != "missing":
                missing_ids.append(fid)

    return ScanDiff(
        to_index=to_index,
        unchanged_ids=unchanged_ids,
        missing_ids=missing_ids,
    )
