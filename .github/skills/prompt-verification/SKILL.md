---
name: prompt-verification
description: "Use when: changing, reviewing, or debugging any prompt Jarela sends to a model — the agent system prompt, harness sections, the tool usage SOP, or a standalone audit/extraction prompt. Provides the procedure for assembling every prompt and checking it for completeness and correctness."
argument-hint: "Prompt, block, or wording being changed"
---

# Prompt Verification

## Goal

Verify prompts against the **assembled text the model actually receives**, not
the builders that produce it.

Jarela's agent prompt is stitched from ~20 builders across a shared cached
prefix, an agent-stable block, and a per-turn dynamic block. Every prompt bug
found so far was invisible in the builders and obvious in the output:

- The tool permission block counted `proxy_only` tools as both "reachable
  through invoke_tool" and "not enabled for this agent" — one sentence,
  contradicting itself.
- `credentials_missing` and `integration_unconfigured` were emitted by the
  permission layer but never explained anywhere in the prompt, so the model
  could not tell a permission decision from an unfinished setup.

Read the artifact.

## When this activates

Any change that alters text a model receives. That includes edits under
`lib/agents/prepare/`, `lib/agents/harness/`, `lib/agents/adaptive-persona.ts`,
and the standalone prompts listed in `lib/agents/prompt-registry.ts` — plus
anything that changes a value the prompt renders, such as a new
`permission_reason`. Reword one line and the procedure still applies: the bugs
found so far were single-sentence contradictions.

## SOP

1. **Assemble, narrowed to the change.**
   ```powershell
   npm run prompts:dump -- --changed          # uncommitted work
   npm run prompts:dump -- --since origin/main # whole branch
   ```
   Both render every prompt to `.prompts/` (gitignored) and then print only
   the artifacts your change reaches. Read those top to bottom.

   Editing any system-prompt builder lists **all four variants**, not just
   one — the blocks compose, so a change to the shared prefix can contradict
   the per-turn block. Never review a single variant when the tool lists four.

   `npm run prompts:dump` with no flag dumps everything, for a full audit.

2. **Register any new prompt.**
   Every build-time prompt belongs in `lib/agents/prompt-registry.ts` with an
   `id`, `source` and `purpose`. `prompt-registry.test.ts` fails if a module
   known to declare a prompt is missing from the inventory, so an unregistered
   prompt is a build failure, not a silent gap.

3. **Check completeness.** For the block you touched, confirm:
   - Every machine value the model can see is explained. If the permission
     layer can emit a `permission_reason`, the prompt must say what to do
     about it. Add the string to the reason list in `prompt-registry.test.ts`.
   - Every tool name the prompt tells the model to call is registered.
   - Instructions that demand structured output show the shape.
   - Counts derived from the same data agree with each other.

4. **Check correctness.**
   - No contradiction between two sentences about the same thing.
   - No unresolved `{{placeholder}}`, `undefined`, `NaN`, `[object Object]`.
   - No duplicated section header.
   - Procedures are ordered and numbered; prose lists of "also remember"
     rules get ignored under load.

5. **Respect the cache boundaries.**
   The prompt is split by `CACHE_SHARED_SPLIT_SENTINEL` and
   `CACHE_SPLIT_SENTINEL`:
   - **Shared prefix** — identical for every agent. Cross-agent static text
     only. Putting agent identity or per-turn state here destroys the shared
     cache for every agent at once.
   - **Agent-stable** — persona, skills, harness, integrations. Must not
     change between turns of one session.
   - **Dynamic** — timestamp, recall, tool permission state, output budget.

   Moving text across a sentinel is a performance change, not just a wording
   change. Say so in the PR.

6. **Add an invariant, not a snapshot.**
   Snapshot tests on prompts churn on every wording tweak and get blindly
   accepted. Assert the property that must hold — "denied count excludes
   proxy-reachable tools", "every reason string appears somewhere" — so the
   test survives rewording and still catches the bug.

7. **Validate.**
   ```powershell
   npx vitest run lib/agents/prompt-registry.test.ts
   npx vitest run lib/agents/prepare
   npm run lint
   ```

## What this cannot check

Static verification proves the text is coherent, not that models obey it.
Behavioural claims — "the model will search instead of giving up", "Gemini can
fill `args_json`" — need `npm run test:live:full` against a real key, ideally
on more than one provider. Do not claim a prompt change works because the unit
tests are green; say which part is verified and which is not.

## Quick Checks

```powershell
npm run prompts:dump -- --changed
npm run prompts:dump -- --since origin/main
Get-Content .prompts/INDEX.md
Select-String -Path .prompts/*.txt -Pattern 'undefined|NaN|\{\{'
npx vitest run lib/agents/prompt-registry.test.ts
```
