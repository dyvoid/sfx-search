// Shared e2e fixtures: a fully mocked /api/* backend plus helpers.
//
// Usage in a spec:
//   import { test, expect } from "./fixtures";
//   test("...", async ({ app, api }) => { ... });
//
// `api` is configured before navigation; use `test.use({ apiOptions: {...} })`
// or mutate `api` and reload for per-test behavior. `api.calls` records every
// request as "METHOD /path?query" for asserting side effects.
import { test as base, expect, type Locator, type Page, type Route } from "@playwright/test";
import type {
  FileDetail,
  IndexingProgress,
  LibraryStats,
  SearchHit,
} from "../src/types";

/** 16-bit mono PCM sine WAV, decodeable by the browser and the Studio. */
export function makeWav(seconds = 2, sampleRate = 44100, freqHz = 440): Buffer {
  const n = Math.round(seconds * sampleRate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.round(8000 * Math.sin((i * 2 * Math.PI * freqHz) / sampleRate));
    b.writeInt16LE(s, 44 + i * 2);
  }
  return b;
}

export function makeHit(i: number, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    file_id: `f${i}`,
    path: `/lib/a/snd${i}.wav`,
    root: "/lib",
    filename: `snd${i}.wav`,
    folder: "/lib/a",
    format: "wav",
    duration_s: 2,
    sample_rate: 44100,
    channels: 1,
    lufs_integrated: -20,
    peak_dbfs: -3,
    loop_score: 0.5,
    tags: {},
    search_text: "",
    best_offset_s: 0.5,
    best_end_s: 1.5,
    best_chunk_idx: 0,
    clap_score: 0.4,
    bm25_score: null,
    rrf_score: 0.01,
    favorite: false,
    user_tags: [],
    note: "",
    ...overrides,
  };
}

const IDLE: IndexingProgress = {
  state: "idle",
  error: null,
  scanned_count: 0,
  skipped_unchanged: 0,
  to_index_count: 0,
  indexed_ok: 0,
  indexed_errors: 0,
  marked_missing: 0,
  total_chunks: 0,
  elapsed_seconds: 0,
  files_per_min: 0,
  audio_hours_per_hour: 0,
  gpu_memory_mb: 0,
  eta_seconds: 0,
};

export interface ApiOptions {
  /** Number of files the mocked library reports and pages through. */
  total: number;
  /** Simulate a running scan (e.g. to check controls disabled while indexing). */
  indexing: boolean;
  /** Files already scanned while `indexing` is true (progress = scanDone / 10). */
  scanDone: number;
  /** Report a failed scan with this message (state "error"); wins over `indexing`. */
  indexingError: string | null;
  /** Make /api/files/{id}/reveal fail with 500. */
  failReveal: boolean;
  /** Never answer /api/audio/* (keeps the Studio in its decoding state). */
  hangAudio: boolean;
  /** Status returned by save-edited; non-2xx returns {detail: saveErrorDetail}. */
  saveStatus: number;
  saveErrorDetail: string;
  /** Delay (ms) before save-edited answers, to keep a save "in flight". */
  saveDelayMs: number;
  /** Length of the decodeable WAV served by /api/audio/*. */
  audioSeconds: number;
  /** Configured library folders ([] = first run, nothing set up). */
  roots: string[];
  /** Configured folders reported as not found on disk. */
  missingRoots: string[];
}

export const DEFAULT_API_OPTIONS: ApiOptions = {
  total: 120,
  indexing: false,
  scanDone: 0,
  indexingError: null,
  failReveal: false,
  hangAudio: false,
  saveStatus: 200,
  saveErrorDetail: "Save failed",
  saveDelayMs: 0,
  audioSeconds: 10,
  roots: ["/lib"],
  missingRoots: [],
};

export class MockApi {
  readonly calls: string[] = [];
  readonly favorites = new Set<string>();
  readonly wav: Buffer;
  opts: ApiOptions;

  constructor(opts: Partial<ApiOptions> = {}) {
    this.opts = { ...DEFAULT_API_OPTIONS, ...opts };
    this.wav = makeWav(this.opts.audioSeconds);
  }

  /** Requests whose "METHOD /path" starts with the given prefix. */
  callsTo(prefix: string): string[] {
    return this.calls.filter((c) => c.startsWith(prefix));
  }

  private stats(): LibraryStats {
    const total = this.opts.total;
    return {
      total_files: total,
      ok_files: total,
      error_files: 0,
      missing_files: 0,
      total_chunks: total,
      total_duration_s: total * 2,
      total_duration_hours: (total * 2) / 3600,
      total_size_bytes: total * 200_000,
      embedding_model: "laion/larger_clap_general",
      embedding_dim: 512,
      roots: this.opts.roots,
      formats: { wav: total },
      favorites_count: this.favorites.size,
    };
  }

