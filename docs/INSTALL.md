# Installing Jarela

Two ways to install:

| Path | When | Result |
|------|------|--------|
| **Pre-built archive** (this file) | You don't have Node, or want the simplest install | A native autostart entry on macOS / Windows |
| **`npm install -g jarela`** | You have Node 22+ | A `jarela` CLI on your PATH |

Both end at the same place: a local Next.js process on `http://127.0.0.1:4312`, all state in `~/.jarela`.

---

## Path 1 — Pre-built archive

Download the archive for your OS from the [latest release](../../releases/latest):

- `jarela-<version>-darwin.tar.gz` — macOS (arm64)
- `jarela-<version>-win.zip` — Windows
- `jarela-<version>-linux.tar.gz` — Linux

These archives are **unsigned**. Your OS will warn you the first time you run them. That's expected — see "First-launch warnings" below.

### macOS

```sh
tar -xzf jarela-<version>-darwin.tar.gz
cd jarela-<version>-darwin
xattr -dr com.apple.quarantine .                     # clear Gatekeeper flag
bash scripts/install-to-system.sh --skip-build
```

This installs Jarela under `~/Library/Application Support/Jarela`, registers a LaunchAgent so it starts at login, and opens `http://127.0.0.1:4312` once it's up.

### Windows

```powershell
Expand-Archive jarela-<version>-win.zip
cd jarela-<version>-win
powershell -ExecutionPolicy Bypass -File scripts\install-to-system.ps1 -SkipBuild
```

This installs Jarela under `%LOCALAPPDATA%\Programs\Jarela`, registers a Scheduled Task to start it at logon, and opens `http://127.0.0.1:4312`.

If SmartScreen blocks the script: **More info → Run anyway**.

### Linux

```sh
tar -xzf jarela-<version>-linux.tar.gz
cd jarela-<version>-linux
bash scripts/install-to-system.sh --skip-build
```

(There is no LaunchAgent / Scheduled Task on Linux — the install script lays the bundle down, you choose your own supervisor: `systemd --user`, `nohup`, etc.)

### First-launch warnings

- **macOS** "unidentified developer": the `xattr -dr com.apple.quarantine` line above clears it for the whole bundle in one go. Without it, you'd right-click → Open the first time per binary.
- **Windows** SmartScreen: **More info → Run anyway**, once.

These warnings exist because we don't yet pay for an Apple Developer ID or an Authenticode cert. See [ADR-0011](docs/adr/0011-distribute-via-portable-archives-and-npm.md) for the trade-off.

---

## Path 2 — npm

```sh
npm install -g jarela
jarela
```

The first `jarela` invocation builds the production bundle (~30–60 s, one time). Subsequent invocations start instantly.

To run on a non-default port:

```sh
PORT=4400 jarela
```

To upgrade:

```sh
npm update -g jarela
jarela        # rebuilds on first run after upgrade
```

---

## Where state lives

All persistent state — chat threads, model configs, integration tokens, scheduled tasks — lives under:

- macOS / Linux: `~/.jarela/`
- Windows: `%LOCALAPPDATA%\Jarela\`

Override with `JARELA_DB_DIR=/path/to/dir`. Uninstalling does **not** delete this directory; remove it by hand if you want a clean slate.

## Uninstall

- **macOS**: `launchctl unload ~/Library/LaunchAgents/com.jarela.app.plist && rm -rf ~/Library/Application\ Support/Jarela ~/Library/LaunchAgents/com.jarela.app.plist`
- **Windows**: `powershell -ExecutionPolicy Bypass -File scripts\uninstall-from-system.ps1`
- **npm**: `npm uninstall -g jarela`
