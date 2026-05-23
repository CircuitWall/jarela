# Installing Jarela

Three ways to install:

| Path | When | Result |
|------|------|--------|
| **Pre-built archive** (this file) | You don't have Node, or want the simplest install | A native autostart entry on macOS / Windows |
| **`npm install -g jarela`** | You have Node 22+ | A `jarela` CLI on your PATH |
| **Docker** (Ubuntu / any Linux host) | You want a container, headless server, or NAS | A `jarela` container listening on `127.0.0.1:4312` |

All three end at the same place: a Next.js process on `http://127.0.0.1:4312`, with state persisted (host: `~/.jarela`; container: the `jarela-data` volume mounted at `/data`).

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

### Install as an autostart service (npm path)

By default `jarela` runs in the foreground — Ctrl-C stops it, nothing restarts it. To register it as a per-user autostart service (no admin / sudo required):

```sh
jarela install-service        # auto-detects Windows / macOS / Linux
```

This registers the native autostart mechanism for your OS, points it at the global `jarela` binary, and starts it immediately:

| OS      | Mechanism                                        | Lives at                                                        |
|---------|--------------------------------------------------|-----------------------------------------------------------------|
| Windows | Scheduled Task `Jarela` (AtLogOn, hidden VBS)    | `%LOCALAPPDATA%\Jarela\service\launcher.vbs`                    |
| macOS   | LaunchAgent `com.jarela.app` (RunAtLoad+KeepAlive) | `~/Library/LaunchAgents/com.jarela.app.plist`                  |
| Linux   | systemd `--user` unit `jarela.service`           | `~/.config/systemd/user/jarela.service`                         |

To remove:

```sh
jarela uninstall-service
```

(Neither command touches your data dir.)

---

---

## Path 3 — Docker (Ubuntu / Linux)

A `Dockerfile` and `docker-compose.yml` ship at the repo root. The image is
based on `node:22-bookworm-slim` (Debian) and runs as a non-root user.

### Quick start (docker compose)

```sh
git clone <repo-url> jarela
cd jarela
docker compose up -d --build
# open http://127.0.0.1:4312
```

### From Docker Hub (no clone, no build)

Releases tagged `v*` publish a multi-arch (`linux/amd64` + `linux/arm64`)
image to Docker Hub at [`jarela/jarela`](https://hub.docker.com/r/jarela/jarela):

```sh
docker run -d --name jarela \
  -p 127.0.0.1:4312:4312 \
  -v jarela-data:/data \
  --restart unless-stopped \
  jarela/jarela:latest
```

Pin to a specific version with `jarela/jarela:0.1.0` (or the major/minor
tags `jarela/jarela:0.1`, `jarela/jarela:0`).

State (SQLite, encrypted secrets, uploads) is persisted in the named
`jarela-data` volume. To reset, `docker compose down -v`.

### Quick start (plain docker)

```sh
docker build -t jarela .
docker run -d --name jarela \
  -p 127.0.0.1:4312:4312 \
  -v jarela-data:/data \
  --restart unless-stopped \
  jarela
```

Or bind-mount a host directory instead of a named volume:

```sh
mkdir -p ~/.jarela
docker run -d --name jarela \
  -p 127.0.0.1:4312:4312 \
  -v ~/.jarela:/data \
  jarela
```

### Container notes

- `PORT` defaults to `4312`, `HOSTNAME` to `0.0.0.0` (so the published port is
  reachable on the host). Override either with `-e PORT=… -e HOSTNAME=…`.
- `JARELA_DB_DIR` is set to `/data` — mount a volume there to persist.
- No D-Bus / OS keychain is available inside the container, so the master
  encryption key transparently falls back to a 0600-permissioned file at
  `/data/.secret-key` (see [ADR-0005](adr/0005-encrypt-secrets-at-rest.md)).
  Back up `/data` to back up everything.
- LAN exposure: drop the `127.0.0.1:` prefix in the port mapping
  (`-p 4312:4312`) — but the app has no built-in auth, so only do that on
  a trusted network.

### Upgrade

```sh
git pull
docker compose up -d --build
```

The `jarela-data` volume survives rebuilds.

### Uninstall

```sh
docker compose down            # keep data
docker compose down -v         # wipe data too
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
- **npm (CLI only)**: `npm uninstall -g jarela`
- **npm (with autostart service)**: `jarela uninstall-service && npm uninstall -g jarela`
