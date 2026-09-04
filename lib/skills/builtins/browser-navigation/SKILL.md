# Browser Navigation

Use this skill when the user asks the agent to use the browser tools, navigate a website, read a complex page, fill forms, work across tabs, or remember site-specific navigation hints for future browser work.

## Operating Model

- Treat the user's real browser as the runtime. Use `browser_tabs` to understand open tabs before switching context, and `browser_activate_tab` only when the task requires focusing a different tab.
- Respect an intentional pinned tab. If no pin is set, the side panel/current foreground tab is the normal target.
- Prefer `browser_snapshot` for page structure and controls, `browser_extract` for text/HTML, and `browser_screenshot` only for visual layout, canvas, charts, or confirmation.
- Reuse cached snapshots when `data.cache.hit` is true. Pass `force_refresh: true` only after page state changes, long delays, or stale handle/name errors.
- For large pages, follow `browser_extract` continuation metadata: read `result_ref.name` with `tool_result_get`, then call `browser_extract` again with `offset: next_offset` until `next_offset` is null.

## Navigation Workflow

1. Check memory for the site before exploring:
   - Use `memory_list` with `namespace: "browser.navigation"` and a search term based on the host or product name.
   - Use `memory_read` for a known key like `host:example.com`.
2. Establish tab context:
   - Call `browser_tabs` when the target tab is ambiguous.
   - Use the current foreground/side-panel tab unless the user explicitly asks for another tab or a pin is set.
3. Map the page once:
   - Call `browser_snapshot` to get headings, landmarks, controls, selectors, handles, and fingerprint.
   - Use handles or `role` + `name` for follow-up actions instead of rediscovering controls.
4. Act efficiently:
   - Use `browser_click` for buttons/links.
   - Use `browser_fill_many` for multi-field forms.
   - Use `browser_fill` for one-off field edits.
   - Use `browser_extract` for reading page content and `browser_screenshot` for visual evidence.
5. Refresh only when needed:
   - Trust auto-snapshot diffs after navigation/click/fill.
   - Use `browser_snapshot({ force_refresh: true })` when the page changed outside the agent's action, a modal appeared unexpectedly, or cached handles fail.

## Remembering Navigation Hints

Use `memory_write` when you learn a durable, reusable navigation fact about a site. The goal is to save future agents from rediscovering the same page structure, not to store page content.

Before writing, read existing hints:

- `memory_list` with `namespace: "browser.navigation"` and `search: "<host-or-product>"`.
- `memory_read` with `namespace: "browser.navigation"` and a likely key such as `host:example.com`.

After the browser task succeeds, call `memory_write` if the new hint would save future navigation work. Merge with the existing value instead of overwriting useful hints.

Write about:

- Login or setup path, without credentials.
- Which tab/page hosts a workflow.
- Stable control names or page labels.
- Required sequence such as "open Settings, then Integrations, then Connect".
- Known dynamic behavior such as "after clicking Save, wait for the toast and refresh snapshot".
- Pages where screenshots are needed because content is canvas/chart-heavy.
- Stable selectors only when role/name or label lookup is not enough.
- Known waits such as "wait for table rows" or "use force_refresh after Save".
- Common dead ends such as old menu labels, modal traps, or unusable tabs.

Do not write about:

- Passwords, tokens, cookies, auth codes, OTPs, payment details, or personal data.
- Raw page extracts, screenshot text, copied document content, or form values.
- One-off private facts from the current task.
- Guesses that were not validated by a successful navigation/action.

Use this memory shape:

```json
{
  "host": "example.com",
  "updated_at": "2026-09-04T00:00:00.000Z",
  "hints": [
    "Dashboard reports are under Reports > Quarterly.",
    "Use role=button name=Export after the report table renders."
  ],
  "avoid": [
    "Do not use nth-of-type selectors for the left nav; labels are stable."
  ]
}
```

Store it with:

- namespace: `browser.navigation`
- key: `host:<hostname>` for site-wide hints
- key: `app:<product-or-domain>` only when one product spans multiple hosts

`memory_write` call shape:

```json
{
   "namespace": "browser.navigation",
   "key": "host:example.com",
   "value": "{\"host\":\"example.com\",\"updated_at\":\"2026-09-04T00:00:00.000Z\",\"hints\":[\"Reports are under Reports > Quarterly.\"],\"avoid\":[\"Do not use nth-of-type selectors for the left nav; labels are stable.\"]}"
}
```

The `value` argument to `memory_write` is a string. Serialize the JSON object before passing it.

Never store secrets, cookies, auth codes, personal data, page extracts, screenshot text, or raw form values in memory. Store the route or control hint, not the private content observed on that page.

## When To Update Memory

Update memory after the task succeeds if the hint would save future exploration. Do not write memory for one-off private facts, temporary page state, or guesses. If a remembered hint turns out stale, overwrite it with the corrected route and include a short `avoid` note so future agents do not repeat the stale path.

## Failure Recovery

- If a control handle fails, call `browser_snapshot({ force_refresh: true })` and retry using role/name before falling back to CSS selectors.
- If tab targeting looks wrong, call `browser_tabs` and explain which tab is current, pinned, foreground, or blocked.
- If extraction truncates, continue with `next_offset`; do not ask the user to paste page text.
- If an action is sensitive, expect an approval prompt. Do not try to bypass it.
- If form filling fails, inspect the snapshot for field roles and labels, then use `browser_fill_many` with explicit locators.
