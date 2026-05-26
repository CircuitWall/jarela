"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { BuiltinToolCategoryInfo } from "@/api/types";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.builtinTools
      .list()
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
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
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((b) => ({ ...b, [row.category]: false }));
    }
  }

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

      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/5 border border-red-500/30 rounded-md px-2 py-1.5">
          {error}
        </div>
      )}

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
    </div>
  );
}
