import type {
  AutomationActivityDisposition,
  AutomationActivityMetadata,
  AutomationActivitySource,
  AutomationActivityState,
} from "@/api/types";
import { getDb } from "@/lib/db";
import { addMessage, touchThread, type MessageRow } from "@/lib/stores/threads";

export interface CreateAutomationActivityInput {
  threadId: string;
  sourceKind: AutomationActivitySource;
  sourceId: string;
  label: string;
  state?: AutomationActivityState;
  detail?: string;
}

export interface UpdateAutomationActivityInput {
  state?: AutomationActivityState;
  disposition?: AutomationActivityDisposition;
  preview?: string;
  error?: string;
  detail?: string;
}

export function listRecentMaterialAutomationActivities(
  threadId: string,
  limit = 8,
): AutomationActivityMetadata[] {
  if (limit <= 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT metadata FROM messages
       WHERE thread_id=? AND metadata IS NOT NULL
         AND instr(metadata, '"automation_activity"') > 0
       ORDER BY rowid DESC
       LIMIT 100`,
    )
    .all(threadId) as Array<{ metadata: string }>;
  const material = rows
    .map((row) => parseActivity(row.metadata))
    .filter((activity): activity is AutomationActivityMetadata => (
      activity?.state === "complete"
      && (
        activity.disposition === "action"
        || activity.disposition === "needs_approval"
        || activity.disposition === "failed"
      )
    ));
  return material.slice(0, limit);
}

function now(): string {
  return new Date().toISOString();
}

function activityContent(activity: AutomationActivityMetadata): string {
  if (activity.state === "queued") return `${activity.label}: queued`;
  if (activity.state === "checking") return `${activity.label}: checking`;
  switch (activity.disposition) {
    case "action": return `${activity.label}: action taken`;
    case "no_action": return `${activity.label}: no action needed`;
    case "needs_approval": return `${activity.label}: needs approval`;
    case "failed": return `${activity.label}: failed`;
    case "cancelled": return `${activity.label}: cancelled`;
    case "expired": return `${activity.label}: expired`;
    default: return `${activity.label}: complete`;
  }
}

function parseActivity(raw: string | null | undefined): AutomationActivityMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { automation_activity?: AutomationActivityMetadata };
    const activity = parsed?.automation_activity;
    if (
      activity?.version !== 1
      || typeof activity.source_id !== "string"
      || typeof activity.source_kind !== "string"
    ) {
      return null;
    }
    return activity;
  } catch {
    return null;
  }
}

function getActivityMessage(messageId: string): MessageRow | null {
  const row = getDb()
    .prepare(
      "SELECT msg_id, thread_id, role, content, created_at, tool_events, category, metadata FROM messages WHERE msg_id=?",
    )
    .get(messageId);
  return (row as MessageRow | undefined) ?? null;
}

function writeActivity(messageId: string, activity: AutomationActivityMetadata): void {
  getDb()
    .prepare("UPDATE messages SET content=?, metadata=? WHERE msg_id=?")
    .run(
      activityContent(activity),
      JSON.stringify({ automation_activity: activity }),
      messageId,
    );
}

export function createAutomationActivity(input: CreateAutomationActivityInput): MessageRow {
  const timestamp = now();
  const activity: AutomationActivityMetadata = {
    version: 1,
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    label: input.label,
    state: input.state ?? "checking",
    occurrence_count: 1,
    first_at: timestamp,
    last_at: timestamp,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  const row = addMessage(
    input.threadId,
    "assistant",
    activityContent(activity),
    null,
    input.sourceKind,
    { automation_activity: activity },
  );
  touchThread(input.threadId);
  return row;
}

export function updateAutomationActivity(
  messageId: string,
  patch: UpdateAutomationActivityInput,
): MessageRow | null {
  const row = getActivityMessage(messageId);
  const existing = parseActivity(row?.metadata);
  if (!row || !existing) return null;
  const activity: AutomationActivityMetadata = {
    ...existing,
    ...patch,
    last_at: now(),
  };
  writeActivity(messageId, activity);
  touchThread(row.thread_id);
  return getActivityMessage(messageId);
}

function collapseNoAction(messageId: string): MessageRow | null {
  const currentRow = getActivityMessage(messageId);
  const current = parseActivity(currentRow?.metadata);
  if (!currentRow || !current || current.disposition !== "no_action") return currentRow;

  const priorRows = getDb()
    .prepare(
      `SELECT msg_id, thread_id, role, content, created_at, tool_events, category, metadata
       FROM messages
       WHERE thread_id=? AND rowid < (SELECT rowid FROM messages WHERE msg_id=?)
       ORDER BY rowid DESC
       LIMIT 50`,
    )
    .all(currentRow.thread_id, currentRow.msg_id) as unknown as MessageRow[];

  let priorRow: MessageRow | null = null;
  let prior: AutomationActivityMetadata | null = null;
  for (const row of priorRows) {
    const activity = parseActivity(row.metadata);
    if (!activity) break;
    if (
      activity.source_kind === current.source_kind
      && activity.source_id === current.source_id
      && activity.disposition === "no_action"
    ) {
      priorRow = row;
      prior = activity;
    }
    break;
  }
  if (!priorRow || !prior) return currentRow;

  const merged: AutomationActivityMetadata = {
    ...prior,
    state: "complete",
    disposition: "no_action",
    occurrence_count: prior.occurrence_count + current.occurrence_count,
    last_at: current.last_at,
    detail: current.detail ?? prior.detail,
    preview: current.preview ?? prior.preview,
  };

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE messages SET content=?, created_at=?, metadata=? WHERE msg_id=?").run(
      activityContent(merged),
      currentRow.created_at,
      JSON.stringify({ automation_activity: merged }),
      priorRow!.msg_id,
    );
    db.prepare("DELETE FROM messages WHERE msg_id=?").run(messageId);
    db.prepare(
      "UPDATE threads SET message_count=MAX(0, message_count-1), updated_at=? WHERE thread_id=?",
    ).run(merged.last_at, currentRow.thread_id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getActivityMessage(priorRow.msg_id);
}

export function finalizeAutomationActivity(
  messageId: string,
  input: Omit<UpdateAutomationActivityInput, "state"> & {
    disposition: AutomationActivityDisposition;
  },
): MessageRow | null {
  const row = updateAutomationActivity(messageId, {
    ...input,
    state: "complete",
  });
  if (!row || input.disposition !== "no_action") return row;
  return collapseNoAction(messageId);
}
