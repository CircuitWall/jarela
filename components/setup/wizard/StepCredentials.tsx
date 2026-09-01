"use client";

import { Globe2, KeyRound, Loader2, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
import { ToolSettingsActionRow } from "@/components/tools/ToolSettingsActionRow";
import { ToolSettingsStatus } from "@/components/tools/ToolSettingsStatus";
import { useEnvSettings } from "@/hooks/useEnvSettings";
import { errorMessage } from "@/lib/utils/error";
import { StepShell } from "./StepShell";

interface StepCredentialsProps {
  definitions: IntegrationDefinition[];
  integrations: IntegrationStatus[];
  onChanged: () => void;
}

const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "deepseek",
  "cohere",
] as const;

const SEARCH_ORDER_VAR = "JARELA_WEB_SEARCH_PROVIDER_ORDER";
const GOOGLE_SEARCH_ENGINE_VAR = "JARELA_GOOGLE_SEARCH_ENGINE_ID";

function SearchEngineSetup() {
  const { rows, error, setError, save: saveEnv } = useEnvSettings();
  const [providerOrder, setProviderOrder] = useState("google,tavily,duckduckgo");
  const [searchEngineId, setSearchEngineId] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const orderRow = rows.find((row) => row.name === SEARCH_ORDER_VAR) ?? null;
  const engineRow = rows.find((row) => row.name === GOOGLE_SEARCH_ENGINE_VAR) ?? null;

  useEffect(() => {
    if (orderRow) setProviderOrder((prev) => (prev.trim() ? prev : orderRow.current));
    if (engineRow) setSearchEngineId((prev) => (prev.trim() ? prev : engineRow.current));
  }, [engineRow, orderRow]);

  async function saveGoogleFirst() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await saveEnv(SEARCH_ORDER_VAR, providerOrder.trim() || "google,tavily,duckduckgo");
      await saveEnv(GOOGLE_SEARCH_ENGINE_VAR, searchEngineId.trim() || null);
      setStatus(searchEngineId.trim()
        ? "Search setup saved. Google will be tried before the fallback providers."
        : "Provider order saved. Add a Google search engine id when you want Google results.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function resetSearchEngine() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await saveEnv(SEARCH_ORDER_VAR, null);
      await saveEnv(GOOGLE_SEARCH_ENGINE_VAR, null);
      setProviderOrder(orderRow?.default ? String(orderRow.default) : "tavily,google,duckduckgo");
      setSearchEngineId("");
      setStatus("Search settings reset to defaults.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-3 px-3 py-3 text-xs text-fg-subtle">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Search size={16} />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-fg">Search engines</p>
              {searchEngineId.trim() && (
                <span className="rounded border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  Google selected
                </span>
              )}
            </div>
            <p className="mt-1 leading-relaxed">
              Choose which search engines agents try first, including Google Custom Search before Tavily or DuckDuckGo.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1.15fr]">
            <label className="space-y-1">
              <span className="block text-[11px] font-medium text-fg-muted">Provider order</span>
              <input
                value={providerOrder}
                onChange={(event) => setProviderOrder(event.target.value)}
                placeholder="google,tavily,duckduckgo"
                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-medium text-fg-muted">Google search engine id</span>
              <input
                value={searchEngineId}
                onChange={(event) => setSearchEngineId(event.target.value)}
                placeholder="Programmable Search Engine cx"
                className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          <p className="leading-relaxed text-fg-faint">
            Google also needs the Google API key from the Google provider card in Model providers. Create the search engine id at programmablesearchengine.google.com.
          </p>
          <ToolSettingsActionRow
            onSave={() => { void saveGoogleFirst(); }}
            saving={saving}
            saveLabel="Save search setup"
            savingLabel="Saving..."
            onReset={() => { void resetSearchEngine(); }}
            resetLabel="Reset search"
            resetDisabled={!orderRow?.overridden && !engineRow?.overridden}
          />
          <ToolSettingsStatus status={status} error={error} />
        </div>
      </div>
    </div>
  );
}

