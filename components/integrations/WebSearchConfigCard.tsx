"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe2, RotateCcw, Save, Sparkles } from "lucide-react";
import { refreshRuntimeConfig } from "@/api/runtime-config";

interface EnvRow {
  name: string;
  current: string;
  default: number | string | boolean;
  overridden: boolean;
  requiresRestart: boolean;
}

const VAR_NAME = "JARELA_WEB_SEARCH_PROVIDER_ORDER";
const VALID = ["tavily", "duckduckgo"] as const;

const PRESETS: Array<{ id: string; label: string; value: string; description: string }> = [
  {
    id: "tavily-first",
    label: "Tavily first",
    value: "tavily,duckduckgo",
    description: "Best quality when TAVILY_API_KEY is available; DDG as fallback.",
  },
  {
    id: "ddg-first",
    label: "DuckDuckGo first",
    value: "duckduckgo,tavily",
    description: "No-key path first; Tavily only if DDG fails.",
  },
];

export function WebSearchConfigCard() {
  const [row, setRow] = useState<EnvRow | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/env", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const body = (await r.json()) as { entries: EnvRow[] };
      const found = body.entries.find((e) => e.name === VAR_NAME) ?? null;
      setRow(found);
      if (found) setValue(found.current);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const normalized = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of value.split(",")) {
      const v = token.trim().toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }, [value]);

  const invalid = normalized.filter((v) => !VALID.includes(v as (typeof VALID)[number]));
  const canSave = row !== null && invalid.length === 0 && normalized.length > 0 && value.trim().length > 0;

  async function save(next: string) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const r = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: VAR_NAME, value: next }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      refreshRuntimeConfig();
      await load();
      setStatus("Saved. New order applies immediately.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const r = await fetch("/api/v1/env", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: VAR_NAME, value: null }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      }
      refreshRuntimeConfig();
      await load();
      setStatus("Reset to default provider order.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-2/70 p-4 mt-4">
      <div className="flex items-center gap-2">
        <Globe2 size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">Web search fallback</h3>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        Choose provider order for the built-in web_search tool. Supported providers: tavily, duckduckgo.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={saving}
            onClick={() => {
              setValue(p.value);
              void save(p.value);
            }}
            className="text-left rounded-lg border border-border bg-surface px-3 py-2 hover:bg-surface-3 disabled:opacity-50"
          >
            <div className="flex items-center gap-1 text-xs font-medium text-fg">
              <Sparkles size={11} />
              {p.label}
            </div>
            <div className="mt-0.5 text-[11px] text-fg-faint">{p.description}</div>
            <code className="mt-1 block text-[11px] text-fg-muted">{p.value}</code>
          </button>
        ))}
      </div>

      <div className="mt-3">
        <label className="text-[11px] text-fg-muted" htmlFor="web-search-order">
          Custom order (comma-separated)
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="web-search-order"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="tavily,duckduckgo"
            className="flex-1 px-2 py-1 rounded border border-border bg-surface text-fg text-[12px] font-mono"
          />
          <button
            type="button"
            onClick={() => { void save(value); }}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 text-[11px]"
          >
            <Save size={11} /> Save
          </button>
          <button
            type="button"
            onClick={() => { void resetToDefault(); }}
            disabled={!row?.overridden || saving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-40 text-[11px]"
          >
            <RotateCcw size={11} /> Reset
          </button>
        </div>
        <p className="mt-1 text-[11px] text-fg-faint">
          Current effective order: {normalized.length > 0 ? normalized.join(" -> ") : "(empty)"}
        </p>
        {invalid.length > 0 && (
          <p className="mt-1 text-[11px] text-red-400">
            Unknown provider(s): {invalid.join(", ")}. Allowed: {VALID.join(", ")}.
          </p>
        )}
      </div>

      {status && <p className="mt-2 text-[11px] text-emerald-400">{status}</p>}
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

      {row && (
        <p className="mt-2 text-[11px] text-fg-faint">
          Env var: {VAR_NAME} {row.requiresRestart ? "(restart required)" : "(hot-applied)"}
        </p>
      )}
    </section>
  );
}
