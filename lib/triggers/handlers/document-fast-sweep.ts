// Fast (60 s) re-sweep loop for remote document sources.
//
// Local folders use fs.watch for low-latency reindexing; remote
// sources (Confluence / Jira) have no inotify equivalent, so we poll
// — but at a much higher cadence than the 10-min full sweep. Each
// source's existing cursor (last_cursor on document_sources) means
// the upstream API call only fetches what changed since last poll,
// keeping rate-limit pressure low.

import {
  listEnabledDocumentSources,
  markSourceScanned,
} from "@/lib/stores/document-sources";
import { isRemoteKind, runRemoteSource } from "@/lib/documents/remote";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { getConfig } from "@/lib/env/config";
import { registerScript } from "../scripts";
import type {
  ScriptFiring,
  TriggerFiring,
  TriggerHandler,
} from "../types";
import { errorMessage } from "@/lib/utils/error";

export const DOCUMENT_FAST_SWEEP_KIND = "doc_fast_sweep";

function intervalMs(): number {
  return getConfig().fastRemoteSweepMs;
}

interface SweepState {
  /** sourceId → last fired (ms epoch). */
  lastRunAt: Map<string, number>;
}

// Pinned to globalThis: Next's standalone build bundles handler files
// into multiple chunks, and module-local state would otherwise be split
// across them. See lib/triggers/handlers/fs-watch.ts for the same fix.
const state = getOrCreateGlobal<SweepState>(
  "__jarela_doc_fast_sweep_state",
  () => ({ lastRunAt: new Map() }),
);

let scriptRegistered = false;
function registerSweepScript(): void {
  if (scriptRegistered) return;
  registerScript("documents.run_remote_source", async (args) => {
    const sourceId = String(args.source_id ?? "");
    if (!sourceId) return { preview: "skipped: missing source_id" };
    // Resolve the source row at fire time so we always pick up the
    // latest config / cursor without caching it.
    const sources = listEnabledDocumentSources();
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return { preview: `skipped: source ${sourceId} not enabled` };
    if (!isRemoteKind(source.kind)) {
      return { preview: `skipped: source ${sourceId} is not a remote kind` };
    }
    try {
      const stats = await runRemoteSource(source);
      return {
        preview:
          `${source.kind} ${source.path}: ` +
          `+${stats.added} ~${stats.updated} =${stats.unchanged} !${stats.errors}`,
      };
    } catch (err) {
      const msg = errorMessage(err);
      // The runRemoteSource path normally swallows its own errors; if
      // something escaped, mark the source so the panel surfaces it.
      try { markSourceScanned(source.id, msg); } catch { /* noop */ }
      throw err;
    }
  });
  scriptRegistered = true;
}

registerSweepScript();

export const documentFastSweepHandler: TriggerHandler = {
  kind: DOCUMENT_FAST_SWEEP_KIND,

  getDueFirings(asOf: Date): TriggerFiring[] {
    const now = asOf.getTime();
    const interval = intervalMs();
    const sources = listEnabledDocumentSources().filter((s) => isRemoteKind(s.kind));
    const firings: ScriptFiring[] = [];
    for (const s of sources) {
      const last = state.lastRunAt.get(s.id) ?? 0;
      if (now - last < interval) continue;
      firings.push({
        id: `${s.id}:${now}`,
        kind: DOCUMENT_FAST_SWEEP_KIND,
        mode: "script",
        script: "documents.run_remote_source",
        args: { source_id: s.id },
      });
    }
    return firings;
  },

  markFired(firing: TriggerFiring): void {
    if (firing.mode !== "script") return;
    const sourceId = firing.args ? String(firing.args.source_id ?? "") : "";
    if (!sourceId) return;
    // Throttle on every firing regardless of outcome — Atlassian
    // rate-limits don't differentiate between success and error.
    state.lastRunAt.set(sourceId, Date.now());
  },
};

/** Test-only helper. */
export function __resetFastSweepState(): void {
  state.lastRunAt.clear();
}
