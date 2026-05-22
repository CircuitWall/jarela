---
status: accepted
date: 2026-05-22
deciders: example-user
consulted:
informed:
---

# Capture web page context via a Chrome MV3 extension that POSTs to Jarela

## Context and Problem Statement

The user often wants to feed Jarela the content of a page they're already
looking at — a doc, a ticket, a forum thread — so the agent can answer
questions about it. Pasting URLs into chat works for public pages but
breaks down for authenticated content (intranet, gated docs, internal
tools) and is awkward when the user only wants *one section* of a long
page rather than the whole thing.

We want a way for the user to mark "this exact piece of the page is
context for Jarela" with one click, without giving any party other than
Jarela itself access to that content.

## Decision Drivers

* **Explicit consent per capture.** Nothing leaves the browser tab without
  an explicit user gesture. No background scraping. No "auto-attach the
  current tab on every message." The user has to opt in each time.
* **Single-process invariant** — the existing constraint that Jarela is a
  single Next.js process must hold (see [[adr-0011]]). The extension runs
  in the browser, not as a daemon.
* **Loopback-only data path.** The captured payload travels exclusively
  over `127.0.0.1` to the Jarela process. No relay servers, no analytics.
* **Zero state on the wire that the agent can't pull again.** Agent
  context lives in threads (already persisted by Jarela). The extension
  is a transport, not a store.
* **Survives the browser killing the service worker.** MV3 service
  workers get killed after ~30s idle. The design must not assume a
  persistent connection.

## Considered Options

* **A — Push-only with element picker.** Toolbar icon → enters picker
  mode → user clicks a DOM element → POST `{url, title, selector, text}`
  to Jarela → content appended to the default agent's most-recent thread.
* **B — Bidirectional WebSocket; agent-pulled `read_active_tab` tool.**
  Extension keeps a WS open to Jarela; agent's tool call fans out a
  request to the active tab; content script replies. Tool returns the
  page text to the model.
* **C — Auto-push on tab focus.** Extension POSTs the current tab's
  `document.body.innerText` whenever it gains focus or the URL changes.
  Jarela caches "latest active page" and the agent has a `read_page`
  tool that returns the cache.

## Decision Outcome

Chosen option: **A — push-only with element picker.**

The element picker concentrates the win: the user selects exactly the
subtree they care about (a single answer in a Stack Overflow thread, a
specific code block, one cell of a table) so the agent gets the *right*
context, not the page boilerplate. One round trip per capture. No
connection state. Survives any browser/SW restart trivially because each
capture is an independent POST.

### Consequences

* **Good** — pure HTTP. No WS framing, no SW lifecycle to fight, no
  long-poll bookkeeping. The MV3 service worker only needs a low-frequency
  `chrome.alarms` heartbeat to track Jarela's reachability.
* **Good** — surgical context. Picking a `<pre>` block keeps the LLM
  context window from getting blown by sidebars, navs, footers.
* **Good** — explicit-per-capture consent removes the privacy footgun of
  option C. The user has to *want* each piece of context to leave the tab.
* **Good** — single-process invariant preserved. The extension is a
  client of Jarela, not a peer process.
* **Bad** — the agent cannot pull a specific tab on demand. If the
  conversation later needs a different element, the user has to capture
  again. Acceptable for v1; option B is the upgrade path if and when a
  real "agent pulls" use case appears.
* **Bad** — `proxy.ts` currently rejects any POST whose `Origin` header
  doesn't match `Host` (CSRF / DNS-rebinding defense), and a content
  script's `Origin` is `chrome-extension://<id>`. The page-capture route
  needs an explicit carve-out from that origin check.
* **Bad** — no pairing token in v1. Anything else on the user's loopback
  can POST to `/api/v1/page-capture`. Same trust level as the rest of
  the v1 surface — loopback is the security boundary today. If we add
  pairing later (e.g., per-extension token), the contract is unchanged;
  the route just gains an `Authorization` check.

## Pros and Cons of the Options

