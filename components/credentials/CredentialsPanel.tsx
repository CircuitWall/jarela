"use client";
import { CheckCircle2, ChevronRight, Filter, Key, Loader2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Credential, CredentialType, IntegrationDefinition, IntegrationStatus, UserProfile } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { useCredentialProbes, type CredentialProbeResult } from "@/hooks/useCredentialProbes";
import { NetworkPanel } from "@/components/integrations/NetworkPanel";
import { PRESET_CATEGORIES } from "@/lib/integrations/categories";
import { AddCredentialDialog } from "./AddCredentialDialog";
import { IntegrationCard } from "./IntegrationCard";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { errorMessage } from "@/lib/utils/error";
import { SubTabBar, type SubTabItem } from "@/components/ui/SubTabBar";
import { StatusDot } from "@/components/ui/StatusDot";

// "Credentials" is the single home for every auth surface. The default
// sub-tab is the unified list: model API keys, integration keys, and
// OAuth (Gmail/Outlook/etc.) all live here, grouped by category, with
// each known integration rendered as an inline editor (save / test /
// Connect). The sibling "Network & environment" sub-tab hosts the
// non-auth bits — HTTP proxy, allowed sites, env-var aliases, and the
// env-sync button.
//
// MCP servers (a capability, not an auth) live under Tools. Result: one
// mental model — *Credentials* answers "what accounts has this agent
// been given access to".

type Sub = "list" | "network";

const SUB_TITLES: Record<Sub, string> = {
  list: "Credentials",
  network: "Network & environment",
};

const TYPE_ORDER = ["model", "integration", "tts", "bridge"] as const;

type GroupTypeKey = (typeof TYPE_ORDER)[number];

const TYPE_LABELS: Record<GroupTypeKey, string> = {
  model: "Model provider credentials",
  integration: "Tool credentials",
  tts: "Voice credentials",
  bridge: "Bridge credentials",
};

const TYPE_HINTS: Record<GroupTypeKey, string> = {
  model: "Keys used by model configurations.",
  integration: "Credentials used by tools and integrations.",
  tts: "Credentials used by voice output providers.",
  bridge: "Credentials used by external bridge connectors.",
};

const PRESET_LABELS: Record<NonNullable<UserProfile["preset"]>, string> = {
  home: "Home",
  work: "Work",
  dev: "Developer",
  custom: "Everything",
};

function describeCredential(c: Credential): string {
  const keys = Object.keys(c.params).filter((k) => k !== "base_url" && k !== "extra_headers");
  if (keys.length === 0) return "Not configured";
  if (c.auth_method === "oauth") {
    return c.params.refresh_token ? "Refresh token stored" : "OAuth pending";
  }
  return `Fields: ${keys.join(", ")}`;
}

export function CredentialsPanel() {
  const { state, dispatch } = useAppContext();
  const raw = state.selectedItem.credentials;
  // Backward compatibility: the second sub-tab used to be keyed
  // "integrations" (when it was called "Built-in integrations"). Honour
  // older deep links and saved selections by routing them to the new
  // "network" key.
  const active: Sub = raw === "network" || raw === "integrations" ? "network" : "list";

  const setSub = (s: Sub) =>
    dispatch({ type: "SET_SELECTION", tab: "credentials", itemId: s });

  const tabItems: SubTabItem<Sub>[] = (["list", "network"] as Sub[]).map((s) => ({
    id: s,
    label: SUB_TITLES[s],
  }));

  return (
    <div className="flex flex-col h-full min-h-0">
      <SubTabBar
        ariaLabel="Credentials sub-section"
        tabs={tabItems}
        active={active}
        onChange={setSub}
      />
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {active === "list" ? <CredentialsListPanel /> : <NetworkPanel />}
      </div>
    </div>
  );
}

