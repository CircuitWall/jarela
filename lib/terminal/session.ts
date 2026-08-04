// Persistent shell session wrapping a child_process.spawn().
//
// Sentinel-based completion: each exec() injects a unique marker after the
// user command so we know exactly when the shell finished processing it.
// The sentinel carries the exit code, so we don't need a separate probe.
//
// All I/O is piped (no PTY). Works for REPLs and build tools; full-screen
// apps (vim, less) would need node-pty which is a future upgrade.

import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveSubprocessEnv } from "@/lib/tools/subprocess-env";

const MAX_BUF = 256_000;
const DEFAULT_SHELL = platform() === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash");

function shellBasename(shell: string): string {
  return shell.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? shell.toLowerCase();
}
function isPs(shell: string): boolean {
  const b = shellBasename(shell);
  return b === "powershell.exe" || b === "powershell" || b === "pwsh.exe" || b === "pwsh";
}
function isCmd(shell: string): boolean {
  const b = shellBasename(shell);
  return b === "cmd.exe" || b === "cmd";
}

function clip(s: string, max = MAX_BUF): string {
  return s.length <= max ? s : `[... truncated ...]\n${s.slice(s.length - max)}`;
}

// Sentinel embeds exit code AND cwd so the registry can track directory changes.
function sentinelLine(uuid: string, shell: string): string {
  if (isPs(shell)) {
    // $LASTEXITCODE = last external-process code; $? = bool for PS cmdlets.
    return `Write-Host "##JARELA:${uuid}##$(if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { if ($?) { 0 } else { 1 } })##$(Get-Location)##"\n`;
  }
  if (isCmd(shell)) {
    return `echo ##JARELA:${uuid}##%ERRORLEVEL%##%CD%##\r\n`;
  }
  // bash / sh / zsh / POSIX
  return `echo "##JARELA:${uuid}##$?##$(pwd)##"\n`;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cwd: string;
}

export class TerminalSession {
  readonly sessionId: string;
  readonly shell: string;
  readonly startCwd: string;

  private proc: ChildProcess;
  private outBuf = "";
  private errBuf = "";
  private pendingOut = "";
  private pendingErr = "";
  private _closed = false;
  private _lastActivity = Date.now();
  private _cwd: string; // updated from sentinel after every exec

  // At most one exec waiter at a time — queued via promise chaining.
  private execChain: Promise<void> = Promise.resolve();

  constructor(opts: {
    sessionId: string;
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
    workspaceRoot?: string;
  }) {
    this.sessionId = opts.sessionId;
    this.shell = opts.shell ?? DEFAULT_SHELL;

    const resolved = resolveSubprocessEnv({ cwd: opts.cwd, env: opts.env, workspaceRoot: opts.workspaceRoot });
    this.startCwd = resolved.cwd;
    this._cwd = resolved.cwd;

    // -NoLogo: suppress banner text that would pollute the output buffer.
    // -NonInteractive: prevent Read-Host from hanging unattended sessions.
    const shellArgs = isPs(this.shell) ? ["-NoLogo", "-NonInteractive"] : [];

    this.proc = spawn(this.shell, shellArgs, { cwd: resolved.cwd, env: resolved.env, stdio: ["pipe", "pipe", "pipe"] });

    if (isPs(this.shell)) {
      // Force UTF-8 so non-ASCII output isn't garbled (critical for PS 5.1).
      this.proc.stdin!.write("$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n");
    }

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      const t = chunk.toString("utf8");
      this.outBuf = clip(this.outBuf + t);
      this.pendingOut += t;
      this._lastActivity = Date.now();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const t = chunk.toString("utf8");
      this.errBuf = clip(this.errBuf + t);
      this.pendingErr += t;
      this._lastActivity = Date.now();
    });

    this.proc.on("close", () => { this._closed = true; });
  }

  /** Run a command and wait for its sentinel. Serialised — callers queue automatically. */
  exec(command: string, timeoutMs = 60_000): Promise<ExecResult> {
    const result = this.execChain.then(() => this._execImmediate(command, timeoutMs));
    // Chain next exec after this one resolves (even on error)
    this.execChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private _execImmediate(command: string, timeoutMs: number): Promise<ExecResult> {
    if (this._closed) return Promise.reject(new Error("session is closed"));

    const uuid = randomUUID();

    return new Promise<ExecResult>((resolve) => {
      this.pendingOut = "";
      this.pendingErr = "";

      const sentinel = `##JARELA:${uuid}##`;
      // Groups: (exitCode)(cwd) — cwd captured from the sentinel itself.
      const re = new RegExp(`##JARELA:${uuid}##(\\d+)##(.+)##`);

      const checkInterval = setInterval(() => {
        const m = this.pendingOut.match(re);
        if (!m) return;
        clearInterval(checkInterval);
        clearTimeout(timer);

        const exitCode = parseInt(m[1], 10);
        const capturedCwd = m[2].trim();
        if (capturedCwd) this._cwd = capturedCwd;

        const sentinelStart = this.pendingOut.indexOf(sentinel);
        const stdout = clip(this.pendingOut.slice(0, sentinelStart).trimEnd(), MAX_BUF);
        const stderr = clip(this.pendingErr.trimEnd(), 16_000);

        this.pendingOut = "";
        this.pendingErr = "";

        resolve({ stdout, stderr, exitCode, timedOut: false, cwd: this._cwd });
      }, 10);

      const timer = setTimeout(() => {
        clearInterval(checkInterval);
        resolve({
          stdout: clip(this.pendingOut.trimEnd()),
          stderr: clip(this.pendingErr.trimEnd(), 16_000),
          exitCode: null,
          timedOut: true,
          cwd: this._cwd,
        });
        this.pendingOut = "";
        this.pendingErr = "";
      }, timeoutMs);

      this.proc.stdin!.write(`${command}\n`);
      this.proc.stdin!.write(sentinelLine(uuid, this.shell));
      this._lastActivity = Date.now();
    });
  }

  /** Send raw input to the running process's stdin (for interactive programs). */
  send(input: string): void {
    if (this._closed) throw new Error("session is closed");
    this.proc.stdin!.write(input);
    this._lastActivity = Date.now();
  }

  /** Read buffered stdout accumulated since last read. */
  readBuffer(clear = false): string {
    const out = this.outBuf;
    if (clear) { this.outBuf = ""; this.errBuf = ""; }
    return out;
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      // Node translates SIGTERM to TerminateProcess on Windows — safe on all platforms.
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  get isDead(): boolean { return this._closed || !this.proc.pid; }
  get idleMs(): number { return Date.now() - this._lastActivity; }
  get pid(): number | undefined { return this.proc.pid; }
  get cwd(): string { return this._cwd; }
}
