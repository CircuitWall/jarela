"use client";
import { Key, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { IntegrationsPanel } from "@/components/integrations/IntegrationsPanel";
import { AddCredentialDialog } from "./AddCredentialDialog";

// "Credentials" is the single home for every auth surface. The default
// sub-tab is the lightweight, category-grouped list of saved credentials
// ("API keys & secrets"); the second sub-tab hosts the rich
// IntegrationsPanel with one-click OAuth, Test buttons, env-sync, and
// the network section.
//
// MCP servers (a capability, not an auth) moved out to Tools; built-in
// integrations (which used to live under their own "Connections" tab)
// moved in here. Result: one mental model — *Credentials* answers
// "what accounts has this agent been given access to".

type Sub = "list" | "integrations";

const SUB_TITLES: Record<Sub, string> = {
  list: "API keys & secrets",
  integrations: "Built-in integrations",
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
  const active: Sub = raw === "integrations" ? "integrations" : "list";

  const setSub = (s: Sub) =>
    dispatch({ type: "SET_SELECTION", tab: "credentials", itemId: s });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        role="tablist"
        aria-label="Credentials sub-section"
        className="flex gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-2"
      >
        {(["list", "integrations"] as Sub[]).map((s) => {
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
        {active === "list" ? <CredentialsListPanel /> : <IntegrationsPanel />}
      </div>
    </div>
  );
}

function CredentialsListPanel() {
  const { dispatch } = useAppContext();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [defs, setDefs] = useState<IntegrationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("credentials", "credential", containerRef);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, ints] = await Promise.all([
        api.credentials.list(),
        api.integrations.list().catch(() => ({ definitions: [] as IntegrationDefinition[], statuses: [] })),
      ]);
      setCredentials(rows);
      setDefs(ints.definitions);
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

  // OAuth providers + advanced editors live on the Built-in integrations
  // sub-tab. The "open" affordance just flips the sub-tab; per-row scroll
  // would require routing two ids and the integrations list is short.
  function openIntegrationsSubTab() {
    dispatch({ type: "SET_SELECTION", tab: "credentials", itemId: "integrations" });
  }

  const grouped = useMemo(() => {
    const byCat = new Map<Category, Credential[]>();
    for (const c of credentials) {
      const cat = (defByName.get(c.provider)?.category ?? "other") as Category;
      const arr = byCat.get(cat) ?? [];
      arr.push(c);
      byCat.set(cat, arr);
    }
    return CATEGORY_ORDER
      .filter((c) => byCat.has(c))
      .map((c) => [c, byCat.get(c)!] as const);
  }, [credentials, defByName]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Key size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Credentials</h2>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Pick a provider and connect it. Same row also shows in Built-in integrations."
        >
          <Plus size={14} /> Add credential
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 space-y-4">
          {loading && credentials.length === 0 && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
          {!loading && credentials.length === 0 && (
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
              <div className="divide-y divide-border/60 border border-border/60 rounded-xl overflow-hidden bg-surface-2/40">
                {rows.map((c) => {
                  const def = defByName.get(c.provider);
                  const label = def?.label ?? c.provider;
                  return (
                    <div key={c.id} data-deep-link-id={c.id} className="flex items-center gap-3 px-3 py-2.5 group">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-fg truncate">{label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-surface-3 text-fg-muted border-border font-mono">{c.provider}</span>
                          <span className="text-[10px] text-fg-faint">{c.auth_method}</span>
                        </div>
                        <p className="text-[11px] text-fg-subtle">{describeCredential(c)}</p>
                      </div>
                      <div className="flex gap-1 opacity-40 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
                        {def && (
                          <button
                            onClick={() => setEditingProvider(c.provider)}
                            className="p-1 text-fg-subtle hover:text-fg transition-colors"
                            title="Edit credential"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
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
          onOpenInIntegrations={() => { setAddOpen(false); openIntegrationsSubTab(); }}
        />
      )}
      {editingProvider && (
        <AddCredentialDialog
          directProviderName={editingProvider}
          onClose={() => { setEditingProvider(null); refresh(); }}
          onSaved={() => refresh()}
          onOpenInIntegrations={() => { setEditingProvider(null); openIntegrationsSubTab(); }}
        />
      )}
    </div>
  );
}
