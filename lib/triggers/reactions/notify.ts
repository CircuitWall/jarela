// ADR-0031 — `reaction.notify`: a watcher reaction script that publishes
// a `task_completed` notification with the watcher's diff preview.
//
// Args provided by the watcher handler at fire time (see
// pollDueWatchers in handlers/watcher.ts):
//   { watcher: { id, label, tool_name, tool_args, agent_id },
//     previous: string | null,
//     current: string,
//     ...userArgs }
//
// User-supplied args (subset that this script reads):
//   { title?: string, level?: "info" | "warning" }
import { registerScript, type ScriptResult } from "@/lib/triggers/scripts";
import { publish as publishNotification } from "@/lib/notifications/bus";

interface NotifyContext {
  watcher?: {
    id?: string;
    label?: string;
    tool_name?: string;
    agent_id?: string;
  };
  previous?: string | null;
  current?: string;
  title?: string;
  level?: "info" | "warning";
}

function shortPreview(previous: string | null | undefined, current: string | undefined): string {
  const cur = (current ?? "").replace(/\s+/g, " ").trim();
  const prev = (previous ?? "").replace(/\s+/g, " ").trim();
  if (!prev) return cur.slice(0, 120);
  // Trivial diff: just show "<prev> → <current>" trimmed at both ends.
  const left = prev.slice(0, 50);
  const right = cur.slice(0, 50);
  return `${left} → ${right}`;
}

registerScript("reaction.notify", async (args: Record<string, unknown>): Promise<ScriptResult> => {
  const ctx = args as NotifyContext;
  const watcher = ctx.watcher ?? {};
  const label = watcher.label ?? "(unknown watcher)";
  const title = (typeof ctx.title === "string" && ctx.title.trim()) || label;
  const preview = shortPreview(ctx.previous, ctx.current);
  // Reuse `task_completed` as the notification surface — the UI already
  // subscribes to it for scheduled-task / agent-prompt firings, and it
  // tolerates an empty thread_id (script firings have no thread).
  publishNotification({
    type: "task_completed",
    task_id: watcher.id ?? "",
    agent_id: watcher.agent_id ?? "",
    prompt: `Watcher "${label}" detected a change.`,
    thread_id: "",
    status: "done",
    preview,
    ts: Date.now(),
  });
  return { preview: `notify: ${title} — ${preview}`.slice(0, 160) };
});
