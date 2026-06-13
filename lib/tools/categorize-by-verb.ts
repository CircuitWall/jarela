/**
 * Auto-categorize a tool's safety bucket from its verb.
 *
 * Mental model (Jira-flavored):
 *
 *   READ    — see things; no state change
 *             (get, list, search, view, fetch, describe, …)
 *   WRITE   — modify content / data scoped to your own object
 *             (create, edit, update, delete-of-content, move, log, …)
 *   EXECUTE — workflow transitions, project-level config, shared infra,
 *             or external side-effects on others
 *             (transition, resolve, schedule, generate, restart, exec, …)
 *
 * Tool naming convention in this repo and most LangChain packages is
 * `[subject_]verb[_object]`, e.g. `calendar_create_event`,
 * `documents_search`, `tool_result_get`. We tokenize on `_`, scan
 * left-to-right, and return the bucket of the first verb we recognize.
 *
 * If no token matches a known verb, we fall back to `"execute"` — the
 * most-restricted bucket — so an unknown / opaque package errs on the
 * side of caution rather than silently auto-approving.
 *
 * The heuristic is intentionally simple and stable: callers (manifest
 * loaders, test audits, UI badges) get a deterministic answer they can
 * override per-tool when the verb is genuinely ambiguous (`set` =
 * field-set vs config-set, `delete` = comment vs filesystem, etc.).
 */
import type { Capability } from "./registry";

// "See things" — pure inspection, no state change.
const READ_VERBS = new Set([
  "get", "list", "read", "search", "view", "find", "fetch", "query",
  "describe", "show", "lookup", "check", "stat", "glob", "grep", "peek",
  "inspect", "snapshot", "screenshot", "extract", "status", "ls", "cat",
  "head", "tail", "diff", "preview", "render",
]);

// "Change content" — mutate fields/data scoped to the caller's own object.
// Jira mental model: "Add Comment", "Edit Issue", "Delete Attachment",
// "Move Issues" all live here even though some are destructive — the
// distinction is *content* vs *workflow / project structure*.
const WRITE_VERBS = new Set([
  "create", "add", "write", "edit", "update", "modify", "set", "put",
  "patch", "append", "prepend", "insert", "rename", "move", "copy",
  "mkdir", "touch", "draft", "comment", "annotate", "vote", "save",
  "store", "log", "upload", "attach", "link", "unlink", "tag", "untag",
  "label", "unlabel", "reindex", "index", "delete", "remove", "trash",
  "drop", "clear", "reset", "undo",
]);

// "Do workflow / project-level / external side-effects" — transitions,
// shared infrastructure, anything that affects others or burns external
// resources (network calls that drive remote browsers, paid API quota,
// process restarts).
const EXECUTE_VERBS = new Set([
  "exec", "execute", "run", "shell", "spawn", "invoke", "call",
  "transition", "resolve", "close", "reopen", "release", "deploy",
  "publish", "schedule", "cancel", "bulk", "propose", "approve",
  "reject", "restart", "stop", "start", "install", "uninstall",
  "configure", "manage", "init", "trigger", "send", "delegate",
  "generate", "synthesize", "transcribe", "translate",
  // browser automation: every action drives a real external page.
  "navigate", "click", "fill", "scroll", "type", "press", "hover",
]);

/**
 * Map a tool name to its capability bucket using verb tables. Returns
 * `"execute"` if no token in the name is a recognized verb — callers
 * may pass an explicit override for ambiguous names (`set_env_var`,
 * `file_delete`, etc.).
 */
export function categorizeByVerb(toolName: string): Capability {
  const tokens = toolName.toLowerCase().split(/[_\-]/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (READ_VERBS.has(token)) return "read";
    if (WRITE_VERBS.has(token)) return "write";
    if (EXECUTE_VERBS.has(token)) return "execute";
  }
  return "execute";
}

/** @internal — exposed for tests so the corpus stays in sync with reality. */
export const _VERB_TABLES = {
  read: READ_VERBS,
  write: WRITE_VERBS,
  execute: EXECUTE_VERBS,
} as const;
