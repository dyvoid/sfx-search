import { SearchHit } from "../types";

/** A rendered loop or take that replaced the Studio's file ("Replace source"). */
export interface DerivedSource {
  kind: "derived";
  /** Filename stem, e.g. "snd0.loop" or "snd0_var_03". */
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  /** The library file the work started from: preselects its folder and lends its user data. */
  origin: SearchHit | null;
}

/** What a Studio session edits. Fixed for the session's lifetime. */
export type StudioSource =
  | { kind: "library"; hit: SearchHit }
  | { kind: "file"; file: File }
  | DerivedSource;

/** What a Studio session reports up for the tab label and replace/close guards. */
export interface StudioStatus {
  /** Display filename, e.g. "snd0.wav". */
  name: string;
  /** Holds work that replacing or closing would lose (edits, loop, takes, or an unsaved derived file). */
  dirty: boolean;
}

export function sourceFilename(source: StudioSource): string {
  switch (source.kind) {
    case "library":
      return source.hit.filename;
    case "file":
      return source.file.name;
    case "derived":
      return `${source.name}.wav`;
  }
}

/** The library file the session's audio comes from, directly or through Replace source. */
export function originHit(source: StudioSource): SearchHit | null {
  if (source.kind === "library") {
    return source.hit;
  }
  return source.kind === "derived" ? source.origin : null;
}
