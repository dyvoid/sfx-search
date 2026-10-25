import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Dices,
  Download,
  FolderOpen,
  GripHorizontal,
  Heart,
  Maximize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Square,
  Upload,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { revealInExplorer, saveEditedFileToLibrary } from "../api";
import { SpectrumMeter } from "../components/SpectrumMeter";
import { SearchHit } from "../types";
import {
  channelsOf,
  decodeAudioFile,
  decodeAudioUrl,
  editorAudioContext,
  formatDuration,
} from "./audio/decoder";
import {
  applyDspChain,
  DEFAULT_EQ_SPEC,
  DEFAULT_SHAPER_SPEC,
  detectSilenceTrimMs,
  EqSpec,
  isEqActive,
  isShaperActive,
  measureSignalStats,
  ShaperSpec,
  SignalStats,
} from "./audio/dspChain";
import {
  bakeLoop,
  BakeMode,
  evaluateBakedSeam,
  FadeCurve,
  ResolvedMode,
  SeamMetrics,
  snapToZeroCrossing,
} from "./audio/loopdsp";
import { LoopCandidate, monoMix } from "./audio/search";
import { StudioTransport } from "./audio/transport";
import {
  DEFAULT_VARIATION_SPEC,
  GeneratedVariation,
  generateVariationBatch,
  synthesizeVariation,
  VariationSpec,
} from "./audio/variations";
import { encodeWav, WavFormat } from "./audio/wav";
import { EditorWaveform, EditorWaveformHandle } from "./EditorWaveform";
import {
  EqResponseGraph,
  SeamScope,
  VariationWaveCardCanvas,
} from "./SeamScope";
import type { SearchMessage } from "./workers/search.worker";

export type EditorModuleId = "loop" | "shaper" | "eq" | "variations";

const LabelWithTip: React.FC<{ label: string; tip: string }> = ({
  label,
  tip,
}) => (
  <span className="sfx-rack-label sfx-label-with-tip">
    <span>{label}</span>
    <span className="sfx-tip-wrap" tabIndex={0} aria-label={tip}>
      <CircleHelp size={11} className="sfx-tip-icon" />
      <span className="sfx-tip-bubble">{tip}</span>
    </span>
  </span>
);

interface StudioViewProps {
  hit: SearchHit | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrevHit: () => void;
  onNextHit: () => void;
  onBackToLibrary: () => void;
  onFindSimilarFromAudio: (file: File) => void;
  onSavedToLibrary: (newHit: SearchHit) => void;
}

