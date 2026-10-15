// Workflow-step contract enforcement. Every workflow_progress step promises
// an input, an output, and a validation check; a model can still end a turn
// with a rejected update, a step left mid-flight, or a step whose validation
// failed. This module detects those breaches from the turn's own tool results
// (code, not model judgement) and builds the targeted auto-retry nudge.

/** Total attempts per step: the original attempt plus two automatic retries. */
export const WORKFLOW_STEP_MAX_ATTEMPTS = 3;
export const WORKFLOW_STEP_AUTO_RETRIES = WORKFLOW_STEP_MAX_ATTEMPTS - 1;
/** Hard cap on automatic workflow retries in one turn, across all steps. */
export const WORKFLOW_TURN_AUTO_RETRY_LIMIT = 6;

export interface WorkflowProgressObservation {
  args: unknown;
  result: unknown;
}

export interface WorkflowStepFailure {
  key: string;
  workflowId: string;
  itemId: string | null;
  label: string;
  reason: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value === "string") {
    try { return asObject(JSON.parse(value)); } catch { return null; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as JsonObject;
    // LangChain ToolMessage-ish wrappers carry the JSON string in `content`
    // or `kwargs.content`.
    if (obj.workflow_id === undefined) {
      // invoke_tool envelope: { ok, tool, status, result }.
      if (obj.tool === "workflow_progress" && obj.result !== undefined) return asObject(obj.result);
      const kwargs = asPlainObject(obj.kwargs);
      const content = obj.content ?? kwargs?.content;
      if (typeof content === "string") return asObject(content);
    }
    return obj;
  }
  return null;
}

function asPlainObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalizes a direct workflow_progress call or an invoke_tool proxy of one. */
export function workflowProgressArgs(name: string, args: unknown): JsonObject | null {
  const obj = asPlainObject(args);
  if (!obj) return null;
  if (name === "workflow_progress") return obj;
  if (name === "invoke_tool" && obj.name === "workflow_progress") {
    const inner = obj.args_json ?? obj.args;
    return asObject(inner);
  }
  return null;
}

function labelFor(itemId: string | null, items: unknown): string {
  if (!itemId) return "workflow update";
  if (Array.isArray(items)) {
    for (const raw of items) {
      const item = asPlainObject(raw);
      if (item?.id === itemId && str(item.label)) return str(item.label)!;
    }
  }
  return itemId.replace(/[_-]/g, " ");
}

function rejectedItemId(args: JsonObject | null): string | null {
  if (!args) return null;
  if (str(args.item_id)) return str(args.item_id);
  if (Array.isArray(args.items)) {
    for (const raw of args.items) {
      const item = asPlainObject(raw);
      if (item?.status === "done" && !str(item.validation_evidence) && str(item.id)) return str(item.id);
    }
  }
  return null;
}

/**
 * Returns the contract breaches still standing at the end of the turn, in
 * the order the workflows were last touched. A later accepted update for the
 * same workflow clears an earlier rejection.
 */
