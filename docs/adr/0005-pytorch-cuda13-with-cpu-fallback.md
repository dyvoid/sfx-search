# ADR 0005: PyTorch CUDA 13.0 build, with automatic CPU fallback for CLAP

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

The project pinned PyTorch to the `cu128` wheel index. That line stopped at torch 2.11 and gets no
further releases. Its kernels cover `sm_75` and newer (RTX 20-series up), so on a GTX 1070
(`sm_61`) `torch.cuda.is_available()` is still true, CLAP is placed on the GPU, and indexing dies
with `CUDA error: no kernel image is available for execution on the device`.

The maintained Windows/Linux indexes are `cu126` (keeps Pascal, but has no Blackwell / RTX 50
kernels and is the legacy line) and `cu130` / `cu132` (RTX 20 through 50, no Pascal). The user
runs an RTX 50-series machine and prefers forward compatibility over old cards.

Measured on an i5-9600K, CLAP on the CPU embeds about 4.9 ten-second windows per second and
turns a text query into a vector in about 0.3 s: fine for search, and a first full scan of a
large library takes hours rather than being impossible. Later scans only process changes.

## Decision

1. Use the `cu130` PyTorch index (torch 2.14.x). Requires an NVIDIA driver with CUDA 13 support
   (R580 or newer).
2. `embed.resolve_device()` chooses the CLAP device: an explicit request wins; otherwise CUDA
   only when the build has kernels for the GPU's compute capability (cubin same major, equal or
   lower minor; or PTX at or below it) and a tiny CUDA op succeeds; otherwise the CPU, with a
   warning that names the GPU and the reason.
3. CLAP stays on for every machine. Hybrid search depends on it (it fuses CLAP matches with
   keyword matches), so dropping it on old hardware would quietly degrade search to keywords.

## Consequences

- RTX 20/30/40/50 run CLAP on the GPU; Pascal and older GPUs, or machines without a CUDA 13
  driver, run it on the CPU instead of crashing.
- The project is back on a PyTorch line that still receives releases.
- First indexing on CPU-only machines is slow (hours for very large libraries). If that becomes
  a problem, options are a smaller CLAP checkpoint or a `cu126` install for that machine; both
  are out of scope here.
