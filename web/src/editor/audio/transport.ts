/**
 * Preview playback via the Web Audio API for the SFX Studio Editor.
 *
 * Two modes share one output and feed an AnalyserNode for real-time metering:
 * - 'loop': the baked/processed loop buffer on repeat (seamless-loop audition).
 * - 'file': the full processed buffer, one-shot from a cursor position to EOF.
 */
export class StudioTransport {
  private ctx: AudioContext;
  private gain: GainNode;
  public readonly analyser: AnalyserNode;
  private source: AudioBufferSourceNode | null = null;
  private loopBuffer: AudioBuffer | null = null;
  private fileBuffer: AudioBuffer | null = null;
  private _mode: "loop" | "file" = "loop";
  private startedAt = 0;
  private startOffset = 0;
  private _playing = false;

  /** Fired when 'file' playback reaches the end of the buffer. */
  onEnded: (() => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.76;
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  get playing(): boolean {
    return this._playing;
  }

  get mode(): "loop" | "file" {
    return this._mode;
  }

  setVolume(linearGain: number): void {
    this.gain.gain.setTargetAtTime(
      Math.max(0, Math.min(2, linearGain)),
      this.ctx.currentTime,
      0.015
    );
  }

  makeBuffer(
    channels: readonly Float32Array[],
    sampleRate: number
  ): AudioBuffer {
    const numCh = Math.max(1, channels.length);
    const len = Math.max(1, channels[0]?.length ?? 1);
    const b = this.ctx.createBuffer(numCh, len, sampleRate);
    channels.forEach((ch, i) => b.getChannelData(i).set(ch));
    return b;
  }

  /**
   * Swap in a newly baked loop buffer. If loop playback is running it
   * continues at the same relative position; file audition is left alone.
   */
  setLoopAudio(buffer: AudioBuffer): void {
    const pos = this.positionSamples();
    const wasLooping = this._playing && this._mode === "loop";
    if (wasLooping) {
      this.stopInternal(false);
    }
    this.loopBuffer = buffer;
    if (wasLooping && buffer.length > 0) {
      this.startSource("loop", pos !== null ? pos % buffer.length : 0);
    }
  }

  /** The full processed file, for click-to-audition outside the loop or one-shot mode. */
  setFileAudio(buffer: AudioBuffer): void {
    const pos = this.positionSamples();
    const wasFilePlaying = this._playing && this._mode === "file";
    if (wasFilePlaying) {
      this.stopInternal(false);
    }
    this.fileBuffer = buffer;
    if (wasFilePlaying && buffer.length > 0) {
      this.startSource(
        "file",
        pos !== null ? Math.min(pos, buffer.length - 1) : 0
      );
    }
  }

  playLoop(offsetSamples = 0): void {
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.startSource("loop", offsetSamples);
  }

  playFile(fromSample: number): void {
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.startSource("file", fromSample);
  }

  private startSource(mode: "loop" | "file", offsetSamples: number): void {
    const buffer = mode === "loop" ? this.loopBuffer : this.fileBuffer;
    if (!buffer || buffer.length === 0) {
      return;
    }
    this.stopInternal(false);
    const offset = Math.max(
      0,
      Math.min(Math.round(offsetSamples), buffer.length - 1)
    );
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = mode === "loop";
    if (mode === "file") {
      s.onended = () => {
        if (this.source !== s) {
          return;
        }
        this.source = null;
        this._playing = false;
        this.startOffset = buffer.length;
        this.onEnded?.();
      };
    }
    s.connect(this.gain);
    s.start(0, offset / buffer.sampleRate);
    this._mode = mode;
    this.startedAt = this.ctx.currentTime;
    this.startOffset = offset;
    this.source = s;
    this._playing = true;
  }

  stop(): void {
    this.stopInternal(true);
  }

  /** Pause keeps the offset — the next play resumes where it stopped. */
  pause(): void {
    const pos = this.positionSamples();
    this.stopInternal(false);
    if (pos !== null) {
      this.startOffset = pos;
    }
  }

  private stopInternal(resetOffset: boolean): void {
    const s = this.source;
    this.source = null;
    try {
      s?.stop();
    } catch {
      // already stopped
    }
    s?.disconnect();
    this._playing = false;
    if (resetOffset) {
      this.startOffset = 0;
    }
  }

  /** Jump to a sample offset within the active buffer; seamless if playing. */
  seek(samples: number): void {
    const b = this.active();
    if (!b || b.length === 0) {
      return;
    }
    this.startOffset = Math.max(
      0,
      Math.min(Math.round(samples), b.length - 1)
    );
    if (this._playing) {
      this.startSource(this._mode, this.startOffset);
    }
  }

  private active(): AudioBuffer | null {
    return this._mode === "loop" ? this.loopBuffer : this.fileBuffer;
  }

  /** Live position within the active buffer, or null when stopped. */
  playheadSamples(): number | null {
    const b = this.active();
    if (!this._playing || !b || b.length === 0) {
      return null;
    }
    const t =
      (this.ctx.currentTime - this.startedAt) * b.sampleRate + this.startOffset;
    return this._mode === "loop" ? t % b.length : Math.min(t, b.length);
  }

  /** Position within the active buffer — playhead when playing, offset when paused. */
  positionSamples(): number | null {
    const b = this.active();
    if (!b || b.length === 0) {
      return null;
    }
    if (this._playing) {
      return this.playheadSamples();
    }
    return this.startOffset;
  }

  dispose(): void {
    this.stopInternal(true);
    try {
      this.gain.disconnect();
      this.analyser.disconnect();
    } catch {
      // ignore
    }
  }
}