export function collectWorkflowContractFailures(observations: readonly WorkflowProgressObservation[]): WorkflowStepFailure[] {
  type Entry = {
    rejected: { itemId: string | null; label: string; error: string } | null;
    checklist: unknown[];
    phase: string | null;
    error: string | null;
    needsUser: Set<string>;
  };
  const latest = new Map<string, Entry>();
  for (const { args, result } of observations) {
    const payload = asObject(result);
    const callArgs = asPlainObject(args);
    const workflowId = str(payload?.workflow_id) ?? str(callArgs?.workflow_id);
    if (!workflowId) continue;
    const previous: Entry = latest.get(workflowId) ?? { rejected: null, checklist: [], phase: null, error: null, needsUser: new Set<string>() };
    latest.delete(workflowId);
    if (payload?.ok === false) {
      const itemId = rejectedItemId(callArgs);
      latest.set(workflowId, {
        ...previous,
        rejected: {
          itemId,
          label: labelFor(itemId, callArgs?.items ?? previous.checklist),
          error: str(payload.error) ?? "the update was rejected",
        },
      });
      continue;
    }
    const state = asPlainObject(payload?.state);
    const needsUser = new Set(previous.needsUser);
    const updatedItemId = str(callArgs?.item_id);
    if (updatedItemId) {
      if (callArgs?.needs_user === true) needsUser.add(updatedItemId);
      else needsUser.delete(updatedItemId);
    }
    latest.set(workflowId, {
      rejected: null,
      checklist: Array.isArray(state?.checklist) ? state.checklist : previous.checklist,
      phase: typeof state?.phase === "string" ? state.phase : null,
      error: str(state?.error),
      needsUser,
    });
  }

  const failures: WorkflowStepFailure[] = [];
  for (const [workflowId, entry] of latest) {
    if (entry.rejected) {
      const { itemId, label, error } = entry.rejected;
      failures.push({
        key: `${workflowId}:${itemId ?? "*"}`,
        workflowId,
        itemId,
        label,
        reason: `workflow_progress rejected the update: ${error}`,
      });
      continue;
    }
    if (entry.phase === "complete") continue;
    for (const raw of entry.checklist) {
      const item = asPlainObject(raw);
      const itemId = str(item?.id);
      if (!item || !itemId || item.needs_user === true || entry.needsUser.has(itemId)) continue;
      const label = str(item.label) ?? itemId;
      if (item.status === "checking") {
        failures.push({
          key: `${workflowId}:${itemId}`,
          workflowId,
          itemId,
          label,
          reason: "the step was started but the turn ended before its output was validated",
        });
      } else if (item.status === "needs_attention") {
        const why = entry.error;
        failures.push({
          key: `${workflowId}:${itemId}`,
          workflowId,
          itemId,
          label,
          reason: `the step's validation did not pass (needs_attention${why ? `: ${why}` : ""})`,
        });
      }
    }
  }
  return failures;
}

/** Splits failures into those with automatic retries left and those exhausted. */
export function planWorkflowStepRetries(
  failures: readonly WorkflowStepFailure[],
  spent: Readonly<Record<string, number>> = {},
): { retry: Array<WorkflowStepFailure & { attempt: number }>; exhausted: WorkflowStepFailure[] } {
  const retry: Array<WorkflowStepFailure & { attempt: number }> = [];
  const exhausted: WorkflowStepFailure[] = [];
  for (const failure of failures) {
    const used = spent[failure.key] ?? 0;
    if (used < WORKFLOW_STEP_AUTO_RETRIES) retry.push({ ...failure, attempt: used + 2 });
    else exhausted.push(failure);
  }
  return { retry, exhausted };
}

export function workflowStepRetryInstruction(workflowId: string, itemId: string | null, label: string): string {
  if (!itemId) {
    return `Resend the \`workflow_progress\` update for workflow \`${workflowId}\` so it satisfies the contract.`;
  }
  const progressUpdate = workflowId === "version_adoption"
    ? `Call \`workflow_progress\` with \`workflow_id: "version_adoption"\`, \`item_id: "${itemId}"\`, and \`status: "checking"\``
    : `Call \`workflow_progress\` for workflow \`${workflowId}\` with the complete items snapshot, setting this step to \`checking\``;
  return `${progressUpdate}, then redo "${label}" from its stated input and run its validation again. Finally mark it \`done\` with newly observed \`validation_evidence\`, or \`needs_attention\` with the reason.`;
}

export function buildWorkflowStepRetryNudge(retries: ReadonlyArray<WorkflowStepFailure & { attempt: number }>): string {
  const lines = retries.map((failure) => (
    `- "${failure.label}" in \`${failure.workflowId}\` (attempt ${failure.attempt} of ${WORKFLOW_STEP_MAX_ATTEMPTS}): ${failure.reason}. ${workflowStepRetryInstruction(failure.workflowId, failure.itemId, failure.label)}`
  ));
  return [
    `↻ Auto-retry: ${retries.length === 1 ? "a workflow step has" : `${retries.length} workflow steps have`} not met the step contract (input → output → validation):`,
    ...lines,
    "Work only on these steps and leave the others unchanged. Do not reuse earlier evidence or claim a result you did not observe. If a step is genuinely paused for the user's approval or input, mark it `needs_attention` with `needs_user: true` and say what you need instead of retrying.",
  ].join("\n");
}
