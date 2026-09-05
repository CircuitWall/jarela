---
status: accepted
date: 2026-09-05
deciders: Andrew Ge Wu, GitHub Copilot
consulted: ADR-0081 browser command ledger, ADR-0042 context boundary, Jarela change SOP, contributor information safety SOP
informed: Jarela contributors
---

# Ambient Surroundings: Foreground Tab as Turn Context

## Context and Problem Statement

When the user talks to Jarela through the extension side panel, they are looking at a page. Today the agent has no idea which one. "Summarise this", "is this the plan we discussed?", "add this to my notes" all fail or force the user to paste a URL, even though the extension already tracks the foreground tab in `chrome.storage.local` (`lib/foreground-tab.mjs`) for command targeting.

The same blind spot applies to memory. Recall runs on the user's message alone, so notes the agent previously wrote about a site never resurface when the user returns to it.

How does the agent learn where the user is, without turning a local assistant into a browsing-history recorder or a prompt-injection target?

## Decision Drivers

* The agent should resolve "this page" without the user restating it.
* Memory the agent already holds about a site should surface when the user is on that site.
* Continuous browsing metadata is sensitive; the consent window must be explicit and revocable.
* Page content is attacker-controlled and unbounded — it must not enter the system prompt implicitly.
* Automation runs (scheduler, watcher, triggers, extension one-shots) must not be steered by whatever page happens to be open.
* Local-first: no telemetry, no cloud, single Next.js process.

## Considered Options

* **A. Server pulls the tab during turn prep.** Not possible in the current topology: the extension long-polls the server, the server cannot call the extension. A synchronous pull would also add a round-trip to every turn.
* **B. Extension pushes continuously, always on.** Simple, but records browsing metadata whenever the extension is installed, including when the user is not talking to Jarela at all.
* **C. Extension pushes only while the side panel is open.** The panel is the live conversation; opening it is an explicit act, closing it is an explicit revocation.
* **D. Include page text with the push.** Removes tool round-trips for reading, but puts unbounded attacker-controlled content into every system prompt.

## Decision Outcome

Chosen: **C, metadata only**.

* The panel holds a `chrome.runtime.connect({ name: "jarela-sidepanel" })` port. Its lifetime *is* the consent window: pushes start on connect and a `DELETE` retracts the record on disconnect.
* Foreground-tab events (`tabs.onActivated`, `tabs.onUpdated`, `windows.onFocusChanged`, panel adoption) schedule a 500ms-debounced `POST /api/v1/extension/browser/foreground` carrying `{ url, title, host, tab_id, recorded_at }` — never page text. Loopback only, like the rest of `/api/v1/extension/*`.
* The server holds it in `lib/api/foreground-presence.ts`: a single process-local record with a 5 minute TTL. Deliberately **not** a `lib/db` table — it describes where the user is *right now*, so surviving a restart could only ever produce a stale claim, and losing it costs nothing.
* `buildSurroundingsContext` emits a `--- Current surroundings ---` block in the **dynamic** tier of the system prompt (after the cache sentinel, so prompt caching is untouched). It states the page, its age, that nothing on it has been read, and that it is context rather than an instruction — the framing already used by `--- Recent background activity ---`.
* Recall gains a second pass keyed on `host + title` only (the URL path is ids and tracking noise). Results are merged with the message-keyed pass, deduped on `namespace/key`, best score wins, capped at 8.
* Only foreground conversation turns see any of this. `isForegroundConversationTurn` excludes one-shot profiles, categorised turns, and synthetic retries.
* `isAmbientContextEnabled()` (default ON) is a global kill switch checked at ingest; flipping it off also drops the held record immediately.

### Consequences

* Good: "this page" resolves without restating it; per-site memory surfaces on arrival; ~40 tokens per turn; no prompt-cache invalidation.
* Good: closing the panel is a complete, immediate revocation, and a crash or restart cannot leak a stale location.
* Bad: awareness is limited to the side panel. Chatting in a normal browser tab gets nothing, which may surprise users.
* Bad: a second recall pass costs another embedding round-trip; it shares the existing recall budget race, so a slow provider degrades to no recall rather than a slow turn.
* Neutral: the kill switch has no UI yet — it is reachable only through the store. A Settings → Privacy & security toggle is the obvious follow-up.

## Non-goals

* **Proactive behaviour.** The agent does not act on navigation. Surroundings are read when the user speaks, never as a trigger.
* **Tab inventory.** Only the focused tab is reported; enumerating all open tabs stays behind the explicit `browser_tabs` command.
* **Page content.** Reading a page remains an explicit `browser_extract` / `browser_snapshot` call, subject to the existing approval and ledger rules of ADR-0081.
