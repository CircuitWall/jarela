// Env-sync orchestrator. Reads "standard" credential env vars from the
// user's shell rc (or Windows User registry), writes them into the
// encrypted integration store, and tracks per-field provenance so user
// edits in the Integrations panel are never overwritten.
//
// Conflict rule: "panel-wins-once-touched". A field whose meta source
// is `"user"` is skipped on every sync; one whose source is `"rc"` (or
// absent) gets the rc value written through. This is what makes
// rotation flow through automatically — the user updates `.zshrc`, the
// next sync picks it up, the encrypted DB row updates, and the
// existing env-then-store fallback in `lib/tools/atlassian.ts` /
// `lib/tools/github.ts` reads the fresh value on the next tool call.
//
// Triggered:
//   - Once per process from `lib/db/index.ts` after DB init (silent,
//     fire-and-forget).
//   - On demand via POST /api/v1/env-sync (returns a SyncResult so the
//     UI can show what happened).

import { getEffectiveAllowlist, getAllEnvVarNames, type EnvFieldMapping } from "./allowlist";
import { discoverEnvVars, type DiscoveredEnv } from "./discover";
import {
  INTEGRATIONS,
  getIntegrationRaw,
  isKnownIntegration,
  type IntegrationName,
} from "@/lib/stores/integrations";
import { getIntegrationMeta, setFieldSources, type FieldSource } from "@/lib/stores/integration_meta";
import { putMemory } from "@/lib/stores/memory";

const INTEGRATIONS_NS = "integrations";

export type SyncAction =
  | "would-write"   // candidate is eligible, will (or did) overwrite
  | "skipped-user"  // user has touched this field — leave it alone
  | "skipped-equal" // rc value matches what's already stored
  | "skipped-empty" // env var was set but empty after trim
  | "absent";       // env var not set in any allowlist alias

export interface SyncCandidate {
  /** Which env var name actually held the value (first present alias). */
  envVar: string | null;
  integration: string;
  field: string;
  /** Current meta source for this field — what's in the DB right now. */
  current_source: FieldSource | "absent";
  current_value_present: boolean;
  /** Masked preview of the rc value (full value for non-secret fields). */
  rc_value_preview: string | null;
  action: SyncAction;
}

export interface SyncResult {
  discovered: DiscoveredEnv;
  candidates: SyncCandidate[];
  /** Subset of `candidates` where action === "would-write" and apply=true. */
  applied_count: number;
  ts: string;
}

/** Public — non-mutating; lets the UI show what *would* happen. */
export async function previewEnvSync(): Promise<SyncResult> {
  return runSync(false);
}

/** Public — mutates the DB (writes "rc"-sourced fields). */
export async function applyEnvSync(): Promise<SyncResult> {
  return runSync(true);
}

// Module-level guard so we run at most once per process from the
// fire-and-forget startup hook. The on-demand API endpoint bypasses
// this and re-runs every call.
let _bootRanPromise: Promise<SyncResult> | null = null;

/**
 * Idempotent boot-time apply. First call kicks off; subsequent calls
 * within the same process return the same promise. Errors are
 * swallowed (logged) — env-sync is best-effort, never blocks startup.
 */
export function runEnvSyncOnce(): Promise<SyncResult | null> {
  if (_bootRanPromise) return _bootRanPromise.catch(() => null);
  _bootRanPromise = applyEnvSync();
  return _bootRanPromise.catch((err) => {
    console.warn("[jarela/env-sync] boot apply failed:", err);
    return null;
  });
}

async function runSync(apply: boolean): Promise<SyncResult> {
  const discovered = await discoverEnvVars(getAllEnvVarNames());
  const ts = new Date().toISOString();
  const candidates: SyncCandidate[] = [];

  // Group writes by integration so we issue one putMemory per row.
  const writesByIntegration = new Map<string, Record<string, string>>();
  const metaUpdates: Array<{ name: string; field: string; source: FieldSource }> = [];

  for (const m of getEffectiveAllowlist()) {
    if (!isKnownIntegration(m.integration)) continue; // allowlist drift; ignore
    const cand = evaluateCandidate(m, discovered.values);
    candidates.push(cand);

    if (apply && cand.action === "would-write") {
      const existing = getIntegrationRaw(m.integration) ?? {};
      const w = writesByIntegration.get(m.integration) ?? { ...existing };
      const value = pickEnvValue(m, discovered.values);
      if (value !== null) w[m.field] = value;
      writesByIntegration.set(m.integration, w);
      metaUpdates.push({ name: m.integration, field: m.field, source: "rc" });
    }
  }

  let applied_count = 0;
  if (apply && writesByIntegration.size > 0) {
    for (const [name, fields] of writesByIntegration) {
      putMemory(INTEGRATIONS_NS, name, fields);
    }
    setFieldSources(metaUpdates, ts);
    applied_count = metaUpdates.length;
  }

  return { discovered, candidates, applied_count, ts };
}

function evaluateCandidate(
  m: EnvFieldMapping,
  values: Record<string, string>,
): SyncCandidate {
  const envVar = m.envVars.find((n) => values[n]) ?? null;
  const rcValue = envVar ? values[envVar] : null;
  const meta = getIntegrationMeta(m.integration);
  const sourceFlag = meta.source[m.field];
  const existing = getIntegrationRaw(m.integration);
  const currentValue = existing?.[m.field] ?? null;
  const currentSource: SyncCandidate["current_source"] = sourceFlag ?? "absent";
  const isSecret = isFieldSecret(m.integration, m.field);

  let action: SyncAction;
  if (envVar === null || rcValue === null) {
    action = "absent";
  } else if (sourceFlag === "user") {
    action = "skipped-user";
  } else if (!rcValue.trim()) {
    action = "skipped-empty";
  } else if (currentValue === rcValue) {
    action = "skipped-equal";
  } else {
    action = "would-write";
  }

  return {
    envVar,
    integration: m.integration,
    field: m.field,
    current_source: currentSource,
    current_value_present: !!currentValue,
    rc_value_preview: rcValue ? maskValue(rcValue, isSecret) : null,
    action,
  };
}

function pickEnvValue(m: EnvFieldMapping, values: Record<string, string>): string | null {
  for (const n of m.envVars) {
    const v = values[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function isFieldSecret(integration: IntegrationName, field: string): boolean {
  const def = INTEGRATIONS[integration];
  return def.fields.find((f) => f.key === field)?.secret ?? true;
}

function maskValue(value: string, isSecret: boolean): string {
  if (!isSecret) return value;
  if (value.length <= 6) return "***";
  return value.slice(0, 4) + "…" + value.slice(-2);
}
