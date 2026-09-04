---
status: accepted
date: 2026-09-04
deciders: Andrew Ge Wu, GitHub Copilot
consulted: Chrome extension permission guidance, Jarela change SOP, contributor information safety SOP
informed: Jarela contributors
---

# Persist Sanitized Browser Command Ledger

## Context and Problem Statement

Jarela's browser extension is becoming a first-class runtime surface: agents can read pages, take screenshots, navigate tabs, fill forms, and focus browser tabs. Users need a visible account of what the agent did in the browser and a way to retry safe failed actions, but browser commands can involve private pages, form values, screenshots, cookies, account pages, and documents.

How should Jarela persist browser command history without turning local browser automation into a sensitive data sink?

## Decision Drivers

* Browser control must be auditable from the Jarela UI.
* Persistence must go through `lib/db` or `lib/stores`; no ad-hoc state files.
* Command history must not store raw page text, screenshots, cookies, tokens, passwords, or full form values.
* Retry must be constrained to safe command classes and explicit user intent.
* The design must preserve the single-Next.js-process browser command queue.
* The implementation must remain local-first with no telemetry or analytics.

## Considered Options

* No persisted ledger; keep only transient UI state.
* Persist full command payloads and results.
* Persist sanitized command metadata plus a safe retry payload for eligible commands.

## Decision Outcome

Chosen option: "Persist sanitized command metadata plus a safe retry payload for eligible commands", because it gives users auditability and practical recovery while avoiding storage of page bodies, screenshots, cookies, and form values.

### Consequences

* Good, because the browser panel can show recent actions, status, timing, host, target tab, and error category across refreshes.
* Good, because safe actions such as tab listing, tab activation, navigation, snapshot, extract, scroll, screenshot, and click can be retried from user intent.
* Good, because form-fill values are never persisted, so failed fill commands are visible but not replayable from stored secrets.
* Bad, because retry is incomplete for high-risk commands and form submissions; users may need to rerun those from the chat flow.
* Bad, because the ledger adds a small SQLite table and cleanup responsibility.

## Pros and Cons of the Options

### No Persisted Ledger

* Good, because it stores no additional browser metadata.
* Good, because it has the smallest implementation surface.
* Bad, because users cannot answer "what did the agent just do?" after refresh or service-worker churn.
* Bad, because retry/recovery has no durable anchor.

### Persist Full Command Payloads and Results

* Good, because replay and debugging would be straightforward.
* Bad, because fill values, page extracts, screenshot references, selectors, private URLs, and result bodies can expose user data.
* Bad, because it conflicts with Jarela's information-safety posture.

### Persist Sanitized Metadata and Safe Retry Payloads

* Good, because it preserves user visibility without retaining raw browser content.
* Good, because retry remains possible for non-secret actions.
* Neutral, because some metadata such as host, URL path, selector, and error text may still be sensitive; values must be truncated and redacted.
* Bad, because it requires careful tests around sanitization and retry eligibility.

## More Information

Related:

* ADR-0018 browser extension page capture
* ADR-0065 image attachments as disk refs
* ADR-0079 tool result references and spill lifecycle
* Jarela contributor information safety SOP
