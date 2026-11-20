/**
 * Process boundary for dependency installs.
 *
 * Kept apart from `install.ts` so the install *decisions* (allowlist, pending
 * approval, blocked global installs) stay unit-testable while the one place
 * that actually spawns `npm` is a thin, auditable shell. `install.ts` swaps it
 * out through `_setInstallRunnerForTests`.
 *
 * argv arrays only — never a shell string. Output is captured for the error
 * message and bounded so a chatty installer cannot flood the log.
 */
import spawn from "cross-spawn";

export type CommandRunner = (command: string[], cwd: string | null, timeoutMs: number) => Promise<void>;

export const runCommand: CommandRunner = (command, cwd, timeoutMs) =>
  new Promise((resolveRun, rejectRun) => {
    const [file, ...args] = command;
    if (!file) {
      rejectRun(new Error("empty install command"));
      return;
    }
    const child = spawn(file, args, {
      cwd: cwd ?? undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`${file} ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${file} ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