  private indexing(): IndexingProgress {
    if (this.opts.indexingError !== null) {
      return { ...IDLE, state: "error", error: this.opts.indexingError };
    }
    return this.opts.indexing
      ? { ...IDLE, state: "running", to_index_count: 10, indexed_ok: this.opts.scanDone }
      : IDLE;
  }

  private hit(i: number): SearchHit {
    const h = makeHit(i);
    h.favorite = this.favorites.has(h.file_id);
    return h;
  }

  async install(page: Page): Promise<void> {
    await page.route("**/api/**", (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    this.calls.push(`${m} ${p}${url.search}`);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const library = () => ({
      roots: this.opts.roots,
      missing_roots: this.opts.missingRoots,
      stats: this.stats(),
      indexing: this.indexing(),
    });

    if (p === "/api/search") {
      const body = JSON.parse(req.postData() ?? "{}") as {
        offset?: number;
        k?: number;
        favorites_only?: boolean;
      };
      const offset = body.offset ?? 0;
      const k = body.k ?? 50;
      let ids = Array.from({ length: this.opts.total }, (_, i) => i);
      if (body.favorites_only) {
        ids = ids.filter((i) => this.favorites.has(`f${i}`));
      }
      const page = ids.slice(offset, offset + k).map((i) => this.hit(i));
      return json({ results: page, count: page.length, total: ids.length, offset });
    }
    if (p.startsWith("/api/similar/")) {
      const results = Array.from({ length: 10 }, (_, i) => this.hit(i + 1));
      return json({ results });
    }
    if (p === "/api/library" && m === "GET") return json(library());
    if (p === "/api/library/pick-folder") return json({ path: "D:/Picked" });
    if (p === "/api/library/roots") return json(library());
    if (p === "/api/library/rescan") return json(library());
    if (p === "/api/stats") return json(this.stats());
    if (p === "/api/folders") {
      return json({ folders: [{ path: "/lib/a", count: this.opts.total }] });
    }
    if (p === "/api/filters") {
      return json({
        formats: ["wav"],
        roots: ["/lib"],
        sample_rates: [44100],
        channels: [1],
        min_duration_s: 0,
        max_duration_s: 10,
        min_lufs: -30,
        max_lufs: -5,
        user_tags: [],
      });
    }
    if (p.startsWith("/api/peaks/")) {
      return json({ peaks: Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 5))) });
    }
    if (p.startsWith("/api/audio/")) {
      if (this.opts.hangAudio) return; // leave the request pending
      const range = req.headers()["range"];
      const w = this.wav;
      const mm = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      if (mm) {
        const start = Number(mm[1]);
        const end = mm[2] ? Number(mm[2]) : w.length - 1;
        return route.fulfill({
          status: 206,
          headers: {
            "Content-Type": "audio/wav",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${w.length}`,
          },
          body: w.subarray(start, end + 1),
        });
      }
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "audio/wav", "Accept-Ranges": "bytes" },
        body: w,
      });
    }
    const userMatch = /^\/api\/files\/([^/]+)\/user$/.exec(p);
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]);
      const body = JSON.parse(req.postData() ?? "{}") as { favorite?: boolean };
      if (body.favorite) this.favorites.add(id);
      else this.favorites.delete(id);
      return json({ file_id: id, favorite: !!body.favorite, user_tags: [], note: "" });
    }
    if (p.endsWith("/reveal")) {
      return this.opts.failReveal
        ? json({ detail: "Could not reveal file" }, 500)
        : json({ ok: true });
    }
    if (p.endsWith("/save-edited")) {
      if (this.opts.saveDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.opts.saveDelayMs));
      }
      if (this.opts.saveStatus >= 300) {
        return json({ detail: this.opts.saveErrorDetail }, this.opts.saveStatus);
      }
      const name = url.searchParams.get("name") ?? "saved";
      const ext = url.searchParams.get("format") ?? "wav";
      return json({ hit: makeHit(999, { file_id: "f999", filename: `${name}.${ext}` }) });
    }
    if (p === "/api/transcode") {
      return route.fulfill({ status: 200, headers: { "Content-Type": "audio/flac" }, body: "fLaC" });
    }
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(p);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      const detail: FileDetail = {
        ...this.hit(Number(id.slice(1)) || 0),
        size_bytes: 200_000,
        mtime_ns: 1,
        embedding_model: "laion/larger_clap_general",
        status: "ok",
        error: null,
        chunks: [{ chunk_idx: 0, start_s: 0, end_s: 2 }],
      };
      return json(detail);
    }
    return json({});
  }
}

interface Fixtures {
  apiOptions: Partial<ApiOptions>;
  api: MockApi;
  /** The library page, loaded with results rendered. */
  app: Page;
  /** Uncaught page errors collected during the test; asserted empty on teardown. */
  pageErrors: string[];
}

export const test = base.extend<Fixtures>({
  apiOptions: [{}, { option: true }],
  pageErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
    expect(errors, "uncaught page errors").toEqual([]);
  },
  api: async ({ page, apiOptions }, use) => {
    const api = new MockApi(apiOptions);
    await api.install(page);
    await use(api);
  },
  app: async ({ page, api, pageErrors }, use) => {
    void api;
    void pageErrors;
    await page.goto("/");
    await page.locator(".sfx-row").first().waitFor();
    await use(page);
  },
});

export { expect };

/** Row locator by index in the results list. */
export const row = (page: Page, idx: number) => page.locator(".sfx-row").nth(idx);

/** Index of the currently selected row, or -1. */
export async function selectedIndex(page: Page): Promise<number> {
  return page.locator(".sfx-row").evaluateAll((rows) =>
    rows.findIndex((r) => r.classList.contains("selected"))
  );
}

/** Index of the row currently playing, or -1. */
export async function playingIndex(page: Page): Promise<number> {
  return page.locator(".sfx-row").evaluateAll((rows) =>
    rows.findIndex((r) => r.classList.contains("is-playing"))
  );
}

export const studioShell = (page: Page) => page.locator(".sfx-editor-shell");

/**
 * Open the Studio for the selected row (E) and wait until the audio has
 * decoded (Download enables once processed channels exist). Pass
 * `waitDecoded: false` when the audio fetch is deliberately hung.
 */
export async function openStudio(
  page: Page,
  { waitDecoded = true }: { waitDecoded?: boolean } = {}
): Promise<void> {
  await page.keyboard.press("e");
  await studioShell(page).waitFor();
  if (waitDecoded) {
    await expect(downloadButton(page)).toBeEnabled();
  }
}

/**
 * Fire a synthetic keydown at the active element and report whether any
 * handler called preventDefault (Playwright can't observe that directly).
 */
export interface KeyInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export async function keydownPrevented(page: Page, init: KeyInit): Promise<boolean> {
  return page.evaluate((i) => {
    const target = document.activeElement ?? document.body;
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, init);
}

// ---------------------------------------------------------------------------
// Keyboard-contract helpers (see docs/testing/keyboard-contract.md)
// ---------------------------------------------------------------------------

/** The footer status bar (library and Studio both render one). */
export const statusbar = (page: Page) => page.locator(".sfx-statusbar");

/** The inspector drawer of the library view. */
export const inspector = (page: Page) => page.locator(".sfx-inspector");

/** The Studio's hero play/pause button; `.playing` while audio runs. */
export const studioPlayButton = (page: Page) => page.locator(".sfx-tp-play-btn");

/** The Studio toolbar's Download button (opens the Download dialog). */
export const downloadButton = (page: Page) => page.getByRole("button", { name: "Download", exact: true });

/** The Studio's "Download" dialog (name and format). */
export const downloadDialog = (page: Page) => page.getByRole("dialog", { name: "Download", exact: true });

/** The Studio's "Save to library" dialog. */
export const saveDialog = (page: Page) => page.getByRole("dialog", { name: "Save to library" });

/** The Library folders modal. */
export const foldersModal = (page: Page) => page.getByRole("dialog", { name: "Library folders" });

/** Save requests recorded so far (all `save-edited` posts). */
export function saveCalls(api: MockApi): string[] {
  return api.calls.filter((c) => c.startsWith("POST /api/files/") && c.includes("/save-edited"));
}

/**
 * Round-trip one request through the mock so every earlier request has been
 * recorded; makes "nothing was sent" assertions deterministic without sleeping.
 */
export async function flushApi(page: Page): Promise<void> {
  await page.evaluate(() => fetch("/api/stats").then((r) => r.json()));
}

/**
 * Press Tab (or Shift+Tab) until `target` has focus, using real keyboard
 * navigation. Throws if it is not reached within `max` presses.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  { shift = false, max = 80 }: { shift?: boolean; max?: number } = {}
): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) throw new Error("tabTo: target not found");
  for (let i = 0; i < max; i++) {
    const hit = await handle.evaluate((el) => el === document.activeElement);
    if (hit) return;
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  }
  if (!(await handle.evaluate((el) => el === document.activeElement))) {
    throw new Error(`tabTo: did not reach target in ${max} Tab presses`);
  }
}

/**
 * Hold a key down for `repeats` keydowns (the 2nd and later have
 * `repeat: true`, like OS auto-repeat), then release it.
 */
export async function holdKey(page: Page, key: string, repeats: number): Promise<void> {
  for (let i = 0; i < repeats; i++) await page.keyboard.down(key);
  await page.keyboard.up(key);
}

/** Accessible name of the focused element ("" if none), for focus-order asserts. */
export async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "";
    return (
      el.getAttribute("aria-label") ||
      (el instanceof HTMLInputElement && el.id) ||
      (el.textContent ?? "").trim() ||
      el.tagName.toLowerCase()
    );
  });
}
