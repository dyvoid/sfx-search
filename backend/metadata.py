"""Tag, BWF bext, iXML, filename, and folder metadata extraction."""

from __future__ import annotations

import json
import re
import struct
import unicodedata
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

from .scan import normalize_path, to_os_path

NOISE_TOKENS: set[str] = {
    "final",
    "v1",
    "v2",
    "v3",
    "v4",
    "copy",
    "wav",
    "flac",
    "mp3",
    "aif",
    "aiff",
    "ogg",
    "opus",
    "m4a",
    "wma",
    "aac",
    "stereo",
    "mono",
    "master",
    "render",
    "export",
    "new",
    "old",
    "edit",
    "edited",
    "mix",
    "sfx",
}

_CAMEL_RE = re.compile(
    r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])"
)
_SPLIT_RE = re.compile(r"[\W_]+")


def _split_words(text: str) -> list[str]:
    """Split on non-word chars, but keep combining marks (Mn/Mc) inside words."""
    parts: list[str] = []
    cur: list[str] = []
    for ch in text:
        if ch != "_" and (
            _SPLIT_RE.fullmatch(ch) is None or unicodedata.category(ch) in ("Mn", "Mc")
        ):
            cur.append(ch)
        elif cur:
            parts.append("".join(cur))
            cur = []
    if cur:
        parts.append("".join(cur))
    return parts


def _fold_accents(token: str) -> str:
    decomposed = unicodedata.normalize("NFKD", token)
    return unicodedata.normalize(
        "NFC", "".join(c for c in decomposed if not "\u0300" <= c <= "\u036f")
    )


_IXML_INTEREST_TAGS: set[str] = {
    "category",
    "subcategory",
    "catid",
    "fxname",
    "description",
    "keywords",
    "notes",
    "note",
    "project",
    "scene",
    "take",
    "tape",
    "designer",
    "library",
    "manufacturer",
    "show",
    "tracktitle",
    "wildtrack",
    "circletake",
}


def tokenize_identifier(text: str) -> list[str]:
    if not text:
        return []
    raw_parts = _split_words(unicodedata.normalize("NFC", text))
    tokens: list[str] = []
    for part in raw_parts:
        if not part:
            continue
        subparts = _CAMEL_RE.split(part)
        for sub in subparts:
            low = sub.lower().strip()
            if not low or low.isdigit() or len(low) < 2 or low in NOISE_TOKENS:
                continue
            tokens.append(low)
            folded = _fold_accents(low)
            if (
                folded != low
                and len(folded) >= 2
                and not folded.isdigit()
                and folded not in NOISE_TOKENS
            ):
                tokens.append(folded)
    return tokens


def parse_wav_chunks(path: str | Path) -> dict[str, str]:
    extracted: dict[str, str] = {}
    os_path = to_os_path(path)
    try:
        with open(os_path, "rb") as f:
            header = f.read(12)
            if len(header) < 12:
                return extracted
            riff_id, _, wave_id = struct.unpack("<4sI4s", header)
            if riff_id not in (b"RIFF", b"RF64") or wave_id != b"WAVE":
                return extracted

            ds64_sizes: dict[bytes, int] = {}
            while True:
                chunk_hdr = f.read(8)
                if len(chunk_hdr) < 8:
                    break
                chunk_id, chunk_size = struct.unpack("<4sI", chunk_hdr)
                cid = chunk_id.decode("latin-1", errors="ignore").strip()

                if cid == "ds64" and 28 <= chunk_size <= 1024 * 1024:
                    data = f.read(chunk_size)
                    ds64_sizes = _parse_ds64_bytes(data)
                    if chunk_size % 2 == 1:
                        f.seek(1, 1)
                    continue

                if chunk_size == 0xFFFFFFFF:
                    real_size = ds64_sizes.get(chunk_id)
                    if real_size is None:
                        break
                    chunk_size = real_size

                if cid.lower() == "bext" and 0 < chunk_size <= 2 * 1024 * 1024:
                    data = f.read(chunk_size)
                    _parse_bext_bytes(data, extracted)
                elif cid.lower() == "ixml" and 0 < chunk_size <= 4 * 1024 * 1024:
                    data = f.read(chunk_size)
                    _parse_ixml_bytes(data, extracted)
                elif chunk_size > 4 * 1024 * 1024 * 1024:
                    break
                else:
                    f.seek(chunk_size, 1)

                if chunk_size % 2 == 1:
                    f.seek(1, 1)
    except OSError:
        return extracted

    return extracted