export const StudioView: React.FC<StudioViewProps> = ({
  hit,
  hasPrev,
  hasNext,
  onPrevHit,
  onNextHit,
  onBackToLibrary,
  onFindSimilarFromAudio,
  onSavedToLibrary,
}) => {
  const waveRef = useRef<EditorWaveformHandle | null>(null);
  const transportRef = useRef<StudioTransport | null>(null);
  const searchWorkerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bakeTimerRef = useRef<number>(0);

  // Source audio state
  const [sourceChannels, setSourceChannels] = useState<Float32Array[] | null>(
    null
  );
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [baseName, setBaseName] = useState<string>("loop");
  const [decoding, setDecoding] = useState<boolean>(false);
  const [decodeError, setDecodeError] = useState<string>("");

  // Active module tab
  const [activeModule, setActiveModule] = useState<EditorModuleId>("loop");

  // Module 1: Seamless Loop state (disabled by default until enabled or auto-found)
  const [loopEnabled, setLoopEnabled] = useState<boolean>(false);
  const [loopStart, setLoopStart] = useState<number>(0);
  const [loopEnd, setLoopEnd] = useState<number>(0);
  const [fadeMs, setFadeMs] = useState<number>(350);
  const [fadeCurve, setFadeCurve] = useState<FadeCurve>("equal-power");
  const [bakeMode, setBakeMode] = useState<BakeMode>("auto");
  const [snapZero, setSnapZero] = useState<boolean>(true);
  const [activeMarker, setActiveMarker] = useState<"start" | "end">("start");

  // Auto-loop search state
  const [minLoopSec, setMinLoopSec] = useState<number>(1.5);
  const [searchWindowMs, setSearchWindowMs] = useState<number>(400);
  const [searchModePref, setSearchModePref] = useState<
    "auto" | "pairs" | "fixed-end"
  >("auto");
  const [searching, setSearching] = useState<boolean>(false);
  const [searchProgress, setSearchProgress] = useState<number>(0);
  const [candidates, setCandidates] = useState<LoopCandidate[]>([]);
  const [candIndex, setCandIndex] = useState<number>(-1);

  // Module 2: Trim & Shaper state
  const [shaper, setShaper] = useState<ShaperSpec>(DEFAULT_SHAPER_SPEC);

  // Module 3: Tone & EQ state
  const [eq, setEq] = useState<EqSpec>(DEFAULT_EQ_SPEC);

  // Module 4: Procedural Variations & Round-Robin Generator state
  const [varSpec, setVarSpec] = useState<VariationSpec>(DEFAULT_VARIATION_SPEC);
  const [variations, setVariations] = useState<GeneratedVariation[]>([]);
  const [activeVarIdx, setActiveVarIdx] = useState<number>(-1);
  const [savingBatch, setSavingBatch] = useState<boolean>(false);
  const [isTestingRR, setIsTestingRR] = useState<boolean>(false);
  const rrTestingRef = useRef<boolean>(false);
  const rrTimerRef = useRef<number>(0);

  // Processed & Baked buffers
  const [processedChannels, setProcessedChannels] = useState<
    Float32Array[] | null
  >(null);
  const [bakedChannels, setBakedChannels] = useState<Float32Array[] | null>(
    null
  );
  const [resolvedMode, setResolvedMode] = useState<ResolvedMode>("head");
  const [fadeAtHead, setFadeAtHead] = useState<boolean>(false);
  const [seamMetrics, setSeamMetrics] = useState<SeamMetrics>({
    stepDelta: 0,
    slopeContinuity: 1,
    energyMatch: 1,
    seamScore: 1,
  });
  const [signalStats, setSignalStats] = useState<SignalStats>({
    peakDbfs: -120,
    rmsDbfs: -120,
    crestDb: 0,
  });

  // Transport state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [auditionMode, setAuditionMode] = useState<"loop" | "file">("loop");
  const [timePosText, setTimePosText] = useState<string>("0:00.00");
  const cursorRef = useRef<number>(0);
  const cursorVisibleRef = useRef<boolean>(false);

  // Export & Library save state (24-bit studio WAV standard)
  const exportFormat: WavFormat = "int24";
  const [saveSuffix, setSaveSuffix] = useState<string>(".edit");
  const [savingToLibrary, setSavingToLibrary] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const fadeSamples = useMemo(
    () => Math.max(0, Math.round((fadeMs / 1000) * sampleRate)),
    [fadeMs, sampleRate]
  );

  // Ensure Web Audio transport exists
  const ensureTransport = useCallback((): StudioTransport => {
    if (!transportRef.current) {
      const t = new StudioTransport(editorAudioContext());
      t.onEnded = () => {
        setIsPlaying(false);
      };
      transportRef.current = t;
    }
    return transportRef.current;
  }, []);

  useEffect(() => {
    return () => {
      searchWorkerRef.current?.terminate();
      window.clearTimeout(bakeTimerRef.current);
      window.clearTimeout(rrTimerRef.current);
      rrTestingRef.current = false;
      transportRef.current?.dispose();
      transportRef.current = null;
    };
  }, []);

  // Load selected hit from `/api/audio/{file_id}` when `hit` changes
  useEffect(() => {
    if (!hit) {
      return;
    }
    const controller = new AbortController();
    setDecoding(true);
    setDecodeError("");
    setStatusMsg(`Loading ${hit.filename}…`);
    transportRef.current?.stop();
    setIsPlaying(false);
    searchWorkerRef.current?.terminate();
    setSearching(false);

    const url = `/api/audio/${encodeURIComponent(hit.file_id)}`;
    decodeAudioUrl(url, controller.signal)
      .then((buf) => {
        if (controller.signal.aborted) {
          return;
        }
        const chs = channelsOf(buf);
        const sr = buf.sampleRate;
        const len = buf.length;
        setSourceChannels(chs);
        setSampleRate(sr);
        setBaseName(hit.filename.replace(/\.[^.]+$/, "") || "sound");

        // Initialize loop region to full file (or best chunk if very long file)
        setLoopStart(0);
        setLoopEnd(len);
        setCandidates([]);
        setCandIndex(-1);
        setShaper(DEFAULT_SHAPER_SPEC);
        setEq(DEFAULT_EQ_SPEC);
        setVariations([]);
        setActiveVarIdx(-1);
        cursorRef.current = 0;
        cursorVisibleRef.current = false;
        setTimePosText("0:00.00");
        setDecoding(false);
        setStatusMsg(
          `${hit.filename} · ${buf.numberOfChannels}ch · ${(sr / 1000).toFixed(
            1
          )} kHz · ${formatDuration(len, sr)}`
        );
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return;
        }
        setDecoding(false);
        const msg = err instanceof Error ? err.message : String(err);
        setDecodeError(msg);
        setStatusMsg(`Failed to decode audio: ${msg}`);
      });

    return () => {
      controller.abort();
    };
  }, [hit?.file_id]);

  // Also allow loading an external local file via Open or Drop
  const loadLocalFile = useCallback(async (file: File) => {
    setDecoding(true);
    setDecodeError("");
    setStatusMsg(`Decoding ${file.name}…`);
    transportRef.current?.stop();
    setIsPlaying(false);
    searchWorkerRef.current?.terminate();
    setSearching(false);
    try {
      const buf = await decodeAudioFile(file);
      const chs = channelsOf(buf);
      const sr = buf.sampleRate;
      const len = buf.length;
      setSourceChannels(chs);
      setSampleRate(sr);
      setBaseName(file.name.replace(/\.[^.]+$/, "") || "sound");
      setLoopStart(0);
      setLoopEnd(len);
      setCandidates([]);
      setCandIndex(-1);
      setShaper(DEFAULT_SHAPER_SPEC);
      setEq(DEFAULT_EQ_SPEC);
      setVariations([]);
      setActiveVarIdx(-1);
      cursorRef.current = 0;
      cursorVisibleRef.current = false;
      setTimePosText("0:00.00");
      setDecoding(false);
      setStatusMsg(
        `${file.name} · ${buf.numberOfChannels}ch · ${(sr / 1000).toFixed(
          1
        )} kHz · ${formatDuration(len, sr)}`
      );
    } catch (err) {
      setDecoding(false);
      const msg = err instanceof Error ? err.message : String(err);
      setDecodeError(msg);
      setStatusMsg(`Could not decode file: ${msg}`);
    }
  }, []);

  // Recompute Processed Channels whenever source, shaper, or eq changes
  const prevProcLenRef = useRef<number>(0);
  useEffect(() => {
    if (!sourceChannels || sourceChannels.length === 0) {
      setProcessedChannels(null);
      prevProcLenRef.current = 0;
      return;
    }
    const processed = applyDspChain(sourceChannels, sampleRate, shaper, eq);
    const newLen = processed[0]?.length ?? 0;
    const oldLen = prevProcLenRef.current;
    prevProcLenRef.current = newLen;
    setProcessedChannels(processed);
    if (oldLen > 0 && newLen !== oldLen) {
      setLoopStart((prevS) => Math.max(0, Math.min(prevS, newLen - 2)));
      setLoopEnd((prevE) =>
        prevE >= oldLen - 4 ? newLen : Math.max(2, Math.min(prevE, newLen))
      );
    }
  }, [sourceChannels, sampleRate, shaper, eq]);

  // Display channels for the waveform canvas:
  // In the Trim & Gain tab, show the full uncropped duration so the user can drag IN/OUT crop handles
  // and see the dimmed trimmed-away regions.
  const uncroppedChannels = useMemo(() => {
    if (!sourceChannels || sourceChannels.length === 0) {
      return null;
    }
    const noCropShaper: ShaperSpec = {
      ...shaper,
      trimStartMs: 0,
      trimEndMs: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    };
    return applyDspChain(sourceChannels, sampleRate, noCropShaper, eq);
  }, [sourceChannels, sampleRate, shaper, eq]);

  const rawTotalSamples = sourceChannels?.[0]?.length ?? 0;
  const cropStartSamples = useMemo(
    () =>
      shaper.enabled
        ? Math.min(
            Math.max(0, Math.round((shaper.trimStartMs / 1000) * sampleRate)),
            Math.max(0, rawTotalSamples - 4)
          )
        : 0,
    [shaper.enabled, shaper.trimStartMs, sampleRate, rawTotalSamples]
  );
  const cropEndSamples = useMemo(
    () =>
      shaper.enabled
        ? Math.max(
            cropStartSamples + 4,
            rawTotalSamples -
              Math.max(0, Math.round((shaper.trimEndMs / 1000) * sampleRate))
          )
        : rawTotalSamples,
    [
      shaper.enabled,
      shaper.trimEndMs,
      sampleRate,
      rawTotalSamples,
      cropStartSamples,
    ]
  );

  const updateCropPoints = useCallback(
    (nextInSample: number, nextOutSample: number) => {
      if (rawTotalSamples < 4) {
        return;
      }
      const clampedIn = Math.max(
        0,
        Math.min(Math.round(nextInSample), rawTotalSamples - 4)
      );
      const clampedOut = Math.max(
        clampedIn + 4,
        Math.min(Math.round(nextOutSample), rawTotalSamples)
      );
      const nextTrimStartMs = Math.round((clampedIn / sampleRate) * 1000);
      const nextTrimEndMs = Math.round(
        ((rawTotalSamples - clampedOut) / sampleRate) * 1000
      );
      setShaper((s) => ({
        ...s,
        enabled: true,
        trimStartMs: nextTrimStartMs,
        trimEndMs: nextTrimEndMs,
      }));
    },
    [rawTotalSamples, sampleRate]
  );

  const handleAutoTrimSilence = useCallback(() => {
    if (!sourceChannels || sourceChannels.length === 0) {
      return;
    }
    const detected = detectSilenceTrimMs(sourceChannels, sampleRate, -50);
    setShaper((s) => ({
      ...s,
      enabled: true,
      trimStartMs: detected.trimStartMs,
      trimEndMs: detected.trimEndMs,
    }));
    setStatusMsg(
      `Auto-trimmed silence: ${detected.trimStartMs}ms from start, ${detected.trimEndMs}ms from end`
    );
  }, [sourceChannels, sampleRate]);

  // Bake Loop & update transport whenever processedChannels or loop params change
  const performBake = useCallback(
    (
      proc: Float32Array[],
      sr: number,
      start: number,
      end: number,
      fadeS: number,
      curve: FadeCurve,
      mode: BakeMode,
      isLoopingOn: boolean
    ) => {
      const len = proc[0]?.length ?? 0;
      if (len < 2) {
        return;
      }
      const clampedStart = Math.max(0, Math.min(Math.floor(start), len - 2));
      const clampedEnd = Math.max(
        clampedStart + 2,
        Math.min(Math.floor(end), len)
      );

      try {
        const effectiveFade = isLoopingOn ? fadeS : 0;
        const res = bakeLoop(proc, {
          start: clampedStart,
          end: clampedEnd,
          fadeLength: effectiveFade,
          curve,
          mode,
        });
        setBakedChannels(res.buffers);
        setResolvedMode(res.mode);
        setFadeAtHead(res.fadeAtHead);
        setSeamMetrics(evaluateBakedSeam(res.buffers, sr));
        setSignalStats(measureSignalStats(res.buffers));

        const tp = ensureTransport();
        tp.setFileAudio(tp.makeBuffer(proc, sr));
        tp.setLoopAudio(tp.makeBuffer(res.buffers, sr));
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureTransport]
  );

  useEffect(() => {
    if (!processedChannels || processedChannels.length === 0) {
      return;
    }
    window.clearTimeout(bakeTimerRef.current);
    bakeTimerRef.current = window.setTimeout(() => {
      performBake(
        processedChannels,
        sampleRate,
        loopStart,
        loopEnd,
        fadeSamples,
        fadeCurve,
        bakeMode,
        loopEnabled
      );
    }, 60);
    return () => window.clearTimeout(bakeTimerRef.current);
  }, [
    processedChannels,
    sampleRate,
    loopStart,
    loopEnd,
    fadeSamples,
    fadeCurve,
    bakeMode,
    loopEnabled,
    performBake,
  ]);

  // Snap helper
  const snapSample = useCallback(
    (sample: number, doSnap = snapZero): number => {
      const ch = processedChannels?.[0] ?? sourceChannels?.[0];
      if (!ch) {
        return Math.round(sample);
      }
      return doSnap
        ? snapToZeroCrossing(ch, sample, 4096, "rising")
        : Math.round(sample);
    },
    [processedChannels, sourceChannels, snapZero]
  );

  const updateLoopPoints = useCallback(
    (nextStart: number, nextEnd: number, shouldSnap = snapZero) => {
      const ch = processedChannels?.[0] ?? sourceChannels?.[0];
      if (!ch) {
        return;
      }
      const len = ch.length;
      const s = shouldSnap ? snapSample(nextStart, true) : Math.round(nextStart);
      const e = shouldSnap ? snapSample(nextEnd, true) : Math.round(nextEnd);
      const clampedS = Math.max(0, Math.min(s, len - 2));
      const clampedE = Math.max(clampedS + 2, Math.min(e, len));
      setLoopStart(clampedS);
      setLoopEnd(clampedE);
      setLoopEnabled(true);
      setSaveSuffix((prev) => (prev === ".edit" ? ".loop" : prev));
    },
    [processedChannels, sourceChannels, snapZero, snapSample]
  );

  // Playhead RAF loop
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const tp = transportRef.current;
      let shown: number | null = null;
      const offsetInRaw = activeModule === "shaper" ? cropStartSamples : 0;
      if (tp && processedChannels) {
        if (tp.playing) {
          const p = tp.positionSamples();
          shown =
            p === null
              ? null
              : tp.mode === "loop"
              ? offsetInRaw + loopStart + p
              : offsetInRaw + p;
          if (shown !== null) {
            cursorRef.current = shown - offsetInRaw;
          }
        } else if (cursorVisibleRef.current) {
          shown = offsetInRaw + cursorRef.current;
        }
      }
      waveRef.current?.setPlayhead(shown);
      if (processedChannels) {
        setTimePosText(
          formatDuration(
            Math.max(0, (shown ?? 0) - offsetInRaw),
            sampleRate
          )
        );
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [processedChannels, loopStart, sampleRate, activeModule, cropStartSamples]);

  // Transport actions
  const togglePlay = useCallback(() => {
    if (!processedChannels) {
      return;
    }
    const tp = ensureTransport();
    if (tp.playing) {
      tp.pause();
      const p = tp.positionSamples();
      if (p !== null) {
        cursorRef.current = tp.mode === "loop" ? loopStart + p : p;
      }
      setIsPlaying(false);
    } else {
      performBake(
        processedChannels,
        sampleRate,
        loopStart,
        loopEnd,
        fadeSamples,
        fadeCurve,
        bakeMode,
        loopEnabled
      );
      cursorVisibleRef.current = true;
      const cur = cursorRef.current;
      if (auditionMode === "loop" && loopEnabled) {
        const offset =
          cur >= loopStart && cur < loopEnd ? cur - loopStart : 0;
        tp.playLoop(offset);
      } else {
        tp.playFile(cur >= loopEnd ? loopStart : cur);
      }
      setIsPlaying(true);
    }
  }, [
    processedChannels,
    ensureTransport,
    loopStart,
    loopEnd,
    sampleRate,
    fadeSamples,
    fadeCurve,
    bakeMode,
    loopEnabled,
    auditionMode,
    performBake,
  ]);

  const stopPlayback = useCallback(() => {
    const tp = transportRef.current;
    if (!tp) {
      return;
    }
    rrTestingRef.current = false;
    setIsTestingRR(false);
    window.clearTimeout(rrTimerRef.current);
    tp.stop();
    cursorRef.current = loopEnabled ? loopStart : 0;
    cursorVisibleRef.current = false;
    setIsPlaying(false);
  }, [loopEnabled, loopStart]);

  const restartLoop = useCallback(() => {
    const tp = transportRef.current;
    cursorRef.current = loopStart;
    cursorVisibleRef.current = true;
    if (tp?.playing) {
      if (auditionMode === "loop" && loopEnabled) {
        tp.playLoop(0);
      } else {
        tp.playFile(loopStart);
      }
    }
  }, [loopStart, auditionMode, loopEnabled]);

  const auditionSeam = useCallback(() => {
    if (!processedChannels) {
      return;
    }
    const tp = ensureTransport();
    performBake(
      processedChannels,
      sampleRate,
      loopStart,
      loopEnd,
      fadeSamples,
      fadeCurve,
      bakeMode,
      loopEnabled
    );
    const loopLen = Math.max(2, loopEnd - loopStart);
    // Start 1.2 seconds before the seam wrap so the listener immediately hears the wrap
    const preRollSamples = Math.min(
      Math.floor(loopLen * 0.75),
      Math.round(sampleRate * 1.2)
    );
    const startOffset = Math.max(0, loopLen - preRollSamples);
    cursorRef.current = loopStart + startOffset;
    cursorVisibleRef.current = true;
    setAuditionMode("loop");
    tp.playLoop(startOffset);
    setIsPlaying(true);
    setStatusMsg("Auditioning loop seam wrap (E → S)…");
  }, [
    processedChannels,
    ensureTransport,
    performBake,
    sampleRate,
    loopStart,
    loopEnd,
    fadeSamples,
    fadeCurve,
    bakeMode,
    loopEnabled,
  ]);

  const seekToSample = useCallback(
    (sample: number) => {
      if (!processedChannels) {
        return;
      }
      const localSample =
        activeModule === "shaper" ? sample - cropStartSamples : sample;
      const len = processedChannels[0].length;
      const s = Math.max(0, Math.min(Math.round(localSample), len - 1));
      cursorRef.current = s;
      cursorVisibleRef.current = true;
      const tp = transportRef.current;
      if (!tp || !tp.playing) {
        return;
      }
      if (
        auditionMode === "loop" &&
        loopEnabled &&
        s >= loopStart &&
        s < loopEnd
      ) {
        tp.playLoop(s - loopStart);
      } else {
        tp.playFile(s);
      }
    },
    [
      processedChannels,
      activeModule,
      cropStartSamples,
      auditionMode,
      loopEnabled,
      loopStart,
      loopEnd,
    ]
  );

  // Auto-Loop Search via Web Worker
  const applyCandidate = useCallback(
    (index: number, list: LoopCandidate[] = candidates) => {
      const c = list[index];
      if (!c || !processedChannels) {
        return;
      }
      setCandIndex(index);
      updateLoopPoints(c.start, c.end, snapZero);
      seekToSample(c.start);
      const pct = Math.round(c.score * 100);
      const durS = ((c.end - c.start) / sampleRate).toFixed(2);
      setStatusMsg(
        `Applied loop suggestion #${index + 1}/${
          list.length
        } (${pct}% match · ${durS}s)`
      );
    },
    [candidates, processedChannels, updateLoopPoints, snapZero, seekToSample, sampleRate]
  );

  const runLoopSearch = useCallback(() => {
    const chs = processedChannels ?? sourceChannels;
    if (!chs || chs.length === 0) {
      return;
    }
    searchWorkerRef.current?.terminate();
    const worker = new Worker(
      new URL("./workers/search.worker.ts", import.meta.url),
      { type: "module" }
    );
    searchWorkerRef.current = worker;

    setSearching(true);
    setSearchProgress(0);

    const fileLen = chs[0].length;
    const isEndNearEof = loopEnd >= fileLen - Math.round(0.05 * sampleRate);
    const pairMode =
      searchModePref === "pairs"
        ? true
        : searchModePref === "fixed-end"
        ? false
        : isEndNearEof;

    setStatusMsg(
      pairMode
        ? "Scanning audio for optimal (start, end) loop pairs…"
        : "Scanning audio for loop starts matching your end marker…"
    );

    worker.onmessage = (e: MessageEvent<SearchMessage>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        setSearchProgress(Math.min(1, msg.value));
      } else {
        setSearching(false);
        setSearchProgress(1);
        const found = msg.candidates;
        setCandidates(found);
        if (found.length === 0) {
          setCandIndex(-1);
          setStatusMsg(
            "No loop points found — try reducing min loop length or window size."
          );
          return;
        }
        applyCandidate(0, found);
      }
    };

    const pcm = monoMix(chs);
    worker.postMessage(
      {
        pcm,
        sampleRate,
        pairMode,
        options: {
          loopEnd,
          minLoopLength:
            Math.round(minLoopSec * sampleRate) || Math.round(sampleRate * 1.5),
          windowMs: searchWindowMs || 400,
          topN: 8,
        },
      },
      [pcm.buffer]
    );
  }, [
    processedChannels,
    sourceChannels,
    loopEnd,
    sampleRate,
    searchModePref,
    minLoopSec,
    searchWindowMs,
    applyCandidate,
  ]);

  // Build WAV ArrayBuffer for current edited output
  const buildCurrentWav = useCallback((): {
    wav: ArrayBuffer;
    filename: string;
  } | null => {
    const outBuffers = bakedChannels ?? processedChannels;
    if (!outBuffers || outBuffers.length === 0) {
      return null;
    }
    const wav = encodeWav(outBuffers, sampleRate, exportFormat);
    const defaultSuf = loopEnabled ? ".loop" : ".edit";
    const cleanSuffix = (saveSuffix.trim() || defaultSuf).replace(/^\.?/, ".");
    const filename = `${baseName}${cleanSuffix}.wav`;
    return { wav, filename };
  }, [
    bakedChannels,
    processedChannels,
    sampleRate,
    exportFormat,
    saveSuffix,
     loopEnabled,
    baseName,
  ]);

  const handleExportDownload = useCallback(() => {
    const res = buildCurrentWav();
    if (!res) {
      return;
    }
    const blob = new Blob([res.wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(
      `Exported ${res.filename} (${(res.wav.byteLength / 1024 / 1024).toFixed(
        2
      )} MB)`
    );
  }, [buildCurrentWav]);

  const handleSaveToLibrary = useCallback(
    async (overwrite = false) => {
      if (!hit) {
        return;
      }
      const res = buildCurrentWav();
      if (!res) {
        return;
      }
      setSavingToLibrary(true);
      setStatusMsg(
        overwrite
          ? `Overwriting ${hit.filename} and re-indexing…`
          : `Saving ${res.filename} to library folder and indexing…`
      );
      try {
        const savedHit = await saveEditedFileToLibrary(
          hit.file_id,
          res.wav,
          res.filename,
          {
            suffix: saveSuffix.trim() || ".loop",
            overwrite,
            copyUserData: true,
          }
        );
        onSavedToLibrary(savedHit);
        setStatusMsg(
          `Saved & indexed in library: ${savedHit.filename} (${savedHit.duration_s.toFixed(
            2
          )}s)`
        );
      } catch (err) {
        setStatusMsg(
          `Save failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setSavingToLibrary(false);
      }
    },
    [hit, buildCurrentWav, saveSuffix, onSavedToLibrary]
  );

  const handleDragEditedStart = (e: React.DragEvent) => {
    const res = buildCurrentWav();
    if (!res) {
      return;
    }
    const dt = e.dataTransfer;
    dt.effectAllowed = "copy";
    const file = new File([res.wav], res.filename, { type: "audio/wav" });
    try {
      dt.items.add(file);
    } catch {
      // ignore if browser blocks items.add(File)
    }
    setStatusMsg(`Dragging ${res.filename} to external app / DAW…`);
  };

  const handleFindSimilarEdited = useCallback(() => {
    const res = buildCurrentWav();
    if (!res) {
      return;
    }
    const file = new File([res.wav], res.filename, { type: "audio/wav" });
    onFindSimilarFromAudio(file);
  }, [buildCurrentWav, onFindSimilarFromAudio]);

  // Procedural Variations & Round-Robin Generator actions
  const stopRRTest = useCallback(() => {
    rrTestingRef.current = false;
    setIsTestingRR(false);
    window.clearTimeout(rrTimerRef.current);
    const tp = transportRef.current;
    if (tp) {
      tp.onEnded = () => setIsPlaying(false);
    }
  }, []);

  const auditionVariation = useCallback(
    (v: GeneratedVariation, idx: number) => {
      stopRRTest();
      setActiveVarIdx(idx);
      const tp = ensureTransport();
      const buf = tp.makeBuffer(v.channels, v.sampleRate);
      tp.setFileAudio(buf);
      setAuditionMode("file");
      cursorRef.current = 0;
      cursorVisibleRef.current = true;
      tp.playFile(0);
      setIsPlaying(true);
      setStatusMsg(
        `Auditioning ${v.name} (${
          v.meanSemitones >= 0
            ? `+${v.meanSemitones.toFixed(1)}`
            : v.meanSemitones.toFixed(1)
        } st · ${v.durationS.toFixed(2)}s)`
      );
    },
    [ensureTransport, stopRRTest]
  );

  const toggleTestRoundRobin = useCallback(() => {
    if (rrTestingRef.current) {
      stopRRTest();
      transportRef.current?.stop();
      setIsPlaying(false);
      setStatusMsg("Stopped round-robin sequence test");
      return;
    }
    const liked = variations.filter((v) => v.liked);
    const pool = liked.length > 0 ? liked : variations;
    if (pool.length === 0) {
      return;
    }
    rrTestingRef.current = true;
    setIsTestingRR(true);
    let step = 0;

    const playNext = () => {
      if (!rrTestingRef.current) {
        return;
      }
      const take = pool[step % pool.length];
      const fullIdx = variations.findIndex((x) => x.id === take.id);
      setActiveVarIdx(fullIdx >= 0 ? fullIdx : 0);

      const tp = ensureTransport();
      const buf = tp.makeBuffer(take.channels, take.sampleRate);
      tp.setFileAudio(buf);
      setAuditionMode("file");
      cursorRef.current = 0;
      cursorVisibleRef.current = true;
      tp.onEnded = () => {
        setIsPlaying(false);
        if (!rrTestingRef.current) {
          return;
        }
        step++;
        if (step >= pool.length * 2) {
          stopRRTest();
          setStatusMsg("Completed 2x round-robin sequence test");
          return;
        }
        rrTimerRef.current = window.setTimeout(playNext, 110);
      };
      tp.playFile(0);
      setIsPlaying(true);
      setStatusMsg(
        `Round-Robin Test (${(step % pool.length) + 1}/${pool.length}): ${
          take.name
        }`
      );
    };

    playNext();
  }, [variations, ensureTransport, stopRRTest]);

  const handleGenerateVariations = useCallback(() => {
    const baseAudio = bakedChannels ?? processedChannels ?? sourceChannels;
    if (!baseAudio || baseAudio.length === 0) {
      return;
    }
    const batch = generateVariationBatch(
      baseAudio,
      sampleRate,
      varSpec,
      baseName
    );
    setVariations(batch);
    if (batch.length > 0) {
      auditionVariation(batch[0], 0);
    }
    setStatusMsg(
      `Generated ${batch.length} ${varSpec.mode} round-robin variations`
    );
  }, [
    bakedChannels,
    processedChannels,
    sourceChannels,
    sampleRate,
    varSpec,
    baseName,
    auditionVariation,
  ]);

  const handleRerollSingleVariation = useCallback(
    (idx: number) => {
      const baseAudio = bakedChannels ?? processedChannels ?? sourceChannels;
      if (!baseAudio || baseAudio.length === 0) {
        return;
      }
      const fresh = synthesizeVariation(
        baseAudio,
        sampleRate,
        varSpec,
        idx,
        baseName
      );
      setVariations((prev) =>
        prev.map((item, i) =>
          i === idx ? { ...fresh, liked: item.liked } : item
        )
      );
      auditionVariation(fresh, idx);
    },
    [
      bakedChannels,
      processedChannels,
      sourceChannels,
      sampleRate,
      varSpec,
      baseName,
      auditionVariation,
    ]
  );

  const toggleVariationLike = useCallback((idx: number) => {
    setVariations((prev) =>
      prev.map((item, i) =>
        i === idx ? { ...item, liked: !item.liked } : item
      )
    );
  }, []);

  const handleDownloadVariation = useCallback(
    (v: GeneratedVariation) => {
      const wav = encodeWav(v.channels, v.sampleRate, exportFormat);
      const blob = new Blob([wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${v.name}.wav`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg(`Exported ${v.name}.wav`);
    },
    [exportFormat]
  );

  const handleSaveVariationToLibrary = useCallback(
    async (v: GeneratedVariation) => {
      if (!hit) {
        return;
      }
      const wav = encodeWav(v.channels, v.sampleRate, exportFormat);
      const suffix = `_var_${String(v.index + 1).padStart(2, "0")}`;
      setSavingBatch(true);
      setStatusMsg(`Saving ${v.name}.wav to library…`);
      try {
        const savedHit = await saveEditedFileToLibrary(
          hit.file_id,
          wav,
          `${v.name}.wav`,
          {
            suffix,
            overwrite: false,
            copyUserData: true,
          }
        );
        onSavedToLibrary(savedHit);
        setStatusMsg(`Saved & indexed variation: ${savedHit.filename}`);
      } catch (err) {
        setStatusMsg(
          `Save variation failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        setSavingBatch(false);
      }
    },
    [hit, exportFormat, onSavedToLibrary]
  );

  const handleSaveLikedVariationsToLibrary = useCallback(async () => {
    if (!hit) {
      return;
    }
    const targets = variations.filter((v) => v.liked);
    const list = targets.length > 0 ? targets : variations;
    if (list.length === 0) {
      return;
    }
    setSavingBatch(true);
    let savedCount = 0;
    try {
      for (const v of list) {
        setStatusMsg(
          `Saving variation ${savedCount + 1}/${list.length} (${v.name}.wav)…`
        );
        const wav = encodeWav(v.channels, v.sampleRate, exportFormat);
        const suffix = `_var_${String(v.index + 1).padStart(2, "0")}`;
        const savedHit = await saveEditedFileToLibrary(
          hit.file_id,
          wav,
          `${v.name}.wav`,
          {
            suffix,
            overwrite: false,
            copyUserData: true,
          }
        );
        onSavedToLibrary(savedHit);
        savedCount++;
      }
      setStatusMsg(
        `Saved & indexed ${savedCount} round-robin variation${
          savedCount === 1 ? "" : "s"
        } to library`
      );
    } catch (err) {
      setStatusMsg(
        `Batch save failed after ${savedCount} files: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setSavingBatch(false);
    }
  }, [hit, variations, exportFormat, onSavedToLibrary]);

  const handleDownloadLikedVariations = useCallback(() => {
    const targets = variations.filter((v) => v.liked);
    const list = targets.length > 0 ? targets : variations;
    for (const v of list) {
      handleDownloadVariation(v);
    }
    setStatusMsg(`Exported ${list.length} WAV variation files`);
  }, [variations, handleDownloadVariation]);

  const handleVariationDragStart = (
    e: React.DragEvent,
    v: GeneratedVariation
  ) => {
    const wav = encodeWav(v.channels, v.sampleRate, exportFormat);
    const filename = `${v.name}.wav`;
    const dt = e.dataTransfer;
    dt.effectAllowed = "copy";
    const file = new File([wav], filename, { type: "audio/wav" });
    try {
      dt.items.add(file);
    } catch {
      // ignore
    }
    setStatusMsg(`Dragging ${filename} to DAW / external app…`);
  };

  // Keyboard shortcuts inside StudioView
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable
      ) {
        if (e.key === "Escape") {
          target?.blur();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        transportRef.current?.stop();
        onBackToLibrary();
        return;
      }

      if (!processedChannels) {
        return;
      }

      const stepSamples = Math.max(
        1,
        Math.round((e.shiftKey ? 10 : 1) * 0.001 * sampleRate)
      );

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "Home":
          e.preventDefault();
          restartLoop();
          break;
        case "KeyF":
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            runLoopSearch();
          }
          break;
        case "KeyS":
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (hit) {
              void handleSaveToLibrary(false);
            } else {
              handleExportDownload();
            }
          } else {
            e.preventDefault();
            auditionSeam();
          }
          break;
        case "BracketLeft":
          e.preventDefault();
          setActiveMarker("start");
          setStatusMsg(
            activeModule === "shaper"
              ? "Active handle: Crop IN — use ←/→ to nudge"
              : "Active marker: Loop Start (S) — use ←/→ to nudge"
          );
          break;
        case "BracketRight":
          e.preventDefault();
          setActiveMarker("end");
          setStatusMsg(
            activeModule === "shaper"
              ? "Active handle: Crop OUT — use ←/→ to nudge"
              : "Active marker: Loop End (E) — use ←/→ to nudge"
          );
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const delta = (e.code === "ArrowRight" ? 1 : -1) * stepSamples;
          if (activeModule === "shaper") {
            if (activeMarker === "start") {
              updateCropPoints(cropStartSamples + delta, cropEndSamples);
            } else {
              updateCropPoints(cropStartSamples, cropEndSamples + delta);
            }
          } else if (activeMarker === "start") {
            updateLoopPoints(loopStart + delta, loopEnd, false);
          } else {
            updateLoopPoints(loopStart, loopEnd + delta, false);
          }
          break;
        }
        case "Digit1":
          setActiveModule("loop");
          break;
        case "Digit2":
          setActiveModule("shaper");
          break;
        case "Digit3":
          setActiveModule("eq");
          break;
        case "Digit4":
          setActiveModule("variations");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    processedChannels,
    sampleRate,
    togglePlay,
    restartLoop,
    runLoopSearch,
    auditionSeam,
    activeMarker,
    loopStart,
    loopEnd,
    updateLoopPoints,
    onBackToLibrary,
    hit,
    handleSaveToLibrary,
    handleExportDownload,
  ]);

  const totalSamples = processedChannels?.[0]?.length ?? 0;
  const loopDurationS = Math.max(0, (loopEnd - loopStart) / sampleRate);
  const totalDurationS = Math.max(0, totalSamples / sampleRate);

  const loopMarkers = useMemo(() => {
    if (activeModule === "shaper" && uncroppedChannels) {
      const fiSamples = shaper.enabled
        ? Math.round((shaper.fadeInMs / 1000) * sampleRate)
        : 0;
      const foSamples = shaper.enabled
        ? Math.round((shaper.fadeOutMs / 1000) * sampleRate)
        : 0;
      return {
        start: cropStartSamples,
        end: cropEndSamples,
        fade: 0,
        fadeAtHead: false,
        startLabel: "IN",
        endLabel: "OUT",
        fadeInSamples: fiSamples,
        fadeOutSamples: foSamples,
      };
    }
    if (processedChannels && (loopEnabled || activeModule === "loop")) {
      return {
        start: loopStart,
        end: loopEnd,
        fade: loopEnabled ? fadeSamples : 0,
        fadeAtHead,
        startLabel: "S",
        endLabel: "E",
      };
    }
    return null;
  }, [
    activeModule,
    uncroppedChannels,
    shaper.enabled,
    shaper.fadeInMs,
    shaper.fadeOutMs,
    sampleRate,
    cropStartSamples,
    cropEndSamples,
    processedChannels,
    loopEnabled,
    loopStart,
    loopEnd,
    fadeSamples,
    fadeAtHead,
  ]);

  const resolvedModeLabel =
    resolvedMode === "pre"
      ? "Pre-roll (before S)"
      : resolvedMode === "post"
      ? "Post-roll (after E)"
      : "Loop head (internal)";

  const shaperActive = isShaperActive(shaper);
  const eqActive = isEqActive(eq);

  return (
    <div
      className="sfx-editor-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) {
          void loadLocalFile(f);
        }
      }}
    >
      {/* Studio Top Bar */}
      <div className="sfx-editor-topbar">
        <div className="sfx-editor-topbar-left">
          <button
            type="button"
            onClick={() => {
              transportRef.current?.stop();
              onBackToLibrary();
            }}
            className="ds-btn ds-btn-secondary ds-btn-sm"
            title="Return to Library Search (Esc)"
          >
            <ArrowLeft size={14} />
            Library
          </button>

          <div className="sfx-divider-v" />

          <div className="sfx-editor-file-nav">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={onPrevHit}
              className="sfx-icon-btn"
              title="Previous sound in search results"
              aria-label="Previous sound"
            >
              <ChevronLeft size={15} />
            </button>
            <div className="sfx-editor-file-meta">
              <span className="sfx-editor-filename" title={hit?.path || baseName}>
                {hit ? hit.filename : `${baseName}.wav`}
              </span>
              <span className="sfx-editor-filespecs ds-tnum">
                {totalSamples > 0
                  ? `${
                      processedChannels?.length ?? 1
                    }ch · ${(sampleRate / 1000).toFixed(1)} kHz · ${totalDurationS.toFixed(
                      2
                    )}s`
                  : "Loading…"}
              </span>
            </div>
            <button
              type="button"
              disabled={!hasNext}
              onClick={onNextHit}
              className="sfx-icon-btn"
              title="Next sound in search results"
              aria-label="Next sound"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        {/* Module Switcher Tabs */}
        <div className="sfx-editor-module-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeModule === "loop"}
            onClick={() => setActiveModule("loop")}
            className={`sfx-module-tab ${
              activeModule === "loop" ? "active" : ""
            }`}
          >
            <Repeat size={14} />
            <span>Seamless Loop</span>
            {loopEnabled && <span className="sfx-module-dot on" />}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeModule === "shaper"}
            onClick={() => setActiveModule("shaper")}
            className={`sfx-module-tab ${
              activeModule === "shaper" ? "active" : ""
            }`}
          >
            <Sliders size={14} />
            <span>Trim &amp; Gain</span>
            {shaperActive && <span className="sfx-module-dot on" />}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeModule === "eq"}
            onClick={() => setActiveModule("eq")}
            className={`sfx-module-tab ${
              activeModule === "eq" ? "active" : ""
            }`}
          >
            <Activity size={14} />
            <span>Tone &amp; EQ</span>
            {eqActive && <span className="sfx-module-dot on" />}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeModule === "variations"}
            onClick={() => setActiveModule("variations")}
            className={`sfx-module-tab ${
              activeModule === "variations" ? "active" : ""
            }`}
          >
            <Dices size={14} />
            <span>Variations</span>
            {variations.length > 0 && <span className="sfx-module-dot on" />}
          </button>
        </div>

        {/* Right Actions: Spectrum + Drag to DAW + Save / Export */}
        <div className="sfx-editor-topbar-right">
          <SpectrumMeter
            analyserNode={transportRef.current?.analyser ?? null}
            isPlaying={isPlaying}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="ds-btn ds-btn-ghost ds-btn-sm"
            title="Open any local audio file into the editor"
          >
            <Upload size={13} />
            Open file
          </button>

          <button
            type="button"
            disabled={!processedChannels}
            onClick={handleFindSimilarEdited}
            className="ds-btn ds-btn-ghost ds-btn-sm"
            title="Search library for sounds acoustically similar to your edited audio"
          >
            <Sparkles size={13} />
            Find Similar
          </button>

          {hit && (
            <button
              type="button"
              onClick={() => revealInExplorer(hit.file_id).catch(() => {})}
              className="sfx-icon-btn"
              title="Reveal source file in Explorer"
              aria-label="Reveal source file in Explorer"
            >
              <FolderOpen size={14} />
            </button>
          )}

          <div
            draggable={Boolean(processedChannels)}
            onDragStart={handleDragEditedStart}
            className="sfx-drag-chip"
            title="Drag this chip directly into your DAW, video editor, or desktop to drop the rendered WAV"
          >
            <GripHorizontal size={13} />
            <span>Drag WAV</span>
          </div>

          {hit && (
            <button
              type="button"
              disabled={!processedChannels || savingToLibrary}
              onClick={() => handleSaveToLibrary(false)}
              className="ds-btn ds-btn-secondary ds-btn-sm"
              title="Save loop as a new WAV in the library folder and index it immediately (Ctrl+S)"
            >
              <Save size={13} />
              {savingToLibrary ? "Saving…" : "Save to Library"}
            </button>
          )}

          <button
            type="button"
            disabled={!processedChannels}
            onClick={handleExportDownload}
            className="ds-btn ds-btn-primary ds-btn-sm"
            title="Download baked WAV file"
          >
            <Download size={13} />
            Export WAV
          </button>
        </div>
      </div>

      {/* Main Waveform Stage */}
      <div className="sfx-editor-stage">
        {decoding ? (
          <div className="sfx-editor-stage-overlay">
            <span className="ds-spinner" />
            <span>Decoding audio into float32 studio buffers…</span>
          </div>
        ) : decodeError ? (
          <div className="sfx-editor-stage-overlay">
            <div className="ds-empty-title">Could not load audio</div>
            <div className="ds-empty-desc">{decodeError}</div>
          </div>
        ) : null}

        <EditorWaveform
          ref={waveRef}
          channels={
            activeModule === "shaper" ? uncroppedChannels : processedChannels
          }
          sampleRate={sampleRate}
          loop={loopMarkers}
          candidates={activeModule === "shaper" ? [] : candidates}
          activeCandidate={activeModule === "shaper" ? -1 : candIndex}
          activeMarker={activeMarker}
          onLoopChange={(s, e) => {
            if (activeModule === "shaper") {
              updateCropPoints(s, e);
            } else {
              updateLoopPoints(s, e, snapZero);
            }
          }}
          onPickCandidate={(idx) => applyCandidate(idx)}
          onSeek={seekToSample}
          onSelectMarker={setActiveMarker}
        />

        {/* Stage Overlay HUD: Legend + Zoom Controls */}
        {activeModule === "shaper" ? (
          <div className="sfx-editor-stage-hud-left">
            <span className="sfx-hud-pill start">
              <span className="dot" />
              IN {(cropStartSamples / sampleRate).toFixed(3)}s
            </span>
            <span className="sfx-hud-pill end">
              <span className="dot" />
              OUT {(cropEndSamples / sampleRate).toFixed(3)}s
            </span>
            <span className="sfx-hud-pill">
              Cropped {totalDurationS.toFixed(3)}s /{" "}
              {(rawTotalSamples / sampleRate).toFixed(3)}s
            </span>
          </div>
        ) : (
          (loopEnabled || activeModule === "loop") && (
            <div className="sfx-editor-stage-hud-left">
              <span className="sfx-hud-pill start">
                <span className="dot" />S {(loopStart / sampleRate).toFixed(3)}s
              </span>
              <span className="sfx-hud-pill end">
                <span className="dot" />E {(loopEnd / sampleRate).toFixed(3)}s
              </span>
              <span className="sfx-hud-pill">
                Len {loopDurationS.toFixed(3)}s
              </span>
              {loopEnabled && fadeMs > 0 && (
                <span className="sfx-hud-pill fade">
                  X-Fade {Math.round(fadeMs)}ms · {resolvedModeLabel}
                </span>
              )}
            </div>
          )
        )}

        <div className="sfx-editor-stage-hud-right">
          <button
            type="button"
            onClick={() => waveRef.current?.zoomByFactor(0.6)}
            className="sfx-hud-btn"
            title="Zoom in (Scroll wheel up)"
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            onClick={() => waveRef.current?.zoomByFactor(1.6)}
            className="sfx-hud-btn"
            title="Zoom out (Scroll wheel down)"
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            onClick={() => waveRef.current?.zoomToLoop()}
            className="sfx-hud-btn"
            title="Zoom to active loop region"
          >
            Loop
          </button>
          <button
            type="button"
            onClick={() => waveRef.current?.zoomToSeam()}
            className="sfx-hud-btn"
            title="Zoom into the crossfade seam"
          >
            Seam
          </button>
          <button
            type="button"
            onClick={() => waveRef.current?.resetView()}
            className="sfx-hud-btn"
            title="Fit entire file in view (Double-click waveform)"
          >
            <Maximize2 size={12} />
            Fit
          </button>
        </div>

        {searching && (
          <div
            className="sfx-editor-search-progress"
            role="progressbar"
            aria-valuenow={Math.round(searchProgress * 100)}
          >
            <div
              className="sfx-editor-search-progress-fill"
              style={{ transform: `scaleX(${searchProgress})` }}
            />
          </div>
        )}
      </div>

      {/* Studio Transport Deck */}
      <div className="sfx-editor-transport-bar">
        <div className="sfx-editor-transport-left">
          <button
            type="button"
            disabled={!processedChannels}
            onClick={runLoopSearch}
            className="ds-btn ds-btn-secondary ds-btn-sm sfx-find-loops-btn"
            title="Scan audio for seamless loop points (F)"
          >
            <Wand2 size={14} />
            {searching ? "Scanning…" : "Find Seamless Loops"}
          </button>

          {candidates.length > 0 && (
            <div className="sfx-cand-stepper">
              <button
                type="button"
                onClick={() =>
                  applyCandidate(
                    (candIndex - 1 + candidates.length) % candidates.length
                  )
                }
                className="sfx-icon-btn"
                title="Previous loop candidate"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="sfx-cand-readout ds-tnum">
                #{candIndex + 1}/{candidates.length} ·{" "}
                {Math.round((candidates[candIndex]?.score ?? 0) * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  applyCandidate((candIndex + 1) % candidates.length)
                }
                className="sfx-icon-btn"
                title="Next loop candidate"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Center Hero Transport Pill */}
        <div className="sfx-tp-pill">
          <button
            type="button"
            disabled={!processedChannels}
            onClick={restartLoop}
            className="sfx-tp-icon-btn"
            title="Restart from loop start (Home)"
            aria-label="Restart from loop start"
          >
            <RotateCcw size={15} />
          </button>

          <button
            type="button"
            disabled={!processedChannels}
            onClick={togglePlay}
            className={`sfx-tp-play-btn ${isPlaying ? "playing" : ""}`}
            title="Play / Pause preview (Space)"
            aria-label="Play or pause preview"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>

          <button
            type="button"
            disabled={!processedChannels}
            onClick={stopPlayback}
            className="sfx-tp-icon-btn"
            title="Stop and rewind"
            aria-label="Stop and rewind"
          >
            <Square size={14} />
          </button>

          <div className="sfx-tp-time ds-tnum">
            <span>{timePosText}</span>
            <span className="sep"> / </span>
            <span className="tot">
              {formatDuration(totalSamples, sampleRate)}
            </span>
          </div>

          <button
            type="button"
            disabled={!processedChannels}
            onClick={auditionSeam}
            className="ds-btn ds-btn-ghost ds-btn-sm"
            title="Jump 1.2s before the loop end to immediately audition the E → S seam transition (S)"
          >
            Test Seam
          </button>
        </div>

        <div className="sfx-editor-transport-right">
          <div className="sfx-signal-meters ds-tnum">
            <span title="Peak amplitude of the baked output">
              Peak{" "}
              <strong
                style={{
                  color:
                    signalStats.peakDbfs > -0.2
                      ? "var(--danger-400)"
                      : "var(--text-primary)",
                }}
              >
                {signalStats.peakDbfs > -119
                  ? `${signalStats.peakDbfs.toFixed(1)} dB`
                  : "—"}
              </strong>
            </span>
            <span title="RMS level of the baked output">
              RMS{" "}
              <strong>
                {signalStats.rmsDbfs > -119
                  ? `${signalStats.rmsDbfs.toFixed(1)} dB`
                  : "—"}
              </strong>
            </span>
            <span title="Computed loop seam continuity score">
              Seam{" "}
              <strong style={{ color: "var(--success-500)" }}>
                {Math.round(seamMetrics.seamScore * 100)}%
              </strong>
            </span>
          </div>
        </div>
      </div>

      {/* Modular Lower Control Rack */}
      <div className="sfx-editor-rack">
        {activeModule === "loop" && (
          <div className="sfx-rack-grid">
            {/* Column 1: Loop Boundaries & Crossfade */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Crossfade &amp; Seam Blend</span>
                <label
                  className="ds-switch-item"
                  style={{ fontSize: "var(--font-size-xs)" }}
                >
                  <div
                    className={`ds-switch-track ${loopEnabled ? "on" : ""}`}
                    onClick={() => setLoopEnabled((v) => !v)}
                  >
                    <div className="ds-switch-thumb" />
                  </div>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Bake Loop
                  </span>
                </label>
              </div>

              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Crossfade (ms)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={Math.min(
                        5000,
                        Math.max(100, Math.floor(loopDurationS * 500))
                      )}
                      step={5}
                      value={fadeMs}
                      onChange={(e) => setFadeMs(Number(e.target.value))}
                      className="sfx-range-input"
                    />
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={10}
                      value={Math.round(fadeMs)}
                      onChange={(e) =>
                        setFadeMs(Math.max(0, Number(e.target.value) || 0))
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Fade curve</label>
                  <div className="sfx-pill-group">
                    {(
                      [
                        ["equal-power", "Equal Power"],
                        ["cosine", "Cosine"],
                        ["linear", "Linear"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setFadeCurve(val)}
                        className={`sfx-choice-pill ${
                          fadeCurve === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Blend placement</label>
                  <div className="sfx-pill-group">
                    {(
                      [
                        ["auto", "Auto"],
                        ["pre", "Pre-roll"],
                        ["post", "Post-roll"],
                        ["head", "Internal"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setBakeMode(val)}
                        className={`sfx-choice-pill ${
                          bakeMode === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Zero-crossing</label>
                  <label
                    className="ds-check"
                    onClick={() => {
                      const next = !snapZero;
                      setSnapZero(next);
                      if (next) {
                        updateLoopPoints(loopStart, loopEnd, true);
                      }
                    }}
                  >
                    <div className={`ds-checkbox ${snapZero ? "on" : ""}`}>
                      {snapZero && <div className="ds-checkbox-inner" />}
                    </div>
                    <span
                      className="ds-check-label"
                      style={{ fontSize: "var(--font-size-xs)" }}
                    >
                      Snap markers to rising zero crossings
                    </span>
                  </label>
                </div>
              </div>
            </section>

            {/* Column 2: Auto-Loop Detection & Candidate Ranking */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Auto-Loop Finder</span>
                <span className="sfx-rack-hint">
                  3-Band Envelope + Fine NCC
                </span>
              </div>

              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Search strategy</label>
                  <div className="sfx-pill-group">
                    {(
                      [
                        ["auto", "Auto"],
                        ["pairs", "Best Pairs (S & E)"],
                        ["fixed-end", "Match End (E)"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setSearchModePref(val)}
                        className={`sfx-choice-pill ${
                          searchModePref === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Min loop length (s)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="number"
                      min={0.1}
                      max={Math.max(1, totalDurationS)}
                      step={0.5}
                      value={minLoopSec}
                      onChange={(e) =>
                        setMinLoopSec(
                          Math.max(0.1, Number(e.target.value) || 0.5)
                        )
                      }
                      className="sfx-num-input ds-tnum"
                    />
                    <span className="sfx-rack-label" style={{ marginLeft: 8 }}>
                      Window (ms)
                    </span>
                    <input
                      type="number"
                      min={50}
                      max={4000}
                      step={50}
                      value={searchWindowMs}
                      onChange={(e) =>
                        setSearchWindowMs(
                          Math.max(50, Number(e.target.value) || 400)
                        )
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                {/* Candidate chips */}
                <div className="sfx-candidate-grid">
                  {candidates.length === 0 ? (
                    <div className="sfx-candidate-empty">
                      Click <strong>Find Seamless Loops</strong> (or press{" "}
                      <kbd className="sfx-kbd">F</kbd>) to scan for phase-aligned
                      loop regions.
                    </div>
                  ) : (
                    candidates.map((c, idx) => {
                      const pct = Math.round(c.score * 100);
                      const lenS = ((c.end - c.start) / sampleRate).toFixed(2);
                      return (
                        <button
                          key={`${c.start}-${c.end}-${idx}`}
                          type="button"
                          onClick={() => applyCandidate(idx)}
                          className={`sfx-candidate-chip ds-tnum ${
                            idx === candIndex ? "active" : ""
                          }`}
                          title={`Start: ${(c.start / sampleRate).toFixed(
                            2
                          )}s → End: ${(c.end / sampleRate).toFixed(2)}s`}
                        >
                          <span className="rank">#{idx + 1}</span>
                          <span className="score">{pct}%</span>
                          <span className="dur">{lenS}s</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </section>

            {/* Column 3: Real-Time Seam Phase Scope */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Seam Continuity Scope</span>
                <span className="sfx-rack-hint ds-tnum">
                  Step Δ {seamMetrics.stepDelta.toFixed(4)} · Energy{" "}
                  {Math.round(seamMetrics.energyMatch * 100)}%
                </span>
              </div>
              <SeamScope
                bakedChannels={bakedChannels}
                sampleRate={sampleRate}
                fadeSamples={loopEnabled ? fadeSamples : 0}
              />
              <div className="sfx-seam-caption">
                <span>
                  Visualizes the last 25ms (<strong style={{ color: "var(--danger-400)" }}>TAIL</strong>) wrapping into the first 25ms (<strong style={{ color: "var(--success-500)" }}>HEAD</strong>) of the baked loop.
                </span>
              </div>
            </section>
          </div>
        )}

        {activeModule === "shaper" && (
          <div className="sfx-rack-grid">
            {/* Column 1: Crop / Trim Region */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Crop / Trim Region</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    disabled={!sourceChannels}
                    onClick={handleAutoTrimSilence}
                    className="ds-btn ds-btn-secondary ds-btn-sm"
                    title="Automatically detect and crop leading and trailing silence below -50 dBFS"
                  >
                    <Wand2 size={12} />
                    Auto-Trim Silence
                  </button>
                  <label
                    className="ds-switch-item"
                    style={{ fontSize: "var(--font-size-xs)" }}
                  >
                    <div
                      className={`ds-switch-track ${
                        shaper.enabled ? "on" : ""
                      }`}
                      onClick={() =>
                        setShaper((s) => ({ ...s, enabled: !s.enabled }))
                      }
                    >
                      <div className="ds-switch-thumb" />
                    </div>
                  </label>
                </div>
              </div>

              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Trim Start (ms)"
                    tip="Crops audio from the beginning of the file. You can also drag the green IN handle directly on the waveform."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(
                        100,
                        Math.floor(
                          (rawTotalSamples / sampleRate) * 1000 -
                            shaper.trimEndMs -
                            20
                        )
                      )}
                      step={5}
                      value={shaper.trimStartMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          trimStartMs: Math.max(0, Number(e.target.value)),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <input
                      type="number"
                      min={0}
                      max={Math.floor((rawTotalSamples / sampleRate) * 1000)}
                      step={10}
                      value={shaper.trimStartMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          trimStartMs: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Trim End (ms)"
                    tip="Crops audio from the end of the file. You can also drag the red OUT handle directly on the waveform."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(
                        100,
                        Math.floor(
                          (rawTotalSamples / sampleRate) * 1000 -
                            shaper.trimStartMs -
                            20
                        )
                      )}
                      step={5}
                      value={shaper.trimEndMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          trimEndMs: Math.max(0, Number(e.target.value)),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <input
                      type="number"
                      min={0}
                      max={Math.floor((rawTotalSamples / sampleRate) * 1000)}
                      step={10}
                      value={shaper.trimEndMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          trimEndMs: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <span className="sfx-rack-label">Cropped Length</span>
                  <span className="sfx-val-readout ds-tnum" style={{ minWidth: 160 }}>
                    {totalDurationS.toFixed(3)}s (of{" "}
                    {(rawTotalSamples / sampleRate).toFixed(3)}s)
                  </span>
                </div>
              </div>
            </section>

            {/* Column 2: Boundary Fades */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Fade In &amp; Fade Out</span>
                <button
                  type="button"
                  onClick={() => setShaper(DEFAULT_SHAPER_SPEC)}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  title="Reset all crop, fade, and gain settings"
                >
                  Reset All
                </button>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Fade-In (ms)"
                    tip="Smoothly ramps volume up from silence at the start of the cropped region (shown in amber on the waveform)."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={Math.min(
                        5000,
                        Math.max(100, Math.floor(totalDurationS * 500))
                      )}
                      step={5}
                      value={shaper.fadeInMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          fadeInMs: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={10}
                      value={shaper.fadeInMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          fadeInMs: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Fade-Out (ms)"
                    tip="Smoothly ramps volume down to silence at the end of the cropped region (shown in amber on the waveform)."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={Math.min(
                        5000,
                        Math.max(100, Math.floor(totalDurationS * 500))
                      )}
                      step={5}
                      value={shaper.fadeOutMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          fadeOutMs: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={10}
                      value={shaper.fadeOutMs}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          fadeOutMs: Math.max(0, Number(e.target.value) || 0),
                        }))
                      }
                      className="sfx-num-input ds-tnum"
                    />
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Fade Curve"
                    tip="Shape of the fade-in and fade-out slopes."
                  />
                  <div className="sfx-pill-group">
                    {(
                      [
                        ["cosine", "S-Curve"],
                        ["equal-power", "Fast Attack"],
                        ["linear", "Linear"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() =>
                          setShaper((s) => ({
                            ...s,
                            enabled: true,
                            fadeCurve: val,
                          }))
                        }
                        className={`sfx-choice-pill ${
                          shaper.fadeCurve === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Column 3: Gain, Normalization & Polarity */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Gain &amp; Normalization</span>
                <span className="sfx-rack-hint ds-tnum">
                  Peak{" "}
                  {signalStats.peakDbfs > -119
                    ? `${signalStats.peakDbfs.toFixed(1)} dB`
                    : "—"}
                </span>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Output Gain (dB)"
                    tip="Boost or attenuate overall volume in decibels."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={-24}
                      max={24}
                      step={0.5}
                      value={shaper.gainDb}
                      onChange={(e) =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          gainDb: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {shaper.gainDb >= 0
                        ? `+${shaper.gainDb.toFixed(1)}`
                        : shaper.gainDb.toFixed(1)}{" "}
                      dB
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Peak Normalize"
                    tip="Automatically scales the sound so its loudest peak hits the exact target ceiling."
                  />
                  <div className="sfx-pill-group">
                    {(
                      [
                        [null, "Off"],
                        [-0.1, "-0.1 dB"],
                        [-1.0, "-1.0 dB"],
                        [-3.0, "-3.0 dB"],
                        [-6.0, "-6.0 dB"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={String(val)}
                        type="button"
                        onClick={() =>
                          setShaper((s) => ({
                            ...s,
                            enabled: true,
                            normalizePeakDbfs: val,
                          }))
                        }
                        className={`sfx-choice-pill ${
                          shaper.normalizePeakDbfs === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Phase &amp; Direction"
                    tip="Reverse plays the cropped region backwards; Remove DC Offset centers the waveform on zero."
                  />
                  <div className="sfx-pill-group">
                    <button
                      type="button"
                      onClick={() =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          reverse: !s.reverse,
                        }))
                      }
                      className={`sfx-choice-pill ${
                        shaper.reverse ? "active" : ""
                      }`}
                    >
                      Reverse Audio
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setShaper((s) => ({
                          ...s,
                          enabled: true,
                          dcOffsetRemove: !s.dcOffsetRemove,
                        }))
                      }
                      className={`sfx-choice-pill ${
                        shaper.dcOffsetRemove ? "active" : ""
                      }`}
                    >
                      Remove DC Offset
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeModule === "eq" && (
          <div className="sfx-rack-grid">
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">High / Low Cut Filters</span>
                <label
                  className="ds-switch-item"
                  style={{ fontSize: "var(--font-size-xs)" }}
                >
                  <div
                    className={`ds-switch-track ${eq.enabled ? "on" : ""}`}
                    onClick={() => setEq((s) => ({ ...s, enabled: !s.enabled }))}
                  >
                    <div className="ds-switch-thumb" />
                  </div>
                  <span style={{ color: "var(--text-secondary)" }}>Enable</span>
                </label>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">High-Pass (Hz)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={20}
                      max={1200}
                      step={5}
                      value={eq.highpassHz}
                      onChange={(e) =>
                        setEq((s) => ({
                          ...s,
                          enabled: true,
                          highpassHz: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {eq.highpassHz <= 22 ? "Off" : `${eq.highpassHz} Hz`}
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Low-Pass (Hz)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={400}
                      max={20000}
                      step={100}
                      value={eq.lowpassHz}
                      onChange={(e) =>
                        setEq((s) => ({
                          ...s,
                          enabled: true,
                          lowpassHz: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {eq.lowpassHz >= 19500
                        ? "Off"
                        : `${(eq.lowpassHz / 1000).toFixed(1)} kHz`}
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Quick Presets</label>
                  <div className="sfx-pill-group">
                    <button
                      type="button"
                      onClick={() => setEq(DEFAULT_EQ_SPEC)}
                      className="sfx-choice-pill"
                    >
                      Flat
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEq({
                          ...DEFAULT_EQ_SPEC,
                          enabled: true,
                          highpassHz: 110,
                          lowGainDb: -3,
                        })
                      }
                      className="sfx-choice-pill"
                    >
                      De-Rumble
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEq({
                          ...DEFAULT_EQ_SPEC,
                          enabled: true,
                          highpassHz: 60,
                          lowpassHz: 2400,
                          highGainDb: -6,
                        })
                      }
                      className="sfx-choice-pill"
                    >
                      Warm Ambience
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEq({
                          ...DEFAULT_EQ_SPEC,
                          enabled: true,
                          highpassHz: 420,
                          lowpassHz: 3400,
                          midGainDb: 6,
                          midFreqHz: 1400,
                          midQ: 1.8,
                        })
                      }
                      className="sfx-choice-pill"
                    >
                      Radio Comms
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">3-Band Parametric Tone</span>
                <button
                  type="button"
                  onClick={() => setEq(DEFAULT_EQ_SPEC)}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Reset EQ
                </button>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Low Shelf (120Hz)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={-15}
                      max={15}
                      step={0.5}
                      value={eq.lowGainDb}
                      onChange={(e) =>
                        setEq((s) => ({
                          ...s,
                          enabled: true,
                          lowGainDb: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {eq.lowGainDb >= 0
                        ? `+${eq.lowGainDb.toFixed(1)}`
                        : eq.lowGainDb.toFixed(1)}{" "}
                      dB
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">
                    Mid Peak ({eq.midFreqHz}Hz)
                  </label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={-15}
                      max={15}
                      step={0.5}
                      value={eq.midGainDb}
                      onChange={(e) =>
                        setEq((s) => ({
                          ...s,
                          enabled: true,
                          midGainDb: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {eq.midGainDb >= 0
                        ? `+${eq.midGainDb.toFixed(1)}`
                        : eq.midGainDb.toFixed(1)}{" "}
                      dB
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">High Shelf (4.5k)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={-15}
                      max={15}
                      step={0.5}
                      value={eq.highGainDb}
                      onChange={(e) =>
                        setEq((s) => ({
                          ...s,
                          enabled: true,
                          highGainDb: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {eq.highGainDb >= 0
                        ? `+${eq.highGainDb.toFixed(1)}`
                        : eq.highGainDb.toFixed(1)}{" "}
                      dB
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">EQ Frequency Response</span>
                <span className="sfx-rack-hint">20 Hz – 20 kHz</span>
              </div>
              <EqResponseGraph spec={eq} sampleRate={sampleRate} />
            </section>
          </div>
        )}

        {activeModule === "variations" && (
          <div className="sfx-rack-grid sfx-rack-grid-variations">
            {/* Column 1: Pitch, Drift & Volume */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Pitch &amp; Movement</span>
                <div className="sfx-pill-group">
                  {(
                    [
                      ["foley", "Foley"],
                      ["melodic", "Melodic"],
                    ] as const
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setVarSpec((s) => ({ ...s, mode: m }))}
                      className={`sfx-choice-pill ${
                        varSpec.mode === m ? "active" : ""
                      }`}
                      title={
                        m === "foley"
                          ? "Foley mode: continuous pitch shifts and organic internal movement"
                          : "Melodic mode: keeps takes in key at low settings, or snaps to musical scale steps at high settings"
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Pitch Shift"
                    tip="Shifts the overall pitch of each take up or down (evenly spread across your takes so no two sound identical). Great for footsteps, impacts, and weapons."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={varSpec.pitchShift}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          pitchShift: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.pitchShift}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Pitch Drift"
                    tip="Bends pitch and speed dynamically over time along a smooth curve (amber line) without changing the total length of the sound. Ideal for whooshes, creaks, vocals, and textures."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={varSpec.driftAmount}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          driftAmount: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.driftAmount}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Volume Swell"
                    tip="Varies the loudness contour over time (teal line) as well as the overall hit strength of each take."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={varSpec.volumeAmount}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          volumeAmount: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.volumeAmount}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Curve Complexity"
                    tip="Number of random inflection points along the Pitch Drift and Volume Swell curves (2 = slow gentle bend, 16 = fast wobbly movement)."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={2}
                      max={16}
                      step={1}
                      value={varSpec.controlPoints}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          controlPoints: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.controlPoints} pts
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label
                    className="ds-check"
                    onClick={() =>
                      setVarSpec((s) => ({
                        ...s,
                        linkPitchAndVolume: !s.linkPitchAndVolume,
                      }))
                    }
                  >
                    <div
                      className={`ds-checkbox ${
                        varSpec.linkPitchAndVolume ? "on" : ""
                      }`}
                    >
                      {varSpec.linkPitchAndVolume && (
                        <div className="ds-checkbox-inner" />
                      )}
                    </div>
                    <span
                      className="ds-check-label"
                      style={{ fontSize: "var(--font-size-xs)" }}
                    >
                      Link pitch &amp; volume movement
                    </span>
                  </label>
                </div>
              </div>
            </section>

            {/* Column 2: Tone, Protection & Character */}
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">
                  Tone, Timing &amp; Protection
                </span>
                <div className="sfx-rack-control-inline" style={{ flex: "none" }}>
                  <span className="sfx-rack-hint">Takes</span>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    step={1}
                    value={varSpec.count}
                    onChange={(e) =>
                      setVarSpec((s) => ({
                        ...s,
                        count: Math.max(
                          1,
                          Math.min(12, Number(e.target.value) || 6)
                        ),
                      }))
                    }
                    className="sfx-num-input ds-tnum"
                    style={{ width: 52, height: 22 }}
                  />
                </div>
              </div>

              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Tone Variation"
                    tip="Controls how much EQ color (brightness, warmth, and resonant body) varies per take. Harder hits are naturally brighter; set to 0% for zero EQ change."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={varSpec.toneSpread}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          toneSpread: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.toneSpread}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Attack Punch"
                    tip="Subtly varies the crispness and snap of the first 30ms of each take so rapid-fire footsteps or weapon hits never sound robotic ('machine-gun effect')."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={varSpec.attackSnap}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          attackSnap: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.attackSnap}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Length Variation"
                    tip="How much faster or slower (shorter or longer) each take is allowed to be. Set to 0% when variations must stay locked to an exact animation length."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={25}
                      step={1}
                      value={varSpec.lengthSpreadPct}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          lengthSpreadPct: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                    />
                    <span className="sfx-val-readout ds-tnum">
                      ±{varSpec.lengthSpreadPct}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <LabelWithTip
                    label="Protect Start / End"
                    tip="Fades the internal Pitch Drift and Volume Swell in at the start and out at the end so your initial impact stays untouched and your tail/loop end stays anchored."
                  />
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={45}
                      step={1}
                      value={varSpec.protectStartPct}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          protectStartPct: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                      title={`Protect Start: ${varSpec.protectStartPct}%`}
                    />
                    <input
                      type="range"
                      min={0}
                      max={45}
                      step={1}
                      value={varSpec.protectEndPct}
                      onChange={(e) =>
                        setVarSpec((s) => ({
                          ...s,
                          protectEndPct: Number(e.target.value),
                        }))
                      }
                      className="sfx-range-input"
                      title={`Protect End: ${varSpec.protectEndPct}%`}
                    />
                    <span className="sfx-val-readout ds-tnum">
                      {varSpec.protectStartPct}% / {varSpec.protectEndPct}%
                    </span>
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label
                    className="ds-check"
                    onClick={() =>
                      setVarSpec((s) => ({
                        ...s,
                        preserveFormants: !s.preserveFormants,
                      }))
                    }
                  >
                    <div
                      className={`ds-checkbox ${
                        varSpec.preserveFormants ? "on" : ""
                      }`}
                    >
                      {varSpec.preserveFormants && (
                        <div className="ds-checkbox-inner" />
                      )}
                    </div>
                    <span
                      className="ds-check-label"
                      style={{ fontSize: "var(--font-size-xs)" }}
                    >
                      Preserve natural body when pitching (Formants)
                    </span>
                  </label>
                </div>
              </div>
            </section>

            {/* Column 3: Generated Round-Robin Takes & Curation */}
            <section className="sfx-rack-card sfx-rack-card-wide">
              <div className="sfx-rack-card-head">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="ds-panel-title">
                    Round-Robin Takes ({variations.length})
                  </span>
                  {variations.some((v) => v.liked) && (
                    <span className="ds-badge ds-badge-accent ds-tnum">
                      {variations.filter((v) => v.liked).length} liked
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    disabled={!processedChannels}
                    onClick={handleGenerateVariations}
                    className="ds-btn ds-btn-primary ds-btn-sm"
                  >
                    <Dices size={13} />
                    Generate {varSpec.count} Takes
                  </button>

                  {variations.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleTestRoundRobin}
                      className={`ds-btn ds-btn-sm ${
                        isTestingRR ? "ds-btn-danger" : "ds-btn-secondary"
                      }`}
                      title="Rapid-fire through your generated (or liked) takes in sequence to test for the machine-gun effect"
                    >
                      {isTestingRR ? <Square size={12} /> : <Play size={12} />}
                      {isTestingRR ? "Stop Test" : "Test Sequence"}
                    </button>
                  )}

                  {variations.length > 0 && hit && (
                    <button
                      type="button"
                      disabled={savingBatch}
                      onClick={handleSaveLikedVariationsToLibrary}
                      className="ds-btn ds-btn-secondary ds-btn-sm"
                      title="Save liked variations (or all if none starred) into the library folder and index immediately"
                    >
                      <Save size={13} />
                      {savingBatch
                        ? "Saving…"
                        : variations.some((v) => v.liked)
                        ? `Save Liked (${
                            variations.filter((v) => v.liked).length
                          })`
                        : "Save All"}
                    </button>
                  )}

                  {variations.length > 0 && (
                    <button
                      type="button"
                      onClick={handleDownloadLikedVariations}
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      title="Download liked variations (or all if none starred) as WAV files"
                    >
                      <Download size={13} />
                      Export
                    </button>
                  )}
                </div>
              </div>

              {variations.length === 0 ? (
                <div className="sfx-candidate-empty">
                  Dial in your variation amounts on the left (hover any{" "}
                  <strong>?</strong> icon for details) and click{" "}
                  <strong>Generate {varSpec.count} Takes</strong>. Then use{" "}
                  <strong>Test Sequence</strong> to hear them fire back-to-back,
                  heart your favorites, drag takes into your DAW, or save them
                  to your library.
                </div>
              ) : (
                <div className="sfx-var-takes-grid">
                  {variations.map((v, idx) => {
                    const isAct = idx === activeVarIdx;
                    return (
                      <div
                        key={v.id}
                        draggable
                        onDragStart={(e) => handleVariationDragStart(e, v)}
                        onClick={() => auditionVariation(v, idx)}
                        className={`sfx-var-take-card ${
                          isAct ? "active" : ""
                        } ${v.liked ? "liked" : ""}`}
                        title="Click to audition · Drag into DAW · Heart to keep"
                      >
                        <div className="sfx-var-take-top">
                          <span className="sfx-var-take-title ds-tnum">
                            #{idx + 1} · {v.durationS.toFixed(2)}s
                          </span>
                          <span className="sfx-var-take-pitch ds-tnum">
                            {v.meanSemitones >= 0
                              ? `+${v.meanSemitones.toFixed(1)}`
                              : v.meanSemitones.toFixed(1)}{" "}
                            st
                          </span>
                          <div
                            className="sfx-var-take-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => handleRerollSingleVariation(idx)}
                              className="sfx-var-mini-btn"
                              title="Re-roll this variation"
                            >
                              <Dices size={12} />
                            </button>
                            {hit && (
                              <button
                                type="button"
                                disabled={savingBatch}
                                onClick={() =>
                                  void handleSaveVariationToLibrary(v)
                                }
                                className="sfx-var-mini-btn"
                                title="Save this variation to library"
                              >
                                <Save size={12} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleVariationLike(idx)}
                              className={`sfx-var-mini-btn ${
                                v.liked ? "liked" : ""
                              }`}
                              title={
                                v.liked
                                  ? "Liked (included in batch save)"
                                  : "Like this variation"
                              }
                            >
                              <Heart
                                size={12}
                                fill={v.liked ? "currentColor" : "none"}
                              />
                            </button>
                          </div>
                        </div>

                        <VariationWaveCardCanvas
                          peaks={v.peaks}
                          pitchCurve={v.pitchCurve}
                          volumeCurve={v.volumeCurve}
                          isActive={isAct}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Studio Footer Status Bar */}
      <footer className="sfx-statusbar">
        <span className="ds-tnum">{statusMsg}</span>
        <span className="sfx-statusbar-shortcuts">
          Space preview · F find loops · S test seam · [ / ] pick marker · ←/→
          nudge (Shift 10ms) · Scroll zoom · Drag pan · Esc back to library
        </span>
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a,.aiff"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void loadLocalFile(f);
          }
          e.target.value = "";
        }}
      />
    </div>
  );
};
