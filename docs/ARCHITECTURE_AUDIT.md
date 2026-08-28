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