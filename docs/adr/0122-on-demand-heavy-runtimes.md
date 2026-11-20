# ADR-0122: Install heavy runtimes on demand

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0121](./0121-optional-tool-and-integration-dependencies.md)
(declaration, probe, plan, install), [ADR-0101](./0101-on-demand-local-embedding-model.md)
(on-demand embedding *model*), [ADR-0111](./0111-dependable-core-user-owned-extensions.md).

## Context

Two capabilities dominate the install footprint but are used by a minority of
installs:

| Capability | Package and transitive runtime | Measured install cost |
| --- | --- | --- |
| Local embeddings | `@huggingface/transformers` → `onnxruntime-node` + `onnxruntime-web` | 426 MB |
| Copilot delegate | `@microsoft/copilot-sdk` → `@microsoft/copilot-sdk-<platform>` | 206 MB |

Measured on a development checkout: `node_modules` was 1,639 MB; after moving
both, 992 MB — a **647 MB (≈40%) reduction**. Both are already loaded through a
dynamic `import()` at call time, and both are listed in
`serverExternalPackages`, so neither is bundled by webpack.

ADR-0121 introduced the contract that makes on-demand installation safe:
declarations, cached probes, catalogue/permission gating, and the
install-on-request path. What was missing was one runtime resolver that does
not depend on the build-time module graph.

## Decision

1. `@huggingface/transformers` and `@microsoft/copilot-sdk` are **removed from
   `dependencies`**. They are not moved to `optionalDependencies`: npm installs
   those by default, so that would save nothing.
2. They are resolved at call time by `lib/dependencies/runtime-package.ts`
   through `createRequire`, from `$JARELA_PACKAGES_DIR` (or the app root in a
   development checkout). Next never sees the specifier, so an absent package
   is a runtime state, not a build failure. The module imports only leaf
   modules (`lib/tools/packages/packages-dir.ts`) because it is reached from
   `lib/embeddings/local.ts`, which sits on the tool-registry module graph.
3. A missing runtime raises `RuntimePackageUnavailableError`, which names the
   package and the exact fix. Embeddings already degrade to `null` and callers
   fall back to lexical retrieval, so absence disables the enhancement without
   breaking recall, search, or indexing.
4. Installation is explicit: `POST /api/v1/dependencies/install` with
   `target=runtime:<package>` installs into the managed packages directory.
   Both package names are in `PACKAGE_PUBLISHER_ALLOWLIST` (exact match, not a
   whole publisher scope) so the one-click path works without widening trust.
5. `copilot_delegate` declares the SDK as a `node-package` dependency through
   its integration manifest; the tool catalogue now falls back to the backing
   integration's declarations, so the tool is gated by the same probe that
   gates enabling the integration.

## Consequences

### Positive

- A default install is ~647 MB smaller; the Docker image and `npm i -g` shrink
  with it.
- The two heaviest optional features fail with an actionable message instead of
  an unresolved-module crash, and cannot be silently used when absent.
- The published-package smoke test now asserts the runtimes are *absent* from a
  plain install, so the saving cannot regress unnoticed.

### Negative / costs

- First use of local embeddings or the Copilot delegate after an upgrade
  requires an explicit install (one request).
- `npm run test:package` no longer exercises a real embedding inference run;
  the model-download path (ADR-0101) is still verified where the runtime is
  present, and `local.integration.test.ts` skips when either is missing.
- Release notes must call out that these features need one extra install step.

## More Information

- Resolver: `lib/dependencies/runtime-package.ts`, `lib/tools/packages/packages-dir.ts`.
- Call sites: `lib/embeddings/local.ts`, `lib/tools/delegation/copilot-sdk-adapter.ts`.
- Declarations: `lib/integrations/github-copilot-cli/manifest.ts`; runtime
  target in `lib/dependencies/plan.ts`.
- Guards: `scripts/check-npm-package.mjs`.
