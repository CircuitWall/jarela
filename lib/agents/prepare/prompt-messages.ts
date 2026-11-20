// The prompt's user turn, assembled in exactly one place.
//
// It used to be spread across three: the hot history window (DB rows filtered by
// scope, transcript status and budget), the `include_hot: false` override that
// rebuilt the list from the request message, and the retry nudge appended after
// both. Each could drop the current turn, and nothing checked the result before
// the provider call — so a run could ask the model with a system prompt and no
// user content at all. Observed symptom: four consecutive turns on one thread
// answered "no request came through with this turn" while the user's messages
// sat in the database, with `message_usage.hot_tokens = 0` (see ADR-0126).
//
// Two invariants replace the convention:
//   1. The message list ends with a user turn carrying the current request.
//   2. A list without non-empty user text is a hard error, never a provider call.

import type { ContentPart } from "@/lib/tools/runtime/types";

export interface PromptTurn {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export class EmptyPromptError extends Error {
  readonly code = "empty_turn";
  constructor(message: string) {
    super(message);
    this.name = "EmptyPromptError";
  }
}

export interface AssemblePromptInput {
  /** History as the window resolved it; ignored when `includeHot` is false. */
  hotHistory: readonly PromptTurn[];
  /** False when the turn's profile asks for no thread history. */
  includeHot: boolean;
  /** This turn's user content (already spilled to refs when it had attachments). */
  currentContent: string | ContentPart[];
  /** Retry-only nudge: visible to the model for this attempt, never persisted. */
  extraUserContext?: string | ContentPart[];
}

export interface AssembledPrompt {
  messages: PromptTurn[];
  /** Where the current request entered the prompt. */
  currentTurnSource: "history" | "injected" | "profile";
  /** True when history was requested but did not carry the current turn. */
  recoveredFromEmptyWindow: boolean;
}

/** Text of a message, ignoring non-text parts (images carry no instructions). */
export function promptTurnText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function assemblePromptMessages(input: AssemblePromptInput): AssembledPrompt {
  const history = input.includeHot ? [...input.hotHistory] : [];
  const currentText = promptTurnText(input.currentContent);
  const tail = history[history.length - 1];
  const alreadyPresent = currentText.trim() !== ""
    && tail?.role === "user"
    && promptTurnText(tail.content).trim() === currentText.trim();

  let currentTurnSource: AssembledPrompt["currentTurnSource"];
  if (alreadyPresent) {
    currentTurnSource = "history";
  } else {
    history.push({ role: "user", content: input.currentContent });
    currentTurnSource = input.includeHot ? "injected" : "profile";
  }
  if (input.extraUserContext !== undefined) {
    history.push({ role: "user", content: input.extraUserContext });
  }

  const hasUserText = history.some(
    (message) => message.role === "user" && promptTurnText(message.content).trim() !== "",
  );
  if (!hasUserText) {
    throw new EmptyPromptError(
      "This turn has no user content to answer: the request message is empty and no stored user message could be recovered.",
    );
  }

  return {
    messages: history,
    currentTurnSource,
    recoveredFromEmptyWindow: input.includeHot && currentTurnSource === "injected",
  };
}
