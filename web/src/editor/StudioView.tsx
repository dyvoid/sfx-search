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
  ArrowRight,
  Dices,
  Download,
  FolderOpen,
  GripHorizontal,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Replace,
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Square,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { revealInExplorer, saveToLibraryFolder } from "../api";
import { KeyHints } from "../components/KeyHints";
import { SpectrumMeter } from "../components/SpectrumMeter";
import { FolderEntry, SearchHit } from "../types";
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
import {
  describeSpec,
  downloadBlob,
  encodeForDownload,
  extensionOf,
  loadOutputSpec,
  normalizeSpec,
  OutputSpec,
  specParams,
  storeOutputSpec,
  stripExtension,
  uploadWav,
  withExtension,
} from "./audio/outputFormat";
import { encodeWav, WavFormat } from "./audio/wav";
import { EditorWaveform, EditorWaveformHandle } from "./EditorWaveform";
import { OutputDialog } from "./OutputDialog";
import { LoopPanels, LoopSearchMode } from "./panels/LoopPanels";
import { TakesPanel } from "./panels/TakesPanel";
import { ToneEqPanels } from "./panels/ToneEqPanels";
import { TrimGainPanels } from "./panels/TrimGainPanels";
import { VariationControls } from "./panels/VariationControls";
import {
  DerivedSource,
  originHit,
  sourceFilename,
  StudioSource,
  StudioStatus,
} from "./studioSource";
import type { SearchMessage } from "./workers/search.worker";

/** The edit page is the base; Loop and Variations are made from its output. */
export type StudioPage = "edit" | "loop" | "variations";
export type EditModule = "shaper" | "eq";

const DEFAULT_LOOP_FADE_MS = 350;
const DEFAULT_LOOP_CURVE: FadeCurve = "equal-power";

const CURVE_NAMES: Record<FadeCurve, string> = {
  "equal-power": "equal-power",
  cosine: "cosine",
  linear: "linear",
};

interface StudioViewProps {
  /** What this session edits; fixed for the session (a new source is a new session). */
  source: StudioSource;
  /** Visible and in front: owns the keyboard and may play audio. */
  active: boolean;
  /** Library folders, for choosing where Save to Library writes. */
  libraryFolders: FolderEntry[];
  libraryRoots: string[];
  onOpenFile: (file: File) => void;
  /** A rendered loop or take becomes the file being edited (undoable from the app). */
  onReplaceSource: (source: DerivedSource) => void;
  onFindSimilarFromAudio: (file: File) => void;
  onSavedToLibrary: (newHit: SearchHit) => void;
  onStatus: (status: StudioStatus) => void;
}

