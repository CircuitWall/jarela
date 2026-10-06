# Development workflow

This guide focuses on developer experience for UI/state work.

## Quick commands

- Install: `npm install`
- Lint all: `npm run lint`
- Lint hooks only: `npm run lint:hooks`
- Test all: `npm test`
- Test hooks only: `npm run test:hooks`
- Watch hook tests: `npm run test:hooks:watch`

## Git and PR conventions

[CONTRIBUTING.md](../CONTRIBUTING.md) is the source of truth. Do not drift
from it when creating commits, branches, or PRs.

- Work on a topic branch, never local `main`.
- Use Conventional Commits v1.0.0 with required scope: `type(scope)[!]: description`.
- Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`.
- Keep the full subject at 72 characters or less.
- Start the description with a real lowercase imperative verb, with no trailing
  period and no parenthesized asides.
- PR titles must follow the same format, and so must every commit on the
  branch: rebase merge replays them all onto `main` individually.
- Do not carry lint warnings forward; fix warnings in touched workflows before
  committing.
- Local hooks enforce branch and commit-message format. CI enforces pull request
  titles and post-merge commit subjects.

## Hook API conventions

- Prefer the unified contract in [docs/ui-hook-api.md](./ui-hook-api.md):
  `state + commands` as canonical surface.
- Keep backward-compatible flat fields during migrations.
- New hook tests should verify:
  - `state` and `commands` shape
  - flat-field parity
  - one async/event path

## File naming and packaging

- Hooks: [hooks/](../hooks/) as `use{Name}.ts`
- Hook tests: [hooks/](../hooks/) as `use{Name}.test.ts`
- Keep hook tests in `hooks/`, not `components/`
- Use `.tsx` only if JSX is required by the test

## Tool directory standard

Keep `lib/tools/` as a small public entrypoint, not a dumping ground for every
tool and helper. New tool code belongs in the narrowest domain folder below:

```text
lib/tools/
  index.ts                  # stable public facade
  communications/           # Gmail, Outlook, Calendar, Microsoft Graph, To Do
  delegation/               # agent, Claude Code, and Codex delegation
  filesystem/               # files, file search, outlines, workspace context
  general/                  # standalone built-in tools without a narrower domain
  packages/                 # LangChain package loading, manifests, install, allowlist
  runtime/                  # registry, catalog, built-in registration, public tool types
  security/                 # safety gates, subprocess environment, credential context
  support/                  # async results, result references, wallclock, Git helpers
  system/                   # tool listing, proposals, skills, MCP and system tools
  web/                      # browser, fetch, search, shopping, media generation
  core/                     # catalog/runtime aggregation facade
```

### Placement rules

- Put a new agent-callable tool beside the closest existing domain. Use
  `general/` only when no more specific domain applies.
- Put a tool's tests beside its implementation in the same domain folder.
- Put registration and discovery logic in `runtime/`; do not put it in a tool
  implementation folder.
- Put reusable cross-domain mechanics in `support/` or `security/`, not in a
  domain tool file.
- Add built-in side-effect imports to `runtime/builtins.ts`, grouped in the
  same domain order as the folders above.
- Keep `lib/tools/index.ts` as the compatibility/public facade. Update it only
  when a public export or shared type needs to be exposed.
- Do not create one-line re-export stubs in the old root location. Update
  internal imports to the real domain path instead.
- Preserve public package subpaths such as `@circuitwall/jarela/lib/tools/types`
  by updating their `package.json#exports` target when an implementation moves.

When adding a new folder, keep its direct file count readable. Split a domain
again when it starts mixing unrelated responsibilities, rather than allowing
another large flat directory to form.

## Safe migration pattern

1. Add `state` + `commands` without removing old flat fields.
2. Update/introduce contract test under [hooks/](../hooks/).
3. Migrate callers to `state`/`commands` incrementally.
4. Remove legacy fields only after deprecation window and docs update.

## Known limits

- Browser-only hooks can depend on `window`, `navigator`, `Notification`,
  and `EventSource`; test under jsdom.
- Event-driven hooks are eventually consistent; prefer deterministic asserts
  (`waitFor`) over synchronous assumptions.

## LLM provider rate limiting

`getProvider()` applies a process-wide `p-queue` limiter to chat, structured
invocations, streaming invocations, and embeddings. All agents, model configs,
and credentials for a provider share its budget. Requests are evenly paced;
concurrency slots remain held until active requests or streams actually settle,
including when cancellation is requested.
Catalog discovery is not counted as model inference. Unknown providers and the
mock provider are unlimited unless overridden. LangChain's `ChatCohere` uses
the Cohere budget.

| Provider | Requests/minute | Concurrent requests | Default basis |
| --- | --- | --- | --- |
| Anthropic | 1,000 | Unlimited | Published standard Start tier; Evaluation tier can be lower |
| OpenAI | 60 | Unlimited | Conservative application preset; limits vary by model/project/tier |
| Gemini | 5 | Unlimited | Conservative application preset; active limits are in AI Studio |
| GitHub Copilot | 10 | Unlimited | Conservative application preset; GitHub publishes no fixed RPM |
| Cohere | 20 | Unlimited | Published trial Chat API limit |
| DeepSeek | Unlimited | 500 | Published account concurrency limit for DeepSeek V4 Pro |
| Unknown | Unlimited | Unlimited | No assumed vendor quota |

