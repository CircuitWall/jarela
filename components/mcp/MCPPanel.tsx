"use client";
import { AlertCircle, CheckCircle2, ChevronLeft, ExternalLink, Eye, EyeOff, Loader2, Plug, Plus, Sparkles, Trash2, X } from "lucide-react";
import { HeaderAction, PanelHeader } from "@/components/ui/PanelHeader";
import { Dialog } from "@/components/ui/Dialog";
import { DialogError, DialogFooter } from "@/components/ui/DialogFooter";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { McpRegistryEntry, McpServer } from "@/api/types";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { useListState } from "@/hooks/useListState";
import { pushErrorToast } from "@/lib/ui/error-report";
import { pushToast } from "@/lib/ui/toasts";
import { errorMessage } from "@/lib/utils/error";
import { mergeMcpEnvironment, validateMcpEnvironment, type McpEnvironmentEntry } from "@/lib/mcp/environment";

import { PanelMessage } from "@/components/ui/PanelMessage";

import { confirmAction } from "@/lib/ui/confirm";

// `editing` value when the user clicked New: starts on the picker step;
// once they pick a registry entry (or click "custom") it transitions to a form.
type EditState =
  | null
  | { mode: "picker" }
  | { mode: "form"; existing: McpServer | null; registryEntry?: McpRegistryEntry };

interface EnvironmentDraft extends McpEnvironmentEntry {
  id: string;
}

function environmentDraftsFromSpec(specJSON: string): EnvironmentDraft[] {
  try {
    const parsed: unknown = JSON.parse(specJSON);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const env = (parsed as Record<string, unknown>).env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return [];
    return Object.entries(env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value], index) => ({ id: `existing-${index}`, name, value }));
  } catch {
    return [];
  }
}

