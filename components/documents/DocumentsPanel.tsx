"use client";
import { AlertCircle, Cloud, FolderOpen, FolderSearch, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { DocumentHit, DocumentSource, DocumentSourceKind, ModelConfig } from "@/api/types";
import { useAppContext } from "@/contexts/AppContext";
import { FolderPickerDialog } from "./FolderPickerDialog";

// Friendly labels + per-kind field hints. Kept inline (not a separate
// module) because this is the only consumer.
const KIND_OPTIONS: Array<{ value: DocumentSourceKind; label: string }> = [
  { value: "local_folder", label: "Local folder" },
  { value: "jira_project", label: "Jira project" },
  { value: "jira_jql", label: "Jira JQL" },
  { value: "confluence_space", label: "Confluence space" },
  { value: "confluence_cql", label: "Confluence CQL" },
  { value: "github_pulls", label: "GitHub pull requests" },
  { value: "github_repo", label: "GitHub repo files" },
  { value: "gmail_mail", label: "Gmail mail" },
  { value: "outlook_mail", label: "Outlook mail" },
];

function isGithubKind(k: DocumentSourceKind): boolean {
  return k === "github_pulls" || k === "github_repo";
}

function isMailKind(k: DocumentSourceKind): boolean {
  return k === "gmail_mail" || k === "outlook_mail";
}

function summarizeRemote(s: DocumentSource): string {
  const c = s.config ?? {};
  switch (s.kind) {
    case "jira_project":     return `Jira project: ${String(c.project_key ?? "?")}`;
    case "jira_jql":         return `Jira JQL: ${String(c.jql ?? "?")}`;
    case "confluence_space": return `Confluence space: ${String(c.space_key ?? "?")}`;
    case "confluence_cql":   return `Confluence CQL: ${String(c.cql ?? "?")}`;
    case "github_pulls": {
      const slug = `${String(c.owner ?? "?")}/${String(c.repo ?? "?")}`;
      return `GitHub PRs: ${slug}`;
    }
    case "github_repo": {
      const slug = `${String(c.owner ?? "?")}/${String(c.repo ?? "?")}`;
      const ref = c.ref ? `@${String(c.ref)}` : "";
      const prefix = c.path_prefix ? ` /${String(c.path_prefix).replace(/^\/+|\/+$/g, "")}` : "";
      return `GitHub repo: ${slug}${ref}${prefix}`;
    }
    case "gmail_mail":       return `Gmail: ${String(c.query ?? "?")}`;
    case "outlook_mail":     return `Outlook: ${String(c.query ?? "?")}`;
    default:                 return s.path;
  }
}

export function DocumentsPanel() {
  const { dispatch } = useAppContext();
  const [sources, setSources] = useState<DocumentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [embeddingModel, setEmbeddingModel] = useState<string>("__auto__");
  const [savingEmbeddingModel, setSavingEmbeddingModel] = useState(false);
  const [embeddingProbe, setEmbeddingProbe] = useState<{
    ok: boolean;
    provider: string;
    model_id: string;
    dimension?: number;
    error?: string;
  } | null>(null);

  // Add-form state. `addKind` drives which other inputs are required; the
  // remote-only fields share one record because no two are needed at once.
  const [addKind, setAddKind] = useState<DocumentSourceKind>("local_folder");
  const [addPath, setAddPath] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addProjectKey, setAddProjectKey] = useState("");
  const [addSpaceKey, setAddSpaceKey] = useState("");
  const [addQuery, setAddQuery] = useState("");      // JQL or CQL
  const [addMailQuery, setAddMailQuery] = useState("");
  const [addMailMaxResults, setAddMailMaxResults] = useState("");
  const [addMailPageSize, setAddMailPageSize] = useState("");
  const [addRecencyDays, setAddRecencyDays] = useState("");
  // GitHub-only fields
  const [addGhOwner, setAddGhOwner] = useState("");
  const [addGhRepo, setAddGhRepo] = useState("");
  const [addGhRef, setAddGhRef] = useState("");
  const [addGhPathPrefix, setAddGhPathPrefix] = useState("");
  const [addGhState, setAddGhState] = useState<"all" | "open" | "closed">("all");
  const [adding, setAdding] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Per-source busy state for reindex spinners.
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Quick search panel.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHit[]>([]);
  const [searching, setSearching] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const hasEnoughModelsForDocs = models.length >= 2;
  const hasWorkingEmbeddingModel = embeddingProbe?.ok ?? false;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sourceRows, modelRows, settings] = await Promise.all([
        api.documents.listSources(),
        api.models.list(),
        api.documents.getSettings(),
      ]);
      setSources(sourceRows);
      setModels(modelRows);
      setEmbeddingModel(settings.embedding_model_config ?? "__auto__");
      setEmbeddingProbe(settings.embedding_probe ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveEmbeddingModel(value: string) {
    const next = value === "__auto__" ? null : value;
    setEmbeddingModel(value);
    setSavingEmbeddingModel(true);
    setEmbeddingProbe(null);
    try {
      const updated = await api.documents.setSettings({ embedding_model_config: next });
      setEmbeddingModel(updated.embedding_model_config ?? "__auto__");
      setEmbeddingProbe(updated.embedding_probe ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEmbeddingModel(false);
    }
  }

  function buildPayload(): Parameters<typeof api.documents.createSource>[0] | null {
    const label = addLabel.trim();
    if (addKind === "local_folder") {
      const trimmedPath = addPath.trim();
      if (!trimmedPath) return null;
      return { path: trimmedPath, label: label || null };
    }
    // Remote — config keyed off kind. `recency_days` is optional;
    // include it only when the user provided a positive integer.
    const config: Record<string, unknown> = {};
    if (addKind === "jira_project") {
      const v = addProjectKey.trim();
      if (!v) return null;
      config.project_key = v;
    } else if (addKind === "confluence_space") {
      const v = addSpaceKey.trim();
      if (!v) return null;
      config.space_key = v;
    } else if (addKind === "jira_jql") {
      const v = addQuery.trim();
      if (!v) return null;
      config.jql = v;
    } else if (addKind === "confluence_cql") {
      const v = addQuery.trim();
      if (!v) return null;
      config.cql = v;
    } else if (addKind === "github_pulls") {
      const owner = addGhOwner.trim();
      const repo = addGhRepo.trim();
      if (!owner || !repo) return null;
      config.owner = owner;
      config.repo = repo;
      config.state = addGhState;
    } else if (addKind === "github_repo") {
      const owner = addGhOwner.trim();
      const repo = addGhRepo.trim();
      if (!owner || !repo) return null;
      config.owner = owner;
      config.repo = repo;
      const ref = addGhRef.trim();
      if (ref) config.ref = ref;
      const prefix = addGhPathPrefix.trim().replace(/^\/+|\/+$/g, "");
      if (prefix) config.path_prefix = prefix;
    } else if (isMailKind(addKind)) {
      const v = addMailQuery.trim();
      if (!v) return null;
      config.query = v;
      const maxResults = parseInt(addMailMaxResults, 10);
      if (Number.isFinite(maxResults) && maxResults > 0) config.max_results = maxResults;
      const pageSize = parseInt(addMailPageSize, 10);
      if (Number.isFinite(pageSize) && pageSize > 0) config.page_size = pageSize;
    }
    const recency = parseInt(addRecencyDays, 10);
    if (Number.isFinite(recency) && recency > 0) config.recency_days = recency;
    if (!label) return null; // remote sources require a label
    return { kind: addKind, label, config };
  }

  function resetAddForm() {
    setAddPath("");
    setAddLabel("");
    setAddProjectKey("");
    setAddSpaceKey("");
    setAddQuery("");
    setAddMailQuery("");
    setAddMailMaxResults("");
    setAddMailPageSize("");
    setAddRecencyDays("");
    setAddGhOwner("");
    setAddGhRepo("");
    setAddGhRef("");
    setAddGhPathPrefix("");
    setAddGhState("all");
  }

  async function addSource() {
    const payload = buildPayload();
    if (!payload) return;
    setAdding(true);
    setError(null);
    try {
      await api.documents.createSource(payload);
      resetAddForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function reindex(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const result = await api.documents.reindex(id);
      if ((result.stats.embed_failed ?? 0) > 0) {
        setError(
          `Embedding degraded: ${result.stats.embed_failed} chunk${result.stats.embed_failed === 1 ? "" : "s"} failed to embed` +
          (result.stats.embed_error ? ` (${result.stats.embed_error})` : ""),
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function removeSource(id: string, summary: string, kind: DocumentSourceKind) {
    const tail = kind === "local_folder"
      ? "Files on disk are untouched."
      : isMailKind(kind)
        ? "The upstream mailbox is untouched."
        : "The upstream content is untouched.";
    if (!confirm(`Stop indexing ${summary}? This deletes all chunks for this source. ${tail}`)) return;
    try {
      await api.documents.deleteSource(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleSource(s: DocumentSource) {
    try {
      await api.documents.updateSource(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    setSearching(true);
    try {
      const res = await api.documents.search(q, { limit: 8 });
      setHits(res.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <FolderSearch size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Documents</h2>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          title="Refresh source list"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        <p className="text-xs text-fg-faint leading-relaxed">
          Sources listed here are indexed in the background. Text files in folders are chunked, embedded, and
          made available to agents via the <code className="font-mono text-fg-muted">documents_search</code> tool.
          Remote sources reuse credentials configured in <em>Connections</em>: Jira/Confluence under
          {" "}<em>Atlassian</em>, GitHub PRs/repos under <em>GitHub</em>, and mail under <em>Gmail</em>/<em>Outlook</em>.
          Embedding uses your default model provider; without one, search falls back to substring match.
        </p>

        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Embedding model</label>
          {!hasEnoughModelsForDocs && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
              <p>
                Documents work best when you keep a dedicated model config for embeddings. Add another model in Models so search and recall do not depend on your main chat setup alone.
              </p>
              <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
                Compatible setup: a provider/model with embeddings support. If none is available, Documents falls back to substring search only.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "SET_TAB", tab: "models" })}
                  className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
                >
                  Open Models
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={embeddingModel}
              onChange={(e) => { void saveEmbeddingModel(e.target.value); }}
              disabled={savingEmbeddingModel}
              className="px-2 py-1.5 rounded-md bg-surface-2 border border-border text-xs text-fg disabled:opacity-60"
            >
              <option value="__auto__">Auto (best available)</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name} ({m.provider})</option>
              ))}
            </select>
            <span className="text-[11px] text-fg-faint">
              Used for document chunk embeddings. Rescan applies this to all eligible chunks.
            </span>
          </div>
          {savingEmbeddingModel && (
            <p className="text-[11px] text-fg-faint">Testing embedding model...</p>
          )}
          {!savingEmbeddingModel && embeddingProbe && (
            <p className={`text-[11px] ${embeddingProbe.ok ? "text-emerald-500" : "text-red-400"}`}>
              {embeddingProbe.ok
                ? `Usable: ${embeddingProbe.provider}/${embeddingProbe.model_id}` +
                  (embeddingProbe.dimension ? ` (${embeddingProbe.dimension} dims)` : "")
                : `Not usable: ${embeddingProbe.error ?? "embedding probe failed"}`}
            </p>
          )}
          {!savingEmbeddingModel && models.length > 0 && !hasWorkingEmbeddingModel && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
              <p>
                Current model setup does not appear ready for semantic document search yet. Add or switch to a model/provider with embeddings support in Models, then rescan your sources.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "SET_TAB", tab: "models" })}
                  className="rounded-md border border-amber-600/30 bg-white/50 px-2 py-1 text-[11px] font-medium text-amber-900 dark:bg-black/10 dark:text-amber-100"
                >
                  Fix in Models
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Add new source — kind picker drives the rest of the form. */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Add a source</label>
          <div className="flex items-center gap-2">
            <select
              value={addKind}
              onChange={(e) => { setAddKind(e.target.value as DocumentSourceKind); resetAddForm(); }}
              className="px-2 py-1.5 rounded-md bg-surface-2 border border-border text-xs text-fg"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="text-[11px] text-fg-faint">
              {addKind === "local_folder"
                ? "Pick a folder on this machine."
                : isMailKind(addKind)
                  ? addKind === "gmail_mail"
                    ? "Requires Gmail credentials (Connections → Gmail)."
                    : "Requires Outlook credentials (Connections → Outlook)."
                : isGithubKind(addKind)
                  ? "Requires GitHub credentials (Connections → GitHub)."
                  : "Requires Atlassian credentials (Connections → Atlassian)."}
            </span>
          </div>

          {addKind === "local_folder" && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex flex-1 min-w-0 gap-1">
                <input
                  type="text"
                  value={addPath}
                  onChange={(e) => setAddPath(e.target.value)}
                  placeholder="Pick or paste an absolute path"
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  title="Browse for a folder"
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-surface-3 border border-border text-xs text-fg hover:bg-surface-2 transition-colors"
                >
                  <FolderOpen size={13} /> Browse
                </button>
              </div>
              <input
                type="text"
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                placeholder="Label (optional)"
                className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
              />
              <button
                onClick={() => void addSource()}
                disabled={adding || !buildPayload()}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
              >
                <Plus size={13} /> Add
              </button>
            </div>
          )}

          {addKind !== "local_folder" && (
            <div className="space-y-2">
              {addKind === "jira_project" && (
                <input
                  type="text"
                  value={addProjectKey}
                  onChange={(e) => setAddProjectKey(e.target.value)}
                  placeholder='Project key (e.g. "ACME")'
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                />
              )}
              {addKind === "confluence_space" && (
                <input
                  type="text"
                  value={addSpaceKey}
                  onChange={(e) => setAddSpaceKey(e.target.value)}
                  placeholder='Space key (e.g. "ENG")'
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                />
              )}
              {(addKind === "jira_jql" || addKind === "confluence_cql") && (
                <textarea
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder={
                    addKind === "jira_jql"
                      ? 'JQL — e.g. assignee = currentUser() AND resolution = Unresolved'
                      : 'CQL — e.g. label = onboarding'
                  }
                  rows={2}
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono resize-y"
                />
              )}
              {isMailKind(addKind) && (
                <textarea
                  value={addMailQuery}
                  onChange={(e) => setAddMailQuery(e.target.value)}
                  placeholder={
                    addKind === "gmail_mail"
                      ? 'Gmail query — e.g. is:unread newer_than:7d'
                      : 'KQL — e.g. isRead:false received>=2026-05-01'
                  }
                  rows={2}
                  className="w-full px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono resize-y"
                />
              )}
              {isGithubKind(addKind) && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={addGhOwner}
                    onChange={(e) => setAddGhOwner(e.target.value)}
                    placeholder='Owner (e.g. "octocat")'
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                  />
                  <input
                    type="text"
                    value={addGhRepo}
                    onChange={(e) => setAddGhRepo(e.target.value)}
                    placeholder='Repo (e.g. "hello-world")'
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                  />
                </div>
              )}
              {addKind === "github_pulls" && (
                <select
                  value={addGhState}
                  onChange={(e) => setAddGhState(e.target.value as "all" | "open" | "closed")}
                  className="w-full sm:w-44 px-2 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
                  title="Which PRs to index"
                >
                  <option value="all">All PRs</option>
                  <option value="open">Open PRs only</option>
                  <option value="closed">Closed PRs only</option>
                </select>
              )}
              {addKind === "github_repo" && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={addGhRef}
                    onChange={(e) => setAddGhRef(e.target.value)}
                    placeholder="Ref (optional, default branch)"
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                  />
                  <input
                    type="text"
                    value={addGhPathPrefix}
                    onChange={(e) => setAddGhPathPrefix(e.target.value)}
                    placeholder="Path prefix (optional, e.g. docs)"
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
                  />
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="Label (required)"
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
                />
                {isMailKind(addKind) ? (
                  <>
                    <input
                      type="number"
                      min={1}
                      value={addMailMaxResults}
                      onChange={(e) => setAddMailMaxResults(e.target.value)}
                      placeholder="Max results (optional)"
                      className="sm:w-44 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
                    />
                    <input
                      type="number"
                      min={1}
                      value={addMailPageSize}
                      onChange={(e) => setAddMailPageSize(e.target.value)}
                      placeholder="Page size (optional)"
                      className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
                    />
                  </>
                ) : (
                  <input
                    type="number"
                    min={1}
                    value={addRecencyDays}
                    onChange={(e) => setAddRecencyDays(e.target.value)}
                    placeholder="Recency days (optional)"
                    className="sm:w-44 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
                  />
                )}
                <button
                  onClick={() => void addSource()}
                  disabled={adding || !buildPayload()}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            </div>
          )}
        </section>

        {pickerOpen && (
          <FolderPickerDialog
            initialPath={addPath.trim() || undefined}
            onClose={() => setPickerOpen(false)}
            onSelect={(picked) => {
              setAddPath(picked);
              setPickerOpen(false);
            }}
          />
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {/* Source list */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Indexed sources</label>
          {loading && sources.length === 0 && (
            <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>
          )}
          {!loading && sources.length === 0 && (
            <p className="text-fg-faint text-xs italic">
              No sources yet. Add one above to start indexing.
            </p>
          )}
          {sources.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                {s.kind === "local_folder"
                  ? <FolderOpen size={13} className="text-fg-subtle shrink-0" />
                  : <Cloud size={13} className="text-fg-subtle shrink-0" />}
                <span className="font-mono text-xs text-fg break-all flex-1">
                  {s.label ? <strong>{s.label}</strong> : null}
                  {s.label ? <span className="text-fg-faint"> — </span> : null}
                  {s.kind === "local_folder" ? s.path : summarizeRemote(s)}
                </span>
                <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => void toggleSource(s)}
                  />
                  enabled
                </label>
                <button
                  onClick={() => void reindex(s.id)}
                  disabled={busy[s.id]}
                  title="Re-scan now"
                  className="p-1 text-fg-subtle hover:text-fg disabled:opacity-40"
                >
                  <RefreshCw size={13} className={busy[s.id] ? "animate-spin" : ""} />
                </button>
                <button
                  onClick={() => void removeSource(s.id, s.kind === "local_folder" ? s.path : summarizeRemote(s), s.kind)}
                  title="Remove source"
                  className="p-1 text-fg-faint hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="text-[11px] text-fg-faint flex flex-wrap gap-x-3 gap-y-0.5">
                <span>{s.stats.document_count} files</span>
                <span>{s.stats.chunk_count} chunks</span>
                <span>{s.stats.embedded_chunk_count} embedded</span>
                {s.last_scan_at && <span>last scan: {new Date(s.last_scan_at).toLocaleString()}</span>}
              </div>
              {!s.last_error && s.stats.chunk_count > 0 && s.stats.embedded_chunk_count === 0 && (
                <div className="text-[11px] text-amber-700 dark:text-amber-400 break-words">
                  Warning: this source has chunks but zero embeddings. Semantic recall is degraded; check default model/provider embedding support.
                </div>
              )}
              {s.last_error && (
                <div className="text-[11px] text-red-600 dark:text-red-400 break-words">
                  Last error: {s.last_error}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* Search probe */}
        <section className="space-y-2">
          <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Try a search</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              placeholder="Ask something the docs would know…"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
            />
            <button
              onClick={() => void runSearch()}
              disabled={searching || !query.trim()}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
            >
              <Search size={13} /> Search
            </button>
          </div>
          {hits.length > 0 && (
            <div className="space-y-2">
              {hits.map((h) => (
                <div key={`${h.document_id}-${h.chunk_index}`} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-fg-muted truncate flex-1">
                      {h.source_label ? `${h.source_label} / ` : ""}{h.rel_path}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-fg-faint shrink-0">
                      {h.match} · {h.score.toFixed(2)}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-fg-muted text-[11px] leading-relaxed font-sans line-clamp-6">
                    {h.text}
                  </pre>
                </div>
              ))}
            </div>
          )}
          {!searching && query.trim() && hits.length === 0 && (
            <p className="text-fg-faint text-xs italic">No hits — try different terms or add more folders above.</p>
          )}
        </section>
      </div>
    </div>
  );
}
