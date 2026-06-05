"use client";
import { AlertCircle, Bell, CheckCircle2, EyeOff, Play, Power, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { AgentConfig, ModelConfig, Watcher } from "@/api/types";
import { formatRelative as sharedFormatRelative } from "@/lib/utils/time";
import { pushErrorToast } from "@/lib/ui/error-report";
import { pushToast } from "@/lib/ui/toasts";
import { agentModelStatus } from "@/lib/agents/effective-model";
import { AgentModelBadge } from "./AgentModelBadge";
import { KindPill, ReactionScriptEditor } from "@/components/triggers/ReactionEditor";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { Select } from "@/components/ui/Select";

// Event-driven tasks (ADR-0027). Sibling to ScheduledTasksPanel — same
// card aesthetic, but rows describe a tool poll + diff detector, not a
// cron firing. Watchers are agent-created via the `schedule_watcher`
// tool; the UI is read-only-ish (cancel / pause / run-now / silent).
export function WatchersSection({ agents, models }: { agents: Record<string, AgentConfig>; models: ModelConfig[] }) {
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
    catch (e) {
      pushErrorToast({
        title: "Couldn't run watcher",
        error: e,
        context: { panel: "scheduled-tasks", action: "watcher.runNow", watcher_id: w.id, label: w.label },
      });
    }
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
            agents={agents}
            models={models}
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
  watcher, agent, agents, models, onCancel, onRunNow, onChanged,
}: {
  watcher: Watcher;
  agent?: AgentConfig;
  agents: Record<string, AgentConfig>;
  models: ModelConfig[];
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
  // Pre-flight model availability for the assigned agent; only relevant
  // when the watcher reacts via an agent prompt (not a pure script).
  const modelStatus = watcher.reaction_kind === "agent_prompt"
    ? agentModelStatus(agent ?? null, models)
    : null;

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
              {modelStatus && modelStatus.state !== "ok" && (
                <>
                  <span>·</span>
                  <AgentModelBadge status={modelStatus} />
                </>
              )}
              {watcher.silent && (
                <>
                  <span>·</span>
                  <span
                    className="inline-flex items-center gap-0.5 text-fg-faint"
                    title="Silent: suppresses the task_completed notification and tells the agent to reply only on material diffs. Errors still notify."
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
          <Row label="Agent">
            <Select
              size="sm"
              value={watcher.agent_id}
              onChange={async (e) => {
                const next = e.target.value;
                if (next === watcher.agent_id) return;
                try {
                  await api.watchers.update(watcher.id, { agent_id: next });
                  onChanged();
                } catch (err) {
                  pushErrorToast({
                    title: "Couldn't re-assign watcher",
                    error: err,
                    context: { panel: "scheduled-tasks", action: "watcher.reassign", watcher_id: watcher.id, target_agent: next },
                  });
                }
              }}
            >
              {Object.values(agents).length === 0 && (
                <option value={watcher.agent_id}>{watcher.agent_id}</option>
              )}
              {Object.values(agents)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </Select>
          </Row>
          <Row label="Tool">
            <span className="font-mono">{watcher.tool}</span>
          </Row>
          <Row label="Args">
            <pre className="whitespace-pre-wrap break-words font-mono text-fg-muted">
              {JSON.stringify(watcher.args ?? {}, null, 2)}
            </pre>
          </Row>
          <Row label="Reaction">
            <ReactionEditor watcher={watcher} onSaved={onChanged} />
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
                  pushErrorToast({
                    title: "Couldn't toggle watcher",
                    error: e,
                    context: { panel: "scheduled-tasks", action: "watcher.toggle", watcher_id: watcher.id, target_enabled: !watcher.enabled },
                  });
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

// ADR-0030 + ADR-0031. The Reaction row routes between two editors based on
// `reaction_kind`. A kind toggle at the top swaps the column atomically via
// PATCH (reaction_kind: ...). The store enforces the discriminated-union
// rules — switching to 'script' clears reaction_prompt and vice versa.
const REACTION_PROMPT_MAX = 4000;

function ReactionEditor({
  watcher, onSaved,
}: {
  watcher: Watcher;
  onSaved: () => void;
}) {
  const [switching, setSwitching] = useState(false);

  async function switchKind(next: "agent_prompt" | "script", scriptName?: string) {
    setSwitching(true);
    try {
      if (next === "script") {
        await api.watchers.update(watcher.id, {
          reaction_kind: "script",
          reaction_script: scriptName ?? null,
          reaction_script_args: null,
        });
      } else {
        await api.watchers.update(watcher.id, {
          reaction_kind: "agent_prompt",
          reaction_prompt: null,
        });
      }
      onSaved();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't switch reaction kind",
        error: e,
        context: { panel: "scheduled-tasks", action: "watcher.reaction_kind", watcher_id: watcher.id, target_kind: next },
      });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <KindPill
          active={watcher.reaction_kind === "agent_prompt"}
          onClick={() => watcher.reaction_kind !== "agent_prompt" && void switchKind("agent_prompt")}
          disabled={switching}
          title="On change, run this watcher's agent with a custom prompt (default behaviour)."
        >
          Agent prompt
        </KindPill>
        <KindPill
          active={watcher.reaction_kind === "script"}
          onClick={() => watcher.reaction_kind !== "script" && void switchKind("script")}
          disabled={switching}
          title="On change, run a built-in reaction.* script with no LLM round-trip."
        >
          Script
        </KindPill>
      </div>
      <p className="text-[10px] text-fg-faint leading-snug">
        Choose how this watcher reacts on change:
        <span className="text-fg-subtle"> Agent prompt</span> runs the assigned agent with diff context;
        <span className="text-fg-subtle"> Script</span> runs a built-in automation without an LLM round-trip.
      </p>
      {watcher.reaction_kind === "script"
        ? (
          <ReactionScriptEditor
            initialScript={watcher.reaction_script}
            initialArgs={watcher.reaction_script_args}
            onSave={async ({ script, args }) => {
              await api.watchers.update(watcher.id, {
                reaction_script: script,
                reaction_script_args: args,
              });
              onSaved();
            }}
            errorContext={{ panel: "scheduled-tasks", action: "watcher.reaction_script", watcher_id: watcher.id }}
            diffContext={true}
          />
        )
        : <ReactionPromptEditor watcher={watcher} onSaved={onSaved} />}
    </div>
  );
}

function ReactionPromptEditor({
  watcher, onSaved,
}: {
  watcher: Watcher;
  onSaved: () => void;
}) {
  const initial = watcher.reaction_prompt ?? "";
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  // Reset local state if the watcher was refetched and the prompt
  // changed (e.g. agent edited it via the tool while this card was open).
  useEffect(() => { setValue(watcher.reaction_prompt ?? ""); }, [watcher.reaction_prompt]);
  const dirty = value.trim() !== initial.trim();
  const tooLong = value.length > REACTION_PROMPT_MAX;

  async function save(next: string | null) {
    setSaving(true);
    try {
      await api.watchers.update(watcher.id, { reaction_prompt: next });
      onSaved();
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save reaction",
        error: e,
        context: { panel: "scheduled-tasks", action: "watcher.reaction_prompt", watcher_id: watcher.id },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <MarkdownTextarea
        value={value}
        onChange={setValue}
        rows={3}
        monospace
        maxLength={REACTION_PROMPT_MAX}
        placeholder="Default: summarise what changed and decide whether the user needs to know."
        className="w-full text-[11px] rounded border border-border bg-surface-1 px-2 py-1 text-fg-muted focus:outline-none focus:border-fg-muted resize-y"
      />
      <div className="flex items-center gap-2 text-[10px] text-fg-faint">
        <span className={tooLong ? "text-rose-700 dark:text-rose-400" : ""}>
          {value.length}/{REACTION_PROMPT_MAX}
        </span>
        <span className="ml-auto flex gap-2">
          {watcher.reaction_prompt !== null && (
            <button
              onClick={() => { setValue(""); void save(null); }}
              disabled={saving}
              className="px-2 py-0.5 rounded border border-border hover:text-fg hover:border-fg-muted disabled:opacity-50"
              title="Clear the custom instruction; fall back to the default directive."
            >
              Reset to default
            </button>
          )}
          <button
            onClick={() => void save(value.trim() ? value : null)}
            disabled={saving || !dirty || tooLong}
            className="px-2 py-0.5 rounded border border-border hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