Sources: [Anthropic](https://platform.claude.com/docs/en/api/rate-limits),
[OpenAI](https://developers.openai.com/api/docs/guides/rate-limits),
[Gemini](https://ai.google.dev/gemini-api/docs/rate-limits),
[GitHub Copilot](https://docs.github.com/en/copilot/concepts/rate-limits),
[Cohere](https://docs.cohere.com/docs/rate-limits), and
[DeepSeek](https://api-docs.deepseek.com/quick_start/rate_limit).

Set `JARELA_PROVIDER_RATE_LIMITS` in the Environment panel to a JSON object:

```json
{"github-copilot":{"requestsPerMinute":10,"maxConcurrent":2},"custom-provider":{"requestsPerMinute":30}}
```

Omitted fields retain the preset. A JSON `null` means unlimited. Finite values
must be positive integers up to 60,000. Invalid overrides are rejected when the
provider factory initializes its limiter. This setting is not agent-writable;
apply changes with a user-controlled restart when no active runs need preserving.
Queue state is in memory and resets on restart; there is no additional daemon
or persisted rate-limit state.

These are local admission limits, not guarantees against all HTTP 429 errors.
They do not meter tokens, daily/monthly quotas, billing caps, SDK-internal
retries, or traffic from other Jarela processes/apps. Set overrides to match
your actual account limits; existing provider error and retry handling still
applies.

## Durable agent system signals

See [ADR-0091](adr/0091-durable-agent-system-signals.md). Producers publish
targeted lifecycle facts through the operation/event/delivery stores, never by
parsing logs. Same-database outcome changes and outbox publication are atomic.
External effects can still have unknown outcomes after a timeout or crash.

The existing `async_run` tool wrapper records intent before starting work and
emits completion, failure, or timeout signals with the async tracking key.
After restart, unfinished calls are marked interrupted; they are not replayed.
Completed result envelopes are encrypted in SQLite and retained for seven
days. The process-local map remains a fast cache; `tool_result_get` and
`tool_result_list` fall back to durable storage and enforce thread ownership.
References include an expiry; legacy process-local references are not offered
after restart. Owned success and error text use encrypted virtual references,
not plaintext spills. UTF-8-safe pages fit the inline transport budget including
JSON encoding; final-page consume removes durable storage and cached access.
The durable envelope budget is 2 MiB. Larger output produces an explicit
failure receipt. Legacy unowned references retain their existing behavior.

Context delivery defaults: at most 20 events and 8,000 journal characters per
batch, 30-minute renewable leases, five attempts, exponential retry backoff
with jitter capped at roughly one minute, and seven-day acknowledged-record
retention. Admission counts accepted operations plus ready/leased deliveries,
with a 1,000-record per-thread limit. Dead letters are retained for diagnosis;
they are not silently discarded or automatically replayed. No new daemon,
cloud service, additional daemon loop, or arbitrary tool execution API is added.

Restart receipts and authorized background-tool outcomes schedule a bounded
continuation through the existing scheduler and thread queues. At most two
threads wake concurrently; busy threads wait, failed preparation backs off,
and completion turns have a read-only tool permission overlay enforced for
bound and proxied tools. Restart additionally rejects completion-originated
calls and correlates foreground attempts with the persisted direct user
message ID, preventing retries from scheduling another exit. Config,
approval, watcher, and task events remain passive context. The continuation
retrieves output and reports only; further writes require a new user turn.
Completion reads are synchronous even if a model supplies `async_run=true`.
Queue, run-registry/waiter, result-cache, and config state are process-wide so
separate Next route bundles agree on ownership, active runs, and invalidation.
Reassigned signal targets are quarantined instead of waking another agent;
cached output respects durable deletion and expiry.

Owned result/outbox settlement is atomic. Transient settlement failure keeps
the observed outcome for up to five attempts on the existing result sweeper;
it does not rerun the tool. If storage remains unavailable or the process dies
before persistence, external effects may be unknown and require verification.
Native Claude/Codex jobs join on actual terminal callbacks, not launch
acknowledgment. Their owned status tools expose bounded metadata and result
keys rather than duplicating private output into generic spills.

Inspect delivery counts through `read_agent_config` and the Logs panel for
dead-letter notices. The store exposes `systemSignalDiagnostics` for local
inspection. The initial version does not expose a UI dead-letter replay button.

## Dependency upgrade workflow

- Upgrade in batches with one clear failure domain: framework/tooling,
  workspace packages, LangChain/provider SDKs, then high-risk native/runtime
  packages.
- Keep TypeScript and ESLint major jumps on their own branches. They affect
  diagnostics and generated declarations broadly enough that they should not be
  mixed with provider or UI changes.
- After workspace dependency changes, run `npm run packages:build` and
  `npm run packages:test`; package manifests can pass root tests while their
  generated declarations drift.
- After Next.js changes, read the matching guide under `node_modules/next/dist/docs/`,
  then run `npm run build`, `npm run security:routes`, and `npm run test:package`.
- After provider or LangChain changes, run the model-router, provider, MCP/tool,
  and attachment tests before live smoke tests.
