/**
 * Output format chosen in the Save / Download dialog. WAV is encoded in the
 * browser; everything else is sent to the backend as lossless WAV and
 * encoded there with ffmpeg (POST /api/transcode, or save-edited directly).
 */
import { encodeWav, WavFormat } from "./wav";

export type OutputFormat = "wav" | "flac" | "mp3" | "ogg" | "opus";

export interface OutputSpec {
  format: OutputFormat;
  /** WAV and FLAC; 32 means 32-bit float (WAV only). */
  bitDepth: number;
  /** Lossy formats, kbps. */
  bitrate: number;
}

export const FORMAT_CHOICES: { value: OutputFormat; label: string }[] = [
  { value: "wav", label: "WAV" },
  { value: "flac", label: "FLAC" },
  { value: "mp3", label: "MP3" },
  { value: "ogg", label: "OGG" },
  { value: "opus", label: "Opus" },
];

/** Mirrors backend/transcode.py; the backend rejects anything else. */
export const BIT_DEPTHS: Partial<Record<OutputFormat, number[]>> = {
  wav: [16, 24, 32],
  flac: [16, 24],
};

export const BITRATES: Partial<Record<OutputFormat, number[]>> = {
  mp3: [128, 192, 256, 320],
  ogg: [96, 128, 192, 256, 320],
  opus: [64, 96, 128, 192, 256],
};

const EXTENSIONS: Record<OutputFormat, string> = {
  wav: ".wav",
  flac: ".flac",
  mp3: ".mp3",
  ogg: ".ogg",
  opus: ".opus",
};

export const DEFAULT_OUTPUT_SPEC: OutputSpec = {
  format: "wav",
  bitDepth: 24,
  bitrate: 192,
};

export function extensionOf(spec: OutputSpec): string {
  return EXTENSIONS[spec.format];
}

/** Keep the spec valid when the format changes (e.g. 32-bit WAV → FLAC). */
export function normalizeSpec(spec: OutputSpec): OutputSpec {
  const depths = BIT_DEPTHS[spec.format];
  const rates = BITRATES[spec.format];
  return {
    format: spec.format,
    bitDepth:
      depths && !depths.includes(spec.bitDepth) ? 24 : spec.bitDepth,
    bitrate: rates && !rates.includes(spec.bitrate) ? 192 : spec.bitrate,
  };
}

/** Swap any known audio extension on `name` for the spec's one. */
export function withExtension(name: string, spec: OutputSpec): string {
  return `${stripExtension(name)}${extensionOf(spec)}`;
}

export function stripExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of Object.values(EXTENSIONS)) {
    if (lower.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
  }
  return name;
}

export function describeSpec(spec: OutputSpec): string {
  if (BIT_DEPTHS[spec.format]) {
    const depth = spec.bitDepth === 32 ? "32-bit float" : `${spec.bitDepth}-bit`;
    return `${spec.format.toUpperCase()} ${depth}`;
  }
  return `${spec.format === "opus" ? "Opus" : spec.format.toUpperCase()} ${spec.bitrate} kbps`;
}

/** The WAV sent to the backend: float only when 32-bit float is wanted. */
export function uploadWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  spec: OutputSpec
): ArrayBuffer {
  const fmt: WavFormat =
    spec.format === "wav" && spec.bitDepth === 32 ? "float32" : "int24";
  return encodeWav(channels, sampleRate, fmt);
}

/** Query parameters understood by save-edited and /api/transcode. */
export function specParams(spec: OutputSpec): Record<string, string> {
  return BIT_DEPTHS[spec.format]
    ? { format: spec.format, bit_depth: String(spec.bitDepth) }
    : { format: spec.format, bitrate: String(spec.bitrate) };
}

/** Encode for download: WAV locally, everything else via the backend. */
export async function encodeForDownload(
  channels: readonly Float32Array[],
  sampleRate: number,
  spec: OutputSpec
): Promise<Blob> {
  if (spec.format === "wav") {
    const fmt: WavFormat =
      spec.bitDepth === 16 ? "int16" : spec.bitDepth === 32 ? "float32" : "int24";
    return new Blob([encodeWav(channels, sampleRate, fmt)], {
      type: "audio/wav",
    });
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([uploadWav(channels, sampleRate, spec)], { type: "audio/wav" }),
    "export.wav"
  );
  const res = await fetch(
    `/api/transcode?${new URLSearchParams(specParams(spec))}`,
    { method: "POST", body: form }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Encoding failed: ${res.statusText}`);
  }
  return res.blob();
}

const STORAGE_KEY = "sfx.studio.outputSpec";

/** Last used format, per viewer; any storage failure falls back to WAV 24. */
export function loadOutputSpec(): OutputSpec {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OutputSpec>;
      if (p.format && p.format in EXTENSIONS) {
        return normalizeSpec({ ...DEFAULT_OUTPUT_SPEC, ...p } as OutputSpec);
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_OUTPUT_SPEC;
}

export function storeOutputSpec(spec: OutputSpec): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
  } catch {
    // ignore
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
