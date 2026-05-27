"use client";
import { AlertCircle, Bell, CheckCircle2, EyeOff, Play, Power, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, Watcher } from "@/api/types";
import { formatRelative as sharedFormatRelative } from "@/lib/utils/time";
import { pushToast } from "@/lib/ui/toasts";

// Event-driven tasks (ADR-0027). Sibling to ScheduledTasksPanel — same
// card aesthetic, but rows describe a tool poll + diff detector, not a
// cron firing. Watchers are agent-created via the `schedule_watcher`
// tool; the UI is read-only-ish (cancel / pause / run-now / silent).
export function WatchersSection({ agents }: { agents: Record<string, AgentConfig> }) {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setWatchers(await api.watchers.list());
    } catch (e) {
      // Surface the failure instead of silently rendering "No watchers".
      // A swallowed catch here was masking real list errors and made it
      // look like the panel was filtering watchers it actually wasn't.
      console.error(e);
      pushToast({
        kind: "error",
        source: "system",
        sourceLabel: "Watchers",
        title: "Couldn't load watchers",
        body: e instanceof Error ? e.message : String(e),
        agent_id: null,
        thread_id: null,
        ttl: 6000,
      });
    }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  async function cancel(w: Watcher) {
    if (!confirm(`Cancel watcher "${w.label}"?`)) return;
    await api.watchers.cancel(w.id);
    void load();
  }
  async function runNow(w: Watcher) {
    try { await api.watchers.runNow(w.id); }
    catch (e) { alert(`Run failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { void load(); }
  }

  const sorted = useMemo(
    () => [...watchers].sort((a, b) => a.next_run_at.localeCompare(b.next_run_at)),
    [watchers],
  );

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 px-1 py-2 border-b border-border/60">
        <Zap size={14} className="text-fg-subtle" />
        <h3 className="text-xs font-semibold text-fg mr-auto">Event-driven Tasks</h3>
        {watchers.length > 0 && (
          <span className="text-[11px] text-fg-faint">{watchers.length}</span>
        )}
      </div>

      {loading && watchers.length === 0 && (
        <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
      )}
      {!loading && watchers.length === 0 && (
        <div className="text-fg-faint text-sm py-6 text-center space-y-2">
          <p>No watchers.</p>
          <p className="text-xs text-fg-faint leading-relaxed">
            Ask any agent &ldquo;watch Jira issue ABC-123 and tell me when it changes&rdquo; or
            &ldquo;poll my inbox every 5 minutes&rdquo;. The agent will register a watcher via
            its <code className="px-1 rounded bg-surface-3 text-fg-subtle">schedule_watcher</code> tool
            and it will only fire when the underlying tool result actually changes.
          </p>
        </div>
      )}
      <div className="mt-2">
        {sorted.map((w) => (
          <WatcherCard
            key={w.id}
            watcher={w}
            agent={agents[w.agent_id]}
            onCancel={() => cancel(w)}
            onRunNow={() => runNow(w)}
            onChanged={() => void load()}
          />
        ))}
      </div>
    </div>
  );
}

function WatcherCard({
  watcher, agent, onCancel, onRunNow, onChanged,
}: {
  watcher: Watcher;
  agent?: AgentConfig;
  onCancel: () => void;
  onRunNow: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const nextRun = sharedFormatRelative(watcher.next_run_at, { collapseSeconds: true });
  const lastRun = watcher.last_run_at
    ? sharedFormatRelative(watcher.last_run_at, { collapseSeconds: true })
    : null;
  const lastFired = watcher.last_fired_at
    ? sharedFormatRelative(watcher.last_fired_at, { collapseSeconds: true })
    : null;
  const overdue = !watcher.last_error && new Date(watcher.next_run_at).getTime() < Date.now() - 60_000;

  return (
    <div data-deep-link-id={watcher.id} className="mb-2 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-surface-3/40 transition-colors"
      >
        <div className="flex items-start gap-2">
          <Bell size={12} className="mt-1 text-amber-700 dark:text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-fg truncate">{watcher.label}</p>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-fg-faint flex-wrap">
              <span className="font-mono">{watcher.tool}</span>
              <span>·</span>
              <span>every {formatInterval(watcher.interval_seconds)}</span>
              <span>·</span>
              <span className={overdue ? "text-amber-700 dark:text-amber-400" : ""}>
                {overdue ? "overdue" : `next: ${nextRun}`}
              </span>
              {agent && (
                <>
                  <span>·</span>
                  <span className="truncate">{agent.name}</span>
                </>
              )}
              {watcher.silent && (
                <>
                  <span>·</span>
                  <span
                    className="inline-flex items-center gap-0.5 text-fg-faint"
                    title="Silent: agent only replies if the diff is material"
                  >
                    <EyeOff size={10} /> silent
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-border/60 text-[11px] text-fg-subtle space-y-2">
          <Row label="Tool">
            <span className="font-mono">{watcher.tool}</span>
          </Row>
          <Row label="Args">
            <pre className="whitespace-pre-wrap break-words font-mono text-fg-muted">
              {JSON.stringify(watcher.args ?? {}, null, 2)}
            </pre>
          </Row>
          <Row label="Interval">
            <span>{formatInterval(watcher.interval_seconds)}</span>
          </Row>
          <Row label="Next poll">
            <span>{new Date(watcher.next_run_at).toLocaleString()}</span>
            <span className="ml-1 text-fg-faint">({nextRun})</span>
          </Row>
          {lastRun && (
            <Row label="Last poll">
              <span>{new Date(watcher.last_run_at!).toLocaleString()}</span>
              <span className="ml-1 text-fg-faint">({lastRun})</span>
            </Row>
          )}
          {lastFired && (
            <Row label="Last fire">
              <span>{new Date(watcher.last_fired_at!).toLocaleString()}</span>
              <span className="ml-1 text-fg-faint">({lastFired})</span>
            </Row>
          )}
          <Row label="Status">
            {watcher.last_error ? (
              <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
                <AlertCircle size={11} /> error
              </span>
            ) : watcher.enabled ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={11} /> active
              </span>
            ) : (
              <span className="text-fg-faint">disabled</span>
            )}
          </Row>
          {watcher.last_error && (
            <Row label="Error">
              <pre className="whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300/90">{watcher.last_error}</pre>
            </Row>
          )}
          <div className="flex justify-end pt-1 gap-2">
            <button
              onClick={async () => {
                try {
                  await api.watchers.update(watcher.id, { enabled: !watcher.enabled });
                  onChanged();
                } catch (e) {
                  alert(`Toggle failed: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:text-fg hover:border-fg-muted"
              title={watcher.enabled ? "Pause this watcher" : "Resume this watcher"}
            >
              <Power size={11} /> {watcher.enabled ? "Pause" : "Resume"}
            </button>
            <button
              onClick={async () => {
                if (running) return;
                setRunning(true);
                try { await onRunNow(); } finally { setRunning(false); }
              }}
              disabled={running}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-700 disabled:opacity-50"
              title="Poll the tool right now. If the result differs from the last poll, the agent fires."
            >
              <Play size={11} /> {running ? "Polling…" : "Poll now"}
            </button>
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-rose-700 dark:hover:text-rose-400 hover:border-rose-700"
            >
              <Trash2 size={11} /> Cancel watcher
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-20 shrink-0 text-fg-faint">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
