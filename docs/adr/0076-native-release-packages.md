---
status: accepted
date: 2026-09-01
deciders: example-user
consulted:
informed:
---

# Add native release packages

## Context and Problem Statement

ADR-0011 chose portable per-OS archives plus npm because that was the lowest
maintenance route to a downloadable release. Jarela now needs native release
packages for Windows, macOS, and Linux so users can install through OS-native
package flows instead of extracting archives and running scripts by hand.

## Decision Drivers

* Keep the Next.js localhost runtime model. Native packages should not introduce
  an Electron, Tauri, or daemon architecture change.
* Keep a single staged release payload per OS, so archives and native packages
  contain the same built application.
* Avoid requiring a separate Node install for native-package users.
* Keep per-user autostart in `jarela install-service`, where the existing
  LaunchAgent, Scheduled Task, and systemd user-unit logic already lives.
* Ship unsigned packages until code-signing and notarization are explicitly
  funded and configured.

## Considered Options

* **A. Wrap the existing staged payload in native package formats** (chosen).
  The release workflow builds the current standalone Next payload per OS, adds
  a copied Node runtime, and packages it as `.msi`, `.pkg`, `.deb`, and `.rpm`.
* **B. Replace archives with Electron / Tauri installers.** Better desktop-app
  affordances, but it changes the runtime model and adds a second application
  shell.
* **C. Keep archives only.** Lowest maintenance, but does not meet the native
  package requirement.

## Decision Outcome

Chosen option: **A**.

The release workflow now publishes these additional artifacts on `v*` tags:

* `jarela-<version>-win.msi`
* `jarela-<version>-darwin.pkg`
* `jarela-<version>-linux.deb`
* `jarela-<version>-linux.rpm`

Native packages install the same built app tree that the archive path uses, plus
a copied Node executable under the application payload. The installed launcher
invokes that bundled Node runtime and `scripts/jarela-bin.mjs`.

Autostart remains opt-in via `jarela install-service`. This avoids running
per-user service setup from elevated/package-manager postinstall contexts, where
the installer may not know which user should own the LaunchAgent, Scheduled Task,
or systemd user unit.

Windows MSI creation uses the WiX .NET command-line tool. WiX 7.0.0 documents an
Open Source Maintenance Fee for revenue-generating users; keep that in mind for
release infrastructure and redistribution decisions.

## Consequences

* Good, because users get OS-native package artifacts without changing the app
  runtime or persistence model.
* Good, because archive and native package payloads come from the same staging
  step.
* Good, because native-package users do not need Node installed separately.
* Bad, because unsigned packages still trigger OS trust warnings.
* Bad, because copying the Node runtime increases package size.
* Bad, because Windows installer creation now depends on WiX in release CI.