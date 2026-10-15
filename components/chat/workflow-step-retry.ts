import { createContext, useContext } from "react";

export interface WorkflowStepRetryRequest {
  workflowId: string;
  itemId: string;
  label: string;
}

/** Sends a retry request for one workflow step; null when the surface cannot send messages. */
export const WorkflowStepRetryContext = createContext<((request: WorkflowStepRetryRequest) => void) | null>(null);

export function useWorkflowStepRetry() {
  return useContext(WorkflowStepRetryContext);
}

export function workflowStepRetryMessage({ workflowId, itemId, label }: WorkflowStepRetryRequest): string {
  const progressUpdate = workflowId === "version_adoption"
    ? `Call \`workflow_progress\` with \`workflow_id: "version_adoption"\`, \`item_id: "${itemId}"\`, and \`status: "checking"\``
    : `Call \`workflow_progress\` for workflow \`${workflowId}\` with the complete items snapshot, setting this step to \`checking\``;
  return [
    `Retry workflow step "${label}" (item \`${itemId}\`) in workflow \`${workflowId}\`.`,
    `${progressUpdate}, then redo the step from its stated input and run its validation again.`,
    "Finally mark it `done` with newly observed `validation_evidence`, or `needs_attention` with the reason. Leave the other steps unchanged.",
  ].join(" ");
}
