export const ACTION_OPERATION_VERBS = [
  "read",
  "write",
  "execute",
  "send",
  "schedule",
  "delete",
  "propose",
] as const;

export const ACTION_STATUS_LABELS = [
  "performed",
  "proposed",
  "blocked",
  "failed",
  "not_performed",
] as const;

/** Fallback segments for external/MCP tools without declared capabilities. */
export const WRITE_TOOL_NAME_SEGMENTS = [
  "write", "edit", "create", "update", "delete", "move", "copy", "mkdir",
  "add", "insert", "patch", "post", "put", "send", "publish", "save",
  "upload", "transition", "rank", "merge", "set", "schedule", "cancel",
] as const;

export function isWriteToolNameSegment(segment: string): boolean {
  return (WRITE_TOOL_NAME_SEGMENTS as readonly string[]).includes(segment);
}

export const ACTION_CLAIM_VERBS = [
  "patched", "edited", "wrote", "ran", "verified", "created", "deleted",
  "updated", "committed", "saved", "added", "removed", "fixed", "applied",
  "installed", "configured", "renamed", "moved", "copied", "pushed", "merged",
  "checked", "confirmed", "tested",
] as const;

export const WRITE_CLAIM_VERBS = [
  "patched", "edited", "wrote", "created", "deleted", "updated", "committed",
  "saved", "added", "removed", "fixed", "applied", "installed", "configured",
  "renamed", "moved", "copied", "pushed", "merged", "completed",
] as const;

export const STALL_TAIL_PHRASES = [
  "one moment", "one sec", "one second", "hold on", "just a moment", "bear with me",
  "let me check", "let me verify", "let me continue", "let me proceed", "let me look",
  "working on it", "continuing now", "proceeding now", "moving on",
] as const;

export const STALL_NOW_ACTION_VERBS = [
  "writing", "saving", "creating", "updating", "deleting", "adding", "appending",
  "generating", "drafting", "pushing", "sending", "posting", "moving", "copying",
  "renaming", "editing", "regenerating",
] as const;

export function formatStallLanguageInstruction(): string {
  return `Avoid ending a turn with an unfinished promise such as ${STALL_TAIL_PHRASES.join(", ")}, or narrating ${STALL_NOW_ACTION_VERBS.join(", ")} ... now; invoke the tool instead.`;
}

export function formatActionVocabularyInstruction(): string {
  return [
    `Use only these operation labels when describing work: ${ACTION_OPERATION_VERBS.join(", ")}.`,
    `Use only these status labels when reporting work: ${ACTION_STATUS_LABELS.join(", ")}.`,
    "Use read for search, lookup, inspect, and retrieve; write for create, update, edit, configure, and save; execute for running commands or code; send for messages and external submissions; schedule for future work; delete for removal; propose for approval-gated changes.",
    "Use blocked when permission, confirmation, or setup prevents the attempt; failed when the tool was invoked but returned an error; not_performed when no action was attempted.",
    "Do not invent synonyms, new operation names, or broader vocabulary.",
  ].join(" ");
}
