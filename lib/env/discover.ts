// Cross-platform discovery of "shell-defined" environment variables.
//
// The problem: Jarela installed as a macOS LaunchAgent or a Linux systemd
// user unit doesn't run inside a login shell, so it never sees vars
// defined in `.zshrc`/`.bashrc`. Windows is the opposite — User-scope
// vars set via the Settings UI/registry ARE inherited by every process,
// but vars set only inside a PowerShell `$PROFILE` are not.
//
// Strategy:
//   - macOS / Linux: spawn `$SHELL -ic '<print-allowlisted>'`. Sourcing
//     the rc file is the whole point of the `-i` flag. Output is
//     framed with a unique sentinel so user rc echo doesn't poison the
//     parser.
//   - Windows: read the User-scope environment block via
//     `[Environment]::GetEnvironmentVariable($name, 'User')`. This hits
//     the registry directly — no rc-equivalent to source.
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
 * Discover values for the given allowlist of env-var names. Always
 * returns; never throws. On platforms or shells we can't probe, falls
 * back to `process.env`.
 */
export async function discoverEnvVars(allowlist: readonly string[]): Promise<DiscoveredEnv> {
  const t0 = Date.now();
  const warnings: string[] = [];

  // Baseline: whatever the running process already has. On Windows this
  // already includes registry User vars. In dev mode (`npm run dev` from
  // a terminal) it includes the parent shell's exports.
  const fromProcess: Record<string, string> = {};
  for (const name of allowlist) {
    const v = process.env[name];
    if (v && v.trim()) fromProcess[name] = v.trim();
  }

  if (platform() === "win32") {
    const reg = await queryWindowsUserEnv(allowlist).catch((e: unknown): null => {
      warnings.push(`windows registry probe failed: ${String(e)}`);
      return null;
    });
    if (reg) {
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
    return {
      values: fromProcess,
      source: "process",
      shell: null,
      warnings,
      elapsed_ms: Date.now() - t0,
    };
  }

  // macOS / Linux
  const shell = process.env.SHELL || "/bin/sh";
  const fromShell = await queryUnixShellEnv(shell, allowlist).catch((e: unknown): null => {
    warnings.push(`shell rc probe (${shell}) failed: ${String(e)}`);
    return null;
  });
  if (fromShell) {
    return {
      values: { ...fromProcess, ...fromShell },
      source: "shell-rc",
      shell,
      warnings,
      elapsed_ms: Date.now() - t0,
    };
  }
  return {
    values: fromProcess,
    source: "process",
    shell,
    warnings,
    elapsed_ms: Date.now() - t0,
  };
}

function queryUnixShellEnv(shell: string, allowlist: readonly string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // Frame each var with sentinels so any noise the user's rc prints
    // (oh-my-zsh banners, version-manager init logs, etc.) gets
    // skipped by the parser. Single-quoted names are JS-side string
    // constants, double-quoted "$VAR" lets the shell expand.
    const lines = allowlist
      .map(
        (n) =>
          `printf '${SENTINEL_OPEN}%s=%s${SENTINEL_CLOSE}\\n' '${n}' "$${n}"`,
      )
      .join("; ");
    // Suppress prompts and history side-effects. Pipe stderr to /dev/null
    // — we don't care about rc-emitted warnings.
    const child = spawn(shell, ["-ic", lines], {
      env: { ...process.env, PS1: "", PROMPT: "", HISTFILE: "/dev/null" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.on("close", (code: number | null) => {
      clearTimeout(t);
      if (code !== 0 && code !== null) {
        // Some shells return non-zero from `-ic` if rc has any failing
        // command, but our printfs still ran first — try parsing anyway.
        // Only reject if we got nothing usable.
        const parsed = parseSentinelStream(stdout, allowlist);
        if (Object.keys(parsed).length === 0) {
          return reject(new Error(`shell exited ${code} with no parseable output`));
        }
        return resolve(parsed);
      }
      resolve(parseSentinelStream(stdout, allowlist));
    });
    child.on("error", (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function queryWindowsUserEnv(allowlist: readonly string[]): Promise<Record<string, string>> {
  // Try modern PowerShell 7+ (pwsh) first, then fall back to the always-
  // present Windows PowerShell 5.1 (powershell.exe). pwsh defaults to
  // UTF-8 stdout; powershell.exe 5.1 defaults to UTF-16, so we force
  // UTF-8 inside the script either way.
  try {
    return await runWindowsProbe("pwsh.exe", allowlist);
  } catch {
    return await runWindowsProbe("powershell.exe", allowlist);
  }
}

function runWindowsProbe(exe: string, allowlist: readonly string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const namesArr = allowlist.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
    // Force UTF-8 stdout — Windows PowerShell 5.1 emits UTF-16 LE by
    // default, which would garble the sentinel parser. The
    // `[Console]::OutputEncoding` line is a no-op on pwsh 7+ but
    // critical on legacy powershell.exe.
    const script =
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `$names = @(${namesArr}); ` +
      `foreach ($n in $names) { ` +
      `  $v = [Environment]::GetEnvironmentVariable($n, 'User'); ` +
      `  if ($v) { Write-Output ('${SENTINEL_OPEN}' + $n + '=' + $v + '${SENTINEL_CLOSE}') } ` +
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
      resolve(parseSentinelStream(stdout, allowlist));
    });
    child.on("error", (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * Pull `__OPEN__NAME=VALUE__CLOSE__` segments out of a stream, ignoring
 * everything else. Tolerates rc-line noise and partial reads.
 */
function parseSentinelStream(stream: string, allowlist: readonly string[]): Record<string, string> {
  const allow = new Set(allowlist);
  const out: Record<string, string> = {};
  // Non-greedy, case-sensitive, multi-line capable. Use `split` so we
  // don't depend on regex flags that some Node versions surface oddly.
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
    if (allow.has(name) && value) out[name] = value;
  }
  return out;
}
