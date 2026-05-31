"use client";
import { AlertCircle, Calendar, CheckCircle2, Clock, EyeOff, Pencil, Play, Power, Repeat, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ScheduledTask } from "@/api/types";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { formatRelative } from "@/lib/utils/time";
import { humanizeCron } from "@/lib/utils/cron";
import { pushErrorToast } from "@/lib/ui/error-report";
import { WatchersSection } from "./WatchersSection";
import { KindPill, ReactionScriptEditor } from "@/components/triggers/ReactionEditor";

export function ScheduledTasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentConfig>>({});
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("tasks", "task", containerRef);

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

  async function runNow(task: ScheduledTask) {
    try {
      await api.scheduledTasks.runNow(task.id);
    } catch (e) {
      pushErrorToast({
        title: "Couldn't run scheduled task",
        error: e,
        context: { panel: "scheduled-tasks", action: "task.runNow", task_id: task.id },
      });
    } finally {
      void load();
    }
  }

  const sorted = useMemo(() => {
    // Pending (next_run_at >= now) first, sorted by next-fire ascending.
    // Then completed (last_run_at set, but for cron these will keep cycling).
    return [...tasks].sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  }, [tasks]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Calendar size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Scheduled Tasks</h2>
        {tasks.length > 0 && (
          <span className="text-[11px] text-fg-faint">{tasks.length}</span>
        )}
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3">
        {loading && tasks.length === 0 && (
          <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
        )}
        {!loading && tasks.length === 0 && (
          <div className="text-fg-faint text-sm py-8 text-center space-y-2">
            <p>No scheduled tasks.</p>
            <p className="text-xs text-fg-faint leading-relaxed">
              Ask any agent &ldquo;remind me to X in 30 minutes&rdquo; or &ldquo;every weekday at 9am, do Y&rdquo;.
              The agent will use its <code className="px-1 rounded bg-surface-3 text-fg-subtle">schedule_task</code> tool
              and the run will appear here.
            </p>
          </div>
        )}
        {sorted.map((t) => (
          <TaskCard key={t.id} task={t} agent={agents[t.agent_id]} onCancel={() => cancel(t)} onRunNow={() => runNow(t)} onChanged={() => void load()} />
        ))}
        <WatchersSection agents={agents} />
      </div>
    </div>
  );
}

