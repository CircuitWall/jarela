"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { BuiltinToolCategoryInfo, ToolInfo } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";

// Built-in tool category toggles. Each row is one category from the tool
// registry; turning it off filters its tools out of the agent permission
// editor AND blocks them from being invoked at runtime (defense in depth
// in lib/tools/index.ts).
//
// Categories with no registered tools simply don't appear — the API
// derives the list from `registeredTools()` so this UI auto-updates
// whenever a new built-in lands.

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
  Mail: "Read and send email via Gmail / Outlook.",
  Calendar: "Read and write calendar events.",
  Config: "Read/write Jarela's own settings.",
};

export function BuiltinToolsPanel() {
  const [rows, setRows] = useState<BuiltinToolCategoryInfo[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "builtin" | "mcp">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "new" | "healthy" | "attention">("all");

  useEffect(() => {
    Promise.all([api.builtinTools.list(), api.tools.list()])
      .then(([categoryRows, toolRows]) => {
        setRows(categoryRows);
        setTools(toolRows);
      })
      .catch((e: unknown) => {
        pushErrorToast({
          title: "Couldn't load tool catalog",
          error: e,
          context: { panel: "tools", action: "list" },
        });
      })
      .finally(() => setLoading(false));
  }, []);

  async function toggle(row: BuiltinToolCategoryInfo) {
    const next = !row.enabled;
    setBusy((b) => ({ ...b, [row.category]: true }));
    try {
      await api.builtinTools.setEnabled(row.category, next);
      setRows((prev) =>
        prev.map((r) => (r.category === row.category ? { ...r, enabled: next } : r)),
      );
      setTools(await api.tools.list());
    } catch (e) {
      pushErrorToast({
        title: "Couldn't toggle built-in tool",
        error: e,
        context: { panel: "tools", action: "toggle", category: row.category, target_enabled: next },
      });
    } finally {
      setBusy((b) => ({ ...b, [row.category]: false }));
    }
  }

  const filteredTools = tools.filter((tool) => {
    const q = query.trim().toLowerCase();
    if (q) {
      const haystack = `${tool.name} ${tool.category ?? ""} ${tool.description ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (sourceFilter !== "all" && tool.source !== sourceFilter) return false;
    const stats = tool.stats;
    if (statusFilter === "new" && !stats?.never_used) return false;
    if (statusFilter === "healthy" && (stats?.never_used || (stats?.score ?? 0) < 0.75)) return false;
    if (statusFilter === "attention" && (stats?.never_used || (stats?.score ?? 0) >= 0.75)) return false;
    return true;
  });

  const issueHref = buildIssueHref(query);

  return (
    <div className="p-4 space-y-3">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-fg">Built-in tools</h2>
        <p className="text-xs text-fg-faint">
          Turn whole categories of built-in tools on or off. Disabled categories
          disappear from the agent permission editor and cannot be invoked even
          if an older agent still has them in its allow-list.
        </p>
      </header>

      {loading && <p className="text-fg-faint text-sm py-3 text-center">Loading…</p>}

      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.category}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2.5"
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-fg">{r.category}</span>
                  <span className="text-[11px] text-fg-faint">
                    {r.toolCount} tool{r.toolCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-xs text-fg-muted mt-0.5">
                  {CATEGORY_BLURB[r.category] ?? ""}
                </p>
                <details className="mt-1.5">
                  <summary className="text-[11px] text-fg-faint cursor-pointer select-none hover:text-fg-muted">
                    Tools
                  </summary>
                  <ul className="mt-1 ml-2 flex flex-wrap gap-1">
                    {r.toolNames.map((n) => (
                      <li
                        key={n}
                        className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-fg-muted"
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none shrink-0 pt-0.5">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  disabled={busy[r.category]}
                  onChange={() => void toggle(r)}
                />
                enabled
              </label>
            </div>
          </li>
        ))}
      </ul>

      <section className="pt-3 border-t border-border space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-fg">Ranked tool catalog</h3>
            <p className="text-xs text-fg-faint">
              Success rate tracks completed calls without errors. Usefulness tracks results whose content appears in the final assistant answer.
            </p>
          </div>
          <a
            href={issueHref}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-surface-2"
          >
            Report issue
          </a>
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_140px_140px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, category, or description"
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
          />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
          >
            <option value="all">All sources</option>
            <option value="builtin">Built-in + RAG</option>
            <option value="mcp">MCP</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-fg-faint"
          >
            <option value="all">All health states</option>
            <option value="new">New: 100%</option>
            <option value="healthy">Healthy</option>
            <option value="attention">Needs attention</option>
          </select>
        </div>

        <div className="space-y-2">
          {filteredTools.length === 0 && (
            <p className="rounded-lg border border-border bg-surface-2 px-3 py-4 text-sm text-fg-faint text-center">
              No tools match the current filters.
            </p>
          )}
          {filteredTools.map((tool) => {
            const stats = tool.stats;
            const score = Math.round((stats?.score ?? 1) * 100);
            const success = Math.round((stats?.success_rate ?? 1) * 100);
            const usefulness = Math.round((stats?.usefulness_rate ?? 1) * 100);
            return (
              <article
                key={tool.name}
                className="rounded-lg border border-border bg-surface-2 px-3 py-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-fg">{tool.name}</span>
                      <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-fg-faint border border-border">
                        {tool.category ?? "Other"}
                      </span>
                      <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-fg-faint border border-border uppercase">
                        {tool.source ?? "builtin"}
                      </span>
                      {stats?.never_used && (
                        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                          new 100%
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-fg-muted">{tool.description}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-right min-w-[120px]">
                    <div className={`text-lg font-semibold ${score >= 75 ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                      {score}%
                    </div>
                    <div className="text-[11px] text-fg-faint">rank score</div>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <Metric label="Calls" value={String(stats?.call_count ?? 0)} />
                  <Metric label="Success" value={`${success}%`} />
                  <Metric label="Used" value={`${usefulness}%`} />
                  <Metric label="Errors" value={String(stats?.error_count ?? 0)} />
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-2.5 py-2">
      <div className="text-[11px] text-fg-faint uppercase tracking-wide">{label}</div>
      <div className="text-sm text-fg font-medium">{value}</div>
    </div>
  );
}

function buildIssueHref(query: string): string {
  const url = new URL("https://github.com/CircuitWall/jarela/issues/new");
  url.searchParams.set("title", query.trim() ? `tool issue: ${query.trim()}` : "tool issue: describe the failing tool");
  url.searchParams.set(
    "body",
    [
      "## What happened",
      "",
      "Describe the tool, MCP server, or documents/RAG issue.",
      "",
      "## Tool name / filter",
      query.trim() || "(fill in)",
      "",
      "## Expected result",
      "",
      "## Actual result",
      "",
      "## Additional context",
      "",
    ].join("\n"),
  );
  return url.toString();
}
