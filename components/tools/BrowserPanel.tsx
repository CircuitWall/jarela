"use client";
import { AlertCircle, CheckCircle2, ExternalLink, Globe2, Loader2, MousePointer2, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { BrowserCommandLogEntry, BrowserExtensionStatus, BrowserTabInfo, BrowserTabsResponse } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { pushToast } from "@/lib/ui/toasts";

function formatLastSeen(status: BrowserExtensionStatus | null): string {
  if (!status) return "unknown";
  if (status.lastSeenMs < 0) return "never";
  if (status.lastSeenMs < 1000) return "just now";
  const seconds = Math.round(status.lastSeenMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function tabTitle(tab: BrowserTabInfo): string {
  return tab.title || tab.host || tab.url || `Tab ${tab.tab_id}`;
}

function tabSubtitle(tab: BrowserTabInfo): string {
  if (tab.host) return tab.host;
  if (tab.url) return tab.url;
  return tab.unusable_reason ?? "metadata unavailable";
}

function BrowserStatusPill({ status }: { status: BrowserExtensionStatus | null }) {
  const connected = status?.connected === true;
  const cfg = connected
    ? { label: "connected", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", icon: <CheckCircle2 size={9} /> }
    : { label: "offline", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30", icon: <AlertCircle size={9} /> };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wide font-semibold ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function TabBadge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "success" | "warn" }) {
  const cls = {
    muted: "bg-fg-faint/10 text-fg-subtle border-fg-faint/20",
    accent: "bg-accent/15 text-accent border-accent/30",
    success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  }[tone];
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wide ${cls}`}>{children}</span>;
}

function statusTone(status: BrowserCommandLogEntry["status"]): "muted" | "accent" | "success" | "warn" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "warn";
  if (status === "running") return "accent";
  return "muted";
}

function humanPhase(phase: string | null): string | null {
  if (!phase) return null;
  return phase.replace(/_/g, " ");
}

export function BrowserPanel() {
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);
  const [tabs, setTabs] = useState<BrowserTabsResponse | null>(null);
  const [history, setHistory] = useState<BrowserCommandLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activating, setActivating] = useState<number | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const nextStatus = await api.browser.status();
      setStatus(nextStatus);
      if (nextStatus.connected) {
        setTabs(await api.browser.tabs({ includeUnusable: true }));
      } else {
        setTabs(null);
      }
      const nextHistory = await api.browser.history({ limit: 12 });
      setHistory(nextHistory.commands);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setTabs(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  async function activate(tab: BrowserTabInfo) {
    setActivating(tab.tab_id);
    setError(null);
    try {
      await api.browser.activateTab(tab.tab_id);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Browser",
        title: "Focused tab",
        body: tabTitle(tab),
        agent_id: null,
        thread_id: null,
        ttl: 2500,
      });
      await load(true);
    } catch (err) {
      pushErrorToast({ title: "Couldn't focus browser tab", error: err, context: { panel: "browser", tab_id: tab.tab_id } });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(null);
    }
  }

  async function retry(command: BrowserCommandLogEntry) {
    setRetrying(command.cmd_id);
    setError(null);
    try {
      await api.browser.retry(command.cmd_id);
      pushToast({
        kind: "info",
        source: "system",
        sourceLabel: "Browser",
        title: "Retried browser command",
        body: command.summary,
        agent_id: null,
        thread_id: null,
        ttl: 3000,
      });
      await load(true);
    } catch (err) {
      pushErrorToast({ title: "Couldn't retry browser command", error: err, context: { panel: "browser", cmd_id: command.cmd_id } });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(null);
    }
  }

  const tabRows = tabs?.tabs ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Globe2 size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Browser</h2>
        <BrowserStatusPill status={status} />
        <button
          onClick={() => void load(true)}
          disabled={refreshing}
          className="p-1.5 rounded text-fg-faint hover:text-fg hover:bg-surface-3 disabled:opacity-50"
          title="Refresh browser status"
        >
          {refreshing ? <Loader2 size={13} className="animate-spin text-accent" /> : <RefreshCw size={13} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-3">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-faint">Last seen</div>
              <div className="mt-1 font-medium text-fg">{formatLastSeen(status)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-faint">Pending</div>
              <div className="mt-1 font-medium text-fg">{status?.pendingCommands ?? 0}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-faint">Tabs</div>
              <div className="mt-1 font-medium text-fg">{tabs?.total ?? 0}</div>
            </div>
          </div>
          {!status?.connected && (
            <div className="mt-3 px-2 py-1.5 rounded bg-amber-950/30 border border-amber-800 text-[11px] text-amber-700 dark:text-amber-300 inline-flex items-start gap-1.5">
              <ShieldAlert size={12} className="mt-0.5 shrink-0" />
              <span>Open Chromium and click the Jarela toolbar icon to wake the extension.</span>
            </div>
          )}
        </div>

        {error && (
          <div className="px-2 py-1.5 rounded bg-rose-950/40 border border-rose-800 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {loading && <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>}

        {!loading && status?.connected && tabRows.length === 0 && (
          <p className="text-fg-faint text-sm py-6 text-center">No tabs are visible to the extension.</p>
        )}

        {tabRows.map((tab) => (
          <div
            key={`${tab.window_id}:${tab.tab_id}`}
            className={`rounded-lg border p-3 transition-colors ${tab.foreground || (tab.active && tab.focused_window) ? "border-accent/35 bg-accent/5" : "border-border bg-surface-2"} ${tab.usable ? "" : "opacity-70"}`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-cyan-600 flex items-center justify-center shrink-0 text-white">
                <ExternalLink size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg truncate">{tabTitle(tab)}</span>
                </div>
                <p className="text-[11px] text-fg-faint truncate mt-0.5" title={tab.url || tab.unusable_reason}>
                  {tabSubtitle(tab)}
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {tab.foreground && <TabBadge tone="accent">current</TabBadge>}
                  {tab.active && tab.focused_window && <TabBadge tone="accent">active</TabBadge>}
                  {tab.pinned_target && <TabBadge tone="success">pinned</TabBadge>}
                  {!tab.usable && <TabBadge tone="warn">blocked</TabBadge>}
                  <TabBadge>window {tab.window_id}</TabBadge>
                </div>
              </div>
              <button
                onClick={() => void activate(tab)}
                disabled={activating !== null || !tab.tab_id}
                className="px-2.5 py-1.5 text-xs rounded bg-accent/15 hover:bg-accent/25 text-accent inline-flex items-center gap-1 disabled:opacity-50"
                title="Focus this browser tab"
              >
                {activating === tab.tab_id ? <Loader2 size={11} className="animate-spin" /> : <MousePointer2 size={11} />}
                Focus
              </button>
            </div>
          </div>
        ))}

        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-medium text-fg mr-auto">Recent browser commands</h3>
            <span className="text-[10px] text-fg-faint">sanitized</span>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-fg-faint py-2">No browser command history yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((command) => (
                <li key={command.cmd_id} className="rounded border border-border/60 bg-surface-3 px-2 py-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-fg truncate">{command.summary}</span>
                        <TabBadge tone={statusTone(command.status)}>{command.status}</TabBadge>
                        {command.risk_level === "sensitive" && <TabBadge tone="warn">sensitive</TabBadge>}
                      </div>
                      <p className="text-[11px] text-fg-faint truncate mt-0.5">
                        {command.type}{command.host ? ` · ${command.host}` : ""}{humanPhase(command.last_phase) ? ` · ${humanPhase(command.last_phase)}` : ""}{command.error ? ` · ${command.error}` : ""}
                      </p>
                    </div>
                    {command.retryable && (
                      <button
                        onClick={() => void retry(command)}
                        disabled={retrying !== null || status?.connected !== true}
                        className="px-2 py-1 text-[11px] rounded bg-accent/15 hover:bg-accent/25 text-accent inline-flex items-center gap-1 disabled:opacity-50"
                        title="Retry this browser command"
                      >
                        {retrying === command.cmd_id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                        Retry
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
