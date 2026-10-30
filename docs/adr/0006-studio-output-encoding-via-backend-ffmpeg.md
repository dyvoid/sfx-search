# ADR 0006: Studio Output Encoding via Backend ffmpeg

- **Status:** Accepted
- **Date:** 2026-10-30

## Context

The Studio wrote every output as 24-bit WAV: Save to Library uploaded a WAV to `save-edited`, and
Download (then "Export WAV") encoded a WAV in the browser and downloaded it at once. Users want to
choose the format and compression: WAV bit depth, FLAC, and lossy formats with a bitrate.

Lossy and FLAC encoding need an encoder. The browser has none built in; WASM encoders would be new
npm dependencies and a heavier bundle. The backend already requires `ffmpeg` on PATH for decoding,
and the local builds in use ship `flac`, `libmp3lame`, `libvorbis` and `libopus`.

## Decision

1. **Encoding happens in the backend with `ffmpeg`** (`backend/transcode.py`). The browser always
   sends a lossless WAV (24-bit, or 32-bit float when that is the target).
2. **Formats:** WAV 16/24/32-float, FLAC 16/24 (compression level 8), MP3, Ogg Vorbis and Opus at
   a fixed set of bitrates. The backend validates the spec (`parse_spec`) and rejects anything else.
3. **Save to Library:** `save-edited` takes `format`, `bit_depth` and `bitrate`, encodes, and
   writes the file with the matching extension. Overwrite without a name still requires the
   source to have that extension.
4. **Download:** `POST /api/transcode` returns the encoded bytes; nothing is kept on disk. WAV is
   still encoded in the browser, so it needs no round trip.
5. **One dialog** (Save to library / Download, for the edited sound or the variation takes) holds
   filename and format. The last choice is remembered per browser. Drag-out to a DAW stays 24-bit
   WAV.

## Consequences

- No new dependencies; formats are limited to what the installed `ffmpeg` can encode.
- Downloading a non-WAV format now needs the backend running, which the app always has.
- The upload limit (256 MB) applies to the lossless upload, so very long 32-bit float outputs can
  hit it sooner than before.
