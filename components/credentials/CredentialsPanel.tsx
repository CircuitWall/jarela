"use client";
import { Filter, Key, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition, IntegrationStatus, UserProfile } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { NetworkPanel } from "@/components/integrations/NetworkPanel";
import { PRESET_CATEGORIES } from "@/lib/integrations/categories";
import { AddCredentialDialog } from "./AddCredentialDialog";
import { IntegrationCard } from "./IntegrationCard";

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

type Category = NonNullable<IntegrationDefinition["category"]>;

const CATEGORY_ORDER: Category[] = [
  "llm",
  "mail",
  "calendar",
  "issue-tracker",
  "infrastructure",
  "chat",
  "other",
];

const CATEGORY_LABELS: Record<Category, string> = {
  llm: "Model providers (LLM)",
  mail: "Mail",
  calendar: "Calendar",
  "issue-tracker": "Issue trackers",
  infrastructure: "Infrastructure",
  chat: "Chat",
  other: "Other",
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Credentials sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {(["list", "network"] as Sub[]).map((s) => {
          const selected = s === active;
          return (
            <button
              key={s}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSub(s)}
              className={
                "px-3 py-1.5 text-sm rounded-t-md border-b-2 -mb-px transition-colors " +
                (selected
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--bg-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {SUB_TITLES[s]}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
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
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "credential", containerRef);
  useDeepLinkScroll("credentials", "integration", containerRef);

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
      setDeleteError(`Could not delete "${c.id}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persona filter: if the user has chosen a preset, hide unconfigured
  // integrations outside that bucket. Configured-but-out-of-bucket
  // entries stay visible so a saved credential never silently vanishes.
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

  // Group: every visible definition belongs in its category bucket
  // (renders as IntegrationCard); credentials WITHOUT a matching
  // definition (legacy model rows etc.) also fall into the right
  // bucket so the user sees a single grouped list.
  const grouped = useMemo(() => {
    type Row =
      | { kind: "def"; def: IntegrationDefinition }
      | { kind: "credential"; credential: Credential };
    const byCat = new Map<Category, Row[]>();
    const defNames = new Set(visibleDefs.map((d) => d.name));

    for (const def of visibleDefs) {
      const cat = (def.category ?? "other") as Category;
      const arr = byCat.get(cat) ?? [];
      arr.push({ kind: "def", def });
      byCat.set(cat, arr);
    }
    for (const c of credentials) {
      if (defNames.has(c.provider)) continue; // covered by the integration card
      const cat = (defByName.get(c.provider)?.category ?? "other") as Category;
      const arr = byCat.get(cat) ?? [];
      arr.push({ kind: "credential", credential: c });
      byCat.set(cat, arr);
    }
    return CATEGORY_ORDER
      .filter((c) => byCat.has(c))
      .map((c) => [c, byCat.get(c)!] as const);
  }, [visibleDefs, credentials, defByName]);

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
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Pick a provider and connect it. Same editors are available inline below."
        >
          <Plus size={14} /> Add credential
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 space-y-4">
          {loading && credentials.length === 0 && defs.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
          )}
          {!loading && grouped.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">
              No credentials yet. Click <span className="font-medium">+ Add credential</span> to connect a model provider (OpenAI, Anthropic, Gemini…) or an integration (Gmail, GitHub, Atlassian…).
            </p>
          )}
          {deleteError && (
            <p className="text-red-700 dark:text-red-400 text-xs mb-2 px-1">{deleteError}</p>
          )}
          {grouped.map(([cat, rows]) => (
            <section key={cat}>
              <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-1 px-1">{CATEGORY_LABELS[cat]}</h3>
              <div className="space-y-2">
                {rows.map((row) => {
                  if (row.kind === "def") {
                    const def = row.def;
                    const status = statuses[def.name];
                    const isOpen = expandedProvider === def.name || !!status?.configured;
                    if (!isOpen) {
                      // Collapse unconfigured integrations into a compact row.
                      return (
                        <div
                          key={def.name}
                          data-deep-link-id={def.name}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-surface-2/40"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-fg-faint" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-sm font-medium text-fg truncate">{def.label}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border font-mono">{def.name}</span>
                            </div>
                            <p className="text-[11px] text-fg-subtle truncate">{def.description}</p>
                          </div>
                          <button
                            onClick={() => setExpandedProvider(def.name)}
                            className="text-[11px] text-accent hover:text-accent-hover shrink-0"
                            title="Open editor"
                          >
                            Connect
                          </button>
                        </div>
                      );
                    }
                    return (
                      <IntegrationCard
                        key={def.name}
                        definition={def}
                        status={status}
                        onChanged={refresh}
                      />
                    );
                  }
                  // Legacy credential row (no matching integration definition).
                  const c = row.credential;
                  return (
                    <div key={c.id} data-deep-link-id={c.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-surface-2/40 group">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-fg truncate">{c.provider}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border font-mono">{c.provider}</span>
                          <span className="text-[10px] text-fg-faint">{c.auth_method}</span>
                        </div>
                        <p className="text-[11px] text-fg-subtle">{describeCredential(c)}</p>
                      </div>
                      <div className="flex gap-1 opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => setEditingProvider(c.provider)}
                          className="p-1 text-fg-subtle hover:text-fg transition-colors"
                          title="Edit credential"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(c)}
                          className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {addOpen && (
        <AddCredentialDialog
          onClose={() => { setAddOpen(false); refresh(); }}
          onSaved={() => refresh()}
        />
      )}
      {editingProvider && (
        <AddCredentialDialog
          directProviderName={editingProvider}
          onClose={() => { setEditingProvider(null); refresh(); }}
          onSaved={() => refresh()}
        />
      )}
    </div>
  );
}
