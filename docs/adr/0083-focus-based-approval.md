---
status: accepted
date: 2026-09-05
deciders: Andrew Ge Wu, GitHub Copilot
consulted: ADR-0081 browser command ledger, ADR-0082 ambient surroundings, Jarela change SOP
informed: Jarela contributors
---

# Approve What the User Cannot See

## Context and Problem Statement

The browser-control approval gate prompted too often and forgot its answers.

Two independent causes:

1. **Approvals did not survive.** Choosing *Always allow* wrote `always` into `chrome.storage.local` **and** POSTed the host onto the server's allowed-sites list. Every health tick (15s) then ran `syncApprovalsWithAllowedHosts`, which **deleted** any local `always` whose host was missing from that list. If the POST failed, the server was unreachable, or the tick simply won the race, the decision the user just made evaporated within seconds.
2. **Risk classification overrode the answer.** `classifyCommandRisk` set `force_prompt` for whole-page reads, screenshots, and any host matching `mail|docs|drive|account|admin|…`. `gateCommand` re-prompted on `force_prompt` *even when the host was already `always`*. On `mail.google.com` or `docs.google.com` that meant a modal on essentially every command, forever, with no way to stop it.

There is also a privacy defect hiding in (1): the allowed-sites list governs **cookie passthrough**. Clicking *Always allow* on a page-control prompt silently enrolled the host into cookie syncing — a far stronger grant than the one the user was asked about.

## Decision Drivers

* A decision the user makes must stick.
* Prompt fatigue is a security failure: users click through modals they see constantly.
* Consent for driving a page and consent for handing over cookies are different grants and must not be coupled.
* The dangerous case is action the user cannot observe.

## Considered Options

* **A. Keep the risk-based prompt, just fix persistence.** Leaves the fatigue: sensitive-host matching is broad enough that common sites prompt on every command.
* **B. Prompt only for a hardcoded list of dangerous command types.** Command type is a poor proxy — a `click` on a background banking tab is worse than an `extract` on a page the user is reading.
* **C. Key the prompt on whether the user can see the target tab.** Chosen.

## Decision Outcome

Chosen: **C**, plus decoupling from the cookie allow-list.

The entire policy is one pure function, `decideGate` in `browser-extension/lib/approvals.mjs`:

```
denied            → deny        (focused or not)
target is focused → allow
always            → allow
otherwise         → prompt
```

"Focused" means the target is the tracked foreground tab *and* still active in its window, so a pinned background target or a tab in another window fails it — which is the point.

The justification for auto-allowing the focused tab is that the user is already watching: the on-page overlay banner narrates the command live and **Stop** is one click away, and Stop persists a deny. A modal on top of that adds friction without adding information.

Supporting changes:

* `syncApprovalsWithAllowedHosts` is **deleted**. `jarelaBrowserApprovals` is now authoritative and nothing reconciles it against anything.
* Approving a site no longer calls `persistAllowedSite`. Cookie passthrough is enrolled only from Settings, deliberately, and still additionally requires a Chrome host-permission grant.
* `classifyCommandRisk` no longer returns `force_prompt`. It still produces `level` + `reasons`, which become the body of a prompt when one is shown.
* Progress phase `approval_waiting_sensitive` → `approval_waiting_background`, matching what is actually being waited on.

### Consequences

* Good: on the tab you are looking at, the agent just works. Decisions persist. Page control no longer smuggles in cookie access.
* Bad: a command on the focused tab now runs with no modal even on a bank or webmail page. This is deliberate — the banner plus Stop is the control — but it is a real reduction in friction on sensitive sites, and someone who wants the old behaviour has no switch for it.
* Bad: users who were relying on *Always allow* to populate the cookie allow-list must now add hosts in Settings. This is the intended correction, not a regression, but it changes an existing path.
* Neutral: `denied` is still absolute, so Stop remains a complete kill switch.

## Non-goals

* Per-command-type approval. Type is not the axis that matters; visibility is.
* Removing the sensitive-risk heuristics. They still explain a prompt; they just no longer force one.