export function StepCredentials({ definitions, integrations, onChanged }: StepCredentialsProps) {
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const claudeDef = useMemo(
    () => definitions.find((def) => def.name === "claude-code") ?? null,
    [definitions],
  );

  const llmDefs = useMemo(() => {
    const byName = new Map(definitions.map((def) => [def.name, def]));
    const ordered = PROVIDER_ORDER
      .map((name) => byName.get(name))
      .filter((def): def is IntegrationDefinition => !!def && def.category === "llm");
    const remaining = definitions
      .filter((def) => def.category === "llm" && !PROVIDER_ORDER.includes(def.name as (typeof PROVIDER_ORDER)[number]))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...ordered, ...remaining];
  }, [definitions]);

  const statusByName = useMemo(
    () => Object.fromEntries(integrations.map((row) => [row.name, row])),
    [integrations],
  );

  async function handleSyncFromEnv() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.envSync.apply();
      const sourceLabel = r.discovered.source === "shell-rc"
        ? `your ${r.discovered.shell ?? "shell"} rc`
        : r.discovered.source === "windows-registry"
          ? "your Windows User env"
          : "the process env";
      if (r.applied_count > 0) {
        setSyncMsg(`Imported ${r.applied_count} field(s) from ${sourceLabel}.`);
      } else {
        const userSkipped = r.candidates.filter((c) => c.action === "skipped-user").length;
        const equal = r.candidates.filter((c) => c.action === "skipped-equal").length;
        const absent = r.candidates.filter((c) => c.action === "absent").length;
        if (userSkipped > 0) {
          setSyncMsg("Nothing imported - fields edited in the UI stay authoritative.");
        } else if (equal > 0 && absent === r.candidates.length - equal) {
          setSyncMsg(`Already up to date with ${sourceLabel}.`);
        } else {
          setSyncMsg(`No matching provider credentials found in ${sourceLabel}.`);
        }
      }
      onChanged();
    } catch (e) {
      setSyncMsg(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <StepShell
      icon={<KeyRound size={18} />}
      eyebrow="Step 2 · Credentials"
      title="Connect provider credentials in the UI first"
      description="Use the built-in credential forms as the main setup path. They work for Claude, GPT, Gemini, Copilot, and other providers without depending on your shell environment."
    >
      <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs text-fg">
        <p className="font-medium">Recommended path</p>
        <p className="mt-1 leading-relaxed text-fg-subtle">
          Add or edit provider credentials here, then pick them from the model editor in the next step. If you already exported tokens in your shell, you can import them as a shortcut, but the UI remains the primary source you manage.
        </p>
      </div>

      {claudeDef && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Agent runtime</div>
          <button
            type="button"
            onClick={() => setActiveProvider(claudeDef.name)}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface-3 px-3 py-3 text-left transition-colors hover:bg-surface-3/70"
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusByName[claudeDef.name]?.configured ? "bg-emerald-500" : "bg-fg-faint"}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <span className="truncate">{claudeDef.label}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusByName[claudeDef.name]?.configured ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-surface text-fg-subtle"}`}>
                  {statusByName[claudeDef.name]?.configured ? "configured" : "optional"}
                </span>
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-fg-faint">
                Give Claude delegation its own UI-managed setup. This lets Jarela launch the local Claude Code CLI with an explicit binary path and API key instead of depending on whatever your shell exported.
              </span>
            </span>
          </button>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">
          <Globe2 size={12} /> Search
        </div>
        <SearchEngineSetup />
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Model providers</div>
        <div className="grid gap-2">
          {llmDefs.map((def) => {
            const status = statusByName[def.name];
            return (
              <button
                key={def.name}
                type="button"
                onClick={() => setActiveProvider(def.name)}
                className="flex items-start gap-3 rounded-xl border border-border bg-surface-3 px-3 py-3 text-left transition-colors hover:bg-surface-3/70"
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${status?.configured ? "bg-emerald-500" : "bg-fg-faint"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    <span className="truncate">{def.label}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${status?.configured ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-surface text-fg-subtle"}`}>
                      {status?.configured ? "configured" : "not connected"}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-fg-faint">{def.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-surface-2/40 px-3 py-3 text-xs text-fg-subtle">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-fg">Already keep tokens in your shell?</p>
            <p className="mt-1 leading-relaxed">
              Import them once here instead of relying on a subprocess to discover them later.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSyncFromEnv}
            disabled={syncing}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-3 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Import existing env
          </button>
        </div>
        {syncMsg && <p className="mt-2 leading-relaxed text-fg-faint">{syncMsg}</p>}
      </div>

      {activeProvider && (
        <AddCredentialDialog
          directProviderName={activeProvider}
          lockCategory
          onClose={() => setActiveProvider(null)}
          onSaved={() => {
            setActiveProvider(null);
            onChanged();
          }}
        />
      )}
    </StepShell>
  );
}