"use client";

import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
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

export function StepCredentials({ definitions, integrations, onChanged }: StepCredentialsProps) {
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

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
          initialCategory="llm"
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