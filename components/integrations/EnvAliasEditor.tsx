"use client";

// Editor for the env-sync allowlist overrides. Users see the default
// env-var aliases (read-only chips) and can add their own additional
// aliases per (integration, field) — lets a dotfile that names tokens
// `MY_ANT_KEY` still feed `anthropic.api_key`. Save calls
// /api/v1/env-sync/allowlist (PUT). The integration + field side is
// fixed by the schema in INTEGRATIONS; this UI never lets users invent
// new targets.

import { useEffect, useState } from "react";
import { Loader2, Save, X } from "lucide-react";
import { api } from "@/api/client";
import type { EnvAllowlistConfig, EnvAllowlistMapping } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";

const ROW_KEY = (integration: string, field: string) => `${integration}:${field}`;

export function EnvAliasEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [config, setConfig] = useState<EnvAllowlistConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.envSync.allowlist.get().then((c) => {
      setConfig(c);
      const initial: Record<string, string> = {};
      for (const m of c.defaults) {
        initial[ROW_KEY(m.integration, m.field)] = (c.overrides[ROW_KEY(m.integration, m.field)] ?? []).join(", ");
      }
      setDrafts(initial);
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  async function saveRow(m: EnvAllowlistMapping) {
    const key = ROW_KEY(m.integration, m.field);
    const envVars = drafts[key]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setSavingKey(key);
    setError(null);
    try {
      const next = await api.envSync.allowlist.set(m.integration, m.field, envVars);
      setConfig(next);
      setDrafts((d) => ({ ...d, [key]: (next.overrides[key] ?? []).join(", ") }));
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="mb-3 px-3 py-3 rounded border border-border bg-surface-2 text-[11px]">
      <div className="flex items-start gap-2 mb-2">
        <span className="font-semibold text-fg flex-1">Env-sync aliases</span>
        <button onClick={onClose} className="text-fg-faint hover:text-fg" aria-label="Close alias editor">
          <X size={12} />
        </button>
      </div>
      <p className="text-fg-faint mb-3">
        Default names are always checked. Add your own aliases (comma-separated) per row when your dotfile uses a different name.
      </p>
      {error && (
        <div className="mb-2 px-2 py-1 rounded border border-border bg-surface-3 text-fg">{error}</div>
      )}
      {config === null ? (
        <p className="text-fg-faint">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {config.defaults.map((m) => {
            const key = ROW_KEY(m.integration, m.field);
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <span className="text-fg-muted min-w-[120px]">
                  {m.integration}.{m.field}
                </span>
                <span className="flex flex-wrap gap-1">
                  {m.envVars.map((v) => (
                    <span key={v} className="px-1.5 py-0.5 rounded bg-surface-3 text-fg-faint border border-border">
                      {v}
                    </span>
                  ))}
                </span>
                <input
                  type="text"
                  value={drafts[key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  placeholder="MY_OTHER_NAME, SOMETHING_ELSE"
                  className="flex-1 min-w-[160px] px-2 py-1 rounded border border-border bg-surface text-fg"
                />
                <button
                  onClick={() => saveRow(m)}
                  disabled={savingKey === key}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-50"
                >
                  {savingKey === key ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                  Save
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
