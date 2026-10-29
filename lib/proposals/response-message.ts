import type { PendingAction } from "@/api/types";

export function buildProposalResponseMessage(action: Pick<PendingAction, "id" | "kind" | "status">): string {
  return `I responded to proposal ${JSON.stringify(action.id)} (${action.kind}); its recorded status is ${action.status}. Read check_proposal for the saved result and continue the original task within its existing permissions. Do not repeat an applied change; a choice response does not approve any separate change.`;
}
