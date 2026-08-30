export type WorkflowItemStatus = "pending" | "checking" | "done" | "needs_attention" | "skipped";

export interface WorkflowItem<Action extends string = string> {
  id: string;
  label: string;
  status: WorkflowItemStatus;
  reason: string;
  affected_files: string[];
  action?: Action;
}

export interface WorkflowState<Phase extends string = string, Item extends WorkflowItem = WorkflowItem> {
  phase: Phase | null;
  checklist: Item[];
  summary?: string;
  error?: string | null;
}

export interface WorkflowProgressUpdate<Phase extends string = string> {
  phase?: Phase | null;
  item_id?: string;
  status?: WorkflowItemStatus;
  summary?: string;
  error?: string | null;
}

export interface WorkflowProgressResult<State> {
  state: State;
  updated_item_id: string | null;
}

function shouldPreserveCompleted(current: WorkflowItemStatus, next: WorkflowItemStatus): boolean {
  return current === "done" && (next === "pending" || next === "checking");
}

export function startWorkflow<State extends WorkflowState, Phase extends string>(
  state: State,
  phase: Phase,
): State {
  return { ...state, phase };
}

export function updateWorkflowItem<State extends WorkflowState>(
  state: State,
  itemId: string,
  status: WorkflowItemStatus,
): State {
  let found = false;
  const checklist = state.checklist.map((item) => {
    if (item.id !== itemId) return item;
    found = true;
    if (shouldPreserveCompleted(item.status, status)) return item;
    return { ...item, status };
  });
  if (!found) throw new Error(`Workflow item "${itemId}" not found`);
  return { ...state, checklist };
}

export function completeWorkflow<State extends WorkflowState, Phase extends string>(
  state: State,
  phase: Phase,
): State {
  return {
    ...state,
    phase,
    checklist: state.checklist.map((item) => (
      item.status === "pending" || item.status === "checking"
        ? { ...item, status: "done" as const }
        : item
    )),
  };
}

export function mergeWorkflowProgress<State extends WorkflowState>(
  state: State,
  update: WorkflowProgressUpdate,
): WorkflowProgressResult<State> {
  let next: State = state;
  let updatedItemId: string | null = null;

  if (Object.prototype.hasOwnProperty.call(update, "phase")) {
    next = { ...next, phase: update.phase ?? null };
  }
  if (update.item_id || update.status) {
    if (!update.item_id || !update.status) {
      throw new Error("Workflow item progress requires both item_id and status");
    }
    next = updateWorkflowItem(next, update.item_id, update.status);
    updatedItemId = update.item_id;
  }
  if (Object.prototype.hasOwnProperty.call(update, "summary")) {
    next = { ...next, summary: update.summary ?? "" };
  }
  if (Object.prototype.hasOwnProperty.call(update, "error")) {
    next = { ...next, error: update.error ?? null };
  }

  return { state: next, updated_item_id: updatedItemId };
}