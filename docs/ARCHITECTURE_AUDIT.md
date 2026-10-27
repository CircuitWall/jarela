# Architecture Audit — 2026-08-28

This audit records the whole-repo architecture findings from the 1.29.1
dependency-upgrade cycle. It is intentionally findings-first: implementation
work should happen in separate, focused PRs unless a dependency upgrade forces a
local change.

## High Priority

1. **UI preference state bypasses store boundaries.** Theme, experience mode,
   and currency preferences still write directly to `localStorage`. Persistent
   state normally belongs in `lib/stores` or needs a documented browser-cache
   exception.
2. **API validation style is inconsistent.** Some `app/api/v1/**` routes call
   zod `safeParse()` directly while others use `validateBody()`. New routes
   should use the shared helper so error response shape and future auditing stay
   centralized.
3. **External tool capability metadata is under-specified.** Built-in tools use
   read/write/execute capability tiers, but external `.cjs` tools still default
   to `execute`. A stricter contract needs an ADR and compatibility window.
4. **Secret-bearing surfaces need explicit redaction tests.** Credentials,
   MCP server env, proxy config, and external plugin manifests should have
   contract tests proving API responses never expose secret values.

## Medium Priority

5. **Chat runtime composition remains tightly coupled.** `ChatView`, `useSSE`,
   and `useChatQueue` still depend on refs and render-order bridges. Avoid
   adding more public methods or mirrored refs; extract transport/content/activity
   responsibilities in small steps.
6. **Provider and tool capability axes are separate.** Provider capabilities
   such as vision/files/tools and tool capabilities such as read/write/execute
   are documented in different places. Extension docs should keep both axes
   explicit until a unified schema exists.
7. **Hot-loaded plugin trust is implicit.** External providers and tools execute
   in-process with user privileges. Signature verification is out of scope for
   now, but docs should warn operators and future work should consider file
   permission checks or load auditing.

## Low Priority

8. **External tool category defaults reduce discoverability.** Omitted external
   tool categories fall back to MCP, which can misclassify non-MCP plugins.
9. **Migrations are forward-only.** Downgrades after schema changes are not a
   supported recovery path. Installation and release docs should continue to
   treat backups as the rollback strategy.
10. **Documentation version drift needs lightweight checks.** README, CLAUDE.md,
    and architecture docs can drift from `package.json` on framework versions.
    A future script could check major-version claims.

## Upgrade-Specific Guardrails

- Preserve the single Next.js process invariant.
- Avoid module-level `getDb()` calls that can run during `next build` workers.
- Keep workspace package publishing protected by `npm run test:package` so
  `workspace:` dependencies never leak into the npm tarball.
- Validate provider SDK upgrades with model-router, attachment, MCP/tool, and
  live smoke tests where credentials are available.

## Follow-up audit — 2026-10-27

This is a repository-wide **code-level architecture and class-duplication
review** of Jarela `2.7.0` with unreleased changes, at commit
`245b71111c1942e4252e3cfb973b7fd68f261515`, plus the package-boundary and
class-level findings below. Five commits follow the documentation baseline
`7434a9e5`. The review covered the five workspace packages, internal
dependency direction, production class inventory, and class-level extraction
candidates; implementation status is recorded separately below.

This review is complete for those code-level criteria. It is not a formal
release-documentation review and does not advance the full documentation
baseline in `docs/index.md`. Earlier architecture findings below remain
separate follow-ups and are not represented as fully re-audited here.

### Workspace package boundary

The five current packages under `packages/` have separate manifests, source,
tests, and package versions. A targeted source-import scan found no imports from
package source into Jarela's app-private modules or sibling workspace packages.
The host-side adapters in `lib/` are the integration seam, not a package
boundary violation.

The review identified these package-architecture gaps:

1. **No package-local SOPs.** None of the five packages has an `AGENTS.md`,
   `SOP.md`, or `CONTRIBUTING.md`. Root guidance covers shared repository rules,
   but package-specific validation, compatibility, ownership, and release
   procedures have no package-local home.
