// fs.watch-driven re-indexing for local document sources.
//
// Boots one watcher per enabled `local_folder` source. Filesystem events
// are filtered (skip dot-dirs / build output / disallowed extensions)
// and debounced per-(source_id, abs) for 500 ms. Each surviving event
// becomes a ScriptFiring that the runner dispatches to
// `documents.reindex_local_file`.
//
// On Linux, fs.watch with `recursive: true` is unsupported — we log
// once per source and rely on the 10-min full sweep there. On macOS
// and Windows this gives sub-second propagation from save-to-search.

import { promises as fs, type FSWatcher, watch as fsWatch } from "node:fs";
import { join, sep } from "node:path";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { listEnabledDocumentSources } from "@/lib/stores/document-sources";
import { ALLOWED_EXT, SKIP_DIRS, lowerExt } from "@/lib/documents/indexer";
// Side-effect import: ensures `documents.reindex_local_file` is in the
// script registry before the first firing dispatches.
import "@/lib/documents/reindex-local-file";
import type {
  ScriptFiring,
  TriggerFiring,
  TriggerHandler,
} from "../types";

export const FS_WATCH_KIND = "fs_watch";

const DEBOUNCE_MS = 500;

interface WatcherState {
  sourceId: string;
  rootPath: string;
  watcher: FSWatcher | null;
  /** Map<abs, debounce-timer-id> while a debounce is in flight. */
  debounceTimers: Map<string, NodeJS.Timeout>;
}

interface FsWatchState {
  watchers: Map<string, WatcherState>;       // sourceId → state
  /** Coalesced pending firings, keyed by `${source_id}:${abs}`. */
  pending: Map<string, { source_id: string; abs: string }>;
  unsupportedLogged: Set<string>;
}

// Stored on globalThis: Next's standalone build bundles this module into
// multiple chunks (one per route that transitively imports it), and each
// chunk would otherwise have its own copy of `state`. Without the global
// pin, the chunk that runs `attachWatcher` enqueues into a different Map
// than the chunk the scheduler tick reads via `drainPending`.
const state = getOrCreateGlobal<FsWatchState>("__jarela_fs_watch_state", () => ({
  watchers: new Map(),
  pending: new Map(),
  unsupportedLogged: new Set(),
}));

function pendingKey(sourceId: string, abs: string): string {
  return `${sourceId}:${abs}`;
}

function enqueuePending(sourceId: string, abs: string): void {
  state.pending.set(pendingKey(sourceId, abs), { source_id: sourceId, abs });
}

function scheduleDebounce(w: WatcherState, abs: string): void {
  const existing = w.debounceTimers.get(abs);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    w.debounceTimers.delete(abs);
    enqueuePending(w.sourceId, abs);
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive just for the debounce.
  if (typeof t.unref === "function") t.unref();
  w.debounceTimers.set(abs, t);
}

function handleEvent(w: WatcherState, filename: string | null): void {
  if (!filename) return;
  // Filter dot-dirs and SKIP_DIRS inline. We can't trust the
  // recursive watcher to honour them.
  const segments = filename.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (SKIP_DIRS.has(seg)) return;
    if (seg.startsWith(".")) return;
  }
  const file = segments[segments.length - 1];
  if (!ALLOWED_EXT.has(lowerExt(file))) return;
  const abs = join(w.rootPath, ...segments);
  scheduleDebounce(w, abs);
}

async function attachWatcher(sourceId: string, rootPath: string): Promise<void> {
  if (state.watchers.has(sourceId)) return;
  // Confirm the directory still exists; fs.watch on a nonexistent path
  // throws synchronously and tears down the boot loop.
  try {
    const st = await fs.stat(rootPath);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }

  const w: WatcherState = {
    sourceId,
    rootPath,
    watcher: null,
    debounceTimers: new Map(),
  };
  try {
    w.watcher = fsWatch(
      rootPath,
      { recursive: true, persistent: false },
      (_event, filename) => {
        const name: string | null =
          typeof filename === "string"
            ? filename
            : filename
              ? (filename as Buffer).toString()
              : null;
        handleEvent(w, name);
      },
    );
    w.watcher.on("error", (err) => {
      console.warn(`[triggers/fs_watch] watcher error for ${rootPath}:`, err.message);
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
      // Linux: recursive fs.watch isn't supported. Falling back to the
      // 10-min full sweep is fine — log once per source.
      if (!state.unsupportedLogged.has(sourceId)) {
        console.warn(
          `[triggers/fs_watch] recursive fs.watch unsupported on this platform; ` +
            `relying on the full sweep for source "${rootPath}"`,
        );
        state.unsupportedLogged.add(sourceId);
      }
      return;
    }
    console.warn(`[triggers/fs_watch] failed to attach watcher to ${rootPath}:`, e.message);
    return;
  }
  state.watchers.set(sourceId, w);
}

function detachWatcher(sourceId: string): void {
  const w = state.watchers.get(sourceId);
  if (!w) return;
  for (const t of w.debounceTimers.values()) clearTimeout(t);
  w.debounceTimers.clear();
  if (w.watcher) {
    try { w.watcher.close(); } catch { /* noop */ }
  }
  state.watchers.delete(sourceId);
}

async function syncWatchers(): Promise<void> {
  const sources = listEnabledDocumentSources().filter((s) => s.kind === "local_folder");
  const wantSourceIds = new Set(sources.map((s) => s.id));

  // Drop watchers whose source disappeared / disabled.
  for (const sourceId of Array.from(state.watchers.keys())) {
    if (!wantSourceIds.has(sourceId)) {
      detachWatcher(sourceId);
    }
  }

  // Attach new watchers.
  for (const s of sources) {
    if (state.watchers.has(s.id)) continue;
    await attachWatcher(s.id, s.path);
  }
}

function drainPending(): ScriptFiring[] {
  if (state.pending.size === 0) return [];
  const now = Date.now();
  const firings: ScriptFiring[] = [];
  for (const { source_id, abs } of state.pending.values()) {
    firings.push({
      id: `${source_id}:${abs}:${now}`,
      kind: FS_WATCH_KIND,
      mode: "script",
      script: "documents.reindex_local_file",
      args: { source_id, abs },
    });
  }
  state.pending.clear();
  return firings;
}

export const fsWatchHandler: TriggerHandler = {
  kind: FS_WATCH_KIND,

  async start(): Promise<void> {
    await syncWatchers();
  },

  async sync(): Promise<void> {
    await syncWatchers();
  },

  async stop(): Promise<void> {
    for (const sourceId of Array.from(state.watchers.keys())) {
      detachWatcher(sourceId);
    }
    state.pending.clear();
  },

  getDueFirings(_asOf: Date): TriggerFiring[] {
    return drainPending();
  },

  markFired(): void {
    // The script writes its own state into `documents`. Nothing extra
    // to bookkeep here — keeping this empty also means re-firing after
    // an error is the next watcher event, which is the right thing.
  },
};

/** Test-only helper. */
export function __resetFsWatchState(): void {
  for (const sourceId of Array.from(state.watchers.keys())) {
    detachWatcher(sourceId);
  }
  state.pending.clear();
  state.unsupportedLogged.clear();
}

/** Test-only helper. Pumps a synthetic event without touching the real fs. */
export function __pushEventForTest(sourceId: string, rootPath: string, filename: string): void {
  let w = state.watchers.get(sourceId);
  if (!w) {
    w = { sourceId, rootPath, watcher: null, debounceTimers: new Map() };
    state.watchers.set(sourceId, w);
  }
  handleEvent(w, filename);
}
