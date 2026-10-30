# Extending Jarela

This is the single integration guide for everything you can plug into,
hook on top of, or layer around Jarela. It covers eight extension surfaces.
Inside the running app, the agent-callable
[`describe_extension_surfaces`](#agent-introspection-tools) tool returns the
same map this document is built around.

For the proposed boundary between shared core work and user-owned
specialization, see the [post-3.0 direction](POST_3_DIRECTION.md) and
[ADR-0111](adr/0111-dependable-core-user-owned-extensions.md).
They define future-work criteria, not new runtime protections. External code
still executes with the trust of its host; capability labels are not a sandbox.

> **Public surface contract.** Plugin authors should rely only on the type
> exports listed in [CONTRIBUTING.md → Public API surface](../CONTRIBUTING.md#public-api-surface).
> Anything else is internal and may change between minor versions.

## Built-in skill maintenance (Unreleased)

The seven packaged playbooks under `lib/skills/builtins/` now share
`name`/`description` frontmatter and explicit Input, Output and Validation
contracts. Browser Navigation, Configuration, Documentation, Integrations,
Operations remain tool-guided procedures. Memory Organization and Personal
Briefing now include portable scripts for deterministic substeps (below).
None grants permissions or automatically executes a complete workflow.
User repositories and built-in read-only/override behavior are unchanged.

All seven are inventoried in `lib/agents/prompt-registry.ts`. Changing a packaged
skill triggers review of its complete static prompt and every assembled system
variant, because its discovery metadata appears in the skill catalog. Use
`npm run prompts:dump -- --changed` for uncommitted changes or
`npm run prompts:dump -- --since origin/main` for a branch.

Focused checks:

```shell
npx vitest run lib/skills lib/agents/prompt-registry.test.ts lib/agents/prepare
```

Tests check discovery, contracts, named tools, JSON examples against real
schemas, and Personal Briefing's six deterministic fixtures. They do not prove
that a model follows the procedure or that a live account/provider works.
Memory Organization also has synthetic cleanup-planning fixtures. Adding
fictional success fixtures for other procedures would not establish workflow
correctness. No general JavaScript runner or milestone completion is introduced.

### Script-backed built-in steps

| Skill | Portable implementation | Jarela entry point |
| --- | --- | --- |
| Personal Briefing | `personal-briefing/scripts/validate.mjs` validates bounded structure, reference membership and source gaps | Existing read-only `validate_personal_briefing` tool imports the same function |
| Memory Organization | `memory-organization/scripts/plan-cleanup.mjs` computes expired active facts and exact duplicate candidates at explicit UTC time | New read-only `plan_memory_cleanup` tool imports the same function |

Both bundles include `scripts/run.mjs`: an authorized external host can invoke
`node <skill-root>/scripts/run.mjs`, send one JSON input on stdin and close stdin.
No npm dependencies, Jarela-private imports, filesystem scans, network or
credentials are required. Input is bounded to 64 KiB of valid UTF-8. Stdout is
one JSON result; exit 0 means `ok: true`, exit 1 means field validation failed
(`ok: false` with issues) or a transport error (stderr, no result). Copy each
whole skill directory, not just its Markdown. Tests copy bundles outside the
app and compare standalone results with typed-tool results; this is portability
evidence under Node, not Claude Code or other-host certification.

The memory tool accepts at most 100 projections from retrieved `facts` records:
`key`, `kind`, `subject`, `content`, `status`, `expires_at`, plus explicit UTC
`now` at the top level. It does not retrieve memory itself. Archived entries are
excluded; expiry at or before `now` is reported. Duplicate candidates match
trimmed kind/subject/content and the exact expiry string. Provenance, confidence,
tags and history may still differ, so review full records before a separately
authorized archival. No merging, writing, deletion or trust changes occur.

Jarela invokes only these fixed reviewed implementations in-process through
normal tool permissions. It never imports scripts from a user repository or
substitutes overridden bundle source into the tool. A user override changes
instructions, not built-in executable code. The optional checked skill runner
remains unavailable; do not use terminal execution to bypass that boundary.
The tiny CLI adapters are intentionally self-contained in each bundle so either
directory can be shared alone; the substantive algorithm has one implementation
shared with its Jarela tool, not a second tool-specific copy.

Browser Navigation, Configuration, Documentation, Integrations and Operations
retain their existing typed tools and model judgment: no wrapper scripts are
added merely to duplicate browser actions, credential probes, settings writes
or document retrieval. Neither converted skill is a fully automated workflow.

#### Memory cleanup execution candidate (Unreleased)

Memory Organization now includes an experimental `execution.json` adapter over
its existing `scripts/run.mjs` and `scripts/plan-cleanup.mjs`, with a 5,000 ms
declared timeout and 64 KiB output budget. It is the first checked-runner
candidate, not an installed runner: ordinary reads are unchanged, and opt-in
`read_skill` execution inspection still returns `execution_available: false`.

The adapter requires the exact projection fields above and rejects additional
fields, unlike the existing typed tool's normalization or the standalone CLI's
tolerant input. Nullable expiry uses bounded `anyOf`; the output declares separate
success and field-error shapes. Date validity, trimmed text limits, unique keys
and expiry comparisons remain the planner's semantic checks. A schema-valid
invocation can therefore return a checked `ok: false` result with exit 1; valid
JSON is not execution success.

Tests capture the bundle's exact bytes, copy those captured bytes into test-only
temporary directories, and run fresh Node processes without PATH or credentials
from a different working directory. They verify fixtures, source mutation
independence, paths with spaces/metacharacters, record-count boundaries and
structured failures. This is a local CLI/contract test, not production snapshot
staging, artifact consent, process-tree cleanup, workflow persistence or
cross-host acceptance. In Jarela, continue using `plan_memory_cleanup`.

## Table of contents

- [Adding an LLM provider (built-in)](#adding-an-llm-provider-built-in)
- [Adding an LLM provider (external `.cjs` plugin)](#adding-an-llm-provider-external)
- [Adding a built-in tool](#adding-a-built-in-tool)
- [Adding a bridge module](#adding-a-bridge-module)
- [Adding an MCP server](#adding-an-mcp-server)
- [Adding a custom harness](#adding-a-custom-harness)
- [Adding an integration manifest](#adding-an-integration-manifest)
- [Inspecting skill execution metadata (Unreleased)](#inspecting-skill-execution-metadata-unreleased)
- [Sharing skill bundles (design target)](#sharing-skill-bundles-design-target)
- [Reading shared skill bundles (Unreleased)](#reading-shared-skill-bundles-unreleased)
- [Branding the app](#branding-the-app)
- [Agent introspection tools](#agent-introspection-tools)

---

## Sharing skill bundles (design target)

[ADR-0112](adr/0112-checked-javascript-skill-execution.md#shared-bundle-portability-requirement)
targets the open [Agent Skills format](https://agentskills.io/specification):
one directory containing `SKILL.md` and optional `scripts/`, `references/` and
`assets/`, shareable with Claude Code and other compatible hosts without
rewriting its source. Jarela's `execution.json` is optional, host-specific
execution metadata, not a prerequisite for a portable instruction-only skill.

This is a proposed compatibility requirement, not delivered cross-host
certification. Script runtimes, tool names, permissions and host-specific
features can differ. Jarela-specific tools still require Jarela; sharing a
bundle does not grant execution rights or make every Claude feature work here.
The first checked-runner design covers dependency-free `.mjs`/`.cjs` only.
Existing manifest inspection remains inert and always reports execution
unavailable. The ADR defines source-preservation, relative-resource and
cross-host fixture checks required before stronger compatibility claims.

## Reading shared skill bundles (Unreleased)

Jarela can read the standard YAML metadata and relative text resources of an
[Agent Skills](https://agentskills.io/specification) directory without converting
its source. Use `read_skill` with `inspect_bundle: true` for metadata diagnostics:

```json
{ "id": "example-skill", "inspect_bundle": true }
```

The additional `bundle` object reports `standard`, `extended`, `legacy` or `invalid`;
full metadata, field issues and compatibility notices; and
`execution_available: false`. `standard` means the checked metadata fields
meet the supported format constraints, not that another host or runtime was
tested. YAML aliases/custom tags, non-string mapping keys, non-finite numbers,
frontmatter above 64 KiB, depth above 32 or more than 4,096 value nodes produce
explicit issues. Name, description and optional standard fields are checked;
unknown host fields are retained and reported as unsupported behavior with
`extended` status rather than claiming standard-only metadata. Unicode names
and character counts follow the reference validator's naming rules.

Discovery still uses a 200-character description preview; inspection returns
the complete standard description (up to 1,024 characters). Nested metadata
does not replace top-level discovery fields. Legacy heading-only and flat
Markdown remain readable. Default `read_skill` responses are unchanged;
format diagnostics are opt-in and do not rewrite or reject legacy instructions.
The [specification](https://agentskills.io/specification) and
[reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py)
were reviewed on 2026-10-28; the reported checks are not a complete conformance
suite or proof of another host's behavior.

Read a referenced file with:

```json
{ "id": "example-skill", "path": "references/REFERENCE.md" }
```

Call `read_skill_resource` with that object. It returns `id`, `path`, `source`,
`content`, UTF-8 `bytes` and `execution_available: false`. Paths use `/`
relative to the selected skill root, regardless of the app working directory.
The same mechanism reads text assets or script source, including files absent
from an execution manifest. Each read is limited to 1 MiB and rejects missing,
nonregular, linked, nonportable, invalid UTF-8 or NUL-containing binary files.
Flat Markdown has no resource directory. Repository override order is shared
with `read_skill`; a missing resource in the winning bundle is an error, not
permission to read a different repo's copy.

No manifest is needed for either operation. Files stay untouched; script source
is data, never imported or executed. `allowed-tools` does not grant Jarela
permissions, and `compatibility` is an author declaration, not a verified
environment. Host-specific controls such as Claude's `context: fork` are
preserved but not enforced. Binary assets, import/export packaging, automatic
runtime/tool adaptation and cross-host execution certification are not added.
Concurrent-edit checks are best-effort read consistency, not an immutable
execution snapshot or host-code sandbox. The checked runner remains proposed
in [ADR-0112](adr/0112-checked-javascript-skill-execution.md).

## Inspecting skill execution metadata (Unreleased)

The experimental `read_skill` option `inspect_execution: true` reads the
selected skill's `execution.json` and reports its declared files without
importing code, running package hooks, installing dependencies or granting
execution authority. Omitting the option preserves the existing response.
Prompt-only and flat Markdown skills still work without a manifest.

```json
{ "id": "example-skill", "inspect_execution": true }
```

The normal skill content is returned with an additional `execution` object:

- `status: "not_declared"`: the selected folder has no manifest, or the skill
  uses a flat Markdown file.
- `status: "invalid"`: `issues` contains field/file paths and explicit errors.
  Malformed metadata does not cause fallback to another repository.
- `status: "inspected"`: `manifest`, declared `files` with byte sizes and
  `total_bytes` passed this structural inspection.

**Every status includes `execution_available: false`.** An inspected manifest
is not an approved, installed, executable or trustworthy skill. There is no
script runner in this slice. Inspection is a current filesystem observation,
not an immutable revision, dependency/import audit, sandbox or authorization.
It cannot establish that files remain unchanged after inspection.

Example folder manifest (experimental; not a public plugin contract):

```json
{
  "schemaVersion": 1,
  "entrypoint": "scripts/main.mjs",
  "files": ["scripts/main.mjs"],
  "inputSchema": {
    "type": "object",
    "properties": { "name": { "type": "string", "maxLength": 100 } },
    "required": ["name"],
    "additionalProperties": false
  },
  "outputSchema": { "type": "string" },
  "timeoutMs": 60000,
  "maxOutputBytes": 65536
}
```

Only explicit `.mjs` and `.cjs` entry points are recognized; the entry point
must appear in `files`. Paths use portable relative `/` separators; absolute,
traversal, backslash, Windows-device and case-colliding paths are rejected.
The inspected skill directory, manifest and declared paths cannot be symbolic
links; declared leaves must be regular files. This is not a race-free snapshot.

Bounds are 64 KiB of UTF-8 manifest text, 64 declared files, 1 MiB per declared
file and 4 MiB across declared files. File totals exclude undeclared files and
the manifest/instructions unless explicitly listed. JSON is bounded to 32
levels and 4,096 value nodes before recursive schema checking. Timeout metadata
defaults to 60,000 ms (allowed 1,000-120,000); output metadata defaults to 64 KiB
(allowed 1-256 KiB). Both must be integers; invalid values are rejected, not
clamped. These limits validate declarations; no execution budgets run here.

Schemas use explicit `type`: object (with a `properties` map), array (with
`items`), string, number, integer, boolean or null. Supported optional fields
are unique declared `required` properties, boolean `additionalProperties`,
`minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, and nonempty
scalar enums for string/number/integer/boolean. Unreleased bounded `anyOf` allows
two to four alternative schemas, including nullable fields and explicit result
variants; a value must match at least one branch. Alternative nodes accept only
`anyOf`, not sibling constraints. The invocation root still requires an explicit
object schema. Existing depth/node bounds include every branch. Unknown fields,
`$ref`, patterns, other combinators and executable validators are rejected. Inspection validates schema
structure, not actual invocation/results or satisfiability of all constraints.

### Internal invocation/result validation (Unreleased)

The internal execution protocol helpers now check actual JSON against this
schema subset without spawning a process, reading a bundle or granting consent.
They require a manifest from the strict parser; they are not public plugin APIs
or a callable execution tool. Existing `read_skill` inspection remains inert.

- Invocation transport is exactly one JSON object, at most 64 KiB of UTF-8 text;
  results are exactly one JSON value within the manifest's `maxOutputBytes`.
  Whitespace counts toward the byte limit. Reject excess rather than parsing
  clipped text. The future runner must bound raw stdout bytes while streaming
  and decode valid UTF-8 before calling the string-based validator.
- Both values use the existing depth-32 / 4,096-value-node bounds, including
  undeclared properties. Non-finite parsed numbers are rejected.
- Check types, required own properties, enums, nested values, inclusive numeric
  and item/length bounds without coercion, defaults, stripping or mutation.
  String lengths count Unicode code points. Omitted `additionalProperties`
  permits undeclared values, as does explicit `true`; `false` rejects them.
- Validation reports up to 20 path-specific issues without echoing invalid
  values. Property paths are still caller data, not sanitized display text.
  The manifest parser explicitly rejects the reserved `__proto__` schema
  property name rather than silently dropping it in the underlying validator.
  A failed `anyOf` reports one issue at the original value path, not every
  rejected branch's diagnostics; rejected branches do not pollute a later match.
- Consent digest calculation reuses the bounded invocation-object parser and
  continues hashing exact original UTF-8 bytes, not a normalized serialization.
  A digest alone does not establish schema-valid input, a snapshot or consent.

This closes only the pure validation portion of the proposed protocol. It does
not verify exit status, runtime identity, snapshots, authorization, cancellation,
process cleanup or cross-host execution. Execution remains unavailable.

### Internal raw-output capture (Unreleased)

`SkillExecutionOutput` consumes raw `Uint8Array` stdout/stderr chunks without
starting a process or granting execution. It validates a private copy of the
manifest, preallocates bounded buffers, copies chunks and rejects the first byte
past the declared stdout ceiling or fixed 16 KiB stderr ceiling. Byte-sized
chunks cannot create an unbounded retained chunk list. Both streams require
valid UTF-8, including multibyte sequences split across chunks; malformed bytes
fail immediately and incomplete trailing sequences fail on finalization.

`finish()` checks one complete stdout JSON result with the shared schema
validator and returns the checked value, bounded diagnostics and exact byte
counts. It does not strip a JSON BOM, repair text or parse clipped output.
Limit, encoding and result failures have explicit error codes and never return
an output value; the first failure remains terminal. Buffers are cleared and
released after failure, finalization or explicit disposal; later writes fail.
Clearing buffers is not a guarantee of erasing all runtime/OS copies.

This is protocol capture only. A JSON `ok: false` field-error envelope can pass
its declared schema, and even a valid success-shaped result does not prove a
zero process exit or verified cleanup. The future process owner must enforce
abort/timeout/exit/pipe completion and whole-tree termination before consuming
results, dispose on every exit path, and treat capture failures as a request
to stop the owned process. This helper neither terminates nor observes processes.
Diagnostics are untrusted, potentially sensitive script output; the helper
does not sanitize them or authorize display/persistence.

### Gated staged runner and durable coordinator (Unreleased)

[ADR-0113](adr/0113-gated-workflow-runtime.md) describes the internal implementation,
not an activated execution feature. There is no new callable tool, route,
environment opt-in, startup migration or production process-owner adapter.
The exported production-availability constants remain false.

- `lib/stores/skill-run-staging.ts` creates unique run-owned directories under
  `JARELA_DB_DIR/skill-runs`, writes captured bytes exclusively and verifies
  content, directory identity and absence of unexpected entries before launch.
  The writable workspace is separate and its canonical filesystem identity is
  checked twice. Mode bits do not provide same-user isolation or Windows ACL
  guarantees. A hostile same-user path race is outside this contract.
- `lib/skills/execution-runner.ts` orchestrates strict input validation,
  exact revision/input/runtime/limit binding, live policy rechecks, one-use
  consent consumption, direct `process.execPath`/argv and an empty environment.
  A required trusted host adapter owns launch, raw pipes, completion and
  descendant termination. There is deliberately no default backend claiming
  arbitrary-code process-tree cleanup from immediate-child exit alone.
- The runner bounds execution and cleanup waits, withholds results after
  failed exit, cancellation, timeout, protocol failure or unverified cleanup,
  and disposes staging only after verified process cleanup. Unverified cleanup
  retains staging and reports failure; restart never executes leftover files.
  Retention/cleanup of crash leftovers still needs production review.
- `lib/workflows/definition.ts` parses inert strict version-1 JSON, limited to
  32 sequential steps and 64 KiB. Tool/script/validate/choice steps each declare
  input/output schemas and either literal input, separately schema-checked run
  invocation data, or a backward-only checked output/path binding. No expression language, dynamic imports or graph loops
  are evaluated. Required inputs remain objects.
- `lib/workflows/runtime.ts` checks every binding and output before downstream
  consumption. Its sole retry coordinator permits at most three attempts for
  declared read operations and six retries per run. Script launches, choices
  and writes do not automatically retry. The trusted host must independently
  verify operation replay classification and permissions; declarations cannot
  make full-trust script code read-only.
- `lib/stores/workflow-runs.ts` is an explicitly constructed SQLite store
  with versioned compare-and-swap updates and 512 KiB state bounds. It is not
  connected to the active application database on startup. Choices persist
  with exact run/revision/step/version checks, but answers are never script
  consent. Interrupted writes become uncertain and require validated observed
  reconciliation, not replay. Recovery of an interrupted owner requires a
  host attestation that the old owner is dead. Model-generated outputs retain
  their label; schema validity is not factual verification.

Tests combine real reviewed memory-cleanup CLI execution through staged runner
orchestration with a deterministic failed check/retry, tool steps, human choice
and synthetic archival/read-back. They also cover policy/binding refusal,
timeout/cancel, cleanup refusal, database reopen, stale/duplicate answers,
owner claims, retry budgets and uncertain writes. Test adapters know the
reviewed fixture never spawns descendants; these results are not platform
process-tree certification, live provider evaluation or milestone completion.
Production adapter/approval/UI wiring, durable-state deployment/retention review,
cross-host checks and human walkthroughs remain activation/acceptance work.

The Memory Organization bundle also includes an inert `workflow.json` example:
supplied fact projections flow into the existing planner, then a typed keep/review
choice. It never archives or deletes. Its invocation and planner schemas are
checked against `execution.json` in tests to detect drift. Sharing/reading this
definition neither runs it nor authorizes its script step. The workflow definition
has its own content revision, separate from the script artifact/consent revision.

### Internal in-memory artifact capture (Unreleased)

`SkillExecutionArtifact.capture` is an internal, opt-in content-capture helper,
not discovery, a runnable snapshot, a grant or a public plugin API. It reads
`execution.json`, `SKILL.md` and the manifest's declared files through the same
bounded regular-file reader used for skill resources. Declared assets may be
binary; user-facing text-resource reads still reject binary/invalid UTF-8 data.
It never imports scripts, follows hooks, writes staging files or launches code.

The capture retains private copies of exact bytes and exposes defensive copies
and frozen file metadata. Its SHA-256 revision includes a domain/version marker
and length-framed sorted paths and contents, including the original manifest
and instructions. Equal contents at different locations have equal revisions;
later source changes or caller mutations cannot change the captured bytes.
Manifest formatting changes also change the revision. Unlisted files are not
included or attested.

The existing limits apply: up to 64 declared files plus automatic metadata,
1 MiB per file, 64 KiB for the manifest, and 4 MiB total **including** metadata.
Explicitly declared metadata is counted once; case aliases for reserved metadata
names are rejected. Symbolic links and special files at/below the selected skill
root are rejected. A second bounded read detects observed changes during capture,
and root filesystem identity is rechecked. This is not an atomic filesystem
snapshot or protection against a hostile same-user process racing path resolution.
In particular, this does not establish the identity of ancestors above the root.

The eventual run lifecycle must bound retained captures, verify an authorized
workspace and policy, bind human consent, and privately stage and reverify these
bytes before any launch. No durable staging location, execution grant, restart
recovery or process-cleanup guarantee is introduced by this helper.

See [ADR-0112](adr/0112-checked-javascript-skill-execution.md) for the remaining
artifact-approval, immutable-snapshot, process-cleanup and execution design gates.

---

## Adding an LLM provider (built-in)

In-tree provider adapters (Anthropic, OpenAI, Gemini, DeepSeek, GitHub
Copilot, …) live under `lib/providers/<name>.ts` and export a `ModelProvider`.
`lib/providers/builtins.ts` imports and registers those objects with
`lib/providers/registry.ts`, which derives provider names from each module.
The static imports keep modules visible to Next's server bundler.

Steps:

1. Create `lib/providers/<name>.ts` exporting a `ModelProvider` from
   `@circuitwall/jarela/lib/providers/types`. Implement at least `chat`;
   add `invoke` and `streamInvoke` if the provider supports tools, and
   `embed` / `listModels` if it supports those.
2. Add the exported provider object to the `PROVIDER_MODULES` list in
  `lib/providers/builtins.ts`. No separate provider-name map is needed.
3. If the provider has known model context windows that the live API
   doesn't surface, register them in `lib/providers/known-context-windows.ts`.
4. Document the new provider in the README "Providers" section.

Reference contract: `lib/providers/types.ts` (the `ModelProvider`
interface and its companion event/message types). See
[`lib/providers/anthropic.ts`](../lib/providers/anthropic.ts) for a
non-trivial worked example with tool calling, prompt caching, and
multi-modal input.

ADR: [0013](../docs/adr/0013-external-providers-and-tools.md).

---

## Adding an LLM provider (external)

If you don't want to vendor your provider in the tree (closed-source
gateway, vendor-internal model catalogue, etc.), drop a CommonJS plugin
into `~/.jarela/providers/<name>.cjs`. It's hot-loaded per call — no
rebuild, no restart.

Steps:

1. Copy [`lib/providers/template-external.cjs.example`](../lib/providers/template-external.cjs.example) to `~/.jarela/providers/<name>.cjs`.
2. Implement the same `ModelProvider` shape from
   `@circuitwall/jarela/lib/providers/types`. The plugin file just
   `module.exports = { name, chat, invoke?, streamInvoke?, ... }`.
3. Confirm with the agent: ask `list_providers` to see your name appear,
   and `describe_provider` for capability/model details.

Auth, retries, and error mapping are the plugin's responsibility.
Capability flags (`vision`, `tools`, `streaming`, `json_mode`,
`web_search`, `audio`, `files`) come from `listModels()` if you implement
it; otherwise the runtime infers from which methods are present.

To make a declared credential testable from Credentials, add an optional
`credentialProbe` descriptor. It supports HTTPS GET probes with bearer,
custom-header, or query-parameter auth; common 401/403 and 429 classification
is handled by Jarela. `credentialField` must name one of the plugin's declared
credential fields. Keep the endpoint read-only and do not put secrets in static
headers or the endpoint URL:

```js
credentialProbe: {
  endpoint: "https://api.example.com/v1/models",
  credentialField: "api_key",
  auth: { type: "bearer" },
  responseDetails: { models: { path: "data", count: true } },
},
```

Probe descriptors must use HTTPS and are checked when the plugin is loaded.
`credentialField` must refer to a declared secret field.
Providers without a safe read-only auth endpoint can omit the descriptor; they
remain available, but the integration test route will not claim to verify them.

ADR: [0013](../docs/adr/0013-external-providers-and-tools.md).

---

## Adding a built-in tool

Built-in tools register themselves at module load. Choose the narrowest domain
folder under [`lib/tools/`](../lib/tools/) first. For example, a Gmail tool
belongs in `lib/tools/communications/`, a filesystem tool in
`lib/tools/filesystem/`, and a new uncategorized local tool in
`lib/tools/general/`. Adding one is two files: the implementation and its
colocated test.

1. Create `lib/tools/<domain>/<name>.ts`:
   ```ts
   import { tool } from "@langchain/core/tools";
   import { z } from "zod";
    import { registerLangChainPackage } from "../packages/langchain-package";

   export const myTool = tool(
     async ({ foo }) => JSON.stringify({ result: foo.toUpperCase() }),
     {
       name: "my_tool",
       description: "What this does, when the agent should call it.",
       schema: z.object({ foo: z.string() }),
     },
   );

   registerLangChainPackage({
     category: "Files",
     tools: { read: [myTool] },
   });
   ```
2. Add `import "../<domain>/<name>";` to
    `lib/tools/runtime/builtins.ts`, keeping imports grouped by domain.

3. Add `<name>.test.ts` beside the implementation. Tests should import the
  implementation from the same folder; do not add a root-level forwarding
  file just to preserve an old internal path.

That's it — no central array, no parallel category map. The new tool is
visible in `GET /api/v1/tools`, callable by every agent (subject to its
tool policy), and surfaced through the `list_tools` agent tool.

**Capability gating** (`registerLangChainPackage({ category, tools: { read | write | execute: [...] } })`):

- `read` — pure read of local or remote state. No side effects.
- `write` — mutates local or remote state.
- `execute` — runs arbitrary code (shell, sandboxed eval, …).

External (`.cjs`) and MCP tools default to `execute` until manifest-level
overrides land. See [ADR-0038](../docs/adr/0038-tool-capability-tiers.md).

**Declare the backing integration** when the tool needs credentials the
operator configures in the Integrations panel:

```ts
registerLangChainPackage({
  category: "Mail",
  integrationId: "gmail",
  tools: { read: [myTool] },
});
```

`integrationId` defaults to `auth.integrationId` when the package uses the
auth bridge, so packages wired that way need nothing extra. Agents are denied
tools whose integration fails its probe (`permission_reason:
"integration_unconfigured"`) or whose declared `credentials_required` keys
resolve in neither `process.env` nor the env-sync allowlist
(`credentials_missing`). The tool stays listed in `GET /api/v1/tools` either
way so the operator can still find it and set it up — see
[ADR-0078](adr/0078-tool-integration-declaration.md).

**Only basic tools are bound to the model each turn.** Everything else an
agent may run is reached through the `invoke_tool` proxy, so a new tool does
not need to be in the agent's pinned list to be reachable — it needs a
`description` good enough to be *found* by a `list_tools` keyword search.
There is no tool index in the system prompt.

**Description text matters.** The text in `description` is what the LLM
sees. Multi-sentence is fine — tell it WHEN to call this tool, not just
WHAT it does. Look at [`lib/tools/system/integrations.ts`](../lib/tools/system/integrations.ts)
for the pattern.

Reference contract: [`lib/tools/runtime/types.ts`](../lib/tools/runtime/types.ts)
and [`lib/tools/runtime/registry.ts`](../lib/tools/runtime/registry.ts).
Worked example: [`lib/tools/runtime/template.ts`](../lib/tools/runtime/template.ts).

---

## Adding a bridge module

Bridge modules adapt a messaging channel to Jarela's shared inbound message,
chat-routing, and lifecycle contracts. The runtime and editor consume module
metadata for connection setup, pairing, chat discovery, lookup, event controls,
and attachment guidance.

1. Create `lib/bridges/modules/<kind>/` and implement a `BridgeAdapter` in a
  platform-specific file.
2. Export a `BridgeModule` from the module entrypoint. Provide `kind`, labels
  and instructions, `createAdapter`, and `removeAuth`. Declare `pairing`,
  `chatDirectory`, `chatLookup`, `groupEventSubscriptions`, and attachment
  guidance only when the adapter supports them.
3. Add the module to `BRIDGE_MODULES` in
  [`lib/bridges/registry.ts`](../lib/bridges/registry.ts). This is the one
  static registration point needed for Next's server bundler. The registry
  validates bridge kinds for creation and publishes serializable metadata at
  `GET /api/v1/bridges/kinds`.
4. Add adapter and registry tests. The common UI uses the metadata; only add
  UI/API capabilities when the channel needs a connection flow that the
  descriptor cannot express.

Bridge remote IDs are opaque channel identifiers. The current route store and
wire contract retain the legacy `remote_jid` field name for compatibility, so
adapters should place their native chat ID there without relying on WhatsApp
JID syntax in shared routing logic. For an OAuth or credential-entry flow,
extend the module capability contract rather than adding kind checks to the
runtime or editor.

### Message content and attachments

Tools and providers exchange message content through `ContentPart` from
`@circuitwall/jarela/lib/tools/types`:

- `text` carries plain user-visible text.
- `image` is the legacy inline base64 image form. New persisted paths should
  prefer `image_ref`.
- `image_ref` points at a content-addressed file under `~/.jarela/files/`,
  served by `GET /api/v1/files/[name]` and materialized to provider bytes only
  when the active model call needs vision input.
- `file` carries inline text file content. Keep this for small text-like files
  whose contents should enter the prompt.
- `file_ref` points at a binary file under `~/.jarela/files/`. Use this for
  PDFs, audio, video, and other binary files so chat-run JSON stays small.

External tools that produce large binary artifacts should write them through
the file store and return a ref-shaped content part or a `/api/v1/files/[name]`
URL. Do not embed large base64 blobs in normal chat/run payloads.

---

## Hot-loading a vanilla LangChain tool package

Any npm package that exports a class implementing
`StructuredToolInterface` (the LangChain.js convention used by
`@langchain/community`, `@langchain/google-community`, third-party
packages, …) can be loaded into Jarela without writing code. The
operator manages the install themselves; Jarela reads a JSON manifest,
dynamic-imports the package, calls the constructor, and registers the
returned tool under a Jarela category + capability.

1. Pick a directory for installed packages. Default is
   `~/.jarela/packages/`; override with `JARELA_PACKAGES_DIR`.
2. Inside that directory, run `npm init -y` once, then `npm install`
   each package you want (e.g. `npm install @langchain/community`).
3. Create `<packages-dir>/manifests/<name>.json` per tool:
   ```json
   {
     "package": "@langchain/community/tools/tavily_search",
     "export": "TavilySearchResults",
     "category": "Web",
     "capability": "read",
     "args": { "maxResults": 5 },
     "requiredEnv": ["TAVILY_API_KEY"]
   }
   ```
   Fields:
   - `package` — npm module specifier (resolved from your packages dir's
     `node_modules`).
   - `export` — named export. Default `"default"`.
   - `category` — Jarela category (`"Web"`, `"Mail"`, … — same vocabulary
      as built-in tools, see [`registry.ts`](../lib/tools/runtime/registry.ts)).
   - `capability` — `"read"` / `"write"` / `"execute"`. Default
     `"execute"` (conservative).
   - `args` — constructor arguments, passed as a single object.
   - `requiredEnv` — optional. If any listed env var is unset, the
     manifest is skipped (with a `skipped` reason) instead of erroring.
4. Either restart the server (the agent sees the tool on its next turn)
   or hit `POST /api/v1/packages/reload` to re-scan without restart.

Inspect the loader state any time with `GET /api/v1/packages`, which
returns the resolved `packagesDir`, registered tool names, skipped
manifests (with reasons, e.g. `requiredEnv` unset), and per-manifest
errors. Both endpoints are thin wrappers around
[`lib/tools/packages/langchain-packages.ts`](../lib/tools/packages/langchain-packages.ts).

**Installing a package via API.** `POST /api/v1/packages/install`
with `{ "spec": "<npm-spec>", "version": "<optional>" }` runs
`npm install` inside `$JARELA_PACKAGES_DIR` and returns the
introspected `StructuredTool` exports it found. Packages from a
publisher in `PACKAGE_PUBLISHER_ALLOWLIST` (default `@langchain/*`,
`@circuitwall/*`, `langchain`; extend via the
`JARELA_PACKAGE_ALLOWLIST` env var, same pattern as
`ENV_ALLOWLIST` in [`lib/env/allowlist.ts`](../lib/env/allowlist.ts))
install immediately. Anything else returns `202` with a pending
approval id; `GET /api/v1/packages/install` lists pending approvals,
`POST /api/v1/packages/install/:id` approves and runs, and
`DELETE /api/v1/packages/install/:id` denies.

**Registering an installed package.** Once the package is on disk,
the manifest-CRUD endpoints create the file that the loader picks up:

- `GET /api/v1/packages/manifests` — list current manifests.
- `POST /api/v1/packages/manifests` with `{ name, package, export?,
  category, capability?, args?, requiredEnv? }` — write a new
  manifest and trigger a reload. 409 on duplicate name.
- `GET|PUT|DELETE /api/v1/packages/manifests/:name` — fetch, upsert
  (replace), or remove a single manifest.

Each mutating call triggers `reloadLangChainPackages()` so the tool
becomes live (or disappears) on the agent's next turn.

**Trust model.** A loaded package runs with full Node privilege in the
Jarela process, same as `JARELA_TOOLS_DIR` extensions. Only install
packages you would `npm install` into any of your own projects.

**Auth.** The constructor's `args` are the auth surface for this
release — for packages whose env vars do the work (Tavily, SerpAPI,
many community tools) just set the env var and add it to `requiredEnv`.
A future PR will add an Integrations-panel form for packages that need
operator-managed credentials.

---

## Adding an MCP server

Jarela's tool pool merges MCP-server tools with built-ins. To register a
server:

- **Via the UI.** App → Settings → MCP → Add server. Pick `stdio`
  (subprocess) or `http` (remote SSE/HTTP), fill in the spec, save.
- **Programmatically.** Call `upsertMcpServer(...)` from
  [`lib/stores/mcp-servers.ts`](../lib/stores/mcp-servers.ts) with a
  `McpServerInput`. Spec env vars and headers are encrypted at rest
  (ADR-0005).
- **From the registry picker.** The MCP picker UI fetches the official
  registry (registry.modelcontextprotocol.io). Variables (`${TOKEN}` etc.)
  are substituted via `applyVariables` from
  [`lib/mcp/registry.ts`](../lib/mcp/registry.ts).

After save, the agent sees the new tools in its pool on the next turn —
verify with the `list_tools` or `list_mcp_servers` tools. If a server's
`last_error` is non-null, fix the spec and the next request retries.

ADR: [0014](../docs/adr/0014-mcp-registry-online-discovery.md).

MCP results can include both human-readable `content` and machine-readable
`structuredContent`. Jarela appends the structured value as a text block labelled
`Structured result (JSON):`, so agents can use exact fields even when the text is
only a summary. Original text and multimodal content remain unchanged; private
protocol `_meta` is not copied into that block. Existing result-size limits still
apply. Tools without structured output retain their previous result shape.
Server-requested interactive input (elicitation) remains disabled.

Contract checked against the [MCP adapters 2.0 migration guide](https://docs.langchain.com/oss/javascript/migrate/langchain-mcp-adapters)
on 2026-10-25. Regression tests cover HTTP discovery/invocation, structured-only
results, multimodal preservation, and exclusion of protocol metadata.

---

## Adding a custom harness

A harness is the system-prompt scaffold an agent runs under: it composes
sections like "plan first," "list capabilities up front,"
"propose-config-change rules," etc. Built-in presets live in
[`lib/agents/harness/presets.ts`](../lib/agents/harness/presets.ts).

To add a custom harness:

- **From inside the app.** Use the agent's `propose_config_change` tool
  with kind `upsert_harness`. The user approves; the harness is stored in
  the `memory_store` table under the `app-settings` namespace.
- **By editing presets.** For an in-tree built-in harness, add a new
  entry to `presets.ts` — section keys, default order, body text.

An agent binds to a harness by `harness_id` on its config row. Resolution
order is per-agent → global default → `builtin:default` (see
[`lib/agents/harness/resolve.ts`](../lib/agents/harness/resolve.ts)).

ADR: [0036](../docs/adr/0036-agent-driven-harness-edits.md).

---

## Adding an integration manifest

An integration manifest tells the agent how to walk a user through
setting up a new external service (Atlassian, Gmail, GitHub, …). The
agent uses `list_integrations` and `get_integration_setup` tools to
narrate the recipe and proposes the corresponding config changes.

Steps:

1. Add a manifest under [`lib/integrations/registry.ts`](../lib/integrations/registry.ts) with prerequisites, ordered steps, and troubleshooting hints.
2. Each step that triggers a config change names its `proposes` kind
   (e.g. `install_mcp`, `update_agent_tools`, `update_agent`).
3. Each step that produces a verifiable side effect names its
   `verify.tool` so the agent can confirm success.
4. The manifest schema is enforced by
   `scripts/check-integration-manifests.mjs` (runs on lint).

ADR: [0010](../docs/adr/0010-agent-led-setup-and-integration-manifests.md).

Credential tests for built-in integrations are declared next to their fields
in [`lib/stores/integrations.ts`](../lib/stores/integrations.ts). A read-only
HTTPS endpoint can use `probe` metadata (credential field, bearer/header/query
auth, optional environment fallback, status overrides, and allowlisted response
summaries) without adding a probe function. Keep custom code in
[`lib/health/probes.ts`](../lib/health/probes.ts) for multi-step OAuth, local
CLI, or non-HTTP authentication flows.

---

## Branding the app

Jarela is published as `@circuitwall/jarela` on npm and licensed Apache-2.0.
Brand overlays (internal forks, white-label deployments) override identity
through configuration and assets — **no source edits**, so there is no rename
diff to rebase on every upstream release.

### You need a build you control

Read this before planning a rollout. The web app's brand values are
`NEXT_PUBLIC_*` env vars, which Next **inlines textually during `next build`**.
They are not read at runtime.

The npm package ships a *prebuilt* `.next/standalone`, already carrying the
Jarela name. So `npm i @circuitwall/jarela && jarela start` **cannot** be
rebranded by setting env vars — the strings are baked in, and `jarela-bin.mjs`
deliberately refuses to rebuild from inside `node_modules` (webpack excludes
that path). Rebranding the web app therefore means running the build yourself:

- **Fork and rebase.** Clone the repo, add `.env.production` with your
  `NEXT_PUBLIC_APP_*` values, drop your assets into `public/`, run
  `npm run build`. Your diff against upstream is config and assets only, so
  tracking each release stays cheap. This is the common case.
- **Wrapper repo.** Keep only `brand.json`, `.env.production`, and logos in
  your repo; have CI check out Jarela at a pinned tag, apply your env, build,
  and publish the artifact. Cleaner ownership boundary, same build step.

Runtime-switchable branding (no rebuild) is **not** supported — it would mean
serving brand config from an API and fetching it on boot. See ADR-0077.

The browser extension is the exception: its build is a packaging step over
static files, so it needs no Next build.

Accordingly the two surfaces differ: the web app reads build-time env vars,
while the browser extension takes a `brand.json` packaging step (its MV3
manifest and icons are static files).

### Web app: `NEXT_PUBLIC_APP_*`

Everything lives in [`lib/env/app-config.ts`](../lib/env/app-config.ts),
exported as the public subpath `@circuitwall/jarela/lib/env/app-config`.

| Env var                                    | Drives                                           |
|--------------------------------------------|--------------------------------------------------|
| `NEXT_PUBLIC_APP_NAME`                     | Page title, PWA `name`, notification titles       |
| `NEXT_PUBLIC_APP_SHORT_NAME`               | PWA `short_name` (defaults to the app name)       |
| `NEXT_PUBLIC_APP_DESCRIPTION`              | Meta description, PWA `description`               |
| `NEXT_PUBLIC_APP_ISSUE_URL`                | "Report a bug" link — **your** tracker            |
| `NEXT_PUBLIC_APP_LOGO_LIGHT`               | In-app wordmark on light surfaces                 |
| `NEXT_PUBLIC_APP_LOGO_DARK`                | Wordmark on dark surfaces (defaults to the light one) |
| `NEXT_PUBLIC_APP_ACCENT_COLOR`             | `--color-accent` (hex only)                       |
| `NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR`       | `--color-accent-hover` (defaults to accent −15% lightness) |
| `NEXT_PUBLIC_APP_FAVICON_SVG` / `_ICO`     | Favicon                                           |
| `NEXT_PUBLIC_APP_ICON_192` / `_512`        | PWA icons (`any` purpose)                         |
| `NEXT_PUBLIC_APP_ICON_192_MASKABLE` / `_512_MASKABLE` | PWA icons (`maskable` purpose)         |
| `NEXT_PUBLIC_APP_ICON_192_LIGHT` / `_512_LIGHT` (+ `_MASKABLE_LIGHT`) | Light-background icon variants |
| `NEXT_PUBLIC_APP_APPLE_TOUCH_ICON`         | iOS home-screen icon                              |

The simplest icon/logo swap is to **drop replacement files into `public/`
under the same names** — then you need none of the asset env vars. Set them
only when your assets live on other paths or a CDN.

Two things to know:

- These are inlined by Next at **build time**, so changing the brand means a
  rebuild, not a restart.
- The accent color must be a hex literal — 6-digit (`#7c3aed`) or 3-digit
  (`#7c3`). It is injected into a `<style>` block, so anything else is
  rejected and ignored.

The data directory follows the brand too: `JARELA_DB_DIR=~/.foo` gets isolated
state.

### Browser extension: `brand.json` + `npm run build:extension`

```bash
npm run build:extension -- --brand ./brand.json --out dist/my-extension
```

Unlike the web app, this works from the installed package too — the tarball
ships `browser-extension/` and the build script, so an overlay consuming
`@circuitwall/jarela` as a plain dependency can brand the extension without a
checkout:

```bash
node node_modules/@circuitwall/jarela/scripts/build-extension.mjs \
  --brand ./brand.json --out dist/my-extension
```

```jsonc
// brand.json — all keys optional
{
  "name": "Acme Assistant",
  "shortName": "Acme",
  "description": "Browser companion for Acme Assistant: …",
  "accentColor": "#7c3aed",
  "logo": "./brand/mark.png"   // toolbar icons are regenerated from this
}
```

This emits a ready-to-load extension folder with a templated `manifest.json`
(name, description, toolbar title, command description), a regenerated
`lib/brand.mjs`, and rebuilt icons. Run without `--brand` and the output
matches the in-tree Jarela extension (a test enforces this).

See [`browser-extension/README.md`](../browser-extension/README.md#rebranding).

### What you may not rebrand

Rebranded builds keep a small **"Powered by Jarela"** link — on the web boot
screen and the extension options page — pointing at the upstream repository.
`UPSTREAM_NAME` / `UPSTREAM_URL` are plain constants, not env vars, and
`build-extension.mjs` never templates them. The credit renders **only** once
you have actually renamed the app; the upstream build shows nothing.

This is separate from `NEXT_PUBLIC_APP_ISSUE_URL`, which is yours to redirect.
Upstream-facing machinery (update checks, tool-telemetry issue drafts) also
keeps pointing at `CircuitWall/jarela`.

Internal identifiers stay `jarela*` on both surfaces — DOM ids, `chrome.storage`
keys, CSS class/keyframe names, `globalThis` keys, DB tables. They are not
product names, and renaming them orphans stored config.

### Beyond the accent color

If you need deeper visual changes than one accent color, the pattern is still
to consume the package's `.next/standalone` build and apply tree-level
mutations in your own pipeline. Blessing arbitrary CSS overrides would turn
internal class names into a public API.

ADR: [0077](../docs/adr/0077-rebranding-overlay-contract.md), building on
[0005](../docs/adr/0005-rebrand-jarela.md).

---

## Agent introspection tools

The agent can introspect every extension surface above without any
out-of-band knowledge:

- `list_tools` — every tool currently in the pool, with category,
  capability, source. Filter by category / capability / source.
- `list_providers`, `describe_provider({ name })` — registered LLM
  providers and their static capabilities + known-model context windows.
- `list_mcp_servers` — configured MCP servers with enabled state, last
  error, transport, and tool count.
- `describe_extension_surfaces` — the curated catalog (mirrors this
  document) with registration entrypoints and doc anchors.
- `list_integrations`, `get_integration_setup({ id })` — agent-led setup
  manifests (the highest-level extension recipe).

When the user asks "what can you do" or "how do I add an X," the agent
should call these instead of describing the system from memory.
