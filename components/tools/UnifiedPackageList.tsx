"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Package,
  Settings,
  Trash2,
} from "lucide-react";
import { api } from "@/api/client";
import { usePackages } from "@/hooks/usePackages";
import { pushErrorToast } from "@/lib/ui/error-report";
import { useAppContext } from "@/contexts/AppContext";
import { ProviderLogo } from "@/components/models/ProviderLogo";
import { groupByProvider, OTHER_PROVIDER_KEY } from "@/components/tools/provider-grouping";
import { ToolSettingInput } from "./ToolSettingInput";
import type {
  BuiltinToolCategoryInfo,
  DefaultLangChainPackageInfo,
  ExtensionsListResponse,
  ExternalToolInfo,
  LangChainPackageManifestRecord,
} from "@/api/types";
import { errorMessage } from "@/lib/utils/error";

// One unified row covering every "package-like" surface: built-in
// category, bundled @circuitwall LangChain package, npm-installed
// LangChain manifest, drop-in `.cjs` tool file. All four end up as
// LangChain tools in the agent's pool — this list reflects that.

type Kind = "builtin" | "default" | "npm" | "dropin";

interface UnifiedRow {
  kind: Kind;
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  toolCount: number;
  // per-kind extras for badges / actions
  capability?: "read" | "write" | "execute";
  toolCounts?: { read: number; write: number; execute: number };
  enabled?: boolean;
  npmPackage?: string;
  packageImport?: string;
  category?: string;
  integrationId?: string;
  file?: string;
  external?: ExternalToolInfo;
  hasSecretIssues?: boolean;
  hasConfigIssues?: boolean;
}

const SOURCE_LABELS: Record<Kind, string> = {
  builtin: "Built-in",
  default: "Default",
  npm: "npm",
  dropin: "Drop-in",
};

const SOURCE_BADGE_CLASS: Record<Kind, string> = {
  builtin:
    "bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-900",
  default:
    "bg-violet-50 dark:bg-violet-950/40 text-violet-800 dark:text-violet-300 border-violet-200 dark:border-violet-900",
  npm:
    "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900",
  dropin:
    "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900",
};

const CATEGORY_BLURB: Record<string, string> = {
  Memory: "Long-term recall: remember/recall facts across sessions.",
  Documents: "Semantic search over folders you indexed (RAG).",
  Files: "Read / write / list files in the workspace.",
  Shell: "Execute shell commands locally.",
  Web: "Fetch URLs and run web searches.",
  Images: "Generate images via configured providers.",
  Voice: "Synthesize speech via TTS.",
  Schedule: "Create one-off and recurring scheduled tasks.",
  Atlassian: "Jira and Confluence read/write.",
  JiraAlign: "Jira Align portfolio-level read/write.",
  GitHub: "Issues, pull requests, code search via the GitHub API.",
  Mail: "Read and send email via Gmail / Outlook / iCloud.",
  Calendar: "Read and write calendar events on Google / Outlook / iCloud.",
  Tasks: "Manage tasks and reminders on Microsoft To Do / iCloud Reminders.",
  Microsoft: "Microsoft Graph escape hatch + unified search + People resolver.",
  Config: "Read/write Jarela's own settings.",
};

const SECRET_MASK = "********";

