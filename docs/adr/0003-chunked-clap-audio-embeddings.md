# ADR 0003: Deterministic chunked CLAP embeddings via ffmpeg worker pipeline

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Sound-effects libraries range from 100 ms UI clicks to 10-minute ambiences and multi-take field recordings, encoded in diverse containers and bit depths (`.wav`, `.flac`, `.aiff`, `.mp3`, `.ogg`, `.opus`, `.m4a`). CLAP (`laion/larger_clap_general`) operates on fixed-duration 48 kHz mono audio inputs (~10 seconds) and defaults to random cropping on longer inputs during standard feature extraction, which makes indexing non-deterministic and drops most of a long file's content. Furthermore, decoding compressed or high-bit-depth audio on the main thread starves the 8 GB VRAM GPU.

## Decision

1. **Decode pipeline:** Use a CPU worker pool (`cpu_count - 2`) running `ffmpeg` subprocesses to decode every audio file into 48 kHz, mono, `float32` PCM via pipes, feeding a bounded queue into the GPU embedding thread.
2. **Deterministic windowing:** Slice decoded PCM into fixed 10 s windows with a 5 s hop before passing audio to the CLAP processor:
   - Files shorter than 10 s produce a single chunk using deterministic repeat-padding.
   - Files exceeding `max_chunks_per_file` (default 120, i.e., ~10 minutes at 5 s hop) dynamically increase the hop size so 120 windows span the entire file evenly.
   - Because every window passed to the model is already at most the model's native 10 s input length, random cropping in the processor is bypassed; embedding the same window twice is strictly deterministic.
3. **Inference & pooling:** Run `laion/larger_clap_general` (512-d) in batches of 32 windows under `torch.inference_mode()` with configurable `fp16` (default) or `fp32` precision. L2-normalize every chunk vector `vec`, and compute `file_vec` as the L2-normalized mean of the file's chunk vectors.

## Consequences

- Long files are searchable across their full duration without exploding index size (bounded at 120 vectors per file).
- File-level similarity (`file_vec` vs `file_vec`) and moment-level search/similarity (`chunks.vec`) are both supported from a single embedding pass.
- Decoupling CPU `ffmpeg` decoding from GPU inference via a bounded queue maximizes throughput on an 8 GB VRAM card without unbounded RAM growth.
- Startup assertions and unit tests must verify that the Hugging Face `ClapFeatureExtractor` configuration matches the 48 kHz / 10 s deterministic window assumption.
