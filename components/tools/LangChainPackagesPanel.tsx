"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Trash2, Check, X, Package } from "lucide-react";
import { usePackages } from "@/hooks/usePackages";
import { pushErrorToast } from "@/lib/ui/error-report";
import type {
  LangChainPackageInstallResponse,
  LangChainPackageManifestRecord,
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

export function LangChainPackagesPanel() {
  const {
    loadResult,
    manifests,
    pending,
    loading,
    refresh,
    install,
    approveInstall,
    denyInstall,
    createManifest,
    deleteManifest,
    reload,
  } = usePackages();

  const [installSpec, setInstallSpec] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<string | null>(null);

  const [form, setForm] = useState<ManifestFormState>(EMPTY_FORM);
  const [savingManifest, setSavingManifest] = useState(false);

  const errorRows = useMemo(() => loadResult?.errors ?? [], [loadResult]);
  const skippedRows = useMemo(() => loadResult?.skipped ?? [], [loadResult]);

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
      await createManifest({
        name: form.name.trim(),
        package: form.package.trim(),
        export: form.exportName.trim() || undefined,
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

  async function handleDeleteManifest(record: LangChainPackageManifestRecord) {
    if (typeof window !== "undefined") {
      if (!window.confirm(`Delete manifest "${record.name}"?`)) return;
    }
    try {
      await deleteManifest(record.name);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't delete manifest",
        error: e,
        context: { panel: "packages", action: "delete-manifest", name: record.name },
      });
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
    <div className="p-4 space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-fg">LangChain packages</h2>
        <p className="text-xs text-fg-faint">
          Hot-load vanilla LangChain tool packages from npm without a rebuild. Trusted
          publishers (<code className="font-mono text-[11px]">@langchain/</code>,{" "}
          <code className="font-mono text-[11px]">@circuitwall/</code>,{" "}
          <code className="font-mono text-[11px]">langchain</code>) install
          immediately; everything else waits for approval below.
        </p>
        {loadResult?.packagesDir && (
          <p className="text-[11px] text-fg-faint font-mono">
            {loadResult.packagesDir}
          </p>
        )}
      </header>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg flex-1">Install from npm</h3>
          <button
            type="button"
            onClick={handleReload}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-2 inline-flex items-center gap-1.5"
            aria-label="Reload installed packages"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Reload
          </button>
        </div>
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
        {installNotice && (
          <p className="text-xs text-fg-muted">{installNotice}</p>
        )}
      </section>

      {pending.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">
            Pending approvals ({pending.length})
          </h3>
          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.id}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono text-fg">
                      {p.spec}
                      {p.version ? `@${p.version}` : ""}
                    </div>
                    <p className="text-xs text-fg-muted mt-0.5">
                      Publisher{" "}
                      <span className="font-mono">{p.publisher}</span> · {p.reason}
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

      <section className="space-y-2 pt-3 border-t border-border">
        <h3 className="text-sm font-semibold text-fg">Tool manifests</h3>
        <p className="text-xs text-fg-faint">
          A manifest maps an exported class from an installed npm package to a
          built-in category. Surfaced under{" "}
          <code className="font-mono text-[11px]">/api/v1/tools</code> after a
          reload.
        </p>

        {loading && (
          <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
        )}

        {!loading && manifests.length === 0 && (
          <p className="text-xs text-fg-faint py-2">
            No manifests yet. Add one below.
          </p>
        )}

        <ul className="space-y-2">
          {manifests.map((r) => (
            <li
              key={r.name}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="flex items-start gap-3">
                <Package className="w-4 h-4 text-fg-faint mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-fg">{r.name}</span>
                    <span className="text-[11px] text-fg-faint">
                      {r.manifest.category} · {r.manifest.capability}
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted mt-0.5 font-mono break-all">
                    {r.manifest.package}#{r.manifest.export}
                  </p>
                  {r.manifest.requiredEnv && r.manifest.requiredEnv.length > 0 && (
                    <p className="text-[11px] text-fg-faint mt-1">
                      env: {r.manifest.requiredEnv.join(", ")}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteManifest(r)}
                  className="rounded-md border border-border px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-3 shrink-0"
                  aria-label={`Delete manifest ${r.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>

        <form
          onSubmit={handleCreateManifest}
          className="rounded-lg border border-border bg-surface-2 p-3 space-y-2"
        >
          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
            Add manifest
          </h4>
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
              placeholder="export (default: default)"
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
                <option key={c} value={c}>
                  {c}
                </option>
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
                <option key={c} value={c}>
                  {c}
                </option>
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

      {(errorRows.length > 0 || skippedRows.length > 0) && (
        <section className="space-y-2 pt-3 border-t border-border">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-fg flex-1">Load status</h3>
            <button
              type="button"
              onClick={refresh}
              className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-2"
            >
              Refresh
            </button>
          </div>
          {errorRows.length > 0 && (
            <ul className="space-y-1">
              {errorRows.map((e) => (
                <li
                  key={e.manifest}
                  className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-fg"
                >
                  <span className="font-mono">{e.manifest}</span>: {e.error}
                </li>
              ))}
            </ul>
          )}
          {skippedRows.length > 0 && (
            <ul className="space-y-1">
              {skippedRows.map((s) => (
                <li
                  key={s.manifest}
                  className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-fg-muted"
                >
                  <span className="font-mono">{s.manifest}</span> skipped — {s.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
