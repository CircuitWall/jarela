"use client";
import { ChevronLeft, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { pushErrorToast } from "@/lib/ui/error-report";

const SECRET_MASK = "********";

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

interface Props {
  // When set, the picker opens directly on a specific category (e.g.
  // "llm" when launched from the ModelEditor's "+ New credential" button).
  initialCategory?: Category;
  // When set, skip the picker entirely and open the form for this exact
  // integration name (e.g. "anthropic"). Used by the Credentials panel's
  // edit affordance so the user lands straight on the right form.
  directProviderName?: string;
  // When set, lock the category step — the user can't navigate back to
  // pick a different bucket. Used when the host already constrained the
  // category (e.g. ModelEditor only wants LLM credentials).
  lockCategory?: boolean;
  onClose: () => void;
  // Called after a successful save with the integration name that was
  // configured. Hosts can use this to refresh their views.
  onSaved?: (integrationName: string) => void;
  // Hook for "open in Built-in integrations sub-tab" — host wires it to
  // flip the Credentials tab onto the integrations sub. When omitted the
  // link is hidden.
  onOpenInIntegrations?: (integrationName: string) => void;
}

// Unified picker for adding/editing any credential. Shows manifest
// providers grouped by category, then drops the user into a manifest-
// driven form. Backed by api.integrations.* — saves land in the same
// credentials table the IntegrationsPanel writes to.
export function AddCredentialDialog({ initialCategory, directProviderName, lockCategory, onClose, onSaved, onOpenInIntegrations }: Props) {
  const [defs, setDefs] = useState<IntegrationDefinition[]>([]);
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<"pick" | "form">(directProviderName ? "form" : "pick");
  const [category] = useState<Category | null>(initialCategory ?? null);
  const [activeName, setActiveName] = useState<string | null>(directProviderName ?? null);

  useEscapeKey(onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.integrations.list();
        if (cancelled) return;
        setDefs(res.definitions);
        setStatuses(Object.fromEntries(res.statuses.map((s) => [s.name, s])));
      } catch (e) {
        if (cancelled) return;
        pushErrorToast({ title: "Couldn't load credentials catalog", error: e, context: { panel: "credentials", action: "catalog.load" } });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const grouped = useMemo(() => {
    const out = new Map<Category, IntegrationDefinition[]>();
    for (const def of defs) {
      const cat = (def.category ?? "other") as Category;
      const arr = out.get(cat) ?? [];
      arr.push(def);
      out.set(cat, arr);
    }
    for (const [, arr] of out) arr.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [defs]);

  const visibleCategories = useMemo(() => {
    if (category) return [category];
    return CATEGORY_ORDER.filter((c) => grouped.has(c));
  }, [category, grouped]);

  function openProvider(name: string) {
    setActiveName(name);
    setStep("form");
  }

  function backToPicker() {
    setActiveName(null);
    setStep("pick");
  }

  const activeDef = activeName ? defs.find((d) => d.name === activeName) ?? null : null;
  const activeStatus = activeName ? statuses[activeName] ?? null : null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-[70] p-2 sm:p-4 overflow-y-auto">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-lg shadow-xl my-2 sm:my-4">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          {step === "form" && !lockCategory && !directProviderName && (
            <button onClick={backToPicker} className="text-fg-subtle hover:text-fg" title="Back to picker">
              <ChevronLeft size={16} />
            </button>
          )}
          <h3 className="text-sm font-semibold text-fg flex-1 truncate">
            {step === "form" && activeDef
              ? `${activeStatus?.configured ? "Edit" : "Connect"} ${activeDef.label}`
              : "Add credential"}
          </h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        {step === "pick" && (
          <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
            {loading && <p className="text-fg-faint text-sm text-center py-6">Loading…</p>}
            {!loading && defs.length === 0 && (
              <p className="text-fg-faint text-sm text-center py-6">No credential providers available.</p>
            )}
            {!loading && visibleCategories.map((cat) => {
              const entries = grouped.get(cat) ?? [];
              if (entries.length === 0) return null;
              return (
                <section key={cat}>
                  <h4 className="text-[11px] uppercase tracking-wide text-fg-faint mb-1.5 px-1">{CATEGORY_LABELS[cat]}</h4>
                  <div className="divide-y divide-border/60 border border-border/60 rounded-xl overflow-hidden bg-surface-3/40">
                    {entries.map((def) => {
                      const configured = statuses[def.name]?.configured;
                      return (
                        <button
                          key={def.name}
                          type="button"
                          onClick={() => openProvider(def.name)}
                          className="w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors flex items-start gap-3"
                        >
                          <div className={`w-1.5 h-1.5 rounded-full mt-1.5 ${configured ? "bg-emerald-500" : "bg-fg-faint"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-fg flex items-center gap-2">
                              <span className="font-medium">{def.label}</span>
                              {configured && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-700 bg-emerald-900/20 text-emerald-700 dark:text-emerald-300">
                                  configured
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-fg-faint mt-0.5 leading-snug">{def.description}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {step === "form" && activeDef && (
          <ProviderForm
            def={activeDef}
            status={activeStatus}
            onSaved={() => {
              onSaved?.(activeDef.name);
              onClose();
            }}
            onCancel={lockCategory || directProviderName ? onClose : backToPicker}
            onOpenInIntegrations={onOpenInIntegrations ? () => { onOpenInIntegrations(activeDef.name); onClose(); } : undefined}
          />
        )}
        {step === "form" && !activeDef && (
          <p className="text-fg-faint text-sm text-center py-8">Loading…</p>
        )}
      </div>
    </div>
  );
}

interface ProviderFormProps {
  def: IntegrationDefinition;
  status: IntegrationStatus | null;
  onSaved: () => void;
  onCancel: () => void;
  onOpenInIntegrations?: () => void;
}

function ProviderForm({ def, status, onSaved, onCancel, onOpenInIntegrations }: ProviderFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(status?.values ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await api.integrations.save(def.name, values);
      // Notify both panels that the credentials surface changed so they
      // refresh without a full reload.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      pushErrorToast({
        title: `Couldn't save ${def.label}`,
        error: e,
        context: { panel: "credentials", action: "integration.save", integration: def.name },
      });
    } finally {
      setSaving(false);
    }
  }

  // OAuth providers benefit from the IntegrationsPanel's "Connect" flow.
  // Surface a hint and a shortcut rather than forcing the user to paste
  // refresh tokens by hand.
  const isOauth = def.fields.some((f) => f.key === "client_id" || f.key === "refresh_token");

  return (
    <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
      <p className="text-[11px] text-fg-muted leading-snug">{def.description}</p>

      {isOauth && onOpenInIntegrations && (
        <div className="px-3 py-2 rounded border border-sky-700/40 bg-sky-900/15 text-[11px] text-sky-700 dark:text-sky-300 flex items-start gap-2">
          <span className="flex-1">
            This provider supports one-click OAuth. Built-in integrations has the “Connect” button that walks you through it.
          </span>
          <button
            type="button"
            onClick={onOpenInIntegrations}
            className="text-[11px] underline hover:text-sky-600 dark:hover:text-sky-200 shrink-0"
          >
            Open
          </button>
        </div>
      )}

      {def.fields.map((f) => (
        <label key={f.key} className="block text-xs text-fg-subtle">
          <span className="flex items-center gap-1.5">
            {f.label}
            {f.required && <span className="text-rose-700 dark:text-rose-400 ml-0.5">*</span>}
          </span>
          <input
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
            onFocus={(e) => {
              // Clicking a masked secret field clears it so the user can type a fresh
              // value without manually selecting and replacing the dots.
              if (f.secret && e.target.value === SECRET_MASK) {
                setValues((p) => ({ ...p, [f.key]: "" }));
              }
            }}
            placeholder={f.placeholder}
            className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
          />
        </label>
      ))}

      {error && (
        <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saving && <Loader2 size={11} className="animate-spin" />}
          {saving ? "Saving…" : status?.configured ? "Update" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3"
        >
          Cancel
        </button>
        {onOpenInIntegrations && (
          <button
            type="button"
            onClick={onOpenInIntegrations}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:text-accent/80"
            title="Open in Built-in integrations — full editor with Test/OAuth"
          >
            Advanced <ExternalLink size={10} />
          </button>
        )}
      </div>
    </div>
  );
}