export function MCPPanel() {
  const { items: servers, loading, refresh } = useListState<McpServer>({
    loader: () => api.mcp.list(),
  });
  const [editing, setEditing] = useState<EditState>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("mcp", "mcp", containerRef);

  async function toggle(s: McpServer) {
    try {
      await api.mcp.update(s.name, { enabled: !s.enabled });
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "MCP Servers",
        title: s.enabled ? "MCP server disabled" : "MCP server enabled",
        body: `"${s.name}"`,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
    } catch (e) {
      pushErrorToast({ title: "Couldn't toggle MCP server", error: e, context: { panel: "mcp", action: "toggle", name: s.name } });
    } finally {
      void refresh();
    }
  }

  async function remove(name: string) {
    if (!(await confirmAction({ message: `Remove MCP server "${name}"?`, destructive: true, confirmLabel: "Remove" }))) return;
    try {
      await api.mcp.delete(name);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "MCP Servers",
        title: "MCP server removed",
        body: `"${name}"`,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
    } catch (e) {
      pushErrorToast({ title: "Couldn't remove MCP server", error: e, context: { panel: "mcp", action: "delete", name } });
    } finally {
      void refresh();
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader icon={<Plug size={14} />} title="MCP servers">
        <HeaderAction icon={<Plus size={14} />} label="New" onClick={() => setEditing({ mode: "picker" })} />
      </PanelHeader>

      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar">
        <div className="px-4 py-2">
          {loading && servers.length === 0 && (
            <PanelMessage>Loading…</PanelMessage>
          )}
          {!loading && servers.length === 0 && (
            <div className="text-fg-faint text-sm py-8 text-center space-y-2">
              <p>No MCP servers configured.</p>
              <p className="text-xs text-fg-faint">
                MCP servers expose tools (filesystem, GitHub, Postgres, …) that the agent can call alongside built-ins.
              </p>
            </div>
          )}
          {servers.map((s) => (
            <McpServerRow
              key={s.name}
              server={s}
              onSelect={() => setEditing({ mode: "form", existing: s })}
              onToggle={toggle}
              onRemove={remove}
            />
          ))}
        </div>
      </div>

      {editing?.mode === "picker" && (
        <RegistryPicker
          existingNames={new Set(servers.map((s) => s.name))}
          onPick={(entry) => setEditing({ mode: "form", existing: null, registryEntry: entry })}
          onCustom={() => setEditing({ mode: "form", existing: null })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.mode === "form" && (
        <MCPEditor
          server={editing.existing}
          registryEntry={editing.registryEntry}
          onBack={editing.existing ? undefined : () => setEditing({ mode: "picker" })}
          onClose={() => { setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function MCPEditor({
  server, registryEntry, onClose, onBack,
}: {
  server: McpServer | null;
  registryEntry?: McpRegistryEntry;
  onClose: () => void;
  onBack?: () => void;
}) {
  const [activeRegistryEntry, setActiveRegistryEntry] = useState(registryEntry);
  const [manifestJSON, setManifestJSON] = useState("");
  const [manifestImported, setManifestImported] = useState(false);
  const [importing, setImporting] = useState(false);
  // If we came from the registry picker, pre-fill name + transport + spec.
  // The user fills in `${VAR}` values via the variables form below; we render
  // the spec with substitutions applied at save time.
  const [name, setName] = useState(server?.name ?? activeRegistryEntry?.id ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(server?.transport ?? activeRegistryEntry?.transport ?? "stdio");
  const [varValues, setVarValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of activeRegistryEntry?.variables ?? []) init[v.key] = v.default ?? "";
    return init;
  });

  const initialSpecJSON = useMemo(() => {
    if (server) return JSON.stringify(server.spec, null, 2);
    if (activeRegistryEntry) return JSON.stringify(activeRegistryEntry.spec, null, 2);
    return JSON.stringify(
      transport === "stdio"
        ? { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
        : { url: "https://example.com/mcp", headers: {} },
      null, 2,
    );
  // initialSpecJSON should only compute once per editor instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [specJSON, setSpecJSON] = useState(initialSpecJSON);
  const [environmentDrafts, setEnvironmentDrafts] = useState<EnvironmentDraft[]>(() => environmentDraftsFromSpec(initialSpecJSON));
  const [environmentEdited, setEnvironmentEdited] = useState(false);
  const nextEnvironmentId = useRef(0);
  const [revealedEnvironmentValues, setRevealedEnvironmentValues] = useState<Set<string>>(() => new Set());
  const [showAdvancedSpec, setShowAdvancedSpec] = useState(transport === "http");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const environmentError = transport === "stdio" ? validateMcpEnvironment(environmentDrafts) : null;

  function updateEnvironmentDrafts(next: EnvironmentDraft[]) {
    setEnvironmentDrafts(next);
    setEnvironmentEdited(true);
    if (validateMcpEnvironment(next)) return;
    try {
      const spec: unknown = JSON.parse(specJSON);
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
      setSpecJSON(JSON.stringify(mergeMcpEnvironment(spec as Record<string, unknown>, next), null, 2));
    } catch {
      // Save reports invalid JSON from the advanced editor.
    }
  }

  // When transport switches, suggest a fresh spec template if user hasn't customized.
  function switchTransport(t: "stdio" | "http") {
    setTransport(t);
    const template = t === "stdio"
      ? { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
      : { url: "https://example.com/mcp", headers: {} };
    const nextSpec = JSON.stringify(template, null, 2);
    setSpecJSON(nextSpec);
    setEnvironmentDrafts(environmentDraftsFromSpec(nextSpec));
    setEnvironmentEdited(false);
    setShowAdvancedSpec(t === "http");
    setRevealedEnvironmentValues(new Set());
  }

  async function save() {
    setError(null);
    if (!name.trim()) { setError("name is required"); return; }
    let spec: Record<string, unknown>;
    try { spec = JSON.parse(specJSON); }
    catch (e) { setError(`spec is not valid JSON: ${errorMessage(e)}`); return; }
    if (transport === "stdio" && environmentEdited) {
      if (environmentError) { setError(environmentError); return; }
      spec = mergeMcpEnvironment(spec, environmentDrafts);
    }
    // Apply registry variable substitutions if any are declared.
    if (activeRegistryEntry?.variables?.length) {
      const missing = activeRegistryEntry.variables.filter((v) => v.required && !varValues[v.key]?.trim());
      if (missing.length > 0) {
        setError(`Fill in: ${missing.map((m) => m.label).join(", ")}`);
        return;
      }
      spec = substituteVars(spec, varValues);
    }
    setSaving(true);
    try {
      if (server) {
        await api.mcp.update(server.name, { transport, spec, enabled });
      } else {
        await api.mcp.create({ name: name.trim(), transport, spec, enabled });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function importManifest() {
    setError(null);
    if (!manifestJSON.trim()) { setError("Paste a server.json manifest first."); return; }
    setImporting(true);
    try {
      const { entry } = await api.mcp.importManifest(manifestJSON);
      setActiveRegistryEntry(entry);
      setManifestImported(true);
      setName(entry.id);
      setTransport(entry.transport);
      setEnabled(false);
      setVarValues(Object.fromEntries((entry.variables ?? []).map((variable) => [variable.key, variable.default ?? ""])));
      const nextSpec = JSON.stringify(entry.spec, null, 2);
      setSpecJSON(nextSpec);
      setEnvironmentDrafts(environmentDraftsFromSpec(nextSpec));
      setEnvironmentEdited(false);
      setShowAdvancedSpec(entry.transport === "http");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  const dirty = useDirty({ name, transport, specJSON, environmentDrafts, enabled, varValues });
  const requestClose = useDismissGuard({ dirty, busy: saving, onClose });

  return (
    <Dialog
      open
      onClose={requestClose}
      title={server ? `Edit ${server.name}` : activeRegistryEntry ? `Install ${activeRegistryEntry.name}` : "New MCP server"}
      titlePrefix={onBack ? (
        <button onClick={onBack} className="p-1 text-fg-subtle hover:text-fg" title="Back to picker">
          <ChevronLeft size={14} />
        </button>
      ) : undefined}
      size="md"
      align="top"
      footer={<DialogFooter onCancel={requestClose} onDiscard={onClose} dirty={dirty} canSave={!server || dirty} onSave={() => void save()} saving={saving} />}
    >
      <div className="space-y-3">
          {!server && !activeRegistryEntry && (
            <div className="space-y-2">
              <label className="block text-xs text-fg-subtle">
                Paste an MCP Registry <code>server.json</code>
                <textarea
                  value={manifestJSON}
                  onChange={(event) => setManifestJSON(event.target.value)}
                  rows={5}
                  placeholder={'{\n  "name": "io.example/server",\n  "version": "1.0.0",\n  "packages": [...]\n}'}
                  className="mt-1 w-full px-2 py-1.5 text-xs font-mono rounded border border-border bg-surface-3 text-fg"
                />
              </label>
              <button
                type="button"
                onClick={() => void importManifest()}
                disabled={importing || !manifestJSON.trim()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border text-fg-muted hover:bg-surface-3 disabled:opacity-50"
              >
                {importing ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Import server.json
              </button>
            </div>
          )}
          {activeRegistryEntry && (
            <div className="px-3 py-2 rounded bg-surface-3/40 border border-border text-[11px] text-fg-subtle">
              {activeRegistryEntry.description}
              {activeRegistryEntry.url && (
                <a href={activeRegistryEntry.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-sky-700 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300">
                  docs <ExternalLink size={10} />
                </a>
              )}
            </div>
          )}

          {manifestImported && (
            <p role="note" className="text-xs text-amber-800 dark:text-amber-300">
              Imported servers start disabled. Review the command or remote URL before enabling; enabling may run third-party code or connect to an external server.
            </p>
          )}

          {activeRegistryEntry?.variables?.length ? (
            <div className="space-y-2">
              <p className="text-xs text-fg-subtle font-medium">Configure</p>
              {activeRegistryEntry.variables.map((v) => (
                <label key={v.key} className="block text-xs text-fg-subtle">
                  {v.label}
                  {v.choices?.length || v.format === "boolean" ? (
                    <select
                      value={varValues[v.key] ?? ""}
                      onChange={(e) => setVarValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg"
                    >
                      <option value="" disabled={v.required}>{v.required ? "Select a value" : "Optional"}</option>
                      {(v.choices ?? ["true", "false"]).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                    </select>
                  ) : (
                    <input
                      type={v.secret ? "password" : v.format === "number" ? "number" : "text"}
                      value={varValues[v.key] ?? ""}
                      onChange={(e) => setVarValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                      placeholder={v.placeholder}
                      required={v.required}
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                    />
                  )}
                </label>
              ))}
            </div>
          ) : null}

          <label className="block text-xs text-fg-subtle">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!server}
              className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg disabled:opacity-50"
              placeholder="filesystem"
            />
          </label>

          <div>
            <p className="text-xs text-fg-subtle mb-1">Transport</p>
            <div className="flex gap-1">
              {(["stdio", "http"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => switchTransport(t)}
                  className={`px-3 py-1 text-xs rounded border ${
                    transport === t
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-surface-3 border-border text-fg-subtle hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {transport === "stdio" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-fg-subtle font-medium">Environment variables</p>
                <button
                  type="button"
                  onClick={() => {
                    updateEnvironmentDrafts([...environmentDrafts, {
                      id: `new-${nextEnvironmentId.current++}`,
                      name: "",
                      value: "",
                    }]);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:bg-surface-3"
                >
                  <Plus size={11} /> Add variable
                </button>
              </div>
              {environmentDrafts.map((entry) => (
                <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] gap-1.5 items-center">
                  <input
                    value={entry.name}
                    onChange={(event) => {
                      updateEnvironmentDrafts(environmentDrafts.map((row) => row.id === entry.id ? { ...row, name: event.target.value } : row));
                    }}
                    aria-label="Environment variable name"
                    placeholder="VARIABLE_NAME"
                    className="min-w-0 px-2 py-1.5 text-xs font-mono rounded border border-border bg-surface-3 text-fg"
                  />
                  <input
                    type={revealedEnvironmentValues.has(entry.id) ? "text" : "password"}
                    value={entry.value}
                    onChange={(event) => {
                      updateEnvironmentDrafts(environmentDrafts.map((row) => row.id === entry.id ? { ...row, value: event.target.value } : row));
                    }}
                    aria-label={`${entry.name || "Environment variable"} value`}
                    placeholder="Value"
                    className="min-w-0 px-2 py-1.5 text-xs font-mono rounded border border-border bg-surface-3 text-fg"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealedEnvironmentValues((current) => {
                      const next = new Set(current);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })}
                    aria-label={`${revealedEnvironmentValues.has(entry.id) ? "Hide" : "Show"} ${entry.name || "environment variable"} value`}
                    title={revealedEnvironmentValues.has(entry.id) ? "Hide value" : "Show value"}
                    className="p-1.5 rounded border border-border text-fg-faint hover:bg-surface-3 hover:text-fg"
                  >
                    {revealedEnvironmentValues.has(entry.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      updateEnvironmentDrafts(environmentDrafts.filter((row) => row.id !== entry.id));
                    }}
                    aria-label={`Remove ${entry.name || "environment variable"}`}
                    title="Remove variable"
                    className="p-1.5 rounded border border-border text-fg-faint hover:bg-surface-3 hover:text-fg"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {environmentError && <p role="alert" className="text-[11px] text-rose-700 dark:text-rose-300">{environmentError}</p>}
            </div>
          )}

          <div>
            <button
              type="button"
              aria-expanded={showAdvancedSpec}
              onClick={() => setShowAdvancedSpec((shown) => !shown)}
              className="inline-flex items-center gap-2 text-xs text-fg-subtle hover:text-fg"
            >
              <span>Advanced spec (JSON)</span>
              <span className="text-[11px] text-fg-faint">{showAdvancedSpec ? "Hide" : "Show"}</span>
            </button>
            {showAdvancedSpec && (
              <label className="block mt-1 text-xs text-fg-subtle">
                <p className="mb-1 text-[11px] text-fg-faint">
                  {transport === "stdio"
                    ? <>Keys: <code>command</code>, <code>args[]</code>, <code>env{}</code>. Environment rows sync with <code>env</code>; values appear here in plain text.</>
                    : <>Keys: <code>url</code>, <code>headers{}</code>.</>}
                </p>
                <textarea
                  value={specJSON}
                  onChange={(e) => {
                    setSpecJSON(e.target.value);
                    setEnvironmentDrafts(environmentDraftsFromSpec(e.target.value));
                    setEnvironmentEdited(false);
                    setRevealedEnvironmentValues(new Set());
                  }}
                  rows={8}
                  className="w-full px-2 py-1.5 text-xs font-mono rounded border border-border bg-surface-3 text-fg"
                />
              </label>
            )}
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>

          <DialogError message={error} />
      </div>
    </Dialog>
  );
}

// Recursively substitutes ${VAR} placeholders in spec strings using user input.
function substituteVars(node: unknown, values: Record<string, string>): Record<string, unknown> {
  return walk(node) as Record<string, unknown>;
  function walk(n: unknown): unknown {
    if (typeof n === "string") return n.replace(/\$\{(\w+)\}/g, (_, k) => values[k] ?? `\${${k}}`);
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return n;
  }
}

function McpServerRow({
  server: s,
  onSelect,
  onToggle,
  onRemove,
}: {
  server: McpServer;
  onSelect: () => void;
  onToggle: (s: McpServer) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      data-deep-link-id={s.name}
      onClick={onSelect}
      className="flex items-center gap-3 py-2.5 border-b border-border/60 group cursor-pointer hover:bg-surface-3/30 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (toggling) return;
              setToggling(true);
              try {
                await onToggle(s);
              } finally {
                setToggling(false);
              }
            }}
            disabled={toggling}
            className={s.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-fg-faint hover:text-fg-subtle"}
            title={toggling ? "Saving…" : s.enabled ? "Disable" : "Enable"}
          >
            {toggling ? <Loader2 size={13} className="animate-spin text-fg-faint" /> : s.enabled ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          </button>
          <span className="text-sm font-medium text-fg">{s.name}</span>
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border bg-surface-2 text-fg-subtle border-border">
            {s.transport}
          </span>
        </div>
        <p className="text-xs text-fg-faint truncate font-mono">
          {s.transport === "stdio"
            ? `${(s.spec as { command?: string }).command ?? "?"} ${((s.spec as { args?: string[] }).args ?? []).join(" ")}`
            : `${(s.spec as { url?: string }).url ?? "?"}`}
        </p>
        {s.last_error && (
          <p className="text-xs text-rose-700 dark:text-rose-400 mt-0.5 truncate" title={s.last_error}>
            error: {s.last_error}
          </p>
        )}
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (deleting) return;
            setDeleting(true);
            try {
              await onRemove(s.name);
            } finally {
              setDeleting(false);
            }
          }}
          disabled={deleting}
          className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-50"
          title={deleting ? "Deleting…" : "Delete"}
        >
          {deleting ? <Loader2 size={13} className="animate-spin text-red-600 dark:text-red-400" /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  );
}

// Browse-and-install picker backed by the official MCP registry. Search
// queries hit registry.modelcontextprotocol.io via /api/v1/mcp-servers/registry;
// results are paginated with a cursor.
function RegistryPicker({
  existingNames, onPick, onCustom, onClose,
}: {
  existingNames: Set<string>;
  onPick: (entry: McpRegistryEntry) => void;
  onCustom: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to the hand-picked allowlist of well-known vendor servers;
  // toggle off to see the broader Official + Vendor list from the upstream
  // registry. Hidden behind a small switch so the curated default is the
  // obvious, recommended path.
  const [curatedOnly, setCuratedOnly] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const runSearch = useCallback(async (q: string, fresh = false) => {
    setLoading(true); setError(null);
    try {
      const res = await api.mcp.registry({ q: q || undefined, fresh, curated: curatedOnly });
      setEntries(res.entries);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setEntries([]); setNextCursor(undefined);
      // Inline error preserves the Retry button at the picker; the toast
      // gives the user a one-click path to report the failure.
      setError(errorMessage(e));
      pushErrorToast({
        title: "Couldn't search MCP registry",
        error: e,
        context: { panel: "mcp", action: "registry.search", query: q || null },
      });
    } finally {
      setLoading(false);
    }
  }, [curatedOnly]);

  useEffect(() => { void runSearch(debouncedQuery); }, [debouncedQuery, runSearch]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.mcp.registry({ q: debouncedQuery || undefined, cursor: nextCursor, curated: curatedOnly });
      setEntries((prev) => [...prev, ...res.entries]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
      pushErrorToast({
        title: "Couldn't load more registry entries",
        error: e,
        context: { panel: "mcp", action: "registry.loadMore", cursor: nextCursor ?? null },
      });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="absolute inset-0 bg-black/60 z-30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface-2 border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Sparkles size={14} className="text-amber-700 dark:text-amber-400" />
          <h3 className="text-sm font-semibold text-fg mr-auto">Add MCP server</h3>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border space-y-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the MCP registry…"
            className="w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg"
            autoFocus
          />
          <label className="flex items-center gap-2 text-[11px] text-fg-subtle cursor-pointer select-none">
            <input
              type="checkbox"
              checked={curatedOnly}
              onChange={(e) => setCuratedOnly(e.target.checked)}
              className="accent-emerald-600"
            />
            <span>
              Curated only{" "}
              <span className="text-fg-faint">
                (vetted vendor servers; uncheck to browse all Official + Vendor entries)
              </span>
            </span>
          </label>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-2">
          {loading && entries.length === 0 && <PanelMessage>Loading…</PanelMessage>}
          {error && (
            <div className="my-3 px-3 py-2 rounded border border-rose-800 bg-rose-950/40 text-xs text-rose-700 dark:text-rose-300">
              <p className="mb-1">Couldn’t reach registry.modelcontextprotocol.io.</p>
              <button
                onClick={() => void runSearch(debouncedQuery, true)}
                className="underline hover:text-rose-200"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <PanelMessage>No matches.</PanelMessage>
          )}
          <div className="space-y-1">
            {entries.map((e) => {
              const installed = existingNames.has(e.id);
              return (
                <button
                  key={`${e.id}-${e.name}`}
                  onClick={() => onPick(e)}
                  disabled={installed}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors group ${
                    installed
                      ? "bg-surface-3/30 border-border/40 cursor-not-allowed"
                      : "bg-surface-3/60 hover:bg-surface-3 border-border hover:border-border"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-sm font-medium ${installed ? "text-fg-faint" : "text-fg"}`}>{e.name}</span>
                    <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded border border-border text-fg-faint">
                      {e.transport}
                    </span>
                    <span className={`text-[9px] uppercase tracking-wider px-1 py-px rounded border ${
                      e.source === "Official"
                        ? "border-emerald-700/60 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                        : e.source === "Vendor"
                          ? "border-sky-700/60 text-sky-600 dark:text-sky-400 bg-sky-500/10"
                          : "border-border text-fg-faint"
                    }`}>
                      {e.source}
                    </span>
                    {installed && (
                      <span className="text-[10px] text-emerald-500 ml-auto">installed</span>
                    )}
                  </div>
                  <p className={`text-xs ${installed ? "text-fg-faint" : "text-fg-subtle"}`}>{e.description}</p>
                </button>
              );
            })}
          </div>
          {nextCursor && !error && (
            <div className="text-center my-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="text-xs text-fg-subtle hover:text-fg disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <button
            onClick={onCustom}
            className="text-xs text-fg-subtle hover:text-fg"
          >
            …or set up a custom server
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
