---
status: accepted
date: 2026-05-19
deciders: andwu
consulted:
informed:
---

# Distribute Jarela via portable per-OS archives and an npm package

## Context and Problem Statement

To install Jarela today a user must clone the git repo and run
`scripts/install-to-system.sh` (macOS) or `scripts/install-to-system.ps1`
(Windows), both of which themselves invoke `npm run build`. That requires
git, Node 22+, npm, and the entire repo on disk before the app does
anything. For anyone outside the development loop this is a wall.

How should we ship Jarela so that (a) a non-developer can install it
without cloning, (b) developers who already have Node can install it the
same way they install any other CLI, (c) we don't pay for code-signing
certificates yet, and (d) the existing `install-to-system` scripts —
which already handle LaunchAgent / Scheduled Task wiring — remain the
single source of truth for OS integration?

## Decision Drivers

* **Two install paths cover the audience.** A non-developer wants
  "download a thing, double-click, accept the OS warning." A developer
  wants `npm install -g jarela`. Anything else is overkill.
* **Existing install scripts are the OS-integration layer.** They
  already wire LaunchAgent / Scheduled Task, split secret/non-secret
  env, and handle `--skip-build` for a pre-built tree. Re-implementing
  any of that inside a new installer (Tauri, electron-builder, MSIX,
  WiX) would duplicate logic and add a tooling dependency.
* **No paid certs (yet).** Apple Developer ID and Authenticode certs
  cost money and require secret management in CI. The first release
  ships unsigned; users accept the OS warning once. Re-evaluate when
  install volume justifies the cost.
* **Native deps must match the host OS.** `better-sqlite3`, `keytar`,
  and the Baileys deps ship platform-specific prebuilts during
  `npm ci`. A standalone tree built on Linux will not load on macOS.
  This forces either per-OS archives or per-host install.
* **Single tag → all artifacts.** One `git tag v…` push must produce
  every distribution channel. No human running `npm publish` from a
  laptop.
* **Strongly favor simplicity** (global CLAUDE.md). Each layer of
  packaging has to justify itself.

## Considered Options

* **A. Per-OS portable archives + npm package** (chosen).
  GitHub Actions matrix builds on `macos-latest`, `windows-latest`,
  `ubuntu-latest`. Each runner runs `npm run build`, stages the
  `.next/standalone/` tree + `.next/static/` + `public/` + the
  matching install script + `package.json`, and produces a `.tar.gz`
  / `.zip`. A separate publish job runs `npm publish` from one of
  the runners. Source-only npm tarball; `jarela` CLI builds on first
  invocation.
* **B. Per-OS archives only.** Drop npm publish. Developers still
  have to clone for the dev workflow, but the GH release archives
  cover non-developer install. Simplest, but loses the
  one-line install path that npm gives free.
* **C. Native installers (.dmg + create-dmg, .msi via WiX, .exe via
  electron-builder).** Best end-user UX (drag to Applications,
  Add/Remove Programs entry). Requires per-installer tooling
  pinned in CI, and the install steps the existing scripts perform
  (LaunchAgent / Scheduled Task) need a second implementation
  inside each installer. Doubles the maintenance surface.
* **D. Tauri / Electron wrapper.** Treat Jarela as a desktop app.
  Wraps the Next.js process inside a native window, ships a single
  binary per OS. Heavy: introduces a Rust / native build chain,
  changes the runtime model from "browser → localhost" to
  "embedded WebView", and would need its own ADR for the runtime
  shift. Out of scope for "ship a download link this week."
* **E. Per-OS npm sub-packages** (the esbuild/swc model:
  `@jarela/cli-darwin-arm64` + meta package that selects the right
  one at install time). Solves the native-dep matching for npm,
  but at the cost of three publish steps per release and a
  dispatch package. Not justified for current scale.

## Decision Outcome

Chosen option: **A**.

A is the only option that covers both audiences (non-developer + dev)
while keeping the existing `install-to-system` scripts as the single
OS-integration source of truth. Archives are a thin packaging step over
what the scripts already expect; `npm publish` is a thin packaging step
over what `npm run build` already produces. No new toolchain, no new
secrets needed beyond an `NPM_TOKEN`, no per-installer code path.

### Per-OS archive layout

Each archive expands to `jarela-<version>-<os>/` containing:

```
jarela-<version>-<os>/
├── .next/standalone/        # runtime tree (built on this OS)
├── .next/static/            # static assets — install script reads from here
├── public/                  # public files — install script reads from here
├── scripts/
│   ├── install-to-system.sh        # mac/linux bundle only
│   ├── _jarela-tailscale.sh        #   "
│   ├── install-to-system.ps1       # windows bundle only
│   ├── installed-launcher.ps1      #   "
│   ├── installed-launcher.vbs      #   "
│   └── _jarela-tailscale.ps1       #   "
├── package.json             # version reference; install script checks for it
└── INSTALL.md               # extract → run install script with --skip-build
```

`mac` / `linux` bundles ship the bash script set; `windows` bundles
ship the PowerShell set. The install scripts already accept
`--skip-build` / `-SkipBuild`, so they reuse the pre-built tree from
the matching-OS runner.

### npm package shape

Lazy build, single platform-agnostic source tarball:

