import {
  findLoopPairs,
  findLoopPoints,
  type LoopCandidate,
  type SearchOptions,
} from "../audio/search";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
declare const self: WorkerScope;

export interface SearchRequest {
  pcm: Float32Array;
  sampleRate: number;
  options: SearchOptions;
  /** True: search start and end freely (loop-pair mode). False: fixed end. */
  pairMode: boolean;
}

export type SearchMessage =
  | { type: "progress"; value: number }
  | { type: "result"; candidates: LoopCandidate[] };

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const { pcm, sampleRate, options, pairMode } = e.data;
  const search = pairMode ? findLoopPairs : findLoopPoints;
  const candidates = search(pcm, sampleRate, options, (value) => {
    self.postMessage({ type: "progress", value });
  });
  self.postMessage({ type: "result", candidates });
};