function TaskCard({
  task, agent, onCancel, onRunNow, onChanged,
}: {
  task: ScheduledTask;
  agent?: AgentConfig;
  onCancel: () => void;
  onRunNow: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState(false);
  const isCron = task.kind === "cron";
  const nextRun = formatRelative(task.next_run_at, { collapseSeconds: true });
  const lastRun = task.last_run_at ? formatRelative(task.last_run_at, { collapseSeconds: true }) : null;
  const overdue = !task.last_error && new Date(task.next_run_at).getTime() < Date.now() - 60_000;

  return (
    <div data-deep-link-id={task.id} className="mb-2 rounded-lg border border-border bg-surface-2 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-surface-3/40 transition-colors"
      >
        <div className="flex items-start gap-2">
          {isCron
            ? <Repeat size={12} className="mt-1 text-violet-700 dark:text-violet-400 shrink-0" />
            : <Clock size={12} className="mt-1 text-sky-700 dark:text-sky-400 shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-fg truncate">{task.prompt}</p>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-fg-faint flex-wrap">
              <span className="font-mono">
                {isCron ? task.schedule : new Date(task.schedule).toLocaleString()}
              </span>
              {isCron && humanizeCron(task.schedule) && (
                <span className="text-fg-muted">({humanizeCron(task.schedule)})</span>
              )}
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
              {task.silent && (
                <>
                  <span>·</span>
                  <span
                    className="inline-flex items-center gap-0.5 text-fg-faint"
                    title="Silent: suppresses the task_completed notification and tells the agent to reply only when something material surfaces. Errors still notify."
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
          {editing ? (
            <TaskEditor task={task} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />
          ) : (
            <>
          {task.reaction_kind === "agent_prompt" && (
            <Row label="Prompt">
              <pre className="whitespace-pre-wrap break-words font-mono text-fg-muted">{task.prompt}</pre>
            </Row>
          )}
          {task.reaction_kind === "script" && (
            <Row label="Prompt">
              <span className="text-fg-faint italic">
                (running script: <span className="font-mono">{task.reaction_script}</span> — no agent prompt)
              </span>
            </Row>
          )}
          <Row label="Reaction">
            <TaskReactionEditor task={task} onChanged={onChanged} />
          </Row>
          {task.description && (
            <Row label="Description">{task.description}</Row>
          )}
          <Row label="Kind">
            <span className="font-mono">{task.kind}</span>
          </Row>
          <Row label={isCron ? "Cron" : "When"}>
            <span className="font-mono">{task.schedule}</span>
            {isCron && humanizeCron(task.schedule) && (
              <span className="ml-1 text-fg-faint">({humanizeCron(task.schedule)})</span>
            )}
            {!isCron && (
              <span className="ml-1 text-fg-faint">({new Date(task.schedule).toLocaleString()})</span>
            )}
          </Row>
          <Row label="Next run">
            <span>{new Date(task.next_run_at).toLocaleString()}</span>
            <span className="ml-1 text-fg-faint">({nextRun})</span>
          </Row>
          {lastRun && (
            <Row label="Last run">
              <span>{new Date(task.last_run_at!).toLocaleString()}</span>
              <span className="ml-1 text-fg-faint">({lastRun})</span>
            </Row>
          )}
          <Row label="Status">
            {task.last_error ? (
              <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
                <AlertCircle size={11} /> error
              </span>
            ) : task.enabled ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={11} /> active
              </span>
            ) : (
              <span className="text-fg-faint">disabled</span>
            )}
          </Row>
          {task.last_error && (
            <Row label="Error">
              <pre className="whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300/90">{task.last_error}</pre>
            </Row>
          )}
          <div className="flex justify-end pt-1 gap-2">
            <button
              onClick={async () => {
                try {
                  await api.scheduledTasks.update(task.id, { enabled: !task.enabled });
                  onChanged();
                } catch (e) {
                  pushErrorToast({
                    title: "Couldn't toggle scheduled task",
                    error: e,
                    context: { panel: "scheduled-tasks", action: "task.toggle", task_id: task.id, target_enabled: !task.enabled },
                  });
                }
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:text-fg hover:border-fg-muted"
              title={task.enabled ? "Pause this task (scheduler will skip it)" : "Resume this task"}
            >
              <Power size={11} /> {task.enabled ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:text-sky-700 dark:hover:text-sky-400 hover:border-sky-700"
            >
              <Pencil size={11} /> Edit
            </button>
            <button
              onClick={async () => {
                if (running) return;
                setRunning(true);
                try { await onRunNow(); } finally { setRunning(false); }
              }}
              disabled={running}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-700 disabled:opacity-50"
              title="Trigger this task now to preview the notification + content. Cron tasks still continue on their normal schedule."
            >
              <Play size={11} /> {running ? "Running…" : "Run now"}
            </button>
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-rose-700 dark:hover:text-rose-400 hover:border-rose-700"
            >
              <Trash2 size={11} /> Cancel task
            </button>
          </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ADR-0032 — kind toggle + script editor for a scheduled task. The
// agent_prompt branch is the existing `prompt` column on the task,
// which is rendered above (or via TaskEditor); when the user switches to
// 'script' the prompt becomes a "(running script: …)" stub.
function TaskReactionEditor({
  task, onChanged,
}: {
  task: ScheduledTask;
  onChanged: () => void;
}) {
  const [switching, setSwitching] = useState(false);

  async function switchKind(next: "agent_prompt" | "script") {
    if (next === task.reaction_kind) return;
    setSwitching(true);
    try {
      if (next === "script") {
        await api.scheduledTasks.update(task.id, {
          reaction_kind: "script",
          reaction_script: null,
          reaction_script_args: null,
        });
      } else {
        await api.scheduledTasks.update(task.id, {
          reaction_kind: "agent_prompt",
          // Restore a non-empty prompt sentinel so the NOT NULL column
          // stays populated; the user can then edit it via the TaskEditor.
          prompt: task.prompt && task.prompt.trim() ? task.prompt : "(edit me)",
        });
      }
      onChanged();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't switch reaction kind",
        error: e,
        context: { panel: "scheduled-tasks", action: "task.reaction_kind", task_id: task.id, target_kind: next },
      });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <KindPill
          active={task.reaction_kind === "agent_prompt"}
          onClick={() => void switchKind("agent_prompt")}
          disabled={switching}
          title="On firing, run this task's agent with the prompt above (default)."
        >
          Agent prompt
        </KindPill>
        <KindPill
          active={task.reaction_kind === "script"}
          onClick={() => void switchKind("script")}
          disabled={switching}
          title="On firing, run a built-in reaction.* script with no LLM round-trip."
        >
          Script
        </KindPill>
      </div>
      <p className="text-[10px] text-fg-faint leading-snug">
        Reaction mode controls what happens when this task fires:
        <span className="text-fg-subtle"> Agent prompt</span> runs the task&apos;s agent prompt;
        <span className="text-fg-subtle"> Script</span> runs a built-in reaction script with no LLM chat turn.
      </p>
      {task.reaction_kind === "script" && (
        <ReactionScriptEditor
          initialScript={task.reaction_script}
          initialArgs={task.reaction_script_args}
          onSave={async ({ script, args }) => {
            await api.scheduledTasks.update(task.id, {
              reaction_script: script,
              reaction_script_args: args,
            });
            onChanged();
          }}
          errorContext={{ panel: "scheduled-tasks", action: "task.reaction_script", task_id: task.id }}
          diffContext={false}
        />
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

// Editable form for an existing task. Keeps inline within the expanded
// card. For "once" tasks the schedule field is a datetime-local input
// (ISO conversion happens on save); for "cron" it's a free-text cron expr
// the server validates with cron-parser.
function TaskEditor({
  task, onCancel, onSaved,
}: {
  task: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState(task.prompt);
  const [description, setDescription] = useState(task.description ?? "");
  const [kind, setKind] = useState<"once" | "cron">(task.kind);
  const [schedule, setSchedule] = useState(() =>
    task.kind === "once" ? isoToLocalInput(task.schedule) : task.schedule,
  );
  const [enabled, setEnabled] = useState(task.enabled);
  const [silent, setSilent] = useState(task.silent ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setError(null);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) { setError("Prompt cannot be empty."); return; }
    const trimmedSchedule = schedule.trim();
    if (!trimmedSchedule) { setError("Schedule cannot be empty."); return; }
    let scheduleOut = trimmedSchedule;
    if (kind === "once") {
      const ts = new Date(trimmedSchedule);
      if (Number.isNaN(ts.getTime())) { setError("Invalid date/time."); return; }
      scheduleOut = ts.toISOString();
    }
    setSaving(true);
    try {
      await api.scheduledTasks.update(task.id, {
        prompt: trimmedPrompt,
        description: description.trim() ? description.trim() : null,
        kind,
        schedule: scheduleOut,
        enabled,
        silent,
      });
      onSaved();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save scheduled task",
        error: e,
        context: { panel: "scheduled-tasks", action: "task.save", task_id: task.id },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <Row label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-[12px] text-fg font-mono"
        />
      </Row>
      <Row label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="optional"
          className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-[12px] text-fg"
        />
      </Row>
      <Row label="Kind">
        <div className="inline-flex rounded border border-border overflow-hidden">
          {(["once", "cron"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                // Reset the schedule field to a sane default when switching kinds.
                if (k === "once" && task.kind !== "once") setSchedule(isoToLocalInput(new Date(Date.now() + 60 * 60_000).toISOString()));
                if (k === "cron" && task.kind !== "cron") setSchedule("0 9 * * *");
              }}
              className={`px-2 py-0.5 text-[11px] ${kind === k ? "bg-surface-3 text-fg" : "text-fg-faint hover:text-fg"}`}
            >
              {k}
            </button>
          ))}
        </div>
      </Row>
      <Row label={kind === "cron" ? "Cron" : "When"}>
        {kind === "cron" ? (
          <input
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 9 * * *"
            className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-[12px] text-fg font-mono"
          />
        ) : (
          <input
            type="datetime-local"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="rounded border border-border bg-surface-1 px-2 py-1 text-[12px] text-fg"
          />
        )}
      </Row>
      <Row label="Enabled">
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-emerald-600"
          />
          <span className="text-[11px]">{enabled ? "active" : "paused"}</span>
        </label>
      </Row>
      <Row label="Silent">
        <label className="inline-flex items-center gap-1 cursor-pointer" title="When silent: suppresses the task_completed notification AND tells the agent to reply only when something material surfaces (NO_REPLY answers are dropped). Errors still notify so failures aren't hidden. Firings remain visible in chat tagged 'scheduled' — use the filter toolbar to hide them.">
          <input
            type="checkbox"
            checked={silent}
            onChange={(e) => setSilent(e.target.checked)}
            className="accent-sky-600"
          />
          <span className="text-[11px]">{silent ? "muted (no notification)" : "always notify"}</span>
        </label>
      </Row>
      {error && (
        <p className="text-[11px] text-rose-700 dark:text-rose-400">{error}</p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-fg-subtle hover:text-fg disabled:opacity-50"
        >
          <X size={11} /> Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-700/10 disabled:opacity-50"
        >
          <Save size={11} /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// Convert an ISO timestamp ("2026-05-21T14:00:00.000Z") to the value
// expected by <input type="datetime-local"> ("2026-05-21T22:00", in
// local time). Browsers don't accept the trailing Z.
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
