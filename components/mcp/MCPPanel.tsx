"use client";
import { AlertCircle, CheckCircle2, ChevronLeft, ExternalLink, Plug, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { McpRegistryEntry, McpServer } from "@/api/types";

// `editing` value when the user clicked New: starts on the picker step;
// once they pick a registry entry (or click "custom") it transitions to a form.
type EditState =
  | null
  | { mode: "picker" }
  | { mode: "form"; existing: McpServer | null; registryEntry?: McpRegistryEntry };

export function MCPPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditState>(null);

  async function load() {
    setLoading(true);
    try { setServers(await api.mcp.list()); } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function toggle(s: McpServer) {
    await api.mcp.update(s.name, { enabled: !s.enabled });
    void load();
  }

  async function remove(name: string) {
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    await api.mcp.delete(name);
    void load();
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Plug size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">MCP Servers</h2>
        <button
          onClick={() => setEditing({ mode: "picker" })}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2">
          {loading && servers.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
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
            <div key={s.name} className="flex items-center gap-3 py-2.5 border-b border-border/60 group">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <button
                    onClick={() => toggle(s)}
                    className={s.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-fg-faint hover:text-fg-subtle"}
                    title={s.enabled ? "Disable" : "Enable"}
                  >
                    {s.enabled ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
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
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button onClick={() => setEditing({ mode: "form", existing: s })} className="p-1 text-fg-subtle hover:text-fg transition-colors" title="Edit">
                  <span className="text-xs">edit</span>
                </button>
                <button onClick={() => remove(s.name)} className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors" title="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
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
          onClose={() => { setEditing(null); void load(); }}
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
  // If we came from the registry picker, pre-fill name + transport + spec.
  // The user fills in `${VAR}` values via the variables form below; we render
  // the spec with substitutions applied at save time.
  const [name, setName] = useState(server?.name ?? registryEntry?.id ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(server?.transport ?? registryEntry?.transport ?? "stdio");
  const [varValues, setVarValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of registryEntry?.variables ?? []) init[v.key] = v.default ?? "";
    return init;
  });

  const initialSpecJSON = useMemo(() => {
    if (server) return JSON.stringify(server.spec, null, 2);
    if (registryEntry) return JSON.stringify(registryEntry.spec, null, 2);
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
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // When transport switches, suggest a fresh spec template if user hasn't customized.
  function switchTransport(t: "stdio" | "http") {
    setTransport(t);
    const template = t === "stdio"
      ? { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
      : { url: "https://example.com/mcp", headers: {} };
    setSpecJSON(JSON.stringify(template, null, 2));
  }

  async function save() {
    setError(null);
    if (!name.trim()) { setError("name is required"); return; }
    let spec: Record<string, unknown>;
    try { spec = JSON.parse(specJSON); }
    catch (e) { setError(`spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); return; }
    // Apply registry variable substitutions if any are declared.
    if (registryEntry?.variables?.length) {
      const missing = registryEntry.variables.filter((v) => !varValues[v.key]?.trim());
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 bg-black/60 z-30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-2 border border-border rounded-xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center gap-1">
          {onBack && (
            <button onClick={onBack} className="p-1 text-fg-subtle hover:text-fg" title="Back to picker">
              <ChevronLeft size={14} />
            </button>
          )}
          <h3 className="text-sm font-semibold text-fg mr-auto">
            {server ? `Edit ${server.name}` : registryEntry ? `Install ${registryEntry.name}` : "New MCP server"}
          </h3>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {registryEntry && (
            <div className="px-3 py-2 rounded bg-surface-3/40 border border-border text-[11px] text-fg-subtle">
              {registryEntry.description}
              {registryEntry.url && (
                <a href={registryEntry.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-sky-700 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300">
                  docs <ExternalLink size={10} />
                </a>
              )}
            </div>
          )}

          {registryEntry?.variables?.length ? (
            <div className="space-y-2">
              <p className="text-xs text-fg-subtle font-medium">Configure</p>
              {registryEntry.variables.map((v) => (
                <label key={v.key} className="block text-xs text-fg-subtle">
                  {v.label}
                  <input
                    type={v.secret ? "password" : "text"}
                    value={varValues[v.key] ?? ""}
                    onChange={(e) => setVarValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                    placeholder={v.placeholder}
                    className="mt-1 w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg font-mono"
                  />
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

          <label className="block text-xs text-fg-subtle">
            Spec (JSON)
            <p className="mt-0.5 mb-1 text-[11px] text-fg-faint">
              {transport === "stdio"
                ? <>Keys: <code>command</code>, <code>args[]</code>, <code>env{}</code></>
                : <>Keys: <code>url</code>, <code>headers{}</code></>}
            </p>
            <textarea
              value={specJSON}
              onChange={(e) => setSpecJSON(e.target.value)}
              rows={8}
              className="w-full px-2 py-1.5 text-xs font-mono rounded border border-border bg-surface-3 text-fg"
            />
          </label>

          <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>

          {error && (
            <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
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

// Browse-and-install picker. Shows popular MCP servers grouped by category;
// user clicks one to jump into the form pre-filled with its template.
function RegistryPicker({
  existingNames, onPick, onCustom, onClose,
}: {
  existingNames: Set<string>;
  onPick: (entry: McpRegistryEntry) => void;
  onCustom: () => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.mcp.registry()
      .then(setEntries)
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  }, [entries, query]);

  const grouped = useMemo(() => {
    const m = new Map<string, McpRegistryEntry[]>();
    for (const e of filtered) {
      if (!m.has(e.category)) m.set(e.category, []);
      m.get(e.category)!.push(e);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

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

        <div className="px-4 py-2 border-b border-border">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search popular servers…"
            className="w-full px-2 py-1.5 text-sm rounded border border-border bg-surface-3 text-fg"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {loading && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}
          {!loading && grouped.length === 0 && (
            <p className="text-fg-faint text-sm py-6 text-center">No matches.</p>
          )}
          {grouped.map(([cat, items]) => (
            <div key={cat} className="mb-3">
              <p className="text-[10px] uppercase tracking-wider text-fg-faint mb-1.5 mt-1">{cat}</p>
              <div className="space-y-1">
                {items.map((e) => {
                  const installed = existingNames.has(e.id);
                  return (
                    <button
                      key={e.id}
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
            </div>
          ))}
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
