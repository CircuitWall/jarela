import type { PendingAction } from "@/api/types";

export function buildProposalResponseMessage(action: Pick<PendingAction, "id" | "kind" | "status">): string {
  return `I responded to proposal ${JSON.stringify(action.id)} (${action.kind}); its recorded status is ${action.status}.
1. Read check_proposal for the saved result and original question/options, not the most recent question in chat.
2. Reconcile this response with intervening chat and the user's latest instructions. Continue only still-relevant work; do not revive cancelled or superseded tasks. If relevance is unclear, acknowledge the saved response and clarify in chat.
3. A denied/dismissed request is not an answer; do not assume a choice or automatically ask it again.
4. Do not repeat an applied change; a choice response does not approve any separate change.`;
}
