"use client";
import { AlertCircle, Brain, Loader2, Moon, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  DreamRun,
  DreamSkipReason,
  DreamingAgentStatus,
  DreamingSettings,
  DreamingSettingsPatch,
} from "@/api/types";
import { useDreaming } from "./useDreaming";

const SKIP_LABELS: Record<DreamSkipReason, string> = {
  disabled: "dreaming is off",
  agent_disabled: "disabled for this agent",
  agent_not_found: "agent not found",
  locked: "the app is locked",
  no_thread: "no conversation yet",
  no_messages: "no messages yet",
  no_model: "no runnable model",
  active_run: "the agent is working",
  queued_turn: "a turn is queued",
  compaction_in_flight: "compaction is running",
  dream_running: "another dream is running",
  not_idle: "not idle long enough",
  too_few_turns: "not enough new turns",
  summary_disabled: "warm summaries are disabled",
  already_dreamed: "already dreamed this idle window",
  daily_limit: "daily run limit reached",
  budget_exhausted: "token budget reached",
  retry_cooldown: "waiting before retrying",
  deep_not_due: "not due until the weekly slot",
  not_default_agent: "weekly maintenance belongs to the default agent",
  documents_busy: "document maintenance is running",
};

function when(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function readinessLabel(eligible: boolean, reason: DreamSkipReason | null): string {
  if (eligible) return "ready";
  return reason ? SKIP_LABELS[reason] : "not ready";
}

function reviewText(run: DreamRun): string | null {
  const review = run.stats?.review;
  if (review && typeof review === "object" && "text" in review && typeof review.text === "string") {
    return review.text;
  }
  return null;
}

function StatusDot({ status }: { status: DreamRun["status"] }) {
  const tone = status === "completed"
    ? "bg-emerald-500"
    : status === "partial"
      ? "bg-amber-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "running"
          ? "bg-accent animate-pulse"
          : "bg-fg-faint";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone}`} aria-hidden="true" />;
}

function NumberField({
  label, value, min, max, step, suffix, disabled, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-20 px-2 py-1 rounded border border-border bg-surface-3 text-fg text-right"
        />
        <span className="text-fg-faint">{suffix}</span>
      </span>
    </label>
  );
}

function DreamSettingsEditor({
  settings,
  busy,
  onSave,
}: {
  settings: DreamingSettings;
  busy: boolean;
  onSave: (patch: DreamingSettingsPatch) => Promise<void>;
}) {
  const [idle, setIdle] = useState(settings.light_idle_minutes);
  const [dailyTokens, setDailyTokens] = useState(settings.light_daily_token_budget);
  const [weeklyTokens, setWeeklyTokens] = useState(settings.deep_weekly_token_budget);
  const [weekday, setWeekday] = useState(settings.deep_weekday);
  const [hour, setHour] = useState(settings.deep_hour);
  // Key on the values, not the settings object: the running-dream poll returns
  // a fresh object every two seconds and must not clobber an in-progress edit.
  useEffect(() => {
    setIdle(settings.light_idle_minutes);
    setDailyTokens(settings.light_daily_token_budget);
    setWeeklyTokens(settings.deep_weekly_token_budget);
    setWeekday(settings.deep_weekday);
    setHour(settings.deep_hour);
  }, [
    settings.light_idle_minutes,
    settings.light_daily_token_budget,
    settings.deep_weekly_token_budget,
    settings.deep_weekday,
    settings.deep_hour,
  ]);
  const changed = idle !== settings.light_idle_minutes
    || dailyTokens !== settings.light_daily_token_budget
    || weeklyTokens !== settings.deep_weekly_token_budget
    || weekday !== settings.deep_weekday
    || hour !== settings.deep_hour;

  return (
    <section className="space-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Moon size={13} className="text-fg-subtle shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide flex-1">Dreaming</span>
        <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(event) => void onSave({ enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>

      <p className="text-[11px] text-fg-faint leading-relaxed">
        After an idle stretch the agent folds earlier context into a warm recap and wakes with a clean hot window.
        The default agent also consolidates memory and the document index weekly. Dreams never delete conversation
        history and never write chat messages.
      </p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <NumberField
          label="Idle threshold" value={idle} min={15} max={1440} suffix="min"
          disabled={busy} onChange={setIdle}
        />
        <NumberField
          label="Light budget" value={dailyTokens} min={0} max={20_000_000} step={10_000}
          suffix="tok/day" disabled={busy} onChange={setDailyTokens}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs border-t border-border/60 pt-2">
        <label className="flex items-center gap-1.5 text-fg-muted">
          <input
            type="checkbox"
            checked={settings.deep_enabled}
            disabled={busy}
            onChange={(event) => void onSave({ deep_enabled: event.target.checked })}
          />
          Weekly deep dream
        </label>
        <NumberField
          label="Weekly budget" value={weeklyTokens} min={0} max={20_000_000} step={10_000}
          suffix="tok/wk" disabled={busy} onChange={setWeeklyTokens}
        />
        <label className="flex items-center justify-between gap-2">
          <span className="text-fg-muted">Deep slot</span>
          <span className="flex items-center gap-1">
            <select
              value={weekday}
              disabled={busy}
              onChange={(event) => setWeekday(Number(event.target.value))}
              className="px-1.5 py-1 rounded border border-border bg-surface-3 text-fg"
            >
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => (
                <option key={day} value={index}>{day}</option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              disabled={busy}
              onChange={(event) => setHour(Number(event.target.value))}
              className="w-14 px-2 py-1 rounded border border-border bg-surface-3 text-fg text-right"
              aria-label="Deep dream hour"
            />
            <span className="text-fg-faint">h</span>
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-fg-muted">
          <input
            type="checkbox"
            checked={settings.deep_merge_enabled}
            disabled={busy}
            onChange={(event) => void onSave({ deep_merge_enabled: event.target.checked })}
          />
          Merge near-duplicates
        </label>
        <label className="flex items-center gap-1.5 text-fg-muted">
          <input
            type="checkbox"
            checked={settings.deep_review_enabled}
            disabled={busy}
            onChange={(event) => void onSave({ deep_review_enabled: event.target.checked })}
          />
          Weekly note
        </label>
      </div>

      <button
        type="button"
        onClick={() => void onSave({ light_idle_minutes: idle, light_daily_token_budget: dailyTokens, deep_weekly_token_budget: weeklyTokens, deep_weekday: weekday, deep_hour: hour })}
        disabled={!changed || busy}
        className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg disabled:opacity-50"
      >
        Save settings
      </button>
    </section>
  );
}

function DreamAgentList({
  agents,
  busy,
  onToggle,
  onDream,
}: {
  agents: DreamingAgentStatus[];
  busy: boolean;
  onToggle: (agentId: string, enabled: boolean) => Promise<void>;
  onDream: (agentId: string, kind: "light" | "deep") => Promise<void>;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Agents</h3>
      {agents.map((agent) => (
        <div key={agent.agent_id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5">
          <input
            type="checkbox"
            checked={agent.enabled}
            disabled={busy}
            aria-label={`Dreaming for ${agent.name}`}
            onChange={(event) => void onToggle(agent.agent_id, event.target.checked)}
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-fg truncate">
              {agent.name}{agent.is_default ? <span className="ml-1 text-[10px] text-accent">default</span> : null}
            </div>
            <div className="text-[10px] text-fg-faint truncate">
              Light: {readinessLabel(agent.light.eligible, agent.light.reason)} · last {when(agent.last_light_dream_at)}
              {agent.is_default ? ` · Deep: ${readinessLabel(agent.deep.eligible, agent.deep.reason)} · last ${when(agent.last_deep_dream_at)}` : ""}
            </div>
            {agent.last_error && <div className="text-[10px] text-red-500 truncate">{agent.last_error}</div>}
          </div>
          <button
            type="button"
            onClick={() => void onDream(agent.agent_id, "light")}
            disabled={busy || !agent.enabled}
            className="text-[11px] px-2 py-1 rounded border border-border bg-surface-2 hover:bg-surface-3 text-fg disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Play size={10} aria-hidden="true" /> Light
          </button>
          {agent.is_default && (
            <button
              type="button"
              onClick={() => void onDream(agent.agent_id, "deep")}
              disabled={busy || !agent.enabled}
              className="text-[11px] px-2 py-1 rounded border border-border bg-surface-2 hover:bg-surface-3 text-fg disabled:opacity-50 inline-flex items-center gap-1"
            >
              <Brain size={10} aria-hidden="true" /> Deep
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function DreamRunList({ runs }: { runs: DreamRun[] }) {
  if (runs.length === 0) {
    return <p className="text-[11px] text-fg-faint">No dreams yet.</p>;
  }
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Dream journal</h3>
      {runs.map((run) => {
        const review = reviewText(run);
        return (
          <div key={run.id} className="rounded-lg border border-border/60 bg-surface-3 px-2 py-1.5 text-[11px]">
            <div className="flex items-center gap-1.5 text-fg-muted">
              <StatusDot status={run.status} />
              <span className="uppercase tracking-wide text-[10px]">{run.kind}</span>
              <span className="text-fg-faint">{run.status}</span>
              <span className="text-fg-faint ml-auto">{when(run.started_at)}</span>
            </div>
            {run.summary && <p className="text-fg-muted mt-1 whitespace-pre-wrap">{run.summary}</p>}
            {run.error && <p className="text-red-500 mt-1 whitespace-pre-wrap">{run.error}</p>}
            {(run.estimated_input_tokens > 0 || run.estimated_output_tokens > 0) && (
              <p className="text-fg-faint mt-1">
                ~{run.estimated_input_tokens.toLocaleString()} in / {run.estimated_output_tokens.toLocaleString()} out estimated tokens
              </p>
            )}
            {review && (
              <details className="mt-1">
                <summary className="cursor-pointer text-fg-faint">Weekly note (model-generated)</summary>
                <p className="text-fg-muted mt-1 whitespace-pre-wrap">{review}</p>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function DreamsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { overview, loading, busy, error, refresh, saveSettings, setAgentEnabled, dreamNow } = useDreaming();

  return (
    <div className="workspace-gutter py-3 space-y-4">
      {!embedded && (
        <div className="flex items-center gap-2">
          <Moon size={13} className="text-fg-subtle" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-fg-muted uppercase tracking-wide flex-1">Dreams</h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            title="Refresh dream status"
            aria-label="Refresh dream status"
            className="p-1 text-fg-subtle hover:text-fg disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading || busy ? "animate-spin" : ""} />
          </button>
        </div>
      )}

      {embedded && (
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || busy}
          className="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
        >
          Refresh dream status
        </button>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20" role="alert">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {loading && !overview && (
        <p className="text-xs text-fg-faint flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading dream status…
        </p>
      )}

      {overview && (
        <>
          {overview.running && (
            <div className="text-[11px] text-fg-muted flex items-center gap-1.5" role="status">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {overview.running.kind === "deep" ? "Deep dream" : "Light dream"} running — started {when(overview.running.started_at)}
            </div>
          )}
          <DreamSettingsEditor settings={overview.settings} busy={busy} onSave={saveSettings} />
          <DreamAgentList
            agents={overview.agents}
            busy={busy}
            onToggle={setAgentEnabled}
            onDream={dreamNow}
          />
          <DreamRunList runs={overview.runs} />
        </>
      )}
    </div>
  );
}
