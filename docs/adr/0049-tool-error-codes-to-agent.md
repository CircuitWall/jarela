---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Surface tool error codes as first-class fields on `tool_result`

## Context and Problem Statement

ADR-0047 added a `ToolResult` discriminated union with a stable `code` so tools can signal recoverable failures (`tool_timeout`, `invalid_args`, `unknown_tool`, etc.) instead of opaque error strings. ADR-0048 wrapped every registered tool through that dispatch so the agent loop's hot path also produces the union.

What didn't follow: the **agent** doesn't actually see the code. The pipeline today is:

1. Tool returns `{kind:"error", code:"tool_timeout", message}`.
2. `dispatch` logs it; LangChain's tool executor stringifies the legacy-shape return into the next `ToolMessage.content`.
3. `lib/agents/llm.ts:228-237` JSON-parses that string and yields `{type:"tool_result", data:{id, name, result}}`.
4. The agent's next turn sees `result` as a structured JSON blob — but the LLM has no signal that this blob represents an error, and certainly no instruction telling it which `code` it just saw or how to react to that code.

So the model frequently retries the same failing call ("rate-limited again — let me try the same args"), or claims success after seeing an error envelope ("I've successfully looked up the issue" when the tool actually returned `http_401`).

The chat UI has the same problem. `ToolList`'s `isErrorPayload()` heuristic looks for the substring `"error"` in the payload — sometimes right, sometimes wrong, and never able to render code-specific affordances (retry, "open settings", etc.) because no code is exposed at the chunk boundary.

## Decision Drivers

* **The LLM needs a stable signal to branch on.** Pattern-matching prose error messages from N tools doesn't scale; one stable code per failure mode does.
* **The chat UI needs the same signal.** Both client and server consumers of `tool_result` should branch on the same source of truth.
* **Don't break the existing payload contract.** `result` stays exactly as it is today; the new fields are *additive* and optional.
* **Cover legacy tools too.** Atlassian/GitHub/etc. predate ADR-0047 and emit `{error, code?}` envelopes; the new code must read both shapes.

## Considered Options

* **(A) Inject a synthetic `[error_code: X]` prefix into `ToolMessage.content`.** Easy. Pollutes the tool's data with prompt-engineering text the model has to ignore in the success case. Fragile.
* **(B) Pass the code through the agent's tool-name (e.g. rename the call to `tool_name__error_x`).** Hacky and breaks LangGraph's downstream assumptions about tool identity.
* **(C) Promote `error_code` and `error_message` to first-class fields on the `tool_result` chunk.** Schema change. Both the LLM-facing system prompt and the chat UI consume the chunk; both can branch on the new fields. The original payload stays untouched.

## Decision Outcome

Chosen: **(C) First-class fields on `tool_result`**.

`ToolResultPayloadSchema` (in `lib/agents/stream-chunk-schema.ts`) now has optional `error_code` + `error_message`. `lib/agents/llm.ts` extracts them via `extractToolError(result)` (a tiny helper in `lib/agents/tool-error.ts` that reads either the PR-4 union or the legacy `{error, code}` envelope) and adds them to the chunk when present.

A new `--- Tool error playbook ---` section is appended to every system prompt teaching the agent how to react to each code (don't retry timeouts blindly, fix `invalid_args` once before retrying, surface auth errors to the user instead of looping, etc.).

### Consequences

* Good — the LLM can now branch on `error_code` instead of pattern-matching error strings.
* Good — the chat UI can render code-specific affordances on tool errors (retry / open-settings / dismiss) without parsing payloads.
* Good — backward compatible: `result` is unchanged; consumers that ignore the new fields keep working.
* Good — the playbook is additive; it doesn't conflict with harness-specific anti-fabrication rules.
* Bad — the playbook adds ~25 lines (~100 tokens) of overhead to every system prompt. Acceptable: it's flat overhead that rides outside the tier budget, and the cost is dwarfed by even one avoided retry of a failing tool call.
* Bad — `extractToolError` reads two shapes (union + legacy). PR-B will retire the legacy shape across all tools; once that lands, the legacy branch can be removed.

## Pros and Cons of the Options

### (C) First-class fields (chosen)

* Good — explicit at the boundary; no string-parsing in consumers.
* Good — composable with existing schema (zod just gains two optional fields).
* Good — lets the chat UI surface specific actions per code without speculative payload parsing.
* Neutral — adds two optional fields to the chunk type. Negligible wire size.

### (A) Inject prefix into ToolMessage content

* Good — zero schema change.
* Bad — pollutes the data the LLM is supposed to operate on.
* Bad — every consumer needs to learn to strip the prefix.

### (B) Encode into tool name

* Good — the LLM already pays attention to tool names.
* Bad — breaks LangGraph's tool-by-name dispatch and the entire downstream UI.

## Implementation notes

* `lib/agents/tool-error.ts` exports `extractToolError(payload)` returning `{code, message} | null`. Reads PR-4 union, legacy envelope, returns null on success shapes.
* `lib/agents/llm.ts` (ToolMessage handler): calls `extractToolError(result)` and spreads `error_code`/`error_message` onto the chunk's `data` when present.
* `lib/agents/stream-chunk-schema.ts`: `ToolResultPayloadSchema` gains optional `error_code` + `error_message`. The flat `SSEEventSchema` inherits via `.extend(...).shape`, so client consumers see the same fields.
* `lib/agents/prepare/system-prompt.ts`: new `buildToolErrorPlaybook()` block appended to every system prompt. Lives in the system prompt, not the harness, so every harness benefits.
* The chat UI consumption of these fields lands in the upcoming PR-D (client error card + retry).
* Cross-references: ADR-0044 (schema as boundary contract), ADR-0047 (ToolResult union), ADR-0048 (agent-loop wrap that ensures every tool call lands here).
