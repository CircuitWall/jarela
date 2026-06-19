"use client";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { Credential, IntegrationDefinition, IntegrationStatus } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { Dialog } from "@/components/ui/Dialog";
import { IntegrationCard } from "./IntegrationCard";

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
  // When provided, the dialog edits THAT specific credential row instead
  // of the provider's default. The dialog still skips the picker.
  credential?: Credential | null;
  // When true, the dialog creates a NEW credential row for the chosen
  // provider instead of editing the default. Used for the "Add another
  // credential" affordance in CredentialsPanel.
  createNew?: boolean;
  onClose: () => void;
  // Called after a successful save with the integration name that was
  // configured. Hosts can use this to refresh their views.
  onSaved?: (integrationName: string) => void;
}

// Unified picker for adding/editing any credential. Shows manifest
// providers grouped by category, then drops the user into the same
// IntegrationCard editor the Credentials panel renders inline — so
// OAuth Connect, Test, and the setup guides are all in one place.
export function AddCredentialDialog({ initialCategory, directProviderName, lockCategory, credential, createNew, onClose, onSaved }: Props) {
  const [defs, setDefs] = useState<IntegrationDefinition[]>([]);
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [loading, setLoading] = useState(true);
  const initialProviderName = directProviderName ?? credential?.provider ?? null;
  const [step, setStep] = useState<"pick" | "form">(initialProviderName ? "form" : "pick");
  const [category] = useState<Category | null>(initialCategory ?? null);
  const [activeName, setActiveName] = useState<string | null>(initialProviderName);

  const reload = useCallback(async () => {
    try {
      const res = await api.integrations.list();
      setDefs(res.definitions);
      setStatuses(Object.fromEntries(res.statuses.map((s) => [s.name, s])));
    } catch (e) {
      pushErrorToast({ title: "Couldn't load credentials catalog", error: e, context: { panel: "credentials", action: "catalog.load" } });
    }
  }, []);

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

  const showBack = step === "form" && !lockCategory && !directProviderName && !credential && !createNew;

  const titleNode =
    step === "form" && activeDef
      ? credential
        ? `Edit ${credential.label ?? credential.id}`
        : createNew
          ? `New ${activeDef.label} credential`
          : `${activeStatus?.configured ? "Edit" : "Connect"} ${activeDef.label}`
      : "Add credential";

  return (
    <Dialog
      open
      onClose={onClose}
      title={titleNode}
      size="md"
      align="top"
      level="topmost"
      padded={false}
      titlePrefix={
        showBack ? (
          <button onClick={backToPicker} className="text-fg-subtle hover:text-fg" title="Back to picker">
            <ChevronLeft size={16} />
          </button>
        ) : undefined
      }
    >
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
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          <IntegrationCard
            definition={activeDef}
            status={activeStatus ?? undefined}
            credential={credential ?? undefined}
            createNew={createNew}
            onChanged={() => {
              if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("jarela:credentials-changed"));
              }
              onSaved?.(activeDef.name);
              void reload();
            }}
            onDeleted={onClose}
          />
        </div>
      )}
      {step === "form" && !activeDef && (
        <p className="text-fg-faint text-sm text-center py-8">Loading…</p>
      )}
    </Dialog>
  );
}
