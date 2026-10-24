/** AudioContext management and audio decoding for the SFX Studio Editor. */

let ctx: AudioContext | null = null;

export function editorAudioContext(): AudioContext {
  if (!ctx) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new AudioCtx();
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

export async function decodeAudioArrayBuffer(
  data: ArrayBuffer
): Promise<AudioBuffer> {
  return editorAudioContext().decodeAudioData(data);
}

export async function decodeAudioUrl(
  url: string,
  signal?: AbortSignal
): Promise<AudioBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return decodeAudioArrayBuffer(buf);
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  return decodeAudioArrayBuffer(data);
}

export function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const copy = new Float32Array(buffer.length);
    copy.set(buffer.getChannelData(c));
    out.push(copy);
  }
  return out;
}

export function formatDuration(samples: number, sampleRate: number): string {
  const s = Math.max(0, samples / Math.max(1, sampleRate));
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(2);
  return `${m}:${rem.padStart(5, "0")}`;
}

export function formatSecondsCompact(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = (s - m * 60).toFixed(2);
    return `${m}:${rem.padStart(5, "0")}`;
  }
  return `${s.toFixed(3)}s`;
}
