"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe2, Sparkles } from "lucide-react";
import { useEnvSettings } from "@/hooks/useEnvSettings";
import { ToolSettingsActionRow } from "./ToolSettingsActionRow";
import { ToolSettingsStatus } from "./ToolSettingsStatus";
import { ToolSettingsSection } from "./ToolSettingsSection";

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
  const { rows, error, setError, save: saveEnv } = useEnvSettings();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const row = rows.find((e) => e.name === VAR_NAME) ?? null;

  useEffect(() => {
    if (!row) return;
    setValue((prev) => (prev.trim().length > 0 ? prev : row.current));
  }, [row]);

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
      await saveEnv(VAR_NAME, next);
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
      await saveEnv(VAR_NAME, null);
      setStatus("Reset to default provider order.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ToolSettingsSection
      title="Web search fallback"
      description="Configure provider order for the built-in web_search tool. Supported providers: tavily, duckduckgo."
      icon={<Globe2 size={14} className="text-accent" />}
    >

      <div className="grid gap-2 sm:grid-cols-2">
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
        <div className="mt-1 space-y-2">
          <input
            id="web-search-order"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="tavily,duckduckgo"
            className="flex-1 px-2 py-1 rounded border border-border bg-surface text-fg text-[12px] font-mono"
          />
          <ToolSettingsActionRow
            onSave={() => { void save(value); }}
            saving={saving}
            saveLabel="Save"
            savingLabel="Saving..."
            onReset={() => { void resetToDefault(); }}
            resetLabel="Reset"
            resetDisabled={!row?.overridden}
          />
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

      <ToolSettingsStatus status={status} error={error} />

      {row && (
        <p className="mt-2 text-[11px] text-fg-faint">
          Env var: {VAR_NAME} {row.requiresRestart ? "(restart required)" : "(hot-applied)"}
        </p>
      )}
    </ToolSettingsSection>
  );
}
