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
  Download,
  FolderOpen,
  GripHorizontal,
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
import { encodeWav, WavFormat } from "./audio/wav";
import { EditorWaveform, EditorWaveformHandle } from "./EditorWaveform";
import { EqResponseGraph, SeamScope } from "./SeamScope";
import type { SearchMessage } from "./workers/search.worker";

export type EditorModuleId = "loop" | "shaper" | "eq" | "variations";

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

  // Module 1: Seamless Loop state
  const [loopEnabled, setLoopEnabled] = useState<boolean>(true);
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

  // Export & Library save state
  const [exportFormat, setExportFormat] = useState<WavFormat>("int24");
  const [saveSuffix, setSaveSuffix] = useState<string>(".loop");
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
  useEffect(() => {
    if (!sourceChannels || sourceChannels.length === 0) {
      setProcessedChannels(null);
      return;
    }
    const processed = applyDspChain(sourceChannels, sampleRate, shaper, eq);
    setProcessedChannels(processed);
  }, [sourceChannels, sampleRate, shaper, eq]);

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
    },
    [processedChannels, sourceChannels, snapZero, snapSample]
  );

  // Playhead RAF loop
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const tp = transportRef.current;
      let shown: number | null = null;
      if (tp && processedChannels) {
        if (tp.playing) {
          const p = tp.positionSamples();
          shown =
            p === null ? null : tp.mode === "loop" ? loopStart + p : p;
          if (shown !== null) {
            cursorRef.current = shown;
          }
        } else if (cursorVisibleRef.current) {
          shown = cursorRef.current;
        }
      }
      waveRef.current?.setPlayhead(shown);
      if (processedChannels) {
        setTimePosText(
          formatDuration(shown ?? cursorRef.current, sampleRate)
        );
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [processedChannels, loopStart, sampleRate]);

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
    tp.stop();
    cursorRef.current = loopStart;
    cursorVisibleRef.current = false;
    setIsPlaying(false);
  }, [loopStart]);

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
      const len = processedChannels[0].length;
      const s = Math.max(0, Math.min(Math.round(sample), len - 1));
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
    [processedChannels, auditionMode, loopEnabled, loopStart, loopEnd]
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
    const cleanSuffix = (saveSuffix.trim() || ".loop").replace(/^\.?/, ".");
    const filename = `${baseName}${cleanSuffix}.wav`;
    return { wav, filename };
  }, [bakedChannels, processedChannels, sampleRate, exportFormat, saveSuffix, baseName]);

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
          setStatusMsg("Active marker: Loop Start (S) — use ←/→ to nudge");
          break;
        case "BracketRight":
          e.preventDefault();
          setActiveMarker("end");
          setStatusMsg("Active marker: Loop End (E) — use ←/→ to nudge");
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const delta = (e.code === "ArrowRight" ? 1 : -1) * stepSamples;
          if (activeMarker === "start") {
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

  const loopMarkers = useMemo(
    () =>
      processedChannels
        ? {
            start: loopStart,
            end: loopEnd,
            fade: loopEnabled ? fadeSamples : 0,
            fadeAtHead,
          }
        : null,
    [processedChannels, loopStart, loopEnd, loopEnabled, fadeSamples, fadeAtHead]
  );

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
            <Sparkles size={14} />
            <span>Variations &amp; Export</span>
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
          channels={processedChannels}
          sampleRate={sampleRate}
          loop={loopMarkers}
          candidates={candidates}
          activeCandidate={candIndex}
          activeMarker={activeMarker}
          onLoopChange={(s, e) => updateLoopPoints(s, e, snapZero)}
          onPickCandidate={(idx) => applyCandidate(idx)}
          onSeek={seekToSample}
          onSelectMarker={setActiveMarker}
        />

        {/* Stage Overlay HUD: Legend + Zoom Controls */}
        <div className="sfx-editor-stage-hud-left">
          <span className="sfx-hud-pill start">
            <span className="dot" />S{" "}
            {(loopStart / sampleRate).toFixed(3)}s
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
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Gain &amp; Normalization</span>
                <label
                  className="ds-switch-item"
                  style={{ fontSize: "var(--font-size-xs)" }}
                >
                  <div
                    className={`ds-switch-track ${shaper.enabled ? "on" : ""}`}
                    onClick={() =>
                      setShaper((s) => ({ ...s, enabled: !s.enabled }))
                    }
                  >
                    <div className="ds-switch-thumb" />
                  </div>
                  <span style={{ color: "var(--text-secondary)" }}>Enable</span>
                </label>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Output Gain (dB)</label>
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
                  <label className="sfx-rack-label">Peak Normalize</label>
                  <div className="sfx-pill-group">
                    {(
                      [
                        [null, "Off"],
                        [-0.1, "-0.1 dBFS"],
                        [-1.0, "-1.0 dBFS"],
                        [-3.0, "-3.0 dBFS"],
                        [-6.0, "-6.0 dBFS"],
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
                  <label className="sfx-rack-label">Signal Polarity</label>
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

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Boundary Fades</span>
                <button
                  type="button"
                  onClick={() => setShaper(DEFAULT_SHAPER_SPEC)}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Reset
                </button>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Fade-In (ms)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={2000}
                      step={10}
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
                  <label className="sfx-rack-label">Fade-Out (ms)</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="range"
                      min={0}
                      max={2000}
                      step={10}
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
              </div>
            </section>

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Non-Destructive Chain</span>
              </div>
              <div className="sfx-seam-caption" style={{ marginTop: 4 }}>
                All Trim, Gain, Normalization, and Fade settings process in
                32-bit floating point before the Seamless Loop stage. Your
                original file on disk is untouched unless you explicitly choose
                overwrite.
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
          <div className="sfx-rack-grid">
            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">Export &amp; Library Save</span>
              </div>
              <div className="sfx-rack-fields">
                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">WAV Bit Depth</label>
                  <div className="sfx-pill-group">
                    {(
                      [
                        ["int16", "16-bit PCM"],
                        ["int24", "24-bit PCM"],
                        ["float32", "32-bit Float"],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setExportFormat(val)}
                        className={`sfx-choice-pill ${
                          exportFormat === val ? "active" : ""
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sfx-rack-row">
                  <label className="sfx-rack-label">Library Suffix</label>
                  <div className="sfx-rack-control-inline">
                    <input
                      type="text"
                      value={saveSuffix}
                      onChange={(e) => setSaveSuffix(e.target.value)}
                      placeholder=".loop"
                      className="sfx-num-input"
                      style={{ width: 96 }}
                    />
                    {hit && (
                      <button
                        type="button"
                        disabled={!processedChannels || savingToLibrary}
                        onClick={() => handleSaveToLibrary(false)}
                        className="ds-btn ds-btn-primary ds-btn-sm"
                      >
                        <Save size={13} />
                        Save as New File
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">
                  Similarity &amp; Variations
                </span>
              </div>
              <div className="sfx-rack-fields">
                <p className="sfx-seam-caption" style={{ margin: 0 }}>
                  Use your edited loop or trimmed region as a CLAP audio query to
                  discover matching textures and variations across your library.
                </p>
                <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 6 }}>
                  <button
                    type="button"
                    disabled={!processedChannels}
                    onClick={handleFindSimilarEdited}
                    className="ds-btn ds-btn-secondary ds-btn-sm"
                  >
                    <Sparkles size={13} />
                    Find Similar to Edited Audio
                  </button>
                </div>
              </div>
            </section>

            <section className="sfx-rack-card">
              <div className="sfx-rack-card-head">
                <span className="ds-panel-title">DAW Drag &amp; Drop</span>
              </div>
              <div className="sfx-seam-caption">
                Drag the <strong>Drag WAV</strong> chip in the top-right header
                directly into Reaper, Ableton Live, Pro Tools, Unreal, or Unity.
                The baked loop and active DSP chain are rendered on-the-fly.
              </div>
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
