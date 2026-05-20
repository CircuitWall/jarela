---
status: "accepted"
date: 2026-05-20
deciders: example-user
---

# Define a stable contract for hot-loaded external providers and tools

## Context and Problem Statement

Jarela had a half-built extension story: `lib/providers/external.ts` could load
`.cjs` files from `~/.jarela/providers/` with cache-busting for hot-reload, but
the result was frozen at module init in `lib/providers/index.ts` so the
hot-reload never fired. Tools had no equivalent — adding a new tool required
editing `lib/tools/index.ts` and rebuilding.

We want both human authors and AI agents to be able to drop a single self-
contained file into a known directory and see it picked up by the running
process without restart, with a contract simple enough to write by hand.

## Decision Drivers

* The contract must be writable by hand or by an LLM with no Jarela source
  open. That excludes anything requiring `import` of in-tree LangChain/Zod.
* Extensions must survive Jarela version bumps that touch LangChain internals.
* Extensions must hot-reload without restart so iteration feels like editing a
  config file, not deploying code.
* Validation errors must be visible to the author. Silent failure is a foot-gun.
* No new sandbox / permission model — extensions run in-process with the same
  Node privileges as the rest of the app, matching how locally-spawned MCP
  servers behave today.

## Considered Options

* **A — Plain object, no langchain import.** Tool exports `{ name, description,
  schema (JSON Schema), category?, run(args, ctx) }`. Loader wraps via
  `tool()`. Provider keeps the existing `ModelProvider` interface (already
  dep-free because providers use `fetch`).
* **B — LangChain-native.** Tool author imports `tool` and `z` directly,
  returns a `StructuredTool`. Provider unchanged.
* **C — Both shapes accepted.** Sniff the export.

## Decision Outcome

Chosen option: **A — Plain object for tools, existing `ModelProvider` for
providers.** Both directories are scanned **per-call** by `getProvider` /
`getAllTools(Async)`, so dropped files are visible on the next request.

### Consequences

* Good — author writes one self-contained `.cjs` file with no project deps.
  An LLM can produce a working extension from the contract alone.
* Good — contract survives LangChain version churn; we own the wrapper.
* Good — same loader pattern (`createRequire` + cache-bust) for both kinds.
  One mental model.
* Bad — authors lose Zod's type inference. JSON Schema is the only validation
  surface. Acceptable: the LLM already consumes JSON Schema, and JSON Schema
  is the documented standard for tool inputs.
* Bad — extensions run in-process with full Node privileges. Identical to
  MCP-stdio servers; documented in README so users know what they're running.
* Bad — per-call `readdirSync` adds microseconds to every chat turn. Negligible
  at expected scale; if it ever shows up in profiles, add an mtime cache
  inside the loaders without changing the public contract.

## Pros and Cons of the Options

### A — Plain object

* Good — zero project deps; author copies a single file and edits it.
* Good — works for AI agents writing extensions (no module resolution).
* Neutral — validation is JSON Schema, not Zod.

### B — LangChain-native

* Good — exact symmetry with built-in tools.
* Bad — external file must resolve `@langchain/core` and `zod`. From
  `~/.jarela/tools/`, those don't resolve to the app's bundled copies; author
  must `npm install` those deps in a separate `node_modules` next to their
  files. Defeats the "drop a file" UX.
* Bad — couples extension authors to LangChain version churn.

### C — Both shapes

* Good — flexible.
* Bad — two contracts, two validation paths, two failure modes. We don't have
  enough author demand to justify the surface area.

## Contract — external tool (final)

```js
// ~/.jarela/tools/<name>.cjs
module.exports = {
  name: "weather",                     // unique; collisions with built-ins are rejected
  description: "Get weather for a city.",
  category: "Web",                     // optional UI grouping
  schema: {                            // JSON Schema 7
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  async run({ city }, ctx) {           // ctx = { thread_id?: string }
    const r = await fetch(`https://wttr.in/${city}?format=j1`);
    return await r.json();             // serialized to JSON for the agent
  },
};
```

## Contract — external provider (final, unchanged)

See `lib/providers/types.ts`. Minimum: `{ name: string, async chat(model_id,
messages, params): { stream } }`. Optional: `invoke`, `streamInvoke`, `embed`.

## Reload semantics

* Per-call: `getProvider`, `listProviderNames`, `getAllTools`, `getAllToolsAsync`,
  `executeTool` re-scan the directory and cache-bust changed files via
  `delete req.cache[req.resolve(path)]`.
* No `fs.watch`. No reload endpoint. The next message is the trigger.
* Validation errors are returned on `GET /api/v1/extensions` and shown in the
  Extensions tab in-app.

## Out of scope

* Sandboxing — explicitly accepted as same-trust as locally-spawned MCP servers.
* `manifest.json` or contract versioning — single-file `.cjs` is the v1
  contract. Re-evaluate when we have a real second version to support.
* TypeScript-source extensions with on-the-fly compilation. `.ts` files are
  accepted by the loader's regex but only work if the user pre-compiles.
  Recommended extension is `.cjs`.

## More Information

* Loader code: `lib/providers/external.ts`, `lib/tools/external.ts`
* Templates: `lib/providers/template-external.cjs.example`,
  `lib/tools/template-external.cjs.example`
* UI surface: `components/extensions/ExtensionsPanel.tsx`,
  `app/api/v1/extensions/route.ts`
