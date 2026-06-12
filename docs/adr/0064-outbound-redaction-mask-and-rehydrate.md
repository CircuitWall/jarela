---
status: "accepted"
date: 2026-06-12
deciders: andwu
---

# Mask-and-rehydrate outbound redaction for sensitive content

## Context and Problem Statement

Today, every byte of every message — including tool outputs containing API keys, personnummer, and bank account numbers — is sent verbatim to whichever LLM provider the agent is configured against (see [models route redaction](../../app/api/v1/models/route.ts), which only masks API responses, not outbound traffic). The only outbound-side filtering is a content-free instruction to the warm-summary agent in [conversation-summary.ts:43-47](../../lib/agents/conversation-summary.ts#L43-L47).

How do we keep clearly-sensitive values (keys, SSNs, account numbers, high-entropy secrets) out of provider traffic while still letting agents *use* those values — e.g. to forward them via a tool call — without seeing them?

## Decision Drivers

* Provider trust boundary: anything sent crosses a network/legal boundary the user did not necessarily intend it to cross.
* Composability: the agent must still be able to pass a sensitive value through a tool (email body, file write, HTTP request) without the model needing to read it.
* User control and transparency: the user must be able to add patterns, see what's masked, and turn the feature off.
* Persistence: existing checkpoint data is on the user's local disk, already covered by [ADR-0005 encrypt-secrets-at-rest](./0005-encrypt-secrets-at-rest.md). Redacting at rest would gain little and break thread resumption across processes (the rehydrate map is in memory).
* Reasoning loss is acceptable: the model losing the ability to validate or transform a masked value is the cost of not sending it.

## Considered Options

* **Pattern redaction only** (drop matches, no rehydrate): simplest, but breaks the "put this key in an email" flow — the tool gets `[REDACTED]` not the real value.
* **LLM-based scrubber** (small model classifies + rewrites): catches semantic PII, but defeats the goal — data has now been sent to *a* model.
* **Format-preserving substitution** (per-installation key, deterministic FPE): replace each secret with a real-looking fake of the same shape, stored in encrypted DB. Cross-thread stable, model gets more structural context. Rejected for v1 — the model treats fakes as real values and may quote, validate, or partially leak them; the fake also reveals length / character class / separator positions to the provider, which is most of the structural information of the original. Re-considerable later via a `placeholder_style` config slot.
* **Mask-and-rehydrate with configurable patterns + entropy heuristic** (this ADR): regex+entropy detection swaps each match for a stable, type-hinted placeholder before the provider call; placeholders are rehydrated to originals before tool execution and before UI render.

## Decision Outcome

Chosen option: **mask-and-rehydrate with a configurable pattern file and high-entropy heuristic**.

### Semantics

* **Outbound:** before [jarela-chat-model.ts:327](../../lib/providers/jarela-chat-model.ts#L327) (`toInvokeMessages`), scan all message content and tool-event payloads. Each match is replaced with a stable token of the form `«SECRET:<id> type=<hint>»`, and the original value is stored in a thread-scoped, in-memory `tokenId → original` map.
* **Inbound — UI:** assistant text streamed to the UI is rehydrated so the user sees the real values they already own.
* **Inbound — tool calls:** **before** a tool executes, every argument is scanned for placeholder tokens and rehydrated. This is the load-bearing piece — it lets the agent compose with values it never saw (e.g. emit a `send_email` tool call whose body contains the placeholder, and the email goes out with the real key).
* **Persistence:** checkpoints store **unmasked** content. Encryption at rest is already provided by ADR-0005 for sensitive namespaces. Masked-at-rest would break resumability across processes and gain little.
* **Stability:** the same source value gets the same token id within a thread, so the model can refer back to "the key from earlier".

### Type hints

The placeholder includes a coarse `type=` hint (`anthropic_api_key`, `personnummer`, `iban`, `unknown_long_string`, …) so the model has enough context to decide what to do with the value without seeing it. Without the hint, `«SECRET:a1b2»` is opaque and unusable.

### Pattern file

User-editable JSON at `~/.jarela/redaction-patterns.json` (consistent with [ADR-0003 sqlite-local-persistence](./0003-sqlite-local-persistence.md) and [ADR-0006 windows-state-dir-localappdata](./0006-windows-state-dir-localappdata.md) state-dir conventions). Hot-reloadable on file change. Each entry:

```json
{
  "name": "swedish_personnummer",
  "regex": "\\b(?:\\d{2})?\\d{6}[-+]\\d{4}\\b",
  "type_hint": "personnummer",
  "validator": "luhn",
  "enabled": true
}
```

`validator` references a built-in named function (`luhn`, `mod97`, `personnummer_check`). Arbitrary code from the JSON file is **not** executed — keeps the trust model of an editable config simple.

### Default pattern set (v1)

| Class | Pattern | Validator |
|---|---|---|
| Anthropic API key | `sk-ant-[A-Za-z0-9_-]{20,}` | — |
| OpenAI API key | `sk-(?:proj-)?[A-Za-z0-9_-]{20,}` | — |
| AWS access key | `AKIA[0-9A-Z]{16}` | — |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{36,}` | — |
| JWT | `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | — |
| PEM block | `-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----` | — |
| Bearer header | `Bearer\s+[A-Za-z0-9._~+/=-]{20,}` | — |
| US SSN | `\b\d{3}-\d{2}-\d{4}\b` | — |
| Swedish personnummer | `\b(?:\d{2})?\d{6}[-+]\d{4}\b` | luhn |
| IBAN | `\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b` | mod97 |
| Swedish bankgiro | `\b\d{3,4}-\d{4}\b` | luhn |
| Swedish plusgiro | `\b\d{2,8}-\d\b` | luhn |

### High-entropy heuristic

Catches unknown-shape secrets (random IDs, opaque tokens) the pattern set misses. Same file, separate `heuristics` block:

```json
{
  "heuristics": {
    "high_entropy": {
      "enabled": true,
      "min_length": 32,
      "min_entropy": 4.0,
      "char_class": "[A-Za-z0-9_=+/.-]",
      "exclude_patterns": [
        "^[a-f0-9]{40}$",
        "^[a-f0-9]{64}$",
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        "^[0-9A-HJKMNP-TV-Z]{26}$",
        "^[a-z]{2,8}_[A-Za-z0-9]{14,}$"
      ]
    }
  }
}
```

The `exclude_patterns` allowlist is required: without it, every git SHA, sha256 hash, and UUID in tool output gets masked, which destroys git/CI/build agents. Default allowlist includes git SHAs (40-hex, 64-hex), UUIDs, ULIDs (Crockford base32, 26 chars), and prefixed framework IDs (`cus_…`, `pi_…`, `gid_…`, etc.).

### Field-name allowlist for structured tool output

Pattern + entropy scanning runs over raw text. For tool results that come back as JSON (most MCP and built-in tools), the mask layer walks the structure and **skips values whose key matches the allowlist** instead of regex-scanning them. Default allowlist:

```json
{
  "field_name_allowlist": [
    "id", "_id", "uuid", "guid", "node_id",
    "run_id", "job_id", "task_id", "thread_id", "message_id",
    "sha", "commit", "commit_sha", "tree_sha", "parent_sha",
    "url", "uri", "href", "self", "html_url", "api_url"
  ]
}
```

Raw-text tool output (CLI stdout, file reads, prose) keeps the regex+entropy path with the `exclude_patterns` allowlist above.

### Global toggle

A single global setting (`redaction.enabled`, default `true`) in the existing settings store, exposed in the settings UI. When off, no scanning, no masking, no rehydrate. Not per-agent — keeps the mental model simple and the trust boundary uniform across the app.

### Transparency in the UI

A core trust requirement: the user must be able to see, per message, **what was held back from the LLM**. Without this, the feature is a black box and users have no way to confirm it's working.

Concretely:

* The masker returns a structured summary alongside the masked text: `Array<{ type_hint: string, count: number }>` per outbound payload (one for the user message, one per tool event).
* The summary is persisted on the message / tool-event record (small, type-only — it does **not** store the redacted values; those already live unmasked in the checkpoint).
* The chat UI renders a shield indicator on any message that had redactions, with a tooltip listing the type counts:

  > 🛡 Held back from the LLM: 1 anthropic_api_key, 1 swedish_personnummer

* The user sees their actual values in chat (rehydrate-at-render handles this); the shield is the only visible affordance that something was masked on the wire.
* Tool-event panels get the same indicator on the tool's input and output sides.

This gives users a continuous, in-conversation signal that the feature is active, without requiring them to inspect logs or open a settings page.

### Effect on tool usage

Most tool ID flows still work because rehydrate-on-tool-args handles passthrough. If `list_runs` returns `run_id: "01HQX7K3J9V8N2M5P6R4T1Y3W8"` and the model emits `get_run(run_id: "«SECRET:a1b2»")`, rehydrate substitutes the real ID before the tool executes — the chain works, the model just never sees the bytes. Same-token-per-source-value within a thread lets the model refer back to "the same run" consistently.

What stops working:

* **Constructing strings by splicing parts of the value** — substring extraction, custom URL paths that don't take the value verbatim. Workable if the model emits the placeholder inside a larger string; broken if it tries to pull out a prefix or suffix.
* **Reading semantic content** — ULID timestamp prefix, Stripe object-type prefix, JIRA project key from the ticket ID, last-4-digits style operations.
* **Comparing values by similarity** across a list — model can't tell two masked entries apart except by token id.

Mitigations: the field-name allowlist lets common ID fields pass through unchanged, and the entropy heuristic's `exclude_patterns` covers common ID shapes (UUID, ULID, hashes, framework-prefixed IDs). Pure-numeric IDs (database PKs, run numbers) already pass the entropy threshold (max entropy of `[0-9]` is `log2(10) ≈ 3.32` < 4.0).

### Consequences

* **Good:** sensitive values stop leaving the process. The agent can still use them through tools by reference.
* **Good:** users can extend coverage by editing one file; no code changes for new patterns.
* **Good:** UI users see real values in chat; experience is unchanged when nothing matches.
* **Bad — accepted:** the model cannot validate, transform, partial-match, or reason over masked content (`"is this key valid?"`, `"what year is this person born?"` stop working).
* **Bad — accepted:** false negatives are guaranteed. The pattern set + entropy heuristic is high-precision, not exhaustive. Users running through novel formats need to add patterns.
* **Bad — accepted:** false positives in tool output (long random-looking IDs that aren't secrets) get masked too. The exclude allowlist is the relief valve.
* **Operational:** rehydrate-on-tool-args is mandatory — a missed rehydrate path means tools execute with placeholders and break silently. Insertion site discipline matters.

## Pros and Cons of the Options

### Pattern redaction only (no rehydrate)

* Good, simple to implement.
* Bad, breaks the "use it via a tool" flow — defeats half the value.

### LLM-based scrubber

* Good, catches semantic PII the regex set will never see.
* Bad, sends the data to a model — defeats the goal unless the scrubber runs locally, which is out of scope.
* Bad, non-deterministic; harder to debug what was redacted.

### Format-preserving substitution

* Good, the model gets values that look real, so length-sensitive operations and string construction work without special handling.
* Good, deterministic per-installation key gives stable masks across threads and process restarts without an in-memory map.
* Bad, the model thinks the fake is real and may try to validate, "rotate", or partially quote it ("the key starts with sk-ant-FA…") — partial fakes don't rehydrate, so the fake leaks.
* Bad, the fake reveals length, character class, and separator positions to the provider — most of the structural information of the original.
* Bad, FPE per pattern requires per-alphabet primitives (FF1/FF3) and is materially more complex to implement and test than a token map.

### Mask-and-rehydrate (chosen)

* Good, preserves tool composition.
* Good, configurable and transparent.
* Good, placeholder syntax is a clear signal to the model that the value is opaque, reducing risk of validation/manipulation attempts.
* Neutral, requires a stable in-memory token map per thread; map is dropped on process restart, which is fine because the canonical source (the unmasked checkpoint) is on disk.
* Bad, more moving parts than dumb redaction; rehydrate insertion sites must be exhaustive.

## More Information

* Existing related work: [ADR-0005 encrypt-secrets-at-rest](./0005-encrypt-secrets-at-rest.md), [ADR-0023 external-tool-secrets](./0023-external-tool-secrets.md), [ADR-0038 tool-capability-axis](./0038-tool-capability-axis.md).
* Insertion sites in code (for the implementation PR):
  * Outbound mask: between [run-thread.ts:292](../../lib/agents/run-thread.ts#L292) and [jarela-chat-model.ts:327](../../lib/providers/jarela-chat-model.ts#L327).
  * Inbound rehydrate (UI): assistant text emitted from `streamWithConfig` in [jarela-chat-model.ts](../../lib/providers/jarela-chat-model.ts).
  * Inbound rehydrate (tool args): in the tool-dispatch path before tool `invoke`.
* Out of scope for this ADR: per-tool redaction policy (e.g. "rehydrate for local file write but block for outbound HTTP"). Future ADR if needed.
