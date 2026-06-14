"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Check, RefreshCw, X } from "lucide-react";
import { usePackages } from "@/hooks/usePackages";
import { pushErrorToast } from "@/lib/ui/error-report";
import { api } from "@/api/client";
import type {
  LangChainCatalogEntry,
  LangChainPackageInstallResponse,
} from "@/api/types";

const CATEGORIES = [
  "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
  "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar",
  "Config", "Agent",
] as const;

const CAPABILITIES = ["read", "write", "execute"] as const;

interface ManifestFormState {
  name: string;
  package: string;
  exportName: string;
  category: (typeof CATEGORIES)[number];
  capability: (typeof CAPABILITIES)[number];
  requiredEnv: string;
}

const EMPTY_FORM: ManifestFormState = {
  name: "",
  package: "",
  exportName: "",
  category: "Web",
  capability: "execute",
  requiredEnv: "",
};

// Collapsible "Install package" section. Holds the npm install form,
// the pending-approvals queue, and the manual manifest editor. Renders
// nothing visible past the header until expanded — matches the UX we
// agreed: clean default view, one click to expand for power users.
export function InstallPanel() {
  const {
    pending,
    install,
    approveInstall,
    denyInstall,
    createManifest,
    reload,
    loadResult,
  } = usePackages();
  const [open, setOpen] = useState(false);

  const [installSpec, setInstallSpec] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [form, setForm] = useState<ManifestFormState>(EMPTY_FORM);
  const [savingManifest, setSavingManifest] = useState(false);
  const [catalog, setCatalog] = useState<LangChainCatalogEntry[]>([]);
  const [catalogSelection, setCatalogSelection] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void api.packages
      .catalog()
      .then((res) => {
        if (!cancelled) setCatalog(res.entries ?? []);
      })
      .catch(() => {
        // Catalog is a convenience; failing to load shouldn't break the panel.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applyCatalogEntry(id: string) {
    setCatalogSelection(id);
    if (!id) return;
    const entry = catalog.find((e) => e.id === id);
    if (!entry) return;
    setInstallSpec(entry.npmPackage);
    setInstallVersion("");
    setInstallNotice(null);
    setForm({
      name: entry.id.replace(/[^a-z0-9_-]+/g, "_"),
      package: entry.manifestPackage ?? entry.npmPackage,
      exportName: entry.exportName,
      category: (CATEGORIES as readonly string[]).includes(entry.category)
        ? (entry.category as (typeof CATEGORIES)[number])
        : "Web",
      capability: entry.capability ?? "execute",
      requiredEnv: (entry.requiredEnv ?? []).join(", "),
    });
  }

  const headerCount = useMemo(() => {
    const n = pending.length;
    return n > 0 ? `${n} pending` : null;
  }, [pending]);

  async function handleInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!installSpec.trim()) return;
    setInstalling(true);
    setInstallNotice(null);
    try {
      const res: LangChainPackageInstallResponse = await install(
        installSpec.trim(),
        installVersion.trim() || undefined,
      );
      if (res.status === "pending") {
        setInstallNotice(
          `Publisher "${res.publisher}" not in allowlist — pending approval below.`,
        );
      } else {
        setInstallNotice(
          `Installed ${res.resolvedPackage}@${res.installedVersion ?? "?"} (${res.tools.length} tool${res.tools.length === 1 ? "" : "s"} found).`,
        );
        setInstallSpec("");
        setInstallVersion("");
      }
    } catch (e) {
      pushErrorToast({
        title: "Install failed",
        error: e,
        context: { panel: "packages", action: "install", spec: installSpec },
      });
    } finally {
      setInstalling(false);
    }
  }

  async function handleApprove(id: string) {
    try {
      await approveInstall(id);
    } catch (e) {
      pushErrorToast({
        title: "Approval failed",
        error: e,
        context: { panel: "packages", action: "approve", id },
      });
    }
  }

  async function handleDeny(id: string) {
    try {
      await denyInstall(id);
    } catch (e) {
      pushErrorToast({
        title: "Deny failed",
        error: e,
        context: { panel: "packages", action: "deny", id },
      });
    }
  }

  async function handleCreateManifest(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.package.trim()) return;
    setSavingManifest(true);
    try {
      const requiredEnv = form.requiredEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const exportName = form.exportName.trim();
      await createManifest({
        name: form.name.trim(),
        package: form.package.trim(),
        // Blank Export = wildcard: register every StructuredTool-shaped
        // export of the package, not just `default`.
        export: exportName.length > 0 ? exportName : "*",
        category: form.category,
        capability: form.capability,
        requiredEnv: requiredEnv.length > 0 ? requiredEnv : undefined,
      });
      setForm(EMPTY_FORM);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't create manifest",
        error: e,
        context: { panel: "packages", action: "create-manifest", name: form.name },
      });
    } finally {
      setSavingManifest(false);
    }
  }

  async function handleReload() {
    try {
      await reload();
    } catch (e) {
      pushErrorToast({
        title: "Reload failed",
        error: e,
        context: { panel: "packages", action: "reload" },
      });
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-3 rounded-lg"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-sm font-semibold text-fg flex-1">Install package</span>
        {headerCount && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900">
            {headerCount}
          </span>
        )}
        <span className="text-[11px] text-fg-faint">
          {open ? "Hide" : "Install from npm or add a manifest"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-3 py-3 space-y-5">
          <p className="text-xs text-fg-faint">
            Hot-load vanilla LangChain tool packages from npm without a rebuild.
            Trusted publishers (<code className="font-mono text-[11px]">@langchain/</code>,{" "}
            <code className="font-mono text-[11px]">@circuitwall/</code>,{" "}
            <code className="font-mono text-[11px]">langchain</code>) install
            immediately; everything else waits for approval below.
          </p>
          {loadResult?.packagesDir && (
            <p className="text-[11px] text-fg-faint font-mono">
              {loadResult.packagesDir}
            </p>
          )}

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide flex-1">
                Install from npm
              </h4>
              <button
                type="button"
                onClick={handleReload}
                className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-3 inline-flex items-center gap-1.5"
                aria-label="Reload installed packages"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Reload
              </button>
            </div>
            {catalog.length > 0 && (
              <div className="space-y-1">
                <label
                  htmlFor="catalog-picker"
                  className="block text-[11px] text-fg-faint"
                >
                  Pick from curated LangChain tools (auto-fills the form below):
                </label>
                <select
                  id="catalog-picker"
                  value={catalogSelection}
                  onChange={(e) => applyCatalogEntry(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Curated LangChain tool catalog"
                >
                  <option value="">— Choose a tool —</option>
                  {catalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} ({entry.npmPackage}) — {entry.description}
                    </option>
                  ))}
                </select>
                {catalogSelection && (() => {
                  const entry = catalog.find((e) => e.id === catalogSelection);
                  if (!entry) return null;
                  return (
                    <p className="text-[11px] text-fg-faint">
                      Export: <code className="font-mono">{entry.exportName}</code>
                      {entry.requiredEnv && entry.requiredEnv.length > 0 && (
                        <>
                          {" "}
                          · Requires:{" "}
                          <code className="font-mono">
                            {entry.requiredEnv.join(", ")}
                          </code>
                        </>
                      )}
                      {entry.docsUrl && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={entry.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-fg"
                          >
                            Docs
                          </a>
                        </>
                      )}
                    </p>
                  );
                })()}
              </div>
            )}
            <form
              onSubmit={handleInstall}
              className="grid gap-2 md:grid-cols-[minmax(0,1fr)_140px_auto]"
            >
              <input
                type="text"
                value={installSpec}
                onChange={(e) => setInstallSpec(e.target.value)}
                placeholder="@langchain/community"
                className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                aria-label="Package spec"
              />
              <input
                type="text"
                value={installVersion}
                onChange={(e) => setInstallVersion(e.target.value)}
                placeholder="version (optional)"
                className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                aria-label="Version"
              />
              <button
                type="submit"
                disabled={installing || !installSpec.trim()}
                className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {installing ? "Installing…" : "Install"}
              </button>
            </form>
            {installNotice && <p className="text-xs text-fg-muted">{installNotice}</p>}
          </section>

          {pending.length > 0 && (
            <section className="space-y-2">
              <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
                Pending approvals ({pending.length})
              </h4>
              <ul className="space-y-2">
                {pending.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-lg border border-border bg-surface-1 px-3 py-2.5"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-mono text-fg">
                          {p.spec}
                          {p.version ? `@${p.version}` : ""}
                        </div>
                        <p className="text-xs text-fg-muted mt-0.5">
                          Publisher <span className="font-mono">{p.publisher}</span> · {p.reason}
                        </p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleApprove(p.id)}
                          className="rounded-md border border-border px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-3 inline-flex items-center gap-1"
                          aria-label={`Approve ${p.spec}`}
                        >
                          <Check className="w-3.5 h-3.5" /> Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeny(p.id)}
                          className="rounded-md border border-border px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-3 inline-flex items-center gap-1"
                          aria-label={`Deny ${p.spec}`}
                        >
                          <X className="w-3.5 h-3.5" /> Deny
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
              Add manifest
            </h4>
            <p className="text-xs text-fg-faint">
              Maps an exported class from an installed npm package to a built-in
              category. Surfaced under <code className="font-mono text-[11px]">/api/v1/tools</code>{" "}
              after a reload.
            </p>
            <form
              onSubmit={handleCreateManifest}
              className="rounded-lg border border-border bg-surface-1 p-3 space-y-2"
            >
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="name (e.g. tavily)"
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Manifest name"
                />
                <input
                  type="text"
                  value={form.package}
                  onChange={(e) => setForm({ ...form, package: e.target.value })}
                  placeholder="package (e.g. @langchain/community/tools/tavily_search)"
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Package import path"
                />
                <input
                  type="text"
                  value={form.exportName}
                  onChange={(e) => setForm({ ...form, exportName: e.target.value })}
                  placeholder="export (blank = all tools in package)"
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Export name"
                />
                <input
                  type="text"
                  value={form.requiredEnv}
                  onChange={(e) => setForm({ ...form, requiredEnv: e.target.value })}
                  placeholder="required env, comma-separated"
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Required env vars"
                />
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      category: e.target.value as (typeof CATEGORIES)[number],
                    })
                  }
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Category"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={form.capability}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      capability: e.target.value as (typeof CAPABILITIES)[number],
                    })
                  }
                  className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
                  aria-label="Capability"
                >
                  {CAPABILITIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={savingManifest || !form.name.trim() || !form.package.trim()}
                  className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs text-fg hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingManifest ? "Saving…" : "Add manifest"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
