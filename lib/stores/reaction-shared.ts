// Shared reaction-discriminator helpers for the watcher (ADR-0031) and
// scheduled-task (ADR-0032) stores. Both schemas use the same
// `reaction_kind` / `reaction_script` / `reaction_script_args` triple, so
// validation lives here and is imported by both.

import { isReactionScript, REACTION_SCRIPT_PREFIX } from "@/lib/triggers/scripts";

export type ReactionKind = "agent_prompt" | "script";

const MAX_REACTION_PROMPT_CHARS = 4000;
const MAX_REACTION_SCRIPT_ARGS_CHARS = 4000;

/**
 * Normalise a reaction-prompt input into the value we store. Treats
 * undefined / null / whitespace-only as "no override" → NULL. Throws when
 * the prompt exceeds 4000 characters (the firing-prompt budget).
 */
export function normaliseReactionPrompt(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw new Error("reaction_prompt must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_REACTION_PROMPT_CHARS) {
    throw new Error(
      `reaction_prompt must be <= ${MAX_REACTION_PROMPT_CHARS} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Validate a reaction-script name: must start with the `reaction.` prefix
 * AND be registered in the in-process script registry. Validated at write
 * time so a bad name is rejected by the agent tool / HTTP route, not by
 * the scheduler tick.
 */
export function validateReactionScript(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("reaction_script must be a non-empty string");
  }
  const trimmed = name.trim();
  if (!trimmed.startsWith(REACTION_SCRIPT_PREFIX)) {
    throw new Error(
      `reaction_script must begin with "${REACTION_SCRIPT_PREFIX}" — got "${trimmed}"`,
    );
  }
  if (!isReactionScript(trimmed)) {
    throw new Error(`reaction_script "${trimmed}" is not registered`);
  }
  return trimmed;
}

/**
 * Normalise reaction-script args into a JSON-encoded string suitable for
 * the DB column. undefined / null → NULL. Anything else must be a plain
 * object that JSON-encodes to <= 4000 chars.
 */
export function normaliseReactionScriptArgs(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("reaction_script_args must be a JSON object");
  }
  const json = JSON.stringify(input);
  if (json.length > MAX_REACTION_SCRIPT_ARGS_CHARS) {
    throw new Error(
      `reaction_script_args JSON must be <= ${MAX_REACTION_SCRIPT_ARGS_CHARS} chars (got ${json.length})`,
    );
  }
  return json;
}

export interface ResolvedReaction {
  kind: ReactionKind;
  prompt: string | null;
  script: string | null;
  scriptArgs: string | null;
}

/**
 * Apply the discriminated-union rules for the reaction columns:
 *   kind='script'        → prompt forced NULL; script + scriptArgs validated.
 *   kind='agent_prompt'  → script + scriptArgs forced NULL; prompt normalised.
 * Centralised so create/update paths in both stores share one source of
 * truth for the union semantics.
 */
export function resolveReaction(input: {
  reaction_kind?: ReactionKind;
  reaction_prompt?: string | null;
  reaction_script?: string | null;
  reaction_script_args?: Record<string, unknown> | null;
}): ResolvedReaction {
  const kind: ReactionKind = input.reaction_kind ?? "agent_prompt";
  if (kind === "script") {
    if (!input.reaction_script) {
      throw new Error("reaction_kind='script' requires reaction_script");
    }
    return {
      kind,
      prompt: null,
      script: validateReactionScript(input.reaction_script),
      scriptArgs: normaliseReactionScriptArgs(input.reaction_script_args ?? null),
    };
  }
  return {
    kind,
    prompt: normaliseReactionPrompt(input.reaction_prompt),
    script: null,
    scriptArgs: null,
  };
}