2. **Package lifecycle is centrally coupled.** Each package delegates its
   build to `scripts/build-workspace-package.mjs`, whose Node target is fixed
   to Node 24. New packages also require central CI/release workflow wiring.
   This limits independent package-specific build and release policy.
3. **Package config guidance does not match implementation.**
   `packages/README.md` says packages inherit shared base configs, but the
   current package TypeScript configs duplicate options and do not extend a
   shared config.
4. **Stale package examples.** `packages/README.md` refers to
   `@circuitwall/jira-langchain` and `@circuitwall/jira-client`, neither of
   which is one of the current workspace packages.

### Jarela internal boundaries

1. **Compile-time dependency points upward.** `lib/ui/navigate.ts` imports the
   `Tab` type from `contexts/AppContext.tsx`. Although this is a type-only
   import and creates no runtime dependency, a lower-level navigation parser
   now depends on a React context module for its shared route vocabulary.
   Confirmed boundary leak; assess whether the tab contract belongs in a
   neutral shared module before changing it.
2. **Optional request body is a route-specific contract, not a confirmed
   validation violation.** `app/api/v1/agents/[id]/duplicate/route.ts` accepts
   an empty body before applying its schema. It is not equivalent to routes
   that require JSON through `validateBody()`, so this route alone does not
   establish an incorrect helper bypass.

### Class-level duplication review

The production class inventory across `lib/`, API routes, and workspace
packages contains adapters, stateful utilities, and error types. No class in
workspace package source reaches into Jarela internals. Two extractions are
worthwhile; one additional small consistency extraction is optional. Other
inspected classes either already centralize shared behavior or have distinct
state/lifecycle semantics.

1. **Repeated memory-value decoding — implemented.** `SqliteMemoryStore.batch()`
   in `lib/stores/langgraph-store.ts` now uses `parseJsonSafe()` in both get
   and search paths, preserving the `{ _raw: value }` malformed-JSON fallback.
2. **Duplicated bounded message-ID tracking — implemented.**
   `WhatsAppBridgeAdapter` previously had parallel sent-ID and received-ID
   array/set pairs with the same insertion, duplicate check, and oldest-entry
   eviction logic, but different capacity limits.
   `lib/cache/keyed-cache.ts` already provides `createContentCache()`. Its
   non-mutating `has()` plus insertion
   order eviction can preserve the current FIFO behavior when used as a
   membership cache; instantiate it separately for sent and received IDs with
   their existing capacities. Both rings now use bounded caches; focused tests
   verify sent-echo suppression, FIFO eviction, and retained-ID deduplication.
3. **Optional consistency extraction for checkpoint parent config.**
   `NodeSqliteSaver.getTuple()` and `NodeSqliteSaver.list()` each construct the
   same `parentConfig` shape from a row. A small private mapper could centralize
   that repeated shape. Keep this low priority: the surrounding `config`
   objects differ by operation, so a broader config-builder abstraction would
   be misleading.

Not recommended as extractions:

- `ProviderRateLimiter` intentionally holds permits for different lifetimes:
  calls release after a result, while chat streams retain the permit until the
  stream closes or aborts. A generic wrapper would obscure that distinction.
- `NodeSqliteSaver` already centralizes row decoding in `decodeRowState()`;
  only the small parent-config mapping above is repeated.
- `JarelaChatModel` repeats only a small preparation pair in generation paths;
  a helper would add indirection without meaningful deduplication.
- `TerminalSession`, `StreamRehydrator`, and `ToolOutcomes` each own focused,
  stateful behavior rather than duplicate class functionality.

The low-priority checkpoint config mapping remains a recommendation only. The
previously recorded findings about browser preference persistence, route
validation conventions, plugin trust/capabilities, and chat composition remain
open follow-ups and were not claimed as exhaustively verified by this
class-focused pass.