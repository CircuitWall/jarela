import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { collectStream } from "@/lib/agents/stream-collector";
import { getDueTasks, markTaskRan, type ScheduledTaskRow } from "@/lib/stores/scheduled-tasks";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { indexAllSources } from "@/lib/documents/indexer";

const POLL_INTERVAL_MS = 30_000;
// Sweep document sources every Nth tick. 20 ticks × 30s = 10 min, which
// matches typical "I edited a file, ask Jarela about it" patience. PR-D
// upgrades this to event-driven fs watching.
const DOC_SWEEP_EVERY_TICKS = 20;

interface SchedulerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  tickCount: number;
}
const state = getOrCreateGlobal<SchedulerState>("__jarela_scheduler", () => ({
  started: false,
  timer: null,
  running: false,
  tickCount: 0,
}));

// Idempotent — call repeatedly; only the first call starts the loop.
export function startScheduler(): void {
  if (state.started) return;
  state.started = true;
  setImmediate(() => { void tick(); });
  state.timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

export function stopScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.started = false;
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const due = getDueTasks();
    for (const task of due) {
      try {
        await runTask(task);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] task ${task.id} failed:`, msg);
        markTaskRan(task.id, task.kind, task.schedule, msg);
        publishNotification({
          type: "task_completed",
          task_id: task.id,
          agent_id: task.agent_id,
          prompt: task.prompt,
          thread_id: "",
          status: "error",
          preview: "",
          error: msg,
          ts: Date.now(),
        });
      }
    }

    // Document-RAG reindex sweep (ADR-0024). Polled here until PR-D wires
    // an fs watcher. Failures are logged but never block the tick.
    state.tickCount = (state.tickCount + 1) % DOC_SWEEP_EVERY_TICKS;
    if (state.tickCount === 0) {
      try {
        await indexAllSources();
      } catch (err) {
        console.error(
          "[scheduler] document index sweep failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } finally {
    state.running = false;
  }
}

async function runTask(task: ScheduledTaskRow): Promise<void> {
  const agent = getAgentConfig(task.agent_id);
  if (!agent) {
    const err = `Agent "${task.agent_id}" not found`;
    markTaskRan(task.id, task.kind, task.schedule, err);
    publishNotification({
      type: "task_completed", task_id: task.id, agent_id: task.agent_id,
      prompt: task.prompt, thread_id: "", status: "error", preview: "", error: err, ts: Date.now(),
    });
    return;
  }
  const thread = getOrCreateAgentThread(task.agent_id);

  const silent = task.silent === 1;
  // Silent mode: wrap the prompt with a "reply only if material" directive
  // AND a NO_REPLY sentinel so the post-run code can drop the assistant
  // turn entirely when nothing is worth surfacing. Visibility itself is
  // handled at the chat-panel layer via the category-filter toolbar —
  // scheduler firings are always tagged `scheduled_task` so users can
  // hide them en masse without losing the audit trail.
  const effectivePrompt = silent
    ? `${task.prompt}\n\n[SILENT_TASK] This prompt was triggered by a scheduled task running quietly. Reply with information only if there is something material the user needs to see right now. If nothing material to report, reply with exactly the single token NO_REPLY and nothing else.`
    : task.prompt;

  const prepared = await prepareThreadRun(
    thread.thread_id,
    effectivePrompt,
    undefined,
    undefined,
    undefined,
    undefined,
    "scheduled_task", // userCategory
  );

  const collected = await collectStream(prepared.stream);
  // Silent + NO_REPLY (or empty content) -> skip persisting the assistant
  // turn. The user prompt remains for audit purposes. Otherwise persist
  // tagged `scheduled_task` so the chat-panel filter can group firings.
  const replyText = collected.assistantContent.trim();
  const isNoReply = silent && /^\s*NO[_ ]?REPLY\b/i.test(replyText);
  const skipAssistant = silent && (isNoReply || replyText.length === 0);
  if (!skipAssistant) {
    persistAssistantMessage(
      thread.thread_id,
      collected.assistantContent,
      collected.usedTools,
      collected.toolEvents,
      "scheduled_task",
    );
  }
  markTaskRan(task.id, task.kind, task.schedule);
  publishNotification({
    type: "task_completed",
    task_id: task.id,
    agent_id: task.agent_id,
    prompt: task.prompt,
    thread_id: thread.thread_id,
    // Silent + NO_REPLY surfaces as "skipped" so the notification stream
    // can choose not to ping the user.
    status: skipAssistant ? "skipped" : "done",
    preview: skipAssistant
      ? ""
      : collected.assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
    ts: Date.now(),
  });
}

// Public wrapper so a "Run now" UI button can trigger the same code path
// the cron scheduler uses. Catches errors itself so the HTTP layer just
// awaits and reports completion.
export async function runScheduledTaskNow(task: ScheduledTaskRow): Promise<void> {
  try {
    await runTask(task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markTaskRan(task.id, task.kind, task.schedule, msg);
    publishNotification({
      type: "task_completed",
      task_id: task.id,
      agent_id: task.agent_id,
      prompt: task.prompt,
      thread_id: "",
      status: "error",
      preview: "",
      error: msg,
      ts: Date.now(),
    });
    throw err;
  }
}