def _parse_ds64_bytes(data: bytes) -> dict[bytes, int]:
    """Parse an RF64 ds64 chunk into a chunk-id -> real-size map (incl. b'data')."""
    sizes: dict[bytes, int] = {}
    if len(data) < 28:
        return sizes
    _, data_size, _ = struct.unpack("<QQQ", data[:24])
    sizes[b"data"] = int(data_size)
    table_len = struct.unpack("<I", data[24:28])[0]
    offset = 28
    for _ in range(min(table_len, 1024)):
        if offset + 12 > len(data):
            break
        cid, csize = struct.unpack("<4sQ", data[offset : offset + 12])
        sizes[cid] = int(csize)
        offset += 12
    return sizes


def _clean_c_str(raw: bytes) -> str:
    idx = raw.find(b"\x00")
    if idx != -1:
        raw = raw[:idx]
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc).strip()
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore").strip()


def _parse_bext_bytes(data: bytes, out: dict[str, str]) -> None:
    if len(data) >= 256:
        desc = _clean_c_str(data[0:256])
        if desc:
            out["bext_description"] = desc
    if len(data) >= 288:
        orig = _clean_c_str(data[256:288])
        if orig:
            out["bext_originator"] = orig
    if len(data) >= 320:
        orig_ref = _clean_c_str(data[288:320])
        if orig_ref:
            out["bext_originator_reference"] = orig_ref
    if len(data) > 602:
        coding_hist = _clean_c_str(data[602:])
        if coding_hist:
            out["bext_coding_history"] = coding_hist


def _parse_ixml_bytes(data: bytes, out: dict[str, str]) -> None:
    text = _clean_c_str(data)
    if not text:
        return
    start = text.find("<")
    if start > 0:
        text = text[start:]
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return

    for elem in root.iter():
        tag_name = elem.tag.split("}")[-1].strip().lower()
        val = (elem.text or "").strip()
        if not val:
            continue
        if tag_name in _IXML_INTEREST_TAGS or len(val) <= 256:
            key = f"ixml_{tag_name}"
            if key in out:
                if val not in out[key]:
                    out[key] = f"{out[key]} {val}"
            else:
                out[key] = val


def extract_metadata(
    path: str | Path,
    root: str | Path | None = None,
    probe_tags: dict[str, str] | None = None,
) -> tuple[str, str]:
    norm_path = normalize_path(path)
    p = Path(norm_path)
    stem = p.stem

    merged_tags: dict[str, str] = {}
    if probe_tags:
        for k, v in probe_tags.items():
            if v and str(v).strip():
                merged_tags[str(k)] = str(v).strip()

    if p.suffix.lower() in (".wav", ".bwf"):
        wav_tags = parse_wav_chunks(path)
        for k, v in wav_tags.items():
            if v and k not in merged_tags:
                merged_tags[k] = v

    filename_tokens = tokenize_identifier(stem)

    rel_parts: list[str]
    if root:
        norm_root = normalize_path(root)
        parent_str = normalize_path(p.parent)
        root_low = norm_root.lower().rstrip("/")
        parent_low = parent_str.lower()
        if parent_low == root_low or parent_low.startswith(root_low + "/"):
            rel_str = parent_str[len(norm_root) :].lstrip("/")
            rel_parts = (
                [part for part in rel_str.split("/") if part] if rel_str else [p.parent.name]
            )
        else:
            rel_parts = list(p.parent.parts[-4:])
    else:
        rel_parts = list(p.parent.parts[-4:])

    folder_components = rel_parts[-4:]
    folder_tokens: list[str] = []
    for comp in folder_components:
        if comp.endswith(":"):
            continue
        folder_tokens.extend(tokenize_identifier(comp))

    tag_tokens: list[str] = []
    for val in merged_tags.values():
        tag_tokens.extend(tokenize_identifier(val))

    search_text = _dedup_join([*filename_tokens, *folder_tokens, *tag_tokens])
    tags_json = json.dumps(merged_tags, ensure_ascii=False, sort_keys=True)
    return tags_json, search_text


def _dedup_join(tokens: Iterable[str]) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    for tok in tokens:
        low = tok.lower().strip()
        if low and low not in seen:
            seen.add(low)
            ordered.append(low)
    return " ".join(ordered)