* Flip `package.json` `private: true` → remove.
* Add `bin: { "jarela": "./scripts/jarela-bin.mjs" }`.
* Add a `files` whitelist so the tarball ships source +
  `scripts/` + `public/` + configs only — no `.next/`, no
  `node_modules/`, no tests, no dotfiles.
* `jarela-bin.mjs`: if `.next/standalone/server.js` is missing, run
  `npm run build` from the install location, then chain into
  `start-prod.mjs`. First run takes ~30–60 s; subsequent runs are
  instant.
* Move build-time dependencies (`tailwindcss`, `@tailwindcss/postcss`,
  `postcss`, `autoprefixer`, `typescript`, `@types/*`) from
  `devDependencies` to `dependencies`. Reason: a global `npm install`
  does not pull devDependencies, but the lazy-build path needs them.
  Eslint stays in devDeps.

### Why no native installers (.dmg / .msi)

Two reasons. First, the OS-integration work — autostart at login,
process supervision, env-var splitting between plist and a
mode-600 secret file — already lives in the install scripts. Wrapping
those in a `.dmg` would mean either calling the scripts from a
postinstall step (which gives the user nothing the archive doesn't)
or rewriting their logic in the installer's native language (double
maintenance). Second, signing-and-notarization is the *actual* UX win
of native installers, and we have decided to defer signing.

### Why one platform-agnostic npm tarball, not three per-OS

Native deps (`better-sqlite3`, `keytar`) install platform-specific
prebuilds when npm pulls them on the user's machine — not from the
publish-time tarball. So a single source tarball is platform-agnostic
*as long as* we don't pre-bake `.next/standalone/`. Pre-baking would
require either three sub-packages (option E) or a postinstall rebuild,
both of which cost more than the 30–60 s first-run build.

### Release trigger

Single workflow `.github/workflows/release.yml`, fires on
`push` of tags matching `v*`. Matrix produces three archives, then a
single `npm publish` job runs. Both gated on the tag.

## Consequences

* Good, because `git tag v0.2.0 && git push --tags` produces every
  artifact channel without further human action.
* Good, because the install scripts remain the single source of truth
  for OS integration; archives just feed them a pre-built tree.
* Good, because npm-installed users get a CLI (`jarela`) that auto-builds
  once and starts immediately thereafter — no separate "install then
  build" step to document.
* Good, because no paid certs are required to ship.
* Bad, because users see an OS security warning on first launch from
  the unsigned archive (macOS "unidentified developer", Windows
  SmartScreen). Mitigated by INSTALL.md including the right-click-Open
  / "More info → Run anyway" workaround. Re-evaluate when install
  volume justifies signing.
* Bad, because `npm install -g jarela` pulls more deps than necessary
  (build deps now in `dependencies`). Acceptable: every npm user *is*
  a build user in the lazy-build model.
* Bad, because the first `jarela` invocation blocks for 30–60 s on
  the build. Acceptable: it happens once per install, with progress
  output.
* Bad, because we now have three OS-specific build artifacts to keep
  green in CI; an arch-specific bug surfaces later than in the
  single-runner CI. Mitigated: the existing CI continues to gate on
  ubuntu-latest, and tag-push releases run all three before publishing.

## Pros and Cons of the Options

### A. Archives + npm

* Good, because covers both audiences with one workflow.
* Good, because reuses existing install scripts — no duplicate
  OS-integration logic.
* Good, because zero paid certs and zero new tooling.
* Bad, because first-run npm build delay.

### B. Archives only

* Good, because simplest possible CI workflow.
* Bad, because no `npm install -g jarela` path; developers still
  have to clone.

### C. Native installers

* Good, because best end-user "just works" experience.
* Bad, because requires per-installer tooling (`create-dmg`, WiX or
  MSIX, possibly NSIS) pinned and maintained in CI.
* Bad, because OS-integration logic gets duplicated between the
  installer's preinstall/postinstall hooks and the existing scripts.
* Bad, because the *actual* UX win — no scary warning — needs paid
  signing certs, which we are deferring.

### D. Tauri / Electron

* Good, because produces a single per-OS binary that *looks* like a
  desktop app.
* Bad, because changes the runtime model (embedded WebView vs.
  browser → localhost) and requires its own ADR.
* Bad, because adds a Rust toolchain (Tauri) or Chromium bundle
  (Electron) — both heavy.

### E. Per-OS npm sub-packages

* Good, because solves the platform-prebuilt problem for npm.
* Bad, because three publishes per release and a dispatch package to
  maintain. Disproportionate for current scale.

## More Information

* Builds on [[adr-0006-windows-state-dir-localappdata]] (Windows
  install layout) and [[adr-0009-in-app-http-proxy-configuration]]
  (proxy env split between plist and `~/.jarela/proxy.env`).
* The first-launch experience for unsigned macOS archives:
  `xattr -dr com.apple.quarantine jarela-<version>-darwin/`,
  documented in INSTALL.md.
* Follow-ups (deferred):
  * Signing — Apple Developer ID + Authenticode — once install
    volume justifies the cost.
  * `arm64` vs `x86_64` macOS matrix split. Current `macos-latest`
    is arm64 only; Intel Mac users would need a `macos-13` job.
  * Auto-update mechanism. Currently users re-download / `npm update -g jarela`.
