"use client";

import { useMemo, useState } from "react";
import { RotateCcw, Settings2 } from "lucide-react";
import { useEnvSettings, type EnvSettingRow } from "@/hooks/useEnvSettings";
import { ToolSettingInput } from "./ToolSettingInput";
import { ToolSettingsActionRow } from "./ToolSettingsActionRow";
import { ToolSettingsStatus } from "./ToolSettingsStatus";
import { ToolSettingsSection } from "./ToolSettingsSection";

const TOOL_GROUPS: Array<{ title: string; vars: string[]; description: string }> = [
  {
    title: "Search & fetch",
    description: "Web search fallback order and fetch payload limits.",
    vars: ["JARELA_WEB_SEARCH_PROVIDER_ORDER", "JARELA_FETCH_TOOL_MAX_BYTES"],
  },
  {
    title: "Files & command execution",
    description: "Output/read/write byte caps for local tooling.",
    vars: ["JARELA_EXEC_MAX_OUTPUT_BYTES", "JARELA_FILES_MAX_READ_BYTES", "JARELA_FILES_MAX_WRITE_BYTES"],
  },
  {
    title: "Media generation",
    description: "Per-request timeout limits for voice and image tools.",
    vars: ["JARELA_VOICE_TIMEOUT_MS", "JARELA_IMAGE_TIMEOUT_MS"],
  },
  {
    title: "Registry & safety",
    description: "MCP discovery timeout and global tool safety mode.",
    vars: ["JARELA_MCP_REGISTRY_TIMEOUT_MS", "JARELA_TOOL_SAFETY"],
  },
];

function ToolVarField({
  row,
  value,
  saving,
  onChange,
  onSave,
  onReset,
}: {
  row: EnvSettingRow;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-[11px] text-fg font-mono">{row.name}</code>
        {row.overridden && (
          <span className="px-1.5 rounded text-[9px] uppercase tracking-wide bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
            overridden
          </span>
        )}
        {row.requiresRestart && (
          <span className="px-1.5 rounded text-[9px] uppercase tracking-wide bg-amber-500/20 text-amber-700 dark:text-amber-300">
            restart
          </span>
        )}
        <span className="ml-auto text-[10px] text-fg-faint">default: {String(row.default)}</span>
      </div>
      <p className="mt-1 text-[11px] text-fg-muted">{row.description}</p>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1">
          <ToolSettingInput
            label="Value"
            type={row.type === "int" ? "number" : row.type === "bool" ? "boolean" : row.type === "enum" ? "enum" : "string"}
            value={value}
            onChange={onChange}
            placeholder={String(row.default)}
            enumValues={row.enumValues}
          />
        </div>
        <ToolSettingsActionRow
          onSave={onSave}
          saving={saving}
          saveLabel="Save"
          savingLabel="Saving..."
          onReset={onReset}
          resetLabel="Reset"
          resetDisabled={!row.overridden}
        />
      </div>
    </div>
  );
}

export function InternalToolConfigCard() {
  const { rows, loading, error, setError, save: saveEnv } = useEnvSettings();
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const toolRows = useMemo(
    () => rows.filter((r) => r.category === "tools"),
    [rows],
  );

  const rowByName = useMemo(() => {
    const m = new Map<string, EnvSettingRow>();
    for (const r of toolRows) m.set(r.name, r);
    return m;
  }, [toolRows]);

  const grouped = useMemo(() => TOOL_GROUPS.map((group) => ({
    ...group,
    rows: group.vars.map((v) => rowByName.get(v)).filter(Boolean) as EnvSettingRow[],
  })).filter((g) => g.rows.length > 0), [rowByName]);

  async function saveVar(name: string, value: string | null) {
    setSaving((prev) => ({ ...prev, [name]: true }));
    setError(null);
    setStatus(null);
    try {
      await saveEnv(name, value);
      setStatus(value === null ? `Reset ${name} to default.` : `Saved ${name}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving((prev) => ({ ...prev, [name]: false }));
    }
  }

  async function resetAll() {
    const overridden = toolRows.filter((r) => r.overridden);
    if (overridden.length === 0) return;
    setError(null);
    setStatus(null);
    try {
      for (const row of overridden) {
        await saveEnv(row.name, null);
      }
      setStatus(`Reset ${overridden.length} tool settings to defaults.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <ToolSettingsSection
      title="Internal tool runtime controls"
      description="These are built-in tool controls with schema defaults from Jarela. Changes apply immediately unless marked restart."
      icon={<Settings2 size={14} className="text-accent" />}
      actions={(
        <button
          type="button"
          onClick={() => { void resetAll(); }}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-fg-muted hover:bg-surface-3 text-[11px]"
        >
          <RotateCcw size={11} /> Reset all to defaults
        </button>
      )}
    >

      {loading && <p className="text-xs text-fg-muted">Loading tool settings…</p>}
      {!loading && grouped.length === 0 && (
        <p className="text-xs text-fg-muted">No internal tool settings are currently exposed.</p>
      )}

      {grouped.map((group) => (
        <div key={group.title} className="space-y-2">
          <div>
            <h4 className="text-xs font-semibold text-fg">{group.title}</h4>
            <p className="text-[11px] text-fg-faint">{group.description}</p>
          </div>
          <div className="grid gap-2">
            {group.rows.map((row) => {
              const value = drafts[row.name] ?? row.current;
              return (
                <ToolVarField
                  key={row.name}
                  row={row}
                  value={value}
                  saving={!!saving[row.name]}
                  onChange={(next) => setDrafts((prev) => ({ ...prev, [row.name]: next }))}
                  onSave={() => { void saveVar(row.name, value); }}
                  onReset={() => {
                    setDrafts((prev) => ({ ...prev, [row.name]: String(row.default) }));
                    void saveVar(row.name, null);
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}

      <ToolSettingsStatus status={status} error={error} />
    </ToolSettingsSection>
  );
}
