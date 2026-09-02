---
status: "accepted"
date: 2026-09-02
deciders: example-user
consulted:
informed:
---

# Rebranding is a config overlay, not a fork

## Context and Problem Statement

ADR-0005 renamed LangGUI to Jarela with a hard rename and "no dual-name shims
at the code level". That settled *our* name, but it left downstream rebranding
unspecified. Since then a partial mechanism accreted: `lib/env/app-config.ts`
exposed `NEXT_PUBLIC_APP_NAME` / `_DESCRIPTION` / `_ISSUE_URL`, and
`docs/EXTENDING.md` documented them under "Branding the app" — while admitting
"There is no sanctioned 'code hook' for overlays yet — open an issue if you
need one."

That mechanism covers only three strings. Everything else a rebrand needs was
hardcoded:

* `public/manifest.json` — PWA `name` / `short_name` / `description`.
* `components/ui/Logo.tsx`, `app/layout.tsx` icons, notification icons.
* Accent color, only changeable by editing `app/globals.css`.
* The entire browser extension: MV3 `manifest.json`, ~150 `Jarela` strings
  across `background.js`, `content.js`, `popup.js`, `options.js`,
  `agent-overlay.js`, the HTML pages, and brand colors in `content.css`.

Meanwhile Jarela is Apache-2.0 and published as `@circuitwall/jarela`, so
overlays consuming the package are an expected use. The open question: how do
they rebrand without forking, and what — if anything — must survive a rebrand?

## Decision Drivers

* An overlay should need **zero code changes** — patching source means merge
  pain on every upstream release.
* The web app already inlines `NEXT_PUBLIC_*` at build time, which reaches
  client components with no Context and no server round-trip. Reuse it rather
  than invent a parallel channel.
* The browser extension **cannot** use that channel: MV3 `manifest.json` and
  icon files are static assets in a folder the browser loads directly.
* Attribution should be preserved without being obnoxious, and without
  depending on the overlay's goodwill to keep it.
* No telemetry, no required cloud calls (CLAUDE.md) — attribution must be a
  static link, never a callback.

## Considered Options

* **A. Env-var overlay for the web app + a packaging step for the extension**
  (chosen).
* **B. A runtime "brand profile" stored in the DB, editable in Settings.**
  Would let a user rebrand a running instance, but brand identity is a
  *deployment* property, not user state; it would also add a schema migration
  and put the manifest behind a DB read on every request.
* **C. Tell overlays to fork.** Zero upstream work, but every fork then carries
  a permanent rename diff that conflicts with each release — the exact cost
  ADR-0005 avoided internally.
* **D. Full theming system (arbitrary CSS injection, template overrides).**
  Maximum flexibility, but it turns every internal class name into a public
  API and blocks routine UI refactors.

## Decision Outcome

Chosen option: **A**.

### Web app: `NEXT_PUBLIC_APP_*`

`lib/env/app-config.ts` is the whole contract and is exported as the public
subpath `@circuitwall/jarela/lib/env/app-config`. It grows beyond the original
three strings to cover short name, logo (light/dark), the favicon/PWA icon
set, and an accent color.

Two consequences follow from Next's build-time inlining:

1. Every read must spell out `process.env.NEXT_PUBLIC_X` as a *literal* member
   expression. Next substitutes textually, so a computed lookup
   (`process.env[key]`) survives into the browser bundle as `undefined`. The
   module carries a comment saying so.
2. `public/manifest.json` becomes `app/manifest.ts` (logic in
   `lib/env/app-manifest.ts` so it's unit-testable), served at
   `/manifest.webmanifest`.

**This means overlays must run their own build.** The published npm package
ships a prebuilt `.next/standalone` with the upstream name already inlined, and
`jarela-bin.mjs` refuses to rebuild from inside `node_modules`. So installing
`@circuitwall/jarela` as a plain dependency and setting `NEXT_PUBLIC_APP_*`
does *not* rebrand it. Overlays either fork and rebase (config + assets only,
no rename diff) or keep a wrapper repo whose CI builds a pinned upstream tag.
The value delivered here is the absence of a rename diff, not the absence of a
build. The browser extension is exempt — its build is a packaging step over
static files.

The accent color is injected as a `<style>` block overriding
`--color-accent` / `--color-accent-hover`, which every `bg-accent` utility
already reads. Values are validated against a hex literal regex — this is the
one place overlay input reaches a stylesheet, so anything else is rejected
rather than escaped. When only a base accent is given, the hover shade is
derived by darkening it 15%.

**Richer theming stays out of scope.** Overlays needing more than an accent
still consume the built `.next/standalone` tree and mutate it in their own
pipeline. Blessing arbitrary CSS overrides would freeze internal class names.

### Browser extension: a build step

The extension gets `browser-extension/lib/brand.mjs` as the single runtime
source of truth for product strings, and `scripts/build-extension.mjs`
(`npm run build:extension`) which reads an optional `brand.json` and emits a
branded copy to `dist/browser-extension/`: templated `manifest.json`,
regenerated `lib/brand.mjs`, and icons rebuilt from the brand logo via a now-
parameterized `generate-icons.mjs`.

With no `brand.json` the output is semantically identical to the in-tree
extension; a test asserts that so the two cannot drift.

Markup carries `data-brand-template="{name} …"` placeholders that
`applyBrand()` fills in, because MV3 forbids inline `<script>`.
`agent-overlay.js` is a *classic* content script and must register its message
listeners synchronously, so it paints placeholders first and brands them when
its dynamic `import()` of `brand.mjs` resolves. `background.js` passes the
product name through `executeScript` `args` — an injected `func` is serialized
and cannot close over `BRAND`.

### What a rebrand may NOT change

`UPSTREAM_NAME` / `UPSTREAM_URL` are plain constants in both
`lib/env/app-config.ts` and `browser-extension/lib/brand.mjs`. They are not
env-backed, and `build-extension.mjs` never templates them. A "Powered by
Jarela" link renders on the web boot screen and the extension options page —
but only when the app has actually been renamed, since the credit is noise in
the upstream build itself.

This is distinct from `getAppIssueUrl()` (`NEXT_PUBLIC_APP_ISSUE_URL`), which
*is* overridable and points at the **fork's own** tracker. Upstream-facing
machinery — `lib/lifecycle/update-check.ts`, `lib/tools/tool-telemetry-issue.ts`,
`components/tools/ToolCatalog.tsx` — keeps its hardcoded `CircuitWall/jarela`
target unchanged.

Internal identifiers stay `jarela*` in both surfaces: DOM ids
(`#__jarela-overlay`), `chrome.storage` keys (`jarelaConfig`), CSS class and
keyframe names, `globalThis` keys, and DB table names. They are not product
names, and renaming them orphans stored config — the same reasoning ADR-0005
applied to DB tables.

## Consequences

* Good, because an overlay rebrands with env vars plus an optional
  `brand.json`, and carries no source diff to rebase.
* Good, because the brand surface is one exported module per side, so its
  contract is greppable and unit-tested.
* Good, because attribution survives rebranding by construction rather than by
  license text alone.
* Bad, because `NEXT_PUBLIC_*` is build-time: changing the brand means a
  rebuild, not a restart — and overlays must own a build pipeline rather than
  consuming the prebuilt npm artifact as-is.
* Bad, because the extension now has a build step where it previously had
  none. Loading `browser-extension/` unpacked still works unchanged for
  upstream development.
* Bad, because deep visual rebranding beyond the accent color still requires
  the overlay to post-process the standalone build.
