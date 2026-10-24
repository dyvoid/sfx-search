/** Minimal PCM WAV encoder (RIFF/WAVE). Supports 16/24-bit PCM and 32-bit float. */

export type WavFormat = "int16" | "int24" | "float32";

const BYTES_PER_SAMPLE: Record<WavFormat, number> = {
  int16: 2,
  int24: 3,
  float32: 4,
};

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  format: WavFormat = "int16"
): ArrayBuffer {
  if (channels.length === 0) {
    throw new RangeError("no channels");
  }
  const numCh = channels.length;
  const frames = channels[0].length;
  const bps = BYTES_PER_SAMPLE[format];
  const blockAlign = numCh * bps;
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, format === "float32" ? 3 : 1, true); // PCM=1, IEEE float=3
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bps * 8, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (format === "float32") {
        v.setFloat32(o, s, true);
        o += 4;
      } else if (format === "int16") {
        v.setInt16(o, Math.round(s * 32767), true);
        o += 2;
      } else {
        const x = Math.round(s * 8388607);
        v.setUint8(o, x & 0xff);
        v.setUint8(o + 1, (x >> 8) & 0xff);
        v.setUint8(o + 2, (x >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return buf;
}
