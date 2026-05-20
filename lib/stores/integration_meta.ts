// Per-field metadata for integration credentials. Sits beside the
// integration values (lib/stores/integrations.ts) and tracks where each
// field's value came from — `"rc"` means env-sync wrote it, `"user"`
// means the user typed it into the Integrations panel.
//
// The env-syncer (lib/env/sync.ts) only overwrites fields whose source
// is `"rc"` (or absent). The moment a user edits the field in the panel
// the source flips to `"user"` and the syncer leaves it alone — this is
// the "panel-wins-once-touched" conflict rule.
//
// Stored in its own memory_store namespace `integration_meta`. Not
// encrypted — the metadata itself contains no secrets, just provenance
// flags + a sync timestamp.

import { getMemory, putMemory } from "@/lib/stores/memory";

const NAMESPACE = "integration_meta";

export type FieldSource = "rc" | "user";

export interface IntegrationMeta {
  /** Source flag per field key (e.g. `{ token: "rc" }`). */
  source: Record<string, FieldSource>;
  /** ISO timestamp of the last successful rc sync that wrote this row. */
  rc_synced_at: string | null;
}

const EMPTY: IntegrationMeta = { source: {}, rc_synced_at: null };

export function getIntegrationMeta(name: string): IntegrationMeta {
  const row = getMemory(NAMESPACE, name);
  if (!row) return { ...EMPTY, source: {} };
  try {
    const parsed = JSON.parse(row.value) as Partial<IntegrationMeta> | null;
    return {
      source: (parsed?.source && typeof parsed.source === "object") ? parsed.source as Record<string, FieldSource> : {},
      rc_synced_at: parsed?.rc_synced_at ?? null,
    };
  } catch {
    return { ...EMPTY, source: {} };
  }
}

/**
 * Update many fields across many integrations in one pass. Keeps DB
 * writes proportional to changed integrations, not changed fields.
 */
export function setFieldSources(
  updates: Array<{ name: string; field: string; source: FieldSource }>,
  rcSyncedAt?: string,
): void {
  if (updates.length === 0) return;
  const byName = new Map<string, IntegrationMeta>();
  for (const u of updates) {
    let m = byName.get(u.name);
    if (!m) {
      m = getIntegrationMeta(u.name);
      byName.set(u.name, m);
    }
    m.source[u.field] = u.source;
    if (rcSyncedAt && u.source === "rc") m.rc_synced_at = rcSyncedAt;
  }
  for (const [name, meta] of byName) putMemory(NAMESPACE, name, meta);
}

/** Convenience for the common "user just edited these fields" case. */
export function markFieldsAsUserTouched(name: string, fields: string[]): void {
  if (fields.length === 0) return;
  setFieldSources(fields.map((f) => ({ name, field: f, source: "user" })));
}
