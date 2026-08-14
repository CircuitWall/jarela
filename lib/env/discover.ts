// Cross-platform discovery of the user's FULL shell-defined environment.
//
// The problem: Jarela installed as a macOS LaunchAgent or a Linux systemd
// user unit doesn't run inside a login shell, so it never sees vars
// defined in `.zshrc`/`.bashrc`. Windows is the opposite — User-scope
// vars set via the Settings UI/registry ARE inherited by every process,
// but vars set only inside a PowerShell `$PROFILE` are not.
//
// Strategy:
//   - macOS / Linux: spawn `$SHELL -ic 'env -0'`. Sourcing the rc file is
//     the whole point of the `-i` flag. Output is framed with a unique
//     sentinel and NUL-separated so user rc echo / multi-line values
//     can't poison the parser.
//   - Windows: read the entire User-scope environment block via
//     `[Environment]::GetEnvironmentVariables('User')`. This hits the
//     registry directly — no rc-equivalent to source.
//
// Always falls back gracefully to whatever is already in `process.env`.
// Hard 4 s timeout per probe so a hung shell can't stall startup.

import { spawn } from "node:child_process";
import { platform } from "node:os";

export type DiscoverySource =
  | "process"
  | "shell-rc"
  | "windows-registry"
  | "unavailable";

export interface DiscoveredEnv {
  values: Record<string, string>;
  source: DiscoverySource;
  /** Path to the shell that ran (unix), or "powershell" on Windows. */
  shell: string | null;
  warnings: string[];
  /** Probe wall-time in ms — useful for telemetry / debugging. */
  elapsed_ms: number;
}

const TIMEOUT_MS = 4000;
const SENTINEL_OPEN = "__JARELA_ENV_BEGIN__";
const SENTINEL_CLOSE = "__JARELA_ENV_END__";

/**
 * Discover the FULL shell environment — every var the user's interactive
 * shell exports, not just an allowlisted subset. Used to seed subprocess
 * env for every child process Jarela spawns (see
 * lib/tools/subprocess-env.ts, lib/mcp/client.ts) so tools, MCP servers,
 * and terminal sessions see the same environment a real terminal would.
 */
export async function discoverAllShellEnv(): Promise<DiscoveredEnv> {
  const t0 = Date.now();
  const warnings: string[] = [];

  const fromProcess: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.trim()) fromProcess[name] = value.trim();
  }

  if (platform() === "win32") {
    const reg = await queryWindowsUserEnvAll().catch((e: unknown): null => {
      warnings.push(`windows registry probe failed: ${String(e)}`);
      return null;
    });
    if (reg && Object.keys(reg).length > 0) {
      // Registry wins over process.env: the registry is the *current*
      // truth, while process.env is frozen at process-spawn time. This
      // is what makes rotation pickup work after the user updates a
      // var in the Settings UI without restarting the app.
      return {
        values: { ...fromProcess, ...reg },
        source: "windows-registry",
        shell: "powershell",
        warnings,
        elapsed_ms: Date.now() - t0,
      };
    }
    return { values: fromProcess, source: "process", shell: null, warnings, elapsed_ms: Date.now() - t0 };
  }

  const shell = process.env.SHELL || "/bin/sh";
  const fromShell = await queryUnixShellEnvAll(shell).catch((e: unknown): null => {
    warnings.push(`shell rc probe (${shell}) failed: ${String(e)}`);
    return null;
  });
  if (fromShell && Object.keys(fromShell).length > 0) {
    return {
      values: { ...fromProcess, ...fromShell },
      source: "shell-rc",
      shell,
      warnings,
      elapsed_ms: Date.now() - t0,
    };
  }
  return { values: fromProcess, source: "process", shell, warnings, elapsed_ms: Date.now() - t0 };
}

/** Full, unfiltered shell env dump via `env -0` (NUL-separated — safe for values containing `=` or newlines). */
function queryUnixShellEnvAll(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const script = `printf '${SENTINEL_OPEN}'; env -0; printf '${SENTINEL_CLOSE}'`;
    const child = spawn(shell, ["-ic", script], {
      env: { ...process.env, PS1: "", PROMPT: "", HISTFILE: "/dev/null" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("close", (code: number | null) => {
      clearTimeout(t);
      const parsed = parseFullEnvBlock(stdout);
      if (code !== 0 && code !== null && Object.keys(parsed).length === 0) {
        return reject(new Error(`shell exited ${code} with no parseable output`));
      }
      resolve(parsed);
    });
    child.on("error", (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Parse a sentinel-framed `env -0` dump into a name -> value map. */
function parseFullEnvBlock(stream: string): Record<string, string> {
  const start = stream.indexOf(SENTINEL_OPEN);
  const end = stream.indexOf(SENTINEL_CLOSE);
  if (start < 0 || end < 0 || end <= start) return {};
  const body = stream.slice(start + SENTINEL_OPEN.length, end);
  const out: Record<string, string> = {};
  for (const entry of body.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = entry.slice(eq + 1);
    if (value) out[name] = value;
  }
  return out;
}

async function queryWindowsUserEnvAll(): Promise<Record<string, string>> {
  // Try modern PowerShell 7+ (pwsh) first, then fall back to the always-
  // present Windows PowerShell 5.1 (powershell.exe). pwsh defaults to
  // UTF-8 stdout; powershell.exe 5.1 defaults to UTF-16, so we force
  // UTF-8 inside the script either way.
  try {
    return await runWindowsProbeAll("pwsh.exe");
  } catch {
    return await runWindowsProbeAll("powershell.exe");
  }
}

function runWindowsProbeAll(exe: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // Force UTF-8 stdout — Windows PowerShell 5.1 emits UTF-16 LE by
    // default, which would garble the sentinel parser. The
    // `[Console]::OutputEncoding` line is a no-op on pwsh 7+ but
    // critical on legacy powershell.exe.
    const script =
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `$vars = [Environment]::GetEnvironmentVariables('User'); ` +
      `foreach ($k in $vars.Keys) { ` +
      `  Write-Output ('${SENTINEL_OPEN}' + $k + '=' + $vars[$k] + '${SENTINEL_CLOSE}') ` +
      `}`;
    const child = spawn(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let stdout = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("close", (code: number | null) => {
      clearTimeout(t);
      if (code !== 0 && code !== null) return reject(new Error(`${exe} exited ${code}`));
      resolve(parseSentinelEntries(stdout));
    });
    child.on("error", (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * Pull `__OPEN__NAME=VALUE__CLOSE__` segments out of a stream, ignoring
 * everything else. Tolerates banner/log noise and partial reads.
 */
function parseSentinelEntries(stream: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = stream.split(SENTINEL_OPEN);
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    const end = seg.indexOf(SENTINEL_CLOSE);
    if (end < 0) continue;
    const body = seg.slice(0, end);
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const name = body.slice(0, eq);
    const value = body.slice(eq + 1).trim();
    if (value) out[name] = value;
  }
  return out;
}