function buildRows(
  builtins: BuiltinToolCategoryInfo[],
  defaults: DefaultLangChainPackageInfo[],
  manifests: LangChainPackageManifestRecord[],
  ext: ExtensionsListResponse | null,
): UnifiedRow[] {
  const rows: UnifiedRow[] = [];

  for (const r of builtins) {
    rows.push({
      kind: "builtin",
      id: `builtin:${r.category}`,
      title: r.category,
      description: CATEGORY_BLURB[r.category] ?? "",
      toolNames: r.toolNames,
      toolCount: r.toolCount,
      enabled: r.enabled,
      category: r.category,
    });
  }

  for (const p of defaults) {
    const total = p.toolCounts.read + p.toolCounts.write + p.toolCounts.execute;
    rows.push({
      kind: "default",
      id: `default:${p.id}`,
      title: p.label,
      description: p.description,
      toolNames: [],
      toolCount: total,
      toolCounts: p.toolCounts,
      enabled: p.enabled,
      npmPackage: p.npmPackage,
      category: p.category,
      integrationId: p.integrationId,
    });
  }

  for (const m of manifests) {
    rows.push({
      kind: "npm",
      id: `npm:${m.name}`,
      title: m.name,
      description: `${m.manifest.package}#${m.manifest.export}`,
      toolNames: [],
      toolCount: 1,
      capability: m.manifest.capability,
      packageImport: `${m.manifest.package}#${m.manifest.export}`,
      category: m.manifest.category,
      enabled: m.enabled,
    });
  }

  if (ext) {
    for (const t of ext.tools) {
      const requiredMissing = t.secrets.some((s) => s.required && !s.is_set);
      const configMissing = t.config.some(
        (s) => s.required && s.value === null && !s.default,
      );
      rows.push({
        kind: "dropin",
        id: `dropin:${t.name}`,
        title: t.name,
        description: t.description,
        toolNames: [t.name],
        toolCount: 1,
        category: t.category ?? undefined,
        file: t.file ?? undefined,
        enabled: t.enabled,
        external: t,
        hasSecretIssues: requiredMissing,
        hasConfigIssues: configMissing,
      });
    }
  }

  return rows;
}

