import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { getDueTasks, markTaskRan, type ScheduledTaskRow } from "@/lib/stores/scheduled-tasks";
import { publish as publishNotification } from "@/lib/notifications/bus";

const POLL_INTERVAL_MS = 30_000;

// Pin scheduler state to globalThis so the timer survives Next.js dev hot-
// reload. Without this, every code edit re-evaluates this module, the
// `started` flag resets to false, the active setInterval handle is lost
// (the underlying Node timer keeps running but nothing references it
// anymore), and the next call to startScheduler() ALSO sees a fresh module
// scope so it tries to start again — sometimes succeeding, sometimes not,
// always confusing.
interface SchedulerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
}
const g = globalThis as unknown as { __langgui_scheduler?: SchedulerState };
if (!g.__langgui_scheduler) {
  g.__langgui_scheduler = { started: false, timer: null, running: false };
}
const state = g.__langgui_scheduler;

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

  const prepared = await prepareThreadRun(thread.thread_id, task.prompt);

  let assistantContent = "";
  for await (const chunk of prepared.stream) {
    if (chunk.type === "text_delta") {
      assistantContent += (chunk.data.delta as string) ?? "";
    }
    if (chunk.type === "done" || chunk.type === "error") break;
  }
  persistAssistantMessage(thread.thread_id, assistantContent);
  markTaskRan(task.id, task.kind, task.schedule);
  publishNotification({
    type: "task_completed",
    task_id: task.id,
    agent_id: task.agent_id,
    prompt: task.prompt,
    thread_id: thread.thread_id,
    status: "done",
    preview: assistantContent.replace(/\s+/g, " ").trim().slice(0, 120),
    ts: Date.now(),
  });
}
