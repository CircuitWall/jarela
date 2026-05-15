"use client";
import { AlertCircle, Calendar, CheckCircle2, Clock, Repeat, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ScheduledTask } from "@/api/types";

export function ScheduledTasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentConfig>>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [taskList, agentList] = await Promise.all([
        api.scheduledTasks.list(),
        api.agents.list(),
      ]);
      setTasks(taskList);
      setAgents(Object.fromEntries(agentList.map((a) => [a.id, a])));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  // Refresh every 15s — scheduler ticks every 30s, so this catches firings
  // before the user opens/closes the panel and missing them.
  useEffect(() => {
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, []);

  async function cancel(task: ScheduledTask) {
    if (!confirm(`Cancel scheduled task?\n\n${task.prompt.slice(0, 200)}${task.prompt.length > 200 ? "…" : ""}`)) return;
    await api.scheduledTasks.cancel(task.id);
    void load();
  }

  const sorted = useMemo(() => {
    // Pending (next_run_at >= now) first, sorted by next-fire ascending.
    // Then completed (last_run_at set, but for cron these will keep cycling).
    return [...tasks].sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  }, [tasks]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Calendar size={14} className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-100 mr-auto">Scheduled Tasks</h2>
        {tasks.length > 0 && (
          <span className="text-[11px] text-zinc-500">{tasks.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && tasks.length === 0 && (
          <p className="text-zinc-500 text-sm py-6 text-center">Loading…</p>
        )}
        {!loading && tasks.length === 0 && (
          <div className="text-zinc-500 text-sm py-8 text-center space-y-2">
            <p>No scheduled tasks.</p>
            <p className="text-xs text-zinc-600 leading-relaxed">
              Ask any agent &ldquo;remind me to X in 30 minutes&rdquo; or &ldquo;every weekday at 9am, do Y&rdquo;.
              The agent will use its <code className="px-1 rounded bg-surface-3 text-zinc-400">schedule_task</code> tool
              and the run will appear here.
            </p>
          </div>
        )}
        {sorted.map((t) => (
          <TaskCard key={t.id} task={t} agent={agents[t.agent_id]} onCancel={() => cancel(t)} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task, agent, onCancel,
}: {
  task: ScheduledTask;
  agent?: AgentConfig;
  onCancel: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isCron = task.kind === "cron";
  const nextRun = formatRelative(task.next_run_at);
  const lastRun = task.last_run_at ? formatRelative(task.last_run_at) : null;
  const overdue = !task.last_error && new Date(task.next_run_at).getTime() < Date.now() - 60_000;

  return (
    <div className="mb-2 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-surface-3/40 transition-colors"
      >
        <div className="flex items-start gap-2">
          {isCron
            ? <Repeat size={12} className="mt-1 text-violet-400 shrink-0" />
            : <Clock size={12} className="mt-1 text-sky-400 shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-zinc-100 truncate">{task.prompt}</p>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-500 flex-wrap">
              <span className="font-mono">
                {isCron ? task.schedule : new Date(task.schedule).toLocaleString()}
              </span>
              <span>·</span>
              <span className={overdue ? "text-amber-400" : ""}>
                {overdue ? "overdue" : `next: ${nextRun}`}
              </span>
              {agent && (
                <>
                  <span>·</span>
                  <span className="truncate">{agent.name}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-border/60 text-[11px] text-zinc-400 space-y-2">
          <Row label="Prompt">
            <pre className="whitespace-pre-wrap break-words font-mono text-zinc-300">{task.prompt}</pre>
          </Row>
          {task.description && (
            <Row label="Description">{task.description}</Row>
          )}
          <Row label="Kind">
            <span className="font-mono">{task.kind}</span>
          </Row>
          <Row label={isCron ? "Cron" : "When"}>
            <span className="font-mono">{task.schedule}</span>
            {!isCron && (
              <span className="ml-1 text-zinc-500">({new Date(task.schedule).toLocaleString()})</span>
            )}
          </Row>
          <Row label="Next run">
            <span>{new Date(task.next_run_at).toLocaleString()}</span>
            <span className="ml-1 text-zinc-500">({nextRun})</span>
          </Row>
          {lastRun && (
            <Row label="Last run">
              <span>{new Date(task.last_run_at!).toLocaleString()}</span>
              <span className="ml-1 text-zinc-500">({lastRun})</span>
            </Row>
          )}
          <Row label="Status">
            {task.last_error ? (
              <span className="inline-flex items-center gap-1 text-rose-400">
                <AlertCircle size={11} /> error
              </span>
            ) : task.enabled ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 size={11} /> active
              </span>
            ) : (
              <span className="text-zinc-500">disabled</span>
            )}
          </Row>
          {task.last_error && (
            <Row label="Error">
              <pre className="whitespace-pre-wrap break-words text-rose-300/90">{task.last_error}</pre>
            </Row>
          )}
          <div className="flex justify-end pt-1">
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-zinc-400 hover:text-rose-400 hover:border-rose-700"
            >
              <Trash2 size={11} /> Cancel task
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
      <span className="w-20 shrink-0 text-zinc-500">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);
  let txt: string;
  if (abs < 60_000) txt = "<1m";
  else if (min < 60) txt = `${min}m`;
  else if (hr < 48) txt = `${hr}h`;
  else txt = `${day}d`;
  return past ? `${txt} ago` : `in ${txt}`;
}