export const StudioView: React.FC<StudioViewProps> = ({
  source,
  active,
  libraryFolders,
  libraryRoots,
  onOpenFile,
  onReplaceSource,
  onFindSimilarFromAudio,
  onSavedToLibrary,
  onStatus,
}) => {
  const waveRef = useRef<EditorWaveformHandle | null>(null);
  const transportRef = useRef<StudioTransport | null>(null);
  const searchWorkerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const takesGridRef = useRef<HTMLDivElement | null>(null);
  const bakeTimerRef = useRef<number>(0);

  const sourceName = sourceFilename(source);
  const libHit = source.kind === "library" ? source.hit : null;
  const origin = originHit(source);
  const baseName = useMemo(
    () => sourceName.replace(/\.[^.]+$/, "") || "sound",
    [sourceName]
  );

  // Source audio state
  const [sourceChannels, setSourceChannels] = useState<Float32Array[] | null>(
    null
  );
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [decoding, setDecoding] = useState<boolean>(source.kind !== "derived");
  const [decodeError, setDecodeError] = useState<string>("");

  const [page, setPage] = useState<StudioPage>("edit");
  const [editModule, setEditModule] = useState<EditModule>("shaper");

  // Loop page state. The whole sound loops by default; nothing needs changing for that.
  const [loopStart, setLoopStart] = useState<number>(0);
  const [loopEnd, setLoopEnd] = useState<number>(0);
  const [fadeMs, setFadeMs] = useState<number>(DEFAULT_LOOP_FADE_MS);
  const [fadeCurve, setFadeCurve] = useState<FadeCurve>(DEFAULT_LOOP_CURVE);
  const [bakeMode, setBakeMode] = useState<BakeMode>("auto");
  const [snapZero, setSnapZero] = useState<boolean>(true);
  const [activeMarker, setActiveMarker] = useState<"start" | "end">("start");

  // Auto-loop search state
  const [minLoopSec, setMinLoopSec] = useState<number>(1.5);
  const [searchWindowMs, setSearchWindowMs] = useState<number>(400);
  const [searchModePref, setSearchModePref] = useState<LoopSearchMode>("auto");
  const [searching, setSearching] = useState<boolean>(false);
  const [searchProgress, setSearchProgress] = useState<number>(0);
  const [candidates, setCandidates] = useState<LoopCandidate[]>([]);
  const [candIndex, setCandIndex] = useState<number>(-1);

  // Edit page state
  const [shaper, setShaper] = useState<ShaperSpec>(DEFAULT_SHAPER_SPEC);
  const [eq, setEq] = useState<EqSpec>(DEFAULT_EQ_SPEC);

  // Variations page state
  const [varSpec, setVarSpec] = useState<VariationSpec>(DEFAULT_VARIATION_SPEC);
  const [variations, setVariations] = useState<GeneratedVariation[]>([]);
  /** The edited sound the current takes were generated from. */
  const [takesBasis, setTakesBasis] = useState<Float32Array[] | null>(null);
  const [activeVarIdx, setActiveVarIdx] = useState<number>(-1);
  const [playingVarIdx, setPlayingVarIdx] = useState<number | null>(null);
  const [varPlayRatio, setVarPlayRatio] = useState<number | null>(null);
  const [savingBatch, setSavingBatch] = useState<boolean>(false);
  const varSourceRef = useRef<{
    source: AudioBufferSourceNode;
    startedAt: number;
    durationS: number;
  } | null>(null);

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

  // Drag-out stays 24-bit WAV (what DAWs expect); Save and Download use outputSpec.
  const exportFormat: WavFormat = "int24";
  const [outputSpec, setOutputSpecState] = useState<OutputSpec>(loadOutputSpec);
  const setOutputSpec = useCallback((next: OutputSpec) => {
    const spec = normalizeSpec(next);
    setOutputSpecState(spec);
    storeOutputSpec(spec);
    setSaveName((name) => (name ? withExtension(name, spec) : name));
  }, []);
  const [savingToLibrary, setSavingToLibrary] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const reportError = useCallback((msg: string) => {
    setErrMsg(msg);
    setStatusMsg(msg);
  }, []);
  /** Which output dialog is open; it acts on the current page's output. */
  const [saveDlg, setSaveDlg] = useState<"save" | "download" | null>(null);
  const [saveName, setSaveName] = useState<string>("");
  const [saveOverwrite, setSaveOverwrite] = useState<boolean>(false);
  /** Library folder Save to Library writes into; starts at the source's own folder. */
  const [saveFolder, setSaveFolder] = useState<string>(() => origin?.folder ?? "");
  const [downloading, setDownloading] = useState<boolean>(false);
  // Any save/download in flight: the dialog locks at once, the spinner waits.
  const outputBusy = savingToLibrary || savingBatch || downloading;
  const [showBusySpinner, setShowBusySpinner] = useState<boolean>(false);
  useEffect(() => {
    if (!outputBusy) {
      setShowBusySpinner(false);
      return;
    }
    // Quick jobs (a WAV download) finish before this and never flash a spinner.
    const t = window.setTimeout(() => setShowBusySpinner(true), 400);
    return () => window.clearTimeout(t);
  }, [outputBusy]);
  const saveDlgRef = useRef<HTMLDivElement | null>(null);
  const saveConfirmRef = useRef<HTMLButtonElement | null>(null);
  const saveOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (saveDlg) {
      return;
    }
    const opener = saveOpenerRef.current;
    saveOpenerRef.current = null;
    if (opener && opener.isConnected) {
      opener.focus();
    }
  }, [saveDlg]);

  const canSaveToLibrary = libraryRoots.length > 0;
  const onLoopPage = page === "loop";
  const showCrop = page === "edit" && editModule === "shaper";
  const loopAudition = onLoopPage && auditionMode === "loop";

  const fadeSamples = useMemo(
    () => Math.max(0, Math.round((fadeMs / 1000) * sampleRate)),
    [fadeMs, sampleRate]
  );

  // Ensure Web Audio transport exists
  const ensureTransport = useCallback((): StudioTransport => {
    if (!transportRef.current) {
      const t = new StudioTransport(editorAudioContext());
      t.onEnded = () => {
        // Played through: park at the start, so the next play doesn't
        // replay the last frame before the end.
        cursorRef.current = 0;
        cursorVisibleRef.current = false;
        setIsPlaying(false);
      };
      transportRef.current = t;
    }
    return transportRef.current;
  }, []);

  const stopVariationPlayback = useCallback(() => {
    const activeVar = varSourceRef.current;
    varSourceRef.current = null;
    if (activeVar) {
      try {
        activeVar.source.onended = null;
        activeVar.source.stop();
        activeVar.source.disconnect();
      } catch {
        // ignore
      }
    }
    setPlayingVarIdx(null);
    setVarPlayRatio(null);
  }, []);

  useEffect(() => {
    return () => {
      searchWorkerRef.current?.terminate();
      window.clearTimeout(bakeTimerRef.current);
      const activeVar = varSourceRef.current;
      varSourceRef.current = null;
      try {
        activeVar?.source.stop();
      } catch {
        // ignore
      }
      transportRef.current?.dispose();
      transportRef.current = null;
    };
  }, []);

  // Load the session's source once: a library file, a local file, or rendered audio.
  useEffect(() => {
    const controller = new AbortController();
    const show = (chs: Float32Array[], sr: number) => {
      const len = chs[0]?.length ?? 0;
      setSourceChannels(chs);
      setSampleRate(sr);
      setLoopStart(0);
      setLoopEnd(len);
      cursorRef.current = 0;
      cursorVisibleRef.current = false;
      setTimePosText("0:00.00");
      setDecoding(false);
      setStatusMsg(
        `${sourceName} · ${chs.length}ch · ${(sr / 1000).toFixed(
          1
        )} kHz · ${formatDuration(len, sr)}`
      );
    };
    if (source.kind === "derived") {
      show(source.channels, source.sampleRate);
      return;
    }
    setDecoding(true);
    setDecodeError("");
    setStatusMsg(`Loading ${sourceName}…`);
    const pending =
      source.kind === "library"
        ? decodeAudioUrl(
            `/api/audio/${encodeURIComponent(source.hit.file_id)}`,
            controller.signal
          )
        : decodeAudioFile(source.file);
    pending
      .then((buf) => {
        if (!controller.signal.aborted) {
          show(channelsOf(buf), buf.sampleRate);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return;
        }
        setDecoding(false);
        const msg = err instanceof Error ? err.message : String(err);
        setDecodeError(msg);
        reportError(`Could not decode audio: ${msg}`);
      });
    return () => controller.abort();
  }, [source, sourceName, reportError]);

  // Recompute the edited sound whenever source, shaper, or eq changes
  const prevProcRef = useRef<{
    len: number;
    trimStartMs: number;
    trimEndMs: number;
    reverse: boolean;
  } | null>(null);
  useEffect(() => {
    if (!sourceChannels || sourceChannels.length === 0) {
      setProcessedChannels(null);
      prevProcRef.current = null;
      return;
    }
    const processed = applyDspChain(sourceChannels, sampleRate, shaper, eq);
    const newLen = processed[0]?.length ?? 0;
    const prev = prevProcRef.current;
    prevProcRef.current = {
      len: newLen,
      trimStartMs: shaper.trimStartMs,
      trimEndMs: shaper.trimEndMs,
      reverse: shaper.reverse,
    };
    setProcessedChannels(processed);
    if (
      prev &&
      (prev.len !== newLen ||
        prev.trimStartMs !== shaper.trimStartMs ||
        prev.trimEndMs !== shaper.trimEndMs ||
        prev.reverse !== shaper.reverse)
    ) {
      // The markers pointed into the old audio, even when the length stayed
      // the same (a shifted trim): loop the whole edited sound again.
      setLoopStart(0);
      setLoopEnd(newLen);
      setCandidates([]);
      setCandIndex(-1);
    }
  }, [sourceChannels, sampleRate, shaper, eq]);

  // In Trim & Gain the waveform shows the full, uncropped sound so the IN/OUT
  // handles can be dragged and the trimmed-away parts show dimmed.
  const uncroppedChannels = useMemo(() => {
    if (!showCrop || !sourceChannels || sourceChannels.length === 0) {
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
  }, [showCrop, sourceChannels, sampleRate, shaper, eq]);

  const rawTotalSamples = sourceChannels?.[0]?.length ?? 0;
  const cropStartSamples = useMemo(
    () =>
      Math.min(
        Math.max(0, Math.round((shaper.trimStartMs / 1000) * sampleRate)),
        Math.max(0, rawTotalSamples - 4)
      ),
    [shaper.trimStartMs, sampleRate, rawTotalSamples]
  );
  const cropEndSamples = useMemo(
    () =>
      Math.max(
        cropStartSamples + 4,
        rawTotalSamples -
          Math.max(0, Math.round((shaper.trimEndMs / 1000) * sampleRate))
      ),
    [shaper.trimEndMs, sampleRate, rawTotalSamples, cropStartSamples]
  );
  // Latest marker positions for the keyboard handler. Synced every render and
  // advanced immediately on each nudge, so keys pressed faster than React
  // re-registers the handler build on the newest position, not a stale one.
  const markersRef = useRef({ cropIn: 0, cropOut: 0, loopStart: 0, loopEnd: 0 });
  markersRef.current = {
    cropIn: cropStartSamples,
    cropOut: cropEndSamples,
    loopStart,
    loopEnd,
  };

  const updateCropPoints = useCallback(
    (nextInSample: number, nextOutSample: number): [number, number] | null => {
      if (rawTotalSamples < 4) {
        return null;
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
        trimStartMs: nextTrimStartMs,
        trimEndMs: nextTrimEndMs,
      }));
      // The positions the new state will derive (ms-rounded, as cropStart/EndSamples do).
      const inSamples = Math.round((nextTrimStartMs / 1000) * sampleRate);
      return [
        inSamples,
        Math.max(
          inSamples + 4,
          rawTotalSamples - Math.round((nextTrimEndMs / 1000) * sampleRate)
        ),
      ];
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
      trimStartMs: detected.trimStartMs,
      trimEndMs: detected.trimEndMs,
    }));
    setStatusMsg(
      `Auto-trimmed silence: ${detected.trimStartMs}ms from start, ${detected.trimEndMs}ms from end`
    );
  }, [sourceChannels, sampleRate]);

  // Bake the loop & update the transport whenever the edit or loop params change
  const performBake = useCallback(
    (
      proc: Float32Array[],
      sr: number,
      start: number,
      end: number,
      fadeS: number,
      curve: FadeCurve,
      mode: BakeMode
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
        const res = bakeLoop(proc, {
          start: clampedStart,
          end: clampedEnd,
          fadeLength: fadeS,
          curve,
          mode,
        });
        setBakedChannels(res.buffers);
        setResolvedMode(res.mode);
        setFadeAtHead(res.fadeAtHead);
        setSeamMetrics(evaluateBakedSeam(res.buffers, sr));

        const tp = ensureTransport();
        tp.setFileAudio(tp.makeBuffer(proc, sr));
        tp.setLoopAudio(tp.makeBuffer(res.buffers, sr));
      } catch (err) {
        reportError(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureTransport, reportError]
  );

  const bakeCurrent = useCallback(() => {
    if (processedChannels) {
      performBake(
        processedChannels,
        sampleRate,
        loopStart,
        loopEnd,
        fadeSamples,
        fadeCurve,
        bakeMode
      );
    }
  }, [
    processedChannels,
    sampleRate,
    loopStart,
    loopEnd,
    fadeSamples,
    fadeCurve,
    bakeMode,
    performBake,
  ]);

  useEffect(() => {
    if (!processedChannels || processedChannels.length === 0) {
      return;
    }
    window.clearTimeout(bakeTimerRef.current);
    bakeTimerRef.current = window.setTimeout(bakeCurrent, 60);
    return () => window.clearTimeout(bakeTimerRef.current);
  }, [processedChannels, bakeCurrent]);

  // Peak/RMS of what this page outputs: the loop on the loop page, else the edit.
  useEffect(() => {
    const chs = onLoopPage ? bakedChannels : processedChannels;
    if (chs && chs.length > 0) {
      setSignalStats(measureSignalStats(chs));
    }
  }, [onLoopPage, bakedChannels, processedChannels]);

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
    (
      nextStart: number,
      nextEnd: number,
      shouldSnap = snapZero
    ): [number, number] | null => {
      const ch = processedChannels?.[0] ?? sourceChannels?.[0];
      if (!ch) {
        return null;
      }
      const len = ch.length;
      const s = shouldSnap ? snapSample(nextStart, true) : Math.round(nextStart);
      const e = shouldSnap ? snapSample(nextEnd, true) : Math.round(nextEnd);
      const clampedS = Math.max(0, Math.min(s, len - 2));
      const clampedE = Math.max(clampedS + 2, Math.min(e, len));
      setLoopStart(clampedS);
      setLoopEnd(clampedE);
      return [clampedS, clampedE];
    },
    [processedChannels, sourceChannels, snapZero, snapSample]
  );

  // Playhead RAF loop
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const tp = transportRef.current;
      let shown: number | null = null;
      const offsetInRaw = showCrop ? cropStartSamples : 0;
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

      // Independent mini playhead for variation take cards
      const varActive = varSourceRef.current;
      if (varActive) {
        const ctx = editorAudioContext();
        const elapsed = Math.max(0, ctx.currentTime - varActive.startedAt);
        const ratio = Math.min(
          1,
          elapsed / Math.max(0.01, varActive.durationS)
        );
        setVarPlayRatio(ratio);
      }

      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [processedChannels, loopStart, sampleRate, showCrop, cropStartSamples]);

  // Transport actions
  const togglePlay = useCallback(() => {
    if (!processedChannels) {
      return;
    }
    stopVariationPlayback();
    const tp = ensureTransport();
    if (tp.playing) {
      tp.pause();
      const p = tp.positionSamples();
      if (p !== null) {
        cursorRef.current = tp.mode === "loop" ? loopStart + p : p;
      }
      setIsPlaying(false);
    } else {
      bakeCurrent();
      cursorVisibleRef.current = true;
      const cur = cursorRef.current;
      if (loopAudition) {
        const offset =
          cur >= loopStart && cur < loopEnd ? cur - loopStart : 0;
        tp.playLoop(offset);
      } else {
        const len = processedChannels[0]?.length ?? 0;
        tp.playFile(cur >= len - 1 ? 0 : cur);
      }
      setIsPlaying(true);
    }
  }, [
    processedChannels,
    ensureTransport,
    loopStart,
    loopEnd,
    loopAudition,
    bakeCurrent,
    stopVariationPlayback,
  ]);

  const stopPlayback = useCallback(() => {
    stopVariationPlayback();
    const tp = transportRef.current;
    if (!tp) {
      return;
    }
    tp.stop();
    cursorRef.current = onLoopPage ? loopStart : 0;
    cursorVisibleRef.current = false;
    setIsPlaying(false);
  }, [onLoopPage, loopStart, stopVariationPlayback]);

  const restartLoop = useCallback(() => {
    const tp = transportRef.current;
    const from = onLoopPage ? loopStart : 0;
    cursorRef.current = from;
    cursorVisibleRef.current = true;
    if (tp?.playing) {
      if (loopAudition) {
        tp.playLoop(0);
      } else {
        tp.playFile(from);
      }
    }
  }, [onLoopPage, loopStart, loopAudition]);

  const auditionSeam = useCallback(() => {
    if (!processedChannels) {
      return;
    }
    const tp = ensureTransport();
    bakeCurrent();
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
    bakeCurrent,
    sampleRate,
    loopStart,
    loopEnd,
  ]);

  const seekToSample = useCallback(
    (sample: number) => {
      if (!processedChannels) {
        return;
      }
      const localSample = showCrop ? sample - cropStartSamples : sample;
      const len = processedChannels[0].length;
      const s = Math.max(0, Math.min(Math.round(localSample), len - 1));
      cursorRef.current = s;
      cursorVisibleRef.current = true;
      const tp = transportRef.current;
      if (!tp || !tp.playing) {
        return;
      }
      if (loopAudition && s >= loopStart && s < loopEnd) {
        tp.playLoop(s - loopStart);
      } else {
        tp.playFile(s);
      }
    },
    [
      processedChannels,
      showCrop,
      cropStartSamples,
      loopAudition,
      loopStart,
      loopEnd,
    ]
  );

  /** Leave for another Studio page: playback stops, the page opens at the start. */
  const goToPage = useCallback(
    (next: StudioPage) => {
      if (next === page) {
        return;
      }
      stopVariationPlayback();
      transportRef.current?.stop();
      cursorRef.current = 0;
      cursorVisibleRef.current = false;
      setIsPlaying(false);
      setAuditionMode("loop");
      setPage(next);
    },
    [page, stopVariationPlayback]
  );

  // Leaving the tab (or being held for Undo) stops playback; the position is kept.
  useEffect(() => {
    if (active) {
      return;
    }
    // A replaced session is held for Undo: it comes back without a dialog in front.
    setSaveDlg(null);
    stopVariationPlayback();
    const tp = transportRef.current;
    if (tp?.playing) {
      const p = tp.positionSamples();
      tp.pause();
      if (p !== null) {
        cursorRef.current =
          tp.mode === "loop" ? markersRef.current.loopStart + p : p;
      }
      setIsPlaying(false);
    }
  }, [active, stopVariationPlayback]);

  // Auto-Loop Search via Web Worker
  const applyCandidate = useCallback(
    (index: number, list: LoopCandidate[] = candidates) => {
      const c = list[index];
      if (!c || !processedChannels) {
        return;
      }
      setCandIndex(index);
      const pts = updateLoopPoints(c.start, c.end, snapZero);
      if (!pts) {
        return;
      }
      // Seek against the new region: the loop state hasn't updated yet, so
      // seekToSample would test against the old one and drop to file playback.
      const [s, e] = pts;
      cursorRef.current = s;
      cursorVisibleRef.current = true;
      const tp = transportRef.current;
      if (tp?.playing) {
        if (loopAudition) {
          performBake(
            processedChannels,
            sampleRate,
            s,
            e,
            fadeSamples,
            fadeCurve,
            bakeMode
          );
          tp.playLoop(0);
        } else {
          tp.playFile(s);
        }
      }
      const pct = Math.round(c.score * 100);
      const durS = ((c.end - c.start) / sampleRate).toFixed(2);
      setStatusMsg(
        `Applied loop suggestion #${index + 1}/${
          list.length
        } (${pct}% match · ${durS}s)`
      );
    },
    [
      candidates,
      processedChannels,
      updateLoopPoints,
      snapZero,
      sampleRate,
      loopAudition,
      performBake,
      fadeSamples,
      fadeCurve,
      bakeMode,
    ]
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

  const resetLoop = useCallback(() => {
    setLoopStart(0);
    setLoopEnd(processedChannels?.[0]?.length ?? 0);
    setFadeMs(DEFAULT_LOOP_FADE_MS);
    setFadeCurve(DEFAULT_LOOP_CURVE);
    setBakeMode("auto");
    setCandidates([]);
    setCandIndex(-1);
    setStatusMsg("The whole sound loops again");
  }, [processedChannels]);

  /** The loop as it would be saved now, without waiting for the debounced bake. */
  const bakeLoopNow = useCallback((): Float32Array[] | null => {
    if (!processedChannels) {
      return null;
    }
    const len = processedChannels[0]?.length ?? 0;
    if (len < 2) {
      return null;
    }
    const s = Math.max(0, Math.min(Math.floor(loopStart), len - 2));
    const e = Math.max(s + 2, Math.min(Math.floor(loopEnd), len));
    return bakeLoop(processedChannels, {
      start: s,
      end: e,
      fadeLength: fadeSamples,
      curve: fadeCurve,
      mode: bakeMode,
    }).buffers;
  }, [processedChannels, loopStart, loopEnd, fadeSamples, fadeCurve, bakeMode]);

  // ----- Output: each page saves and downloads its own result -----
  const selectedTakes = useMemo(
    () => variations.filter((v) => v.selected),
    [variations]
  );
  const outputChannels = onLoopPage ? bakedChannels : processedChannels;
  const outputStem = `${baseName}${onLoopPage ? ".loop" : ".edit"}`;

  /** Files a drag from the header carries: this page's output, as 24-bit WAV. */
  const dragFiles = useCallback((): File[] => {
    if (page === "variations") {
      return selectedTakes.map(
        (v) =>
          new File([encodeWav(v.channels, v.sampleRate, exportFormat)], `${v.name}.wav`, {
            type: "audio/wav",
          })
      );
    }
    const chs = onLoopPage ? bakeLoopNow() : processedChannels;
    if (!chs || chs.length === 0) {
      return [];
    }
    return [
      new File([encodeWav(chs, sampleRate, exportFormat)], `${outputStem}.wav`, {
        type: "audio/wav",
      }),
    ];
  }, [
    page,
    selectedTakes,
    onLoopPage,
    bakeLoopNow,
    processedChannels,
    sampleRate,
    exportFormat,
    outputStem,
  ]);

  const handleDragOutStart = (e: React.DragEvent) => {
    const files = dragFiles();
    if (files.length === 0) {
      e.preventDefault();
      return;
    }
    const dt = e.dataTransfer;
    dt.effectAllowed = "copy";
    for (const file of files) {
      try {
        dt.items.add(file);
      } catch {
        // ignore if browser blocks items.add(File)
      }
    }
    setStatusMsg(
      files.length === 1
        ? `Dragging ${files[0].name} to external app / DAW…`
        : `Dragging ${files.length} takes to external app / DAW…`
    );
  };

  const handleFindSimilarEdited = useCallback(() => {
    if (!processedChannels) {
      return;
    }
    const wav = encodeWav(processedChannels, sampleRate, exportFormat);
    onFindSimilarFromAudio(
      new File([wav], `${baseName}.edit.wav`, { type: "audio/wav" })
    );
  }, [processedChannels, sampleRate, exportFormat, baseName, onFindSimilarFromAudio]);

  const downloadOutput = useCallback(
    async (filename: string): Promise<boolean> => {
      if (!outputChannels || outputChannels.length === 0) {
        return false;
      }
      setStatusMsg(`Encoding ${filename}…`);
      setDownloading(true);
      try {
        const blob = await encodeForDownload(
          outputChannels,
          sampleRate,
          outputSpec
        );
        downloadBlob(blob, filename);
        setStatusMsg(
          `Downloaded ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`
        );
        return true;
      } catch (err) {
        reportError(
          `Download failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      } finally {
        setDownloading(false);
      }
    },
    [outputChannels, sampleRate, outputSpec, reportError]
  );

  const saveOutputToLibrary = useCallback(
    async (name: string, overwrite: boolean): Promise<boolean> => {
      if (!saveFolder || !outputChannels || outputChannels.length === 0) {
        return false;
      }
      const targetLabel = `${name}${extensionOf(outputSpec)}`;
      setSavingToLibrary(true);
      setErrMsg(null);
      setStatusMsg(
        overwrite
          ? `Saving ${targetLabel} (replace existing) and indexing…`
          : `Saving ${targetLabel} to the library and indexing…`
      );
      try {
        const savedHit = await saveToLibraryFolder(
          uploadWav(outputChannels, sampleRate, outputSpec),
          {
            folder: saveFolder,
            name,
            overwrite,
            sourceFileId: origin?.file_id ?? null,
            loop: onLoopPage,
            encode: specParams(outputSpec),
          }
        );
        onSavedToLibrary(savedHit);
        setStatusMsg(
          `Saved & indexed in library: ${savedHit.filename} (${savedHit.duration_s.toFixed(
            2
          )}s)`
        );
        return true;
      } catch (err) {
        reportError(
          `Save failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      } finally {
        setSavingToLibrary(false);
      }
    },
    [
      saveFolder,
      outputChannels,
      sampleRate,
      outputSpec,
      origin,
      onLoopPage,
      onSavedToLibrary,
      reportError,
    ]
  );

  const saveTakesToLibrary = useCallback(async (): Promise<boolean> => {
    if (!saveFolder || selectedTakes.length === 0) {
      return false;
    }
    setSavingBatch(true);
    setErrMsg(null);
    let savedCount = 0;
    try {
      for (const v of selectedTakes) {
        setStatusMsg(
          `Saving take ${savedCount + 1}/${selectedTakes.length} (${v.name}${extensionOf(
            outputSpec
          )})…`
        );
        const savedHit = await saveToLibraryFolder(
          uploadWav(v.channels, v.sampleRate, outputSpec),
          {
            folder: saveFolder,
            name: v.name,
            overwrite: false,
            sourceFileId: origin?.file_id ?? null,
            loop: false,
            encode: specParams(outputSpec),
          }
        );
        onSavedToLibrary(savedHit);
        savedCount++;
      }
      setStatusMsg(
        `Saved & indexed ${savedCount} take${savedCount === 1 ? "" : "s"} in the library`
      );
      return true;
    } catch (err) {
      reportError(
        `Save failed after ${savedCount} files: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    } finally {
      setSavingBatch(false);
    }
  }, [saveFolder, selectedTakes, outputSpec, origin, onSavedToLibrary, reportError]);

  const downloadTakes = useCallback(async (): Promise<boolean> => {
    if (selectedTakes.length === 0) {
      return false;
    }
    setSavingBatch(true);
    let done = 0;
    try {
      for (const v of selectedTakes) {
        setStatusMsg(`Downloading take ${done + 1}/${selectedTakes.length}…`);
        const blob = await encodeForDownload(v.channels, v.sampleRate, outputSpec);
        downloadBlob(blob, `${v.name}${extensionOf(outputSpec)}`);
        done++;
      }
      setStatusMsg(
        `Downloaded ${done} take${done === 1 ? "" : "s"} (${describeSpec(outputSpec)})`
      );
      return true;
    } catch (err) {
      reportError(
        `Download failed after ${done} files: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    } finally {
      setSavingBatch(false);
    }
  }, [selectedTakes, outputSpec, reportError]);

  const openOutputDialog = useCallback(
    (mode: "save" | "download") => {
      if (mode === "save" && !canSaveToLibrary) {
        return;
      }
      if (page === "variations") {
        if (selectedTakes.length === 0) {
          return;
        }
      } else {
        if (!outputChannels) {
          return;
        }
        setSaveName(`${outputStem}${extensionOf(outputSpec)}`);
      }
      setSaveOverwrite(false);
      setErrMsg(null);
      const a = document.activeElement;
      saveOpenerRef.current = a instanceof HTMLElement ? a : null;
      setSaveDlg(mode);
    },
    [
      canSaveToLibrary,
      page,
      selectedTakes.length,
      outputChannels,
      outputStem,
      outputSpec,
    ]
  );

  const confirmSave = useCallback(async () => {
    const mode = saveDlg;
    if (!mode || outputBusy) {
      return;
    }
    // Pressing Enter in the field: keep focus in the dialog once it locks.
    saveConfirmRef.current?.focus();
    let ok = false;
    if (page === "variations") {
      ok = mode === "save" ? await saveTakesToLibrary() : await downloadTakes();
    } else {
      const stem = stripExtension(saveName.trim());
      if (!stem) {
        return;
      }
      ok =
        mode === "save"
          ? await saveOutputToLibrary(stem, saveOverwrite)
          : await downloadOutput(`${stem}${extensionOf(outputSpec)}`);
    }
    if (ok) {
      setSaveDlg(null);
    }
  }, [
    saveDlg,
    outputBusy,
    page,
    saveName,
    saveOverwrite,
    outputSpec,
    saveTakesToLibrary,
    downloadTakes,
    saveOutputToLibrary,
    downloadOutput,
  ]);

  // ----- Variations -----
  const playVariationOnce = useCallback(
    (v: GeneratedVariation, idx: number) => {
      // Pause main transport if it was playing, without touching main playhead
      if (transportRef.current?.playing) {
        transportRef.current.pause();
        setIsPlaying(false);
      }
      const prev = varSourceRef.current;
      varSourceRef.current = null;
      if (prev) {
        try {
          prev.source.onended = null;
          prev.source.stop();
          prev.source.disconnect();
        } catch {
          // ignore
        }
      }

      const tp = ensureTransport();
      const ctx = editorAudioContext();
      if (ctx.state === "suspended") {
        void ctx.resume();
      }
      const buf = tp.makeBuffer(v.channels, v.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(tp.analyser);

      setActiveVarIdx(idx);
      setPlayingVarIdx(idx);
      setVarPlayRatio(0);
      varSourceRef.current = {
        source: src,
        startedAt: ctx.currentTime,
        durationS: Math.max(0.01, buf.duration),
      };

      src.onended = () => {
        if (varSourceRef.current?.source === src) {
          varSourceRef.current = null;
          setPlayingVarIdx(null);
          setVarPlayRatio(null);
        }
      };
      src.start(0);
    },
    [ensureTransport]
  );

  const auditionVariation = useCallback(
    (v: GeneratedVariation, idx: number) => {
      playVariationOnce(v, idx);
      setStatusMsg(
        `Auditioning ${v.name} (${
          v.meanSemitones >= 0
            ? `+${v.meanSemitones.toFixed(1)}`
            : v.meanSemitones.toFixed(1)
        } st · ${v.durationS.toFixed(2)}s)`
      );
    },
    [playVariationOnce]
  );

  const handleGenerateVariations = useCallback(() => {
    if (!processedChannels || processedChannels.length === 0) {
      return;
    }
    const batch = generateVariationBatch(
      processedChannels,
      sampleRate,
      varSpec,
      baseName
    );
    setVariations(batch);
    setTakesBasis(processedChannels);
    if (batch.length > 0) {
      auditionVariation(batch[0], 0);
      // On a short window the page scrolls: bring the new takes into view.
      window.requestAnimationFrame(() =>
        takesGridRef.current?.scrollIntoView({ block: "nearest" })
      );
    }
    setStatusMsg(
      `Generated ${batch.length} ${varSpec.mode} round-robin variations`
    );
  }, [processedChannels, sampleRate, varSpec, baseName, auditionVariation]);

  const handleRerollSingleVariation = useCallback(
    (idx: number) => {
      if (!processedChannels || processedChannels.length === 0) {
        return;
      }
      const fresh = synthesizeVariation(
        processedChannels,
        sampleRate,
        varSpec,
        idx,
        baseName
      );
      setVariations((prev) =>
        prev.map((item, i) =>
          i === idx ? { ...fresh, selected: item.selected } : item
        )
      );
      auditionVariation(fresh, idx);
    },
    [processedChannels, sampleRate, varSpec, baseName, auditionVariation]
  );

  const toggleTakeSelected = useCallback((idx: number) => {
    setVariations((prev) =>
      prev.map((item, i) =>
        i === idx ? { ...item, selected: !item.selected } : item
      )
    );
  }, []);

  const handleTakeDragStart = (e: React.DragEvent, v: GeneratedVariation) => {
    const wav = encodeWav(v.channels, v.sampleRate, exportFormat);
    const filename = `${v.name}.wav`;
    const dt = e.dataTransfer;
    dt.effectAllowed = "copy";
    try {
      dt.items.add(new File([wav], filename, { type: "audio/wav" }));
    } catch {
      // ignore
    }
    setStatusMsg(`Dragging ${filename} to DAW / external app…`);
  };

  // ----- Replace source: a loop or take becomes the file being edited -----
  const replaceSourceWith = useCallback(
    (name: string, channels: Float32Array[] | null, sr: number) => {
      if (!channels || channels.length === 0) {
        return;
      }
      stopVariationPlayback();
      transportRef.current?.stop();
      setIsPlaying(false);
      onReplaceSource({ kind: "derived", name, channels, sampleRate: sr, origin });
    },
    [origin, onReplaceSource, stopVariationPlayback]
  );

  // ----- Status for the app: tab label and the guards around replacing work -----
  const procLen = processedChannels?.[0]?.length ?? 0;
  const loopTouched =
    loopStart !== 0 ||
    (procLen > 0 && loopEnd !== procLen) ||
    fadeMs !== DEFAULT_LOOP_FADE_MS ||
    fadeCurve !== DEFAULT_LOOP_CURVE ||
    bakeMode !== "auto";
  const shaperActive = isShaperActive(shaper);
  const eqActive = isEqActive(eq);
  const dirty =
    source.kind === "derived" ||
    shaperActive ||
    eqActive ||
    loopTouched ||
    variations.length > 0;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    onStatusRef.current({ name: sourceName, dirty });
  }, [sourceName, dirty]);

  // Keyboard shortcuts inside StudioView
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (saveDlg && e.key === "Tab" && saveDlgRef.current) {
        const f = Array.from(
          saveDlgRef.current.querySelectorAll<HTMLElement>(
            "input, button, [tabindex]:not([tabindex='-1'])"
          )
        ).filter((el) => !(el as HTMLButtonElement).disabled);
        if (f.length > 0) {
          const first = f[0];
          const last = f[f.length - 1];
          const activeEl = document.activeElement;
          if (!saveDlgRef.current.contains(activeEl)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          } else if (e.shiftKey && activeEl === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && activeEl === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }
      const inputType =
        tag === "input" ? (target as HTMLInputElement).type : "";
      const nonTextInput = ["range", "checkbox", "radio"].includes(
        inputType
      );
      const isSaveChord =
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "s";
      const runSave = () => {
        if (saveDlg || !processedChannels || e.repeat) {
          return;
        }
        openOutputDialog(canSaveToLibrary ? "save" : "download");
      };
      if (
        (tag === "input" && !nonTextInput) ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable
      ) {
        if (isSaveChord) {
          e.preventDefault(); // block the browser's "Save page" dialog
          runSave();
        }
        if (e.key === "Escape") {
          target?.blur();
        }
        return;
      }
      // Custom toggles (<label role="checkbox"> etc.) blur on Escape like
      // native ones, so the first Escape never leaves the page from them.
      const toggleControl =
        nonTextInput ||
        Boolean(
          target?.closest("[role='checkbox'], [role='switch'], [role='radio']")
        );
      if (toggleControl && e.key === "Escape" && !saveDlg) {
        target?.blur();
        return;
      }

      if (saveDlg) {
        if (isSaveChord) {
          e.preventDefault();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (!outputBusy) {
            setSaveDlg(null);
          }
        }
        return;
      }

      if (e.key === "Escape") {
        // Back from Loop or Variations to the edit page; nothing above the edit page.
        if (page !== "edit") {
          e.preventDefault();
          goToPage("edit");
        }
        return;
      }

      if (isSaveChord) {
        e.preventDefault(); // block the browser's "Save page" dialog
      }
      if (!processedChannels) {
        return;
      }

      if ((e.ctrlKey || e.metaKey || e.altKey) && !isSaveChord) {
        return;
      }
      if (
        e.repeat &&
        e.code !== "ArrowLeft" &&
        e.code !== "ArrowRight"
      ) {
        if (isSaveChord) {
          e.preventDefault(); // still block the browser's "Save page" dialog
        }
        return;
      }

      // The save chord is matched on the typed key (layout-independent), so it
      // can't be dispatched through the e.code switch below.
      if (isSaveChord) {
        runSave();
        return;
      }

      const stepSamples = Math.max(
        1,
        Math.round((e.shiftKey ? 10 : 1) * 0.001 * sampleRate)
      );

      const onControl = Boolean(
        target?.closest(
          "button, a, [role='button'], [role='option'], [role='menuitem'], [role='switch'], [role='checkbox'], [role='tab']"
        )
      );

      // Keep native keys native on focused sliders / checkboxes.
      if (
        inputType === "range" &&
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(e.code)
      ) {
        return;
      }
      if (
        (inputType === "checkbox" || inputType === "radio") &&
        (e.code === "Space" || e.code === "Enter")
      ) {
        return;
      }

      // Markers exist only in Trim & Gain (crop handles) and on the loop page.
      const hasMarkers = showCrop || onLoopPage;
      if (
        !hasMarkers &&
        ["BracketLeft", "BracketRight", "ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        return;
      }

      switch (e.code) {
        case "Space":
          if (onControl) {
            return;
          }
          e.preventDefault();
          togglePlay();
          break;
        case "Home":
          e.preventDefault();
          restartLoop();
          break;
        case "KeyF":
          if (onLoopPage) {
            e.preventDefault();
            runLoopSearch();
          }
          break;
        case "KeyS":
          if (onLoopPage) {
            e.preventDefault();
            auditionSeam();
          }
          break;
        case "KeyG":
          if (page === "variations") {
            e.preventDefault();
            handleGenerateVariations();
          }
          break;
        case "BracketLeft":
          e.preventDefault();
          setActiveMarker("start");
          setStatusMsg(
            showCrop
              ? "Active handle: Crop IN — use ←/→ to nudge"
              : "Active marker: Loop Start (S) — use ←/→ to nudge"
          );
          break;
        case "BracketRight":
          e.preventDefault();
          setActiveMarker("end");
          setStatusMsg(
            showCrop
              ? "Active handle: Crop OUT — use ←/→ to nudge"
              : "Active marker: Loop End (E) — use ←/→ to nudge"
          );
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const delta = (e.code === "ArrowRight" ? 1 : -1) * stepSamples;
          const m = markersRef.current;
          if (showCrop) {
            const next =
              activeMarker === "start"
                ? updateCropPoints(m.cropIn + delta, m.cropOut)
                : updateCropPoints(m.cropIn, m.cropOut + delta);
            if (next) {
              [m.cropIn, m.cropOut] = next;
            }
          } else {
            const next =
              activeMarker === "start"
                ? updateLoopPoints(m.loopStart + delta, m.loopEnd, false)
                : updateLoopPoints(m.loopStart, m.loopEnd + delta, false);
            if (next) {
              [m.loopStart, m.loopEnd] = next;
            }
          }
          break;
        }
        case "Digit1":
          goToPage("edit");
          setEditModule("shaper");
          break;
        case "Digit2":
          goToPage("edit");
          setEditModule("eq");
          break;
        case "Digit3":
          goToPage("loop");
          break;
        case "Digit4":
          goToPage("variations");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    processedChannels,
    sampleRate,
    togglePlay,
    restartLoop,
    runLoopSearch,
    auditionSeam,
    handleGenerateVariations,
    page,
    showCrop,
    onLoopPage,
    goToPage,
    activeMarker,
    updateCropPoints,
    updateLoopPoints,
    canSaveToLibrary,
    openOutputDialog,
    saveDlg,
    outputBusy,
  ]);

  const totalSamples = procLen;
  const loopDurationS = Math.max(0, (loopEnd - loopStart) / sampleRate);
  const totalDurationS = Math.max(0, totalSamples / sampleRate);

  const loopMarkers = useMemo(() => {
    if (showCrop && uncroppedChannels) {
      return {
        start: cropStartSamples,
        end: cropEndSamples,
        fade: 0,
        fadeAtHead: false,
        startLabel: "IN",
        endLabel: "OUT",
        fadeInSamples: Math.round((shaper.fadeInMs / 1000) * sampleRate),
        fadeOutSamples: Math.round((shaper.fadeOutMs / 1000) * sampleRate),
        curve: shaper.fadeCurve,
        silenceOutside: true,
      };
    }
    if (processedChannels && onLoopPage) {
      return {
        start: loopStart,
        end: loopEnd,
        fade: fadeSamples,
        fadeAtHead,
        startLabel: "S",
        endLabel: "E",
        curve: fadeCurve,
        mode: resolvedMode,
      };
    }
    return null;
  }, [
    showCrop,
    uncroppedChannels,
    shaper.fadeInMs,
    shaper.fadeOutMs,
    shaper.fadeCurve,
    sampleRate,
    cropStartSamples,
    cropEndSamples,
    processedChannels,
    onLoopPage,
    loopStart,
    loopEnd,
    fadeSamples,
    fadeAtHead,
    fadeCurve,
    resolvedMode,
  ]);

  const resolvedModeLabel =
    resolvedMode === "pre"
      ? "Pre-roll (before S)"
      : resolvedMode === "post"
      ? "Post-roll (after E)"
      : "Loop head (internal)";

  /** What the edit page changes, one line each, for the output dialog. */
  const editIncluded = useMemo(() => {
    const lines: string[] = [];
    if (shaper.trimStartMs > 0 || shaper.trimEndMs > 0) {
      lines.push(
        `Trim ${(cropStartSamples / sampleRate).toFixed(2)}–${(
          cropEndSamples / sampleRate
        ).toFixed(2)} s`
      );
    }
    if (shaper.fadeInMs > 0 || shaper.fadeOutMs > 0) {
      lines.push(`Fades ${shaper.fadeInMs} / ${shaper.fadeOutMs} ms`);
    }
    if (Math.abs(shaper.gainDb) > 0.01) {
      lines.push(
        `Gain ${shaper.gainDb > 0 ? "+" : ""}${shaper.gainDb.toFixed(1)} dB`
      );
    }
    if (shaper.normalizePeakDbfs !== null) {
      lines.push(`Peak normalized to ${shaper.normalizePeakDbfs.toFixed(1)} dB`);
    }
    if (shaper.reverse) {
      lines.push("Reversed");
    }
    if (shaper.dcOffsetRemove) {
      lines.push("DC offset removed");
    }
    if (eqActive) {
      lines.push("Tone & EQ");
    }
    return lines;
  }, [shaper, cropStartSamples, cropEndSamples, sampleRate, eqActive]);

  const fromEdit = editIncluded.length > 0 ? "Edits from the edit page" : "The sound as loaded";
  const dialogIncluded =
    page === "edit"
      ? editIncluded.length > 0
        ? editIncluded
        : ["The sound as loaded, no edits"]
      : page === "loop"
      ? [
          fromEdit,
          fadeMs > 0
            ? `${Math.round(fadeMs)} ms ${CURVE_NAMES[fadeCurve]} crossfade baked in`
            : "No crossfade",
        ]
      : [
          fromEdit,
          `${selectedTakes.length} selected take${selectedTakes.length === 1 ? "" : "s"}`,
        ];

  const pageTitle = page === "loop" ? "Loop" : "Variations";
  const downloadLabel =
    page === "variations"
      ? `Download ${selectedTakes.length} file${selectedTakes.length === 1 ? "" : "s"}`
      : "Download";
  const outputReady =
    page === "variations" ? selectedTakes.length > 0 : Boolean(outputChannels);

  const dragChip = (
    <div
      draggable={outputReady}
      onDragStart={handleDragOutStart}
      className="sfx-drag-chip"
      title="Drag into your DAW, video editor, or desktop to drop this page's output as WAV"
    >
      <GripHorizontal size={14} />
      <span>Drag WAV</span>
    </div>
  );

  const outputButtons = (
    <>
      {canSaveToLibrary && (
        <button
          type="button"
          disabled={!outputReady || outputBusy}
          onClick={() => openOutputDialog("save")}
          className="ds-btn ds-btn-secondary"
          title="Save into a library folder and index it immediately (Ctrl+S)"
        >
          <Save size={14} />
          {savingToLibrary || savingBatch ? "Saving…" : "Save to Library"}
        </button>
      )}
      <button
        type="button"
        disabled={!outputReady || outputBusy}
        onClick={() => openOutputDialog("download")}
        className="ds-btn ds-btn-primary"
        title="Download this page's output, choosing name and format"
      >
        <Download size={14} />
        {downloadLabel}
      </button>
    </>
  );

  const header =
    page === "edit" ? (
      <header className="sfx-editor-header">
        <div className="sfx-editor-toolbar">
          <div className="sfx-editor-toolbar-group">
            <div className="sfx-editor-file-meta">
              <span className="sfx-editor-filename" title={libHit?.path || sourceName}>
                {sourceName}
              </span>
              <span className="sfx-editor-filespecs ds-tnum">
                {totalSamples > 0
                  ? `${processedChannels?.length ?? 1}ch · ${(sampleRate / 1000).toFixed(
                      1
                    )} kHz · ${totalDurationS.toFixed(2)}s`
                  : decodeError
                  ? "Could not load"
                  : "Loading…"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="ds-btn ds-btn-ghost"
              title="Open an audio file from your computer"
            >
              <Upload size={14} />
              Open file
            </button>
            {dragChip}
            <button
              type="button"
              disabled={!processedChannels}
              onClick={handleFindSimilarEdited}
              className="ds-btn ds-btn-ghost"
              title="Search the library for sounds like your edited audio"
            >
              <Sparkles size={14} />
              Find similar
            </button>
            {libHit && (
              <button
                type="button"
                onClick={() => revealInExplorer(libHit.file_id).catch(() => {})}
                className="ds-btn ds-btn-ghost"
                title="Show the source file in Explorer"
              >
                <FolderOpen size={14} />
                Show in Explorer
              </button>
            )}
          </div>

          <div className="sfx-editor-toolbar-group">
            <span className="ds-microlabel sfx-create-label">Create</span>
            <button
              type="button"
              disabled={!processedChannels}
              onClick={() => goToPage("loop")}
              className="ds-btn ds-btn-secondary"
              aria-label="Create loop"
              title="Make a seamless loop from the edited sound (3)"
            >
              <Repeat size={14} />
              Loop
              <ArrowRight size={13} />
              <kbd className="sfx-kbd">3</kbd>
            </button>
            <button
              type="button"
              disabled={!processedChannels}
              onClick={() => goToPage("variations")}
              className="ds-btn ds-btn-secondary"
              aria-label="Create variations"
              title="Make round-robin takes from the edited sound (4)"
            >
              <Dices size={14} />
              Variations
              <ArrowRight size={13} />
              <kbd className="sfx-kbd">4</kbd>
            </button>
            <div className="sfx-divider-v" />
            {outputButtons}
          </div>
        </div>
      </header>
    ) : (
      <header className="sfx-editor-header">
        <div className="sfx-editor-toolbar">
          <div className="sfx-editor-toolbar-group">
            <button
              type="button"
              onClick={() => goToPage("edit")}
              className="ds-btn ds-btn-secondary"
              aria-label="Back to edit"
              title="Back to the edit page; your settings here are kept (Esc)"
            >
              <ArrowLeft size={14} />
              Back to edit
              <kbd className="sfx-kbd">Esc</kbd>
            </button>
            <div className="sfx-divider-v" />
            <div className="sfx-editor-file-meta">
              <span className="sfx-editor-filename">{pageTitle}</span>
              <span className="sfx-editor-filespecs ds-tnum">
                {`From ${sourceName}${editIncluded.length > 0 ? ", as edited" : ""} · ${totalDurationS.toFixed(
                  2
                )} s`}
              </span>
            </div>
            {dragChip}
          </div>
          <div className="sfx-editor-toolbar-group">
            {onLoopPage && (
              <>
                <button
                  type="button"
                  disabled={!processedChannels}
                  onClick={() =>
                    replaceSourceWith(`${baseName}.loop`, bakeLoopNow(), sampleRate)
                  }
                  className="ds-btn ds-btn-ghost"
                  title="The loop becomes the file you edit. Your current edits, loop settings and takes are cleared. You can undo for a few seconds."
                >
                  <Replace size={14} />
                  Replace source with loop
                </button>
                <div className="sfx-divider-v" />
              </>
            )}
            {outputButtons}
          </div>
        </div>
      </header>
    );

  const stage = (
    <>
      {/* Main Waveform Stage */}
      <div className="sfx-editor-stage">
        {/* Header strip: marker readouts + zoom, off the canvas */}
        <div className="sfx-editor-stage-bar">
          {showCrop ? (
            <div className="sfx-editor-stage-hud-left">
              <span className="sfx-hud-pill start">
                <span className="dot" />
                IN <b>{(cropStartSamples / sampleRate).toFixed(3)}s</b>
              </span>
              <span className="sfx-hud-pill end">
                <span className="dot" />
                OUT <b>{(cropEndSamples / sampleRate).toFixed(3)}s</b>
              </span>
              {cropEndSamples - cropStartSamples < rawTotalSamples && (
                <span className="sfx-hud-pill">
                  Length <b>{totalDurationS.toFixed(3)}s</b> of{" "}
                  <b>{(rawTotalSamples / sampleRate).toFixed(3)}s</b>
                </span>
              )}
            </div>
          ) : (
            onLoopPage && (
              <div className="sfx-editor-stage-hud-left">
                <span className="sfx-hud-pill start">
                  <span className="dot" />S <b>{(loopStart / sampleRate).toFixed(3)}s</b>
                </span>
                <span className="sfx-hud-pill end">
                  <span className="dot" />E <b>{(loopEnd / sampleRate).toFixed(3)}s</b>
                </span>
                <span className="sfx-hud-pill">
                  Length <b>{loopDurationS.toFixed(3)}s</b>
                </span>
                {fadeMs > 0 && (
                  <span className="sfx-hud-pill fade">
                    Crossfade <b>{Math.round(fadeMs)} ms</b> · {resolvedModeLabel}
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
            {onLoopPage && (
              <>
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
              </>
            )}
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
        </div>
        <div className="sfx-editor-stage-view">
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
            channels={showCrop ? uncroppedChannels : processedChannels}
            sampleRate={sampleRate}
            loop={loopMarkers}
            activeMarker={activeMarker}
            onLoopChange={(s, e) => {
              if (showCrop) {
                updateCropPoints(s, e);
              } else {
                updateLoopPoints(s, e, snapZero);
              }
            }}
            onSeek={seekToSample}
            onSelectMarker={setActiveMarker}
          />

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
      </div>

      {/* Studio Transport Deck */}
      <div className="sfx-editor-transport-bar">
        <div className="sfx-editor-transport-left">
          {onLoopPage && (
            <>
              <button
                type="button"
                disabled={!processedChannels}
                onClick={auditionSeam}
                className="ds-btn ds-btn-ghost ds-btn-sm"
                title="Jump 1.2s before the loop end to immediately audition the E → S seam transition (S)"
              >
                Test Seam
              </button>
              <span className="sfx-rack-hint">Preview</span>
              <div
                className="sfx-pill-group"
                role="group"
                aria-label="Audition source"
              >
                <button
                  type="button"
                  onClick={() => setAuditionMode("loop")}
                  className={`sfx-choice-pill ${
                    auditionMode === "loop" ? "active" : ""
                  }`}
                >
                  Loop
                </button>
                <button
                  type="button"
                  onClick={() => setAuditionMode("file")}
                  className={`sfx-choice-pill ${
                    auditionMode === "file" ? "active" : ""
                  }`}
                  title="Preview the whole edited sound instead of just the loop region"
                >
                  File
                </button>
              </div>
            </>
          )}
        </div>

        {/* Center Hero Transport Pill */}
        <div className="sfx-tp-pill">
          <button
            type="button"
            disabled={!processedChannels}
            onClick={restartLoop}
            className="sfx-tp-icon-btn"
            title="Restart from beginning / loop start (Home)"
            aria-label="Restart playback"
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
        </div>

        <div className="sfx-editor-transport-right">
          <div
            className="sfx-meter-slot"
            aria-hidden={!(isPlaying || playingVarIdx !== null)}
          >
            {(isPlaying || playingVarIdx !== null) && (
              <SpectrumMeter
                analyserNode={transportRef.current?.analyser ?? null}
                isPlaying
              />
            )}
          </div>
          <div className="sfx-signal-meters ds-tnum">
            <span title="Peak amplitude of the output">
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
            <span className="rms" title="RMS level of the output">
              RMS{" "}
              <strong>
                {signalStats.rmsDbfs > -119
                  ? `${signalStats.rmsDbfs.toFixed(1)} dB`
                  : "—"}
              </strong>
            </span>
            {onLoopPage && (
              <span title="Computed loop seam continuity score">
                Seam{" "}
                <strong
                  style={{
                    color:
                      seamMetrics.seamScore >= 0.7
                        ? "var(--success-500)"
                        : seamMetrics.seamScore >= 0.4
                        ? "var(--warning-500)"
                        : "var(--danger-400)",
                  }}
                >
                  {Math.round(seamMetrics.seamScore * 100)}%
                </strong>
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const keyHints =
    page === "edit"
      ? [
          { keys: "Space", label: "Preview" },
          ...(showCrop
            ? [
                { keys: "[ ]", label: "Pick handle" },
                { keys: "← →", label: "Nudge (Shift: 10 ms)" },
              ]
            : []),
          { keys: "1 2", label: "Edit modules" },
          { keys: "3 4", label: "Loop / Variations" },
          { keys: "Ctrl+S", label: "Save" },
          { keys: "Alt+1", label: "Library" },
          { keys: "Scroll", label: "Zoom" },
        ]
      : page === "loop"
      ? [
          { keys: "Space", label: "Preview" },
          { keys: "F", label: "Find loops" },
          { keys: "S", label: "Test seam" },
          { keys: "[ ]", label: "Pick marker" },
          { keys: "← →", label: "Nudge (Shift: 10 ms)" },
          { keys: "Esc", label: "Back to edit" },
          { keys: "Ctrl+S", label: "Save" },
          { keys: "Scroll", label: "Zoom" },
        ]
      : [
          { keys: "Space", label: "Preview" },
          { keys: "G", label: "Generate" },
          { keys: "Esc", label: "Back to edit" },
          { keys: "Ctrl+S", label: "Save" },
        ];

  return (
    <div
      className="sfx-editor-shell"
      data-page={page}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = e.dataTransfer?.files?.[0];
        if (f) {
          onOpenFile(f);
        }
      }}
    >
      {header}

      {page !== "variations" && stage}

      {page === "edit" && (
        <div className="sfx-editor-module-row">
          <div className="sfx-editor-module-tabs" role="tablist" aria-label="Edit modules">
            <button
              type="button"
              role="tab"
              aria-selected={editModule === "shaper"}
              aria-label="Trim & Gain"
              title="Trim & Gain (1)"
              onClick={() => setEditModule("shaper")}
              className={`sfx-module-tab ${editModule === "shaper" ? "active" : ""}`}
            >
              <kbd className="sfx-kbd">1</kbd>
              <Sliders size={14} />
              <span>Trim &amp; Gain</span>
              {shaperActive && <span className="sfx-module-dot on" />}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={editModule === "eq"}
              aria-label="Tone & EQ"
              title="Tone & EQ (2)"
              onClick={() => setEditModule("eq")}
              className={`sfx-module-tab ${editModule === "eq" ? "active" : ""}`}
            >
              <kbd className="sfx-kbd">2</kbd>
              <Activity size={14} />
              <span>Tone &amp; EQ</span>
              {eqActive && <span className="sfx-module-dot on" />}
            </button>
          </div>
          <button
            type="button"
            disabled={editModule === "shaper" ? !shaperActive : !eqActive}
            onClick={() =>
              editModule === "shaper"
                ? setShaper(DEFAULT_SHAPER_SPEC)
                : setEq(DEFAULT_EQ_SPEC)
            }
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            <RotateCcw size={12} />
            {editModule === "shaper" ? "Reset Trim & Gain" : "Reset Tone & EQ"}
          </button>
        </div>
      )}

      <div className={`sfx-editor-rack ${page === "variations" ? "sfx-variations-page" : ""}`}>
        {page === "edit" && editModule === "shaper" && (
          <TrimGainPanels
            shaper={shaper}
            setShaper={setShaper}
            rawTotalSamples={rawTotalSamples}
            sampleRate={sampleRate}
            totalDurationS={totalDurationS}
            canAutoTrim={Boolean(sourceChannels)}
            onAutoTrim={handleAutoTrimSilence}
          />
        )}

        {page === "edit" && editModule === "eq" && (
          <ToneEqPanels eq={eq} setEq={setEq} sampleRate={sampleRate} />
        )}

        {onLoopPage && (
          <LoopPanels
            sampleRate={sampleRate}
            totalDurationS={totalDurationS}
            loopDurationS={loopDurationS}
            fadeMs={fadeMs}
            setFadeMs={setFadeMs}
            fadeCurve={fadeCurve}
            setFadeCurve={setFadeCurve}
            bakeMode={bakeMode}
            setBakeMode={setBakeMode}
            snapZero={snapZero}
            onToggleSnap={() => {
              const next = !snapZero;
              setSnapZero(next);
              if (next) {
                updateLoopPoints(loopStart, loopEnd, true);
              }
            }}
            onResetLoop={resetLoop}
            candidates={candidates}
            candIndex={candIndex}
            onApplyCandidate={(idx) => applyCandidate(idx)}
            onClearCandidates={() => {
              setCandidates([]);
              setCandIndex(-1);
              setStatusMsg("Cleared loop suggestions");
            }}
            searching={searching}
            canSearch={Boolean(processedChannels)}
            onFindLoops={runLoopSearch}
            searchModePref={searchModePref}
            setSearchModePref={setSearchModePref}
            minLoopSec={minLoopSec}
            setMinLoopSec={setMinLoopSec}
            searchWindowMs={searchWindowMs}
            setSearchWindowMs={setSearchWindowMs}
            bakedChannels={bakedChannels}
            fadeSamples={fadeSamples}
          />
        )}

        {page === "variations" && (
          <>
            <div className="sfx-var-top">
              <section className="sfx-rack-card sfx-var-source">
                <div className="sfx-rack-card-head">
                  <span className="ds-panel-title">
                    Source{editIncluded.length > 0 ? " · edited" : ""}
                  </span>
                  <span className="sfx-rack-hint ds-tnum">{totalDurationS.toFixed(2)} s</span>
                </div>
                <div className="sfx-var-source-wave">
                  <EditorWaveform
                    ref={waveRef}
                    channels={processedChannels}
                    sampleRate={sampleRate}
                    loop={null}
                    activeMarker={activeMarker}
                    onLoopChange={() => {}}
                    onSeek={seekToSample}
                  />
                </div>
                <div className="sfx-var-source-transport">
                  <button
                    type="button"
                    disabled={!processedChannels}
                    onClick={togglePlay}
                    className={`sfx-tp-play-btn ${isPlaying ? "playing" : ""}`}
                    title="Play / Pause the source (Space)"
                    aria-label="Play or pause preview"
                  >
                    {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                  </button>
                  <div className="sfx-tp-time ds-tnum">
                    <span>{timePosText}</span>
                    <span className="sep"> / </span>
                    <span className="tot">{formatDuration(totalSamples, sampleRate)}</span>
                  </div>
                </div>
              </section>
              <VariationControls
                varSpec={varSpec}
                setVarSpec={setVarSpec}
                onReset={() =>
                  setVarSpec((s) => ({ ...DEFAULT_VARIATION_SPEC, count: s.count }))
                }
              />
            </div>
            <TakesPanel
              variations={variations}
              activeVarIdx={activeVarIdx}
              playingVarIdx={playingVarIdx}
              varPlayRatio={varPlayRatio}
              takeCount={varSpec.count}
              setTakeCount={(n) => setVarSpec((s) => ({ ...s, count: n }))}
              canGenerate={Boolean(processedChannels)}
              stale={variations.length > 0 && takesBasis !== processedChannels}
              onGenerate={handleGenerateVariations}
              onAudition={auditionVariation}
              onStop={stopVariationPlayback}
              onReroll={handleRerollSingleVariation}
              onToggleSelected={toggleTakeSelected}
              onReplaceSource={(v) => replaceSourceWith(v.name, v.channels, v.sampleRate)}
              onDragStart={handleTakeDragStart}
              gridRef={takesGridRef}
            />
          </>
        )}
      </div>

      {saveDlg && (
        <OutputDialog
          mode={saveDlg}
          takeStems={page === "variations" ? selectedTakes.map((v) => v.name) : null}
          fileName={saveName}
          setFileName={setSaveName}
          included={dialogIncluded}
          outputSpec={outputSpec}
          setOutputSpec={setOutputSpec}
          folder={saveFolder}
          setFolder={setSaveFolder}
          folders={libraryFolders}
          roots={libraryRoots}
          overwrite={saveOverwrite}
          setOverwrite={setSaveOverwrite}
          busy={outputBusy}
          showSpinner={showBusySpinner}
          errMsg={errMsg}
          onConfirm={() => void confirmSave()}
          onClose={() => setSaveDlg(null)}
          dialogRef={saveDlgRef}
          confirmRef={saveConfirmRef}
        />
      )}

      {/* Studio Footer Status Bar */}
      <footer className="sfx-statusbar">
        {errMsg ? (
          <span className="ds-tnum sfx-status-err">
            {errMsg}
            <button
              type="button"
              className="sfx-similar-exit"
              aria-label="Dismiss error"
              onClick={() => setErrMsg(null)}
            >
              <X size={11} />
              dismiss
            </button>
          </span>
        ) : (
          <span className="ds-tnum">{statusMsg}</span>
        )}
        <KeyHints hints={keyHints} />
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a,.aiff"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            onOpenFile(f);
          }
        }}
      />
    </div>
  );
};