export function CredentialsListPanel() {
  const { dispatch } = useAppContext();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [defs, setDefs] = useState<IntegrationDefinition[]>([]);
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [preset, setPreset] = useState<UserProfile["preset"]>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addAnotherProvider, setAddAnotherProvider] = useState<string | null>(null);
  const [editingCredential, setEditingCredential] = useState<Credential | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [collapsedByType, setCollapsedByType] = useState<Record<GroupTypeKey, boolean>>({
    model: true,
    integration: true,
    tts: true,
    bridge: true,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "credential", containerRef);
  useDeepLinkScroll("credentials", "integration", containerRef);
  // Auto-test every saved credential on mount + after edits so the UI
  // shows a live ✓/✗ next to each row without the user having to click
  // Test for each one. Results are cached in-module across re-renders.
  const probes = useCredentialProbes(credentials);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, ints, profile] = await Promise.all([
        api.credentials.list(),
        api.integrations.list().catch(() => ({ definitions: [] as IntegrationDefinition[], statuses: [] as IntegrationStatus[] })),
        api.profile.get().catch(() => null),
      ]);
      setCredentials(rows);
      setDefs(ints.definitions);
      setStatuses(Object.fromEntries(ints.statuses.map((s) => [s.name, s])));
      setPreset(profile?.preset ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    if (typeof window !== "undefined") window.addEventListener("jarela:credentials-changed", onChange);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("jarela:credentials-changed", onChange);
    };
  }, [refresh]);

  const defByName = useMemo(() => {
    const m = new Map<string, IntegrationDefinition>();
    for (const d of defs) m.set(d.name, d);
    return m;
  }, [defs]);

  async function syncFromEnv() {
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
        setSyncMsg(`Synced ${r.applied_count} field(s) from ${sourceLabel}.`);
      } else {
        const userSkipped = r.candidates.filter((c) => c.action === "skipped-user").length;
        const equal = r.candidates.filter((c) => c.action === "skipped-equal").length;
        const absent = r.candidates.filter((c) => c.action === "absent").length;
        if (userSkipped > 0) {
          setSyncMsg(`Nothing to write \u2014 ${userSkipped} field(s) were edited here and won't be overwritten.`);
        } else if (equal > 0 && absent === r.candidates.length - equal) {
          setSyncMsg(`Already up to date with ${sourceLabel}.`);
        } else {
          setSyncMsg(`No matching env vars set in ${sourceLabel}.`);
        }
      }
      await refresh();
    } catch (e) {
      setSyncMsg(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }

  async function handleDelete(c: Credential) {
    setDeleteError(null);
    try {
      if (c.type === "integration") {
        await api.integrations.delete(c.provider);
      } else {
        await api.credentials.delete(c.id);
      }
      refresh();
    } catch (e) {
      setDeleteError(`Could not delete "${c.id}": ${errorMessage(e)}`);
    }
  }

  // Persona filter: hide unconfigured definitions outside the chosen
  // bucket. Used only to count how many integrations the picker hides
  // — the list itself only renders providers with saved credentials.
  const visibleDefs = useMemo(() => {
    if (!preset) return defs;
    const allowed = PRESET_CATEGORIES[preset];
    if (allowed === null) return defs;
    return defs.filter((def) => {
      if (!def.category) return true;
      if (allowed.has(def.category)) return true;
      return statuses[def.name]?.configured === true;
    });
  }, [defs, preset, statuses]);

  const hiddenCount = defs.length - visibleDefs.length;

  // Group saved credentials by type, then provider. "integration" rows are
  // the unified tool-credential bucket so mail/github/calendar/etc all live
  // in one collapsible section.
  const groupedByType = useMemo(() => {
    type ProviderGroup = {
      type: CredentialType;
      provider: string;
      def: IntegrationDefinition | undefined;
      credentials: Credential[];
      sortLabel: string;
    };

    const byType = new Map<GroupTypeKey, ProviderGroup[]>();
    const byProvider = new Map<string, Credential[]>();
    for (const c of credentials) {
      const key = `${c.type}::${c.provider}`;
      const arr = byProvider.get(key) ?? [];
      arr.push(c);
      byProvider.set(key, arr);
    }

    for (const rows of byProvider.values()) {
      const type = rows[0]?.type;
      const provider = rows[0]?.provider;
      if (!type || !provider) continue;
      // Stable ordering: default first, then by id.
      rows.sort((a, b) => {
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
      const def = defByName.get(provider);
      const section = TYPE_ORDER.includes(type as GroupTypeKey)
        ? (type as GroupTypeKey)
        : "integration";
      const arr = byType.get(section) ?? [];
      arr.push({
        type,
        provider,
        def,
        credentials: rows,
        sortLabel: (def?.label ?? provider).toLowerCase(),
      });
      byType.set(section, arr);
    }

    for (const groups of byType.values()) {
      groups.sort((a, b) => a.sortLabel.localeCompare(b.sortLabel) || a.provider.localeCompare(b.provider));
    }

    return TYPE_ORDER
      .filter((t) => byType.has(t))
      .map((t) => [t, byType.get(t)!] as const);
  }, [credentials, defByName]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Key size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Credentials</h2>
        {preset && preset !== "custom" && (
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_TAB", tab: "profile" })}
            title={`Filtered to "${PRESET_LABELS[preset]}" preset. Click to change in Profile.`}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border border-border bg-surface-2 text-fg-muted hover:bg-surface-3"
          >
            <Filter size={11} />
            <span>{PRESET_LABELS[preset]}</span>
            {hiddenCount > 0 && (
              <span className="text-fg-faint">· {hiddenCount} hidden</span>
            )}
          </button>
        )}
        <button
          onClick={syncFromEnv}
          disabled={syncing}
          title="Pull standard credential env vars (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) from your shell rc / Windows User env into the Credentials list. Fields you've edited here are never overwritten."
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-50"
        >
          {syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Sync from environment
        </button>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Pick a provider and connect it. Same editors are available inline below."
        >
          <Plus size={14} /> Add credential
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar">
        <div className="px-4 py-2 space-y-4">
          {syncMsg && (
            <div className="px-3 py-2 rounded border border-border bg-surface-2 text-[11px] text-fg-muted flex items-start gap-2">
              <RefreshCw size={12} className="mt-0.5 text-fg-subtle shrink-0" />
              <span className="flex-1">{syncMsg}</span>
              <button onClick={() => setSyncMsg(null)} className="text-fg-faint hover:text-fg" aria-label="Dismiss">
                <XCircle size={12} />
              </button>
            </div>
          )}
          {loading && credentials.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
          )}
          {!loading && groupedByType.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">
              No credentials yet. Click <span className="font-medium">+ Add credential</span> to connect a model provider (OpenAI, Anthropic, Gemini…) or an integration (Gmail, GitHub, Atlassian…).
            </p>
          )}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {groupedByType.map(([type, groups]) => {
            const credentialCount = groups.reduce((sum, g) => sum + g.credentials.length, 0);
            const collapsed = collapsedByType[type];
            return (
              <section key={type} className="rounded-lg border border-border/60 bg-surface-2/35 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setCollapsedByType((prev) => ({ ...prev, [type]: !prev[type] }))}
                  className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-surface-3/30 transition-colors"
                  aria-expanded={!collapsed}
                >
                  <ChevronRight size={14} className={["text-fg-faint transition-transform", collapsed ? "" : "rotate-90"].join(" ")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-fg truncate">{TYPE_LABELS[type]}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border">
                        {groups.length} provider{groups.length === 1 ? "" : "s"}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border">
                        {credentialCount} credential{credentialCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="text-[11px] text-fg-faint truncate">{TYPE_HINTS[type]}</p>
                  </div>
                </button>
                {!collapsed && (
                  <div className="px-2 pb-2 space-y-3 border-t border-border/50">
                    {groups.map(({ provider, def, credentials: rows }) => (
                      <ProviderGroup
                        key={`${type}:${provider}`}
                        provider={provider}
                        def={def}
                        rows={rows}
                        probes={probes}
                        onEdit={(c) => setEditingCredential(c)}
                        onAddAnother={() => setAddAnotherProvider(provider)}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {addOpen && (
        <AddCredentialDialog
          onClose={() => { setAddOpen(false); refresh(); }}
          onSaved={() => refresh()}
        />
      )}
      {addAnotherProvider && (
        <AddCredentialDialog
          directProviderName={addAnotherProvider}
          createNew
          onClose={() => { setAddAnotherProvider(null); refresh(); }}
          onSaved={() => refresh()}
        />
      )}
      {editingCredential && (
        <AddCredentialDialog
          directProviderName={editingCredential.provider}
          credential={editingCredential}
          onClose={() => { setEditingCredential(null); refresh(); }}
          onSaved={() => refresh()}
        />
      )}
    </div>
  );
}

function ProviderGroup({
  provider,
  def,
  rows,
  probes,
  onEdit,
  onAddAnother,
  onDelete,
}: {
  provider: string;
  def: IntegrationDefinition | undefined;
  rows: Credential[];
  probes: Map<string, CredentialProbeResult>;
  onEdit: (c: Credential) => void;
  onAddAnother: () => void;
  onDelete: (c: Credential) => void;
}) {
  const title = def?.label ?? provider;
  return (
    <div data-deep-link-id={provider} className="rounded-lg border border-border/60 bg-surface-2/40">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2">
        <span className="shrink-0 text-fg-subtle"><ProviderLogo name={provider} size={16} /></span>
        <span className="text-xs font-medium text-fg truncate">{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border font-mono">{provider}</span>
        <button
          onClick={onAddAnother}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent-hover"
          title={`Add another credential for ${title}`}
        >
          <Plus size={11} /> Add another
        </button>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((c) => {
          const probe = probes.get(c.id) ?? { state: "idle" as const };
          const broken = probe.state === "error";
          return (
            <li
              key={c.id}
              data-deep-link-id={c.id}
              onClick={() => onEdit(c)}
              className={
                "flex items-center gap-3 px-3 py-2 group cursor-pointer hover:bg-surface-3/30 transition-colors " +
                (broken ? "bg-red-500/5" : "")
              }
            >
              <ProbeIndicator probe={probe} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-fg truncate">{c.label ?? c.id}</span>
                  {c.is_default && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-700 bg-emerald-900/20 text-emerald-700 dark:text-emerald-300">
                      default
                    </span>
                  )}
                  <span className="text-[10px] text-fg-faint">{c.auth_method}</span>
                </div>
                <p className={"text-[11px] truncate " + (broken ? "text-red-700 dark:text-red-400" : "text-fg-subtle")}>
                  {broken ? (probe.message ?? "Probe failed") : describeCredential(c)}
                </p>
              </div>
              <div className="flex gap-1 opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(c); }}
                  className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Status icon for the auto-probe sweep. Loading spinner while the probe
// is in flight, green check on ok, red X on failure, neutral dot when
// the provider doesn't expose a probe (e.g. credentials without an
// integration definition).
function ProbeIndicator({ probe }: { probe: CredentialProbeResult }) {
  if (probe.state === "running" || probe.state === "idle") {
    return (
      <span title="Testing credential…" className="shrink-0 inline-flex">
        <Loader2 size={13} className="text-fg-faint animate-spin" aria-label="Testing credential" />
      </span>
    );
  }
  if (probe.state === "ok") {
    return (
      <span title="Credential is reachable." className="shrink-0 inline-flex">
        <CheckCircle2 size={13} className="text-emerald-500" aria-label="Credential reachable" />
      </span>
    );
  }
  if (probe.state === "error") {
    return (
      <span title={probe.message ?? "Probe failed"} className="shrink-0 inline-flex">
        <XCircle size={13} className="text-red-500" aria-label="Credential probe failed" />
      </span>
    );
  }
  // unsupported — provider has no health probe registered.
  return <StatusDot tone="success" size="xs" />;
}