export function UnifiedPackageList() {
  const { dispatch } = useAppContext();
  const {
    loadResult,
    manifests,
    refresh,
    setDefaultEnabled,
    setManifestEnabled,
    deleteManifest,
  } = usePackages();
  const [builtins, setBuiltins] = useState<BuiltinToolCategoryInfo[]>([]);
  const [ext, setExt] = useState<ExtensionsListResponse | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | Kind>("all");
  const [loadingExtras, setLoadingExtras] = useState(true);

  async function loadExtras() {
    setLoadingExtras(true);
    try {
      const [cats, exts] = await Promise.all([
        api.builtinTools.list(),
        api.extensions.list(),
      ]);
      setBuiltins(cats);
      setExt(exts);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't load packages",
        error: e,
        context: { panel: "packages", action: "list" },
      });
    } finally {
      setLoadingExtras(false);
    }
  }

  useEffect(() => {
    void loadExtras();
  }, []);

  const rows = useMemo(
    () => buildRows(builtins, loadResult?.defaults ?? [], manifests, ext),
    [builtins, loadResult, manifests, ext],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      if (!q) return true;
      const hay = `${r.title} ${r.description} ${r.category ?? ""} ${r.npmPackage ?? ""} ${r.packageImport ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, kindFilter]);

  async function toggleBuiltin(row: UnifiedRow) {
    if (!row.category) return;
    const next = !row.enabled;
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await api.builtinTools.setEnabled(row.category, next);
      setBuiltins((prev) =>
        prev.map((r) => (r.category === row.category ? { ...r, enabled: next } : r)),
      );
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle category",
        error: e,
        context: { panel: "packages", action: "toggle-builtin", category: row.category, target_enabled: next },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  async function toggleDefault(row: UnifiedRow) {
    const id = row.id.slice("default:".length);
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await setDefaultEnabled(id, !row.enabled);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle package",
        error: e,
        context: { panel: "packages", action: "toggle-default", id, target_enabled: !row.enabled },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  async function toggleNpm(row: UnifiedRow) {
    const name = row.id.slice("npm:".length);
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await setManifestEnabled(name, !row.enabled);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle package",
        error: e,
        context: { panel: "packages", action: "toggle-npm", name, target_enabled: !row.enabled },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  async function toggleDropin(row: UnifiedRow) {
    const name = row.id.slice("dropin:".length);
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await api.extensions.setDropinEnabled(name, !row.enabled);
      setExt((prev) =>
        prev
          ? {
              ...prev,
              tools: prev.tools.map((t) =>
                t.name === name ? { ...t, enabled: !row.enabled } : t,
              ),
            }
          : prev,
      );
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle tool",
        error: e,
        context: { panel: "packages", action: "toggle-dropin", name, target_enabled: !row.enabled },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  async function removeManifest(row: UnifiedRow) {
    const name = row.id.slice("npm:".length);
    if (typeof window !== "undefined") {
      if (!window.confirm(`Delete manifest "${name}"?`)) return;
    }
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await deleteManifest(name);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't delete manifest",
        error: e,
        context: { panel: "packages", action: "delete-manifest", name },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  function openCredentials(integrationId: string) {
    dispatch({ type: "SET_TAB", tab: "settings" });
    dispatch({ type: "SET_SELECTION", tab: "settings", itemId: "credentials" });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "settings");
      url.searchParams.set("item", "credentials");
      url.searchParams.set("scrollTo", integrationId);
      window.history.replaceState({}, "", url.toString());
    }
  }

  const counts: Record<Kind, number> = {
    builtin: rows.filter((r) => r.kind === "builtin").length,
    default: rows.filter((r) => r.kind === "default").length,
    npm: rows.filter((r) => r.kind === "npm").length,
    dropin: rows.filter((r) => r.kind === "dropin").length,
  };

  const dropInDir = ext?.directories.tools;
  const manifestErrors = loadResult?.errors ?? [];
  const extErrors = ext?.errors.filter((e) => e.kind === "tool") ?? [];

  return (
    <section className="space-y-3">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes size={14} className="text-fg-subtle" />
          <h3 className="text-sm font-semibold text-fg">Installed packages</h3>
        </div>
        <p className="text-xs text-fg-faint">
          Every LangChain-style tool surface in one place: built-in categories,
          bundled defaults, npm-installed packages, and drop-in <code className="font-mono text-[11px]">.cjs</code>{" "}
          files{dropInDir ? <> from <span className="font-mono break-all">{dropInDir}</span></> : null}.
        </p>
      </header>

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, package, or category"
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
        />
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
          aria-label="Source filter"
        >
          <option value="all">All sources ({rows.length})</option>
          <option value="builtin">Built-in ({counts.builtin})</option>
          <option value="default">Default ({counts.default})</option>
          <option value="npm">npm ({counts.npm})</option>
          <option value="dropin">Drop-in ({counts.dropin})</option>
        </select>
      </div>

      {loadingExtras && rows.length === 0 ? (
        <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface-2 px-3 py-4 text-sm text-fg-faint text-center">
          No packages match the current filters.
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((row) => (
            <PackageListRow
              key={row.id}
              row={row}
              busy={Boolean(busy[row.id])}
              expanded={Boolean(expanded[row.id])}
              onToggleExpand={() =>
                setExpanded((m) => ({ ...m, [row.id]: !m[row.id] }))
              }
              onToggleEnabled={() => {
                if (row.kind === "builtin") return toggleBuiltin(row);
                if (row.kind === "default") return toggleDefault(row);
                if (row.kind === "npm") return toggleNpm(row);
                if (row.kind === "dropin") return toggleDropin(row);
              }}
              onRemove={row.kind === "npm" ? () => removeManifest(row) : undefined}
              onConfigureCredentials={
                row.kind === "default" && row.integrationId
                  ? () => openCredentials(row.integrationId!)
                  : undefined
              }
              onSecretsSaved={loadExtras}
            />
          ))}
        </ul>
      )}

      {(manifestErrors.length > 0 || extErrors.length > 0) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle size={13} /> Load errors
          </div>
          <ul className="space-y-1 text-xs text-fg-muted">
            {manifestErrors.map((e) => (
              <li key={`m-${e.manifest}`} className="break-words">
                <span className="font-mono break-all">{e.manifest}</span>: {e.error}
              </li>
            ))}
            {extErrors.map((e, i) => (
              <li key={`x-${e.file}-${i}`} className="break-words">
                <span className="font-mono break-all">{e.file}</span>: {e.error}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              void refresh();
              void loadExtras();
            }}
            className="text-[11px] text-accent hover:text-accent-hover"
          >
            Re-scan
          </button>
        </div>
      )}
    </section>
  );
}

interface PackageListRowProps {
  row: UnifiedRow;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled?: () => void | Promise<void>;
  onRemove?: () => void | Promise<void>;
  onConfigureCredentials?: () => void;
  onSecretsSaved: () => void | Promise<void>;
}

function PackageListRow({
  row,
  busy,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onRemove,
  onConfigureCredentials,
  onSecretsSaved,
}: PackageListRowProps) {
  const canExpand =
    row.toolNames.length > 0 || row.kind === "dropin" || Boolean(row.packageImport);

  return (
    <li className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggleExpand}
          disabled={!canExpand}
          className="shrink-0 mt-0.5 text-fg-faint hover:text-fg disabled:opacity-30 disabled:cursor-default"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {canExpand ? (
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <Package size={14} />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-fg break-words">{row.title}</span>
            <span
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${SOURCE_BADGE_CLASS[row.kind]}`}
            >
              {SOURCE_LABELS[row.kind]}
            </span>
            {row.capability && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-3 text-fg-subtle border-border">
                {row.capability}
              </span>
            )}
            {row.category && row.kind !== "builtin" && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-3 text-fg-subtle border-border">
                {row.category}
              </span>
            )}
            <span className="text-[11px] text-fg-faint">
              {row.toolCount} tool{row.toolCount === 1 ? "" : "s"}
            </span>
            {row.toolCounts && (
              <span className="text-[11px] text-fg-faint">
                ({row.toolCounts.read} r · {row.toolCounts.write} w · {row.toolCounts.execute} x)
              </span>
            )}
            {row.hasSecretIssues && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900">
                missing secrets
              </span>
            )}
            {row.hasConfigIssues && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-900">
                missing config
              </span>
            )}
          </div>
          {row.description && (
            <p className="text-xs text-fg-muted mt-0.5 break-words">{row.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap min-w-0">
            {row.npmPackage && (
              <code className="text-[10px] text-fg-faint font-mono break-all">
                {row.npmPackage}
              </code>
            )}
            {row.file && (
              <code className="text-[10px] text-fg-faint font-mono break-all">
                {row.file}
              </code>
            )}
            {onConfigureCredentials && (
              <button
                type="button"
                onClick={onConfigureCredentials}
                className="text-[11px] text-accent hover:text-accent-hover underline-offset-2 hover:underline"
              >
                Configure credentials
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          {onToggleEnabled && (
            <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none">
              <input
                type="checkbox"
                checked={Boolean(row.enabled)}
                disabled={busy}
                onChange={() => void onToggleEnabled()}
              />
              enabled
            </label>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => void onRemove()}
              disabled={busy}
              className="rounded-md border border-border px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-3 disabled:opacity-50"
              aria-label="Delete manifest"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {expanded && row.toolNames.length > 0 && (
        <ExpandedToolList toolNames={row.toolNames} />
      )}
      {expanded && row.kind === "npm" && row.packageImport && (
        <div className="mt-2 ml-6 text-[11px] text-fg-faint font-mono break-all">
          {row.packageImport}
        </div>
      )}
      {expanded && row.kind === "dropin" && row.external && (
        <DropInSecretsEditor tool={row.external} onSaved={onSecretsSaved} />
      )}
    </li>
  );
}

// Renders the flat list of tool names under an expanded row, grouped by
// third-party provider (Gmail / Outlook / iCloud / Other). Categories
// that span a single provider render as one box; wide categories like
// "Mail" that touch several vendors break out into per-provider blocks
// so the user can eyeball which brand each tool belongs to.
function ExpandedToolList({ toolNames }: { toolNames: string[] }) {
  const groups = groupByProvider(toolNames, (n) => n);
  return (
    <div className="mt-2 ml-6 space-y-1.5">
      {groups.map((g) => (
        <div key={g.provider} className="rounded-md border border-border/60 bg-surface-3/40 p-1.5">
          <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">
            {g.provider !== OTHER_PROVIDER_KEY && (
              <ProviderLogo name={g.provider} size={11} />
            )}
            <span className="font-medium">{g.label}</span>
            <span className="text-fg-faint normal-case tracking-normal">({g.items.length})</span>
          </div>
          <ul className="flex flex-wrap gap-1">
            {g.items.map((n) => (
              <li
                key={n}
                title={n}
                className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted"
              >
                {g.provider !== OTHER_PROVIDER_KEY && n.startsWith(g.provider + "_")
                  ? n.slice(g.provider.length + 1)
                  : n}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DropInSecretsEditor({
  tool,
  onSaved,
}: {
  tool: ExternalToolInfo;
  onSaved: () => void | Promise<void>;
}) {
  const [secretValues, setSecretValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.secrets.map((s) => [s.key, s.is_set ? SECRET_MASK : ""])),
  );
  const [savingSecrets, setSavingSecrets] = useState(false);
  const [secretErr, setSecretErr] = useState<string | null>(null);

  const [configValues, setConfigValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.config.map((s) => [s.key, s.value ?? s.default ?? ""])),
  );
  const [savingConfig, setSavingConfig] = useState(false);
  const [configErr, setConfigErr] = useState<string | null>(null);

  useEffect(() => {
    setSecretValues(
      Object.fromEntries(tool.secrets.map((s) => [s.key, s.is_set ? SECRET_MASK : ""])),
    );
  }, [tool.name, tool.secrets]);

  useEffect(() => {
    setConfigValues(
      Object.fromEntries(tool.config.map((s) => [s.key, s.value ?? s.default ?? ""])),
    );
  }, [tool.name, tool.config]);

  if (tool.secrets.length === 0 && tool.config.length === 0) {
    return (
      <p className="mt-2 ml-6 text-[11px] text-fg-faint">
        This drop-in tool declares no credentials or configuration.
      </p>
    );
  }

  async function saveSecrets() {
    setSavingSecrets(true);
    setSecretErr(null);
    try {
      const payload: Record<string, string> = {};
      for (const s of tool.secrets) {
        const v = secretValues[s.key];
        if (v === undefined) continue;
        if (v === SECRET_MASK) continue;
        payload[s.key] = v;
      }
      await api.extensions.saveToolSecrets(tool.name, payload);
      await onSaved();
    } catch (e) {
      setSecretErr(errorMessage(e));
    } finally {
      setSavingSecrets(false);
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    setConfigErr(null);
    try {
      const payload: Record<string, string> = {};
      for (const s of tool.config) {
        const v = configValues[s.key];
        if (v !== undefined) payload[s.key] = v;
      }
      await api.extensions.saveToolConfig(tool.name, payload);
      await onSaved();
    } catch (e) {
      setConfigErr(errorMessage(e));
    } finally {
      setSavingConfig(false);
    }
  }

  return (
    <div className="mt-2 ml-6 border-l border-border/60 pl-3 space-y-4">
      {tool.secrets.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-[11px] text-fg-faint">
            <KeyRound size={11} /> Credentials
          </div>
          {tool.secrets.map((s) => (
            <label key={s.key} className="block">
              <span className="text-xs text-fg-subtle">
                {s.label ?? s.key}
                {s.required && (
                  <span className="text-rose-600 dark:text-rose-400 ml-0.5">*</span>
                )}
              </span>
              {s.description && (
                <span className="block text-[11px] text-fg-faint">{s.description}</span>
              )}
              <input
                type="password"
                autoComplete="off"
                value={secretValues[s.key] ?? ""}
                onChange={(e) =>
                  setSecretValues((v) => ({ ...v, [s.key]: e.target.value }))
                }
                onFocus={(e) => {
                  if (e.currentTarget.value === SECRET_MASK) e.currentTarget.select();
                }}
                placeholder={s.is_set ? "" : "not configured"}
                className="mt-0.5 w-full px-2 py-1 text-sm bg-surface border border-border rounded font-mono"
              />
            </label>
          ))}
          {secretErr && (
            <p className="text-xs text-rose-700 dark:text-rose-400 flex items-center gap-1">
              <AlertCircle size={12} /> {secretErr}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void saveSecrets()}
              disabled={savingSecrets}
              className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {savingSecrets ? "Saving…" : "Save credentials"}
            </button>
            <span className="text-[11px] text-fg-faint">
              Leave a field empty to clear it. Stored encrypted at rest.
            </span>
          </div>
        </div>
      )}

      {tool.config.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-[11px] text-fg-faint">
            <Settings size={11} /> Configuration
          </div>
          {tool.config.map((s) => (
            <ToolSettingInput
              key={s.key}
              label={s.label ?? s.key}
              hint={s.description}
              required={s.required}
              type={s.type}
              value={configValues[s.key] ?? ""}
              onChange={(v) => setConfigValues((prev) => ({ ...prev, [s.key]: v }))}
              placeholder={s.default ?? "not configured"}
            />
          ))}
          {configErr && (
            <p className="text-xs text-rose-700 dark:text-rose-400 flex items-center gap-1">
              <AlertCircle size={12} /> {configErr}
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void saveConfig()}
              disabled={savingConfig}
              className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {savingConfig ? "Saving…" : "Save configuration"}
            </button>
            <span className="text-[11px] text-fg-faint">
              Leave a field empty to reset to default.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