### A — Push-only with picker

* Good — minimal moving parts; matches existing v1 HTTP surface.
* Good — surgical capture (user picks the element).
* Bad — no agent-initiated read.

### B — WS + agent pull

* Good — agent can decide when to read; supports "summarize whatever's
  open right now" without prior user action.
* Bad — MV3 service worker death keeps killing the WS; needs keepalive
  + reconnect machinery.
* Bad — adds a real protocol to design (request id, timeout, error
  shapes) where option A has none.
* Bad — implicit context. Agent can read the page without the user
  having marked anything as relevant — privacy-hostile.

### C — Auto-push on focus

* Good — zero clicks; agent has fresh context whenever the user
  switches tabs.
* Bad — sends every page the user looks at to Jarela by default. Even
  for a single-user local app, this is the wrong default.
* Bad — captures *whole pages*, blowing context budgets.
* Bad — multi-tab cache ambiguity (which tab is "current"?).

## Server contract — final

`POST /api/v1/page-capture`

Request body (zod-validated):

```ts
{
  url: string,                  // page URL
  title?: string,               // <title>, ≤500 chars
  selector?: string,            // CSS path of picked element, ≤2000 chars
  tagName?: string,             // e.g. "DIV", "PRE"
  text: string,                 // innerText of picked element
  capturedAt: string,           // ISO-8601 timestamp
}
```

Response:

```ts
{
  thread_id: string,
  msg_id: string,
  agent_id: string,
  agent_name: string,
  thread_title: string | null,
  created_thread: boolean,
  truncated: boolean,
  originalBytes: number,
}
```

Behaviour:

1. Reject non-loopback hosts with 403.
2. Truncate `text` to 100KB UTF-8; signal truncation to caller and embed
   a `> ⚠ Truncated` warning in the appended message body.
3. **Pick the target thread:** the most recently updated thread *of the
   default agent*. If the default agent has no threads, create a fresh
   one under it. If there is no default agent (fresh install), fall back
   to the first configured agent. With zero agents configured, return
   503. Scoping to the default agent — rather than "most recent thread
   of any agent" — keeps routing predictable: a stray reply on agent B
   does not silently retarget future captures.
4. Append the capture as a `user` message in that thread.
5. `publish` a `thread_message_added` event (carrying `thread_id` +
   `agent_id`) so the open web UI re-fetches without polling.
6. Return the picked thread's metadata so the extension's success banner
   can name where the capture landed.

## Reload / lifecycle

* Background service worker uses `chrome.alarms` (15s period) to
  heartbeat `GET /api/v1/health`. Toolbar icon + tooltip reflect the
  last health result. No persistent connection; if the SW gets killed
  the alarm revives it.
* Content script is injected on demand via `chrome.scripting.executeScript`
  when the toolbar icon is clicked. Idempotent — re-injection is a no-op.

## Out of scope

* **Pairing token / extension authentication.** Loopback is the v1
  boundary. Add a per-extension token if the surface ever opens beyond
  loopback (e.g., tailnet capture from a phone browser).
* **iframe and shadow-DOM picking.** v1 picker only walks the top-level
  document tree.
* **Firefox port.** Firefox's MV3 implementation differs slightly
  (`browser.*` namespace, different SW model). Add a small shim later.
* **Server → extension channel.** No agent-initiated reads. Revisit if
  option B's use case emerges.
* **Thread picker in extension popup.** Default-agent / most-recent
  heuristic is the v1 choice; the response includes the picked thread's
  agent + title so the success banner can name where the capture landed.
* **Auto-trigger agent run with a default prompt.** Capture lands as a
  user message and waits for the user's follow-up question.

## More Information

* Server route: `app/api/v1/page-capture/route.ts` (thin wrapper) +
  `lib/api/page-capture.ts` (handler logic, tested).
* Origin carve-out: `proxy.ts`.
* Bus event: `lib/notifications/bus.ts` — adds `thread_message_added`.
* Extension: `browser-extension/` (MV3, load-unpacked).
