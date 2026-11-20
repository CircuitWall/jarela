# ADR-0123: Agent browser interaction — reliable, fast read and write

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0018](./0018-browser-extension-page-capture.md) (extension,
loopback capture), [ADR-0081](./0081-browser-command-ledger.md) (sanitized
command ledger), ADR-0082 (ambient surroundings), ADR-0083 (visible-target
approval gate), [ADR-0065](./0065-image-attachments-as-disk-refs.md) and
ADR-0079 (file refs / spill lifecycle), ADR-0090 (`view_attachment` limits).

## Context

The extension already drives the user's own browser through ten typed tools
(`browser_navigate`, `browser_click`, `browser_fill`, `browser_fill_many`,
`browser_scroll`, `browser_screenshot`, `browser_extract`, `browser_snapshot`,
`browser_tabs`, `browser_activate_tab`) executed by
`chrome.scripting.executeScript` in the top frame, with a sanitized ledger,
per-host approvals, and an on-tab control banner.

Two properties now dominate user-visible quality: **reliability** (an action
either happens or reports why not) and **speed** (steps per task, model turns
per task). Both are measurable in the local ledger, and both are worse than the
industry reference implementations (Anthropic's browser toolset, Claude in
Chrome, ChatGPT's browser, Playwright MCP).

### Evidence from the local development ledger

`browser_command_log` held 48,368 commands between 2026-09-04 and 2026-11-05.
The volume is dominated by a repeatable local harness (including a scripted
driver that sent a 1000 ms budget), so these are *direction*, not user
telemetry:

| Command | Succeeded | Failed | Failure rate | Dominant cause |
| --- | --- | --- | --- | --- |
| `fill` | 529 | 1091 | 67.3% | 100% "no element matched" |
| `navigate` | 1587 | 1591 | 50.1% | 1060 timed out at the caller's 1 s budget; 530 "tab crashed" |
| `screenshot` | 1038 | 518 | 33.3% | 100% capture denied (target tab not the focused active tab) |
| `snapshot` | 7854 | 543 | 6.5% | 540 "tab crashed" |
| `click` | 18851 | 1004 | 5.1% | 504 no match, 499 timed out before the extension picked it up |
| `extract`, `tabs`, `scroll`, `fill_many`, `activate_tab` | — | ~0 | <0.5% | — |

The causes are structural, not model behaviour:

1. **Selectors go stale between observation and action.** The server resolves a
   cached `handle`/`role+name` into a CSS string, then ships that string into a
   DOM that has re-rendered. Every `fill` failure and half of the `click`
   failures are this.
2. **Navigation, dialogs and crashes have no representation.** A tab that
   crashes, a `confirm()`/`beforeunload` prompt, or a client-side route change
   produces a timeout rather than an outcome. 5,849 ledger rows are stranded in
   `running` with no terminal state.
3. **Screenshots can only ever work on the focused active tab**, because
   `activeTab` + `chrome.tabs.captureVisibleTab` require exactly that. The
   pinned/background targets the agent is told to use are the ones that fail.
4. **Every action is its own model turn.** Successful commands cost 17–32 ms
   each; only `click` costs more (335 ms average, from the 300 ms DOM-idle
   settle plus snapshot). The transport is cheap — the round trip through the
   model is the cost, and the current surface forces one per step.

### What the reference implementations do

* **Anthropic browser toolset** exposes 27 default members plus 4 opt-in ones
  (`read_console`, `read_network`, `javascript_exec`, `file_upload`) over one
  `browser_toolset_20260801` entry. Reads return an accessibility tree where
  every element carries a `[ref_N]` tag; actions take either a
  `{type: "ref"}` target or a viewport coordinate, with refs preferred and
  coordinates the documented fallback for canvas and cross-origin content. A
  turn with several member calls is a *batch*: run in order, stop at the first
  failure, answer the rest with `Not executed: an earlier action in this turn
  failed.` Tab management returns a `browser_state` block. Security lives in the
  executor: scheme-allowlisted navigation, host allowlists re-checked after
  redirects, human confirmation of consequential actions per call, and the
  risky members off by default.
* **Claude Code with the Claude in Chrome extension** opens its own tabs in a
  per-session tab group, shares login state, pauses on login/CAPTCHA so the
  human can take over, and calls a `browser_batch` tool.
* **ChatGPT** runs a cloud browser with its own profile, site permission modes,
  a secure credential form the model never sees, and human takeover; its browser
  extension and built-in browser both offer an explicit "Developer mode" with
  full CDP access behind approval, plus confirmation before consequential
  actions.
* **Playwright MCP** is "fast and lightweight… accessibility tree, not
  pixel-based input… deterministic tool application", and its own README now
  recommends CLI + skills over MCP for coding agents because loading tool
  schemas and verbose trees is expensive.
* **OpenAI's current computer-use guidance** goes the other way and ships a
  single `exec_js` tool over a persistent Playwright page rather than granular
  click tools.

## Decision Drivers

* A failed action must report a cause the agent can act on, never a timeout.
* A multi-step workflow must not cost one model turn per DOM interaction.
* The agent's observation must be enough to decide the next step in one call.
* Screen coordinates must not become the primary interaction model.
* Safety keeps its current shape: per-host grants, visible interruption,
  sanitized ledger. No new authority is implied by faster execution.
* Anything added must be inspectable and reversible by the user — no cloud
  browser, no unattended second process.
* Local-only: no telemetry, no required cloud calls beyond the configured model
  provider.

## Considered Options

* **A. Keep the current surface, tune timeouts and prompts.**
* **B. Adopt a single code-execution channel** (`exec_js`-style) like current
  OpenAI guidance.
* **C. Keep typed commands, move resolution into the page, add batching and an
  opt-in CDP capability layer, and make screenshots model-visible.**
* **D. Replace the extension with a bundled Playwright/headless browser.**

## Decision Outcome

Chosen option: **C**, because it fixes the measured failure classes at their
root, removes most round trips without giving up per-action approval and
auditability, and adds browser-level access only where `executeScript` cannot
express the operation.

### D1 — Locators resolve against the live page

The extension maintains a per-tab node registry (page-side, keyed by an injected
symbol) and hands out refs scoped to `(tab_id, document generation)`. A command
carries the ref, or `role` + `name`, or a selector; the extension resolves in
this order at execution time: registry ref → accessible-name match → selector.

A miss triggers exactly one automatic re-snapshot and re-resolve, then returns
`{ ok: false, error, candidates: [...], hint }` with the closest accessible-name
matches. The server no longer converts handles into CSS before dispatch, so a
re-render between observation and action cannot invalidate the target.

Stale refs answer with an explicit instruction to re-read, mirroring the
reference contract: `ref_3 is stale or not found on the current page. Re-read
the page to get fresh references.`

### D2 — The page model is a text-bearing accessibility tree

`browser_snapshot` returns an indented accessibility tree with role, accessible
name, state, and ref, plus page text, under these controls:

* `filter: "interactive" | "text" | "all"` (default `interactive`)
* `depth` cap (default 15)
* `ref` to scope the read to a subtree
* hard 50,000-character cap with an explicit truncation notice

Hidden elements never enter the tree. `browser_extract` keeps its current
contract (raw `text`/`html`/`outerHTML` with offsets) because it answers a
different question: the tree is for deciding what to do, the extract is for
quoting content. The existing 5-minute cache stays, but keyed per tab.

### D3 — One batch command with expectations

New command type `batch`. It carries an ordered list of steps, each a
discriminant of the existing command shapes plus an optional `expect`:

* `{ selector }` — element appears
* `{ text }` — visible text appears
* `{ url }` — location matches
* `{ network_idle }` — no in-flight requests for N ms
* `{ time }` — fixed pause (bounded)

The whole list runs inside one poll/result round trip. Execution stops at the
first failed step or unmet expectation; remaining steps answer
`Not executed: an earlier action in this step list failed.` A step that requires
approval stops the batch and surfaces the prompt rather than running the rest
unattended. The result carries per-step status plus one final `diff`.

`browser_batch` is exposed as a tool and is the documented default for
multi-step work.

### D4 — Explicit waiting

`browser_wait({ for: selector | text | url | network_idle | time, timeout_ms })`
replaces ad-hoc `wait_for_selector` parking on `navigate`. Post-action
auto-snapshot keeps its 300 ms quiet / 2 s ceiling settle for single actions; a
batch settles once at the end unless a step's `expect` requires earlier
observation.

### D5 — Navigation and tab lifecycle

`browser_navigate` accepts a URL or `back` | `forward` | `reload`; `new_tab` and
`close_tab` join the tab members. The executor rejects any scheme other than
`http`/`https` by parsing the URL (not prefix matching), and re-checks the
host against the same allow/deny decisions after redirects.

### D6 — Dialogs are data

`alert`, `confirm`, `prompt`, and `beforeunload` are reported as a command
result instead of blocking or silently disappearing. Default policy dismisses
and reports. The agent can answer with `browser_dialog({ accept, prompt_text })`.
A navigation the agent itself requested never waits on `beforeunload`.

### D7 — Trusted input where synthetic input cannot work

`hover`, `key` (single key, chord, or space-separated sequence with `repeat`),
`double_click`, `select_option`, and `drag` are added. Execution order is
synthetic first (`executeScript`, no extra permission) and trusted second
(CDP `Input.*`) when a synthetic action produced no observable DOM change and
the target is covered or pointer-sensitive.

### D8 — CDP is an opt-in capability layer, attached narrowly

`debugger` is an **optional** permission, not part of the base manifest. It
unlocks exactly four things that `executeScript` cannot express:

* dialog interception (D6)
* trusted input (D7)
* capture of a non-focused tab
* per-frame observation for iframes and console/network reads

Rules:

* Granted per site through the existing approval store, surfaced as its own
  grant next to page control. Denying CDP leaves every other tool working.
* Attached lazily for the duration of one command and detached in a `finally`;
  never held while the user is idle.
* Every CDP-backed command passes the same target gate, risk classifier,
  banner, and ledger as today. The ledger gains `transport: "scripting" | "cdp"`.
* Chrome displays its debugging infobar while attached, and DevTools cannot be
  open on the same tab. Both are documented in the extension README and the
  Browser panel.

### D9 — Screenshots become model-visible through the provider contract

Today every provider adapter stringifies tool output, so `browser_screenshot`
returns a URL the model cannot see. The provider message contract is extended so
a tool result may carry image parts, mapped per adapter: Anthropic `tool_result`
content blocks, OpenAI function-call output image content, Gemini inline data.

Constraints:

* Screenshots remain a fallback observation channel for layout, canvas, charts,
  and confirmation — text extraction stays the source of truth for reading.
* One image per action at most, downscaled to the model's image limits, stored
  as a file ref (ADR-0065/0079) so the URL still serves the UI.
* If an adapter cannot carry images in tool results, the tool degrades to URL +
  explicit "you cannot see this image" text rather than pretending.

Anthropic's `zoom(region)` equivalent is deferred; region crops reuse
`browser_screenshot({ selector })` in the meantime.

### D10 — Safety posture is inherited, not replaced

ADR-0018/0081/0082/0083 mechanisms stay authoritative:

* Per-host `always` / `denied` decisions and the visible-target gate.
* The sanitized ledger, progress phases, retry rules, and the on-tab banner with
  Stop.
* Capability classification (`read` vs `write`) per tool.

Two additions, both extensions of existing mechanisms rather than new gates:

* **Consequence classes** in the risk classifier. Irreversible actions (submit,
  pay, delete, send, accept terms) prompt even on a focused tab, per call —
  including inside a batch, which is why D3 stops on them.
* **Opt-in diagnostics** — `read_console` and `read_network` stay off by
  default, are granted per site, redact credential-shaped query parameters and
  authorization headers, and are capped.

### Out of scope

* A cloud or headless browser owned by Jarela. The user's tab stays the runtime.
* Coordinate-first interaction. Coordinates remain a documented fallback for
  surfaces with no accessibility node.
* A single `exec_js` tool replacing typed commands. Granular commands are what
  make per-action approval, risk classes, and the ledger possible.
* File upload/download and `javascript_exec`. They are the riskiest members in
  the reference toolset and are deliberately deferred; if added later they
  follow the same opt-in, per-site, allowlisted-directory rules.

## Consequences

* Good — the two largest failure classes (stale selectors, unwinnable captures)
  get root-cause fixes instead of prompt workarounds.
* Good — a multi-step form or search flow becomes one or two model turns instead
  of one per interaction.
* Good — crashes, dialogs, and navigation become reportable outcomes, so the
  ledger stops accumulating `running` rows.
* Good — the agent can finally see what a user sees, which is what makes the
  visual fallback meaningful.
* Bad — a new optional permission prompt, a debugging infobar on CDP-backed
  commands, and a documented conflict with open DevTools.
* Bad — the provider tool-result contract change touches three adapters, their
  tests, and the token-budget accounting; images in tool results raise input
  cost per observation.
* Bad — the extension grows a second execution transport, so its test surface
  roughly doubles.
* Neutral — refs replace CSS selectors as the primary identifier, which changes
  the shape of every browser tool result and therefore the prompts that describe
  them.

### Measurable targets

| Metric | Baseline | Target |
| --- | --- | --- |
| `fill` terminal failure rate | 67.3% | < 5% |
| `navigate` terminal failure rate | 50.1% | < 5% |
| `screenshot` failure rate | 33.3% | < 5% |
| Ledger rows stranded in `running` | 5,849 | 0 |
| Commands per multi-step task | ~1 per action | ≤ 3 |
| Model turns per multi-step task | ~1 per action | ≤ 3 |

Measured against a local fixture page covering: `confirm()`, a shadow-DOM
widget, an iframe form, a canvas chart, a selector that changes on re-render,
a slow region, and a client-side route change.

## Reuse and duplication review

* **Reuse** the command queue, long-poll transport, approval store, risk
  classifier, and ledger. D1–D5 add no new state outside them.
* **Extract** the page-snapshot serializer into one extension-side module shared
  by `snapshot`, the post-action observation, and batch step observations,
  because all three must produce identical refs.
* **Keep separate** `browser_extract` from the accessibility-tree read: raw
  text/HTML with offsets and a tree walk answering "what can I act on" have
  different contracts and different truncation rules.
* **Keep separate** the synthetic and CDP transports behind one dispatch
  function, so the approval and ledger path stays single.

## Adoption plan

Ordered by leverage; each step lands with its tests and its prompt/skill
update.

1. **Reliability** — live-DOM resolution (D1), per-tab state, dialogs (D6),
   navigation-aware waits and crash recovery, tab-scoped capture (D8), ledger
   finalization.
2. **Speed and observation** — batch with expectations (D3), tree read (D2),
   explicit wait (D4), tab lifecycle (D5).
3. **Fidelity** — tool-result images (D9), trusted input (D7), iframe/shadow
   traversal, opt-in console/network.
4. **Prompt and docs** — rewrite the `browser-navigation` skill around
   batch-first, expect-based verification, and "one observation per batch";
   update tool descriptions, recovery hints, the extension README, and the C4
   flows in `docs/ARCHITECTURE.md`.

### Implementation status

Landed with this ADR: D1–D5 and the prompt/doc updates. Navigation is
scheme-checked and reports a crashed or discarded tab instead of timing out;
capture of a non-active target briefly activates and then restores the user's
tab; `press` covers keyboard-only controls. Still open: D6 (dialogs), D7
(trusted input via CDP), D8 (CDP transport, iframe and console/network reads),
D9 (images in tool results), ledger finalization for abandoned `running` rows,
and the remaining observation work in step 3.

## More Information

* Anthropic, [Browser use tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/browser-use-tool)
  (member tools, refs vs coordinates, batch halt rule, executor-side security).
* Anthropic, [Piloting Claude in Chrome](https://claude.com/resources/articles/claude-for-chrome)
  (permissions, action confirmations, prompt-injection measurement).
* Claude Code, [Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome)
  (session tab groups, human takeover, `browser_batch`).
* OpenAI, [Browser](https://learn.chatgpt.com/docs/browser.md) and
  [Browser extension](https://learn.chatgpt.com/docs/chrome-extension.md)
  (cloud browser, secure sign-in form, takeover, per-site permissions, CDP
  "Developer mode").
* Microsoft, [Playwright MCP](https://github.com/microsoft/playwright-mcp)
  (accessibility tree over pixels; CLI + skills vs MCP token cost).
